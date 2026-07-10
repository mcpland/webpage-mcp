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
  type WebpageMcpExtensionCapabilities,
  type WebpageMcpWorkflowRunOption,
} from 'webpage-mcp-shared';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { NativeMessagingHost } from '../native-messaging-host';
import { isSuccessfulMcpToolResult, shouldRefreshWorkflowToolList } from './tool-list-change';

export interface McpToolContext {
  sessionId: string;
  instanceId: string;
  nativeHost: NativeMessagingHost;
  signal?: AbortSignal;
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

function sendExtensionRequest(
  ctx: McpToolContext,
  payload: unknown,
  messageType: string,
  timeoutMs: number,
): Promise<any> {
  if (ctx.signal) {
    return ctx.nativeHost.sendRequestToExtensionAndWait(
      payload,
      messageType,
      timeoutMs,
      ctx.signal,
    );
  }
  return ctx.nativeHost.sendRequestToExtensionAndWait(payload, messageType, timeoutMs);
}

function createMcpAbortError(): Error {
  const error = new Error('MCP request cancelled');
  error.name = 'AbortError';
  return error;
}

function isAbortFailure(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(
    signal?.aborted ||
    (error &&
      typeof error === 'object' &&
      'name' in error &&
      (error as { name?: unknown }).name === 'AbortError'),
  );
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createMcpAbortError());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', handleAbort);
      callback();
    };
    const handleAbort = (): void => finish(() => reject(createMcpAbortError()));
    signal.addEventListener('abort', handleAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
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
  revision: string;
  description?: string;
  variables?: PublishedFlowVariable[];
  parameters?: PublishedFlowParameterSchema;
  backgroundSupport?: PublishedFlowBackgroundSupport;
  sideEffects?: PublishedFlowSideEffects;
  meta?: {
    tool?: {
      description?: string;
    };
  };
}

const FLOW_TOOL_CACHE_TTL_MS = 10_000;
const FLOW_TOOL_CACHE_STALE_MS = 5 * 60_000;
export const DYNAMIC_FLOW_LIMITS = Object.freeze({
  maxCachedSessions: 64,
  maxConcurrentHandshakes: 16,
  maxFlows: 64,
  maxExaminedFlows: 512,
  maxCapabilityEntries: 256,
  maxWarnings: 32,
  maxCollectionEntries: 256,
  maxObjectEntries: 256,
  maxExaminedObjectEntries: 512,
  maxDepth: 16,
  maxNodesPerResponse: 8_192,
  maxDescriptorBytesPerResponse: 256 * 1024,
  maxIdentifierBytes: 256,
  maxSlugBytes: 64,
  maxStringBytes: 2 * 1024,
});
const FLOW_TOOL_CACHE_MAX_SESSIONS = DYNAMIC_FLOW_LIMITS.maxCachedSessions;
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
const WORKFLOW_RUN_TOOL_NAME = 'workflow_run';
const EXPOSE_LEGACY_FLOW_TOOLS_ENV = 'WEBPAGE_MCP_EXPOSE_LEGACY_FLOW_TOOLS';
const PUBLIC_TOOL_NAME_SET = new Set<string>(TOOL_SCHEMAS.map((tool) => tool.name));
interface PublishedFlowsInflight {
  startedAt: number;
  promise: Promise<PublishedFlow[]>;
  invalidated: boolean;
  forceRefresh: boolean;
}
const publishedFlowsCache = new Map<string, { fetchedAt: number; items: PublishedFlow[] }>();
const publishedFlowsInflight = new Map<string, PublishedFlowsInflight>();
const extensionCapabilitiesCache = new Map<
  string,
  { fetchedAt: number; capabilities: WebpageMcpExtensionCapabilities }
>();

interface DescriptorBudget {
  nodes: number;
  bytes: number;
}

interface DescriptorSanitizationState {
  complete: boolean;
}

const UNSAFE_DESCRIPTOR_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PUBLISHED_FLOW_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function jsonCharacterBytes(character: string): number {
  if (character === '"' || character === '\\') return 2;
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint <= 0x1f) {
    return ['\b', '\t', '\n', '\f', '\r'].includes(character) ? 2 : 6;
  }
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 6;
  return utf8ByteLength(character);
}

function boundJsonString(
  value: string,
  maximumUtf8Bytes: number,
  maximumJsonBytes = Number.MAX_SAFE_INTEGER,
): { value: string; jsonBytes: number; complete: boolean } {
  let output = '';
  let utf8Bytes = 0;
  let jsonBytes = 2;
  let complete = true;
  for (const character of value) {
    const characterUtf8Bytes = utf8ByteLength(character);
    const characterJsonBytes = jsonCharacterBytes(character);
    if (
      utf8Bytes + characterUtf8Bytes > maximumUtf8Bytes ||
      jsonBytes + characterJsonBytes > maximumJsonBytes
    ) {
      complete = false;
      break;
    }
    output += character;
    utf8Bytes += characterUtf8Bytes;
    jsonBytes += characterJsonBytes;
  }
  return { value: output, jsonBytes, complete };
}

function consumeDescriptorBudget(budget: DescriptorBudget, bytes: number, nodes = 1): boolean {
  if (
    bytes < 0 ||
    nodes < 0 ||
    budget.bytes + bytes > DYNAMIC_FLOW_LIMITS.maxDescriptorBytesPerResponse ||
    budget.nodes + nodes > DYNAMIC_FLOW_LIMITS.maxNodesPerResponse
  ) {
    return false;
  }
  budget.bytes += bytes;
  budget.nodes += nodes;
  return true;
}

function sanitizeDescriptorString(
  value: string,
  budget: DescriptorBudget,
  maximumBytes: number = DYNAMIC_FLOW_LIMITS.maxStringBytes,
  state?: DescriptorSanitizationState,
): string | undefined {
  const remaining = DYNAMIC_FLOW_LIMITS.maxDescriptorBytesPerResponse - budget.bytes;
  const bounded = boundJsonString(value, maximumBytes, remaining);
  if (!bounded.complete && state) state.complete = false;
  if (
    (value.length > 0 && bounded.value.length === 0) ||
    !consumeDescriptorBudget(budget, bounded.jsonBytes)
  ) {
    if (state) state.complete = false;
    return undefined;
  }
  return bounded.value;
}

function sanitizeDescriptorIdentifier(
  value: unknown,
  budget: DescriptorBudget,
  maximumBytes: number = DYNAMIC_FLOW_LIMITS.maxIdentifierBytes,
): string | undefined {
  const normalized = normalizeBoundedIdentifier(value, maximumBytes);
  if (!normalized) return undefined;
  const bounded = boundJsonString(
    normalized,
    maximumBytes,
    DYNAMIC_FLOW_LIMITS.maxDescriptorBytesPerResponse - budget.bytes,
  );
  if (!bounded.complete) return undefined;
  return consumeDescriptorBudget(budget, bounded.jsonBytes) ? normalized : undefined;
}

function normalizeBoundedIdentifier(
  value: unknown,
  maximumBytes: number = DYNAMIC_FLOW_LIMITS.maxIdentifierBytes,
): string | undefined {
  if (typeof value !== 'string' || value.length > maximumBytes) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return boundJsonString(normalized, maximumBytes).complete ? normalized : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeDescriptorValue(
  value: unknown,
  budget: DescriptorBudget,
  depth = 0,
  state?: DescriptorSanitizationState,
): unknown {
  if (value === null) {
    if (consumeDescriptorBudget(budget, 4)) return null;
    if (state) state.complete = false;
    return undefined;
  }
  if (typeof value === 'string') {
    return sanitizeDescriptorString(value, budget, DYNAMIC_FLOW_LIMITS.maxStringBytes, state);
  }
  if (typeof value === 'boolean') {
    if (consumeDescriptorBudget(budget, value ? 4 : 5)) return value;
    if (state) state.complete = false;
    return undefined;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value) && consumeDescriptorBudget(budget, String(value).length)) {
      return value;
    }
    if (state) state.complete = false;
    return undefined;
  }
  if (depth >= DYNAMIC_FLOW_LIMITS.maxDepth) {
    if (state) state.complete = false;
    return undefined;
  }

  if (Array.isArray(value)) {
    if (!consumeDescriptorBudget(budget, 2)) {
      if (state) state.complete = false;
      return undefined;
    }
    if (value.length > DYNAMIC_FLOW_LIMITS.maxCollectionEntries && state) {
      state.complete = false;
    }
    const output: unknown[] = [];
    const length = Math.min(value.length, DYNAMIC_FLOW_LIMITS.maxCollectionEntries);
    for (let index = 0; index < length; index += 1) {
      const item = sanitizeDescriptorValue(value[index], budget, depth + 1, state);
      if (item !== undefined) {
        if (output.length > 0 && !consumeDescriptorBudget(budget, 1, 0)) {
          if (state) state.complete = false;
          break;
        }
        output.push(item);
      }
    }
    return output;
  }

  if (!isPlainRecord(value) || !consumeDescriptorBudget(budget, 2)) {
    if (state) state.complete = false;
    return undefined;
  }
  const output: Record<string, unknown> = {};
  let examined = 0;
  let accepted = 0;
  for (const key in value) {
    if (examined >= DYNAMIC_FLOW_LIMITS.maxExaminedObjectEntries) {
      if (state) state.complete = false;
      break;
    }
    examined += 1;
    if (!Object.prototype.hasOwnProperty.call(value, key) || UNSAFE_DESCRIPTOR_KEYS.has(key)) {
      if (state) state.complete = false;
      continue;
    }
    if (key.length === 0 || key.length > DYNAMIC_FLOW_LIMITS.maxIdentifierBytes) {
      if (state) state.complete = false;
      continue;
    }
    const boundedKey = boundJsonString(key, DYNAMIC_FLOW_LIMITS.maxIdentifierBytes);
    if (!boundedKey.complete) {
      if (state) state.complete = false;
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      if (state) state.complete = false;
      continue;
    }
    if (accepted >= DYNAMIC_FLOW_LIMITS.maxObjectEntries) {
      if (state) state.complete = false;
      break;
    }
    const fieldOverhead = boundedKey.jsonBytes + 1 + (accepted > 0 ? 1 : 0);
    if (!consumeDescriptorBudget(budget, fieldOverhead, 0)) {
      if (state) state.complete = false;
      break;
    }
    const item = sanitizeDescriptorValue(descriptor.value, budget, depth + 1, state);
    if (item === undefined) {
      if (state) state.complete = false;
      continue;
    }
    output[key] = item;
    accepted += 1;
  }
  return output;
}

function sanitizePublishedParameters(
  value: unknown,
  budget: DescriptorBudget,
): PublishedFlowParameterSchema | undefined {
  if (!isPlainRecord(value)) return undefined;
  const trialBudget = { ...budget };
  const state: DescriptorSanitizationState = { complete: true };
  const sanitized = sanitizeDescriptorValue(value, trialBudget, 1, state);
  if (!state.complete || !isPlainRecord(sanitized)) return undefined;
  if (sanitized.type !== 'object' || !isPlainRecord(sanitized.properties)) return undefined;
  if (!Array.isArray(sanitized.required)) return undefined;
  budget.bytes = trialBudget.bytes;
  budget.nodes = trialBudget.nodes;
  return sanitized as unknown as PublishedFlowParameterSchema;
}

function getOwnDataValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function sanitizePublishedVariable(
  value: unknown,
  budget: DescriptorBudget,
  state?: DescriptorSanitizationState,
): PublishedFlowVariable | undefined {
  if (!isPlainRecord(value)) return undefined;
  const name = normalizeBoundedIdentifier(getOwnDataValue(value, 'name'));
  const key = normalizeBoundedIdentifier(getOwnDataValue(value, 'key'));
  if (
    (!name && !key) ||
    (name && UNSAFE_DESCRIPTOR_KEYS.has(name)) ||
    (key && UNSAFE_DESCRIPTOR_KEYS.has(key))
  ) {
    return undefined;
  }

  const whitelisted: Record<string, unknown> = {};
  if (name) whitelisted.name = name;
  if (key) whitelisted.key = key;
  for (const field of ['label', 'description']) {
    const fieldValue = getOwnDataValue(value, field);
    if (typeof fieldValue === 'string') whitelisted[field] = fieldValue;
  }
  for (const field of ['type', 'kind', 'item']) {
    const fieldValue = normalizeBoundedIdentifier(getOwnDataValue(value, field));
    if (fieldValue) whitelisted[field] = fieldValue;
  }
  for (const field of ['sensitive', 'required']) {
    const fieldValue = getOwnDataValue(value, field);
    if (typeof fieldValue === 'boolean') whitelisted[field] = fieldValue;
  }
  for (const field of ['default', 'options']) {
    const fieldValue = getOwnDataValue(value, field);
    if (fieldValue !== undefined) whitelisted[field] = fieldValue;
  }
  const rawRules = getOwnDataValue(value, 'rules');
  if (isPlainRecord(rawRules)) {
    const rules: Record<string, unknown> = {};
    const required = getOwnDataValue(rawRules, 'required');
    const enumValues = getOwnDataValue(rawRules, 'enum');
    if (typeof required === 'boolean') rules.required = required;
    if (Array.isArray(enumValues)) rules.enum = enumValues;
    if (Object.keys(rules).length > 0) whitelisted.rules = rules;
  }

  const sanitized = sanitizeDescriptorValue(whitelisted, budget, 2, state);
  return isPlainRecord(sanitized) ? (sanitized as PublishedFlowVariable) : undefined;
}

function sanitizePublishedVariables(
  value: unknown,
  budget: DescriptorBudget,
): PublishedFlowVariable[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > DYNAMIC_FLOW_LIMITS.maxCollectionEntries) return undefined;
  const trialBudget = { ...budget };
  const state: DescriptorSanitizationState = { complete: true };
  if (!consumeDescriptorBudget(trialBudget, 2)) return undefined;
  const output: PublishedFlowVariable[] = [];
  for (const rawVariable of value) {
    const variable = sanitizePublishedVariable(rawVariable, trialBudget, state);
    if (!variable) {
      state.complete = false;
      break;
    }
    if (output.length > 0 && !consumeDescriptorBudget(trialBudget, 1, 0)) {
      state.complete = false;
      break;
    }
    output.push(variable);
  }
  if (!state.complete) return undefined;
  budget.bytes = trialBudget.bytes;
  budget.nodes = trialBudget.nodes;
  return output;
}

function sanitizePublishedBackgroundSupport(
  value: unknown,
  budget: DescriptorBudget,
): PublishedFlowBackgroundSupport | undefined {
  if (!isPlainRecord(value)) return undefined;
  const whitelisted: Record<string, unknown> = {};
  const supported = getOwnDataValue(value, 'supported');
  if (typeof supported === 'boolean') whitelisted.supported = supported;
  for (const field of ['modes', 'caveats']) {
    const fieldValue = getOwnDataValue(value, field);
    if (Array.isArray(fieldValue)) {
      const strings: string[] = [];
      const length = Math.min(fieldValue.length, DYNAMIC_FLOW_LIMITS.maxCollectionEntries);
      for (let index = 0; index < length; index += 1) {
        if (typeof fieldValue[index] === 'string') strings.push(fieldValue[index]);
      }
      whitelisted[field] = strings;
    }
  }
  const sanitized = sanitizeDescriptorValue(whitelisted, budget, 1);
  return isPlainRecord(sanitized) ? (sanitized as PublishedFlowBackgroundSupport) : undefined;
}

function sanitizePublishedSideEffects(
  value: unknown,
  budget: DescriptorBudget,
): PublishedFlowSideEffects | undefined {
  if (!isPlainRecord(value)) return undefined;
  const rawSummary = getOwnDataValue(value, 'summary');
  if (!isPlainRecord(rawSummary)) return undefined;
  const summary: Record<string, number> = {};
  for (const field of ['safe', 'idempotent', 'dangerous', 'unknown']) {
    const fieldValue = getOwnDataValue(rawSummary, field);
    if (Number.isSafeInteger(fieldValue) && (fieldValue as number) >= 0) {
      summary[field] = fieldValue as number;
    }
  }
  const sanitized = sanitizeDescriptorValue({ summary }, budget, 1);
  return isPlainRecord(sanitized) ? (sanitized as PublishedFlowSideEffects) : undefined;
}

function sanitizePublishedMeta(
  value: unknown,
  budget: DescriptorBudget,
): PublishedFlow['meta'] | undefined {
  if (!isPlainRecord(value)) return undefined;
  const tool = getOwnDataValue(value, 'tool');
  if (!isPlainRecord(tool)) return undefined;
  const description = getOwnDataValue(tool, 'description');
  if (typeof description !== 'string') return undefined;
  const sanitized = sanitizeDescriptorValue({ tool: { description } }, budget, 1);
  return isPlainRecord(sanitized) ? (sanitized as PublishedFlow['meta']) : undefined;
}

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
    [['cancellation'], ['notifications', 'cancelled'], ['experimental', 'cancellation']],
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
  const inflight = publishedFlowsInflight.get(sessionId);
  if (inflight) inflight.invalidated = true;
  publishedFlowsCache.delete(sessionId);
  extensionCapabilitiesCache.delete(sessionId);
}

function pruneDynamicFlowCaches(now = Date.now()): void {
  for (const [sessionId, cache] of publishedFlowsCache.entries()) {
    if (now - cache.fetchedAt > FLOW_TOOL_CACHE_STALE_MS) {
      publishedFlowsCache.delete(sessionId);
    }
  }
  for (const [sessionId, cache] of extensionCapabilitiesCache.entries()) {
    if (now - cache.fetchedAt > FLOW_TOOL_CACHE_STALE_MS) {
      extensionCapabilitiesCache.delete(sessionId);
    }
  }

  const activity = collectDynamicFlowSessionActivity();
  const settledOldestFirst = Array.from(activity.entries())
    .filter(([sessionId]) => !publishedFlowsInflight.has(sessionId))
    .sort((a, b) => a[1] - b[1]);
  while (activity.size > FLOW_TOOL_CACHE_MAX_SESSIONS) {
    const target = settledOldestFirst.shift();
    if (!target) break;
    publishedFlowsCache.delete(target[0]);
    extensionCapabilitiesCache.delete(target[0]);
    activity.delete(target[0]);
  }
}

function collectDynamicFlowSessionActivity(): Map<string, number> {
  const activity = new Map<string, number>();
  const remember = (sessionId: string, timestamp: number): void => {
    activity.set(sessionId, Math.max(activity.get(sessionId) ?? 0, timestamp));
  };
  for (const [sessionId, cache] of publishedFlowsCache) remember(sessionId, cache.fetchedAt);
  for (const [sessionId, cache] of extensionCapabilitiesCache) {
    remember(sessionId, cache.fetchedAt);
  }
  for (const [sessionId, inflight] of publishedFlowsInflight) {
    remember(sessionId, inflight.startedAt);
  }
  return activity;
}

function admitDynamicFlowSession(sessionId: string, now: number): boolean {
  pruneDynamicFlowCaches(now);
  const activity = collectDynamicFlowSessionActivity();
  if (activity.has(sessionId)) return true;
  if (activity.size < FLOW_TOOL_CACHE_MAX_SESSIONS) return true;

  let oldestSettled: { sessionId: string; timestamp: number } | undefined;
  for (const [candidate, timestamp] of activity) {
    if (publishedFlowsInflight.has(candidate)) continue;
    if (!oldestSettled || timestamp < oldestSettled.timestamp) {
      oldestSettled = { sessionId: candidate, timestamp };
    }
  }
  if (!oldestSettled) return false;
  publishedFlowsCache.delete(oldestSettled.sessionId);
  extensionCapabilitiesCache.delete(oldestSettled.sessionId);
  return true;
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
    supportedTools: [],
    supportedRunOptions: [],
    featureFlags: ['capability_handshake_fallback'],
    warnings: [warning],
  };
}

function normalizeStringArray(
  value: unknown,
  options: {
    maximumEntries?: number;
    maximumBytes?: number;
    truncate?: boolean;
  } = {},
): string[] {
  if (!Array.isArray(value)) return [];
  const maximumEntries = options.maximumEntries ?? DYNAMIC_FLOW_LIMITS.maxCapabilityEntries;
  const maximumBytes = options.maximumBytes ?? DYNAMIC_FLOW_LIMITS.maxIdentifierBytes;
  const output: string[] = [];
  const seen = new Set<string>();
  const examined = Math.min(value.length, maximumEntries * 2);
  for (let index = 0; index < examined && output.length < maximumEntries; index += 1) {
    const item = value[index];
    if (typeof item !== 'string' || item.length === 0) continue;
    if (!options.truncate && item.length > maximumBytes) continue;
    const bounded = boundJsonString(item, maximumBytes);
    if ((!options.truncate && !bounded.complete) || !bounded.value || seen.has(bounded.value)) {
      continue;
    }
    seen.add(bounded.value);
    output.push(bounded.value);
  }
  return output;
}

function normalizeCapabilityIdentifier(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length > DYNAMIC_FLOW_LIMITS.maxIdentifierBytes) {
    return fallback;
  }
  const normalized = value.trim();
  const bounded = boundJsonString(normalized, DYNAMIC_FLOW_LIMITS.maxIdentifierBytes);
  return normalized && bounded.complete ? normalized : fallback;
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
  const supportedTools = normalizeStringArray(raw.supportedTools).filter((tool) =>
    PUBLIC_TOOL_NAME_SET.has(tool),
  );
  const warnings = normalizeStringArray(raw.warnings, {
    maximumEntries: DYNAMIC_FLOW_LIMITS.maxWarnings,
    maximumBytes: DYNAMIC_FLOW_LIMITS.maxStringBytes,
    truncate: true,
  });

  return {
    protocolVersion: normalizeCapabilityIdentifier(
      raw.protocolVersion,
      WEBPAGE_MCP_PROTOCOL_VERSION,
    ),
    capabilityVersion: normalizeCapabilityIdentifier(
      raw.capabilityVersion,
      WEBPAGE_MCP_CAPABILITY_VERSION,
    ),
    extensionVersion: normalizeCapabilityIdentifier(raw.extensionVersion, 'unknown'),
    mcpServerVersion: normalizeCapabilityIdentifier(raw.mcpServerVersion, MCP_SERVER_VERSION),
    supportedTools,
    supportedRunOptions,
    featureFlags: normalizeStringArray(raw.featureFlags, {
      maximumEntries: 64,
    }),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(typeof raw.generatedAt === 'string' &&
    raw.generatedAt.length <= DYNAMIC_FLOW_LIMITS.maxIdentifierBytes &&
    boundJsonString(raw.generatedAt, DYNAMIC_FLOW_LIMITS.maxIdentifierBytes).complete
      ? { generatedAt: raw.generatedAt }
      : {}),
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
  return supported;
}

function normalizePublishedFlows(response: any): PublishedFlow[] {
  if (!response || response.status !== 'success' || !Array.isArray(response.items)) {
    return [];
  }

  const candidates: Array<{
    item: Record<string, unknown>;
    id: string;
    slug: string;
    revision: string;
  }> = [];
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();
  const examined = Math.min(response.items.length, DYNAMIC_FLOW_LIMITS.maxExaminedFlows);
  for (
    let index = 0;
    index < examined && candidates.length < DYNAMIC_FLOW_LIMITS.maxFlows;
    index += 1
  ) {
    const item = response.items[index];
    if (!isPlainRecord(item)) continue;
    const id = normalizeBoundedIdentifier(getOwnDataValue(item, 'id'));
    const slug = normalizeBoundedIdentifier(
      getOwnDataValue(item, 'slug'),
      DYNAMIC_FLOW_LIMITS.maxSlugBytes,
    );
    const rawRevision = getOwnDataValue(item, 'revision');
    const revision = normalizeBoundedIdentifier(rawRevision);
    if (
      !id ||
      !slug ||
      !revision ||
      !PUBLISHED_FLOW_SLUG_PATTERN.test(slug) ||
      seenIds.has(id) ||
      seenSlugs.has(slug)
    ) {
      continue;
    }
    seenIds.add(id);
    seenSlugs.add(slug);
    candidates.push({ item, id, slug, revision });
  }

  // Reserve every runnable identity and revision guard before optional schemas
  // can consume the shared response budget.
  const budget: DescriptorBudget = { nodes: 1, bytes: 2 };
  const output: PublishedFlow[] = [];
  for (const candidate of candidates) {
    if (!consumeDescriptorBudget(budget, 128)) break;
    const id = sanitizeDescriptorIdentifier(candidate.id, budget);
    const slug = sanitizeDescriptorIdentifier(
      candidate.slug,
      budget,
      DYNAMIC_FLOW_LIMITS.maxSlugBytes,
    );
    const revision = sanitizeDescriptorIdentifier(candidate.revision, budget);
    if (!id || !slug || !revision) break;
    if (output.length > 0 && !consumeDescriptorBudget(budget, 1, 0)) break;
    output.push({ id, slug, revision });
  }

  for (let index = 0; index < output.length; index += 1) {
    const flow = output[index];
    const item = candidates[index].item;
    const rawDescription = getOwnDataValue(item, 'description');
    if (typeof rawDescription === 'string') {
      const description = sanitizeDescriptorString(rawDescription, budget);
      if (description !== undefined) flow.description = description;
    }

    const parameters = sanitizePublishedParameters(getOwnDataValue(item, 'parameters'), budget);
    if (parameters) flow.parameters = parameters;
    else {
      const variables = sanitizePublishedVariables(getOwnDataValue(item, 'variables'), budget);
      if (variables) flow.variables = variables;
    }
    const backgroundSupport = sanitizePublishedBackgroundSupport(
      getOwnDataValue(item, 'backgroundSupport'),
      budget,
    );
    if (backgroundSupport) flow.backgroundSupport = backgroundSupport;
    const sideEffects = sanitizePublishedSideEffects(getOwnDataValue(item, 'sideEffects'), budget);
    if (sideEffects) flow.sideEffects = sideEffects;
    const meta = sanitizePublishedMeta(getOwnDataValue(item, 'meta'), budget);
    if (meta) flow.meta = meta;
  }
  return output;
}

function getPublishedVariableName(
  variable: PublishedFlowVariable | null | undefined,
): string | undefined {
  if (!variable) {
    return undefined;
  }
  return normalizeBoundedIdentifier(variable.name) ?? normalizeBoundedIdentifier(variable.key);
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
    ? schema.required.filter(
        (name) =>
          typeof name === 'string' && Object.prototype.hasOwnProperty.call(properties, name),
      )
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
  if (variable.item === 'string' || variable.item === 'number' || variable.item === 'boolean') {
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

function buildVariableSchema(
  variable: PublishedFlowVariable,
  variableName: string,
): Record<string, unknown> {
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
  if (ctx.signal?.aborted) {
    throw createMcpAbortError();
  }
  const forceRefresh = options?.forceRefresh === true;
  const now = Date.now();
  pruneDynamicFlowCaches(now);
  const cached = publishedFlowsCache.get(ctx.sessionId);
  if (!forceRefresh && cached && now - cached.fetchedAt < FLOW_TOOL_CACHE_TTL_MS) {
    return cached.items;
  }

  const inflight = publishedFlowsInflight.get(ctx.sessionId);
  if (inflight) {
    if (inflight.invalidated || (forceRefresh && !inflight.forceRefresh)) {
      const refreshed = inflight.promise.then(() =>
        fetchPublishedFlows(ctx, { forceRefresh: true }),
      );
      return waitWithSignal(refreshed, ctx.signal);
    }
    return waitWithSignal(inflight.promise, ctx.signal);
  }
  if (publishedFlowsInflight.size >= DYNAMIC_FLOW_LIMITS.maxConcurrentHandshakes) {
    throw new Error(
      `Dynamic flow handshake capacity reached (${DYNAMIC_FLOW_LIMITS.maxConcurrentHandshakes}); retry shortly`,
    );
  }
  if (!admitDynamicFlowSession(ctx.sessionId, now)) {
    throw new Error('Dynamic flow session capacity reached; retry after another session closes');
  }

  const requestContext = { ...ctx, signal: undefined };
  const requestState: PublishedFlowsInflight = {
    startedAt: now,
    invalidated: false,
    forceRefresh,
    promise: Promise.resolve([]),
  };
  const requestPromise = (async () => {
    const response = await sendExtensionRequest(
      requestContext,
      {
        meta: buildExtensionToolMeta(ctx),
        handshake: {
          protocolVersion: WEBPAGE_MCP_PROTOCOL_VERSION,
          mcpServerVersion: MCP_SERVER_VERSION,
          clientCapabilities: listSupportedClientCapabilities(getClientCapabilitiesForContext(ctx)),
        },
      },
      'rr_list_published_flows',
      20000,
    );
    if (requestState.invalidated) return [];
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
  })().catch((error) => {
    if (requestState.invalidated) return [];
    if (isAbortFailure(error, requestContext.signal)) {
      throw error;
    }
    rememberExtensionCapabilities(
      ctx.sessionId,
      createFallbackExtensionCapabilities(
        'Extension capability handshake failed; using conservative workflow schema.',
      ),
    );
    publishedFlowsCache.set(ctx.sessionId, {
      fetchedAt: Date.now(),
      items: [],
    });
    pruneDynamicFlowCaches();
    return [];
  });

  const trackedRequest = requestPromise.finally(() => {
    if (publishedFlowsInflight.get(ctx.sessionId) === requestState) {
      publishedFlowsInflight.delete(ctx.sessionId);
    }
  });
  requestState.promise = trackedRequest;
  publishedFlowsInflight.set(ctx.sessionId, requestState);
  return waitWithSignal(trackedRequest, ctx.signal);
}

function splitDynamicFlowArgs(
  args: any,
  flowVariableKeys?: ReadonlySet<string>,
  runOptionKeys: ReadonlySet<SessionRunOptionKey> = new Set<SessionRunOptionKey>(),
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
      const description =
        (item.meta && item.meta.tool && item.meta.tool.description) || item.description || '';
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
      description:
        'Run without activating/focusing target tabs or windows where Chrome APIs allow it.',
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
      description:
        'Optional start URL to open before running. Only http:// and https:// URLs are allowed.',
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
  const inputSchema = tool.inputSchema as {
    properties?: Record<string, any>;
    required?: string[];
  };
  const baseProperties = inputSchema?.properties || {};
  const runOptionKeys = getRunOptionKeySet(capabilities);
  const properties: Record<string, any> = {};
  for (const key of ['flowId', 'requireRevision', 'args']) {
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

function filterPublicToolsForCapabilities(capabilities: WebpageMcpExtensionCapabilities): Tool[] {
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
    const descriptionParts = [descriptionBase, backgroundSupport, sideEffectDescription].filter(
      Boolean,
    );
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
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    return {
      tools: await listToolsForContext({
        ...ctx,
        signal: extra.signal,
        clientCapabilities: resolveMcpClientCapabilities(server.getClientCapabilities()),
      }),
    };
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    callToolForContext(
      {
        ...ctx,
        signal: extra.signal,
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
      (name !== WORKFLOW_RUN_TOOL_NAME &&
        !name.startsWith('flow.') &&
        !PUBLIC_TOOL_NAME_SET.has(name))
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
          throw new Error(
            'workflow_run is not supported by the connected extension capability set.',
          );
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

        const proxyRes = await sendExtensionRequest(
          ctx,
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
        if (isAbortFailure(err, ctx.signal)) throw err;
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
          throw new Error(
            `Dynamic flow tools are not supported by the connected extension capability set.`,
          );
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
        const proxyRes = await sendExtensionRequest(
          ctx,
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
          content: [
            {
              type: 'text',
              text: `Error calling dynamic flow tool: ${proxyRes.error}`,
            },
          ],
          isError: true,
        };
      } catch (err: any) {
        if (isAbortFailure(err, ctx.signal)) throw err;
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
    const response = await sendExtensionRequest(
      ctx,
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
    if (isAbortFailure(error, ctx.signal)) throw error;
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
