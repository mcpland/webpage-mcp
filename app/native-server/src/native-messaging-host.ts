import { stdin, stdout } from 'process';
import { Server } from './server';
import { v4 as uuidv4 } from 'uuid';
import {
  DEFAULT_MCP_INSTANCE_ID,
  NativeMessageType,
  type McpServerInstanceConfig,
  type McpServerInstanceStatus,
  type NativeSyncInstancesPayload,
} from 'webpage-mcp-shared';
import { NATIVE_SERVER_PORT, TIMEOUTS } from './constant';
import fileHandler from './file-handler';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timeoutId: NodeJS.Timeout;
}

const INSTANCE_ID_REGEX = /^[A-Za-z0-9._-]{1,64}$/;

function normalizeInstanceId(raw: unknown): string {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed && INSTANCE_ID_REGEX.test(trimmed)) {
      return trimmed;
    }
  }
  return DEFAULT_MCP_INSTANCE_ID;
}

function normalizePort(raw: unknown): number | undefined {
  const parsed =
    typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const port = Math.floor(parsed);
  if (port <= 0 || port > 65535) {
    return undefined;
  }
  return port;
}

function normalizeInstanceConfig(
  raw: unknown,
  fallbackPort: number,
): McpServerInstanceConfig | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const instanceId = normalizeInstanceId(obj.instanceId);
  const port = normalizePort(obj.port) ?? (instanceId === DEFAULT_MCP_INSTANCE_ID ? fallbackPort : undefined);
  if (!port) {
    return null;
  }

  return {
    instanceId,
    port,
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

export class NativeMessagingHost {
  private servers: Map<string, Server> = new Map();
  private instanceStatuses: Map<string, McpServerInstanceStatus> = new Map();
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private static readonly AUTH_TOKEN_ENV = 'WEBPAGE_MCP_AUTH_TOKEN';

  public setServer(serverInstance: Server): void {
    const instanceId = normalizeInstanceId(serverInstance.instanceId);
    this.servers.set(instanceId, serverInstance);
    serverInstance.setNativeHost(this);
    this.instanceStatuses.set(instanceId, {
      instanceId,
      isRunning: serverInstance.isRunning,
      port: serverInstance.getListeningPort() ?? undefined,
      lastUpdated: Date.now(),
    });
  }

  // add message handler to wait for start server
  public start(): void {
    try {
      this.setupMessageHandling();
    } catch (_error: any) {
      process.exit(1);
    }
  }

  private setupMessageHandling(): void {
    let buffer = Buffer.alloc(0);
    let expectedLength = -1;
    const MAX_MESSAGES_PER_TICK = 100; // Safety guard to avoid long-running loops per readable tick
    const MAX_MESSAGE_SIZE_BYTES = 16 * 1024 * 1024; // 16MB upper bound for a single message

    const processAvailable = () => {
      let processed = 0;
      while (processed < MAX_MESSAGES_PER_TICK) {
        // Read length header when needed
        if (expectedLength === -1) {
          if (buffer.length < 4) break; // not enough for header
          expectedLength = buffer.readUInt32LE(0);
          buffer = buffer.slice(4);

          // Validate length header
          if (expectedLength <= 0 || expectedLength > MAX_MESSAGE_SIZE_BYTES) {
            this.sendError(`Invalid message length: ${expectedLength}`);
            // Reset state to resynchronize stream
            expectedLength = -1;
            buffer = Buffer.alloc(0);
            break;
          }
        }

        // Wait for complete body
        if (buffer.length < expectedLength) break;

        const messageBuffer = buffer.slice(0, expectedLength);
        buffer = buffer.slice(expectedLength);
        expectedLength = -1;
        processed++;

        try {
          const message = JSON.parse(messageBuffer.toString());
          void this.handleMessage(message);
        } catch (error: any) {
          this.sendError(`Failed to parse message: ${error.message}`);
        }
      }

      // If we hit the cap but still have at least one complete message pending, schedule to continue soon
      if (processed === MAX_MESSAGES_PER_TICK) {
        setImmediate(processAvailable);
      }
    };

    stdin.on('readable', () => {
      let chunk;
      while ((chunk = stdin.read()) !== null) {
        buffer = Buffer.concat([buffer, chunk]);
        processAvailable();
      }
    });

    stdin.on('end', () => {
      this.cleanup();
    });

    stdin.on('error', () => {
      this.cleanup();
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
    const previous = this.instanceStatuses.get(normalized);

    const status: McpServerInstanceStatus = {
      instanceId: normalized,
      isRunning: server?.isRunning ?? previous?.isRunning ?? false,
      port: server?.getListeningPort() ?? previous?.port,
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

  private findRunningInstanceByPort(
    requestedPort: number,
    excludedInstanceId?: string,
  ): { instanceId: string; port: number } | null {
    for (const [instanceId, server] of this.servers.entries()) {
      if (instanceId === excludedInstanceId) continue;
      if (!server.isRunning) continue;
      const listeningPort = server.getListeningPort();
      if (typeof listeningPort === 'number' && listeningPort === requestedPort) {
        return { instanceId, port: listeningPort };
      }
    }
    return null;
  }

  private async startServer(instanceId: string, port: number): Promise<McpServerInstanceStatus> {
    const normalized = normalizeInstanceId(instanceId);
    const requestedPort = normalizePort(port) ?? NATIVE_SERVER_PORT;
    const server = this.getOrCreateServer(normalized);

    if (server.isRunning) {
      const listeningPort = server.getListeningPort();
      if (typeof listeningPort === 'number' && listeningPort === requestedPort) {
        const runningStatus = this.snapshotInstanceStatus(normalized);
        this.sendMessage({
          type: NativeMessageType.SERVER_STARTED,
          payload: { instanceId: normalized, port: runningStatus.port },
        });
        return runningStatus;
      }

      await server.stop();
    }

    const conflict = this.findRunningInstanceByPort(requestedPort, normalized);
    if (conflict) {
      throw new Error(
        `Port ${requestedPort} is already in use by instance "${conflict.instanceId}". Each instance must use a unique port.`,
      );
    }

    const actualPort = await server.start(requestedPort, this);
    const status: McpServerInstanceStatus = {
      instanceId: normalized,
      isRunning: true,
      port: actualPort,
      lastUpdated: Date.now(),
    };
    this.instanceStatuses.set(normalized, status);

    this.sendMessage({
      type: NativeMessageType.SERVER_STARTED,
      payload: { instanceId: normalized, port: actualPort },
    });

    return status;
  }

  private async stopServer(instanceId: string): Promise<McpServerInstanceStatus> {
    const normalized = normalizeInstanceId(instanceId);
    const server = this.servers.get(normalized);
    const previous = this.instanceStatuses.get(normalized);
    const port = server?.getListeningPort() ?? previous?.port;

    if (server?.isRunning) {
      await server.stop();
    }

    const status: McpServerInstanceStatus = {
      instanceId: normalized,
      isRunning: false,
      port,
      lastUpdated: Date.now(),
    };
    this.instanceStatuses.set(normalized, status);

    this.sendMessage({
      type: NativeMessageType.SERVER_STOPPED,
      payload: { instanceId: normalized, port },
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
    port: number;
  } {
    if (typeof payload === 'number' || typeof payload === 'string') {
      return {
        instanceId: DEFAULT_MCP_INSTANCE_ID,
        port: normalizePort(payload) ?? NATIVE_SERVER_PORT,
      };
    }

    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      return {
        instanceId: normalizeInstanceId(obj.instanceId),
        port: normalizePort(obj.port) ?? NATIVE_SERVER_PORT,
      };
    }

    return {
      instanceId: DEFAULT_MCP_INSTANCE_ID,
      port: NATIVE_SERVER_PORT,
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
    const defaultPort =
      this.instanceStatuses.get(DEFAULT_MCP_INSTANCE_ID)?.port ??
      this.servers.get(DEFAULT_MCP_INSTANCE_ID)?.getListeningPort() ??
      NATIVE_SERVER_PORT;
    const byId = new Map<string, McpServerInstanceConfig>();

    for (const raw of rawInstances) {
      const normalized = normalizeInstanceConfig(raw, defaultPort);
      if (!normalized) continue;
      byId.set(normalized.instanceId, normalized);
    }

    if (!byId.has(DEFAULT_MCP_INSTANCE_ID)) {
      byId.set(DEFAULT_MCP_INSTANCE_ID, {
        instanceId: DEFAULT_MCP_INSTANCE_ID,
        port: defaultPort,
        enabled: true,
        autoStart: true,
        label: 'Default',
      });
    }

    return sortInstanceConfigs(Array.from(byId.values()));
  }

  private ensureUniqueAutoStartPorts(instances: McpServerInstanceConfig[]): void {
    const byPort = new Map<number, string>();
    for (const instance of instances) {
      if (!instance.enabled || !instance.autoStart) {
        continue;
      }
      const existing = byPort.get(instance.port);
      if (existing && existing !== instance.instanceId) {
        throw new Error(
          `Port ${instance.port} is assigned to both "${existing}" and "${instance.instanceId}". Configure unique ports for enabled auto-start instances.`,
        );
      }
      byPort.set(instance.port, instance.instanceId);
    }
  }

  private async syncServers(instances: McpServerInstanceConfig[]): Promise<McpServerInstanceStatus[]> {
    this.ensureUniqueAutoStartPorts(instances);

    const desiredIds = new Set<string>(instances.map((item) => item.instanceId));

    for (const instance of instances) {
      if (instance.enabled && instance.autoStart) {
        await this.startServer(instance.instanceId, instance.port);
      } else {
        await this.stopServer(instance.instanceId);
      }
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
          const status = await this.startServer(directive.instanceId, directive.port);
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

    const runningServers = Array.from(this.servers.values()).filter((server) => server.isRunning);
    if (runningServers.length === 0) {
      process.exit(0);
      return;
    }

    Promise.allSettled(
      runningServers.map(async (server) => {
        try {
          await server.stop();
        } catch {
          // Ignore cleanup failures; we still want process exit.
        }
      }),
    )
      .then((results) => {
        const hasRejected = results.some((result) => result.status === 'rejected');
        process.exit(hasRejected ? 1 : 0);
      })
      .catch(() => {
        process.exit(1);
      });
  }
}

const nativeMessagingHostInstance = new NativeMessagingHost();
export default nativeMessagingHostInstance;
