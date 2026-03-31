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
  key?: string;
  name?: string;
  label?: string;
  description?: string;
  sensitive?: boolean;
  type?: string;
  kind?: string;
  default?: unknown;
  required?: boolean;
  options?: unknown[];
  item?: string;
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
  'debugStepByStep',
  'stepDelayMs',
  'captureStepScreenshots',
  'recordStepScreenshotBaselines',
  'screenshotBaselines',
  'screenshotDiffThreshold',
] as const;
const RUN_OPTION_KEY_SET = new Set<string>(SESSION_RUN_OPTION_KEYS);
const PUBLIC_TOOL_NAME_SET = new Set<string>(TOOL_SCHEMAS.map((tool) => tool.name));
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

function getPublishedVariableName(variable: PublishedFlowVariable | null | undefined): string | undefined {
  if (!variable) {
    return undefined;
  }
  if (typeof variable.name === 'string' && variable.name.trim()) {
    return variable.name.trim();
  }
  if (typeof variable.key === 'string' && variable.key.trim()) {
    return variable.key.trim();
  }
  return undefined;
}

function isPublishedVariableRequired(variable: PublishedFlowVariable): boolean {
  return variable.required === true || variable.rules?.required === true;
}

function getReservedDynamicToolVariableNames(
  variables: ReadonlyArray<PublishedFlowVariable> | null | undefined,
): string[] {
  if (!Array.isArray(variables)) {
    return [];
  }

  return variables
    .map((variable) => getPublishedVariableName(variable))
    .filter((name): name is string => typeof name === 'string' && RUN_OPTION_KEY_SET.has(name));
}

function getDynamicToolVariables(
  variables: ReadonlyArray<PublishedFlowVariable> | null | undefined,
): PublishedFlowVariable[] {
  if (!Array.isArray(variables)) {
    return [];
  }

  return variables.filter((variable) => {
    if (variable?.sensitive === true) {
      return false;
    }
    const variableName = getPublishedVariableName(variable);
    return typeof variableName === 'string' && variableName.length > 0 && !RUN_OPTION_KEY_SET.has(variableName);
  });
}

function inferVariableType(variable: PublishedFlowVariable): string {
  const declaredType =
    typeof variable.kind === 'string'
      ? variable.kind
      : typeof variable.type === 'string'
        ? variable.type
        : undefined;
  if (declaredType) {
    return declaredType.toLowerCase();
  }

  if (Array.isArray(variable.default)) {
    return 'array';
  }
  if (typeof variable.default === 'boolean') {
    return 'boolean';
  }
  if (typeof variable.default === 'number') {
    return 'number';
  }
  if (variable.default && typeof variable.default === 'object') {
    return 'json';
  }
  return 'string';
}

function buildJsonValueSchema(): Record<string, unknown> {
  return {
    anyOf: [
      { type: 'object' },
      { type: 'array' },
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'null' },
    ],
  };
}

function buildArrayItemSchema(variable: PublishedFlowVariable): Record<string, unknown> {
  if (variable.item === 'json') {
    return buildJsonValueSchema();
  }
  if (
    variable.item === 'string' ||
    variable.item === 'number' ||
    variable.item === 'boolean'
  ) {
    return { type: variable.item };
  }
  if (Array.isArray(variable.default) && variable.default.length > 0) {
    const sample = variable.default[0];
    if (sample === null || Array.isArray(sample) || (sample && typeof sample === 'object')) {
      return buildJsonValueSchema();
    }
    if (typeof sample === 'boolean') return { type: 'boolean' };
    if (typeof sample === 'number') return { type: 'number' };
  }
  return { type: 'string' };
}

function buildVariableSchema(variable: PublishedFlowVariable, variableName: string): Record<string, unknown> {
  const description =
    (typeof variable.label === 'string' && variable.label.trim()) ||
    (typeof variable.description === 'string' && variable.description.trim()) ||
    variableName;
  const type = inferVariableType(variable);
  const schema: Record<string, unknown> = { description };

  if (type === 'boolean') {
    schema.type = 'boolean';
  } else if (type === 'number') {
    schema.type = 'number';
  } else if (type === 'enum') {
    schema.type = 'string';
    const enumValues = Array.isArray(variable.options)
      ? variable.options
      : Array.isArray(variable.rules?.enum)
        ? variable.rules?.enum
        : [];
    if (enumValues.length > 0) {
      schema.enum = enumValues;
    }
  } else if (type === 'array') {
    schema.type = 'array';
    schema.items = buildArrayItemSchema(variable);
  } else if (type === 'json') {
    Object.assign(schema, buildJsonValueSchema());
  } else {
    schema.type = 'string';
  }

  if (variable.default !== undefined) {
    schema.default = variable.default;
  }

  return schema;
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
    if (RUN_OPTION_KEY_SET.has(key)) {
      runOptions[key] = value;
      continue;
    }
    const isDeclaredVariable = flowVariableKeys?.has(key) === true;
    if (isDeclaredVariable || !RUN_OPTION_KEY_SET.has(key)) {
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
    const reservedVariableNames = getReservedDynamicToolVariableNames(item.variables);
    const descriptionBase =
      (item.meta && item.meta.tool && item.meta.tool.description) ||
      item.description ||
      'Recorded flow';
    const description =
      reservedVariableNames.length > 0
        ? `${descriptionBase} Reserved dynamic tool parameter names are ignored as flow variables: ${reservedVariableNames.join(', ')}. Use record_replay_flow_run with args for those values.`
        : descriptionBase;
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const v of getDynamicToolVariables(item.variables)) {
      const variableName = getPublishedVariableName(v);
      if (!variableName) {
        continue;
      }
      const prop = buildVariableSchema(v, variableName);
      if (isPublishedVariableRequired(v)) required.push(variableName);
      properties[variableName] = prop;
    }
    // Run options
    if (!properties['tabTarget'])
      properties['tabTarget'] = { type: 'string', enum: ['current', 'new'], default: 'current' };
    if (!properties['refresh']) properties['refresh'] = { type: 'boolean', default: false };
    if (!properties['captureNetwork'])
      properties['captureNetwork'] = { type: 'boolean', default: false };
    if (!properties['returnLogs']) properties['returnLogs'] = { type: 'boolean', default: false };
    if (!properties['timeoutMs']) properties['timeoutMs'] = { type: 'number', minimum: 0 };
    if (!properties['startUrl']) {
      properties['startUrl'] = {
        type: 'string',
        description: 'Optional start URL to open before running. Only http:// and https:// URLs are allowed.',
      };
    }
    if (!properties['tabId']) properties['tabId'] = { type: 'number' };
    if (!properties['debugStepByStep'])
      properties['debugStepByStep'] = {
        type: 'boolean',
        default: false,
        description: 'Include per-step debug trace in run result.',
      };
    if (!properties['stepDelayMs'])
      properties['stepDelayMs'] = {
        type: 'number',
        minimum: 0,
        description: 'Optional delay between steps for visual debugging.',
      };
    if (!properties['captureStepScreenshots'])
      properties['captureStepScreenshots'] = {
        type: 'boolean',
        default: false,
        description: 'Capture screenshot after each step and include in debug output.',
      };
    if (!properties['recordStepScreenshotBaselines'])
      properties['recordStepScreenshotBaselines'] = {
        type: 'boolean',
        default: false,
        description: 'Capture screenshots keyed by stepId for future baseline comparison.',
      };
    if (!properties['screenshotBaselines'])
      properties['screenshotBaselines'] = {
        type: 'object',
        description: 'Baseline screenshots keyed by stepId.',
      };
    if (!properties['screenshotDiffThreshold'])
      properties['screenshotDiffThreshold'] = {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Similarity threshold for screenshot comparison (0-1).',
      };
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
    return { tools: await listToolsForContext(ctx) };
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callToolForContext(ctx, request.params.name, request.params.arguments || {}),
  );
};

export async function listToolsForContext(ctx: McpToolContext): Promise<Tool[]> {
  const dynamicTools = await listDynamicFlowTools(ctx);
  return [...TOOL_SCHEMAS, ...dynamicTools];
}

export const callToolForContext = async (
  ctx: McpToolContext,
  name: string,
  args: any,
): Promise<CallToolResult> => {
  try {
    if (!name || (!name.startsWith('flow.') && !PUBLIC_TOOL_NAME_SET.has(name))) {
      return {
        content: [
          {
            type: 'text',
            text: `Error calling tool: Tool not found: ${name}`,
          },
        ],
        isError: true,
      };
    }

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
          getDynamicToolVariables(match.variables)
            .map((variable) => getPublishedVariableName(variable))
            .filter((key): key is string => typeof key === 'string' && key.length > 0),
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
