import { stdin, stdout } from 'process';
import fs from 'node:fs';
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
  callToolForContext,
  listToolsForContext,
  type McpClientCapabilityFallback,
} from './mcp/register-tools';
import { NativeMessageFrameDecoder } from './native-message-framing';

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

const INSTANCE_ID_REGEX = /^[A-Za-z0-9._-]{1,64}$/;

function removeSocketIfExists(socketPath: string): void {
  if (process.platform === 'win32') {
    return;
  }
  if (!socketPath || !fs.existsSync(socketPath)) {
    return;
  }
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // Ignore stale socket cleanup failures; listen will report a concrete error if needed.
  }
}

function normalizeInstanceId(raw: unknown): string {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed && INSTANCE_ID_REGEX.test(trimmed)) {
      return trimmed;
    }
  }
  return DEFAULT_MCP_INSTANCE_ID;
}

function normalizeInstanceConfig(raw: unknown): McpServerInstanceConfig | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const instanceId = normalizeInstanceId(obj.instanceId);

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

export class NativeMessagingHost {
  private servers: Map<string, Server> = new Map();
  private instanceStatuses: Map<string, McpServerInstanceStatus> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private streamSubscriptions: Map<string, AgentStreamSubscription> = new Map();
  private ipcServer: net.Server | null = null;
  private ipcSockets: Set<net.Socket> = new Set();
  private static readonly AUTH_TOKEN_ENV = 'WEBPAGE_MCP_AUTH_TOKEN';

  public setServer(serverInstance: Server): void {
    const instanceId = normalizeInstanceId(serverInstance.instanceId);
    this.servers.set(instanceId, serverInstance);
    serverInstance.setNativeHost(this);
    this.instanceStatuses.set(instanceId, {
      instanceId,
      isRunning: serverInstance.isRunning,
      lastUpdated: Date.now(),
    });
  }

  // add message handler to wait for start server
  public start(): void {
    try {
      this.setupIpcServer();
      this.setupMessageHandling();
    } catch (_error: any) {
      process.exit(1);
    }
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

  private setupIpcServer(): void {
    const socketPath = getNativeSocketPath();

    if (process.platform !== 'win32') {
      ensureNativeSocketParentDir(socketPath);
      removeSocketIfExists(socketPath);

      // Best-effort cleanup for legacy tmp socket path from older builds.
      const legacySocketPath = getLegacyNativeSocketPath();
      if (legacySocketPath !== socketPath) {
        removeSocketIfExists(legacySocketPath);
      }
    }

    this.ipcServer = net.createServer((socket) => {
      this.handleIpcSocket(socket);
    });

    this.ipcServer.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.sendError(`IPC server error: ${message}`);
    });

    this.ipcServer.listen(socketPath);
  }

  private handleIpcSocket(socket: net.Socket): void {
    this.ipcSockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';

    const send = (payload: unknown): void => {
      try {
        socket.write(`${JSON.stringify(payload)}\n`);
      } catch {
        // Ignore broken socket writes.
      }
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) break;

        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;

        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          send({
            id: null,
            error: error instanceof Error ? error.message : 'Invalid JSON payload',
          });
          continue;
        }

        void this.handleIpcRequest(parsed)
          .then((result) => {
            send({ id: parsed?.id ?? null, result });
          })
          .catch((error) => {
            send({
              id: parsed?.id ?? null,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
    });

    socket.on('close', () => {
      this.ipcSockets.delete(socket);
    });
    socket.on('error', () => {
      this.ipcSockets.delete(socket);
    });
  }

  private async handleIpcRequest(request: any): Promise<unknown> {
    const method = typeof request?.method === 'string' ? request.method : '';
    const params = request?.params && typeof request.params === 'object' ? request.params : {};
    const instanceId = normalizeInstanceId((params as Record<string, unknown>).instanceId);
    const sessionIdRaw = (params as Record<string, unknown>).sessionId;
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
          clientCapabilities: (params as Record<string, unknown>)
            .clientCapabilities as McpClientCapabilityFallback | undefined,
        });
        return { tools };
      }
      case 'mcp_call_tool': {
        const paramsRecord = params as Record<string, unknown>;
        const name = typeof paramsRecord.name === 'string' ? paramsRecord.name : '';
        if (!name) {
          throw new Error('name is required');
        }
        const args = paramsRecord.args ?? {};
        const result = await callToolForContext(
          {
            sessionId,
            instanceId,
            nativeHost: this,
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
    let framingFailed = false;

    const onReadable = () => {
      let chunk;
      while ((chunk = stdin.read()) !== null) {
        try {
          decoder.write(chunk, (messageBuffer) => {
            try {
              const message = JSON.parse(messageBuffer.toString());
              void this.handleMessage(message);
            } catch (error: any) {
              this.sendError(`Failed to parse message: ${error.message}`);
            }
          });
        } catch (error) {
          framingFailed = true;
          stdin.removeListener('readable', onReadable);
          this.sendError(error instanceof Error ? error.message : String(error));
          this.cleanup();
          break;
        }
      }
    };

    stdin.on('readable', onReadable);

    stdin.on('end', () => {
      if (!framingFailed) {
        this.cleanup();
      }
    });

    stdin.on('error', () => {
      if (!framingFailed) {
        this.cleanup();
      }
    });
  }

  private getOrCreateServer(instanceId: string): Server {
    const normalized = normalizeInstanceId(instanceId);
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
    const normalized = normalizeInstanceId(instanceId);
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
    const normalized = normalizeInstanceId(instanceId);
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
    const normalized = normalizeInstanceId(instanceId);
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
      response.error = error;
    } else {
      response.payload = payload;
    }
    this.sendMessage(response);
  }

  private resolveStartDirective(
    payload: unknown,
  ): {
    instanceId: string;
  } {
    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      return {
        instanceId: normalizeInstanceId(obj.instanceId),
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
        instanceId: normalizeInstanceId(obj.instanceId),
      };
    }
    return {
      instanceId: DEFAULT_MCP_INSTANCE_ID,
    };
  }

  private resolveSyncDirective(payload: unknown): McpServerInstanceConfig[] {
    const rawPayload = payload && typeof payload === 'object' ? (payload as NativeSyncInstancesPayload) : null;
    const rawInstances = Array.isArray(rawPayload?.instances) ? rawPayload.instances : [];
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
    const normalized = normalizeInstanceId(instanceId);
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
    const explicitInstanceId = normalizeInstanceId(raw.instanceId);

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

    const payload =
      message?.payload && typeof message.payload === 'object'
        ? (message.payload as Record<string, unknown>)
        : {};
    const instanceId = normalizeInstanceId(payload.instanceId);
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!sessionId) {
      this.sendRequestResponse(requestId, undefined, 'sessionId is required');
      return;
    }

    const requestedSubscriptionId =
      typeof payload.subscriptionId === 'string' ? payload.subscriptionId.trim() : '';
    const subscriptionId = requestedSubscriptionId || requestId;

    const existing = this.streamSubscriptions.get(subscriptionId);
    if (existing) {
      try {
        existing.dispose();
      } catch {
        // ignore
      }
      this.streamSubscriptions.delete(subscriptionId);
    }

    const server = this.getOrCreateServer(instanceId);
    if (!server.isRunning) {
      await this.startServer(instanceId);
    }

    const dispose = server.subscribeAgentEvents(sessionId, (event: RealtimeEvent) => {
      this.sendMessage({
        type: NativeMessageType.AGENT_STREAM_EVENT,
        payload: {
          subscriptionId,
          instanceId,
          sessionId,
          event,
        },
      });
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
        transport: 'sse',
        timestamp: new Date().toISOString(),
      },
    };
    this.sendMessage({
      type: NativeMessageType.AGENT_STREAM_EVENT,
      payload: {
        subscriptionId,
        instanceId,
        sessionId,
        event: connectedEvent,
      },
    });

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

    const payload =
      message?.payload && typeof message.payload === 'object'
        ? (message.payload as Record<string, unknown>)
        : {};
    const subscriptionId = typeof payload.subscriptionId === 'string' ? payload.subscriptionId.trim() : '';
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

    if (message.responseToRequestId) {
      const requestId = String(message.responseToRequestId);
      const pending = this.pendingRequests.get(requestId);

      if (pending) {
        clearTimeout(pending.timeoutId);
        if (message.error) {
          pending.reject(new Error(String(message.error)));
        } else {
          pending.resolve(message.payload);
        }
        this.pendingRequests.delete(requestId);
      }
      return;
    }

    const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;

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
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const requestId = uuidv4(); // Generate unique request ID

      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId); // Remove from Map after timeout
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Store request's resolve/reject functions and timeout ID
      this.pendingRequests.set(requestId, { resolve, reject, timeoutId });

      // Send message with requestId to Chrome
      this.sendMessage({
        type: messageType, // Define a request type, e.g. 'request_data'
        payload: messagePayload,
        requestId: requestId, // <--- Key: include request ID
      });
    });
  }

  /**
   * Send message to Chrome extension
   */
  public sendMessage(message: any): void {
    try {
      const messageString = JSON.stringify(message);
      const messageBuffer = Buffer.from(messageString);
      const headerBuffer = Buffer.alloc(4);
      headerBuffer.writeUInt32LE(messageBuffer.length, 0);
      // Ensure atomic write
      stdout.write(Buffer.concat([headerBuffer, messageBuffer]), (err) => {
        if (err) {
          // Consider how to handle write failure, may affect request completion
        } else {
          // Message sent successfully, no action needed
        }
      });
    } catch (_error: any) {
      // Catch JSON.stringify or Buffer operation errors
      // If preparation stage fails, associated request may never be sent
      // Need to consider whether to reject corresponding Promise (if called within sendRequestToExtensionAndWait)
    }
  }

  /**
   * Send error message to Chrome extension (mainly for sending non-request-response type errors)
   */
  private sendError(errorMessage: string): void {
    this.sendMessage({
      type: NativeMessageType.ERROR_FROM_NATIVE_HOST, // Use more explicit type
      payload: { message: errorMessage },
    });
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    // Reject all pending requests
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Native host is shutting down or Chrome disconnected.'));
    });
    this.pendingRequests.clear();

    for (const [subscriptionId, subscription] of this.streamSubscriptions.entries()) {
      try {
        subscription.dispose();
      } catch {
        // ignore cleanup failures
      }
      this.streamSubscriptions.delete(subscriptionId);
    }

    for (const socket of Array.from(this.ipcSockets)) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      this.ipcSockets.delete(socket);
    }

    if (this.ipcServer) {
      try {
        this.ipcServer.close();
      } catch {
        // ignore
      }
      this.ipcServer = null;
    }
    const socketPath = getNativeSocketPath();
    if (process.platform !== 'win32') {
      removeSocketIfExists(socketPath);
      const legacySocketPath = getLegacyNativeSocketPath();
      if (legacySocketPath !== socketPath) {
        removeSocketIfExists(legacySocketPath);
      }
    }

    this.stopServers()
      .then(() => {
        process.exit(0);
      })
      .catch(() => {
        process.exit(1);
      });
  }
}

const nativeMessagingHostInstance = new NativeMessagingHost();
export default nativeMessagingHostInstance;
