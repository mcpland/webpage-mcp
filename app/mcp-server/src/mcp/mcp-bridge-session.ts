import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { TOOL_SCHEMAS } from 'webpage-mcp-shared';
import { resolveInstanceId } from '../instance-id';
import type { NativeBridgeRequestClient } from './native-ipc-bridge-client';
import {
  clearDynamicFlowCacheForSession,
  resolveMcpClientCapabilities,
} from './register-tools';
import { shouldNotifyWorkflowToolListChanged } from './tool-list-change';

const LIST_TOOLS_TIMEOUT_MS = 30_000;
const CALL_TOOL_TIMEOUT_MS = 120_000;

export interface McpBridgeSessionOptions {
  bridgeClient: NativeBridgeRequestClient;
  instanceId?: string;
  sessionId?: string;
  serverName: string;
  logLabel: string;
  onToolListChanged?: (sourceSessionId: string) => Promise<void>;
}

export interface McpBridgeSession {
  readonly server: Server;
  readonly sessionId: string;
  readonly instanceId: string;
  close(): Promise<void>;
}

function isAbortFailure(error: unknown, signal: AbortSignal): boolean {
  return Boolean(
    signal.aborted ||
      (error &&
        typeof error === 'object' &&
        'name' in error &&
        (error as { name?: unknown }).name === 'AbortError'),
  );
}

export function createMcpBridgeSession(options: McpBridgeSessionOptions): McpBridgeSession {
  const sessionId = options.sessionId || randomUUID();
  const instanceId = resolveInstanceId(options.instanceId);
  const server = new Server(
    {
      name: options.serverName,
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

  const bridgeParams = (): Record<string, unknown> => ({
    sessionId,
    instanceId,
    clientCapabilities: resolveMcpClientCapabilities(server.getClientCapabilities()),
  });

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    try {
      const response = await options.bridgeClient.request<{ tools?: Tool[] }>(
        'mcp_list_tools',
        bridgeParams(),
        LIST_TOOLS_TIMEOUT_MS,
        extra.signal,
      );
      return { tools: response && Array.isArray(response.tools) ? response.tools : TOOL_SCHEMAS };
    } catch (error) {
      if (isAbortFailure(error, extra.signal)) {
        throw error;
      }
      console.warn(`[${options.logLabel}] Failed to list tools via native bridge:`, error);
      return { tools: TOOL_SCHEMAS };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments || {};
    try {
      const response = await options.bridgeClient.request<{ result?: CallToolResult }>(
        'mcp_call_tool',
        {
          ...bridgeParams(),
          name: request.params.name,
          args,
        },
        CALL_TOOL_TIMEOUT_MS,
        extra.signal,
      );
      if (!response?.result) {
        throw new Error('Missing result from native bridge');
      }
      if (shouldNotifyWorkflowToolListChanged(request.params.name, args, response.result)) {
        try {
          if (options.onToolListChanged) {
            await options.onToolListChanged(sessionId);
          } else {
            await server.sendToolListChanged();
          }
        } catch (notificationError) {
          console.warn(
            `[${options.logLabel}] Failed to send tools/list_changed notification:`,
            notificationError,
          );
        }
      }
      return response.result;
    } catch (error) {
      if (isAbortFailure(error, extra.signal)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error calling tool: ${message}` }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));

  let closePromise: Promise<void> | null = null;
  return {
    server,
    sessionId,
    instanceId,
    close(): Promise<void> {
      if (!closePromise) {
        clearDynamicFlowCacheForSession(sessionId);
        // Assign before invoking Server.close so a synchronous transport
        // onclose callback cannot recursively start a second close.
        closePromise = Promise.resolve().then(() => server.close());
      }
      return closePromise;
    },
  };
}
