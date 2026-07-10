#!/usr/bin/env node

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS } from 'webpage-mcp-shared';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getLegacyNativeSocketPath, getNativeSocketPath } from '../ipc/socket-path';
import { IPC_AUTH_METHOD, readNativeIpcCredential } from '../ipc/bridge-auth';
import { BoundedNdjsonDecoder } from '../ipc/bounded-ndjson';
import { autoBootstrapNativeMessagingForStdio } from '../scripts/utils';
import { resolveMcpClientCapabilities } from './register-tools';
import { shouldNotifyWorkflowToolListChanged } from './tool-list-change';

function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (!input) {
    return fallback;
  }
  const value = Number.parseInt(input, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const CONNECT_RETRY_INTERVAL_MS = parsePositiveInt(
  process.env.WEBPAGE_MCP_STDIO_CONNECT_RETRY_INTERVAL_MS,
  250,
);
const CONNECT_MAX_WAIT_MS = parsePositiveInt(process.env.WEBPAGE_MCP_STDIO_CONNECT_TIMEOUT_MS, 10000);
const IPC_MAX_REQUEST_LINE_BYTES = 1024 * 1024;
const IPC_MAX_RESPONSE_LINE_BYTES = 16 * 1024 * 1024;
const IPC_MAX_PENDING_REQUESTS = 16;

interface PendingIpcRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as any).code === 'string') {
    return (error as any).code;
  }
  return 'UNKNOWN';
}

function shouldRetryConnect(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EPIPE';
}

function getSocketPathCandidates(): string[] {
  const explicit = process.env.WEBPAGE_MCP_NATIVE_SOCKET?.trim();
  if (explicit) {
    return [explicit];
  }

  const primaryPath = getNativeSocketPath();
  const legacyPath = getLegacyNativeSocketPath();
  if (legacyPath === primaryPath) {
    return [primaryPath];
  }
  return [primaryPath, legacyPath];
}

function formatBridgeConnectError(
  socketPaths: string[],
  error: unknown,
  candidateErrors?: Map<string, unknown>,
): Error {
  const errorCode = getErrorCode(error);
  const errorMessage = error instanceof Error ? error.message : String(error);
  const socketPathLines = socketPaths.map((candidate, index) => `${index + 1}. ${candidate}`);
  const candidateErrorLines =
    candidateErrors && candidateErrors.size > 0
      ? socketPaths.map((candidate) => {
          const candidateError = candidateErrors.get(candidate);
          if (!candidateError) {
            return `- ${candidate}: <no error details>`;
          }
          const code = getErrorCode(candidateError);
          const message =
            candidateError instanceof Error ? candidateError.message : String(candidateError);
          return `- ${candidate}: [${code}] ${message}`;
        })
      : [];
  const lines = [
    `Unable to connect to native bridge socket (${socketPaths.length} candidate${
      socketPaths.length > 1 ? 's' : ''
    })`,
    ...socketPathLines,
    ...(candidateErrorLines.length > 0
      ? ['Candidate errors:', ...candidateErrorLines]
      : []),
    `Reason: [${errorCode}] ${errorMessage}`,
    'The native host is not running or has not opened the IPC socket yet.',
    'Fix steps:',
    '1. Open Chrome and ensure the Webpage MCP extension is enabled.',
    '2. Ensure extension Native auto-connect is enabled (or click Connect in popup).',
    '3. Run `npx -y webpage-mcp@latest doctor` and fix reported issues.',
    '4. If WEBPAGE_MCP_NATIVE_SOCKET is set, ensure both processes use the same value.',
    '5. If clicking Connect does not create new wrapper logs, re-register with current extension ID:',
    '   `npx -y webpage-mcp@latest register --browser chrome --force --extension-id <your_extension_id>`',
  ];
  return new Error(lines.join('\n'));
}

class NativeIpcBridgeClient {
  private socket: net.Socket | null = null;
  private authenticated = false;
  private readonly decoder = new BoundedNdjsonDecoder(IPC_MAX_RESPONSE_LINE_BYTES);
  private writeTail = Promise.resolve();
  private connectPromise: Promise<void> | null = null;
  private connectedSocketPath: string | null = null;
  private readonly pending = new Map<string, PendingIpcRequest>();

  private connectOnce(socketPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(socketPath);

      const cleanup = (): void => {
        socket.removeAllListeners('connect');
        socket.removeAllListeners('error');
      };

      socket.on('connect', () => {
        cleanup();
        this.socket = socket;
        this.authenticated = false;
        this.connectedSocketPath = socketPath;
        this.decoder.reset();

        socket.on('data', (chunk: Buffer) => this.onData(socket, chunk));
        socket.on('close', () => this.onDisconnected(socket, 'IPC socket closed'));
        socket.on('error', (error) => this.onDisconnected(socket, error.message));

        void this.authenticate(socket, socketPath)
          .then(() => {
            if (this.socket !== socket || socket.destroyed) {
              throw new Error('IPC socket closed during authentication');
            }
            this.authenticated = true;
            resolve();
          })
          .catch((error) => {
            if (this.socket === socket) {
              this.socket = null;
              this.authenticated = false;
              this.connectedSocketPath = null;
            }
            socket.destroy();
            reject(error);
          });
      });

      socket.on('error', (error) => {
        cleanup();
        reject(error);
      });
    });
  }

  private async connectWithRetry(socketPaths: string[]): Promise<void> {
    const start = Date.now();
    let lastError: unknown = null;
    const candidateErrors = new Map<string, unknown>();

    while (Date.now() - start <= CONNECT_MAX_WAIT_MS) {
      for (const socketPath of socketPaths) {
        try {
          await this.connectOnce(socketPath);
          return;
        } catch (error) {
          lastError = error;
          candidateErrors.set(socketPath, error);
          if (!shouldRetryConnect(error)) {
            throw formatBridgeConnectError(socketPaths, error, candidateErrors);
          }
        }
      }

      await sleep(CONNECT_RETRY_INTERVAL_MS);
    }

    throw formatBridgeConnectError(socketPaths, lastError, candidateErrors);
  }

  async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.authenticated) {
      return;
    }
    if (this.connectPromise) {
      return await this.connectPromise;
    }

    const socketPaths = getSocketPathCandidates();
    this.connectPromise = this.connectWithRetry(socketPaths).finally(() => {
      this.connectPromise = null;
    });

    return await this.connectPromise;
  }

  private onData(socket: net.Socket, chunk: Buffer): void {
    if (this.socket !== socket) {
      return;
    }
    let lines: string[];
    try {
      lines = this.decoder.push(chunk);
    } catch {
      socket.destroy(new Error('Invalid or oversized IPC response'));
      return;
    }

    for (const line of lines) {
      if (!line) {
        continue;
      }

      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        socket.destroy(new Error('Invalid IPC response'));
        return;
      }

      const id = typeof message?.id === 'string' ? message.id : '';
      if (!id) {
        continue;
      }
      const pending = this.pending.get(id);
      if (!pending) {
        continue;
      }

      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (message.error) {
        pending.reject(new Error(String(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private onDisconnected(socket: net.Socket, reason: string): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = null;
    this.authenticated = false;
    this.connectedSocketPath = null;
    this.decoder.reset();
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private async authenticate(socket: net.Socket, socketPath: string): Promise<void> {
    const credential = readNativeIpcCredential(socketPath);
    const result = await this.sendRequest<{ authenticated?: boolean }>(
      socket,
      IPC_AUTH_METHOD,
      { token: credential.token },
      5_000,
    );
    if (result?.authenticated !== true) {
      throw new Error('Native IPC bridge did not authenticate the connection');
    }
  }

  private sendRequest<T>(
    socket: net.Socket,
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<T> {
    if (socket.destroyed || this.socket !== socket) {
      return Promise.reject(new Error('IPC socket is not connected'));
    }
    if (this.pending.size >= IPC_MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new Error(`IPC client has reached its ${IPC_MAX_PENDING_REQUESTS}-request limit`),
      );
    }

    const id = randomUUID();
    const payload = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(payload, 'utf8') > IPC_MAX_REQUEST_LINE_BYTES) {
      return Promise.reject(
        new Error(`IPC request exceeds the ${IPC_MAX_REQUEST_LINE_BYTES}-byte limit`),
      );
    }

    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IPC request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });

    const write = this.writeTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (socket.destroyed || this.socket !== socket) {
            reject(new Error('IPC socket is not connected'));
            return;
          }
          socket.write(`${payload}\n`, (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        }),
    );
    this.writeTail = write.catch(() => {});
    void write.catch((error) => {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      }
    });

    return response;
  }

  async request<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    await this.ensureConnected();
    if (!this.socket || this.socket.destroyed) {
      const detail = this.connectedSocketPath ? ` (${this.connectedSocketPath})` : '';
      throw new Error(`IPC socket is not connected${detail}`);
    }

    return await this.sendRequest<T>(this.socket, method, params, timeoutMs);
  }

  close(): void {
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.authenticated = false;
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('IPC client closed'));
      this.pending.delete(id);
    }
  }
}

const bridgeClient = new NativeIpcBridgeClient();
const mcpSessionId = randomUUID();
let stdioMcpServer: Server | null = null;
let shutdownStarted = false;

function getStdioMcpServer(): Server {
  if (stdioMcpServer) {
    return stdioMcpServer;
  }

  stdioMcpServer = new Server(
    {
      name: 'WebpageMcpStdioServer',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {
          listChanged: true,
        },
        resources: {},
        prompts: {},
      },
      debouncedNotificationMethods: ['notifications/tools/list_changed'],
    },
  );

  setupHandlers(stdioMcpServer);
  return stdioMcpServer;
}

async function listToolsFromBridge(): Promise<Tool[]> {
  const result = await bridgeClient.request<{ tools?: Tool[] }>('mcp_list_tools', {
    sessionId: mcpSessionId,
    clientCapabilities: resolveMcpClientCapabilities(stdioMcpServer?.getClientCapabilities()),
  });
  if (!result || !Array.isArray(result.tools)) {
    return TOOL_SCHEMAS;
  }
  return result.tools;
}

async function callToolFromBridge(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const result = await bridgeClient.request<{ result?: CallToolResult }>('mcp_call_tool', {
    sessionId: mcpSessionId,
    name,
    args,
    clientCapabilities: resolveMcpClientCapabilities(stdioMcpServer?.getClientCapabilities()),
  }, 120_000);
  if (!result?.result) {
    throw new Error('Missing result from native bridge');
  }
  return result.result;
}

function setupHandlers(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const tools = await listToolsFromBridge();
      return { tools };
    } catch (error) {
      console.warn('[webpage-mcp-stdio] Failed to list tools via native bridge:', error);
      return { tools: TOOL_SCHEMAS };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = request.params.arguments || {};
      const result = await callToolFromBridge(request.params.name, args);
      if (shouldNotifyWorkflowToolListChanged(request.params.name, args, result)) {
        try {
          await server.sendToolListChanged();
        } catch (notificationError) {
          console.warn(
            '[webpage-mcp-stdio] Failed to send tools/list_changed notification:',
            notificationError,
          );
        }
      }
      return result;
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: `Error calling tool: ${error?.message || String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;

  bridgeClient.close();

  try {
    await stdioMcpServer?.close();
  } catch {
    // ignore close errors during shutdown
  }
  stdioMcpServer = null;

  process.exit(exitCode);
}

function installProcessLifecycleHooks(): void {
  process.stdin.on('end', () => {
    void shutdown(0);
  });
  process.stdin.on('close', () => {
    void shutdown(0);
  });

  process.on('SIGINT', () => {
    void shutdown(0);
  });
  process.on('SIGTERM', () => {
    void shutdown(0);
  });

  const parentPid = process.ppid;
  if (Number.isInteger(parentPid) && parentPid > 1) {
    const timer = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        void shutdown(0);
      }
    }, 5000);
    timer.unref();
  }
}

async function main(): Promise<void> {
  installProcessLifecycleHooks();

  try {
    await autoBootstrapNativeMessagingForStdio({
      output: 'stderr',
    });
  } catch (error) {
    console.warn('[webpage-mcp-stdio] Automatic native registration bootstrap failed:', error);
  }

  const transport = new StdioServerTransport();
  await getStdioMcpServer().connect(transport);
}

main().catch((error) => {
  console.error('Fatal error in webpage-mcp-stdio:', error);
  process.exit(1);
});
