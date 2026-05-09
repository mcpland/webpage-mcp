import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  NativeMessageType,
  TOOL_SCHEMAS,
  WEBPAGE_MCP_CAPABILITY_VERSION,
  WEBPAGE_MCP_PROTOCOL_VERSION,
  WEBPAGE_MCP_SUPPORTED_WORKFLOW_RUN_OPTIONS,
  type WebpageMcpExtensionCapabilities,
  type WebpageMcpWorkflowRunOption,
} from 'webpage-mcp-shared';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { NativeMessagingHost } from '../native-messaging-host';
import {
  isSuccessfulMcpToolResult,
  shouldRefreshWorkflowToolList,
} from './tool-list-change';

export interface McpToolContext {
  sessionId: string;
  instanceId: string;
  nativeHost: NativeMessagingHost;
  clientCapabilities?: McpClientCapabilityFallback;
}

export interface McpClientCapabilityFallback {
  toolListChanged: boolean;
  resourceReferences: boolean;
  cancellation: boolean;
  structuredErrors: boolean;
  largeResults: boolean;
  source: 'initialize' | 'env' | 'default';
  warnings: string[];
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

interface PublishedFlowParameterSchema {
  type?: string;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
}

interface PublishedFlowBackgroundSupport {
  supported?: boolean;
  modes?: string[];
  caveats?: string[];
}

interface PublishedFlowSideEffectSummary {
  safe?: number;
  idempotent?: number;
  dangerous?: number;
  unknown?: number;
}

interface PublishedFlowSideEffects {
  summary?: PublishedFlowSideEffectSummary;
}

interface PublishedFlow {
  id: string;
  slug: string;
  revision?: string;
  description?: string;
  variables?: PublishedFlowVariable[];
  parameters?: PublishedFlowParameterSchema;
  exampleArgs?: Record<string, unknown>;
  backgroundSupport?: PublishedFlowBackgroundSupport;
  sideEffects?: PublishedFlowSideEffects;
  outputs?: Array<Record<string, unknown>>;
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
  'background',
  'refresh',
  'captureNetwork',
  'returnLogs',
  'timeoutMs',
  'startUrl',
  'tabId',
] as const;
type SessionRunOptionKey = (typeof SESSION_RUN_OPTION_KEYS)[number];
const DEFAULT_SUPPORTED_RUN_OPTION_KEYS = [
  ...WEBPAGE_MCP_SUPPORTED_WORKFLOW_RUN_OPTIONS,
] as const satisfies ReadonlyArray<SessionRunOptionKey>;
const WORKFLOW_RUN_TOOL_NAME = 'workflow_run';
const EXPOSE_LEGACY_FLOW_TOOLS_ENV = 'WEBPAGE_MCP_EXPOSE_LEGACY_FLOW_TOOLS';
const PUBLIC_TOOL_NAME_SET = new Set<string>(TOOL_SCHEMAS.map((tool) => tool.name));
const publishedFlowsCache = new Map<string, { fetchedAt: number; items: PublishedFlow[] }>();
const publishedFlowsInflight = new Map<string, Promise<PublishedFlow[]>>();
const extensionCapabilitiesCache = new Map<
  string,
  { fetchedAt: number; capabilities: WebpageMcpExtensionCapabilities }
>();

const MCP_SERVER_VERSION = (() => {
  try {
    const pkg = require('../../package.json') as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version.trim()) {
      return pkg.version;
    }
  } catch {
    // Fall through to the environment fallback.
  }
  return process.env.npm_package_version || 'unknown';
})();

function getNestedBoolean(value: unknown, paths: string[][]): boolean | undefined {
  for (const path of paths) {
    let current = value;
    for (const key of path) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[key];
    }
    if (typeof current === 'boolean') {
      return current;
    }
  }
  return undefined;
}

function readEnvBoolean(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return undefined;
}

function resolveClientCapabilityBoolean(
  initializeCapabilities: unknown,
  envName: string,
  paths: string[][],
): { value: boolean; source: 'initialize' | 'env' | 'default' } {
  const fromInitialize = getNestedBoolean(initializeCapabilities, paths);
  if (fromInitialize !== undefined) {
    return { value: fromInitialize, source: 'initialize' };
  }
  const fromEnv = readEnvBoolean(envName);
  if (fromEnv !== undefined) {
    return { value: fromEnv, source: 'env' };
  }
  return { value: false, source: 'default' };
}

function strongestClientCapabilitySource(
  sources: Array<'initialize' | 'env' | 'default'>,
): 'initialize' | 'env' | 'default' {
  if (sources.includes('initialize')) return 'initialize';
  if (sources.includes('env')) return 'env';
  return 'default';
}

export function resolveMcpClientCapabilities(
  initializeCapabilities?: unknown,
): McpClientCapabilityFallback {
  const toolListChanged = resolveClientCapabilityBoolean(
    initializeCapabilities,
    'WEBPAGE_MCP_CLIENT_TOOL_LIST_CHANGED',
    [
      ['tools', 'listChanged'],
      ['notifications', 'toolsListChanged'],
      ['experimental', 'toolsListChanged'],
      ['experimental', 'toolListChanged'],
    ],
  );
  const resourceReferences = resolveClientCapabilityBoolean(
    initializeCapabilities,
    'WEBPAGE_MCP_CLIENT_RESOURCE_REFERENCES',
    [
      ['resources', 'references'],
      ['experimental', 'resourceReferences'],
    ],
  );
  const cancellation = resolveClientCapabilityBoolean(
    initializeCapabilities,
    'WEBPAGE_MCP_CLIENT_CANCELLATION',
    [
      ['cancellation'],
      ['notifications', 'cancelled'],
      ['experimental', 'cancellation'],
    ],
  );
  const structuredErrors = resolveClientCapabilityBoolean(
    initializeCapabilities,
    'WEBPAGE_MCP_CLIENT_STRUCTURED_ERRORS',
    [
      ['errors', 'structured'],
      ['experimental', 'structuredErrors'],
    ],
  );
  const largeResults = resolveClientCapabilityBoolean(
    initializeCapabilities,
    'WEBPAGE_MCP_CLIENT_LARGE_RESULTS',
    [
      ['results', 'large'],
      ['experimental', 'largeResults'],
    ],
  );
  const source = strongestClientCapabilitySource([
    toolListChanged.source,
    resourceReferences.source,
    cancellation.source,
    structuredErrors.source,
    largeResults.source,
  ]);
  const warnings: string[] = [];
  if (!toolListChanged.value) {
    warnings.push(
      'MCP client tool-list change support is not confirmed; workflow_run.workflow uses plain string runtime validation.',
    );
  }
  if (!resourceReferences.value) {
    warnings.push(
      'MCP client resource references are not confirmed; debug artifacts should be returned as compact summaries.',
    );
  }
  if (!cancellation.value) {
    warnings.push(
      'MCP client cancellation support is not confirmed; long-running workflow operations should use bounded timeouts.',
    );
  }

  return {
    toolListChanged: toolListChanged.value,
    resourceReferences: resourceReferences.value,
    cancellation: cancellation.value,
    structuredErrors: structuredErrors.value,
    largeResults: largeResults.value,
    source,
    warnings,
  };
}

function getClientCapabilitiesForContext(ctx: McpToolContext): McpClientCapabilityFallback {
  return ctx.clientCapabilities ?? resolveMcpClientCapabilities();
}

function listSupportedClientCapabilities(
  clientCapabilities: McpClientCapabilityFallback,
): string[] {
  return [
    clientCapabilities.toolListChanged ? 'toolListChanged' : undefined,
    clientCapabilities.resourceReferences ? 'resourceReferences' : undefined,
    clientCapabilities.cancellation ? 'cancellation' : undefined,
    clientCapabilities.structuredErrors ? 'structuredErrors' : undefined,
    clientCapabilities.largeResults ? 'largeResults' : undefined,
  ].filter((capability): capability is string => typeof capability === 'string');
}

function buildExtensionToolMeta(ctx: McpToolContext): {
  mcpSessionId: string;
  instanceId: string;
  clientCapabilities: McpClientCapabilityFallback;
} {
  return {
    mcpSessionId: ctx.sessionId,
    instanceId: ctx.instanceId,
    clientCapabilities: getClientCapabilitiesForContext(ctx),
  };
}

export function clearDynamicFlowCacheForSession(sessionId: string): void {
  if (!sessionId) {
    return;
  }
  publishedFlowsCache.delete(sessionId);
  publishedFlowsInflight.delete(sessionId);
  extensionCapabilitiesCache.delete(sessionId);
}

function pruneDynamicFlowCaches(now = Date.now()): void {
  for (const [sessionId, cache] of publishedFlowsCache.entries()) {
    if (now - cache.fetchedAt > FLOW_TOOL_CACHE_STALE_MS) {
      publishedFlowsCache.delete(sessionId);
      publishedFlowsInflight.delete(sessionId);
      extensionCapabilitiesCache.delete(sessionId);
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
    extensionCapabilitiesCache.delete(target[0]);
  }
}

function shouldExposeLegacyDynamicFlowTools(): boolean {
  return process.env[EXPOSE_LEGACY_FLOW_TOOLS_ENV] === '1';
}

function createFallbackExtensionCapabilities(
  warning = 'Extension capability handshake unavailable; using conservative workflow schema.',
): WebpageMcpExtensionCapabilities {
  return {
    protocolVersion: WEBPAGE_MCP_PROTOCOL_VERSION,
    capabilityVersion: WEBPAGE_MCP_CAPABILITY_VERSION,
    extensionVersion: 'unknown',
    mcpServerVersion: MCP_SERVER_VERSION,
    supportedTools: TOOL_SCHEMAS.map((tool) => tool.name),
    supportedRunOptions: [...DEFAULT_SUPPORTED_RUN_OPTION_KEYS],
    featureFlags: ['capability_handshake_fallback'],
    warnings: [warning],
  };
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function normalizeExtensionCapabilities(value: unknown): WebpageMcpExtensionCapabilities {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createFallbackExtensionCapabilities();
  }

  const raw = value as Record<string, unknown>;
  const supportedRunOptions = normalizeStringArray(raw.supportedRunOptions).filter(
    (option): option is WebpageMcpWorkflowRunOption =>
      (SESSION_RUN_OPTION_KEYS as readonly string[]).includes(option),
  );
  const supportedTools = normalizeStringArray(raw.supportedTools);
  const warnings = normalizeStringArray(raw.warnings);

  return {
    protocolVersion:
      typeof raw.protocolVersion === 'string' && raw.protocolVersion.trim()
        ? raw.protocolVersion
        : WEBPAGE_MCP_PROTOCOL_VERSION,
    capabilityVersion:
      typeof raw.capabilityVersion === 'string' && raw.capabilityVersion.trim()
        ? raw.capabilityVersion
        : WEBPAGE_MCP_CAPABILITY_VERSION,
    extensionVersion:
      typeof raw.extensionVersion === 'string' && raw.extensionVersion.trim()
        ? raw.extensionVersion
        : 'unknown',
    mcpServerVersion:
      typeof raw.mcpServerVersion === 'string' && raw.mcpServerVersion.trim()
        ? raw.mcpServerVersion
        : MCP_SERVER_VERSION,
    supportedTools: supportedTools.length > 0 ? supportedTools : TOOL_SCHEMAS.map((tool) => tool.name),
    supportedRunOptions:
      supportedRunOptions.length > 0
        ? supportedRunOptions
        : [...DEFAULT_SUPPORTED_RUN_OPTION_KEYS],
    featureFlags: normalizeStringArray(raw.featureFlags),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(typeof raw.generatedAt === 'string' ? { generatedAt: raw.generatedAt } : {}),
  };
}

function rememberExtensionCapabilities(
  sessionId: string,
  capabilities: WebpageMcpExtensionCapabilities,
): void {
  extensionCapabilitiesCache.set(sessionId, {
    fetchedAt: Date.now(),
    capabilities,
  });
}

function getExtensionCapabilitiesForSession(sessionId: string): WebpageMcpExtensionCapabilities {
  const cached = extensionCapabilitiesCache.get(sessionId);
  if (cached && Date.now() - cached.fetchedAt < FLOW_TOOL_CACHE_STALE_MS) {
    return cached.capabilities;
  }
  return createFallbackExtensionCapabilities();
}

function getRunOptionKeySet(
  capabilities: WebpageMcpExtensionCapabilities,
): ReadonlySet<SessionRunOptionKey> {
  const supported = new Set<SessionRunOptionKey>();
  for (const option of capabilities.supportedRunOptions) {
    if ((SESSION_RUN_OPTION_KEYS as readonly string[]).includes(option)) {
      supported.add(option as SessionRunOptionKey);
    }
  }
  if (supported.size === 0) {
    for (const option of DEFAULT_SUPPORTED_RUN_OPTION_KEYS) {
      supported.add(option);
    }
  }
  return supported;
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
      revision: typeof item.revision === 'string' ? item.revision : undefined,
      description: item.description,
      variables: Array.isArray(item.variables) ? item.variables : [],
      parameters:
        item.parameters && typeof item.parameters === 'object' && !Array.isArray(item.parameters)
          ? item.parameters
          : undefined,
      exampleArgs:
        item.exampleArgs && typeof item.exampleArgs === 'object' && !Array.isArray(item.exampleArgs)
          ? item.exampleArgs
          : undefined,
      backgroundSupport:
        item.backgroundSupport &&
        typeof item.backgroundSupport === 'object' &&
        !Array.isArray(item.backgroundSupport)
          ? item.backgroundSupport
          : undefined,
      sideEffects:
        item.sideEffects && typeof item.sideEffects === 'object' && !Array.isArray(item.sideEffects)
          ? item.sideEffects
          : undefined,
      outputs: Array.isArray(item.outputs) ? item.outputs : undefined,
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
  runOptionKeys: ReadonlySet<SessionRunOptionKey>,
): string[] {
  if (!Array.isArray(variables)) {
    return [];
  }

  return variables
    .map((variable) => getPublishedVariableName(variable))
    .filter(
      (name): name is string =>
        typeof name === 'string' && runOptionKeys.has(name as SessionRunOptionKey),
    );
}

function getDynamicToolVariables(
  variables: ReadonlyArray<PublishedFlowVariable> | null | undefined,
  runOptionKeys: ReadonlySet<SessionRunOptionKey>,
): PublishedFlowVariable[] {
  if (!Array.isArray(variables)) {
    return [];
  }

  return variables.filter((variable) => {
    if (variable?.sensitive === true) {
      return false;
    }
    const variableName = getPublishedVariableName(variable);
    return (
      typeof variableName === 'string' &&
      variableName.length > 0 &&
      !runOptionKeys.has(variableName as SessionRunOptionKey)
    );
  });
}

function getSchemaParameterNames(parameters: PublishedFlowParameterSchema | undefined): string[] {
  if (!parameters?.properties || typeof parameters.properties !== 'object') {
    return [];
  }
  return Object.keys(parameters.properties).filter((name) => name.length > 0);
}

function getReservedDynamicToolParameterNames(
  item: PublishedFlow,
  runOptionKeys: ReadonlySet<SessionRunOptionKey>,
): string[] {
  const names = new Set<string>(getReservedDynamicToolVariableNames(item.variables, runOptionKeys));
  for (const name of getSchemaParameterNames(item.parameters)) {
    if (runOptionKeys.has(name as SessionRunOptionKey)) {
      names.add(name);
    }
  }
  return Array.from(names);
}

function buildDynamicToolParameterSchemaFromDescriptor(
  item: PublishedFlow,
  runOptionKeys: ReadonlySet<SessionRunOptionKey>,
): { properties: Record<string, any>; required: string[] } | null {
  const schema = item.parameters;
  if (!schema?.properties || typeof schema.properties !== 'object') {
    return null;
  }

  const properties: Record<string, any> = {};
  for (const [name, value] of Object.entries(schema.properties)) {
    if (!name || runOptionKeys.has(name as SessionRunOptionKey)) {
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      properties[name] = { ...value };
    }
  }

  const required = Array.isArray(schema.required)
    ? schema.required.filter((name) => typeof name === 'string' && name in properties)
    : [];
  return { properties, required };
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
      {
        meta: buildExtensionToolMeta(ctx),
        handshake: {
          protocolVersion: WEBPAGE_MCP_PROTOCOL_VERSION,
          mcpServerVersion: MCP_SERVER_VERSION,
          clientCapabilities: listSupportedClientCapabilities(
            getClientCapabilitiesForContext(ctx),
          ),
        },
      },
      'rr_list_published_flows',
      20000,
    );
    rememberExtensionCapabilities(
      ctx.sessionId,
      normalizeExtensionCapabilities(response?.capabilities),
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
      rememberExtensionCapabilities(
        ctx.sessionId,
        createFallbackExtensionCapabilities('Extension capability handshake failed; using conservative workflow schema.'),
      );
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
  runOptionKeys: ReadonlySet<SessionRunOptionKey> = new Set(DEFAULT_SUPPORTED_RUN_OPTION_KEYS),
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
    if (runOptionKeys.has(key as SessionRunOptionKey)) {
      runOptions[key] = value;
      continue;
    }
    const isDeclaredVariable = flowVariableKeys?.has(key) === true;
    if (isDeclaredVariable || !runOptionKeys.has(key as SessionRunOptionKey)) {
      variables[key] = value;
    }
  }

  return { variables, runOptions };
}

function getWorkflowSummary(items: PublishedFlow[]): string {
  const workflows = items
    .slice(0, 50)
    .map((item) => {
      const description = (item.meta && item.meta.tool && item.meta.tool.description) || item.description || '';
      const sideEffects = item.sideEffects?.summary;
      const effectSummary = sideEffects
        ? ` [side effects: safe ${sideEffects.safe ?? 0}, idempotent ${sideEffects.idempotent ?? 0}, dangerous ${sideEffects.dangerous ?? 0}]`
        : '';
      const background =
        item.backgroundSupport?.supported === false
          ? ' [background: no]'
          : item.backgroundSupport?.supported === true
            ? ' [background: yes]'
            : '';
      return description
        ? `${item.slug}: ${description}${background}${effectSummary}`
        : `${item.slug}${background}${effectSummary}`;
    })
    .join('\n');
  return workflows || 'No published workflows were discovered for this browser session.';
}

function addWorkflowRunOptionProperties(
  properties: Record<string, any>,
  runOptionKeys: ReadonlySet<SessionRunOptionKey>,
): void {
  if (runOptionKeys.has('tabId')) {
    properties.tabId = {
      type: 'number',
      description: 'Explicit tab to bind the run to. Overrides `tabTarget`.',
    };
  }
  if (runOptionKeys.has('tabTarget')) {
    properties.tabTarget = {
      type: 'string',
      enum: ['current', 'new'],
      default: 'current',
      description: "Target tab: 'current' or 'new'.",
    };
  }
  if (runOptionKeys.has('background')) {
    properties.background = {
      type: 'boolean',
      default: false,
      description: 'Run without activating/focusing target tabs or windows where Chrome APIs allow it.',
    };
  }
  if (runOptionKeys.has('refresh')) {
    properties.refresh = { type: 'boolean', default: false };
  }
  if (runOptionKeys.has('captureNetwork')) {
    properties.captureNetwork = { type: 'boolean', default: false };
  }
  if (runOptionKeys.has('returnLogs')) {
    properties.returnLogs = { type: 'boolean', default: false };
  }
  if (runOptionKeys.has('timeoutMs')) {
    properties.timeoutMs = { type: 'number', minimum: 0 };
  }
  if (runOptionKeys.has('startUrl')) {
    properties.startUrl = {
      type: 'string',
      description: 'Optional start URL to open before running. Only http:// and https:// URLs are allowed.',
    };
  }
}

function buildWorkflowRunTool(
  items: PublishedFlow[],
  capabilities: WebpageMcpExtensionCapabilities,
  clientCapabilities: McpClientCapabilityFallback,
): Tool {
  const workflowSlugs = items.map((item) => item.slug).filter((slug) => slug.length > 0);
  const workflowProperty: Record<string, unknown> = {
    type: 'string',
    description:
      'Published workflow slug to run. Use workflow_describe or record_replay_list_published for parameter schema, examples, background support, and side-effect metadata.',
  };
  if (workflowSlugs.length > 0 && clientCapabilities.toolListChanged) {
    workflowProperty.enum = workflowSlugs;
  }
  const runOptionKeys = getRunOptionKeySet(capabilities);
  const properties: Record<string, any> = {
    workflow: workflowProperty,
    args: {
      type: 'object',
      description:
        'Workflow variable values keyed by variable name. Sensitive values may be passed as { "secretRef": "..." } so plaintext is injected only in the extension runtime.',
      additionalProperties: true,
    },
  };
  addWorkflowRunOptionProperties(properties, runOptionKeys);

  return {
    name: WORKFLOW_RUN_TOOL_NAME,
    description: `Run a published workflow by slug using a compact schema. Use workflow_describe before running when you need exact args or side-effect/background details. ${
      clientCapabilities.toolListChanged
        ? 'The workflow field includes the currently published slugs.'
        : 'Client tool-list refresh support is not confirmed, so workflow is validated at runtime.'
    } Available workflows:\n${getWorkflowSummary(items)}`,
    inputSchema: {
      type: 'object',
      properties,
      required: ['workflow'],
    },
  };
}

function filterFlowRunToolForCapabilities(
  tool: Tool,
  capabilities: WebpageMcpExtensionCapabilities,
): Tool {
  if (tool.name !== 'record_replay_flow_run') {
    return tool;
  }
  const inputSchema = tool.inputSchema as { properties?: Record<string, any>; required?: string[] };
  const baseProperties = inputSchema?.properties || {};
  const runOptionKeys = getRunOptionKeySet(capabilities);
  const properties: Record<string, any> = {};
  for (const key of ['flowId', 'args']) {
    if (baseProperties[key]) {
      properties[key] = baseProperties[key];
    }
  }
  for (const key of SESSION_RUN_OPTION_KEYS) {
    if (runOptionKeys.has(key) && baseProperties[key]) {
      properties[key] = baseProperties[key];
    }
  }
  return {
    ...tool,
    inputSchema: {
      ...inputSchema,
      type: 'object',
      properties,
    },
  };
}

function filterPublicToolsForCapabilities(
  capabilities: WebpageMcpExtensionCapabilities,
): Tool[] {
  const supportedTools = new Set(capabilities.supportedTools);
  return TOOL_SCHEMAS.filter((tool) => supportedTools.has(tool.name)).map((tool) =>
    filterFlowRunToolForCapabilities(tool, capabilities),
  );
}

function supportsWorkflowRun(capabilities: WebpageMcpExtensionCapabilities): boolean {
  return capabilities.supportedTools.includes('record_replay_flow_run');
}

async function ensureCapabilitiesForContext(
  ctx: McpToolContext,
): Promise<WebpageMcpExtensionCapabilities> {
  await fetchPublishedFlows(ctx);
  return getExtensionCapabilitiesForSession(ctx.sessionId);
}

function filterFlowRunArgsForCapabilities(
  args: any,
  capabilities: WebpageMcpExtensionCapabilities,
): any {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return args;
  }
  const runOptionKeys = getRunOptionKeySet(capabilities);
  const filtered: Record<string, unknown> = {};
  for (const key of ['flowId', 'args', 'requireRevision']) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      filtered[key] = args[key];
    }
  }
  for (const key of SESSION_RUN_OPTION_KEYS) {
    if (runOptionKeys.has(key) && Object.prototype.hasOwnProperty.call(args, key)) {
      filtered[key] = args[key];
    }
  }
  return filtered;
}

async function listDynamicFlowTools(
  ctx: McpToolContext,
  capabilities: WebpageMcpExtensionCapabilities,
  publishedFlows?: PublishedFlow[],
): Promise<Tool[]> {
  const items = publishedFlows || (await fetchPublishedFlows(ctx));
  const runOptionKeys = getRunOptionKeySet(capabilities);
  const tools: Tool[] = [];
  for (const item of items) {
    const name = `flow.${item.slug}`;
    const reservedVariableNames = getReservedDynamicToolParameterNames(item, runOptionKeys);
    const descriptionBase =
      (item.meta && item.meta.tool && item.meta.tool.description) ||
      item.description ||
      'Recorded flow';
    const sideEffects = item.sideEffects?.summary;
    const backgroundSupport =
      item.backgroundSupport?.supported === true
        ? 'Background execution: supported.'
        : item.backgroundSupport?.supported === false
          ? `Background execution: not supported${item.backgroundSupport.caveats?.length ? ` (${item.backgroundSupport.caveats.join('; ')})` : ''}.`
          : '';
    const sideEffectDescription = sideEffects
      ? `Side effects: safe ${sideEffects.safe ?? 0}, idempotent ${sideEffects.idempotent ?? 0}, dangerous ${sideEffects.dangerous ?? 0}, unknown ${sideEffects.unknown ?? 0}.`
      : '';
    const descriptionParts = [descriptionBase, backgroundSupport, sideEffectDescription].filter(Boolean);
    const description =
      reservedVariableNames.length > 0
        ? `${descriptionParts.join(' ')} Reserved dynamic tool parameter names are ignored as flow variables: ${reservedVariableNames.join(', ')}. Use record_replay_flow_run with args for those values.`
        : descriptionParts.join(' ');
    const descriptorSchema = buildDynamicToolParameterSchemaFromDescriptor(item, runOptionKeys);
    const properties: Record<string, any> = descriptorSchema?.properties ?? {};
    const required: string[] = descriptorSchema?.required ?? [];
    if (!descriptorSchema) {
      for (const v of getDynamicToolVariables(item.variables, runOptionKeys)) {
        const variableName = getPublishedVariableName(v);
        if (!variableName) {
          continue;
        }
        const prop = buildVariableSchema(v, variableName);
        if (isPublishedVariableRequired(v)) required.push(variableName);
        properties[variableName] = prop;
      }
    }
    addWorkflowRunOptionProperties(properties, runOptionKeys);
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
    return {
      tools: await listToolsForContext({
        ...ctx,
        clientCapabilities: resolveMcpClientCapabilities(server.getClientCapabilities()),
      }),
    };
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callToolForContext(
      {
        ...ctx,
        clientCapabilities: resolveMcpClientCapabilities(server.getClientCapabilities()),
      },
      request.params.name,
      request.params.arguments || {},
    ),
  );
};

export async function listToolsForContext(ctx: McpToolContext): Promise<Tool[]> {
  const items = await fetchPublishedFlows(ctx);
  const capabilities = getExtensionCapabilitiesForSession(ctx.sessionId);
  const clientCapabilities = getClientCapabilitiesForContext(ctx);
  const tools = [...filterPublicToolsForCapabilities(capabilities)];
  if (supportsWorkflowRun(capabilities)) {
    tools.push(buildWorkflowRunTool(items, capabilities, clientCapabilities));
  }
  if (shouldExposeLegacyDynamicFlowTools() && supportsWorkflowRun(capabilities)) {
    tools.push(...(await listDynamicFlowTools(ctx, capabilities, items)));
  }
  return tools;
}

export const callToolForContext = async (
  ctx: McpToolContext,
  name: string,
  args: any,
): Promise<CallToolResult> => {
  try {
    if (
      !name ||
      (name !== WORKFLOW_RUN_TOOL_NAME && !name.startsWith('flow.') && !PUBLIC_TOOL_NAME_SET.has(name))
    ) {
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

    if (name === WORKFLOW_RUN_TOOL_NAME) {
      try {
        const workflow = args && typeof args.workflow === 'string' ? args.workflow.trim() : '';
        if (!workflow) {
          throw new Error('Missing required workflow slug.');
        }

        const items = await fetchPublishedFlows(ctx, { forceRefresh: true });
        const capabilities = getExtensionCapabilitiesForSession(ctx.sessionId);
        if (!supportsWorkflowRun(capabilities)) {
          throw new Error('workflow_run is not supported by the connected extension capability set.');
        }
        const match = items.find((it) => it.slug === workflow);
        if (!match) {
          const available = items.map((item) => item.slug).join(', ');
          throw new Error(
            available
              ? `Workflow not found: ${workflow}. Available workflows: ${available}`
              : `Workflow not found: ${workflow}`,
          );
        }

        const variables =
          args && args.args && typeof args.args === 'object' && !Array.isArray(args.args)
            ? args.args
            : {};
        const runOptions: Record<string, unknown> = {};
        const runOptionKeys = getRunOptionKeySet(capabilities);
        if (args && typeof args === 'object' && !Array.isArray(args)) {
          for (const key of SESSION_RUN_OPTION_KEYS) {
            if (runOptionKeys.has(key) && Object.prototype.hasOwnProperty.call(args, key)) {
              runOptions[key] = args[key];
            }
          }
        }

        const proxyRes = await ctx.nativeHost.sendRequestToExtensionAndWait(
          {
            name: 'record_replay_flow_run',
            args: {
              flowId: match.id,
              ...(match.revision ? { requireRevision: match.revision } : {}),
              args: variables,
              ...runOptions,
            },
            meta: buildExtensionToolMeta(ctx),
          },
          NativeMessageType.CALL_TOOL,
          120000,
        );
        if (proxyRes.status === 'success') return proxyRes.data;
        return {
          content: [
            {
              type: 'text',
              text: `Error calling workflow_run: ${proxyRes.error}`,
            },
          ],
          isError: true,
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Error resolving workflow_run: ${err?.message || String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }

    // If calling a dynamic flow tool (name starts with flow.), proxy to common flow-run tool
    if (name && name.startsWith('flow.')) {
      // We need to resolve flow by slug to ID
      try {
        const slug = name.slice('flow.'.length);
        const items = await fetchPublishedFlows(ctx, { forceRefresh: true });
        const capabilities = getExtensionCapabilitiesForSession(ctx.sessionId);
        if (!supportsWorkflowRun(capabilities)) {
          throw new Error(`Dynamic flow tools are not supported by the connected extension capability set.`);
        }
        const match = items.find((it) => it.slug === slug);
        if (!match) throw new Error(`Flow not found for tool ${name}`);
        const runOptionKeys = getRunOptionKeySet(capabilities);
        const variableKeys = new Set(
          getDynamicToolVariables(match.variables, runOptionKeys)
            .map((variable) => getPublishedVariableName(variable))
            .filter((key): key is string => typeof key === 'string' && key.length > 0),
        );
        const { variables, runOptions } = splitDynamicFlowArgs(args, variableKeys, runOptionKeys);
        const flowArgs = {
          flowId: match.id,
          ...(match.revision ? { requireRevision: match.revision } : {}),
          args: variables,
          ...runOptions,
        };
        const proxyRes = await ctx.nativeHost.sendRequestToExtensionAndWait(
          {
            name: 'record_replay_flow_run',
            args: flowArgs,
            meta: buildExtensionToolMeta(ctx),
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
    const capabilities = await ensureCapabilitiesForContext(ctx);
    if (!capabilities.supportedTools.includes(name)) {
      return {
        content: [
          {
            type: 'text',
            text: `Error calling tool: Tool not supported by connected extension capability set: ${name}`,
          },
        ],
        isError: true,
      };
    }
    const forwardedArgs =
      name === 'record_replay_flow_run'
        ? filterFlowRunArgsForCapabilities(args, capabilities)
        : args;
    const response = await ctx.nativeHost.sendRequestToExtensionAndWait(
      {
        name,
        args: forwardedArgs,
        meta: buildExtensionToolMeta(ctx),
      },
      NativeMessageType.CALL_TOOL,
      120000, // Extended to 120 seconds to avoid timeout for long tasks such as performance analysis
    );
    if (response.status === 'success') {
      if (
        shouldRefreshWorkflowToolList(name, args) &&
        (response.data === undefined ||
          response.data === null ||
          typeof response.data !== 'object' ||
          isSuccessfulMcpToolResult(response.data))
      ) {
        clearDynamicFlowCacheForSession(ctx.sessionId);
      }
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
