import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpBridgeSession, type McpBridgeSession } from './mcp-bridge-session';
import { NativeBridgeRequestScheduler } from './native-bridge-request-scheduler';
import { NativeIpcBridgeClient, type NativeBridgeRequestClient } from './native-ipc-bridge-client';
import { normalizeRemoteHostname, type RemoteMcpServerOptions } from './remote-server-config';

export const REMOTE_MCP_ENDPOINT = '/mcp';
export const REMOTE_MCP_HEALTH_ENDPOINT = '/healthz';
export const REMOTE_MCP_READY_ENDPOINT = '/readyz';
export const REMOTE_MCP_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const REMOTE_MCP_DEFAULT_MAX_SESSIONS = 64;
export const REMOTE_MCP_DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const REMOTE_MCP_DEFAULT_SESSION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const REMOTE_MCP_DEFAULT_SSE_STREAM_MAX_LIFETIME_MS = 5 * 60 * 1000;

const MAX_SESSION_ID_BYTES = 256;
const DEFAULT_MAX_ACTIVE_HTTP_REQUESTS = 128;
const NATIVE_READY_TIMEOUT_MS = 5_000;
const HTTP_REQUEST_TIMEOUT_MS = 135_000;
const HTTP_HEADERS_TIMEOUT_MS = 10_000;
const HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const HTTP_MAX_HEADERS_COUNT = 64;
const HTTP_MAX_REQUESTS_PER_SOCKET = 100;
const HTTP_MAX_CONNECTIONS = 128;

interface ClosableNativeBridge extends NativeBridgeRequestClient {
  close?: () => void;
}

interface RemoteMcpSessionRecord {
  readonly id: string;
  readonly transport: StreamableHTTPServerTransport;
  readonly bridgeSession: McpBridgeSession;
  readonly createdAt: number;
  lastActivityAt: number;
  activeOperations: number;
  activeSseStreams: number;
}

export interface RemoteMcpServerDependencies {
  bridgeClient?: ClosableNativeBridge;
  now?: () => number;
  maxSessions?: number;
  maxActiveHttpRequests?: number;
  sessionIdleTimeoutMs?: number;
  sessionMaxLifetimeMs?: number;
  sseStreamMaxLifetimeMs?: number;
}

export interface RemoteMcpListenResult {
  host: string;
  port: number;
  protocol: 'http' | 'https';
  endpoint: string;
}

class HttpRequestError extends Error {
  public constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

function secureHash(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function constantTimeSecretEquals(received: string, expectedHash: Buffer): boolean {
  const receivedHash = secureHash(received);
  return receivedHash.length === expectedHash.length && timingSafeEqual(receivedHash, expectedHash);
}

function extractBearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer[ \t]+([A-Za-z0-9._~+/-]+=*)$/i.exec(header.trim());
  return match?.[1];
}

function formatUrlHostname(hostname: string): string {
  return hostname.includes(':') ? `[${hostname}]` : hostname;
}

function requestHostname(header: string | undefined): string | undefined {
  if (!header || header.length > 512 || /[\s/?#@]/.test(header)) return undefined;
  try {
    const parsed = new URL(`http://${header}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/') return undefined;
    return normalizeRemoteHostname(parsed.hostname, 'request Host');
  } catch {
    return undefined;
  }
}

function setCommonResponseHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  setCommonResponseHeaders(response);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
  for (const [name, value] of Object.entries(headers)) {
    response.setHeader(name, value);
  }
  response.end(body);
}

function sendMcpError(
  response: ServerResponse,
  statusCode: number,
  code: number,
  message: string,
  headers?: Record<string, string>,
): void {
  sendJson(response, statusCode, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

function getSingleHeader(
  value: string | string[] | undefined,
  maximumBytes: number,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > maximumBytes) return undefined;
  return normalized;
}

function isInitializationPayload(payload: unknown): boolean {
  if (isInitializeRequest(payload)) return true;
  return Array.isArray(payload) && payload.some((entry) => isInitializeRequest(entry));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentEncoding = getSingleHeader(request.headers['content-encoding'], 64);
  if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
    throw new HttpRequestError(415, 'Content-Encoding is not supported');
  }
  const declaredLength = getSingleHeader(request.headers['content-length'], 32);
  if (declaredLength) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new HttpRequestError(400, 'Invalid Content-Length');
    }
    if (parsedLength > REMOTE_MCP_MAX_REQUEST_BODY_BYTES) {
      request.resume();
      throw new HttpRequestError(413, 'MCP request body is too large');
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let oversized = false;
  try {
    for await (const rawChunk of request) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      totalBytes += chunk.byteLength;
      if (totalBytes > REMOTE_MCP_MAX_REQUEST_BODY_BYTES) {
        oversized = true;
        continue;
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (request.aborted) {
      throw new HttpRequestError(400, 'Request body was aborted');
    }
    throw error;
  }
  if (oversized) {
    throw new HttpRequestError(413, 'MCP request body is too large');
  }
  if (totalBytes === 0) {
    throw new HttpRequestError(400, 'MCP request body is empty');
  }
  try {
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'));
  } catch {
    throw new HttpRequestError(400, 'MCP request body is invalid JSON');
  }
}

export class RemoteMcpServer {
  private readonly nativeBridgeClient: ClosableNativeBridge;
  private readonly bridgeClient: NativeBridgeRequestScheduler;
  private readonly ownsBridgeClient: boolean;
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly maxActiveHttpRequests: number;
  private readonly sessionIdleTimeoutMs: number;
  private readonly sessionMaxLifetimeMs: number;
  private readonly sseStreamMaxLifetimeMs: number;
  private readonly allowedHosts: Set<string>;
  private readonly allowedOrigins: Set<string>;
  private readonly expectedTokenHash: Buffer;
  private readonly sessions = new Map<string, RemoteMcpSessionRecord>();
  private listener: http.Server | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private closePromise: Promise<void> | null = null;
  private activeHttpRequests = 0;

  public constructor(
    private readonly options: RemoteMcpServerOptions,
    dependencies: RemoteMcpServerDependencies = {},
  ) {
    this.nativeBridgeClient = dependencies.bridgeClient || new NativeIpcBridgeClient();
    this.bridgeClient = new NativeBridgeRequestScheduler(this.nativeBridgeClient);
    this.ownsBridgeClient = !dependencies.bridgeClient;
    this.now = dependencies.now || Date.now;
    this.maxSessions = dependencies.maxSessions ?? REMOTE_MCP_DEFAULT_MAX_SESSIONS;
    this.maxActiveHttpRequests =
      dependencies.maxActiveHttpRequests ?? DEFAULT_MAX_ACTIVE_HTTP_REQUESTS;
    this.sessionIdleTimeoutMs =
      dependencies.sessionIdleTimeoutMs ?? REMOTE_MCP_DEFAULT_SESSION_IDLE_TIMEOUT_MS;
    this.sessionMaxLifetimeMs =
      dependencies.sessionMaxLifetimeMs ?? REMOTE_MCP_DEFAULT_SESSION_MAX_LIFETIME_MS;
    this.sseStreamMaxLifetimeMs =
      dependencies.sseStreamMaxLifetimeMs ?? REMOTE_MCP_DEFAULT_SSE_STREAM_MAX_LIFETIME_MS;
    if (
      !Number.isInteger(this.maxSessions) ||
      this.maxSessions <= 0 ||
      !Number.isInteger(this.maxActiveHttpRequests) ||
      this.maxActiveHttpRequests <= 0 ||
      !Number.isFinite(this.sessionIdleTimeoutMs) ||
      this.sessionIdleTimeoutMs <= 0 ||
      !Number.isFinite(this.sessionMaxLifetimeMs) ||
      this.sessionMaxLifetimeMs <= 0 ||
      !Number.isFinite(this.sseStreamMaxLifetimeMs) ||
      this.sseStreamMaxLifetimeMs <= 0
    ) {
      throw new Error('Remote MCP server capacity and lifecycle limits must be positive');
    }
    this.allowedHosts = new Set(options.allowedHosts);
    this.allowedOrigins = new Set(options.allowedOrigins);
    if (!options.token) {
      throw new Error('Remote MCP server requires a bearer token');
    }
    this.expectedTokenHash = secureHash(options.token);
  }

  public get sessionCount(): number {
    return this.sessions.size;
  }

  public async start(): Promise<RemoteMcpListenResult> {
    if (this.listener) {
      return this.getListenResult();
    }
    if (this.closePromise) {
      throw new Error('Remote MCP server has already been closed');
    }

    const requestListener = (request: IncomingMessage, response: ServerResponse): void => {
      void this.handleRequest(request, response);
    };
    const listener = this.options.tls
      ? https.createServer(
          {
            cert: this.options.tls.cert,
            key: this.options.tls.key,
            maxHeaderSize: 16 * 1024,
            requireHostHeader: true,
          },
          requestListener,
        )
      : http.createServer({ maxHeaderSize: 16 * 1024, requireHostHeader: true }, requestListener);
    listener.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
    listener.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
    listener.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
    listener.maxHeadersCount = HTTP_MAX_HEADERS_COUNT;
    listener.maxRequestsPerSocket = HTTP_MAX_REQUESTS_PER_SOCKET;
    listener.maxConnections = HTTP_MAX_CONNECTIONS;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        listener.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        listener.removeListener('error', onError);
        resolve();
      };
      listener.once('error', onError);
      listener.once('listening', onListening);
      listener.listen(this.options.port, this.options.host);
    });
    listener.on('clientError', (_error, socket) => {
      if (!socket.destroyed) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      }
    });
    this.listener = listener;

    const cleanupInterval = Math.max(
      1_000,
      Math.min(60_000, this.sessionIdleTimeoutMs / 2, this.sessionMaxLifetimeMs / 2),
    );
    this.cleanupTimer = setInterval(() => {
      void this.pruneIdleSessions();
    }, cleanupInterval);
    this.cleanupTimer.unref();

    return this.getListenResult();
  }

  private getListenResult(): RemoteMcpListenResult {
    if (!this.listener) throw new Error('Remote MCP server is not listening');
    const address = this.listener.address();
    if (!address || typeof address === 'string') {
      throw new Error('Remote MCP server has no TCP listen address');
    }
    const protocol = this.options.tls ? 'https' : 'http';
    const displayHost = ['0.0.0.0', '::'].includes(this.options.host)
      ? this.options.allowedHosts[0]!
      : this.options.host;
    return {
      host: this.options.host,
      port: address.port,
      protocol,
      endpoint: `${protocol}://${formatUrlHostname(displayHost)}:${address.port}${REMOTE_MCP_ENDPOINT}`,
    };
  }

  private validateRequestAuthority(request: IncomingMessage, response: ServerResponse): boolean {
    const hostname = requestHostname(getSingleHeader(request.headers.host, 512));
    if (!hostname || !this.allowedHosts.has(hostname)) {
      sendJson(response, 403, { error: 'Forbidden Host' });
      return false;
    }
    const origin = getSingleHeader(request.headers.origin, 2048);
    if (origin) {
      let parsedOrigin: URL;
      try {
        parsedOrigin = new URL(origin);
      } catch {
        sendJson(response, 403, { error: 'Forbidden Origin' });
        return false;
      }
      if (
        parsedOrigin.origin === 'null' ||
        parsedOrigin.username ||
        parsedOrigin.password ||
        parsedOrigin.pathname !== '/' ||
        parsedOrigin.search ||
        parsedOrigin.hash ||
        origin.endsWith('/') ||
        !this.allowedOrigins.has(parsedOrigin.origin)
      ) {
        sendJson(response, 403, { error: 'Forbidden Origin' });
        return false;
      }
    }
    return true;
  }

  private validateAuthorization(request: IncomingMessage, response: ServerResponse): boolean {
    const token = extractBearerToken(request.headers.authorization);
    if (!token || !constantTimeSecretEquals(token, this.expectedTokenHash)) {
      sendJson(response, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      return false;
    }
    return true;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closePromise) {
      sendJson(response, 503, { error: 'Server is shutting down' });
      return;
    }
    if (this.activeHttpRequests >= this.maxActiveHttpRequests) {
      sendJson(response, 503, { error: 'Too many active requests' }, { 'Retry-After': '1' });
      return;
    }
    this.activeHttpRequests += 1;
    try {
      if (!this.validateRequestAuthority(request, response)) return;
      let pathname: string;
      try {
        pathname = new URL(request.url || '/', 'http://webpage-mcp.invalid').pathname;
      } catch {
        sendJson(response, 400, { error: 'Invalid request URL' });
        return;
      }

      if (pathname === REMOTE_MCP_HEALTH_ENDPOINT) {
        if (request.method !== 'GET') {
          sendJson(response, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
          return;
        }
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      if (!this.validateAuthorization(request, response)) return;

      if (pathname === REMOTE_MCP_READY_ENDPOINT) {
        if (request.method !== 'GET') {
          sendJson(response, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
          return;
        }
        try {
          const result = await this.bridgeClient.request<{ ok?: boolean }>(
            'ping',
            { instanceId: this.options.instanceId },
            NATIVE_READY_TIMEOUT_MS,
          );
          if (result?.ok !== true) throw new Error('Native bridge returned an invalid response');
          sendJson(response, 200, { status: 'ready' });
        } catch {
          sendJson(response, 503, { status: 'unavailable' }, { 'Retry-After': '1' });
        }
        return;
      }

      if (pathname !== REMOTE_MCP_ENDPOINT) {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }
      if (!['GET', 'POST', 'DELETE'].includes(request.method || '')) {
        sendMcpError(response, 405, -32_000, 'Method not allowed', {
          Allow: 'GET, POST, DELETE',
        });
        return;
      }

      await this.pruneIdleSessions();
      await this.handleMcpRequest(request, response);
    } catch (error) {
      if (error instanceof HttpRequestError) {
        sendMcpError(response, error.statusCode, -32_700, error.message);
        return;
      }
      console.error('[webpage-mcp-server] Request failed:', error);
      if (!response.headersSent && !response.writableEnded) {
        sendMcpError(response, 500, -32_603, 'Internal server error');
      } else if (!response.destroyed) {
        response.destroy();
      }
    } finally {
      this.activeHttpRequests = Math.max(0, this.activeHttpRequests - 1);
    }
  }

  private async handleMcpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const rawSessionId = request.headers['mcp-session-id'];
    const sessionId = getSingleHeader(rawSessionId, MAX_SESSION_ID_BYTES);
    if (rawSessionId !== undefined && !sessionId) {
      sendMcpError(response, 400, -32_000, 'Invalid Mcp-Session-Id header');
      return;
    }

    let parsedBody: unknown;
    if (request.method === 'POST') {
      parsedBody = await readJsonBody(request);
    }

    let record = sessionId ? this.sessions.get(sessionId) : undefined;
    let newlyCreated = false;
    if (!record) {
      if (sessionId) {
        sendMcpError(response, 404, -32_001, 'Session not found');
        return;
      }
      if (request.method !== 'POST' || !isInitializationPayload(parsedBody)) {
        sendMcpError(response, 400, -32_000, 'A valid initialization request is required');
        return;
      }
      if (this.sessions.size >= this.maxSessions) {
        sendMcpError(response, 503, -32_000, 'Remote MCP session limit reached', {
          'Retry-After': '1',
        });
        return;
      }
      record = await this.createSession();
      newlyCreated = true;
    }

    const isStandaloneSseRequest = request.method === 'GET';
    let streamLifetimeTimer: NodeJS.Timeout | null = null;
    if (isStandaloneSseRequest) {
      record.activeSseStreams += 1;
      streamLifetimeTimer = setTimeout(() => {
        record.transport.closeStandaloneSSEStream();
      }, this.sseStreamMaxLifetimeMs);
      streamLifetimeTimer.unref();
    } else {
      record.activeOperations += 1;
      record.lastActivityAt = this.now();
    }
    try {
      await record.transport.handleRequest(request, response, parsedBody);
    } finally {
      if (streamLifetimeTimer) {
        clearTimeout(streamLifetimeTimer);
        record.activeSseStreams = Math.max(0, record.activeSseStreams - 1);
      } else {
        record.activeOperations = Math.max(0, record.activeOperations - 1);
        record.lastActivityAt = this.now();
      }
      if (newlyCreated && record.transport.sessionId !== record.id) {
        await this.disposeSession(record.id);
      }
    }
  }

  private async createSession(): Promise<RemoteMcpSessionRecord> {
    const id = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      enableJsonResponse: true,
    });
    const bridgeSession = createMcpBridgeSession({
      bridgeClient: this.bridgeClient,
      sessionId: id,
      instanceId: this.options.instanceId,
      serverName: 'WebpageMcpRemoteServer',
      logLabel: 'webpage-mcp-server',
      onToolListChanged: async () => this.broadcastToolListChanged(),
    });
    const now = this.now();
    const record: RemoteMcpSessionRecord = {
      id,
      transport,
      bridgeSession,
      createdAt: now,
      lastActivityAt: now,
      activeOperations: 0,
      activeSseStreams: 0,
    };
    transport.onerror = (error) => {
      console.warn(`[webpage-mcp-server] MCP session ${id} transport error:`, error.message);
    };
    transport.onclose = () => {
      void this.disposeSession(id);
    };
    try {
      this.sessions.set(id, record);
      await bridgeSession.server.connect(transport);
      return record;
    } catch (error) {
      await this.disposeSession(id);
      throw error;
    }
  }

  private async broadcastToolListChanged(): Promise<void> {
    const notifications = [...this.sessions.values()].map((record) =>
      record.bridgeSession.server.sendToolListChanged(),
    );
    const results = await Promise.allSettled(notifications);
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn(
          '[webpage-mcp-server] Failed to broadcast tools/list_changed notification:',
          result.reason,
        );
      }
    }
  }

  private async pruneIdleSessions(): Promise<void> {
    const now = this.now();
    const expired = [...this.sessions.values()]
      .filter(
        (record) =>
          now - record.createdAt >= this.sessionMaxLifetimeMs ||
          (record.activeOperations === 0 &&
            now - record.lastActivityAt >= this.sessionIdleTimeoutMs),
      )
      .map((record) => record.id);
    await Promise.allSettled(expired.map((id) => this.disposeSession(id)));
  }

  private async disposeSession(id: string): Promise<void> {
    const record = this.sessions.get(id);
    if (!record) return;
    this.sessions.delete(id);
    await record.bridgeSession.close().catch((error) => {
      console.warn(`[webpage-mcp-server] Failed to close MCP session ${id}:`, error);
    });
  }

  public close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.performClose();
    }
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const listener = this.listener;
    this.listener = null;
    const listenerClosed = listener
      ? new Promise<void>((resolve, reject) => {
          listener.close((error) => (error ? reject(error) : resolve()));
        })
      : Promise.resolve();

    this.bridgeClient.close();
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.disposeSession(id)));
    listener?.closeIdleConnections?.();
    listener?.closeAllConnections?.();
    await listenerClosed;
    if (this.ownsBridgeClient) {
      this.nativeBridgeClient.close?.();
    }
  }
}
