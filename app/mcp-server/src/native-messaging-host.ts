import { stdin, stdout } from 'process';
import net from 'node:net';
import { Server } from './server';
import { v4 as uuidv4 } from 'uuid';
import {
  DEFAULT_MCP_INSTANCE_ID,
  isAgentRpcRequestPayload,
  NativeMessageType,
  type AgentRpcRequestPayload,
  type McpServerInstanceConfig,
  type McpServerInstanceStatus,
  type NativeSyncInstancesPayload,
} from 'webpage-mcp-shared';
import { TIMEOUTS } from './constant';
import fileHandler from './file-handler';
import type { RealtimeEvent } from './agent/types';
import {
  ensureNativeSocketParentDir,
  getLegacyNativeSocketPath,
  getNativeSocketPath,
} from './ipc/socket-path';
import {
  constantTimeTokenEquals,
  createNativeIpcCredential,
  IPC_AUTH_METHOD,
  removeNativeIpcCredential,
  type NativeIpcCredential,
} from './ipc/bridge-auth';
import { BoundedNdjsonDecoder } from './ipc/bounded-ndjson';
import { IPC_CANCEL_REQUEST_METHOD } from './ipc/bridge-protocol';
import {
  captureUnixSocketIdentity,
  prepareUnixSocketPath,
  removeOwnedUnixSocket,
  type UnixSocketIdentity,
} from './ipc/socket-lifecycle';
import {
  callToolForContext,
  listToolsForContext,
  type McpClientCapabilityFallback,
} from './mcp/register-tools';
import { NativeMessageFrameDecoder } from './native-message-framing';
import { NativeDirectiveQueue } from './native-directive-queue';
import {
  isNativeMessageEncodingError,
  NativeMessageWriter,
  type NativeMessageSendOptions,
} from './native-message-output';
import { resolveInstanceId } from './instance-id';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timeoutId: NodeJS.Timeout;
}

interface AgentStreamSubscription {
  subscriptionId: string;
  instanceId: string;
  sessionId: string;
  dispose: () => void;
}

const IPC_MAX_REQUEST_LINE_BYTES = 1024 * 1024;
const IPC_MAX_RESPONSE_LINE_BYTES = 16 * 1024 * 1024;
const IPC_MAX_IN_FLIGHT_REQUESTS = 4;
const IPC_MAX_PENDING_REQUESTS = 16;
const IPC_PAUSE_HIGH_WATERMARK = 8;
const IPC_RESUME_LOW_WATERMARK = 4;
export const IPC_MAX_CONNECTIONS = 64;
export const IPC_AUTHENTICATION_TIMEOUT_MS = 5_000;
const NATIVE_MAX_PENDING_DIRECTIVES = 64;
export const NATIVE_MAX_SERVER_INSTANCES = 64;
export const NATIVE_MAX_INSTANCE_LABEL_BYTES = 256;
export const NATIVE_CONTROL_IDENTIFIER_MAX_BYTES = 256;
export const NATIVE_MESSAGE_TYPE_MAX_BYTES = 128;
export const NATIVE_CONTROL_ERROR_MAX_BYTES = 8 * 1024;
export const IPC_METHOD_MAX_BYTES = 128;
export const IPC_TOOL_NAME_MAX_BYTES = 256;

export function createNativeIpcListenOptions(socketPath: string): net.ListenOptions {
  return {
    path: socketPath,
    // Keep the Windows named pipe on Node's private default explicitly. These
    // flags are ignored for Unix-domain sockets.
    readableAll: false,
    writableAll: false,
    exclusive: true,
  };
}

function isBoundedNonEmptyString(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes
  );
}

function truncateControlText(value: string, maximumBytes = NATIVE_CONTROL_ERROR_MAX_BYTES): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value;
  const marker = '…';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  let retained = '';
  let retainedBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (retainedBytes + characterBytes + markerBytes > maximumBytes) break;
    retained += character;
    retainedBytes += characterBytes;
  }
  return `${retained}${marker}`;
}

function agentStreamCoalesceKey(...parts: string[]): string {
  // JSON tuple encoding prevents delimiter collisions between subscription IDs
  // and message IDs while keeping keys deterministic and easy to inspect.
  return JSON.stringify(['agent-stream', ...parts]);
}

function getAgentStreamSendOptions(
  subscriptionId: string,
  event: RealtimeEvent,
): NativeMessageSendOptions {
  switch (event.type) {
    case 'message':
      return {
        coalesceKey: agentStreamCoalesceKey(subscriptionId, 'message', event.data.id),
        // Assistant completion is the cumulative snapshot the UI and storage
        // must converge on. Tool messages remain evictable under backpressure.
        terminal: event.data.role === 'assistant' && event.data.isFinal === true,
      };
    case 'status':
      return {
        coalesceKey: agentStreamCoalesceKey(subscriptionId, 'status'),
        terminal: ['completed', 'error', 'cancelled'].includes(event.data.status),
      };
    case 'error':
      return {
        coalesceKey: agentStreamCoalesceKey(subscriptionId, 'error'),
        terminal: true,
      };
    case 'usage':
      return { coalesceKey: agentStreamCoalesceKey(subscriptionId, 'usage') };
    case 'heartbeat':
      return { coalesceKey: agentStreamCoalesceKey(subscriptionId, 'heartbeat') };
    case 'connected':
      return { coalesceKey: agentStreamCoalesceKey(subscriptionId, 'connected') };
  }
}

function normalizeInstanceConfig(raw: unknown): McpServerInstanceConfig | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const instanceId = resolveInstanceId(obj.instanceId);
  if (
    typeof obj.label === 'string' &&
    Buffer.byteLength(obj.label, 'utf8') > NATIVE_MAX_INSTANCE_LABEL_BYTES
  ) {
    throw new Error(`Instance label exceeds ${NATIVE_MAX_INSTANCE_LABEL_BYTES} bytes`);
  }

  return {
    instanceId,
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : true,
    autoStart: typeof obj.autoStart === 'boolean' ? obj.autoStart : true,
    label: typeof obj.label === 'string' && obj.label.trim() ? obj.label.trim() : undefined,
  };
}

function sortInstanceConfigs(instances: McpServerInstanceConfig[]): McpServerInstanceConfig[] {
  return [...instances].sort((a, b) => {
    if (a.instanceId === DEFAULT_MCP_INSTANCE_ID && b.instanceId !== DEFAULT_MCP_INSTANCE_ID) return -1;
    if (b.instanceId === DEFAULT_MCP_INSTANCE_ID && a.instanceId !== DEFAULT_MCP_INSTANCE_ID) return 1;
    return a.instanceId.localeCompare(b.instanceId);
  });
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, entryValue]) => typeof entryValue === 'string',
  ) as Array<[string, string]>;
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
}

const MAX_AGENT_STREAM_SUBSCRIPTIONS = 128;
const MAX_AGENT_STREAM_SUBSCRIPTIONS_PER_SESSION = 16;
const MAX_AGENT_STREAM_IDENTIFIER_BYTES = 256;

function isBoundedAgentStreamIdentifier(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') <= MAX_AGENT_STREAM_IDENTIFIER_BYTES;
}

export class NativeMessagingHost {
  private servers: Map<string, Server> = new Map();
  private instanceStatuses: Map<string, McpServerInstanceStatus> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private streamSubscriptions: Map<string, AgentStreamSubscription> = new Map();
  private ipcServer: net.Server | null = null;
  private ipcSockets: Set<net.Socket> = new Set();
  private ipcCredential: NativeIpcCredential | null = null;
  private ipcSocketIdentity: UnixSocketIdentity | null = null;
  private ipcSocketPath: string | null = null;
  private messageHandlingCleanup: (() => void) | null = null;
  private processShutdownRequested = false;
  private shutdownPromise: Promise<void> | null = null;
  private static readonly AUTH_TOKEN_ENV = 'WEBPAGE_MCP_AUTH_TOKEN';

  public constructor(private readonly messageWriter = new NativeMessageWriter(stdout)) {}

  public setServer(serverInstance: Server): void {
    const instanceId = resolveInstanceId(serverInstance.instanceId);
    this.servers.set(instanceId, serverInstance);
    serverInstance.setNativeHost(this);
    this.instanceStatuses.set(instanceId, {
      instanceId,
      isRunning: serverInstance.isRunning,
      lastUpdated: Date.now(),
    });
  }

  // add message handler to wait for start server
  public async start(): Promise<void> {
    await this.setupIpcServer();
    this.setupMessageHandling();
  }

  public async stopServers(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.servers.values()).map((server) => server.stop()),
    );
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      const details = failures
        .map((failure) =>
          failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
        )
        .join('; ');
      throw new Error(`Failed to stop one or more MCP server instances: ${details}`);
    }
  }

  /** Release every native-host resource. Safe to call more than once. */
  public shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.performShutdown();
    }
    return this.shutdownPromise;
  }

  private async setupIpcServer(): Promise<void> {
    const socketPath = getNativeSocketPath();

    if (process.platform !== 'win32') {
      ensureNativeSocketParentDir(socketPath);
      const preparation = await prepareUnixSocketPath(socketPath);
      if (preparation === 'active') {
        throw new Error(`IPC socket is already owned by a running native host: ${socketPath}`);
      }

      // Best-effort cleanup for legacy tmp socket path from older builds.
      const legacySocketPath = getLegacyNativeSocketPath();
      if (!process.env.WEBPAGE_MCP_NATIVE_SOCKET?.trim() && legacySocketPath !== socketPath) {
        await prepareUnixSocketPath(legacySocketPath).catch(() => {
          // Never disturb an active listener or unrelated entry at the legacy path.
        });
      }
    }

    const pendingSockets = new Set<net.Socket>();
    let boundSocketIdentity: UnixSocketIdentity | null = null;
    let createdCredential: NativeIpcCredential | null = null;
    let bridgeReady = false;
    const ipcServer = net.createServer({ pauseOnConnect: true }, (socket) => {
      if (!bridgeReady) {
        if (pendingSockets.size + this.ipcSockets.size >= IPC_MAX_CONNECTIONS) {
          socket.destroy();
          return;
        }
        pendingSockets.add(socket);
        socket.once('close', () => pendingSockets.delete(socket));
        return;
      }
      this.acceptIpcSocket(socket);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          ipcServer.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          ipcServer.removeListener('error', onError);
          resolve();
        };

        ipcServer.once('error', onError);
        ipcServer.once('listening', onListening);
        ipcServer.listen(createNativeIpcListenOptions(socketPath));
      });

      ipcServer.on('error', (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.sendError(`IPC server error: ${message}`);
      });

      boundSocketIdentity = process.platform === 'win32' ? null : captureUnixSocketIdentity(socketPath);
      createdCredential = createNativeIpcCredential(socketPath);

      this.ipcServer = ipcServer;
      this.ipcCredential = createdCredential;
      this.ipcSocketIdentity = boundSocketIdentity;
      this.ipcSocketPath = socketPath;
      bridgeReady = true;

      for (const socket of pendingSockets) {
        pendingSockets.delete(socket);
        if (!socket.destroyed) {
          this.acceptIpcSocket(socket);
        }
      }
    } catch (error) {
      for (const socket of pendingSockets) {
        socket.destroy();
      }
      pendingSockets.clear();
      try {
        ipcServer.close();
      } catch {
        // Ignore cleanup failure while preserving the startup error.
      }

      if (createdCredential) {
        removeNativeIpcCredential(createdCredential);
        if (this.ipcCredential === createdCredential) {
          this.ipcCredential = null;
        }
      }
      if (process.platform !== 'win32' && boundSocketIdentity) {
        try {
          removeOwnedUnixSocket(socketPath, boundSocketIdentity);
        } catch {
          // The path was never bound or no longer belongs to this startup attempt.
        }
      }
      throw error;
    }
  }

  private acceptIpcSocket(socket: net.Socket): boolean {
    if (this.ipcSockets.size >= IPC_MAX_CONNECTIONS) {
      socket.destroy();
      return false;
    }
    this.handleIpcSocket(socket);
    socket.resume();
    return true;
  }

  private handleIpcSocket(socket: net.Socket): void {
    this.ipcSockets.add(socket);
    const decoder = new BoundedNdjsonDecoder(IPC_MAX_REQUEST_LINE_BYTES);
    const requestQueue: any[] = [];
    const activeControllers = new Map<string, AbortController>();
    let authenticated = false;
    let activeRequests = 0;
    let pendingCancellationResponses = 0;
    let inputPaused = false;
    let closing = false;
    let closed = false;
    let writeTail = Promise.resolve();
    let authenticationTimeout: NodeJS.Timeout | null = null;

    const clearAuthenticationTimeout = (): void => {
      if (!authenticationTimeout) return;
      clearTimeout(authenticationTimeout);
      authenticationTimeout = null;
    };

    const send = (payload: any): Promise<void> => {
      let serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized, 'utf8') > IPC_MAX_RESPONSE_LINE_BYTES) {
        serialized = JSON.stringify({
          id: payload?.id ?? null,
          error: `IPC response exceeds the ${IPC_MAX_RESPONSE_LINE_BYTES}-byte limit`,
        });
      }
      const framed = `${serialized}\n`;
      const write = writeTail.then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (socket.destroyed) {
              reject(new Error('IPC socket is closed'));
              return;
            }
            try {
              socket.write(framed, (error) => {
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              });
            } catch (error) {
              reject(error);
            }
          }),
      );
      writeTail = write.catch(() => {});
      return write;
    };

    const abortConnectionWork = (): void => {
      requestQueue.length = 0;
      for (const controller of activeControllers.values()) {
        controller.abort();
      }
      activeControllers.clear();
    };

    const closeWithError = (id: unknown, error: string): void => {
      if (closing || closed) {
        return;
      }
      closing = true;
      socket.pause();
      abortConnectionWork();
      void send({ id: typeof id === 'string' ? id : null, error }).finally(() => {
        socket.destroy();
      });
    };

    const updateInputBackpressure = (): void => {
      if (closing || closed) {
        return;
      }
      const pendingCount = activeRequests + requestQueue.length;
      if (!inputPaused && pendingCount >= IPC_PAUSE_HIGH_WATERMARK) {
        socket.pause();
        inputPaused = true;
      } else if (inputPaused && pendingCount <= IPC_RESUME_LOW_WATERMARK) {
        socket.resume();
        inputPaused = false;
      }
    };

    const processRequestQueue = (): void => {
      while (
        !closing &&
        !closed &&
        activeRequests < IPC_MAX_IN_FLIGHT_REQUESTS &&
        requestQueue.length > 0
      ) {
        const request = requestQueue.shift();
        const controller = new AbortController();
        activeControllers.set(request.id, controller);
        activeRequests += 1;

        void (async () => {
          try {
            const result = await this.handleIpcRequest(request, controller.signal);
            if (!closing && !closed && !controller.signal.aborted) {
              await send({ id: request.id, result });
            }
          } catch (error) {
            if (!closing && !closed && !controller.signal.aborted) {
              await send({
                id: request?.id ?? null,
                error: truncateControlText(
                  error instanceof Error ? error.message : String(error),
                ),
              });
            }
          } finally {
            if (activeControllers.get(request.id) === controller) {
              activeControllers.delete(request.id);
            }
            activeRequests -= 1;
            updateInputBackpressure();
            processRequestQueue();
          }
        })();
      }
      updateInputBackpressure();
    };

    authenticationTimeout = setTimeout(() => {
      if (authenticated || closing || closed) return;
      // Do not wait for a peer-controlled write callback when enforcing the
      // authentication deadline.
      closing = true;
      decoder.reset();
      abortConnectionWork();
      socket.destroy();
    }, IPC_AUTHENTICATION_TIMEOUT_MS);
    authenticationTimeout.unref();

    socket.on('data', (chunk: Buffer) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (error) {
        closeWithError(null, error instanceof Error ? error.message : 'Invalid IPC frame');
        return;
      }

      for (const line of lines) {
        if (closing || closed || !line) {
          continue;
        }

        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          closeWithError(null, 'Invalid JSON payload');
          return;
        }

        if (
          typeof parsed?.id === 'string' &&
          !isBoundedNonEmptyString(parsed.id, NATIVE_CONTROL_IDENTIFIER_MAX_BYTES)
        ) {
          closeWithError(null, `IPC request id exceeds ${NATIVE_CONTROL_IDENTIFIER_MAX_BYTES} bytes`);
          return;
        }

        if (!authenticated) {
          const token = parsed?.params?.token;
          if (
            typeof parsed?.id !== 'string' ||
            !parsed.id ||
            parsed?.method !== IPC_AUTH_METHOD ||
            !this.ipcCredential ||
            !constantTimeTokenEquals(token, this.ipcCredential.token)
          ) {
            closeWithError(parsed?.id, 'IPC authentication failed');
            return;
          }
          authenticated = true;
          clearAuthenticationTimeout();
          void send({ id: parsed.id, result: { authenticated: true } });
          continue;
        }

        if (parsed?.method === IPC_AUTH_METHOD) {
          void send({ id: parsed?.id ?? null, error: 'IPC connection is already authenticated' });
          continue;
        }

        if (typeof parsed?.id !== 'string' || !parsed.id) {
          closeWithError(null, 'IPC request id must be a non-empty string');
          return;
        }
        if (!isBoundedNonEmptyString(parsed.method, IPC_METHOD_MAX_BYTES)) {
          closeWithError(parsed.id, `IPC method must be a non-empty string up to ${IPC_METHOD_MAX_BYTES} bytes`);
          return;
        }
        if (parsed.method === IPC_CANCEL_REQUEST_METHOD) {
          if (pendingCancellationResponses >= IPC_MAX_PENDING_REQUESTS) {
            closeWithError(parsed.id, 'IPC connection has too many cancellation requests');
            return;
          }
          pendingCancellationResponses += 1;
          const sendCancellationResponse = (payload: unknown): void => {
            void send(payload)
              .finally(() => {
                pendingCancellationResponses -= 1;
              })
              .catch(() => {});
          };
          const targetRequestId =
            typeof parsed?.params?.requestId === 'string' ? parsed.params.requestId : '';
          if (!targetRequestId) {
            sendCancellationResponse({
              id: parsed.id,
              error: 'requestId is required for IPC cancellation',
            });
            continue;
          }
          if (!isBoundedNonEmptyString(targetRequestId, NATIVE_CONTROL_IDENTIFIER_MAX_BYTES)) {
            sendCancellationResponse({
              id: parsed.id,
              error: `requestId exceeds ${NATIVE_CONTROL_IDENTIFIER_MAX_BYTES} bytes`,
            });
            continue;
          }

          let cancelled = false;
          const queuedIndex = requestQueue.findIndex(
            (queuedRequest) => queuedRequest?.id === targetRequestId,
          );
          if (queuedIndex >= 0) {
            requestQueue.splice(queuedIndex, 1);
            cancelled = true;
          }
          const activeController = activeControllers.get(targetRequestId);
          if (activeController) {
            activeController.abort();
            cancelled = true;
          }
          sendCancellationResponse({ id: parsed.id, result: { cancelled } });
          updateInputBackpressure();
          processRequestQueue();
          continue;
        }
        if (
          activeControllers.has(parsed.id) ||
          requestQueue.some((queuedRequest) => queuedRequest?.id === parsed.id)
        ) {
          closeWithError(parsed.id, 'IPC request id is already in use');
          return;
        }
        if (activeRequests + requestQueue.length >= IPC_MAX_PENDING_REQUESTS) {
          closeWithError(parsed.id, 'IPC connection has too many pending requests');
          return;
        }
        requestQueue.push(parsed);
        processRequestQueue();
      }
    });

    socket.on('close', () => {
      closed = true;
      clearAuthenticationTimeout();
      decoder.reset();
      abortConnectionWork();
      this.ipcSockets.delete(socket);
    });
    socket.on('error', () => {
      if (!socket.destroyed) {
        socket.destroy();
      }
    });
  }

  private async handleIpcRequest(request: any, signal?: AbortSignal): Promise<unknown> {
    const method = typeof request?.method === 'string' ? request.method : '';
    if (!isBoundedNonEmptyString(method, IPC_METHOD_MAX_BYTES)) {
      throw new Error(`IPC method must be a non-empty string up to ${IPC_METHOD_MAX_BYTES} bytes`);
    }
    const params = request?.params && typeof request.params === 'object' ? request.params : {};
    const instanceId = resolveInstanceId((params as Record<string, unknown>).instanceId);
    const sessionIdRaw = (params as Record<string, unknown>).sessionId;
    if (
      sessionIdRaw !== undefined &&
      !isBoundedNonEmptyString(sessionIdRaw, NATIVE_CONTROL_IDENTIFIER_MAX_BYTES)
    ) {
      throw new Error(`sessionId must be a non-empty string up to ${NATIVE_CONTROL_IDENTIFIER_MAX_BYTES} bytes`);
    }
    const sessionId =
      typeof sessionIdRaw === 'string' && sessionIdRaw.trim() ? sessionIdRaw.trim() : uuidv4();

    switch (method) {
      case 'ping':
        return { ok: true };
      case 'mcp_list_tools': {
        const tools = await listToolsForContext({
          sessionId,
          instanceId,
          nativeHost: this,
          signal,
          clientCapabilities: (params as Record<string, unknown>)
            .clientCapabilities as McpClientCapabilityFallback | undefined,
        });
        return { tools };
      }
      case 'mcp_call_tool': {
        const paramsRecord = params as Record<string, unknown>;
        const name = typeof paramsRecord.name === 'string' ? paramsRecord.name : '';
        if (!isBoundedNonEmptyString(name, IPC_TOOL_NAME_MAX_BYTES)) {
          throw new Error(`name must be a non-empty string up to ${IPC_TOOL_NAME_MAX_BYTES} bytes`);
        }
        const args = paramsRecord.args ?? {};
        const result = await callToolForContext(
          {
            sessionId,
            instanceId,
            nativeHost: this,
            signal,
            clientCapabilities: paramsRecord.clientCapabilities as McpClientCapabilityFallback | undefined,
          },
          name,
          args,
        );
        return { result };
      }
      default:
        throw new Error(`Unsupported IPC method: ${method}`);
    }
  }

  private setupMessageHandling(): void {
    const decoder = new NativeMessageFrameDecoder();
    const directiveQueue = new NativeDirectiveQueue<Buffer>(
      NATIVE_MAX_PENDING_DIRECTIVES,
      (messageBuffer) => this.handleMessage(JSON.parse(messageBuffer.toString('utf8'))),
      (error) => {
        this.sendError(
          `Failed to handle directive message: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
    let framingFailed = false;

    const onReadable = () => {
      let chunk;
      while ((chunk = stdin.read()) !== null) {
        try {
          decoder.write(chunk, (messageBuffer) => {
            const message = JSON.parse(messageBuffer.toString());
            if (message?.responseToRequestId) {
              // Extension responses unblock active directives and must never wait behind them.
              void this.handleMessage(message);
            } else {
              // Retain the original frame rather than a parsed object so the
              // queue's byte budget exactly matches the memory it owns.
              directiveQueue.enqueue(messageBuffer);
            }
          });
        } catch (error) {
          framingFailed = true;
          stdin.removeListener('readable', onReadable);
          this.sendError(error instanceof Error ? error.message : String(error));
          this.requestProcessShutdown(1);
          break;
        }
      }
    };

    const onEnd = (): void => {
      if (!framingFailed) {
        this.requestProcessShutdown(0);
      }
    };

    const onError = (): void => {
      if (!framingFailed) {
        this.requestProcessShutdown(1);
      }
    };

    stdin.on('readable', onReadable);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
    this.messageHandlingCleanup = () => {
      directiveQueue.close();
      stdin.removeListener('readable', onReadable);
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      this.messageHandlingCleanup = null;
    };
  }

  private getOrCreateServer(instanceId: string): Server {
    const normalized = resolveInstanceId(instanceId);
    let server = this.servers.get(normalized);
    if (server) {
      return server;
    }
    server = new Server({ instanceId: normalized });
    server.setNativeHost(this);
    this.servers.set(normalized, server);
    this.instanceStatuses.set(normalized, {
      instanceId: normalized,
      isRunning: false,
      lastUpdated: Date.now(),
    });
    return server;
  }

  private snapshotInstanceStatus(instanceId: string): McpServerInstanceStatus {
    const normalized = resolveInstanceId(instanceId);
    const server = this.servers.get(normalized);
    const status: McpServerInstanceStatus = {
      instanceId: normalized,
      isRunning: server?.isRunning ?? false,
      lastUpdated: Date.now(),
    };

    this.instanceStatuses.set(normalized, status);
    return status;
  }

  private listServerInstances(): McpServerInstanceStatus[] {
    const ids = new Set<string>([...this.instanceStatuses.keys(), ...this.servers.keys()]);
    const statuses = Array.from(ids).map((instanceId) => this.snapshotInstanceStatus(instanceId));
    statuses.sort((a, b) => {
      if (a.instanceId === DEFAULT_MCP_INSTANCE_ID && b.instanceId !== DEFAULT_MCP_INSTANCE_ID) return -1;
      if (b.instanceId === DEFAULT_MCP_INSTANCE_ID && a.instanceId !== DEFAULT_MCP_INSTANCE_ID) return 1;
      return a.instanceId.localeCompare(b.instanceId);
    });
    return statuses;
  }

  private async startServer(instanceId: string): Promise<McpServerInstanceStatus> {
    const normalized = resolveInstanceId(instanceId);
    const server = this.getOrCreateServer(normalized);

    if (server.isRunning) {
      const runningStatus = this.snapshotInstanceStatus(normalized);
      this.sendMessage({
        type: NativeMessageType.SERVER_STARTED,
        payload: { instanceId: normalized },
      });
      return runningStatus;
    }

    await server.start(this);
    const status: McpServerInstanceStatus = {
      instanceId: normalized,
      isRunning: true,
      lastUpdated: Date.now(),
    };
    this.instanceStatuses.set(normalized, status);

    this.sendMessage({
      type: NativeMessageType.SERVER_STARTED,
      payload: { instanceId: normalized },
    });

    return status;
  }

  private async stopServer(instanceId: string): Promise<McpServerInstanceStatus> {
    const normalized = resolveInstanceId(instanceId);
    const server = this.servers.get(normalized);

    if (server?.isRunning) {
      await server.stop();
    }

    this.cleanupStreamSubscriptionsForInstance(normalized);

    const status: McpServerInstanceStatus = {
      instanceId: normalized,
      isRunning: false,
      lastUpdated: Date.now(),
    };
    this.instanceStatuses.set(normalized, status);

    this.sendMessage({
      type: NativeMessageType.SERVER_STOPPED,
      payload: { instanceId: normalized },
    });

    return status;
  }

  private sendRequestResponse(requestId: string, payload?: unknown, error?: string): void {
    const response: Record<string, unknown> = {
      responseToRequestId: requestId,
    };
    if (error) {
      response.error = truncateControlText(error);
    } else {
      response.payload = payload;
    }
    this.sendMessage(response);
  }

  private reportMessageWriteFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[NativeMessagingHost] ${message}\n`);
  }

  private resolveStartDirective(
    payload: unknown,
  ): {
    instanceId: string;
  } {
    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      return {
        instanceId: resolveInstanceId(obj.instanceId),
      };
    }

    return {
      instanceId: DEFAULT_MCP_INSTANCE_ID,
    };
  }

  private resolveStopDirective(payload: unknown): { instanceId: string } {
    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      return {
        instanceId: resolveInstanceId(obj.instanceId),
      };
    }
    return {
      instanceId: DEFAULT_MCP_INSTANCE_ID,
    };
  }

  private resolveSyncDirective(payload: unknown): McpServerInstanceConfig[] {
    const rawPayload = payload && typeof payload === 'object' ? (payload as NativeSyncInstancesPayload) : null;
    const rawInstances = Array.isArray(rawPayload?.instances) ? rawPayload.instances : [];
    if (rawInstances.length > NATIVE_MAX_SERVER_INSTANCES) {
      throw new Error(`Instance count exceeds ${NATIVE_MAX_SERVER_INSTANCES}`);
    }
    const byId = new Map<string, McpServerInstanceConfig>();

    for (const raw of rawInstances) {
      const normalized = normalizeInstanceConfig(raw);
      if (!normalized) continue;
      byId.set(normalized.instanceId, normalized);
    }

    if (!byId.has(DEFAULT_MCP_INSTANCE_ID)) {
      byId.set(DEFAULT_MCP_INSTANCE_ID, {
        instanceId: DEFAULT_MCP_INSTANCE_ID,
        enabled: true,
        autoStart: true,
        label: 'Default',
      });
    }

    return sortInstanceConfigs(Array.from(byId.values()));
  }

  private async syncServers(instances: McpServerInstanceConfig[]): Promise<McpServerInstanceStatus[]> {
    const desiredIds = new Set<string>(instances.map((item) => item.instanceId));

    for (const instance of instances) {
      if (!instance.enabled) {
        await this.stopServer(instance.instanceId);
        continue;
      }

      if (instance.autoStart) {
        await this.startServer(instance.instanceId);
        continue;
      }

      // Keep manual instances as-is: do not auto-start or auto-stop.
      this.snapshotInstanceStatus(instance.instanceId);
    }

    const knownIds = new Set<string>([...this.servers.keys(), ...this.instanceStatuses.keys()]);
    for (const instanceId of knownIds) {
      if (desiredIds.has(instanceId)) {
        continue;
      }
      await this.stopServer(instanceId);
      this.servers.delete(instanceId);
      this.instanceStatuses.delete(instanceId);
    }

    return this.listServerInstances();
  }

  private cleanupStreamSubscriptionsForInstance(instanceId: string): void {
    const normalized = resolveInstanceId(instanceId);
    for (const [subscriptionId, item] of this.streamSubscriptions.entries()) {
      if (item.instanceId !== normalized) {
        continue;
      }
      try {
        item.dispose();
      } catch {
        // ignore cleanup errors
      }
      this.streamSubscriptions.delete(subscriptionId);
    }
  }

  private parseAgentRpcPayload(payload: unknown): {
    instanceId: string;
    request: AgentRpcRequestPayload;
  } {
    const raw = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const explicitInstanceId = resolveInstanceId(raw.instanceId);

    if (!isAgentRpcRequestPayload(raw)) {
      throw new Error('agent_rpc payload must include operation');
    }

    const request: AgentRpcRequestPayload = {
      instanceId: explicitInstanceId,
      operation: raw.operation,
      params:
        raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)
          ? (raw.params as Record<string, unknown>)
          : undefined,
      query:
        raw.query && typeof raw.query === 'object' && !Array.isArray(raw.query)
          ? (raw.query as Record<string, unknown>)
          : undefined,
      body: raw.body,
      headers: readStringRecord(raw.headers),
    };

    return {
      instanceId: explicitInstanceId,
      request,
    };
  }

  private async handleAgentRpc(message: any): Promise<void> {
    const requestId = typeof message?.requestId === 'string' ? message.requestId : '';
    if (!requestId) {
      this.sendError('agent_rpc requires requestId');
      return;
    }
    if (!isBoundedNonEmptyString(requestId, NATIVE_CONTROL_IDENTIFIER_MAX_BYTES)) {
      this.sendError(`agent_rpc requestId exceeds ${NATIVE_CONTROL_IDENTIFIER_MAX_BYTES} bytes`);
      return;
    }

    const { instanceId, request } = this.parseAgentRpcPayload(message.payload);
    const server = this.getOrCreateServer(instanceId);
    if (!server.isRunning) {
      await this.startServer(instanceId);
    }

    const response = await server.invokeAgentRpc(request);
    this.sendRequestResponse(requestId, {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
      json: response.json,
      isBinary: response.isBinary,
      base64Body: response.base64Body,
    });
  }

  private async handleAgentStreamSubscribe(message: any): Promise<void> {
    const requestId = typeof message?.requestId === 'string' ? message.requestId : '';
    if (!requestId) {
      this.sendError('agent_stream_subscribe requires requestId');
      return;
    }
    if (!isBoundedAgentStreamIdentifier(requestId)) {
      this.sendError(
        `agent_stream_subscribe requestId exceeds ${MAX_AGENT_STREAM_IDENTIFIER_BYTES} bytes`,
      );
      return;
    }

    const payload =
      message?.payload && typeof message.payload === 'object'
        ? (message.payload as Record<string, unknown>)
        : {};
    const instanceId = resolveInstanceId(payload.instanceId);
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!sessionId) {
      this.sendRequestResponse(requestId, undefined, 'sessionId is required');
      return;
    }
    if (!isBoundedAgentStreamIdentifier(sessionId)) {
      this.sendRequestResponse(
        requestId,
        undefined,
        `sessionId exceeds ${MAX_AGENT_STREAM_IDENTIFIER_BYTES} bytes`,
      );
      return;
    }

    const requestedSubscriptionId =
      typeof payload.subscriptionId === 'string' ? payload.subscriptionId.trim() : '';
    const subscriptionId = requestedSubscriptionId || requestId;
    if (!isBoundedAgentStreamIdentifier(subscriptionId)) {
      this.sendRequestResponse(
        requestId,
        undefined,
        `subscriptionId exceeds ${MAX_AGENT_STREAM_IDENTIFIER_BYTES} bytes`,
      );
      return;
    }

    const server = this.getOrCreateServer(instanceId);
    if (!server.isRunning) {
      await this.startServer(instanceId);
    }

    // Re-read capacity after asynchronous startup. Replacing an existing id is
    // allowed at the limit because it does not grow the registry.
    const existing = this.streamSubscriptions.get(subscriptionId);
    if (!existing && this.streamSubscriptions.size >= MAX_AGENT_STREAM_SUBSCRIPTIONS) {
      this.sendRequestResponse(
        requestId,
        undefined,
        `Agent stream subscription limit reached (${MAX_AGENT_STREAM_SUBSCRIPTIONS})`,
      );
      return;
    }
    let sessionSubscriptions = 0;
    for (const subscription of this.streamSubscriptions.values()) {
      if (
        subscription !== existing &&
        subscription.instanceId === instanceId &&
        subscription.sessionId === sessionId
      ) {
        sessionSubscriptions += 1;
      }
    }
    if (sessionSubscriptions >= MAX_AGENT_STREAM_SUBSCRIPTIONS_PER_SESSION) {
      this.sendRequestResponse(
        requestId,
        undefined,
        `Agent stream session subscription limit reached (${MAX_AGENT_STREAM_SUBSCRIPTIONS_PER_SESSION})`,
      );
      return;
    }

    if (existing) {
      try {
        existing.dispose();
      } catch {
        // ignore
      }
      this.streamSubscriptions.delete(subscriptionId);
    }

    const dispose = server.subscribeAgentEvents(sessionId, (event: RealtimeEvent) => {
      this.sendMessage(
        {
          type: NativeMessageType.AGENT_STREAM_EVENT,
          payload: {
            subscriptionId,
            instanceId,
            sessionId,
            event,
          },
        },
        getAgentStreamSendOptions(subscriptionId, event),
      );
    });

    this.streamSubscriptions.set(subscriptionId, {
      subscriptionId,
      instanceId,
      sessionId,
      dispose,
    });

    const connectedEvent: RealtimeEvent = {
      type: 'connected',
      data: {
        sessionId,
        transport: 'native-messaging',
        timestamp: new Date().toISOString(),
      },
    };
    this.sendMessage(
      {
        type: NativeMessageType.AGENT_STREAM_EVENT,
        payload: {
          subscriptionId,
          instanceId,
          sessionId,
          event: connectedEvent,
        },
      },
      getAgentStreamSendOptions(subscriptionId, connectedEvent),
    );

    this.sendRequestResponse(requestId, {
      success: true,
      subscriptionId,
      instanceId,
      sessionId,
    });
  }

  private handleAgentStreamUnsubscribe(message: any): void {
    const requestId = typeof message?.requestId === 'string' ? message.requestId : '';
    if (!requestId) {
      this.sendError('agent_stream_unsubscribe requires requestId');
      return;
    }
    if (!isBoundedNonEmptyString(requestId, NATIVE_CONTROL_IDENTIFIER_MAX_BYTES)) {
      this.sendError(
        `agent_stream_unsubscribe requestId exceeds ${NATIVE_CONTROL_IDENTIFIER_MAX_BYTES} bytes`,
      );
      return;
    }

    const payload =
      message?.payload && typeof message.payload === 'object'
        ? (message.payload as Record<string, unknown>)
        : {};
    const rawSubscriptionId = payload.subscriptionId;
    if (
      rawSubscriptionId !== undefined &&
      !isBoundedNonEmptyString(rawSubscriptionId, NATIVE_CONTROL_IDENTIFIER_MAX_BYTES)
    ) {
      this.sendRequestResponse(
        requestId,
        undefined,
        `subscriptionId exceeds ${NATIVE_CONTROL_IDENTIFIER_MAX_BYTES} bytes`,
      );
      return;
    }
    const subscriptionId =
      typeof rawSubscriptionId === 'string' ? rawSubscriptionId.trim() : '';
    if (!subscriptionId) {
      this.sendRequestResponse(requestId, undefined, 'subscriptionId is required');
      return;
    }

    const existing = this.streamSubscriptions.get(subscriptionId);
    if (existing) {
      try {
        existing.dispose();
      } catch {
        // ignore
      }
      this.streamSubscriptions.delete(subscriptionId);
    }

    this.sendRequestResponse(requestId, {
      success: true,
      subscriptionId,
    });
  }

  private async handleMessage(message: any): Promise<void> {
    if (!message || typeof message !== 'object') {
      this.sendError('Invalid message format');
      return;
    }

    if (message.responseToRequestId !== undefined) {
      if (
        !isBoundedNonEmptyString(
          message.responseToRequestId,
          NATIVE_CONTROL_IDENTIFIER_MAX_BYTES,
        )
      ) {
        this.sendError(
          `responseToRequestId must be a non-empty string up to ${NATIVE_CONTROL_IDENTIFIER_MAX_BYTES} bytes`,
        );
        return;
      }
      const requestId = message.responseToRequestId;
      const pending = this.pendingRequests.get(requestId);

      if (pending) {
        clearTimeout(pending.timeoutId);
        if (message.error) {
          pending.reject(new Error(truncateControlText(String(message.error))));
        } else {
          pending.resolve(message.payload);
        }
        this.pendingRequests.delete(requestId);
      }
      return;
    }

    if (
      message.requestId !== undefined &&
      !isBoundedNonEmptyString(message.requestId, NATIVE_CONTROL_IDENTIFIER_MAX_BYTES)
    ) {
      this.sendError(
        `requestId must be a non-empty string up to ${NATIVE_CONTROL_IDENTIFIER_MAX_BYTES} bytes`,
      );
      return;
    }
    const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
    if (!isBoundedNonEmptyString(message.type, NATIVE_MESSAGE_TYPE_MAX_BYTES)) {
      if (requestId) {
        this.sendRequestResponse(
          requestId,
          undefined,
          `message type must be a non-empty string up to ${NATIVE_MESSAGE_TYPE_MAX_BYTES} bytes`,
        );
      } else {
        this.sendError(
          `message type must be a non-empty string up to ${NATIVE_MESSAGE_TYPE_MAX_BYTES} bytes`,
        );
      }
      return;
    }

    // Handle directive messages from Chrome
    try {
      switch (message.type) {
        case NativeMessageType.START: {
          const directive = this.resolveStartDirective(message.payload);
          const status = await this.startServer(directive.instanceId);
          if (requestId) {
            this.sendRequestResponse(requestId, { status: 'success', instance: status });
          }
          break;
        }
        case NativeMessageType.STOP: {
          const directive = this.resolveStopDirective(message.payload);
          const status = await this.stopServer(directive.instanceId);
          if (requestId) {
            this.sendRequestResponse(requestId, { status: 'success', instance: status });
          }
          break;
        }
        case NativeMessageType.LIST_INSTANCES: {
          if (!requestId) {
            this.sendError('list_instances requires requestId');
            return;
          }
          this.sendRequestResponse(requestId, {
            status: 'success',
            instances: this.listServerInstances(),
          });
          break;
        }
        case NativeMessageType.SYNC_INSTANCES: {
          if (!requestId) {
            this.sendError('sync_instances requires requestId');
            return;
          }
          const instances = this.resolveSyncDirective(message.payload);
          const statuses = await this.syncServers(instances);
          this.sendRequestResponse(requestId, {
            status: 'success',
            instances: statuses,
          });
          break;
        }
        case 'auth_get_token':
          this.handleAuthGetToken(message);
          break;
        // Keep ping/pong for simple liveness detection, but this differs from request-response pattern
        case 'ping_from_extension':
          this.sendMessage({ type: 'pong_to_extension' });
          break;
        case 'file_operation':
          await this.handleFileOperation(message);
          break;
        case NativeMessageType.AGENT_RPC:
          await this.handleAgentRpc(message);
          break;
        case NativeMessageType.AGENT_STREAM_SUBSCRIBE:
          await this.handleAgentStreamSubscribe(message);
          break;
        case NativeMessageType.AGENT_STREAM_UNSUBSCRIBE:
          this.handleAgentStreamUnsubscribe(message);
          break;
        default:
          if (requestId) {
            this.sendRequestResponse(requestId, undefined, `Unknown message type: ${message.type || 'no type'}`);
          } else {
            this.sendError(`Unknown message type or non-response message: ${message.type || 'no type'}`);
          }
      }
    } catch (error: any) {
      const errorMessage = `Failed to handle directive message: ${error.message}`;
      if (requestId) {
        this.sendRequestResponse(requestId, undefined, errorMessage);
      } else {
        this.sendError(errorMessage);
      }
    }
  }

  private getConfiguredAuthToken(): string | undefined {
    const token = process.env[NativeMessagingHost.AUTH_TOKEN_ENV];
    if (typeof token !== 'string') {
      return undefined;
    }
    const trimmed = token.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private handleAuthGetToken(message: any): void {
    const requestId = message?.requestId;
    if (!requestId) {
      this.sendError('auth_get_token requires requestId');
      return;
    }
    const token = this.getConfiguredAuthToken();
    this.sendMessage({
      type: 'auth_token_response',
      responseToRequestId: requestId,
      payload: {
        enabled: Boolean(token),
        token: token || null,
      },
    });
  }

  /**
   * Handle file operations from the extension
   */
  private async handleFileOperation(message: any): Promise<void> {
    try {
      const result = await fileHandler.handleFileRequest(message.payload);

      if (message.requestId) {
        // Send response back with the request ID
        this.sendMessage({
          type: 'file_operation_response',
          responseToRequestId: message.requestId,
          payload: result,
        });
      } else {
        // No request ID, just send result
        this.sendMessage({
          type: 'file_operation_result',
          payload: result,
        });
      }
    } catch (error: any) {
      const errorResponse = {
        success: false,
        error: error.message || 'Unknown error during file operation',
      };

      if (message.requestId) {
        this.sendMessage({
          type: 'file_operation_response',
          responseToRequestId: message.requestId,
          error: errorResponse.error,
        });
      } else {
        this.sendError(`File operation failed: ${errorResponse.error}`);
      }
    }
  }

  /**
   * Send request to Chrome and wait for response
   * @param messagePayload Data to send to Chrome
   * @param timeoutMs Timeout for waiting response (milliseconds)
   * @returns Promise, resolves to Chrome's returned payload on success, rejects on failure
   */
  public sendRequestToExtensionAndWait(
    messagePayload: any,
    messageType: string = 'request_data',
    timeoutMs: number = TIMEOUTS.DEFAULT_REQUEST_TIMEOUT,
    signal?: AbortSignal,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = uuidv4(); // Generate unique request ID
      let settled = false;

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', handleAbort);
        this.pendingRequests.delete(requestId);
        callback();
      };

      const handleAbort = (): void => {
        const error = new Error('Native bridge request cancelled');
        error.name = 'AbortError';
        finish(() => reject(error));
      };

      const timeoutId = setTimeout(() => {
        finish(() => reject(new Error(`Request timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      // Store request's resolve/reject functions and timeout ID
      this.pendingRequests.set(requestId, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (reason) => finish(() => reject(reason)),
        timeoutId,
      });

      if (signal?.aborted) {
        handleAbort();
        return;
      }
      signal?.addEventListener('abort', handleAbort, { once: true });

      // Send message with requestId to Chrome. Encoding and stdout failures
      // reject immediately rather than leaving the request waiting for timeout.
      void this.messageWriter
        .send({
          type: messageType,
          payload: messagePayload,
          requestId,
        })
        .catch((error) => {
          const pending = this.pendingRequests.get(requestId);
          if (!pending) {
            return;
          }
          clearTimeout(pending.timeoutId);
          this.pendingRequests.delete(requestId);
          pending.reject(error);
        });
    });
  }

  /**
   * Send message to Chrome extension
   */
  public sendMessage(message: any, options: NativeMessageSendOptions = {}): void {
    void this.messageWriter.send(message, options).catch((error) => {
      const responseToRequestId =
        message && typeof message === 'object' && typeof message.responseToRequestId === 'string'
          ? message.responseToRequestId
          : '';

      // Oversized or unserializable responses have not touched stdout, so a
      // compact protocol error can still complete the extension's request.
      if (responseToRequestId && isNativeMessageEncodingError(error)) {
        void this.messageWriter
          .send({
            responseToRequestId,
            error: `Native host could not encode response: ${error instanceof Error ? error.message : String(error)}`,
          })
          .catch((fallbackError) => this.reportMessageWriteFailure(fallbackError));
        return;
      }

      this.reportMessageWriteFailure(error);
    });
  }

  /**
   * Send error message to Chrome extension (mainly for sending non-request-response type errors)
   */
  private sendError(errorMessage: string): void {
    this.sendMessage({
      type: NativeMessageType.ERROR_FROM_NATIVE_HOST, // Use more explicit type
      payload: { message: truncateControlText(errorMessage) },
    });
  }

  private requestProcessShutdown(exitCode: number): void {
    if (this.processShutdownRequested) return;
    this.processShutdownRequested = true;
    void this.shutdown().then(
      () => process.exit(exitCode),
      (error) => {
        console.error(
          `[mcp-server] shutdown failed: ${error instanceof Error ? error.stack || error.message : String(error)}`,
        );
        process.exit(1);
      },
    );
  }

  private async performShutdown(): Promise<void> {
    this.messageHandlingCleanup?.();

    // Reject all pending requests
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Native host is shutting down or Chrome disconnected.'));
    });
    this.pendingRequests.clear();

    const cleanupErrors: unknown[] = [];
    try {
      fileHandler.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }

    for (const [subscriptionId, subscription] of this.streamSubscriptions.entries()) {
      try {
        subscription.dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
      this.streamSubscriptions.delete(subscriptionId);
    }

    for (const socket of Array.from(this.ipcSockets)) {
      try {
        socket.destroy();
      } catch (error) {
        cleanupErrors.push(error);
      }
      this.ipcSockets.delete(socket);
    }

    const ipcServer = this.ipcServer;
    this.ipcServer = null;
    const closeIpcServer = new Promise<void>((resolve, reject) => {
      if (!ipcServer) {
        resolve();
        return;
      }
      try {
        ipcServer.close((error) => {
          const code =
            error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
          if (!error || code === 'ERR_SERVER_NOT_RUNNING') resolve();
          else reject(error);
        });
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (code === 'ERR_SERVER_NOT_RUNNING') resolve();
        else reject(error);
      }
    });

    if (this.ipcCredential) {
      removeNativeIpcCredential(this.ipcCredential);
      this.ipcCredential = null;
    }
    if (process.platform !== 'win32' && this.ipcSocketPath && this.ipcSocketIdentity) {
      try {
        removeOwnedUnixSocket(this.ipcSocketPath, this.ipcSocketIdentity);
      } catch {
        // Never remove a replacement path during shutdown.
      }
    }
    this.ipcSocketPath = null;
    this.ipcSocketIdentity = null;

    const results = await Promise.allSettled([closeIpcServer, this.stopServers()]);
    for (const result of results) {
      if (result.status === 'rejected') cleanupErrors.push(result.reason);
    }

    if (cleanupErrors.length > 0) {
      const details = cleanupErrors
        .map((error) => (error instanceof Error ? error.message : String(error)))
        .join('; ');
      throw new Error(`Native host shutdown encountered cleanup failures: ${details}`);
    }
  }
}

const nativeMessagingHostInstance = new NativeMessagingHost();
export default nativeMessagingHostInstance;
