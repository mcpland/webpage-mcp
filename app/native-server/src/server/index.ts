/**
 * HTTP Server - Core server implementation.
 *
 * Responsibilities:
 * - Fastify instance management
 * - Plugin registration (CORS, etc.)
 * - Route delegation to specialized modules
 * - MCP transport handling
 * - Server lifecycle management
 */
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import {
  NATIVE_SERVER_PORT,
  TIMEOUTS,
  SERVER_CONFIG,
  HTTP_STATUS,
  ERROR_MESSAGES,
} from '../constant';
import { NativeMessagingHost } from '../native-messaging-host';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../mcp/mcp-server';
import { clearDynamicFlowCacheForSession } from '../mcp/register-tools';
import { AgentStreamManager } from '../agent/stream-manager';
import { AgentChatService } from '../agent/chat-service';
import { CodexEngine } from '../agent/engines/codex';
import { ClaudeEngine } from '../agent/engines/claude';
import { closeDb } from '../agent/db';
import { registerAgentRoutes } from './routes';
import { DEFAULT_MCP_INSTANCE_ID } from 'webpage-mcp-shared';

// ============================================================
// Types
// ============================================================

interface ExtensionRequestPayload {
  data?: unknown;
}

interface ServerOptions {
  instanceId?: string;
}

type McpSessionTransport = StreamableHTTPServerTransport | SSEServerTransport;

interface McpSession {
  sessionId: string;
  transport: McpSessionTransport;
  mcpServer: McpSdkServer;
  protocol: 'streamable-http' | 'sse';
  createdAt: number;
}

type StreamableMcpSession = McpSession & { transport: StreamableHTTPServerTransport };
type SseMcpSession = McpSession & { transport: SSEServerTransport };
const AUTH_TOKEN_ENV = 'WEBPAGE_MCP_AUTH_TOKEN';
const AUTH_TOKEN_HEADER = 'x-webpage-mcp-token';
const AUTH_TOKEN_QUERY_KEYS = ['authToken', 'token'] as const;
const AUTH_PROTECTED_PATHS = ['/mcp', '/sse', '/messages', '/agent', '/ask-extension'] as const;

function isReplyCommitted(reply: FastifyReply): boolean {
  const raw = reply.raw;
  return reply.sent || raw.headersSent || raw.writableEnded || raw.destroyed;
}

function trySendReply(
  reply: FastifyReply,
  statusCode: number,
  payload: string | { error: string },
): boolean {
  if (isReplyCommitted(reply)) {
    return false;
  }
  reply.code(statusCode).send(payload);
  return true;
}

function endRawReplyIfOpen(reply: FastifyReply): void {
  if (!reply.raw.writableEnded && !reply.raw.destroyed) {
    reply.raw.end();
  }
}

// ============================================================
// Server Class
// ============================================================

export class Server {
  private static activeServerCount = 0;
  private fastify: FastifyInstance;
  public isRunning = false;
  public readonly instanceId: string;
  private nativeHost: NativeMessagingHost | null = null;
  private mcpSessions: Map<string, McpSession> = new Map();
  private agentStreamManager: AgentStreamManager;
  private agentChatService: AgentChatService;
  private listeningPort: number | null = null;

  constructor(options: ServerOptions = {}) {
    this.instanceId = options.instanceId?.trim() || DEFAULT_MCP_INSTANCE_ID;
    this.fastify = Fastify({ logger: SERVER_CONFIG.LOGGER_ENABLED });
    this.agentStreamManager = new AgentStreamManager();
    this.agentChatService = new AgentChatService({
      engines: [new CodexEngine(), new ClaudeEngine()],
      streamManager: this.agentStreamManager,
    });
    this.setupPlugins();
    this.setupRoutes();
  }

  /**
   * Associate NativeMessagingHost instance.
   */
  public setNativeHost(nativeHost: NativeMessagingHost): void {
    this.nativeHost = nativeHost;
  }

  private getNativeHostOrThrow(): NativeMessagingHost {
    if (!this.nativeHost) {
      throw new Error(ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE);
    }
    return this.nativeHost;
  }

  private registerMcpSession(session: McpSession): void {
    this.mcpSessions.set(session.sessionId, session);
  }

  private getMcpSession(sessionId?: string): McpSession | undefined {
    if (!sessionId) return undefined;
    return this.mcpSessions.get(sessionId);
  }

  private getStreamableSession(sessionId?: string): StreamableMcpSession | undefined {
    const session = this.getMcpSession(sessionId);
    if (!session || !(session.transport instanceof StreamableHTTPServerTransport)) {
      return undefined;
    }
    return session as StreamableMcpSession;
  }

  private getSseSession(sessionId?: string): SseMcpSession | undefined {
    const session = this.getMcpSession(sessionId);
    if (!session || !(session.transport instanceof SSEServerTransport)) {
      return undefined;
    }
    return session as SseMcpSession;
  }

  private async disposeMcpSession(
    sessionId: string,
    options: { closeTransport?: boolean; closeServer?: boolean } = {},
  ): Promise<void> {
    const session = this.mcpSessions.get(sessionId);
    if (!session) return;

    this.mcpSessions.delete(sessionId);
    clearDynamicFlowCacheForSession(sessionId);
    const { closeTransport = false, closeServer = true } = options;

    if (closeTransport) {
      try {
        await session.transport.close();
      } catch {
        // Ignore transport close errors during cleanup
      }
    }

    if (closeServer) {
      try {
        await session.mcpServer.close();
      } catch {
        // Ignore server close errors during cleanup
      }
    }
  }

  private async disposeAllMcpSessions(): Promise<void> {
    const ids = Array.from(this.mcpSessions.keys());
    await Promise.all(ids.map((id) => this.disposeMcpSession(id, { closeTransport: true })));
  }

  private resolveListeningPort(fallbackPort: number): number {
    const address = this.fastify.server.address();
    if (address && typeof address === 'object' && typeof address.port === 'number') {
      return address.port;
    }
    return fallbackPort;
  }

  private getConfiguredAuthToken(): string | undefined {
    const token = process.env[AUTH_TOKEN_ENV];
    if (typeof token !== 'string') {
      return undefined;
    }
    const trimmed = token.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private isProtectedPath(rawUrl?: string): boolean {
    const path = String(rawUrl || '').split('?')[0] || '';
    if (!path || path === '/ping') {
      return false;
    }
    return AUTH_PROTECTED_PATHS.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
  }

  private extractAuthToken(request: FastifyRequest): string | undefined {
    const bearerHeader = request.headers.authorization;
    const candidate = Array.isArray(bearerHeader) ? bearerHeader[0] : bearerHeader;
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      const bearerPrefix = 'Bearer ';
      if (trimmed.startsWith(bearerPrefix)) {
        const token = trimmed.slice(bearerPrefix.length).trim();
        if (token) {
          return token;
        }
      }
    }

    const directHeader = request.headers[AUTH_TOKEN_HEADER];
    const directToken = Array.isArray(directHeader) ? directHeader[0] : directHeader;
    if (typeof directToken === 'string') {
      const trimmed = directToken.trim();
      if (trimmed) {
        return trimmed;
      }
    }

    try {
      const rawUrl = request.raw.url || request.url;
      if (rawUrl) {
        const url = new URL(rawUrl, `http://${SERVER_CONFIG.HOST}`);
        for (const key of AUTH_TOKEN_QUERY_KEYS) {
          const token = url.searchParams.get(key);
          if (token && token.trim()) {
            return token.trim();
          }
        }
      }
    } catch {
      // Ignore malformed URL values and continue without query token.
    }
    return undefined;
  }

  private setupPlugins(): void {
    this.fastify.register(cors, {
      origin: (origin, cb) => {
        // Allow requests with no origin (e.g., curl, server-to-server)
        if (!origin) {
          return cb(null, true);
        }
        // Check if origin matches any pattern in whitelist
        const allowed = SERVER_CONFIG.CORS_ORIGIN.some((pattern) =>
          pattern instanceof RegExp ? pattern.test(origin) : origin.startsWith(pattern),
        );
        cb(null, allowed);
      },
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      credentials: true,
    });

    this.fastify.addHook('preHandler', async (request, reply) => {
      const expectedToken = this.getConfiguredAuthToken();
      if (!expectedToken) {
        return;
      }
      if (request.method === 'OPTIONS') {
        return;
      }
      if (!this.isProtectedPath(request.raw.url || request.url)) {
        return;
      }
      const requestToken = this.extractAuthToken(request);
      if (!requestToken || requestToken !== expectedToken) {
        reply.code(HTTP_STATUS.UNAUTHORIZED).send({ error: 'Unauthorized' });
        return reply;
      }
    });
  }

  private setupRoutes(): void {
    // Health check
    this.setupHealthRoutes();

    // Extension communication
    this.setupExtensionRoutes();

    // Agent routes (delegated to separate module)
    registerAgentRoutes(this.fastify, {
      streamManager: this.agentStreamManager,
      chatService: this.agentChatService,
    });

    // MCP routes
    this.setupMcpRoutes();
  }

  // ============================================================
  // Health Routes
  // ============================================================

  private setupHealthRoutes(): void {
    this.fastify.get('/ping', async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.status(HTTP_STATUS.OK).send({
        status: 'ok',
        message: 'pong',
      });
    });
  }

  // ============================================================
  // Extension Routes
  // ============================================================

  private setupExtensionRoutes(): void {
    this.fastify.get(
      '/ask-extension',
      async (request: FastifyRequest<{ Body: ExtensionRequestPayload }>, reply: FastifyReply) => {
        if (!this.nativeHost) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE });
        }
        if (!this.isRunning) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.SERVER_NOT_RUNNING });
        }

        try {
          const extensionResponse = await this.nativeHost.sendRequestToExtensionAndWait(
            request.query,
            'process_data',
            TIMEOUTS.EXTENSION_REQUEST_TIMEOUT,
          );
          return reply.status(HTTP_STATUS.OK).send({ status: 'success', data: extensionResponse });
        } catch (error: unknown) {
          const err = error as Error;
          if (err.message.includes('timed out')) {
            return reply
              .status(HTTP_STATUS.GATEWAY_TIMEOUT)
              .send({ status: 'error', message: ERROR_MESSAGES.REQUEST_TIMEOUT });
          } else {
            return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
              status: 'error',
              message: `Failed to get response from extension: ${err.message}`,
            });
          }
        }
      },
    );
  }

  // ============================================================
  // MCP Routes
  // ============================================================

  private setupMcpRoutes(): void {
    // SSE endpoint
    this.fastify.get('/sse', async (_, reply) => {
      let createdSession: McpSession | undefined;
      try {
        const transport = new SSEServerTransport('/messages', reply.raw);
        const sessionId = transport.sessionId;
        const mcpServer = createMcpServer({
          sessionId,
          instanceId: this.instanceId,
          nativeHost: this.getNativeHostOrThrow(),
        });
        createdSession = {
          sessionId,
          transport,
          mcpServer,
          protocol: 'sse',
          createdAt: Date.now(),
        };

        transport.onclose = () => {
          void this.disposeMcpSession(sessionId, { closeTransport: false });
        };

        this.registerMcpSession(createdSession);
        await mcpServer.connect(transport);
      } catch (error) {
        if (createdSession) {
          await this.disposeMcpSession(createdSession.sessionId, { closeTransport: true });
        }
        if (!trySendReply(reply, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_MESSAGES.INTERNAL_SERVER_ERROR)) {
          endRawReplyIfOpen(reply);
        }
      }
    });

    // SSE messages endpoint
    this.fastify.post('/messages', async (req, reply) => {
      try {
        const { sessionId } = req.query as { sessionId?: string };
        const session = this.getSseSession(sessionId);
        if (!session || !sessionId) {
          reply.code(HTTP_STATUS.BAD_REQUEST).send('No transport found for sessionId');
          return;
        }

        await session.transport.handlePostMessage(req.raw, reply.raw, req.body);
      } catch (error) {
        if (!trySendReply(reply, HTTP_STATUS.INTERNAL_SERVER_ERROR, ERROR_MESSAGES.INTERNAL_SERVER_ERROR)) {
          endRawReplyIfOpen(reply);
        }
      }
    });

    // MCP POST endpoint
    this.fastify.post('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      let session = this.getStreamableSession(sessionId);
      let createdSession: StreamableMcpSession | undefined;
      let sessionRegistered = false;

      if (session) {
        // Transport found, proceed
      } else if (!sessionId && isInitializeRequest(request.body)) {
        const newSessionId = randomUUID();
        const mcpServer = createMcpServer({
          sessionId: newSessionId,
          instanceId: this.instanceId,
          nativeHost: this.getNativeHostOrThrow(),
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (initializedSessionId) => {
            if (!createdSession || initializedSessionId !== newSessionId) {
              return;
            }
            createdSession.sessionId = initializedSessionId;
            if (!sessionRegistered) {
              this.registerMcpSession(createdSession);
              sessionRegistered = true;
            }
          },
        });
        createdSession = {
          sessionId: newSessionId,
          transport,
          mcpServer,
          protocol: 'streamable-http',
          createdAt: Date.now(),
        };
        session = createdSession;

        transport.onclose = () => {
          const closedSessionId = createdSession?.sessionId || newSessionId;
          void this.disposeMcpSession(closedSessionId, { closeTransport: false });
        };

        await mcpServer.connect(transport);
      } else {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_MCP_REQUEST });
        return;
      }

      if (!session) {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_MCP_REQUEST });
        return;
      }

      try {
        await session.transport.handleRequest(request.raw, reply.raw, request.body);
        if (createdSession && !sessionRegistered) {
          await createdSession.transport.close().catch(() => {});
          await createdSession.mcpServer.close().catch(() => {});
        }
      } catch (error) {
        if (createdSession && !sessionRegistered) {
          await createdSession.transport.close().catch(() => {});
          await createdSession.mcpServer.close().catch(() => {});
        }
        if (
          !trySendReply(reply, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
            error: ERROR_MESSAGES.MCP_REQUEST_PROCESSING_ERROR,
          })
        ) {
          endRawReplyIfOpen(reply);
        }
      }
    });

    // MCP GET endpoint (SSE stream)
    this.fastify.get('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const session = this.getStreamableSession(sessionId);

      if (!session) {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_SSE_SESSION });
        return;
      }

      try {
        await session.transport.handleRequest(request.raw, reply.raw);
      } catch (error) {
        if (
          !trySendReply(reply, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
            error: ERROR_MESSAGES.MCP_REQUEST_PROCESSING_ERROR,
          })
        ) {
          endRawReplyIfOpen(reply);
        }
      }

      request.socket.on('close', () => {
        request.log.info(`SSE client disconnected for session: ${sessionId}`);
      });
    });

    // MCP DELETE endpoint
    this.fastify.delete('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const session = this.getStreamableSession(sessionId);

      if (!session || !sessionId) {
        reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_SESSION_ID });
        return;
      }

      try {
        await session.transport.handleRequest(request.raw, reply.raw);
        await this.disposeMcpSession(sessionId, { closeTransport: false });
        if (!isReplyCommitted(reply)) {
          reply.code(HTTP_STATUS.NO_CONTENT).send();
        }
      } catch (error) {
        if (
          !trySendReply(reply, HTTP_STATUS.INTERNAL_SERVER_ERROR, {
            error: ERROR_MESSAGES.MCP_SESSION_DELETION_ERROR,
          })
        ) {
          endRawReplyIfOpen(reply);
        }
      }
    });
  }

  // ============================================================
  // Server Lifecycle
  // ============================================================

  public async start(port = NATIVE_SERVER_PORT, nativeHost: NativeMessagingHost): Promise<number> {
    if (!this.nativeHost) {
      this.nativeHost = nativeHost;
    } else if (this.nativeHost !== nativeHost) {
      this.nativeHost = nativeHost;
    }

    if (this.isRunning) {
      return this.resolveListeningPort(port);
    }

    try {
      await this.fastify.listen({ port, host: SERVER_CONFIG.HOST });
      const actualPort = this.resolveListeningPort(port);
      this.listeningPort = actualPort;

      // Keep backward compatibility: env URL resolution tracks the default MCP instance only.
      if (this.instanceId === DEFAULT_MCP_INSTANCE_ID) {
        process.env.WEBPAGE_MCP_PORT = String(actualPort);
        process.env.MCP_HTTP_PORT = String(actualPort);
      }

      this.isRunning = true;
      Server.activeServerCount += 1;
      return actualPort;
    } catch (err) {
      this.isRunning = false;
      this.listeningPort = null;
      throw err;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      await this.disposeAllMcpSessions();
      await this.fastify.close();
      this.isRunning = false;
      this.listeningPort = null;
      Server.activeServerCount = Math.max(0, Server.activeServerCount - 1);
      if (Server.activeServerCount === 0) {
        closeDb();
      }
      if (this.instanceId === DEFAULT_MCP_INSTANCE_ID) {
        delete process.env.WEBPAGE_MCP_PORT;
        delete process.env.MCP_HTTP_PORT;
      }
    } catch (err) {
      this.isRunning = false;
      this.listeningPort = null;
      Server.activeServerCount = Math.max(0, Server.activeServerCount - 1);
      await this.disposeAllMcpSessions().catch(() => {});
      if (Server.activeServerCount === 0) {
        closeDb();
      }
      throw err;
    }
  }

  public getInstance(): FastifyInstance {
    return this.fastify;
  }

  public getListeningPort(): number | null {
    return this.listeningPort;
  }
}

const serverInstance = new Server({ instanceId: DEFAULT_MCP_INSTANCE_ID });
export default serverInstance;
