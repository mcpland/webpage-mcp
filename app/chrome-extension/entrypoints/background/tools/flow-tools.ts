import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import {
  TOOL_NAMES,
  createEmptyWorkflowSideEffectSummary,
  isKnownWorkflowSideEffectKind,
  normalizeWorkflowSideEffectProfile,
  workflowSideEffectAllowsRetry,
  type WorkflowSideEffectProfile,
  type WorkflowSideEffectSummary,
} from 'webpage-mcp-shared';
import type { FlowV3 } from '../record-replay-v3/domain/flow';
import type { RunEvent, RunRecordV3 } from '../record-replay-v3/domain/events';
import type { FlowId, RunId } from '../record-replay-v3/domain/ids';
import type { ArtifactRecord } from '../record-replay-v3/storage/artifacts';
import { RR_ERROR_CODES } from '../record-replay-v3/domain/errors';
import { normalizeVariableDefinitions } from '../record-replay-v3/domain/variables';
import { createStoragePort } from '../record-replay-v3';
import { saveFlowToV3 } from '../record-replay-v3/compat';
import { buildWorkflowToolDescriptor, getPublishedFlowInfo } from '../record-replay-v3/flows/publish';
import {
  containsSensitiveValue,
  getVariableLikeName,
  isSensitiveKeyName,
  isSensitiveVariableLike,
} from '../record-replay-v3/flows/sensitive';
import { findEntryNodeId } from '../record-replay-v3/storage/import/flow-convert';
import { applyFlowParameterSuggestions } from './flow-parameterization';

type FlowHintLevel = 'info' | 'warning';

interface FlowHint {
  level: FlowHintLevel;
  code: string;
  message: string;
  nodeId?: string;
}

interface PublicAnalyzedNode {
  id: FlowV3['nodes'][number]['id'];
  kind: FlowV3['nodes'][number]['kind'];
  name?: FlowV3['nodes'][number]['name'];
  disabled?: FlowV3['nodes'][number]['disabled'];
  sideEffect: WorkflowSideEffectProfile;
}

interface PublicAnalyzedFlow {
  id: FlowV3['id'];
  name: FlowV3['name'];
  description?: FlowV3['description'];
  createdAt: FlowV3['createdAt'];
  updatedAt: FlowV3['updatedAt'];
  entryNodeId: FlowV3['entryNodeId'];
  nodes: PublicAnalyzedNode[];
  edges: FlowV3['edges'];
  variables?: FlowV3['variables'];
  meta?: Pick<
    NonNullable<FlowV3['meta']>,
    'domain' | 'tags' | 'bindings' | 'tool' | 'exposedOutputs'
  >;
}

interface WorkflowDebugNode extends PublicAnalyzedNode {
  policy?: FlowV3['nodes'][number]['policy'];
  config: Record<string, unknown>;
}

interface WorkflowDebugRun {
  id: RunRecordV3['id'];
  status: RunRecordV3['status'];
  createdAt: RunRecordV3['createdAt'];
  updatedAt: RunRecordV3['updatedAt'];
  startedAt?: RunRecordV3['startedAt'];
  finishedAt?: RunRecordV3['finishedAt'];
  tookMs?: RunRecordV3['tookMs'];
  tabId?: RunRecordV3['tabId'];
  currentNodeId?: RunRecordV3['currentNodeId'];
  attempt: RunRecordV3['attempt'];
  maxAttempts: RunRecordV3['maxAttempts'];
  args?: Record<string, unknown>;
  execution?: RunRecordV3['execution'];
  error?: unknown;
  outputs?: unknown;
  events: Array<Record<string, unknown>>;
  artifacts?: WorkflowDebugArtifact[];
}

interface WorkflowDebugArtifact {
  id: string;
  nodeId: string;
  kind: ArtifactRecord['kind'];
  savedAs: string;
  mimeType: ArtifactRecord['mimeType'];
  sizeBytes: number;
  createdAt: number;
  expiresAt: number;
  metadata?: ArtifactRecord['metadata'];
  dataBase64?: string;
  dataBase64Omitted?: 'not_requested' | 'too_large';
}

interface WorkflowRepairRecommendation {
  severity: 'info' | 'warning';
  code: string;
  message: string;
  nodeId?: string;
  autoFix?: 'parameterize_recorded_values' | 'default_stability_policy';
}

interface WorkflowRepairChange {
  code: string;
  message: string;
}

const REDACTED = '<redacted>';
const SENSITIVE_DEBUG_CONFIG_KEYS = new Set([
  'body',
  'data',
  'formdata',
  'headers',
  'payload',
  'postdata',
  'requestbody',
]);
const SCRIPT_CONFIG_KEYS = new Set(['code', 'script', 'jsScript']);
const RETRYABLE_STABILITY_ERROR_CODES = [
  RR_ERROR_CODES.TARGET_NOT_FOUND,
  RR_ERROR_CODES.ELEMENT_NOT_VISIBLE,
  RR_ERROR_CODES.TIMEOUT,
  RR_ERROR_CODES.NAVIGATION_FAILED,
] as const;

type FlowVariable = NonNullable<FlowV3['variables']>[number];

function getNodeSideEffectProfile(node: FlowV3['nodes'][number]): WorkflowSideEffectProfile {
  return normalizeWorkflowSideEffectProfile(node.kind, node.sideEffect);
}

function summarizeWorkflowSideEffects(flow: FlowV3): WorkflowSideEffectSummary {
  const summary = createEmptyWorkflowSideEffectSummary();
  for (const node of Array.isArray(flow.nodes) ? flow.nodes : []) {
    const profile = getNodeSideEffectProfile(node);
    summary[profile.category] += 1;
    if (!isKnownWorkflowSideEffectKind(node.kind)) {
      summary.unknown += 1;
    }
  }
  return summary;
}

function isSafeForFlowDefaultRetry(node: FlowV3['nodes'][number]): boolean {
  return workflowSideEffectAllowsRetry(getNodeSideEffectProfile(node), 'flowDefault');
}

function sideEffectRetryEligibleNodes(flow: FlowV3): FlowV3['nodes'] {
  return (Array.isArray(flow.nodes) ? flow.nodes : []).filter(isSafeForFlowDefaultRetry);
}

function isRetryableStabilityErrorCode(code: string): boolean {
  return (RETRYABLE_STABILITY_ERROR_CODES as readonly string[]).includes(code);
}

function getVariableName(variable: FlowVariable | null | undefined): string | undefined {
  return getVariableLikeName(variable);
}

function isSensitiveVariableDefinition(variable: FlowVariable | null | undefined): boolean {
  return isSensitiveVariableLike(variable);
}

function countFlowNodes(flow: FlowV3): number {
  return Array.isArray(flow.nodes) ? flow.nodes.length : 0;
}

function sanitizeAnalyzedFlow(flow: FlowV3): PublicAnalyzedFlow {
  const visibleVariables = Array.isArray(flow.variables)
    ? flow.variables
        .filter((variable) => !isSensitiveVariableDefinition(variable))
        .map((variable) => ({ ...variable }))
    : undefined;
  const publicMeta =
    flow.meta &&
    (flow.meta.domain ||
      flow.meta.tags ||
      flow.meta.bindings ||
      flow.meta.tool ||
      flow.meta.exposedOutputs)
      ? {
          ...(flow.meta.domain ? { domain: flow.meta.domain } : {}),
          ...(Array.isArray(flow.meta.tags) ? { tags: [...flow.meta.tags] } : {}),
          ...(Array.isArray(flow.meta.bindings)
            ? {
                bindings: flow.meta.bindings.map((binding) => ({ ...binding })),
              }
            : {}),
          ...(flow.meta.tool ? { tool: { ...flow.meta.tool } } : {}),
          ...(Array.isArray(flow.meta.exposedOutputs)
            ? {
                exposedOutputs: flow.meta.exposedOutputs.map((output) => ({ ...output })),
              }
            : {}),
        }
      : undefined;

  return {
    id: flow.id,
    name: flow.name,
    ...(flow.description ? { description: flow.description } : {}),
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    entryNodeId: flow.entryNodeId,
    nodes: Array.isArray(flow.nodes)
      ? flow.nodes.map((node) => ({
          id: node.id,
          kind: node.kind,
          ...(node.name ? { name: node.name } : {}),
          ...(node.disabled === true ? { disabled: true } : {}),
          sideEffect: getNodeSideEffectProfile(node),
        }))
      : [],
    edges: Array.isArray(flow.edges) ? flow.edges.map((edge) => ({ ...edge })) : [],
    ...(visibleVariables !== undefined
      ? {
          variables: visibleVariables.length > 0 ? visibleVariables : undefined,
        }
      : {}),
    ...(publicMeta ? { meta: publicMeta } : {}),
  };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function truncateString(value: string, maxLength = 1000): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...<truncated:${value.length - maxLength}>`;
}

function isVariableReference(value: string): string | null {
  const match = value.trim().match(/^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/);
  return match ? match[1] : null;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return SENSITIVE_DEBUG_CONFIG_KEYS.has(normalized) || isSensitiveKeyName(normalized);
}

function redactUrl(value: string): string {
  const credentialRedacted = value.replace(/^(https?:\/\/)([^/?#@]+)@/i, `$1${REDACTED}@`);
  return credentialRedacted.replace(
    /([?&][^=&]*(?:authorization|auth|bearer|cookie|key|password|secret|session|token)[^=&]*=)[^&#]*/gi,
    `$1${REDACTED}`,
  );
}

function sanitizeDebugValue(
  value: unknown,
  key: string,
  sensitiveVariableNames: ReadonlySet<string>,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    if (key === 'url') {
      return truncateString(redactUrl(value));
    }
    if (SCRIPT_CONFIG_KEYS.has(key)) {
      return `<redacted script:${value.length}>`;
    }
    if (key === 'value') {
      const variableName = isVariableReference(value);
      if (variableName) {
        return sensitiveVariableNames.has(variableName) ? `{${variableName}}` : value;
      }
      return REDACTED;
    }
    if (isSensitiveKey(key) || containsSensitiveValue(value)) {
      return REDACTED;
    }
    return truncateString(value);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeDebugValue(item, key, sensitiveVariableNames));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(childKey)) {
        out[childKey] = REDACTED;
        continue;
      }
      const sanitizeKey = key === 'candidates' && childKey === 'value' ? 'selector' : childKey;
      out[childKey] = sanitizeDebugValue(childValue, sanitizeKey, sensitiveVariableNames);
    }
    return out;
  }

  return value;
}

function sanitizeDebugConfig(
  config: unknown,
  sensitiveVariableNames: ReadonlySet<string>,
): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {};
  }

  return sanitizeDebugValue(config, 'config', sensitiveVariableNames) as Record<string, unknown>;
}

function sanitizeDebugVariables(flow: FlowV3): FlowV3['variables'] {
  if (!Array.isArray(flow.variables)) {
    return undefined;
  }
  const variables = flow.variables.map((variable) => {
    if (isSensitiveVariableDefinition(variable)) {
      const { default: _default, ...rest } = variable;
      return { ...rest, sensitive: true };
    }
    return { ...variable };
  });
  return variables.length > 0 ? variables : undefined;
}

function getSensitiveVariableNames(flow: FlowV3): Set<string> {
  return new Set(
    (flow.variables || [])
      .filter((variable) => isSensitiveVariableDefinition(variable))
      .map((variable) => getVariableName(variable))
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );
}

function sanitizeDebugNodes(flow: FlowV3): WorkflowDebugNode[] {
  const sensitiveVariableNames = getSensitiveVariableNames(flow);
  return (Array.isArray(flow.nodes) ? flow.nodes : []).map((node) => ({
    id: node.id,
    kind: node.kind,
    ...(node.name ? { name: node.name } : {}),
    ...(node.disabled === true ? { disabled: true } : {}),
    sideEffect: getNodeSideEffectProfile(node),
    ...(node.policy ? { policy: node.policy } : {}),
    config: sanitizeDebugConfig(node.config, sensitiveVariableNames),
  }));
}

function sanitizeError(error: unknown, sensitiveVariableNames: ReadonlySet<string>): unknown {
  if (!error || typeof error !== 'object') {
    return error;
  }
  const record = error as Record<string, unknown>;
  return {
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
    ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {}),
    ...(record.data !== undefined
      ? { data: sanitizeDebugValue(record.data, 'data', sensitiveVariableNames) }
      : {}),
    ...(record.cause ? { cause: sanitizeError(record.cause, sensitiveVariableNames) } : {}),
  };
}

function sanitizeRunObject(
  value: unknown,
  sensitiveVariableNames: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      sensitiveVariableNames.has(key) || isSensitiveKey(key)
        ? REDACTED
        : sanitizeDebugValue(item, key, sensitiveVariableNames);
  }
  return out;
}

function sanitizeEvent(event: RunEvent, sensitiveVariableNames: ReadonlySet<string>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    seq: event.seq,
    ts: event.ts,
    type: event.type,
  };

  if ('nodeId' in event && event.nodeId) base.nodeId = event.nodeId;
  if ('attempt' in event) base.attempt = event.attempt;
  if ('tookMs' in event) base.tookMs = event.tookMs;
  if ('decision' in event) base.decision = event.decision;
  if ('level' in event) base.level = event.level;
  if ('message' in event) base.message = truncateString(event.message);
  if ('tabId' in event) base.tabId = event.tabId;
  if ('flowId' in event) base.flowId = event.flowId;
  if ('reason' in event) base.reason = sanitizeDebugValue(event.reason, 'reason', sensitiveVariableNames);
  if ('next' in event) base.next = event.next;
  if ('error' in event) base.error = sanitizeError(event.error, sensitiveVariableNames);
  if (event.type === 'vars.patch') {
    base.patch = event.patch.map((patch) => ({
      op: patch.op,
      name: patch.name,
      ...(patch.value !== undefined ? { value: sensitiveVariableNames.has(patch.name) ? REDACTED : '<set>' } : {}),
    }));
  }
  if (event.type === 'artifact.screenshot') {
    base.savedAs = event.savedAs;
    base.artifactId = event.artifactId;
    if (event.data !== undefined) {
      base.data = `<redacted screenshot:${event.data.length}>`;
    }
  }
  if (event.type === 'log' && event.data !== undefined) {
    base.data = sanitizeDebugValue(event.data, 'data', sensitiveVariableNames);
  }
  if (event.type === 'run.succeeded' && event.outputs !== undefined) {
    base.outputs = sanitizeRunObject(event.outputs, sensitiveVariableNames);
  }

  return base;
}

function shouldIncludeArtifactData(args: any, runId: string): boolean {
  if (args?.includeArtifactData === true) return true;
  if (args?.includeArtifactData === false) return false;
  return runId.length > 0;
}

function sanitizeDebugArtifact(
  artifact: ArtifactRecord,
  includeData: boolean,
  maxArtifactDataBytes: number,
): WorkflowDebugArtifact {
  const safe: WorkflowDebugArtifact = {
    id: artifact.id,
    nodeId: artifact.nodeId,
    kind: artifact.kind,
    savedAs: artifact.filename,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    createdAt: artifact.createdAt,
    expiresAt: artifact.expiresAt,
    ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
  };
  if (!includeData) {
    safe.dataBase64Omitted = 'not_requested';
  } else if (artifact.sizeBytes > maxArtifactDataBytes) {
    safe.dataBase64Omitted = 'too_large';
  } else {
    safe.dataBase64 = artifact.dataBase64;
  }
  return safe;
}

async function resolveFlowForWorkflowTool(args: any): Promise<FlowV3 | null> {
  const storage = createStoragePort();
  const flowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
  if (flowId) {
    return storage.flows.get(flowId as FlowId);
  }

  const workflow = typeof args?.workflow === 'string' ? args.workflow.trim() : '';
  if (!workflow) {
    return null;
  }

  const flows = await storage.flows.list();
  return flows.find((flow) => getPublishedFlowInfo(flow)?.slug === workflow) || null;
}

async function collectDebugRuns(flow: FlowV3, args: any): Promise<WorkflowDebugRun[]> {
  const includeRuns = args?.includeRuns !== false;
  const runId = typeof args?.runId === 'string' ? args.runId.trim() : '';
  if (!includeRuns && !runId) {
    return [];
  }

  const storage = createStoragePort();
  const maxRuns = runId ? 1 : clampNumber(args?.maxRuns, 3, 0, 10);
  const maxEventsPerRun = clampNumber(args?.maxEventsPerRun, 40, 0, 100);
  const includeArtifacts = args?.includeArtifacts !== false;
  const includeArtifactData = shouldIncludeArtifactData(args, runId);
  const maxArtifactDataBytes = clampNumber(
    args?.maxArtifactDataBytes,
    2 * 1024 * 1024,
    0,
    8 * 1024 * 1024,
  );
  const sensitiveVariableNames = getSensitiveVariableNames(flow);
  let runs: RunRecordV3[] = [];

  if (runId) {
    const run = await storage.runs.get(runId as RunId);
    if (run && run.flowId === flow.id) {
      runs = [run];
    }
  } else if (maxRuns > 0) {
    const allRuns = await storage.runs.list();
    runs = allRuns
      .filter((run) => run.flowId === flow.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, maxRuns);
  }

  const debugRuns: WorkflowDebugRun[] = [];
  for (const run of runs) {
    const fromSeq =
      maxEventsPerRun > 0 && typeof run.nextSeq === 'number'
        ? Math.max(0, run.nextSeq - maxEventsPerRun)
        : 0;
    const events =
      maxEventsPerRun > 0
        ? await storage.events.list(run.id, { fromSeq, limit: maxEventsPerRun })
        : [];
    const artifacts = includeArtifacts
      ? (await storage.artifacts.listByRun(run.id)).map((artifact) =>
          sanitizeDebugArtifact(artifact, includeArtifactData, maxArtifactDataBytes),
        )
      : undefined;
    debugRuns.push({
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      ...(run.tookMs !== undefined ? { tookMs: run.tookMs } : {}),
      ...(run.tabId !== undefined ? { tabId: run.tabId } : {}),
      ...(run.currentNodeId !== undefined ? { currentNodeId: run.currentNodeId } : {}),
      attempt: run.attempt,
      maxAttempts: run.maxAttempts,
      ...(run.args ? { args: sanitizeRunObject(run.args, sensitiveVariableNames) } : {}),
      ...(run.execution ? { execution: run.execution } : {}),
      ...(run.error ? { error: sanitizeError(run.error, sensitiveVariableNames) } : {}),
      ...(run.outputs ? { outputs: sanitizeRunObject(run.outputs, sensitiveVariableNames) } : {}),
      events: events.map((event) => sanitizeEvent(event, sensitiveVariableNames)),
      ...(artifacts ? { artifacts } : {}),
    });
  }

  return debugRuns;
}

function collectFlowHints(flow: FlowV3): FlowHint[] {
  const hints: FlowHint[] = [];
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];

  const hasAssert = nodes.some((node) => node.kind === 'assert');
  if (!hasAssert) {
    hints.push({
      level: 'warning',
      code: 'missing_assertion',
      message: 'No assert node found. Consider adding at least one checkpoint.',
    });
  }

  for (const node of nodes) {
    const target = node?.config && typeof node.config === 'object' ? (node.config as any).target : null;
    const selector = target && typeof target.selector === 'string' ? target.selector : '';
    if (selector) {
      if (selector.includes(':nth-of-type(') || selector.startsWith('/')) {
        hints.push({
          level: 'warning',
          code: 'unstable_selector',
          message: 'Selector may be unstable (structural or XPath). Prefer data-* or aria selectors.',
          nodeId: node.id,
        });
      }
    }

    if (node.kind === 'fill') {
      const value = node?.config && (node.config as any).value;
      if (typeof value === 'string' && value.trim() && !/^\{[a-zA-Z_][a-zA-Z0-9_]*\}$/.test(value.trim())) {
        hints.push({
          level: 'info',
          code: 'literal_fill_value',
          message: 'Fill value looks literal. Consider converting it to a variable.',
          nodeId: node.id,
        });
      }
    }
  }

  for (let i = 1; i < nodes.length; i++) {
    const prev = nodes[i - 1];
    const curr = nodes[i];
    if (!prev || !curr) continue;
    const prevSel = (prev.config as any)?.target?.selector || '';
    const currSel = (curr.config as any)?.target?.selector || '';
    if (prev.kind === curr.kind && prevSel && currSel && prevSel === currSel) {
      hints.push({
        level: 'info',
        code: 'possible_redundant_step',
        message: 'Consecutive steps operate on the same selector. Check for redundancy.',
        nodeId: curr.id,
      });
    }
  }

  return hints;
}

function hasRecordingParameterSuggestions(flow: FlowV3): boolean {
  return getActionableRecordingParameterSuggestions(flow).length > 0;
}

function getExistingVariableNames(flow: FlowV3): Set<string> {
  return new Set(
    (flow.variables || [])
      .map((variable) => getVariableName(variable))
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );
}

function isValidRepairVariableKey(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
}

function getActionableRecordingParameterSuggestions(flow: FlowV3): Array<{ suggestedKey: string }> {
  const suggestions = flow.meta?.recording?.parameterSuggestions;
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return [];
  }

  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const existingVariables = getExistingVariableNames(flow);
  const actionable: Array<{ suggestedKey: string }> = [];

  for (const suggestion of suggestions) {
    const nodeId = typeof suggestion?.nodeId === 'string' ? suggestion.nodeId.trim() : '';
    const kind = suggestion?.kind;
    const suggestedKey =
      typeof suggestion?.suggestedKey === 'string' ? suggestion.suggestedKey.trim() : '';
    const currentValue = typeof suggestion?.currentValue === 'string' ? suggestion.currentValue : '';
    if (!nodeId || (kind !== 'fill' && kind !== 'navigate') || !isValidRepairVariableKey(suggestedKey)) {
      continue;
    }

    const node = nodes.find((candidate) => candidate?.id === nodeId);
    if (!node || !node.config || typeof node.config !== 'object') {
      continue;
    }

    const placeholder = `{${suggestedKey}}`;
    const hasVariable = existingVariables.has(suggestedKey);

    if (kind === 'fill') {
      const value = (node.config as { value?: unknown }).value;
      if (typeof value === 'string' && value === placeholder && !hasVariable) {
        actionable.push({ suggestedKey });
      } else if (typeof value === 'string' && value !== placeholder && value === currentValue) {
        actionable.push({ suggestedKey });
      }
      continue;
    }

    const url = (node.config as { url?: unknown }).url;
    if (typeof url === 'string' && url.includes(placeholder) && !hasVariable) {
      actionable.push({ suggestedKey });
    } else if (typeof url === 'string' && currentValue && url.includes(currentValue)) {
      actionable.push({ suggestedKey });
    }
  }

  return actionable;
}

function getSanitizedErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}

function buildRuntimeFailureRecommendations(
  runs: WorkflowDebugRun[],
): WorkflowRepairRecommendation[] {
  const recommendations: WorkflowRepairRecommendation[] = [];
  const retryableErrorCodes = new Set<string>();
  const failedNodeIds = new Map<string, number>();

  for (const run of runs) {
    const runErrorCode = getSanitizedErrorCode(run.error);
    if (runErrorCode && isRetryableStabilityErrorCode(runErrorCode)) {
      retryableErrorCodes.add(runErrorCode);
    }
    if (typeof run.currentNodeId === 'string' && run.status === 'failed') {
      failedNodeIds.set(run.currentNodeId, (failedNodeIds.get(run.currentNodeId) || 0) + 1);
    }
    for (const event of run.events) {
      const eventErrorCode = getSanitizedErrorCode(event.error);
      if (eventErrorCode && isRetryableStabilityErrorCode(eventErrorCode)) {
        retryableErrorCodes.add(eventErrorCode);
      }
      if (event.type === 'node.failed' && typeof event.nodeId === 'string') {
        failedNodeIds.set(event.nodeId, (failedNodeIds.get(event.nodeId) || 0) + 1);
      }
    }
  }

  if (retryableErrorCodes.size > 0) {
    recommendations.push({
      severity: 'warning',
      code: 'runtime_flake_retryable_errors',
      message: `Recent runs failed with retryable browser instability codes: ${Array.from(retryableErrorCodes).join(', ')}.`,
      autoFix: 'default_stability_policy',
    });
  }

  const hotNode = Array.from(failedNodeIds.entries()).sort((a, b) => b[1] - a[1])[0];
  if (hotNode) {
    recommendations.push({
      severity: 'warning',
      code: 'runtime_failure_hotspot',
      message: `Recent run failures cluster on node ${hotNode[0]}. Inspect its selector, wait condition, or navigation assumptions.`,
      nodeId: hotNode[0],
    });
  }

  return recommendations;
}

function safeRetryNodesMissingPolicy(flow: FlowV3): FlowV3['nodes'] {
  return sideEffectRetryEligibleNodes(flow).filter((node) => !node.policy?.retry);
}

function flowDefaultRetryTouchesSideEffects(flow: FlowV3): boolean {
  if (!flow.policy?.defaultNodePolicy?.retry) return false;
  return (Array.isArray(flow.nodes) ? flow.nodes : []).some((node) => !isSafeForFlowDefaultRetry(node));
}

function buildRepairRecommendations(
  flow: FlowV3,
  hints: FlowHint[],
  runs: WorkflowDebugRun[],
): WorkflowRepairRecommendation[] {
  const recommendations: WorkflowRepairRecommendation[] = [];
  const defaultNodePolicy = flow.policy?.defaultNodePolicy;
  const missingSafeRetryNodes = safeRetryNodesMissingPolicy(flow);

  if (missingSafeRetryNodes.length > 0) {
    recommendations.push({
      severity: 'warning',
      code: 'missing_default_retry_policy',
      message:
        `No side-effect-scoped retry policy is configured for ${missingSafeRetryNodes.length} safe query/read node(s). A single retry helps absorb transient lookup, wait, assertion, screenshot, and read failures without repeating dangerous side effects.`,
      autoFix: 'default_stability_policy',
    });
  }

  if (flowDefaultRetryTouchesSideEffects(flow)) {
    recommendations.push({
      severity: 'warning',
      code: 'global_retry_policy_has_side_effect_risk',
      message:
        'The workflow has a flow-level default retry policy. Repair will scope retry to safe query/read nodes so clicks, scripts, HTTP requests, and other side-effecting nodes are not retried automatically.',
      autoFix: 'default_stability_policy',
    });
  }

  if (!defaultNodePolicy?.timeout) {
    recommendations.push({
      severity: 'warning',
      code: 'missing_default_timeout_policy',
      message:
        'No default node timeout is configured. A bounded attempt timeout makes failures more predictable.',
      autoFix: 'default_stability_policy',
    });
  }

  if (
    defaultNodePolicy?.artifacts?.screenshot !== 'onFailure' &&
    defaultNodePolicy?.artifacts?.screenshot !== 'always'
  ) {
    recommendations.push({
      severity: 'info',
      code: 'missing_failure_screenshot_policy',
      message:
        'Failure screenshots are not enabled by default. Capturing screenshots on failure improves future diagnosis.',
      autoFix: 'default_stability_policy',
    });
  }

  if (hasRecordingParameterSuggestions(flow)) {
    recommendations.push({
      severity: 'info',
      code: 'recorded_parameter_suggestions_available',
      message:
        'Recording metadata contains parameter suggestions. Applying them reduces hard-coded replay inputs.',
      autoFix: 'parameterize_recorded_values',
    });
  }

  for (const hint of hints) {
    if (hint.code === 'unstable_selector') {
      recommendations.push({
        severity: 'warning',
        code: 'selector_needs_human_or_ai_repair',
        message:
          'A selector appears structural or XPath-based. Use workflow_debug_view plus flow_update to replace it with a stable data, aria, role, or text selector.',
        ...(hint.nodeId ? { nodeId: hint.nodeId } : {}),
      });
    } else if (hint.code === 'missing_assertion') {
      recommendations.push({
        severity: 'warning',
        code: 'missing_assertion_checkpoint',
        message:
          'The workflow has no assertion checkpoint. Add an assert node after the critical outcome so partial success is detectable.',
      });
    } else if (hint.code === 'literal_fill_value') {
      recommendations.push({
        severity: 'info',
        code: 'literal_input_value',
        message:
          'A fill node still uses a literal value. Parameterize it when this workflow should be reused across accounts or datasets.',
        ...(hint.nodeId ? { nodeId: hint.nodeId } : {}),
        ...(hasRecordingParameterSuggestions(flow) ? { autoFix: 'parameterize_recorded_values' as const } : {}),
      });
    } else if (hint.code === 'possible_redundant_step') {
      recommendations.push({
        severity: 'info',
        code: 'possible_redundant_step',
        message:
          'Consecutive steps operate on the same selector. Remove duplicates if they are recording noise.',
        ...(hint.nodeId ? { nodeId: hint.nodeId } : {}),
      });
    }
  }

  return [...recommendations, ...buildRuntimeFailureRecommendations(runs)];
}

function applyDefaultStabilityPolicy(flow: FlowV3): WorkflowRepairChange[] {
  const changes: WorkflowRepairChange[] = [];
  const policy = flow.policy ?? {};
  const defaultNodePolicy = policy.defaultNodePolicy ?? {};
  const nextDefaultNodePolicy = { ...defaultNodePolicy };
  const retryTemplate = nextDefaultNodePolicy.retry ?? {
    retries: 1,
    intervalMs: 500,
    backoff: 'linear' as const,
    maxIntervalMs: 2_000,
    jitter: 'full' as const,
    retryOn: RETRYABLE_STABILITY_ERROR_CODES,
  };

  if (!nextDefaultNodePolicy.timeout) {
    nextDefaultNodePolicy.timeout = { ms: 15_000, scope: 'attempt' };
    changes.push({
      code: 'default_timeout_added',
      message: 'Added default node attempt timeout of 15000ms.',
    });
  }

  if (nextDefaultNodePolicy.retry) {
    delete nextDefaultNodePolicy.retry;
    changes.push({
      code: 'global_retry_scoped_to_safe_nodes',
      message:
        'Removed flow-level default retry so side-effecting nodes are not retried automatically.',
    });
  }

  const safeNodesMissingRetry = safeRetryNodesMissingPolicy(flow);
  for (const node of safeNodesMissingRetry) {
    node.policy = {
      ...(node.policy ?? {}),
      retry: { ...retryTemplate },
    };
  }
  if (safeNodesMissingRetry.length > 0) {
    changes.push({
      code: 'default_retry_added',
      message: `Added one retry to ${safeNodesMissingRetry.length} safe query/read node(s).`,
    });
  }

  const artifacts = nextDefaultNodePolicy.artifacts ?? {};
  if (artifacts.screenshot !== 'onFailure' && artifacts.screenshot !== 'always') {
    nextDefaultNodePolicy.artifacts = {
      ...artifacts,
      screenshot: 'onFailure',
    };
    changes.push({
      code: 'failure_screenshot_added',
      message: 'Enabled screenshot capture on node failure.',
    });
  }

  if (changes.length > 0) {
    flow.policy = {
      ...policy,
      defaultNodePolicy: nextDefaultNodePolicy,
    };
  }

  return changes;
}

class FlowAnalyzeTool {
  name = TOOL_NAMES.RECORD_REPLAY.FLOW_ANALYZE;

  async execute(args: any): Promise<ToolResult> {
    const flowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    if (!flowId) return createErrorResponse('flowId is required');

    const flow = await createStoragePort().flows.get(flowId as FlowV3['id']);
    if (!flow) return createErrorResponse(`Flow not found: ${flowId}`);

    const hints = collectFlowHints(flow);
    const sanitizedFlow = sanitizeAnalyzedFlow(flow);
    const descriptor = buildWorkflowToolDescriptor(flow);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            summary: {
              flowId: flow.id,
              name: flow.name,
              nodeCount: countFlowNodes(flow),
              edgeCount: Array.isArray(flow.edges) ? flow.edges.length : 0,
              variableCount: Array.isArray(sanitizedFlow.variables)
                ? sanitizedFlow.variables.length
                : 0,
              hintCount: hints.length,
              sideEffects: descriptor.sideEffects.summary,
            },
            hints,
            descriptor,
            flow: sanitizedFlow,
          }),
        },
      ],
      isError: false,
    };
  }
}

class WorkflowDescribeTool {
  name = TOOL_NAMES.RECORD_REPLAY.WORKFLOW_DESCRIBE;

  async execute(args: any): Promise<ToolResult> {
    const requestedFlowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    const requestedWorkflow = typeof args?.workflow === 'string' ? args.workflow.trim() : '';
    if (!requestedFlowId && !requestedWorkflow) {
      return createErrorResponse('flowId or workflow is required');
    }

    const flow = await resolveFlowForWorkflowTool(args);
    if (!flow) {
      return createErrorResponse(
        requestedFlowId
          ? `Flow not found: ${requestedFlowId}`
          : `Published workflow not found: ${requestedWorkflow}`,
      );
    }

    const publishedInfo = getPublishedFlowInfo(flow);
    const descriptor = buildWorkflowToolDescriptor(flow);
    const hints = collectFlowHints(flow);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            flowId: flow.id,
            workflow: publishedInfo?.slug,
            name: flow.name,
            description: publishedInfo?.description ?? flow.description,
            category: publishedInfo?.category,
            runTool: TOOL_NAMES.RECORD_REPLAY.FLOW_RUN,
            runArgs: {
              flowId: flow.id,
              args: descriptor.exampleArgs,
              tabTarget: 'current',
              ...(descriptor.backgroundSupport.supported ? { background: true } : {}),
            },
            descriptor,
            hints,
          }),
        },
      ],
      isError: false,
    };
  }
}

class WorkflowDebugViewTool {
  name = TOOL_NAMES.RECORD_REPLAY.WORKFLOW_DEBUG_VIEW;

  async execute(args: any): Promise<ToolResult> {
    const requestedFlowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    const requestedWorkflow = typeof args?.workflow === 'string' ? args.workflow.trim() : '';
    if (!requestedFlowId && !requestedWorkflow) {
      return createErrorResponse('flowId or workflow is required');
    }

    const flow = await resolveFlowForWorkflowTool(args);
    if (!flow) {
      return createErrorResponse(
        requestedFlowId
          ? `Flow not found: ${requestedFlowId}`
          : `Published workflow not found: ${requestedWorkflow}`,
      );
    }

    const publishedInfo = getPublishedFlowInfo(flow);
    const hints = collectFlowHints(flow);
    const runs = await collectDebugRuns(flow, args);
    const descriptor = buildWorkflowToolDescriptor(flow);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            summary: {
              flowId: flow.id,
              workflow: publishedInfo?.slug,
              name: flow.name,
              nodeCount: countFlowNodes(flow),
              edgeCount: Array.isArray(flow.edges) ? flow.edges.length : 0,
              variableCount: Array.isArray(flow.variables) ? flow.variables.length : 0,
              hintCount: hints.length,
              runCount: runs.length,
              sideEffects: descriptor.sideEffects.summary,
            },
            hints,
            descriptor,
            workflow: {
              id: flow.id,
              slug: publishedInfo?.slug,
              name: flow.name,
              description: flow.description,
              entryNodeId: flow.entryNodeId,
              nodes: sanitizeDebugNodes(flow),
              edges: Array.isArray(flow.edges) ? flow.edges.map((edge) => ({ ...edge })) : [],
              variables: sanitizeDebugVariables(flow),
              policy: flow.policy,
              meta: sanitizeAnalyzedFlow(flow).meta,
            },
            runs,
          }),
        },
      ],
      isError: false,
    };
  }
}

class WorkflowRepairTool {
  name = TOOL_NAMES.RECORD_REPLAY.WORKFLOW_REPAIR;

  async execute(args: any): Promise<ToolResult> {
    const requestedFlowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    const requestedWorkflow = typeof args?.workflow === 'string' ? args.workflow.trim() : '';
    if (!requestedFlowId && !requestedWorkflow) {
      return createErrorResponse('flowId or workflow is required');
    }

    const flow = await resolveFlowForWorkflowTool(args);
    if (!flow) {
      return createErrorResponse(
        requestedFlowId
          ? `Flow not found: ${requestedFlowId}`
          : `Published workflow not found: ${requestedWorkflow}`,
      );
    }

    const publishedInfo = getPublishedFlowInfo(flow);
    const initialHints = collectFlowHints(flow);
    const runs = await collectDebugRuns(flow, args);
    const recommendationsBeforeApply = buildRepairRecommendations(flow, initialHints, runs);
    const shouldApply = args?.apply === true && args?.dryRun !== true;
    const changes: WorkflowRepairChange[] = [];
    let parameterization: ReturnType<typeof applyFlowParameterSuggestions> | undefined;

    if (shouldApply && args?.applyParameterSuggestions !== false && hasRecordingParameterSuggestions(flow)) {
      parameterization = applyFlowParameterSuggestions(flow);
      if (parameterization.changed) {
        changes.push({
          code: 'parameter_suggestions_applied',
          message: `Applied ${parameterization.applied} recorded parameter suggestion(s).`,
        });
      }
    }

    if (shouldApply && args?.applyDefaultStabilityPolicy !== false) {
      changes.push(...applyDefaultStabilityPolicy(flow));
    }

    const updated = shouldApply && changes.length > 0;
    if (updated) {
      flow.updatedAt = new Date().toISOString();
      await saveFlowToV3(flow);
    }

    const finalHints = shouldApply ? collectFlowHints(flow) : initialHints;
    const recommendations = shouldApply
      ? buildRepairRecommendations(flow, finalHints, runs)
      : recommendationsBeforeApply;
    const plannedAutoFixes = recommendations
      .filter((recommendation) => recommendation.autoFix)
      .map((recommendation) => recommendation.autoFix);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            flowId: flow.id,
            workflow: publishedInfo?.slug,
            applied: shouldApply,
            dryRun: args?.dryRun === true,
            updated,
            summary: {
              nodeCount: countFlowNodes(flow),
              edgeCount: Array.isArray(flow.edges) ? flow.edges.length : 0,
              variableCount: Array.isArray(flow.variables) ? flow.variables.length : 0,
              hintCount: finalHints.length,
              inspectedRunCount: runs.length,
              recommendationCount: recommendations.length,
            },
            recommendations,
            plannedAutoFixes,
            ...(shouldApply
              ? {
                  recommendationsBeforeApply,
                  plannedAutoFixesBeforeApply: recommendationsBeforeApply
                    .filter((recommendation) => recommendation.autoFix)
                    .map((recommendation) => recommendation.autoFix),
                }
              : {}),
            changes,
            ...(parameterization ? { parameterization } : {}),
          }),
        },
      ],
      isError: false,
    };
  }
}

class FlowUpdateTool {
  name = TOOL_NAMES.RECORD_REPLAY.FLOW_UPDATE;

  async execute(args: any): Promise<ToolResult> {
    const flowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    if (!flowId) return createErrorResponse('flowId is required');

    const flow = await createStoragePort().flows.get(flowId as FlowV3['id']);
    if (!flow) return createErrorResponse(`Flow not found: ${flowId}`);

    let changed = false;

    if (typeof args?.name === 'string') {
      const nextName = args.name.trim();
      if (nextName && nextName !== flow.name) {
        flow.name = nextName;
        changed = true;
      }
    }
    if (typeof args?.description === 'string') {
      const nextDescription = args.description.trim();
      const normalized = nextDescription || undefined;
      if (normalized !== flow.description) {
        flow.description = normalized;
        changed = true;
      }
    }
    if (Array.isArray(args?.nodes)) {
      flow.nodes = args.nodes;
      changed = true;
    }
    if (Array.isArray(args?.edges)) {
      flow.edges = args.edges;
      changed = true;
    }
    if (args && Object.prototype.hasOwnProperty.call(args, 'variables')) {
      try {
        flow.variables = normalizeVariableDefinitions(args.variables, 'variables');
      } catch (error) {
        return createErrorResponse(error instanceof Error ? error.message : String(error));
      }
      changed = true;
    }
    const applyParameterSuggestions = args?.applyParameterSuggestions === true;
    let parameterization: ReturnType<typeof applyFlowParameterSuggestions> | undefined;
    if (applyParameterSuggestions) {
      parameterization = applyFlowParameterSuggestions(flow);
      if (parameterization.changed) {
        changed = true;
      }
    }

    if (!changed) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              updated: false,
              flowId,
              ...(parameterization ? { parameterization } : {}),
            }),
          },
        ],
        isError: false,
      };
    }

    if (Array.isArray(args?.nodes) || Array.isArray(args?.edges)) {
      const entry = findEntryNodeId(flow.nodes, flow.edges);
      if (!entry.nodeId) {
        return createErrorResponse('Could not determine a valid entry node for the updated flow');
      }
      flow.entryNodeId = entry.nodeId;
    }

    flow.updatedAt = new Date().toISOString();
    await saveFlowToV3(flow);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            updated: true,
            flow: {
              id: flow.id,
              name: flow.name,
              description: flow.description,
              nodeCount: countFlowNodes(flow),
              edgeCount: Array.isArray(flow.edges) ? flow.edges.length : 0,
              variableCount: Array.isArray(flow.variables) ? flow.variables.length : 0,
            },
            ...(parameterization ? { parameterization } : {}),
          }),
        },
      ],
      isError: false,
    };
  }
}

export const flowAnalyzeTool = new FlowAnalyzeTool();
export const flowUpdateTool = new FlowUpdateTool();
export const workflowDescribeTool = new WorkflowDescribeTool();
export const workflowDebugViewTool = new WorkflowDebugViewTool();
export const workflowRepairTool = new WorkflowRepairTool();
