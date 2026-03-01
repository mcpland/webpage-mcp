import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { NativeMessageType, TOOL_SCHEMAS } from 'webpage-mcp-shared';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { NativeMessagingHost } from '../native-messaging-host';

export interface McpToolContext {
  sessionId: string;
  instanceId: string;
  nativeHost: NativeMessagingHost;
}

interface PublishedFlowVariable {
  key: string;
  label?: string;
  type?: string;
  default?: unknown;
  rules?: {
    required?: boolean;
    enum?: unknown[];
  };
}

interface PublishedFlow {
  id: string;
  slug: string;
  description?: string;
  variables?: PublishedFlowVariable[];
  meta?: {
    tool?: {
      description?: string;
    };
  };
}

const FLOW_TOOL_CACHE_TTL_MS = 10_000;
const FLOW_TOOL_CACHE_STALE_MS = 5 * 60_000;
const FLOW_TOOL_CACHE_MAX_SESSIONS = 500;
const SESSION_RUN_OPTION_KEYS = [
  'tabTarget',
  'refresh',
  'captureNetwork',
  'returnLogs',
  'timeoutMs',
  'startUrl',
  'tabId',
] as const;
const RUN_OPTION_KEY_SET = new Set<string>(SESSION_RUN_OPTION_KEYS);
const publishedFlowsCache = new Map<string, { fetchedAt: number; items: PublishedFlow[] }>();
const publishedFlowsInflight = new Map<string, Promise<PublishedFlow[]>>();

export function clearDynamicFlowCacheForSession(sessionId: string): void {
  if (!sessionId) {
    return;
  }
  publishedFlowsCache.delete(sessionId);
  publishedFlowsInflight.delete(sessionId);
}

function pruneDynamicFlowCaches(now = Date.now()): void {
  for (const [sessionId, cache] of publishedFlowsCache.entries()) {
    if (now - cache.fetchedAt > FLOW_TOOL_CACHE_STALE_MS) {
      publishedFlowsCache.delete(sessionId);
      publishedFlowsInflight.delete(sessionId);
    }
  }

  if (publishedFlowsCache.size <= FLOW_TOOL_CACHE_MAX_SESSIONS) {
    return;
  }
  const entries = Array.from(publishedFlowsCache.entries()).sort(
    (a, b) => a[1].fetchedAt - b[1].fetchedAt,
  );
  const overflow = publishedFlowsCache.size - FLOW_TOOL_CACHE_MAX_SESSIONS;
  for (let i = 0; i < overflow; i += 1) {
    const target = entries[i];
    if (!target) break;
    publishedFlowsCache.delete(target[0]);
    publishedFlowsInflight.delete(target[0]);
  }
}

function normalizePublishedFlows(response: any): PublishedFlow[] {
  if (!response || response.status !== 'success' || !Array.isArray(response.items)) {
    return [];
  }

  return response.items
    .filter(
      (item: any) =>
        item &&
        typeof item.id === 'string' &&
        item.id.trim().length > 0 &&
        typeof item.slug === 'string' &&
        item.slug.trim().length > 0,
    )
    .map((item: any) => ({
      id: item.id,
      slug: item.slug,
      description: item.description,
      variables: Array.isArray(item.variables) ? item.variables : [],
      meta: item.meta,
    }));
}

async function fetchPublishedFlows(
  ctx: McpToolContext,
  options?: { forceRefresh?: boolean },
): Promise<PublishedFlow[]> {
  const forceRefresh = options?.forceRefresh === true;
  const now = Date.now();
  pruneDynamicFlowCaches(now);
  const cached = publishedFlowsCache.get(ctx.sessionId);
  if (!forceRefresh && cached && now - cached.fetchedAt < FLOW_TOOL_CACHE_TTL_MS) {
    return cached.items;
  }

  if (!forceRefresh) {
    const inflight = publishedFlowsInflight.get(ctx.sessionId);
    if (inflight) {
      return inflight;
    }
  }

  const requestPromise = (async () => {
    const response = await ctx.nativeHost.sendRequestToExtensionAndWait(
      { meta: { mcpSessionId: ctx.sessionId, instanceId: ctx.instanceId } },
      'rr_list_published_flows',
      20000,
    );
    const items = normalizePublishedFlows(response);
    publishedFlowsCache.set(ctx.sessionId, {
      fetchedAt: Date.now(),
      items,
    });
    pruneDynamicFlowCaches();
    return items;
  })()
    .catch(() => {
      return [];
    })
    .finally(() => {
      publishedFlowsInflight.delete(ctx.sessionId);
    });

  publishedFlowsInflight.set(ctx.sessionId, requestPromise);
  return requestPromise;
}

function splitDynamicFlowArgs(
  args: any,
  flowVariableKeys?: ReadonlySet<string>,
): {
  variables: Record<string, unknown>;
  runOptions: Record<string, unknown>;
} {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { variables: {}, runOptions: {} };
  }

  const variables: Record<string, unknown> = {};
  const runOptions: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (flowVariableKeys?.has(key)) {
      variables[key] = value;
      continue;
    }
    if (RUN_OPTION_KEY_SET.has(key)) {
      runOptions[key] = value;
    } else {
      variables[key] = value;
    }
  }

  return { variables, runOptions };
}

async function listDynamicFlowTools(ctx: McpToolContext): Promise<Tool[]> {
  const items = await fetchPublishedFlows(ctx);
  const tools: Tool[] = [];
  for (const item of items) {
    const name = `flow.${item.slug}`;
    const description =
      (item.meta && item.meta.tool && item.meta.tool.description) ||
      item.description ||
      'Recorded flow';
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const v of item.variables || []) {
      if (!v || typeof v.key !== 'string' || !v.key) {
        continue;
      }
      const desc = v.label || v.key;
      const typ = (v.type || 'string').toLowerCase();
      const prop: any = { description: desc };
      if (typ === 'boolean') prop.type = 'boolean';
      else if (typ === 'number') prop.type = 'number';
      else if (typ === 'enum') {
        prop.type = 'string';
        if (v.rules && Array.isArray(v.rules.enum)) prop.enum = v.rules.enum;
      } else if (typ === 'array') {
        // default array of strings; can extend with itemType later
        prop.type = 'array';
        prop.items = { type: 'string' };
      } else {
        prop.type = 'string';
      }
      if (v.default !== undefined) prop.default = v.default;
      if (v.rules && v.rules.required) required.push(v.key);
      properties[v.key] = prop;
    }
    // Run options
    if (!properties['tabTarget'])
      properties['tabTarget'] = { type: 'string', enum: ['current', 'new'], default: 'current' };
    if (!properties['refresh']) properties['refresh'] = { type: 'boolean', default: false };
    if (!properties['captureNetwork'])
      properties['captureNetwork'] = { type: 'boolean', default: false };
    if (!properties['returnLogs']) properties['returnLogs'] = { type: 'boolean', default: false };
    if (!properties['timeoutMs']) properties['timeoutMs'] = { type: 'number', minimum: 0 };
    if (!properties['startUrl']) properties['startUrl'] = { type: 'string' };
    if (!properties['tabId']) properties['tabId'] = { type: 'number' };
    const tool: Tool = {
      name,
      description,
      inputSchema: { type: 'object', properties, required },
    };
    tools.push(tool);
  }
  return tools;
}

export const setupTools = (server: Server, ctx: McpToolContext) => {
  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const dynamicTools = await listDynamicFlowTools(ctx);
    return { tools: [...TOOL_SCHEMAS, ...dynamicTools] };
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleToolCall(ctx, request.params.name, request.params.arguments || {}),
  );
};

const handleToolCall = async (ctx: McpToolContext, name: string, args: any): Promise<CallToolResult> => {
  try {
    // If calling a dynamic flow tool (name starts with flow.), proxy to common flow-run tool
    if (name && name.startsWith('flow.')) {
      // We need to resolve flow by slug to ID
      try {
        const slug = name.slice('flow.'.length);
        let items = await fetchPublishedFlows(ctx);
        let match = items.find((it) => it.slug === slug);
        if (!match) {
          items = await fetchPublishedFlows(ctx, { forceRefresh: true });
          match = items.find((it) => it.slug === slug);
        }
        if (!match) throw new Error(`Flow not found for tool ${name}`);
        const variableKeys = new Set(
          Array.isArray(match.variables)
            ? match.variables
                .map((variable) => variable?.key)
                .filter((key): key is string => typeof key === 'string' && key.length > 0)
            : [],
        );
        const { variables, runOptions } = splitDynamicFlowArgs(args, variableKeys);
        const flowArgs = {
          flowId: match.id,
          args: variables,
          ...runOptions,
        };
        const proxyRes = await ctx.nativeHost.sendRequestToExtensionAndWait(
          {
            name: 'record_replay_flow_run',
            args: flowArgs,
            meta: { mcpSessionId: ctx.sessionId, instanceId: ctx.instanceId },
          },
          NativeMessageType.CALL_TOOL,
          120000,
        );
        if (proxyRes.status === 'success') return proxyRes.data;
        return {
          content: [{ type: 'text', text: `Error calling dynamic flow tool: ${proxyRes.error}` }],
          isError: true,
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error resolving dynamic flow tool: ${err?.message || String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
    // Send request to Chrome extension and wait for response
    const response = await ctx.nativeHost.sendRequestToExtensionAndWait(
      {
        name,
        args,
        meta: { mcpSessionId: ctx.sessionId, instanceId: ctx.instanceId },
      },
      NativeMessageType.CALL_TOOL,
      120000, // Extended to 120 seconds to avoid timeout for long tasks such as performance analysis
    );
    if (response.status === 'success') {
      return response.data;
    } else {
      return {
        content: [
          {
            type: 'text',
            text: `Error calling tool: ${response.error}`,
          },
        ],
        isError: true,
      };
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Error calling tool: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
};
