/**
 * Internal Route Runtime - Core server implementation.
 *
 * Responsibilities:
 * - Fastify instance management (no external listen socket)
 * - Plugin registration (CORS/auth hooks for internal route contract)
 * - Route delegation to specialized modules
 * - Native-host internal route invocation
 * - Server lifecycle management
 */
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import {
  TIMEOUTS,
  SERVER_CONFIG,
  HTTP_STATUS,
  ERROR_MESSAGES,
} from '../constant';
import { NativeMessagingHost } from '../native-messaging-host';
import { AgentStreamManager } from '../agent/stream-manager';
import { AgentChatService } from '../agent/chat-service';
import { CodexEngine } from '../agent/engines/codex';
import { ClaudeEngine } from '../agent/engines/claude';
import { closeDb } from '../agent/db';
import type { RealtimeEvent } from '../agent/types';
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

export interface InternalRouteRequest {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface InternalRouteResponse {
  statusCode: number;
  headers: Record<string, unknown>;
  body: string;
  json: unknown;
  isBinary: boolean;
  base64Body: string | null;
}

const AUTH_TOKEN_ENV = 'WEBPAGE_MCP_AUTH_TOKEN';
const AUTH_TOKEN_HEADER = 'x-webpage-mcp-token';
const AUTH_TOKEN_QUERY_KEYS = ['authToken', 'token'] as const;
const AUTH_PROTECTED_PATHS = ['/agent', '/ask-extension'] as const;

// ============================================================
// Server Class
// ============================================================

export class Server {
  private static activeServerCount = 0;
  private fastify: FastifyInstance;
  public isRunning = false;
  public readonly instanceId: string;
  private nativeHost: NativeMessagingHost | null = null;
  private agentStreamManager: AgentStreamManager;
  private agentChatService: AgentChatService;

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

  private buildInjectPath(pathname: string, query?: Record<string, unknown>): string {
    const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
    if (!query || Object.keys(query).length === 0) {
      return path;
    }

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item === undefined || item === null) continue;
          params.append(key, String(item));
        }
        continue;
      }
      params.set(key, String(value));
    }
    const queryString = params.toString();
    return queryString ? `${path}?${queryString}` : path;
  }

  public async invokeInternalRoute(request: InternalRouteRequest): Promise<InternalRouteResponse> {
    await this.fastify.ready();

    const token = this.getConfiguredAuthToken();
    const headers: Record<string, string> = {
      ...(request.headers || {}),
    };
    if (token) {
      if (!headers.Authorization && !headers.authorization) {
        headers.Authorization = `Bearer ${token}`;
      }
      if (!headers['x-webpage-mcp-token']) {
        headers['x-webpage-mcp-token'] = token;
      }
    }

    const url = this.buildInjectPath(request.path, request.query);
    const injectResponse = await new Promise<{
      statusCode: number;
      headers: Record<string, unknown>;
      payload: string;
      rawPayload: Buffer;
      json: () => unknown;
    }>((resolve, reject) => {
      this.fastify.inject(
        {
          method: request.method as any,
          url,
          payload: request.body as any,
          headers,
        },
        (error, response) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(response as any);
        },
      );
    });

    const contentTypeHeader = String(injectResponse.headers['content-type'] || '').toLowerCase();
    const isJson = contentTypeHeader.includes('application/json');
    const isBinaryLike =
      contentTypeHeader.startsWith('image/') ||
      contentTypeHeader.startsWith('application/octet-stream');

    let parsedJson: unknown = null;
    if (isJson) {
      try {
        parsedJson = injectResponse.json();
      } catch {
        parsedJson = null;
      }
    }

    return {
      statusCode: injectResponse.statusCode,
      headers: injectResponse.headers,
      body: injectResponse.payload,
      json: parsedJson,
      isBinary: isBinaryLike,
      base64Body: isBinaryLike ? injectResponse.rawPayload.toString('base64') : null,
    };
  }

  public subscribeAgentEvents(
    sessionId: string,
    listener: (event: RealtimeEvent) => void,
  ): () => void {
    this.agentStreamManager.addListener(sessionId, listener);
    return () => {
      this.agentStreamManager.removeListener(sessionId, listener);
    };
  }

  // ============================================================
  // Server Lifecycle
  // ============================================================

  public async start(nativeHost: NativeMessagingHost): Promise<void> {
    if (!this.nativeHost) {
      this.nativeHost = nativeHost;
    } else if (this.nativeHost !== nativeHost) {
      this.nativeHost = nativeHost;
    }

    if (this.isRunning) {
      return;
    }

    await this.fastify.ready();
    this.isRunning = true;
    Server.activeServerCount += 1;
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    Server.activeServerCount = Math.max(0, Server.activeServerCount - 1);
    if (Server.activeServerCount === 0) {
      closeDb();
    }
  }

  public getInstance(): FastifyInstance {
    return this.fastify;
  }
}

const serverInstance = new Server({ instanceId: DEFAULT_MCP_INSTANCE_ID });
export default serverInstance;
