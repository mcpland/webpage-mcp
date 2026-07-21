import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import {
  TOOL_NAMES,
  WEBPAGE_MCP_CAPABILITY_VERSION,
  WEBPAGE_MCP_PROTOCOL_VERSION,
  type WorkflowSideEffectProfile,
} from 'webpage-mcp-shared';
import {
  FLOW_DSL_VERSION,
  FLOW_NODE_SEMANTICS_VERSION,
  FLOW_SCHEMA_VERSION,
  type FlowRepairHistoryEntry,
  type FlowQualityMeta,
  type FlowV3,
} from '../record-replay-v3/domain/flow';
import type { JsonObject } from '../record-replay-v3/domain/json';
import type { RunEvent, RunRecordV3 } from '../record-replay-v3/domain/events';
import type { FlowId, NodeId, RunId } from '../record-replay-v3/domain/ids';
import type {
  ArtifactMetadataRecord,
  ArtifactRecord,
} from '../record-replay-v3/storage/artifacts';
import {
  RR_ERROR_CODES,
  createResourceLimitExceededError,
  isResourceLimitError,
} from '../record-replay-v3/domain/errors';
import { normalizeVariableDefinitions } from '../record-replay-v3/domain/variables';
import { createStoragePort } from '../record-replay-v3';
import { enqueueRunAndWait, saveFlowToV3 } from '../record-replay-v3/compat';
import {
  FlowWriteConflictError,
  withFlowWriteLock,
} from '../record-replay-v3/flows/write-lock';
import {
  appendWorkflowAuditEvent,
  buildWorkflowQualitySummary,
  buildWorkflowToolDescriptor,
  calculateWorkflowRevision,
  getPublishedFlowInfo,
} from '../record-replay-v3/flows/publish';
import { markScheduledRevalidationCatchUp } from '../record-replay-v3/flows/revalidation';
import {
  containsSensitiveValue,
  getVariableLikeName,
  isSensitiveKeyName,
  isSensitiveVariableLike,
} from '../record-replay-v3/flows/sensitive';
import { findEntryNodeId } from '../record-replay-v3/storage/import/flow-convert';
import { applyFlowParameterSuggestions } from './flow-parameterization';
import {
  getStabilizeSafetyBoundary,
  hasStabilizeUrlBoundary,
  isAllowedPublicStartUrl,
  normalizeBoundaryStrings,
  validateUrlAgainstStabilizeBoundary,
  type WorkflowStabilizeValidationError,
} from './flow-safety-boundary';
import {
  applyWorkflowMigration,
  applyWorkflowMigrationRollback,
  buildWorkflowMigrationPlan,
  createWorkflowMigrationId,
  getMigrationRollbackSnapshot,
  workflowRuntimeRequiresMigration,
} from './flow-runtime-migration';
import {
  WorkflowApprovalStoreTool,
  getApprovalIdReference,
  resolveTrustedWorkflowApproval,
} from './flow-approval-store';
import { redactWorkflowUrl as redactUrl } from './flow-redaction';
import {
  buildWorkflowSegmentPlan,
  classifyWorkflowRisk,
  collectRuntimeSideEffectEvidence,
  getDisabledWorkflowNodeIds,
  getNodeSideEffectProfile,
  getNodeWorkflowRisk,
  getPublicNodeExecutionMetadata,
  hasSegmentBoundary,
  isBoundaryStoppedStatus,
  maxWorkflowRisk,
  mergeWorkflowSideEffectSummaries,
  riskRank,
  summarizeWorkflowSideEffects,
  type RuntimeSideEffectEvidence,
  type WorkflowRiskProfile,
  type WorkflowSegmentPlan,
} from './flow-risk-analysis';
import { WorkflowReleaseReadinessTool } from './flow-release-readiness';
import {
  applyDefaultStabilityPolicy,
  flowDefaultRetryTouchesSideEffects,
  isRetryableStabilityErrorCode,
  safeRetryNodesMissingPolicy,
} from './flow-retry-policy';
import type {
  AssertionRepairSuggestion,
  SelectorQualityDiagnostic,
  SelectorRepairPlan,
  WaitRepairPlan,
  WorkflowRepairChange,
  WorkflowRepairRecommendation,
  WorkflowWaitConditionPatch,
} from './flow-repair-types';
import {
  applySelectorRepairPlans,
  buildNodeSelectorQualityDiagnostic,
  buildSelectorQualityDiagnostic,
  buildSelectorDiagnostics,
  buildSelectorRepairRecommendations,
  getEventErrorCode,
  getEventNodeId,
  getNodeTarget,
  getPrimarySelectorFromTarget,
  planSelectorRepairs,
} from './flow-selector-repair';

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
  executable?: boolean;
  sideEffect?: WorkflowSideEffectProfile;
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
    'domain' | 'tags' | 'bindings' | 'tool' | 'exposedOutputs' | 'quality' | 'audit'
  >;
}

interface WorkflowDebugNode extends PublicAnalyzedNode {
  policy?: FlowV3['nodes'][number]['policy'];
  config: Record<string, unknown>;
  selectorQuality?: SelectorQualityDiagnostic;
}

interface ToolExecutionContext {
  meta?: {
    mcpSessionId?: string;
    instanceId?: string;
    source?: 'mcp' | 'ui';
    clientCapabilities?:
      | string[]
      | {
          toolListChanged?: boolean;
          resourceReferences?: boolean;
          cancellation?: boolean;
          structuredErrors?: boolean;
          largeResults?: boolean;
          source?: string;
          warnings?: string[];
        };
  };
}

interface NormalizedMcpClientCapabilities {
  mcp: boolean;
  source: string;
  toolListChanged: boolean;
  resourceReferences: boolean;
  cancellation: boolean;
  structuredErrors: boolean;
  largeResults: boolean;
  supported: string[];
  warnings: string[];
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
  savedAs?: string;
  mimeType?: ArtifactRecord['mimeType'];
  sizeBytes?: number;
  originalSizeBytes?: number;
  createdAt?: number;
  expiresAt?: number;
  ttlMs?: number;
  truncated?: boolean;
  missing?: boolean;
  unavailableReason?: 'expired_or_cleaned';
  untrusted: true;
  provenance: NonNullable<ArtifactRecord['provenance']>;
  redaction: NonNullable<ArtifactRecord['redaction']>;
  metadata?: ArtifactRecord['metadata'];
  dataBase64?: string;
  dataBase64Omitted?:
    | 'not_requested'
    | 'too_large'
    | 'redaction_low_confidence'
    | 'truncated'
    | 'artifact_missing';
}

type DebugArtifactRecord = ArtifactMetadataRecord & {
  dataBase64?: string;
};

type WorkflowStabilizeRunPhase = 'baseline' | 'postRepair' | 'reset';

interface WorkflowStabilizeRunSummary {
  phase: WorkflowStabilizeRunPhase;
  iteration: number;
  runId?: string;
  status: string;
  success: boolean;
  verifiedAssertionNodeIds?: string[];
  currentNodeId?: string;
  failedNodeId?: string;
  errorCode?: string;
  errorCategory?: string;
  errorMessage?: string;
  tookMs?: number;
  revision: string;
  debugArgs?: Record<string, unknown>;
}

interface WorkflowStabilizeValidationRuns {
  targetRuns: WorkflowStabilizeRunSummary[];
  resetRuns: WorkflowStabilizeRunSummary[];
  targetDebugRuns: WorkflowDebugRun[];
}

interface WorkflowResetPlan {
  flow: FlowV3;
  workflow?: string;
  args?: Record<string, unknown>;
  maxRuns: number;
  requireStable: boolean;
  revision: string;
  risk: WorkflowRiskProfile;
  quality: ReturnType<typeof buildWorkflowQualitySummary>;
}

interface WorkflowResetValidation {
  requested: boolean;
  plan?: WorkflowResetPlan;
  blockedReason?: string;
  errors: WorkflowStabilizeValidationError[];
}

interface WorkflowStabilizeScore {
  passRate: number;
  passedRuns: number;
  failedRuns: number;
  iterations: number;
}

interface WorkflowStabilizeWarning {
  code: string;
  category: 'validation' | 'safety' | 'capability' | 'resource';
  message: string;
  path?: string;
  nodeId?: string;
}

type WorkflowCapabilityStatus = 'full' | 'partial' | 'none' | 'unknown';

interface WorkflowCapabilityMatrix {
  replayValidation: WorkflowCapabilityStatus;
  domSnapshot: WorkflowCapabilityStatus;
  accessibilitySnapshot: WorkflowCapabilityStatus;
  navigationEvents: WorkflowCapabilityStatus;
  networkEvents: WorkflowCapabilityStatus;
  mutationEvents: WorkflowCapabilityStatus;
  selectorResolution: WorkflowCapabilityStatus;
  screenshots: WorkflowCapabilityStatus;
  crossOriginFrames: WorkflowCapabilityStatus;
  closedShadowDom: WorkflowCapabilityStatus;
  downloads: WorkflowCapabilityStatus;
  mfa: WorkflowCapabilityStatus;
  captcha: WorkflowCapabilityStatus;
  unsupportedReasons: string[];
}

interface WorkflowRuntimeMetrics {
  workflowRun: {
    totalCount: number;
    successCount: number;
    failureCount: number;
    successRate: number | null;
  };
  passRateByWorkflow: Record<string, number>;
  repair: {
    applyCount: number;
    applyRate: number | null;
    falseRepairCount: number;
    falseRepairRate: number | null;
  };
  artifactRedaction: {
    lowConfidenceCount: number;
  };
  quota: {
    hitCount: number;
  };
  capability: {
    unsupportedCount: number;
  };
  approval: {
    useCount: number;
  };
  quality: {
    staleQualityCount: number;
  };
  audit: {
    eventCount: number;
  };
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
type FlowVariable = NonNullable<FlowV3['variables']>[number];
let fallbackQualityHmacSalt: string | undefined;

function flowDisablesFailureScreenshots(flow: FlowV3): boolean {
  const defaultScreenshot = flow.policy?.defaultNodePolicy?.artifacts?.screenshot;
  if (defaultScreenshot !== 'never') {
    return false;
  }
  return (Array.isArray(flow.nodes) ? flow.nodes : []).every((node) => {
    const nodeScreenshot = node.policy?.artifacts?.screenshot;
    return !nodeScreenshot || nodeScreenshot === 'never';
  });
}

function buildWorkflowCapabilityMatrix(
  flow: FlowV3,
  mode: 'debug' | 'stabilize',
): WorkflowCapabilityMatrix {
  const unsupportedReasons: string[] = [];
  if (mode === 'stabilize') {
    unsupportedReasons.push(
      'Reset workflow execution and automatic stopBeforeDangerous segmentation are bounded validation features, not rollback guarantees',
    );
  } else {
    unsupportedReasons.push(
      'workflow_debug_view reports persisted observations only and does not probe the live page',
    );
  }
  unsupportedReasons.push(
    'DOM and accessibility snapshots are not captured as structured artifacts yet',
    'Network and mutation observation events are schema-defined but not collected by default',
    'Cross-origin iframe and closed shadow DOM observability cannot be proven from persisted run data',
    'MFA, CAPTCHA, and download observability are reported as unknown unless future runtime events prove support',
  );

  return {
    replayValidation: mode === 'stabilize' ? 'partial' : 'unknown',
    domSnapshot: 'none',
    accessibilitySnapshot: 'none',
    navigationEvents: 'partial',
    networkEvents: 'none',
    mutationEvents: 'none',
    selectorResolution: 'partial',
    screenshots: flowDisablesFailureScreenshots(flow) ? 'none' : 'partial',
    crossOriginFrames: 'unknown',
    closedShadowDom: 'none',
    downloads: 'unknown',
    mfa: 'unknown',
    captcha: 'unknown',
    unsupportedReasons,
  };
}

function normalizeExecutionMode(value: unknown): 'auto' | 'analyzeOnly' | 'sandboxReplay' | 'userApprovedReplay' {
  return value === 'analyzeOnly' || value === 'sandboxReplay' || value === 'userApprovedReplay'
    ? value
    : 'auto';
}

async function resolveStabilizeTargetTabUrl(args: any): Promise<{ url?: string; path: string; label: string }> {
  const tabId =
    typeof args?.tabId === 'number' && Number.isFinite(args.tabId)
      ? Math.floor(args.tabId)
      : undefined;
  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      return {
        url: typeof tab?.url === 'string' ? tab.url : undefined,
        path: '/tabId',
        label: 'target tab URL',
      };
    } catch {
      return { path: '/tabId', label: 'target tab URL' };
    }
  }

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = Array.isArray(tabs) ? tabs[0] : undefined;
    return {
      url: typeof tab?.url === 'string' ? tab.url : undefined,
      path: '/tabTarget',
      label: 'current tab URL',
    };
  } catch {
    return { path: '/tabTarget', label: 'current tab URL' };
  }
}

async function validateStabilizeReplayBoundary(
  args: any,
  executionMode: 'auto' | 'analyzeOnly' | 'sandboxReplay' | 'userApprovedReplay',
): Promise<WorkflowStabilizeValidationError | undefined> {
  const boundary = getStabilizeSafetyBoundary(args);
  if (!hasStabilizeUrlBoundary(boundary)) {
    return undefined;
  }

  const startUrl = typeof args?.startUrl === 'string' ? args.startUrl.trim() : '';
  if (startUrl) {
    return validateUrlAgainstStabilizeBoundary(startUrl, boundary, '/startUrl', 'startUrl');
  }
  if (executionMode !== 'sandboxReplay') {
    return undefined;
  }
  if (args?.tabTarget === 'new') {
    return {
      code: 'SANDBOX_REPLAY_REQUIRES_START_URL',
      path: '/startUrl',
      message:
        'sandboxReplay with tabTarget="new" requires startUrl so the test environment boundary can be verified',
    };
  }

  const target = await resolveStabilizeTargetTabUrl(args);
  if (!target.url) {
    return {
      code: 'SANDBOX_REPLAY_TARGET_URL_UNAVAILABLE',
      path: target.path,
      message: `sandboxReplay requires a readable ${target.label} so the test environment boundary can be verified`,
    };
  }
  return validateUrlAgainstStabilizeBoundary(target.url, boundary, target.path, target.label);
}

function getStabilizeTestEnvironment(args: any): Record<string, unknown> | undefined {
  return args?.safety?.testEnvironment &&
    typeof args.safety.testEnvironment === 'object' &&
    !Array.isArray(args.safety.testEnvironment)
    ? args.safety.testEnvironment
    : undefined;
}

function hasRunnableResetPlan(resetValidation: WorkflowResetValidation): boolean {
  return Boolean(resetValidation.plan && resetValidation.plan.maxRuns > 0);
}

function getSandboxReplayBoundaryError(
  args: any,
  resetValidation: WorkflowResetValidation,
  segmentPlan: WorkflowSegmentPlan,
): WorkflowStabilizeValidationError | undefined {
  const testEnvironment = getStabilizeTestEnvironment(args);
  if (!testEnvironment) {
    return {
      code: 'SANDBOX_REPLAY_REQUIRES_TEST_ENVIRONMENT',
      path: '/safety/testEnvironment',
      message: 'sandboxReplay requires safety.testEnvironment',
    };
  }

  const name = typeof testEnvironment.name === 'string' ? testEnvironment.name.trim() : '';
  const origins = normalizeBoundaryStrings(testEnvironment.origins);
  if (!name || origins.length === 0) {
    return {
      code: 'SANDBOX_REPLAY_TEST_ENVIRONMENT_INCOMPLETE',
      path: '/safety/testEnvironment',
      message: 'sandboxReplay requires safety.testEnvironment.name and at least one origin',
    };
  }

  const accountLabel =
    typeof testEnvironment.accountLabel === 'string' && testEnvironment.accountLabel.trim()
      ? testEnvironment.accountLabel.trim()
      : '';
  if (!accountLabel && !hasRunnableResetPlan(resetValidation) && !hasSegmentBoundary(segmentPlan)) {
    return {
      code: 'SANDBOX_REPLAY_REQUIRES_BOUNDED_ENVIRONMENT',
      path: '/safety',
      message:
        'sandboxReplay is bounded test replay, not a rollback sandbox; provide a test account label, reset workflow, or segment boundary',
    };
  }

  return undefined;
}

function validateWorkflowStabilizeArgs(args: any): WorkflowStabilizeValidationError[] {
  const errors: WorkflowStabilizeValidationError[] = [];
  const flowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
  const workflow = typeof args?.workflow === 'string' ? args.workflow.trim() : '';

  if ((flowId && workflow) || (!flowId && !workflow)) {
    errors.push({
      code: 'INVALID_WORKFLOW_IDENTIFIER',
      path: '',
      message: 'Exactly one of flowId or workflow is required',
    });
  }
  if (args?.apply === true && args?.dryRun === true) {
    errors.push({
      code: 'MUTUALLY_EXCLUSIVE_OPTIONS',
      path: '/apply',
      message: 'apply=true cannot be combined with dryRun=true',
    });
  }
  if (
    typeof args?.tabId === 'number' &&
    Number.isFinite(args.tabId) &&
    args?.tabTarget === 'new'
  ) {
    errors.push({
      code: 'MUTUALLY_EXCLUSIVE_OPTIONS',
      path: '/tabId',
      message: 'tabId cannot be combined with tabTarget="new"',
    });
  }
  const startUrl = typeof args?.startUrl === 'string' ? args.startUrl.trim() : '';
  if (startUrl && !isAllowedPublicStartUrl(startUrl)) {
    errors.push({
      code: 'INVALID_START_URL',
      path: '/startUrl',
      message: 'Only http:// and https:// URLs are allowed for startUrl',
    });
  }
  if (
    args?.iterations !== undefined &&
    (typeof args.iterations !== 'number' ||
      !Number.isFinite(args.iterations) ||
      args.iterations < 1 ||
      args.iterations > 10)
  ) {
    errors.push({
      code: 'INVALID_ITERATIONS',
      path: '/iterations',
      message: 'iterations must be a number from 1 to 10',
    });
  }
  if (
    args?.minPassRate !== undefined &&
    (typeof args.minPassRate !== 'number' ||
      !Number.isFinite(args.minPassRate) ||
      args.minPassRate < 0 ||
      args.minPassRate > 1)
  ) {
    errors.push({
      code: 'INVALID_MIN_PASS_RATE',
      path: '/minPassRate',
      message: 'minPassRate must be a number from 0 to 1',
    });
  }

  return errors;
}

function createStructuredToolError(
  code: string,
  message: string,
  errors: WorkflowStabilizeValidationError[],
): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: false,
          status: 'validation_failed',
          error: {
            code,
            category: 'validation',
            retryable: false,
            message,
            errors,
          },
        }),
      },
    ],
    isError: true,
  };
}

interface FlowRevisionConflictLike {
  code: 'STALE_WORKFLOW_REVISION';
  message?: string;
  flowId?: unknown;
  expectedRevision?: unknown;
  currentRevision?: unknown;
}

function getFlowRevisionConflict(error: unknown): FlowRevisionConflictLike | null {
  return isRecord(error) && error.code === 'STALE_WORKFLOW_REVISION'
    ? (error as unknown as FlowRevisionConflictLike)
    : null;
}

function createWorkflowRevisionConflictError(
  error: FlowRevisionConflictLike,
  message: string,
): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: false,
          status: 'stale_revision',
          error: {
            code: 'STALE_WORKFLOW_REVISION',
            category: 'conflict',
            retryable: true,
            message,
            ...(typeof error.flowId === 'string' ? { flowId: error.flowId } : {}),
            ...(typeof error.expectedRevision === 'string'
              ? { expectedRevision: error.expectedRevision }
              : {}),
            ...(typeof error.currentRevision === 'string' || error.currentRevision === null
              ? { currentRevision: error.currentRevision }
              : {}),
          },
        }),
      },
    ],
    isError: true,
  };
}

async function persistScheduledRevalidationCatchUp(flow: FlowV3): Promise<FlowV3> {
  const initialCatchUp = markScheduledRevalidationCatchUp(flow);
  if (!initialCatchUp.changed) {
    return flow;
  }

  const flowId = flow.id as FlowId;
  const storage = createStoragePort();
  return withFlowWriteLock(flowId, async () => {
    const latest = await storage.flows.get(flowId);
    if (!latest) {
      return flow;
    }
    const catchUp = markScheduledRevalidationCatchUp(latest);
    if (catchUp.changed) {
      await storage.flows.save(catchUp.flow);
      return catchUp.flow;
    }
    return latest;
  });
}

function getVariableName(variable: FlowVariable | null | undefined): string | undefined {
  return getVariableLikeName(variable);
}

function isSensitiveVariableDefinition(variable: FlowVariable | null | undefined): boolean {
  return isSensitiveVariableLike(variable);
}

function inferFlowVariableKind(variable: FlowVariable): string {
  if (variable.kind) return variable.kind;
  if (typeof variable.default === 'number') return 'number';
  if (typeof variable.default === 'boolean') return 'boolean';
  if (Array.isArray(variable.default)) return 'array';
  if (variable.default && typeof variable.default === 'object') return 'json';
  return 'string';
}

function validateWorkflowArgsForStabilize(
  flow: FlowV3,
  value: unknown,
  pathPrefix: string,
): { args?: Record<string, unknown>; errors: WorkflowStabilizeValidationError[] } {
  const errors: WorkflowStabilizeValidationError[] = [];
  if (value === undefined || value === null) {
    value = {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      errors: [
        {
          code: 'INVALID_WORKFLOW_ARGS',
          path: pathPrefix,
          message: 'workflow args must be an object',
        },
      ],
    };
  }

  const input = value as Record<string, unknown>;
  const variables = Array.isArray(flow.variables) ? flow.variables : [];
  const knownVariables = new Map(variables.map((variable) => [variable.name, variable]));
  for (const key of Object.keys(input)) {
    if (!knownVariables.has(key)) {
      errors.push({
        code: 'UNKNOWN_WORKFLOW_ARG',
        path: `${pathPrefix}/${key}`,
        message: `Unknown workflow argument: ${key}`,
      });
    }
  }

  for (const variable of variables) {
    if (!variable?.name) continue;
    const hasValue = Object.prototype.hasOwnProperty.call(input, variable.name);
    const argValue = input[variable.name];
    if (variable.required === true && variable.default === undefined && !hasValue) {
      errors.push({
        code: 'MISSING_REQUIRED_WORKFLOW_ARG',
        path: `${pathPrefix}/${variable.name}`,
        message: `Missing required workflow argument: ${variable.name}`,
      });
      continue;
    }
    if (!hasValue || argValue === undefined || argValue === null) {
      continue;
    }

    const kind = inferFlowVariableKind(variable);
    const valid =
      kind === 'number'
        ? typeof argValue === 'number' && Number.isFinite(argValue)
        : kind === 'boolean'
          ? typeof argValue === 'boolean'
          : kind === 'array'
            ? Array.isArray(argValue)
            : kind === 'json'
              ? true
              : kind === 'enum'
                ? Array.isArray(variable.options) && variable.options.includes(argValue as never)
                : typeof argValue === 'string';
    if (!valid) {
      errors.push({
        code: 'INVALID_WORKFLOW_ARG_TYPE',
        path: `${pathPrefix}/${variable.name}`,
        message: `Invalid value for workflow argument "${variable.name}"`,
      });
    }
  }

  return {
    ...(Object.keys(input).length > 0 ? { args: input } : {}),
    errors,
  };
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
      flow.meta.exposedOutputs ||
      flow.meta.quality ||
      flow.meta.audit)
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
          ...(flow.meta.quality
            ? {
                quality: {
                  level: flow.meta.quality.level,
                  status: flow.meta.quality.status,
                  revision: flow.meta.quality.revision,
                  stabilityScore: flow.meta.quality.stabilityScore,
                  passRate: flow.meta.quality.passRate,
                  validationRuns: flow.meta.quality.validationRuns,
                  countedValidationRuns: flow.meta.quality.countedValidationRuns,
                  lastValidatedAt: flow.meta.quality.lastValidatedAt,
                  freshnessExpiresAt: flow.meta.quality.freshnessExpiresAt,
                  staleReason: flow.meta.quality.staleReason,
                },
              }
            : {}),
          ...(flow.meta.audit?.events
            ? {
                audit: {
                  events: flow.meta.audit.events.map((event) => ({
                    ...event,
                    ...(event.metadata ? { metadata: { ...event.metadata } } : {}),
                  })),
                },
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
          ...getPublicNodeExecutionMetadata(node),
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

const MCP_CLIENT_CAPABILITY_KEYS = [
  'toolListChanged',
  'resourceReferences',
  'cancellation',
  'structuredErrors',
  'largeResults',
] as const;

function normalizeMcpClientCapabilities(
  context?: ToolExecutionContext,
): NormalizedMcpClientCapabilities {
  const isMcp = context?.meta?.source === 'mcp' || Boolean(context?.meta?.mcpSessionId);
  const raw = context?.meta?.clientCapabilities;
  const supported = new Set<string>();
  const warnings: string[] = [];
  let source = isMcp ? 'default' : 'direct';

  if (Array.isArray(raw)) {
    source = 'list';
    for (const capability of raw) {
      if (typeof capability === 'string' && capability.trim()) {
        supported.add(capability.trim());
      }
    }
  } else if (raw && typeof raw === 'object') {
    const capabilityRecord = raw as Record<string, unknown>;
    source =
      typeof capabilityRecord.source === 'string' && capabilityRecord.source.trim()
        ? capabilityRecord.source.trim()
        : source;
    for (const key of MCP_CLIENT_CAPABILITY_KEYS) {
      if (capabilityRecord[key] === true) {
        supported.add(key);
      }
    }
    if (Array.isArray(capabilityRecord.warnings)) {
      for (const warning of capabilityRecord.warnings) {
        if (typeof warning === 'string' && warning.trim()) {
          warnings.push(warning.trim());
        }
      }
    }
  }

  const normalized: NormalizedMcpClientCapabilities = {
    mcp: isMcp,
    source,
    toolListChanged: supported.has('toolListChanged'),
    resourceReferences: supported.has('resourceReferences'),
    cancellation: supported.has('cancellation'),
    structuredErrors: supported.has('structuredErrors'),
    largeResults: supported.has('largeResults'),
    supported: MCP_CLIENT_CAPABILITY_KEYS.filter((key) => supported.has(key)),
    warnings,
  };

  if (isMcp && !normalized.toolListChanged) {
    normalized.warnings.push(
      'MCP client tool-list change support is not confirmed; workflow slugs are validated at runtime.',
    );
  }
  if (isMcp && !normalized.resourceReferences) {
    normalized.warnings.push(
      'MCP client resource references are not confirmed; debug artifacts are summarized rather than returned as artifact references.',
    );
  }
  if (isMcp && !normalized.cancellation) {
    normalized.warnings.push(
      'MCP client cancellation support is not confirmed; long-running workflow operations use bounded resumable validation groups.',
    );
  }

  normalized.warnings = Array.from(new Set(normalized.warnings));
  return normalized;
}

function buildClientCapabilitySummary(
  capabilities: NormalizedMcpClientCapabilities,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    mcp: capabilities.mcp,
    source: capabilities.source,
    supported: capabilities.supported,
    warnings: capabilities.warnings,
  };
  if (capabilities.mcp) {
    summary.toolListChanged = capabilities.toolListChanged;
    summary.resourceReferences = capabilities.resourceReferences;
    summary.cancellation = capabilities.cancellation;
    summary.structuredErrors = capabilities.structuredErrors;
    summary.largeResults = capabilities.largeResults;
  }
  return summary;
}

function buildClientCapabilityWarnings(
  capabilities: NormalizedMcpClientCapabilities,
  options: { includeArtifacts?: boolean; longRunning?: boolean; runGroupId?: string } = {},
): WorkflowStabilizeWarning[] {
  if (!capabilities.mcp) {
    return [];
  }
  const warnings: WorkflowStabilizeWarning[] = [];
  if (!capabilities.resourceReferences && options.includeArtifacts !== false) {
    warnings.push({
      code: 'CLIENT_RESOURCE_REFERENCES_UNCONFIRMED',
      category: 'capability',
      message:
        'MCP client resource reference support is not confirmed; artifact payloads and references are unavailable in this response.',
    });
  }
  if (!capabilities.cancellation && options.longRunning) {
    warnings.push({
      code: 'CLIENT_CANCELLATION_UNCONFIRMED',
      category: 'capability',
      message: options.runGroupId
        ? `MCP client cancellation support is not confirmed; workflow_stabilize uses bounded validation and resumable runGroupId ${options.runGroupId}.`
        : 'MCP client cancellation support is not confirmed; workflow_stabilize uses bounded validation instead of relying on client cancellation.',
    });
  }
  if (!capabilities.structuredErrors) {
    warnings.push({
      code: 'CLIENT_STRUCTURED_ERRORS_UNCONFIRMED',
      category: 'capability',
      message:
        'MCP client structured error support is not confirmed; workflow tools include machine-readable error details inside text JSON payloads.',
    });
  }
  if (!capabilities.largeResults) {
    warnings.push({
      code: 'CLIENT_LARGE_RESULTS_UNCONFIRMED',
      category: 'capability',
      message:
        'MCP client large-result handling is not confirmed; debug output remains compact and filtered by maxRuns/maxEventsPerRun.',
    });
  }
  return warnings;
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
  return (Array.isArray(flow.nodes) ? flow.nodes : []).map((node) => {
    const selectorQuality = buildNodeSelectorQualityDiagnostic(node);
    return {
      id: node.id,
      kind: node.kind,
      ...(node.name ? { name: node.name } : {}),
      ...(node.disabled === true ? { disabled: true } : {}),
      ...getPublicNodeExecutionMetadata(node),
      ...(node.policy ? { policy: node.policy } : {}),
      config: sanitizeDebugConfig(node.config, sensitiveVariableNames),
      ...(selectorQuality ? { selectorQuality } : {}),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function roundScore(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(4));
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
  if (event.type === 'navigation.observed') {
    if (event.beforeUrl !== undefined) {
      base.beforeUrl = sanitizeDebugValue(event.beforeUrl, 'url', sensitiveVariableNames);
    }
    if (event.afterUrl !== undefined) {
      base.afterUrl = sanitizeDebugValue(event.afterUrl, 'url', sensitiveVariableNames);
    }
    if (event.frameId !== undefined) base.frameId = event.frameId;
    if (event.sameDocument !== undefined) base.sameDocument = event.sameDocument;
    base.status = event.status;
  }
  if (event.type === 'network.observed') {
    base.requestId = truncateString(event.requestId, 120);
    base.url = sanitizeDebugValue(event.url, 'url', sensitiveVariableNames);
    base.resourceType = event.resourceType;
    base.currentFrame = event.currentFrame;
    base.startedAt = event.startedAt;
    if (event.endedAt !== undefined) base.endedAt = event.endedAt;
    if (event.status !== undefined) base.status = event.status;
    if (event.frameId !== undefined) base.frameId = event.frameId;
    if (event.method !== undefined) base.method = truncateString(event.method, 20);
    if (event.fromCache !== undefined) base.fromCache = event.fromCache;
    if (event.requestGroup !== undefined) base.requestGroup = truncateString(event.requestGroup, 80);
    if (event.quietWindowMs !== undefined) base.quietWindowMs = event.quietWindowMs;
    if (event.longLived !== undefined) base.longLived = event.longLived;
  }
  if (event.type === 'dom.visibility') {
    base.selector = sanitizeDebugValue(event.selector, 'selector', sensitiveVariableNames);
    if (event.candidateIndex !== undefined) base.candidateIndex = event.candidateIndex;
    base.matchCount = event.matchCount;
    if (event.appearedAt !== undefined) base.appearedAt = event.appearedAt;
    if (event.disappearedAt !== undefined) base.disappearedAt = event.disappearedAt;
    if (event.stableForMs !== undefined) base.stableForMs = event.stableForMs;
    base.status = event.status;
  }
  if (event.type === 'selector.resolution') {
    base.primarySelector = sanitizeDebugValue(
      event.primarySelector,
      'selector',
      sensitiveVariableNames,
    );
    base.resolvedBy = event.resolvedBy;
    if (event.candidateIndex !== undefined) base.candidateIndex = event.candidateIndex;
    base.matchCount = event.matchCount;
    if (event.fingerprint !== undefined) base.fingerprint = event.fingerprint;
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

function getDebugNodeIdFilter(args: any): string {
  return typeof args?.nodeId === 'string' ? args.nodeId.trim() : '';
}

function getDebugMaxEventsPerRun(args: any): number {
  return clampNumber(
    args?.maxEvents ?? args?.maxEventsPerRun,
    40,
    0,
    100,
  );
}

function getArtifactProvenance(
  artifact?: DebugArtifactRecord,
): NonNullable<ArtifactRecord['provenance']> {
  return artifact?.provenance ?? { source: 'runtimeCapture', trust: 'untrusted' };
}

function getArtifactRedaction(
  artifact?: DebugArtifactRecord,
): NonNullable<ArtifactRecord['redaction']> {
  return (
    artifact?.redaction ?? {
      status: 'lowConfidence',
      confidence: 'low',
      warnings: [
        'Artifact predates redaction metadata; binary data is not inlined by default.',
      ],
    }
  );
}

function artifactHasLowConfidenceRedaction(artifact: DebugArtifactRecord): boolean {
  const redaction = getArtifactRedaction(artifact);
  return redaction.status === 'lowConfidence' || redaction.confidence === 'low';
}

function sanitizeDebugArtifact(
  artifact: DebugArtifactRecord,
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
    originalSizeBytes: artifact.originalSizeBytes ?? artifact.sizeBytes,
    createdAt: artifact.createdAt,
    expiresAt: artifact.expiresAt,
    ttlMs: artifact.ttlMs ?? Math.max(0, artifact.expiresAt - artifact.createdAt),
    truncated: artifact.truncated === true,
    untrusted: true,
    provenance: getArtifactProvenance(artifact),
    redaction: getArtifactRedaction(artifact),
    ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
  };
  if (!includeData) {
    safe.dataBase64Omitted = 'not_requested';
  } else if (artifact.truncated === true) {
    safe.dataBase64Omitted = 'truncated';
  } else if (artifactHasLowConfidenceRedaction(artifact)) {
    safe.dataBase64Omitted = 'redaction_low_confidence';
  } else if (artifact.sizeBytes > maxArtifactDataBytes) {
    safe.dataBase64Omitted = 'too_large';
  } else if (typeof artifact.dataBase64 !== 'string') {
    safe.dataBase64Omitted = 'artifact_missing';
  } else {
    safe.dataBase64 = artifact.dataBase64;
  }
  return safe;
}

function buildMissingDebugArtifact(
  event: Extract<RunEvent, { type: 'artifact.screenshot' }>,
): WorkflowDebugArtifact | null {
  if (!event.artifactId) {
    return null;
  }
  return {
    id: event.artifactId,
    nodeId: event.nodeId,
    kind: 'screenshot',
    ...(event.savedAs ? { savedAs: event.savedAs } : {}),
    missing: true,
    unavailableReason: 'expired_or_cleaned',
    untrusted: true,
    provenance: { source: 'runtimeCapture', trust: 'untrusted' },
    redaction: {
      status: 'lowConfidence',
      confidence: 'low',
      warnings: [
        'Artifact payload is unavailable because it expired, was cleaned up, or was removed by retention.',
      ],
    },
    dataBase64Omitted: 'artifact_missing',
  };
}

function buildDebugArtifacts(
  records: DebugArtifactRecord[],
  events: RunEvent[],
  includeData: boolean,
  maxArtifactDataBytes: number,
): WorkflowDebugArtifact[] {
  const artifacts: WorkflowDebugArtifact[] = [];
  let remainingArtifactDataBytes = maxArtifactDataBytes;
  for (const record of records) {
    const artifact = sanitizeDebugArtifact(
      record,
      includeData,
      remainingArtifactDataBytes,
    );
    artifacts.push(artifact);
    if (artifact.dataBase64 !== undefined) {
      remainingArtifactDataBytes = Math.max(
        0,
        remainingArtifactDataBytes - Math.max(0, record.sizeBytes),
      );
    }
  }
  const presentIds = new Set(records.map((artifact) => artifact.id));
  for (const event of events) {
    if (
      event.type !== 'artifact.screenshot' ||
      !event.artifactId ||
      presentIds.has(event.artifactId)
    ) {
      continue;
    }
    const missing = buildMissingDebugArtifact(event);
    if (missing) {
      artifacts.push(missing);
      presentIds.add(event.artifactId);
    }
  }
  return artifacts;
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

function getWorkflowResetSpec(args: any):
  | { workflow: string; args?: Record<string, unknown>; maxRuns: number; requireStable: boolean }
  | null {
  const reset =
    args?.safety?.reset && typeof args.safety.reset === 'object' && !Array.isArray(args.safety.reset)
      ? args.safety.reset
      : {};
  const workflow =
    typeof reset.workflow === 'string' && reset.workflow.trim()
      ? reset.workflow.trim()
      : typeof args?.safety?.resetWorkflow === 'string' && args.safety.resetWorkflow.trim()
        ? args.safety.resetWorkflow.trim()
        : '';
  if (!workflow) {
    return null;
  }
  const resetArgs =
    reset.args && typeof reset.args === 'object' && !Array.isArray(reset.args)
      ? (reset.args as Record<string, unknown>)
      : undefined;
  return {
    workflow,
    ...(resetArgs ? { args: resetArgs } : {}),
    maxRuns: clampNumber(reset.maxRuns, 1, 0, 3),
    requireStable: reset.requireStable !== false,
  };
}

async function buildWorkflowResetValidation(options: {
  args: any;
  targetFlow: FlowV3;
  hasApprovalReference: boolean;
}): Promise<WorkflowResetValidation> {
  const spec = getWorkflowResetSpec(options.args);
  if (!spec) {
    return { requested: false, errors: [] };
  }

  const errors: WorkflowStabilizeValidationError[] = [];
  const storage = createStoragePort();
  const flows = await storage.flows.list();
  const resetFlow = flows.find((flow) => getPublishedFlowInfo(flow)?.slug === spec.workflow);
  if (!resetFlow) {
    errors.push({
      code: 'RESET_WORKFLOW_NOT_FOUND',
      path: '/safety/reset/workflow',
      message: `Reset workflow not found: ${spec.workflow}`,
    });
    return {
      requested: true,
      blockedReason: `reset workflow not found: ${spec.workflow}`,
      errors,
    };
  }
  if (resetFlow.id === options.targetFlow.id) {
    errors.push({
      code: 'RESET_WORKFLOW_SELF_REFERENCE',
      path: '/safety/reset/workflow',
      message: 'reset workflow cannot reference the target workflow',
    });
    return {
      requested: true,
      blockedReason: 'reset workflow cannot reference the target workflow',
      errors,
    };
  }

  const argsValidation = validateWorkflowArgsForStabilize(
    resetFlow,
    spec.args ?? {},
    '/safety/reset/args',
  );
  if (argsValidation.errors.length > 0) {
    return {
      requested: true,
      blockedReason: 'reset workflow args failed validation',
      errors: argsValidation.errors,
    };
  }

  const descriptor = buildWorkflowToolDescriptor(resetFlow);
  const risk = classifyWorkflowRisk(descriptor.sideEffects.summary);
  if ((risk === 'dangerous' || risk === 'unknown') && !options.hasApprovalReference) {
    errors.push({
      code: 'RESET_WORKFLOW_REQUIRES_APPROVAL',
      path: '/safety/reset/workflow',
      message: 'dangerous or unknown reset workflow requires a trusted approval reference',
    });
    return {
      requested: true,
      blockedReason: 'reset workflow requires trusted approval',
      errors,
    };
  }

  const quality = buildWorkflowQualitySummary(resetFlow);
  if (
    spec.requireStable &&
    (!quality.current || (quality.level !== 'stable' && quality.level !== 'verified'))
  ) {
    errors.push({
      code: 'RESET_WORKFLOW_QUALITY_STALE',
      path: '/safety/reset/workflow',
      message: `reset workflow quality is not current stable: ${quality.staleReason ?? quality.level}`,
    });
    return {
      requested: true,
      blockedReason: 'reset workflow quality gate failed',
      errors,
    };
  }

  return {
    requested: true,
    plan: {
      flow: resetFlow,
      workflow: spec.workflow,
      args: argsValidation.args,
      maxRuns: spec.maxRuns,
      requireStable: spec.requireStable,
      revision: calculateWorkflowRevision(resetFlow),
      risk,
      quality,
    },
    errors: [],
  };
}

async function cleanupDebugArtifactsForRun(
  flow: FlowV3,
  args: any,
): Promise<
  { requested: boolean; scope: 'run'; runId: string; deleted: number } | null | { error: string }
> {
  if (args?.cleanupArtifacts !== true) {
    return null;
  }
  const runId = typeof args?.runId === 'string' ? args.runId.trim() : '';
  if (!runId) {
    return { error: 'runId is required when cleanupArtifacts is true' };
  }

  const storage = createStoragePort();
  const run = await storage.runs.get(runId as RunId);
  if (!run || run.flowId !== flow.id) {
    return { error: `Run not found for workflow: ${runId}` };
  }
  return {
    requested: true,
    scope: 'run',
    runId,
    deleted: await storage.artifacts.deleteByRun(run.id),
  };
}

async function collectDebugRuns(flow: FlowV3, args: any): Promise<WorkflowDebugRun[]> {
  const includeRuns = args?.includeRuns !== false;
  const runId = typeof args?.runId === 'string' ? args.runId.trim() : '';
  if (!includeRuns && !runId) {
    return [];
  }

  const storage = createStoragePort();
  const maxRuns = runId ? 1 : clampNumber(args?.maxRuns, 3, 0, 10);
  const maxEventsPerRun = getDebugMaxEventsPerRun(args);
  const nodeIdFilter = getDebugNodeIdFilter(args);
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
    const filteredEvents = nodeIdFilter
      ? events.filter((event) => 'nodeId' in event && event.nodeId === nodeIdFilter)
      : events;
    let artifacts: WorkflowDebugArtifact[] | undefined;
    if (includeArtifacts) {
      const metadata = (await storage.artifacts.listByRun(run.id)).filter((artifact) =>
        nodeIdFilter ? artifact.nodeId === nodeIdFilter : true,
      );
      let records: DebugArtifactRecord[] = metadata;
      if (includeArtifactData) {
        records = [];
        let remainingArtifactDataBytes = maxArtifactDataBytes;
        for (const artifact of metadata) {
          const canLoadPayload =
            artifact.truncated !== true &&
            !artifactHasLowConfidenceRedaction(artifact) &&
            artifact.sizeBytes <= remainingArtifactDataBytes;
          if (!canLoadPayload) {
            records.push(artifact);
            continue;
          }
          const fullRecord = await storage.artifacts.get(artifact.id);
          records.push(fullRecord ?? artifact);
          if (fullRecord) {
            remainingArtifactDataBytes = Math.max(
              0,
              remainingArtifactDataBytes - Math.max(0, fullRecord.sizeBytes),
            );
          }
        }
      }
      artifacts = buildDebugArtifacts(
        records,
        filteredEvents,
        includeArtifactData,
        maxArtifactDataBytes,
      );
    }
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
      events: filteredEvents.map((event) => sanitizeEvent(event, sensitiveVariableNames)),
      ...(artifacts ? { artifacts } : {}),
    });
  }

  return debugRuns;
}

function roundMetric(value: number): number {
  return Number(Math.max(0, value).toFixed(4));
}

function extractDebugRunErrorCode(run: WorkflowDebugRun): string | undefined {
  const error = run.error;
  if (isRecord(error)) {
    const code = error.code ?? error.errorCode;
    if (typeof code === 'string' && code.trim()) {
      return code.trim();
    }
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  return undefined;
}

function isQuotaLikeErrorCode(code: string | undefined): boolean {
  return Boolean(code && /(quota|rate.?limit|resource.?exhausted|storage.?limit|limit.?exceeded)/i.test(code));
}

function countQuotaSignalEvents(run: WorkflowDebugRun): number {
  return run.events.filter((event) => {
    const data = isRecord(event.data) ? event.data : undefined;
    const code = typeof data?.code === 'string' ? data.code : undefined;
    const category = typeof data?.category === 'string' ? data.category : undefined;
    const message = typeof event.message === 'string' ? event.message : undefined;
    return (
      category === 'resource' ||
      isQuotaLikeErrorCode(code) ||
      isQuotaLikeErrorCode(message)
    );
  }).length;
}

function countQuotaSignalArtifacts(run: WorkflowDebugRun): number {
  return (run.artifacts ?? []).filter(
    (artifact) =>
      artifact.truncated === true ||
      artifact.dataBase64Omitted === 'truncated',
  ).length;
}

function countQuotaSignalsInDebugRuns(runs: WorkflowDebugRun[]): number {
  return runs.reduce(
    (sum, run) =>
      sum +
      (isQuotaLikeErrorCode(extractDebugRunErrorCode(run)) ? 1 : 0) +
      countQuotaSignalEvents(run) +
      countQuotaSignalArtifacts(run),
    0,
  );
}

function countUnsupportedCapabilities(capabilities?: WorkflowCapabilityMatrix): number {
  if (!capabilities) {
    return 0;
  }
  const statusCount = Object.entries(capabilities).filter(
    ([key, value]) => key !== 'unsupportedReasons' && (value === 'none' || value === 'unknown'),
  ).length;
  return statusCount + capabilities.unsupportedReasons.length;
}

function countLowConfidenceArtifacts(runs: WorkflowDebugRun[]): number {
  return runs.reduce(
    (sum, run) =>
      sum +
      (run.artifacts ?? []).filter(
        (artifact) =>
          artifact.redaction.status === 'lowConfidence' ||
          artifact.redaction.confidence === 'low' ||
          artifact.dataBase64Omitted === 'redaction_low_confidence',
      ).length,
    0,
  );
}

function buildWorkflowRuntimeMetrics(
  flow: FlowV3,
  runs: WorkflowDebugRun[],
  capabilities?: WorkflowCapabilityMatrix,
): WorkflowRuntimeMetrics {
  const successCount = runs.filter((run) => run.status === 'succeeded').length;
  const totalCount = runs.length;
  const failureCount = Math.max(0, totalCount - successCount);
  const repairHistory = Array.isArray(flow.meta?.repairs?.history)
    ? flow.meta.repairs.history
    : [];
  const falseRepairCount = repairHistory.filter(
    (entry) =>
      typeof entry.beforeQuality === 'number' &&
      typeof entry.afterQuality === 'number' &&
      entry.afterQuality < entry.beforeQuality,
  ).length;
  const auditEvents = Array.isArray(flow.meta?.audit?.events) ? flow.meta.audit.events : [];
  const quality = buildWorkflowQualitySummary(flow);
  const workflowKey = getPublishedFlowInfo(flow)?.slug ?? flow.id;

  return {
    workflowRun: {
      totalCount,
      successCount,
      failureCount,
      successRate: totalCount > 0 ? roundMetric(successCount / totalCount) : null,
    },
    passRateByWorkflow: {
      [workflowKey]: quality.passRate,
    },
    repair: {
      applyCount: repairHistory.length,
      applyRate: totalCount > 0 ? roundMetric(repairHistory.length / totalCount) : null,
      falseRepairCount,
      falseRepairRate:
        repairHistory.length > 0 ? roundMetric(falseRepairCount / repairHistory.length) : null,
    },
    artifactRedaction: {
      lowConfidenceCount: countLowConfidenceArtifacts(runs),
    },
    quota: {
      hitCount: countQuotaSignalsInDebugRuns(runs),
    },
    capability: {
      unsupportedCount: countUnsupportedCapabilities(capabilities),
    },
    approval: {
      useCount: auditEvents.filter((event) => event.kind === 'approval_use').length,
    },
    quality: {
      staleQualityCount: quality.current ? 0 : 1,
    },
    audit: {
      eventCount: auditEvents.length,
    },
  };
}

function buildStabilizeRuntimeMetrics(options: {
  flow: FlowV3;
  validationRuns: WorkflowStabilizeRunSummary[];
  inspectedRuns: WorkflowDebugRun[];
  capabilities: WorkflowCapabilityMatrix;
  applied: boolean;
  changes: WorkflowRepairChange[];
  rollbackSuggested: boolean;
  approvalUsed: boolean;
  passRate: number;
  qualityCurrent: boolean;
}): WorkflowRuntimeMetrics {
  const totalCount = options.validationRuns.length;
  const successCount = options.validationRuns.filter((run) => run.success).length;
  const falseRepairCount = options.rollbackSuggested ? 1 : 0;
  const workflowKey = getPublishedFlowInfo(options.flow)?.slug ?? options.flow.id;
  const auditEvents = Array.isArray(options.flow.meta?.audit?.events) ? options.flow.meta.audit.events : [];
  const persistedApprovalUseCount = auditEvents.filter((event) => event.kind === 'approval_use').length;

  return {
    workflowRun: {
      totalCount,
      successCount,
      failureCount: Math.max(0, totalCount - successCount),
      successRate: totalCount > 0 ? roundMetric(successCount / totalCount) : null,
    },
    passRateByWorkflow: {
      [workflowKey]: roundScore(options.passRate),
    },
    repair: {
      applyCount: options.applied ? options.changes.length : 0,
      applyRate: totalCount > 0 ? roundMetric((options.applied ? 1 : 0) / totalCount) : null,
      falseRepairCount,
      falseRepairRate: options.applied ? falseRepairCount : null,
    },
    artifactRedaction: {
      lowConfidenceCount: countLowConfidenceArtifacts(options.inspectedRuns),
    },
    quota: {
      hitCount:
        options.validationRuns.filter((run) => isQuotaLikeErrorCode(run.errorCode)).length +
        countQuotaSignalsInDebugRuns(options.inspectedRuns),
    },
    capability: {
      unsupportedCount: countUnsupportedCapabilities(options.capabilities),
    },
    approval: {
      useCount: persistedApprovalUseCount > 0 ? persistedApprovalUseCount : options.approvalUsed ? 1 : 0,
    },
    quality: {
      staleQualityCount: options.qualityCurrent ? 0 : 1,
    },
    audit: {
      eventCount: auditEvents.length,
    },
  };
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
      const quality = buildSelectorQualityDiagnostic(isRecord(target) ? target : undefined);
      if (quality?.usesNthOfType || quality?.usesXPath || (quality && quality.score < 0.55)) {
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

function buildWaitDiagnosticRecommendations(
  runs: WorkflowDebugRun[],
): WorkflowRepairRecommendation[] {
  const timeoutNodes = new Set<string>();
  let hasObservationEvents = false;
  for (const run of runs) {
    for (const event of run.events) {
      if (
        event.type === 'navigation.observed' ||
        event.type === 'network.observed' ||
        event.type === 'dom.visibility'
      ) {
        hasObservationEvents = true;
      }
      const code = getSanitizedErrorCode(event.error);
      if (
        (code === RR_ERROR_CODES.TIMEOUT || code === RR_ERROR_CODES.NAVIGATION_FAILED) &&
        typeof event.nodeId === 'string'
      ) {
        timeoutNodes.add(event.nodeId);
      }
    }
  }

  if (timeoutNodes.size === 0) {
    return [];
  }
  if (!hasObservationEvents) {
    return [
      {
        severity: 'warning',
        code: 'wait_repair_requires_observation_events',
        message:
          'Recent timeout/navigation failures lack navigation, network, or DOM visibility observations. Only manual bounded wait suggestions are safe.',
      },
    ];
  }
  return Array.from(timeoutNodes).map((nodeId) => ({
    severity: 'warning' as const,
    code: 'bounded_wait_candidate',
    message:
      'Recent observations can support a bounded wait before this node. Automatic wait patching remains gated until confidence is high.',
    nodeId,
  }));
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

  return [
    ...recommendations,
    ...buildSelectorRepairRecommendations(planSelectorRepairs(flow, runs)),
    ...buildWaitRepairRecommendations(planWaitRepairs(flow, runs)),
    ...buildAssertionRepairRecommendations(buildAssertionRepairSuggestions(flow, runs)),
    ...buildRuntimeFailureRecommendations(runs),
    ...buildWaitDiagnosticRecommendations(runs),
  ];
}

function getIncomingEdges(flow: FlowV3, nodeId: string): FlowV3['edges'] {
  return (Array.isArray(flow.edges) ? flow.edges : []).filter((edge) => edge.to === nodeId);
}

function getOutgoingEdges(flow: FlowV3, nodeId: string): FlowV3['edges'] {
  return (Array.isArray(flow.edges) ? flow.edges : []).filter((edge) => edge.from === nodeId);
}

function createUniqueFlowId(flow: FlowV3, prefix: string): string {
  const usedNodeIds = new Set((Array.isArray(flow.nodes) ? flow.nodes : []).map((node) => node.id));
  const usedEdgeIds = new Set((Array.isArray(flow.edges) ? flow.edges : []).map((edge) => edge.id));
  const normalized = prefix.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'repair';
  let candidate = normalized;
  let counter = 1;
  while (usedNodeIds.has(candidate as FlowV3['entryNodeId']) || usedEdgeIds.has(candidate as FlowV3['edges'][number]['id'])) {
    counter += 1;
    candidate = `${normalized}-${counter}`;
  }
  return candidate;
}

function waitConditionsEqual(
  left: WorkflowWaitConditionPatch | undefined,
  right: WorkflowWaitConditionPatch | undefined,
): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === 'selector' && right.kind === 'selector') {
    return left.selector === right.selector && (left.visible !== false) === (right.visible !== false);
  }
  if (left.kind === 'networkIdle' && right.kind === 'networkIdle') {
    return (left.idleMs ?? 750) === (right.idleMs ?? 750);
  }
  return true;
}

function getWaitConditionFromNode(node: FlowV3['nodes'][number] | undefined): WorkflowWaitConditionPatch | undefined {
  if (!node || node.kind !== 'wait' || !isRecord(node.config)) return undefined;
  const condition = node.config.condition;
  if (!isRecord(condition) || typeof condition.kind !== 'string') return undefined;
  if (condition.kind === 'navigation') return { kind: 'navigation' };
  if (condition.kind === 'networkIdle') {
    return {
      kind: 'networkIdle',
      ...(typeof condition.idleMs === 'number' ? { idleMs: condition.idleMs } : {}),
    };
  }
  if (condition.kind === 'selector' && typeof condition.selector === 'string') {
    return {
      kind: 'selector',
      selector: condition.selector,
      ...(condition.visible === false ? { visible: false } : {}),
    };
  }
  return undefined;
}

function hasEquivalentWaitBefore(
  flow: FlowV3,
  nodeId: string,
  condition: WorkflowWaitConditionPatch,
): boolean {
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const incomingWaits = getIncomingEdges(flow, nodeId)
    .map((edge) => nodes.find((node) => node.id === edge.from))
    .filter((node): node is FlowV3['nodes'][number] => Boolean(node));
  if (flow.entryNodeId === nodeId) {
    const entryWait = nodes.find((node) => node.id === flow.entryNodeId && node.kind === 'wait');
    if (entryWait && getOutgoingEdges(flow, entryWait.id).some((edge) => edge.to === nodeId)) {
      incomingWaits.push(entryWait);
    }
  }
  return incomingWaits.some((waitNode) => waitConditionsEqual(getWaitConditionFromNode(waitNode), condition));
}

function canInsertWaitBefore(flow: FlowV3, nodeId: string): boolean {
  return flow.entryNodeId === nodeId || getIncomingEdges(flow, nodeId).length > 0;
}

function isWaitRepairFailureCode(code: string | undefined): boolean {
  return (
    code === RR_ERROR_CODES.TARGET_NOT_FOUND ||
    code === RR_ERROR_CODES.ELEMENT_NOT_VISIBLE ||
    code === RR_ERROR_CODES.TIMEOUT ||
    code === RR_ERROR_CODES.NAVIGATION_FAILED
  );
}

function failedNodeIdsForWaitRepair(runs: WorkflowDebugRun[]): Set<string> {
  const nodeIds = new Set<string>();
  for (const run of runs) {
    const runErrorCode = getSanitizedErrorCode(run.error);
    if (run.status === 'failed' && run.currentNodeId && isWaitRepairFailureCode(runErrorCode)) {
      nodeIds.add(run.currentNodeId);
    }
    for (const event of run.events) {
      if (getEventNodeId(event) && isWaitRepairFailureCode(getEventErrorCode(event))) {
        nodeIds.add(getEventNodeId(event)!);
      }
    }
  }
  return nodeIds;
}

function buildSelectorWaitPlanFromEvent(
  run: WorkflowDebugRun,
  event: Record<string, unknown>,
  nodeId: string,
): WaitRepairPlan | undefined {
  if (event.type !== 'dom.visibility' || getEventNodeId(event) !== nodeId) return undefined;
  if (typeof event.selector !== 'string' || !event.selector.trim()) return undefined;
  if (event.status !== 'appeared' && event.status !== 'stable') return undefined;
  if (typeof event.matchCount === 'number' && event.matchCount < 1) return undefined;
  return {
    op: 'addWaitBefore',
    nodeId,
    status: 'suggestion',
    reason: 'The failed target was later observed as visible; add a bounded selector wait before retrying the action.',
    confidence: 0.92,
    condition: { kind: 'selector', selector: event.selector.trim(), visible: true },
    evidence: {
      runId: run.id,
      observedNodeId: nodeId,
      eventType: 'dom.visibility',
      status: typeof event.status === 'string' ? event.status : undefined,
      selector: event.selector.trim(),
      ...(typeof event.matchCount === 'number' ? { matchCount: event.matchCount } : {}),
    },
  };
}

function buildNavigationWaitPlanFromEvent(
  run: WorkflowDebugRun,
  event: Record<string, unknown>,
  nodeId: string,
  observedNodeIds: ReadonlySet<string>,
): WaitRepairPlan | undefined {
  if (event.type !== 'navigation.observed') return undefined;
  const observedNodeId = getEventNodeId(event);
  if (!observedNodeId || !observedNodeIds.has(observedNodeId)) return undefined;
  if (event.status !== 'completed') return undefined;
  const beforeUrl = typeof event.beforeUrl === 'string' ? event.beforeUrl : undefined;
  const afterUrl = typeof event.afterUrl === 'string' ? event.afterUrl : undefined;
  if (!beforeUrl || !afterUrl || beforeUrl === afterUrl) return undefined;
  return {
    op: 'addWaitBefore',
    nodeId,
    status: 'suggestion',
    reason: 'A preceding step changed the page URL before this failure; add a bounded navigation wait.',
    confidence: 0.88,
    condition: { kind: 'navigation' },
    evidence: {
      runId: run.id,
      observedNodeId,
      eventType: 'navigation.observed',
      status: 'completed',
      beforeUrl,
      afterUrl,
    },
  };
}

function buildNetworkIdleWaitPlanFromEvent(
  run: WorkflowDebugRun,
  event: Record<string, unknown>,
  nodeId: string,
  observedNodeIds: ReadonlySet<string>,
): WaitRepairPlan | undefined {
  if (event.type !== 'network.observed') return undefined;
  const observedNodeId = getEventNodeId(event);
  if (!observedNodeId || !observedNodeIds.has(observedNodeId)) return undefined;
  if (event.currentFrame !== true || typeof event.endedAt !== 'number') return undefined;
  const resourceType = typeof event.resourceType === 'string' ? event.resourceType : undefined;
  const longLived =
    event.longLived === true || resourceType === 'websocket' || resourceType === 'eventsource';
  const requestGroup = typeof event.requestGroup === 'string' ? event.requestGroup.trim() : '';
  const quietWindowMs =
    typeof event.quietWindowMs === 'number' && Number.isFinite(event.quietWindowMs)
      ? Math.max(0, Math.floor(event.quietWindowMs))
      : undefined;
  const hasRelevantRequestGroup =
    requestGroup === 'relevant' ||
    requestGroup === 'current-node' ||
    requestGroup === 'current-frame';
  const hasQuietWindow = quietWindowMs !== undefined && quietWindowMs >= 750;
  const strongEvidence = !longLived && hasRelevantRequestGroup && hasQuietWindow;
  return {
    op: 'addWaitBefore',
    nodeId,
    status: strongEvidence ? 'autoPatch' : 'suggestion',
    reason: strongEvidence
      ? 'A preceding step produced relevant current-frame network activity followed by a bounded quiet window.'
      : 'A preceding step produced current-frame network activity, but relevant request group and quiet-window evidence are required before automatic network-idle repair.',
    confidence: strongEvidence ? 0.9 : 0.72,
    condition: { kind: 'networkIdle', idleMs: quietWindowMs ?? 750 },
    evidence: {
      runId: run.id,
      observedNodeId,
      eventType: 'network.observed',
      resourceType,
      currentFrame: true,
      ...(requestGroup ? { requestGroup } : {}),
      ...(quietWindowMs !== undefined ? { quietWindowMs } : {}),
      ...(longLived ? { longLived } : {}),
    },
  };
}

function chooseWaitRepairObservation(
  flow: FlowV3,
  runs: WorkflowDebugRun[],
  nodeId: string,
): WaitRepairPlan | undefined {
  const predecessorIds = new Set(getIncomingEdges(flow, nodeId).map((edge) => edge.from));
  const observedNodeIds = new Set<string>([nodeId, ...predecessorIds]);
  const candidates: WaitRepairPlan[] = [];
  for (const run of runs) {
    for (const event of run.events) {
      const selectorPlan = buildSelectorWaitPlanFromEvent(run, event, nodeId);
      if (selectorPlan) candidates.push(selectorPlan);
      const navigationPlan = buildNavigationWaitPlanFromEvent(run, event, nodeId, observedNodeIds);
      if (navigationPlan) candidates.push(navigationPlan);
      const networkPlan = buildNetworkIdleWaitPlanFromEvent(run, event, nodeId, observedNodeIds);
      if (networkPlan) candidates.push(networkPlan);
    }
  }
  return candidates.sort((left, right) => right.confidence - left.confidence)[0];
}

function planWaitRepairs(flow: FlowV3, runs: WorkflowDebugRun[]): WaitRepairPlan[] {
  const plans: WaitRepairPlan[] = [];
  const failedNodeIds = failedNodeIdsForWaitRepair(runs);
  for (const nodeId of failedNodeIds) {
    const node = flow.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.kind === 'wait') continue;
    const observationPlan = chooseWaitRepairObservation(flow, runs, nodeId);
    if (!observationPlan) {
      plans.push({
        op: 'addWaitBefore',
        nodeId,
        status: 'suggestion',
        reason: 'Recent failures look timing-related, but no navigation, network, or DOM visibility observation is available for a safe automatic wait patch.',
        confidence: 0.35,
        condition: { kind: 'selector', selector: getPrimarySelectorFromTarget(getNodeTarget(node)) ?? '', visible: true },
        evidence: {},
      });
      continue;
    }
    if (
      observationPlan.confidence >= 0.85 &&
      canInsertWaitBefore(flow, nodeId) &&
      !hasEquivalentWaitBefore(flow, nodeId, observationPlan.condition)
    ) {
      observationPlan.status = 'autoPatch';
    }
    plans.push(observationPlan);
  }
  return plans;
}

function buildWaitRepairRecommendations(plans: WaitRepairPlan[]): WorkflowRepairRecommendation[] {
  return plans.map((plan) => ({
    severity: plan.status === 'autoPatch' ? 'info' : 'warning',
    code: plan.status === 'autoPatch' ? 'bounded_wait_patch_available' : 'bounded_wait_suggestion',
    message:
      plan.status === 'autoPatch'
        ? `Observed timing evidence supports adding a bounded wait before ${plan.nodeId}; workflow_stabilize can apply and validate it.`
        : `A bounded wait before ${plan.nodeId} is suggested, but stronger observations or graph context are required before automatic patching.`,
    nodeId: plan.nodeId,
    ...(plan.status === 'autoPatch' ? { autoFix: 'wait_repair' as const } : {}),
  }));
}

function insertWaitBeforeNode(flow: FlowV3, plan: WaitRepairPlan): WorkflowRepairChange | undefined {
  if (plan.status !== 'autoPatch') return undefined;
  const targetNode = flow.nodes.find((node) => node.id === plan.nodeId);
  if (!targetNode || !canInsertWaitBefore(flow, plan.nodeId)) return undefined;
  if (hasEquivalentWaitBefore(flow, plan.nodeId, plan.condition)) return undefined;

  const waitNodeId = createUniqueFlowId(flow, `wait-before-${plan.nodeId}`);
  const waitEdgeId = createUniqueFlowId(flow, `edge-${waitNodeId}-${plan.nodeId}`);
  const waitNode: FlowV3['nodes'][number] = {
    id: waitNodeId as FlowV3['entryNodeId'],
    kind: 'wait',
    name: `Wait before ${targetNode.name || targetNode.kind}`,
    config: { condition: plan.condition },
  };
  const targetIndex = flow.nodes.findIndex((node) => node.id === plan.nodeId);
  flow.nodes.splice(targetIndex >= 0 ? targetIndex : flow.nodes.length, 0, waitNode);

  const incoming = getIncomingEdges(flow, plan.nodeId);
  if (incoming.length > 0) {
    for (const edge of flow.edges) {
      if (edge.to === plan.nodeId) {
        edge.to = waitNodeId as FlowV3['entryNodeId'];
      }
    }
  }
  if (flow.entryNodeId === plan.nodeId) {
    flow.entryNodeId = waitNodeId as FlowV3['entryNodeId'];
  }
  flow.edges.push({
    id: waitEdgeId as FlowV3['edges'][number]['id'],
    from: waitNodeId as FlowV3['entryNodeId'],
    to: plan.nodeId as FlowV3['entryNodeId'],
  });

  return {
    code: 'bounded_wait_added',
    message: `Added a bounded ${plan.condition.kind} wait before ${plan.nodeId}.`,
    nodeId: plan.nodeId,
    reason: plan.reason,
    confidence: plan.confidence,
    patch: {
      op: 'addWaitBefore',
      nodeId: plan.nodeId,
      waitNodeId,
      condition: plan.condition,
      confidence: plan.confidence,
      evidence: plan.evidence,
    },
  };
}

function applyWaitRepairPlans(flow: FlowV3, plans: WaitRepairPlan[]): WorkflowRepairChange[] {
  const changes: WorkflowRepairChange[] = [];
  for (const plan of plans) {
    const change = insertWaitBeforeNode(flow, plan);
    if (change) changes.push(change);
  }
  return changes;
}

function buildAssertionRepairSuggestions(flow: FlowV3, runs: WorkflowDebugRun[]): AssertionRepairSuggestion[] {
  if ((Array.isArray(flow.nodes) ? flow.nodes : []).some((node) => node.kind === 'assert')) {
    return [];
  }
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const terminalNode =
    nodes.find((node) => getOutgoingEdges(flow, node.id).length === 0) ?? nodes[nodes.length - 1];
  const latestVisibleEvent = runs
    .flatMap((run) => run.events.map((event) => ({ run, event })))
    .reverse()
    .find(({ run, event }) => {
      return (
        run.status === 'succeeded' &&
        event.type === 'dom.visibility' &&
        typeof event.selector === 'string' &&
        (event.status === 'appeared' || event.status === 'stable') &&
        (typeof event.matchCount !== 'number' || event.matchCount > 0)
      );
    });

  if (latestVisibleEvent && typeof latestVisibleEvent.event.selector === 'string') {
    return [
      {
        op: 'addAssertAfter',
        nodeId: getEventNodeId(latestVisibleEvent.event) ?? terminalNode?.id,
        status: 'suggestion',
        reason:
          'A successful run observed a stable visible element. Add an assertion only if this element represents the business outcome.',
        confidence: 0.62,
        assertion: { kind: 'visible', selector: latestVisibleEvent.event.selector },
        evidence: {
          runId: latestVisibleEvent.run.id,
          eventType: 'dom.visibility',
          selector: latestVisibleEvent.event.selector,
        },
      },
    ];
  }

  return [
    {
      op: 'addAssertAfter',
      ...(terminalNode ? { nodeId: terminalNode.id } : {}),
      status: 'suggestion',
      reason:
        'No assertion checkpoint exists. Add a structured assertion for the expected business outcome before marking the workflow verified.',
      confidence: 0.4,
    },
  ];
}

function buildAssertionRepairRecommendations(
  suggestions: AssertionRepairSuggestion[],
): WorkflowRepairRecommendation[] {
  return suggestions.map((suggestion) => ({
    severity: 'warning',
    code: 'assertion_checkpoint_suggestion',
    message: suggestion.assertion
      ? 'A candidate assertion checkpoint is available from successful-run observations, but it requires user confirmation before writing.'
      : 'No assertion checkpoint exists; add a structured business outcome assertion before requiring verified quality.',
    ...(suggestion.nodeId ? { nodeId: suggestion.nodeId } : {}),
  }));
}

function scoreStabilizeRuns(runs: WorkflowStabilizeRunSummary[]): WorkflowStabilizeScore {
  const passedRuns = runs.filter((run) => run.success).length;
  const failedRuns = runs.filter((run) => !run.success).length;
  const total = passedRuns + failedRuns;
  return {
    passRate: total > 0 ? passedRuns / total : 0,
    passedRuns,
    failedRuns,
    iterations: runs.length,
  };
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`)
    .join(',')}}`;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function getWorkflowQualityHmacSalt(): Promise<string> {
  const storageKey = 'workflowQualityHmacSalt';
  try {
    const stored = await chrome.storage.local.get(storageKey);
    const existing = stored?.[storageKey];
    if (typeof existing === 'string' && existing.length >= 16) {
      return existing;
    }
    const random = new Uint8Array(32);
    globalThis.crypto.getRandomValues(random);
    const salt = bytesToHex(random.buffer);
    await chrome.storage.local.set({ [storageKey]: salt });
    return salt;
  } catch {
    if (!fallbackQualityHmacSalt) {
      const random = new Uint8Array(32);
      if (globalThis.crypto?.getRandomValues) {
        globalThis.crypto.getRandomValues(random);
        fallbackQualityHmacSalt = bytesToHex(random.buffer);
      } else {
        fallbackQualityHmacSalt = `${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2)}`;
      }
    }
    return fallbackQualityHmacSalt;
  }
}

async function createWorkflowArgsHash(args: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto HMAC is unavailable for workflow quality argsHash');
  }
  const encoder = new TextEncoder();
  const salt = await getWorkflowQualityHmacSalt();
  const key = await subtle.importKey(
    'raw',
    encoder.encode(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await subtle.sign('HMAC', key, encoder.encode(stableSerialize(args ?? {})));
  return `hmac-sha256:${bytesToHex(signature)}`;
}

function fnv1aForPublicFingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function createPublicStringHash(value: string | undefined): string | undefined {
  return value ? `fnv1a32:${fnv1aForPublicFingerprint(value)}` : undefined;
}

function getExtensionVersion(): string | undefined {
  try {
    return chrome.runtime.getManifest?.().version;
  } catch {
    return undefined;
  }
}

function inferValidationSiteFingerprint(flow: FlowV3, args: any): string | undefined {
  const candidate =
    typeof args?.startUrl === 'string' && args.startUrl.trim()
      ? args.startUrl.trim()
      : flow.meta?.recording?.originUrl;
  if (!candidate) {
    return undefined;
  }
  try {
    const url = new URL(candidate);
    return `url:${url.origin}${url.pathname}`;
  } catch {
    return createPublicStringHash(candidate);
  }
}

function isWorkflowAssertionNodeKind(kind: unknown): boolean {
  return kind === 'assert' || kind === 'expect' || kind === 'assertion';
}

function getExecutableAssertionNodeIds(flow: FlowV3): Set<string> {
  return new Set(
    (flow.nodes || [])
      .filter((node) => node.disabled !== true && isWorkflowAssertionNodeKind(node.kind))
      .map((node) => String(node.id)),
  );
}

function getSuccessfulAssertionNodeIds(flow: FlowV3, events: RunEvent[] | undefined): string[] {
  const assertionNodeIds = getExecutableAssertionNodeIds(flow);
  if (assertionNodeIds.size === 0 || !Array.isArray(events)) {
    return [];
  }
  return Array.from(
    new Set(
      events
        .filter(
          (event): event is Extract<RunEvent, { type: 'node.succeeded' }> =>
            event.type === 'node.succeeded' && assertionNodeIds.has(String(event.nodeId)),
        )
        .map((event) => String(event.nodeId)),
    ),
  );
}

function countedRunsSatisfiedAssertionOracle(runs: WorkflowStabilizeRunSummary[]): boolean {
  const successfulRuns = runs.filter((run) => run.success);
  return (
    successfulRuns.length > 0 &&
    successfulRuns.every((run) => (run.verifiedAssertionNodeIds?.length ?? 0) > 0)
  );
}

function inferWorkflowVerification(
  flow: FlowV3,
  stable: boolean,
  countedRuns: WorkflowStabilizeRunSummary[],
): NonNullable<FlowQualityMeta['verification']> {
  const assertionNodeIds = getExecutableAssertionNodeIds(flow);
  if (assertionNodeIds.size > 0 && countedRunsSatisfiedAssertionOracle(countedRuns)) {
    return {
      oracle: 'assertion',
      oracleStrength: 'normal',
      ...(stable ? { verifiedAt: new Date().toISOString() } : {}),
    };
  }
  if (assertionNodeIds.size > 0) {
    return {
      oracle: 'none',
      oracleStrength: 'weak',
      missingReason:
        'Assertion nodes exist, but no counted successful validation run recorded successful assertion execution.',
    };
  }
  if (Array.isArray(flow.meta?.exposedOutputs) && flow.meta.exposedOutputs.length > 0) {
    return {
      oracle: 'declaredOutput',
      oracleStrength: 'weak',
      missingReason: 'Declared outputs are exposed but output validation is not enabled yet.',
    };
  }
  return {
    oracle: 'none',
    oracleStrength: 'weak',
    missingReason: 'No assert node, declared output validation, or expected outcome is configured.',
  };
}

function calculateStabilityScore(
  score: WorkflowStabilizeScore,
  minValidationRuns: number,
  capabilities: WorkflowCapabilityMatrix,
  current: boolean,
): number {
  const sampleFactor = Math.min(1, score.iterations / Math.max(1, minValidationRuns));
  const unsupportedCount = capabilities.unsupportedReasons.length;
  const capabilityFactor = Math.max(0.7, 1 - unsupportedCount * 0.03);
  const freshnessFactor = current ? 1 : 0.5;
  return Number((score.passRate * sampleFactor * capabilityFactor * freshnessFactor).toFixed(4));
}

function getLastFailure(runs: WorkflowStabilizeRunSummary[]):
  | { nodeId?: string; code?: string; runId?: string }
  | undefined {
  const failed = [...runs].reverse().find((run) => !run.success);
  if (!failed) return undefined;
  return {
    ...(failed.failedNodeId ?? failed.currentNodeId
      ? { nodeId: failed.failedNodeId ?? failed.currentNodeId }
      : {}),
    ...(failed.errorCode ? { code: failed.errorCode } : {}),
    ...(failed.runId ? { runId: failed.runId } : {}),
  };
}

function buildValidationEnvironmentContext(args: any): Partial<NonNullable<FlowQualityMeta['validationContext']>> {
  const context: Partial<NonNullable<FlowQualityMeta['validationContext']>> = {};
  const legacyTestEnvironment =
    typeof args?.safety?.testEnvironment === 'string' && args.safety.testEnvironment.trim()
      ? args.safety.testEnvironment.trim()
      : '';
  if (legacyTestEnvironment) {
    context.testEnvironment = legacyTestEnvironment;
  }

  const testEnvironment = getStabilizeTestEnvironment(args);
  if (testEnvironment) {
    const name = typeof testEnvironment.name === 'string' ? testEnvironment.name.trim() : '';
    const accountLabel =
      typeof testEnvironment.accountLabel === 'string' ? testEnvironment.accountLabel.trim() : '';
    const origins = normalizeBoundaryStrings(testEnvironment.origins);
    const pathPrefixes = normalizeBoundaryStrings(testEnvironment.pathPrefixes);
    if (name) {
      context.testEnvironment = name;
    }
    const accountLabelHash = createPublicStringHash(accountLabel);
    if (accountLabelHash) {
      context.accountLabel = accountLabelHash;
    }
    if (origins.length > 0) {
      context.testEnvironmentOrigins = origins;
    }
    if (pathPrefixes.length > 0) {
      context.testEnvironmentPathPrefixes = pathPrefixes;
    }
  }

  const allowedHosts = normalizeBoundaryStrings(args?.safety?.allowedHosts);
  if (allowedHosts.length > 0) {
    context.allowedHosts = allowedHosts;
  }

  return context;
}

async function buildStabilizeQualityRecord(options: {
  flow: FlowV3;
  args: any;
  risk: WorkflowRiskProfile;
  executionMode: string;
  runs: WorkflowStabilizeRunSummary[];
  revision: string;
  minPassRate: number;
  minValidationRuns: number;
  capabilities: WorkflowCapabilityMatrix;
  warnings: WorkflowStabilizeWarning[];
  runGroupId?: string;
}): Promise<FlowQualityMeta> {
  const now = new Date();
  const freshnessExpiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const segmentOnly =
    options.args?.safety?.segments?.mode === 'explicit' ||
    options.args?.safety?.segments?.mode === 'stopBeforeDangerous' ||
    options.runs.some((run) => isBoundaryStoppedStatus(run.status));
  const countedRuns = segmentOnly ? [] : options.runs;
  const countedScore = scoreStabilizeRuns(countedRuns);
  const stable =
    countedScore.iterations >= options.minValidationRuns &&
    countedScore.passRate >= options.minPassRate;
  const verification = inferWorkflowVerification(options.flow, stable, countedRuns);
  const level = stable && verification.oracle === 'assertion' ? 'verified' : stable ? 'stable' : 'unverified';
  const stabilityScore = calculateStabilityScore(
    countedScore,
    options.minValidationRuns,
    options.capabilities,
    true,
  );
  const runIds = options.runs
    .map((run) => run.runId)
    .filter((runId): runId is string => Boolean(runId));
  const lastFailure = getLastFailure(options.runs);
  const siteFingerprint = inferValidationSiteFingerprint(options.flow, options.args);
  const locale = globalThis.navigator?.language;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const userAgentHash = createPublicStringHash(globalThis.navigator?.userAgent);
  const extensionVersion = getExtensionVersion();
  const validationEnvironment = buildValidationEnvironmentContext(options.args);
  const validationStartUrl =
    typeof options.args?.startUrl === 'string' && options.args.startUrl.trim()
      ? options.args.startUrl.trim()
      : undefined;
  const validationContext: NonNullable<FlowQualityMeta['validationContext']> = {
    argsHash: await createWorkflowArgsHash(options.args?.args ?? {}),
    argsHashAlgorithm: 'hmac-sha256',
    ...(validationStartUrl ? { startUrl: redactUrl(validationStartUrl) } : {}),
    tabTarget: options.args?.tabTarget === 'new' ? 'new' : 'current',
    background: options.args?.background === true,
    executionMode: options.executionMode,
    ...validationEnvironment,
    ...(siteFingerprint ? { siteFingerprint } : {}),
    runGroupId: options.runGroupId ?? `stabilize-${Date.now().toString(36)}`,
    tabOwnership: options.args?.tabTarget === 'new' ? 'owned' : 'current',
    ...(locale ? { locale } : {}),
    ...(timezone ? { timezone } : {}),
    ...(userAgentHash ? { userAgentHash } : {}),
    ...(extensionVersion ? { extensionVersion } : {}),
    protocolVersion: WEBPAGE_MCP_PROTOCOL_VERSION,
    capabilityVersion: WEBPAGE_MCP_CAPABILITY_VERSION,
  };
  const excludedRuns = segmentOnly
    ? { count: options.runs.length, reasons: ['segment_only'] }
    : { count: 0, reasons: [] };
  const validationRecord: NonNullable<FlowQualityMeta['validationRecords']>[number] = {
    id: `validation-${Date.now().toString(36)}`,
    tool: TOOL_NAMES.RECORD_REPLAY.WORKFLOW_STABILIZE,
    revision: options.revision,
    runGroupId: validationContext.runGroupId,
    completedAt: now.toISOString(),
    phase: options.runs.some((run) => run.phase === 'postRepair') ? 'postRepair' : 'baseline',
    passRate: countedScore.passRate,
    stabilityScore,
    countedRuns: countedScore.iterations,
    passedRuns: countedScore.passedRuns,
    failedRuns: countedScore.failedRuns,
    excludedRuns,
    runIds,
    validationContext,
    risk: options.risk,
    segmentOnly,
  };
  const previousRecords = Array.isArray(options.flow.meta?.quality?.validationRecords)
    ? options.flow.meta.quality.validationRecords
    : [];

  return {
    ...(options.flow.meta?.quality ?? {}),
    lastStabilizedAt: now.toISOString(),
    lastValidatedAt: now.toISOString(),
    freshnessExpiresAt,
    revision: options.revision,
    status: level === 'verified' ? 'verified' : level === 'stable' ? 'stable' : 'draft',
    level,
    stabilityScore,
    passRate: countedScore.passRate,
    validationRuns: options.runs.length,
    countedValidationRuns: countedScore.iterations,
    passedRuns: countedScore.passedRuns,
    failedRuns: countedScore.failedRuns,
    excludedRuns,
    minValidationRuns: options.minValidationRuns,
    ...(lastFailure?.nodeId ? { lastFailureNodeId: lastFailure.nodeId as FlowV3['entryNodeId'] } : {}),
    ...(lastFailure?.code ? { lastFailureCode: lastFailure.code } : {}),
    risk: options.risk,
    validationContext,
    verification,
    capabilities: options.capabilities,
    consecutiveFailureCount: countedScore.failedRuns > 0 ? countedScore.failedRuns : 0,
    ...(stable ? { staleReason: undefined } : { staleReason: 'validation_failed' }),
    revalidation: {
      policy: 'onFailure',
      nextRevalidateAt: freshnessExpiresAt,
      autoDowngrade: true,
      lastRevalidateReason: 'workflow_stabilize',
    },
    slo: {
      targetPassRate: options.minPassRate,
      minValidationRuns: options.minValidationRuns,
    },
    artifactRunIds: lastFailure?.runId ? [lastFailure.runId] : [],
    warnings: options.warnings.map((warning) => warning.code).slice(0, 30),
    validationRecords: [...previousRecords, validationRecord].slice(-20),
  };
}

function summarizeStabilizeRunResult(
  flow: FlowV3,
  phase: WorkflowStabilizeRunSummary['phase'],
  iteration: number,
  revision: string,
  result: Awaited<ReturnType<typeof enqueueRunAndWait>>,
): WorkflowStabilizeRunSummary {
  const { run, result: runResult } = result;
  const verifiedAssertionNodeIds = getSuccessfulAssertionNodeIds(flow, result.events);
  const debugArgs = runResult.debug?.debugArgs
    ? { ...runResult.debug.debugArgs }
    : runResult.success === false
      ? {
          runId: runResult.runId,
          flowId: run.flowId,
          ...(runResult.currentNodeId ? { nodeId: runResult.currentNodeId } : {}),
          maxEvents: 100,
          includeArtifacts: true,
        }
      : undefined;
  return {
    phase,
    iteration,
    runId: runResult.runId || run.id,
    status: run.status ?? runResult.status ?? (runResult.success ? 'succeeded' : 'failed'),
    success: runResult.success === true,
    ...(verifiedAssertionNodeIds.length > 0 ? { verifiedAssertionNodeIds } : {}),
    ...(runResult.currentNodeId ? { currentNodeId: runResult.currentNodeId } : {}),
    ...(runResult.failedNodeId ? { failedNodeId: runResult.failedNodeId } : {}),
    ...(runResult.errorCode ? { errorCode: runResult.errorCode } : {}),
    ...(runResult.error?.message ? { errorMessage: runResult.error.message } : {}),
    tookMs: runResult.summary?.tookMs ?? run.tookMs,
    revision,
    ...(debugArgs ? { debugArgs } : {}),
  };
}

function buildValidationDebugRun(
  flow: FlowV3,
  result: Awaited<ReturnType<typeof enqueueRunAndWait>>,
): WorkflowDebugRun {
  const { run, events } = result;
  const sensitiveVariableNames = getSensitiveVariableNames(flow);
  const now = Date.now();
  const rawEvents = Array.isArray(events) ? (events as RunEvent[]) : [];
  const artifacts = buildDebugArtifacts([], rawEvents, false, 0);
  return {
    id: run.id,
    status: run.status,
    createdAt: typeof run.createdAt === 'number' ? run.createdAt : now,
    updatedAt: typeof run.updatedAt === 'number' ? run.updatedAt : now,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.tookMs !== undefined ? { tookMs: run.tookMs } : {}),
    ...(run.tabId !== undefined ? { tabId: run.tabId } : {}),
    ...(run.currentNodeId !== undefined ? { currentNodeId: run.currentNodeId } : {}),
    attempt: typeof run.attempt === 'number' ? run.attempt : 0,
    maxAttempts: typeof run.maxAttempts === 'number' ? run.maxAttempts : 1,
    ...(run.args ? { args: sanitizeRunObject(run.args, sensitiveVariableNames) } : {}),
    ...(run.execution ? { execution: run.execution } : {}),
    ...(run.error ? { error: sanitizeError(run.error, sensitiveVariableNames) } : {}),
    ...(run.outputs ? { outputs: sanitizeRunObject(run.outputs, sensitiveVariableNames) } : {}),
    events: rawEvents.map((event) => sanitizeEvent(event, sensitiveVariableNames)),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
}

function summarizeStabilizeRunError(
  phase: WorkflowStabilizeRunSummary['phase'],
  iteration: number,
  revision: string,
  error: unknown,
): WorkflowStabilizeRunSummary {
  if (isResourceLimitError(error)) {
    const resourceError = createResourceLimitExceededError(
      'Stabilize validation run hit a runtime resource limit',
      error,
      { source: 'workflow_stabilize' },
    );
    return {
      phase,
      iteration,
      status: 'failed',
      success: false,
      errorCode: resourceError.code,
      errorCategory: 'resource',
      errorMessage: resourceError.message,
      revision,
    };
  }
  return {
    phase,
    iteration,
    status: 'failed',
    success: false,
    errorCode: 'STABILIZE_RUN_FAILED',
    errorMessage: error instanceof Error ? error.message : String(error),
    revision,
  };
}

async function executeStabilizeValidationRuns(
  flow: FlowV3,
  args: any,
  phase: WorkflowStabilizeRunSummary['phase'],
  iterations: number,
  revision: string,
  warnings: WorkflowStabilizeWarning[],
  segmentPlan: WorkflowSegmentPlan,
  resetPlan?: WorkflowResetPlan,
  options: {
    stopAfterTargetRun?: (
      targetDebugRuns: WorkflowDebugRun[],
      targetRuns: WorkflowStabilizeRunSummary[],
    ) => boolean;
  } = {},
): Promise<WorkflowStabilizeValidationRuns> {
  const runs: WorkflowStabilizeRunSummary[] = [];
  const resetRuns: WorkflowStabilizeRunSummary[] = [];
  const targetDebugRuns: WorkflowDebugRun[] = [];
  const normalizedStartUrl =
    typeof args?.startUrl === 'string' && args.startUrl.trim() ? args.startUrl.trim() : undefined;
  const execution = {
    disallowLocalFileUploads: true,
    disallowLocalFilePages: true,
    redactDownloadPaths: true,
    ...(args?.background === true ? { backgroundTabs: true } : {}),
  };
  const stopBeforeNodeId = segmentPlan.stopBeforeNodeId;
  const endNodeId = segmentPlan.endNodeId;

  for (let index = 0; index < iterations; index += 1) {
    if (resetPlan && resetPlan.maxRuns > 0) {
      let resetSucceeded = false;
      for (let resetAttempt = 0; resetAttempt < resetPlan.maxRuns; resetAttempt += 1) {
        try {
          const resetResult = await enqueueRunAndWait({
            flowId: resetPlan.flow.id as FlowId,
            expectedRevision: resetPlan.revision,
            tabId:
              typeof args?.tabId === 'number' && Number.isFinite(args.tabId)
                ? Math.floor(args.tabId)
                : undefined,
            tabTarget: args?.tabTarget === 'new' ? 'new' : 'current',
            args: resetPlan.args as any,
            execution,
            refresh: resetAttempt > 0,
          });
          const resetSummary = summarizeStabilizeRunResult(
            resetPlan.flow,
            'reset',
            index + 1,
            resetPlan.revision,
            resetResult,
          );
          resetRuns.push(resetSummary);
          if (resetSummary.success) {
            resetSucceeded = true;
            break;
          }
        } catch (error) {
          const resetError = summarizeStabilizeRunError('reset', index + 1, resetPlan.revision, error);
          resetRuns.push(resetError);
          if (resetError.errorCategory === 'resource') {
            warnings.push({
              code: RR_ERROR_CODES.RESOURCE_LIMIT_EXCEEDED,
              category: 'resource',
              message: resetError.errorMessage ?? 'Reset workflow hit a runtime resource limit.',
            });
          }
          break;
        }
      }
      if (!resetSucceeded) {
        warnings.push({
          code: 'STABILIZE_RESET_FAILED',
          category: 'safety',
          message:
            'Reset workflow failed before target validation; target workflow passRate was not updated from this iteration.',
        });
        break;
      }
    }

    try {
      const result = await enqueueRunAndWait({
        flowId: flow.id as FlowId,
        expectedRevision: revision,
        tabId:
          typeof args?.tabId === 'number' && Number.isFinite(args.tabId)
            ? Math.floor(args.tabId)
            : undefined,
        tabTarget: args?.tabTarget === 'new' ? 'new' : 'current',
        args: args?.args && typeof args.args === 'object' ? args.args : undefined,
        execution,
        startUrl: normalizedStartUrl,
        refresh: index > 0 || args?.refresh === true,
        ...(stopBeforeNodeId ? { stopBeforeNodeId } : {}),
        ...(endNodeId ? { endNodeId } : {}),
      });
      const summary = summarizeStabilizeRunResult(flow, phase, index + 1, revision, result);
      runs.push(summary);
      targetDebugRuns.push(buildValidationDebugRun(flow, result));
      if (options.stopAfterTargetRun?.(targetDebugRuns, runs)) {
        break;
      }
    } catch (error) {
      const runError = summarizeStabilizeRunError(phase, index + 1, revision, error);
      warnings.push({
        code: runError.errorCode === RR_ERROR_CODES.RESOURCE_LIMIT_EXCEEDED
          ? RR_ERROR_CODES.RESOURCE_LIMIT_EXCEEDED
          : 'STABILIZE_RUN_FAILED',
        category: runError.errorCategory === 'resource' ? 'resource' : 'capability',
        message: runError.errorMessage ?? (error instanceof Error ? error.message : String(error)),
      });
      runs.push(runError);
      break;
    }
  }

  return { targetRuns: runs, resetRuns, targetDebugRuns };
}

type WorkflowRepairSource = 'workflow_repair' | 'workflow_stabilize';

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createWorkflowRepairRollbackSnapshot(flow: FlowV3): JsonObject {
  const snapshot: Record<string, unknown> = {
    entryNodeId: flow.entryNodeId,
    nodes: cloneJson(flow.nodes ?? []),
    edges: cloneJson(flow.edges ?? []),
    variables: cloneJson(flow.variables ?? []),
  };

  if (flow.policy) {
    snapshot.policy = cloneJson(flow.policy);
  }

  const metaSnapshot: Record<string, unknown> = {};
  for (const field of [
    'domain',
    'tags',
    'bindings',
    'tool',
    'exposedOutputs',
    'recording',
    'stopBarrier',
    'quality',
    'runtime',
  ] as const) {
    const value = flow.meta?.[field];
    if (value !== undefined) {
      metaSnapshot[field] = cloneJson(value);
    }
  }
  if (Object.keys(metaSnapshot).length > 0) {
    snapshot.meta = metaSnapshot;
  }

  return cloneJson(snapshot) as JsonObject;
}

function isWorkflowRepairRollbackSnapshot(value: unknown): value is JsonObject {
  return (
    isRecord(value) &&
    typeof value.entryNodeId === 'string' &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges)
  );
}

function summarizeWorkflowRepairRollbackSnapshot(snapshot: JsonObject): Record<string, unknown> {
  return {
    entryNodeId: snapshot.entryNodeId,
    nodeCount: Array.isArray(snapshot.nodes) ? snapshot.nodes.length : 0,
    edgeCount: Array.isArray(snapshot.edges) ? snapshot.edges.length : 0,
    variableCount: Array.isArray(snapshot.variables) ? snapshot.variables.length : 0,
    hasPolicy: Boolean(snapshot.policy),
    metaFields: isRecord(snapshot.meta) ? Object.keys(snapshot.meta).sort() : [],
  };
}

function restoreWorkflowGraphFromRepairSnapshot(flow: FlowV3, snapshot: JsonObject): FlowV3 {
  const restored: FlowV3 = {
    ...flow,
    entryNodeId: snapshot.entryNodeId as FlowV3['entryNodeId'],
    nodes: cloneJson(snapshot.nodes) as unknown as FlowV3['nodes'],
    edges: cloneJson(snapshot.edges) as unknown as FlowV3['edges'],
    variables: Array.isArray(snapshot.variables)
      ? (cloneJson(snapshot.variables) as unknown as FlowV3['variables'])
      : [],
    updatedAt: new Date().toISOString() as FlowV3['updatedAt'],
    meta: {
      ...(isRecord(snapshot.meta) ? (cloneJson(snapshot.meta) as FlowV3['meta']) : {}),
      ...(flow.meta?.repairs ? { repairs: flow.meta.repairs } : {}),
      ...(flow.meta?.audit ? { audit: flow.meta.audit } : {}),
    },
  };

  if (isRecord(snapshot.policy)) {
    restored.policy = cloneJson(snapshot.policy) as FlowV3['policy'];
  } else {
    delete restored.policy;
  }

  return restored;
}

function markWorkflowRepairRolledBack(
  flow: FlowV3,
  repairRevision: string,
  rollbackRevision: string,
): FlowV3 {
  const repairs = flow.meta?.repairs;
  if (!repairs?.history?.length) {
    return flow;
  }

  const history = repairs.history.map((entry) => {
    if (entry.repairRevision !== repairRevision) {
      return entry;
    }
    return {
      ...entry,
      rollbackRevision,
      rollback: {
        ...(entry.rollback ?? {}),
        available: false,
        reason: 'Rollback applied; workflow definition was restored to the pre-repair snapshot.',
      },
    };
  });
  const nextRepairs = {
    ...repairs,
    history,
  };
  if (nextRepairs.currentRepairRevision === repairRevision) {
    delete nextRepairs.currentRepairRevision;
  }

  return {
    ...flow,
    meta: {
      ...(flow.meta ?? {}),
      repairs: nextRepairs,
    },
  };
}

function findWorkflowRepairRollbackEntry(
  flow: FlowV3,
  repairRevision?: string,
): FlowRepairHistoryEntry | undefined {
  const history = Array.isArray(flow.meta?.repairs?.history) ? flow.meta.repairs.history : [];
  const candidates = repairRevision
    ? history.filter((entry) => entry.repairRevision === repairRevision)
    : [...history].reverse();
  return candidates.find(
    (entry) =>
      entry.rollback?.available === true &&
      isWorkflowRepairRollbackSnapshot(entry.rollback.snapshot),
  );
}

function recordWorkflowRepairHistory(
  flow: FlowV3,
  beforeRevision: string,
  changes: WorkflowRepairChange[],
  source: WorkflowRepairSource,
  rollbackSnapshot?: JsonObject,
): string | undefined {
  if (changes.length === 0) return undefined;
  const meta = { ...(flow.meta ?? {}) };
  const existing = Array.isArray(meta.repairs?.history) ? meta.repairs.history : [];
  const repairRevision = `repair-${Date.now().toString(36)}`;
  const selectorChange = changes.find((change) => change.code === 'selector_target_replaced');
  const pageContentUsed = changes.some(
    (change) => change.code === 'selector_target_replaced' || change.code === 'bounded_wait_added',
  );
  const tool =
    source === 'workflow_repair'
      ? TOOL_NAMES.RECORD_REPLAY.WORKFLOW_REPAIR
      : TOOL_NAMES.RECORD_REPLAY.WORKFLOW_STABILIZE;
  const resultingRevision = calculateWorkflowRevision(flow);
  meta.repairs = {
    ...(meta.repairs ?? {}),
    currentRepairRevision: repairRevision,
    history: [
      ...existing.slice(-19),
      {
        repairRevision,
        baseRevision: beforeRevision,
        resultingRevision,
        appliedAt: new Date().toISOString(),
        patchSummary: changes.map((change) => change.code).join(', '),
        changes: changes.map((change) => ({ ...change })),
        provenance: {
          source,
          pageContentUsed,
        },
        ...(selectorChange?.beforeQuality ? { beforeQuality: selectorChange.beforeQuality.score } : {}),
        ...(selectorChange?.afterQuality ? { afterQuality: selectorChange.afterQuality.score } : {}),
        rollback: {
          beforeRevision,
          available: Boolean(rollbackSnapshot),
          reason: rollbackSnapshot
            ? 'Rollback restores the workflow definition only; external side effects are not reversible.'
            : 'Workflow rollback metadata is recorded; external side effects are not reversible.',
          ...(rollbackSnapshot ? { snapshot: rollbackSnapshot } : {}),
        },
      },
    ],
  };
  flow.meta = meta;
  let audited = appendWorkflowAuditEvent(flow, {
    kind: 'repair_apply',
    actor: 'mcp',
    revision: calculateWorkflowRevision(flow),
    reason: `${source}_apply`,
    metadata: {
      tool,
      baseRevision: beforeRevision,
      resultingRevision,
      repairRevision,
      changeCount: changes.length,
      changeCodes: changes.map((change) => change.code).slice(0, 30),
      nodeIds: changes
        .map((change) => change.nodeId)
        .filter((nodeId): nodeId is string => typeof nodeId === 'string' && nodeId.length > 0)
        .slice(0, 30),
      pageContentUsed,
    },
  });
  if (
    changes.some((change) =>
      ['default_timeout_added', 'default_retry_added', 'failure_screenshot_added'].includes(change.code),
    )
  ) {
    audited = appendWorkflowAuditEvent(audited, {
      kind: 'policy_change',
      actor: 'mcp',
      revision: calculateWorkflowRevision(audited),
      reason: `${source}_default_policy`,
      metadata: {
        tool,
        changeCodes: changes
          .map((change) => change.code)
          .filter((code) =>
            ['default_timeout_added', 'default_retry_added', 'failure_screenshot_added'].includes(code),
          )
          .slice(0, 30),
      },
    });
  }
  flow.meta = audited.meta;
  return repairRevision;
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

    let flow = await resolveFlowForWorkflowTool(args);
    if (!flow) {
      return createErrorResponse(
        requestedFlowId
          ? `Flow not found: ${requestedFlowId}`
          : `Published workflow not found: ${requestedWorkflow}`,
      );
    }
    flow = await persistScheduledRevalidationCatchUp(flow);

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

  async execute(args: any, context?: ToolExecutionContext): Promise<ToolResult> {
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
    const clientCapabilities = normalizeMcpClientCapabilities(context);
    const requestedIncludeArtifacts = args?.includeArtifacts !== false;
    const includeArtifacts =
      requestedIncludeArtifacts &&
      !(clientCapabilities.mcp && !clientCapabilities.resourceReferences);
    const clientCapabilityWarnings = buildClientCapabilityWarnings(clientCapabilities, {
      includeArtifacts: requestedIncludeArtifacts,
    });
    const expiredArtifactCleanupCount = includeArtifacts
      ? await createStoragePort().artifacts.cleanupExpired(Date.now())
      : 0;
    const artifactCleanup = await cleanupDebugArtifactsForRun(flow, args);
    if (artifactCleanup && 'error' in artifactCleanup) {
      return createErrorResponse(artifactCleanup.error);
    }
    const runs = await collectDebugRuns(flow, {
      ...args,
      includeArtifacts,
      ...(includeArtifacts ? {} : { includeArtifactData: false }),
    });
    const descriptor = buildWorkflowToolDescriptor(flow);
    const capabilities = buildWorkflowCapabilityMatrix(flow, 'debug');
    const metrics = buildWorkflowRuntimeMetrics(flow, runs, capabilities);

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
              artifactCount: runs.reduce((sum, run) => sum + (run.artifacts?.length ?? 0), 0),
              expiredArtifactCleanupCount,
              capabilityStatus: {
                screenshots: capabilities.screenshots,
                navigationEvents: capabilities.navigationEvents,
                networkEvents: capabilities.networkEvents,
                mutationEvents: capabilities.mutationEvents,
                selectorResolution: capabilities.selectorResolution,
              },
              clientCapabilities: buildClientCapabilitySummary(clientCapabilities),
              sideEffects: descriptor.sideEffects.summary,
            },
            capabilities,
            metrics,
            audit: {
              events: flow.meta?.audit?.events ?? [],
            },
            artifactPolicy: {
              contentTrust: 'untrusted',
              dataInline: 'explicit_request_only_and_blocked_when_redaction_is_low_confidence',
              cleanup: artifactCleanup ?? { requested: false },
              resourceReferences:
                clientCapabilities.mcp && !clientCapabilities.resourceReferences
                  ? 'unavailable_client_capability_unconfirmed'
                  : 'available_or_not_required',
            },
            warnings: clientCapabilityWarnings,
            hints,
            selectorDiagnostics: buildSelectorDiagnostics(flow, runs),
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
    const selectorRepairPlansBeforeApply = planSelectorRepairs(flow, runs);
    const waitRepairPlansBeforeApply = planWaitRepairs(flow, runs);
    const assertionRepairSuggestionsBeforeApply = buildAssertionRepairSuggestions(flow, runs);
    const recommendationsBeforeApply = buildRepairRecommendations(flow, initialHints, runs);
    const shouldApply = args?.apply === true && args?.dryRun !== true;
    const initialRevision = calculateWorkflowRevision(flow);
    const rollbackSnapshot = shouldApply ? createWorkflowRepairRollbackSnapshot(flow) : undefined;
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
      recordWorkflowRepairHistory(flow, initialRevision, changes, 'workflow_repair', rollbackSnapshot);
      flow.updatedAt = new Date().toISOString();
      try {
        await saveFlowToV3(flow, {
          expectedRevision: initialRevision,
          revisionConflictMessage:
            'workflow_repair could not apply because the workflow changed while repair analysis was in progress',
        });
      } catch (error) {
        const conflict = getFlowRevisionConflict(error);
        if (conflict) {
          return createWorkflowRevisionConflictError(
            conflict,
            'workflow_repair could not apply because the workflow changed while repair analysis was in progress',
          );
        }
        throw error;
      }
    }

    const finalHints = shouldApply ? collectFlowHints(flow) : initialHints;
    const selectorRepairPlans = shouldApply
      ? planSelectorRepairs(flow, runs)
      : selectorRepairPlansBeforeApply;
    const waitRepairPlans = shouldApply
      ? planWaitRepairs(flow, runs)
      : waitRepairPlansBeforeApply;
    const assertionRepairSuggestions = shouldApply
      ? buildAssertionRepairSuggestions(flow, runs)
      : assertionRepairSuggestionsBeforeApply;
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
            selectorDiagnostics: buildSelectorDiagnostics(flow, runs),
            selectorRepairs: selectorRepairPlans,
            waitRepairs: waitRepairPlans,
            assertionRepairs: assertionRepairSuggestions,
            plannedAutoFixes,
            ...(shouldApply
              ? {
                  recommendationsBeforeApply,
                  selectorRepairsBeforeApply: selectorRepairPlansBeforeApply,
                  waitRepairsBeforeApply: waitRepairPlansBeforeApply,
                  assertionRepairsBeforeApply: assertionRepairSuggestionsBeforeApply,
                  plannedAutoFixesBeforeApply: recommendationsBeforeApply
                    .filter((recommendation) => recommendation.autoFix)
                    .map((recommendation) => recommendation.autoFix),
                }
              : {}),
            changes,
            ...(updated ? { audit: flow.meta?.audit?.events?.slice(-2) } : {}),
            ...(parameterization ? { parameterization } : {}),
          }),
        },
      ],
      isError: false,
    };
  }
}

function createWorkflowRepairRollbackError(
  code: string,
  message: string,
  metadata: Record<string, unknown> = {},
  retryable = false,
): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: {
            code,
            category: retryable ? 'conflict' : 'validation',
            retryable,
            message,
            ...metadata,
          },
        }),
      },
    ],
    isError: true,
  };
}

class WorkflowRepairRollbackTool {
  name = TOOL_NAMES.RECORD_REPLAY.WORKFLOW_REPAIR_ROLLBACK;

  async execute(args: any): Promise<ToolResult> {
    const requestedFlowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    const requestedWorkflow = typeof args?.workflow === 'string' ? args.workflow.trim() : '';
    if (!requestedFlowId && !requestedWorkflow) {
      return createWorkflowRepairRollbackError(
        'WORKFLOW_ROLLBACK_TARGET_REQUIRED',
        'flowId or workflow is required',
      );
    }
    if (requestedFlowId && requestedWorkflow) {
      return createWorkflowRepairRollbackError(
        'WORKFLOW_ROLLBACK_TARGET_CONFLICT',
        'Provide either flowId or workflow, not both',
      );
    }

    const resolved = await resolveFlowForWorkflowTool(args);
    if (!resolved) {
      return createWorkflowRepairRollbackError(
        'WORKFLOW_NOT_FOUND',
        requestedFlowId
          ? `Flow not found: ${requestedFlowId}`
          : `Published workflow not found: ${requestedWorkflow}`,
      );
    }

    try {
      return await withFlowWriteLock(resolved.id as FlowId, async () => {
        const flow = await resolveFlowForWorkflowTool(args);
        if (!flow) {
          return createWorkflowRepairRollbackError(
            'WORKFLOW_NOT_FOUND',
            requestedFlowId
              ? `Flow not found: ${requestedFlowId}`
              : `Published workflow not found: ${requestedWorkflow}`,
          );
        }

        const currentRevision = calculateWorkflowRevision(flow);
        const requiredRevision =
          typeof args?.requireCurrentRevision === 'string' ? args.requireCurrentRevision.trim() : '';
        if (requiredRevision && requiredRevision !== currentRevision) {
          return createWorkflowRepairRollbackError(
            'STALE_WORKFLOW_REVISION',
            'workflow_repair_rollback requireCurrentRevision does not match the current workflow revision',
            {
              requiredRevision,
              currentRevision,
            },
          );
        }

        const requestedRepairRevision =
          typeof args?.repairRevision === 'string' ? args.repairRevision.trim() : undefined;
        const entry = findWorkflowRepairRollbackEntry(flow, requestedRepairRevision);
        if (!entry || !isWorkflowRepairRollbackSnapshot(entry.rollback?.snapshot)) {
          return createWorkflowRepairRollbackError(
            'ROLLBACK_SNAPSHOT_NOT_FOUND',
            requestedRepairRevision
              ? `No rollback snapshot is available for repair revision ${requestedRepairRevision}`
              : 'No rollback snapshot is available for this workflow',
            {
              repairRevision: requestedRepairRevision,
            },
          );
        }

        const expectedCurrentRevision = entry.resultingRevision;
        if (
          expectedCurrentRevision &&
          expectedCurrentRevision !== currentRevision &&
          args?.force !== true
        ) {
          return createWorkflowRepairRollbackError(
            'STALE_REPAIR_ROLLBACK_REVISION',
            'Workflow has changed since the selected repair was applied; pass force true to rollback anyway.',
            {
              repairRevision: entry.repairRevision,
              expectedCurrentRevision,
              currentRevision,
            },
          );
        }

        const snapshot = entry.rollback.snapshot;
        const publishedInfo = getPublishedFlowInfo(flow);
        const selectedRepairRevision = entry.repairRevision ?? requestedRepairRevision ?? '';
        const snapshotSummary = summarizeWorkflowRepairRollbackSnapshot(snapshot);
        if (args?.dryRun === true) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  applied: false,
                  dryRun: true,
                  flowId: flow.id,
                  workflow: publishedInfo?.slug,
                  currentRevision,
                  rollback: {
                    repairRevision: selectedRepairRevision,
                    beforeRevision: entry.rollback.beforeRevision ?? entry.baseRevision,
                    expectedCurrentRevision,
                    snapshot: snapshotSummary,
                  },
                }),
              },
            ],
            isError: false,
          };
        }

        let restored = restoreWorkflowGraphFromRepairSnapshot(flow, snapshot);
        const restoredRevision = calculateWorkflowRevision(restored);
        restored = markWorkflowRepairRolledBack(
          restored,
          selectedRepairRevision,
          restoredRevision,
        );
        restored = appendWorkflowAuditEvent(restored, {
          kind: 'repair_rollback',
          actor: 'mcp',
          revision: restoredRevision,
          reason: 'workflow_repair_rollback',
          metadata: {
            tool: TOOL_NAMES.RECORD_REPLAY.WORKFLOW_REPAIR_ROLLBACK,
            repairRevision: selectedRepairRevision,
            ...((entry.rollback.beforeRevision ?? entry.baseRevision)
              ? { beforeRevision: entry.rollback.beforeRevision ?? entry.baseRevision }
              : {}),
            fromRevision: currentRevision,
            restoredRevision,
            forced: args?.force === true,
          },
        });
        restored.updatedAt = new Date().toISOString() as FlowV3['updatedAt'];
        const saved = await saveFlowToV3(restored);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                applied: true,
                dryRun: false,
                flowId: saved.id,
                workflow: getPublishedFlowInfo(saved)?.slug,
                currentRevision,
                restoredRevision,
                rollback: {
                  repairRevision: selectedRepairRevision,
                  beforeRevision: entry.rollback.beforeRevision ?? entry.baseRevision,
                  expectedCurrentRevision,
                  snapshot: snapshotSummary,
                },
                audit: saved.meta?.audit?.events?.slice(-1) ?? [],
              }),
            },
          ],
          isError: false,
        };
      });
    } catch (error) {
      if (error instanceof FlowWriteConflictError) {
        return createWorkflowRepairRollbackError(
          error.code,
          error.message,
          { flowId: error.flowId },
          true,
        );
      }
      throw error;
    }
  }
}

class WorkflowStabilizeTool {
  name = TOOL_NAMES.RECORD_REPLAY.WORKFLOW_STABILIZE;

  async execute(args: any, context?: ToolExecutionContext): Promise<ToolResult> {
    const validationErrors = validateWorkflowStabilizeArgs(args);
    if (validationErrors.length > 0) {
      return createStructuredToolError(
        'INVALID_WORKFLOW_STABILIZE_ARGS',
        'Invalid workflow_stabilize arguments',
        validationErrors,
      );
    }

    const requestedFlowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    const requestedWorkflow = typeof args?.workflow === 'string' ? args.workflow.trim() : '';
    const flow = await resolveFlowForWorkflowTool(args);
    if (!flow) {
      return createStructuredToolError(
        'WORKFLOW_NOT_FOUND',
        requestedFlowId
          ? `Flow not found: ${requestedFlowId}`
          : `Published workflow not found: ${requestedWorkflow}`,
        [
          {
            code: 'WORKFLOW_NOT_FOUND',
            path: requestedFlowId ? '/flowId' : '/workflow',
            message: requestedFlowId
              ? `Flow not found: ${requestedFlowId}`
              : `Published workflow not found: ${requestedWorkflow}`,
          },
        ],
      );
    }

    let workingFlow = flow;
    const publishedInfo = getPublishedFlowInfo(workingFlow);
    const initialRevision = calculateWorkflowRevision(workingFlow);
    const requiredRevision =
      typeof args?.safety?.requireRevision === 'string' ? args.safety.requireRevision.trim() : '';
    if (requiredRevision && requiredRevision !== initialRevision) {
      return createStructuredToolError(
        'STALE_WORKFLOW_REVISION',
        'workflow_stabilize requireRevision does not match the current workflow revision',
        [
          {
            code: 'STALE_WORKFLOW_REVISION',
            path: '/safety/requireRevision',
            message: `Expected ${requiredRevision}, current revision is ${initialRevision}`,
          },
        ],
      );
    }

    const hints = collectFlowHints(workingFlow);
    const recentRuns = await collectDebugRuns(workingFlow, {
      ...args,
      includeRuns: true,
      includeArtifacts: args?.debug?.captureArtifacts !== 'none',
      maxRuns: 3,
      maxEventsPerRun: args?.debug?.maxEventsPerRun,
    });
    const descriptor = buildWorkflowToolDescriptor(workingFlow);
    const disabledNodeIds = getDisabledWorkflowNodeIds(workingFlow);
    let runtimeSideEffectEvidence = collectRuntimeSideEffectEvidence(recentRuns, { disabledNodeIds });
    let staticSideEffects = descriptor.sideEffects.summary;
    let sideEffects = mergeWorkflowSideEffectSummaries(
      staticSideEffects,
      runtimeSideEffectEvidence.summary,
    );
    let staticRisk = classifyWorkflowRisk(staticSideEffects);
    let risk = maxWorkflowRisk(staticRisk, runtimeSideEffectEvidence.risk);
    const executionMode = normalizeExecutionMode(args?.safety?.executionMode);
    const iterations = clampNumber(args?.iterations, 3, 1, 10);
    const minPassRate =
      typeof args?.minPassRate === 'number' && Number.isFinite(args.minPassRate)
        ? Math.max(0, Math.min(1, args.minPassRate))
        : 1;
    const stabilizeRunGroupId = `stabilize-${Date.now().toString(36)}`;
    const clientCapabilities = normalizeMcpClientCapabilities(context);
    const approvalCheck = await resolveTrustedWorkflowApproval({
      args,
      flow: workingFlow,
      revision: initialRevision,
    });
    const hasApprovalReference = approvalCheck.accepted;
    const initialQuality = buildWorkflowQualitySummary(workingFlow);
    const runtimeMigrationBlock = workflowRuntimeRequiresMigration(workingFlow);
    const workflowStatusRequiresResume =
      initialQuality.status === 'paused' || initialQuality.status === 'blocked';
    const warnings: WorkflowStabilizeWarning[] = [];
    warnings.push(
      ...buildClientCapabilityWarnings(clientCapabilities, {
        includeArtifacts: args?.debug?.captureArtifacts !== 'none',
        longRunning: executionMode !== 'analyzeOnly' && iterations > 1,
        runGroupId: stabilizeRunGroupId,
      }),
    );
    if (getApprovalIdReference(args) && !approvalCheck.accepted) {
      warnings.push({
        code: 'STABILIZE_APPROVAL_REJECTED',
        category: 'safety',
        message: approvalCheck.reason ?? 'approval reference was not accepted',
      });
    }
    let runtimeSideEffectWarningEmitted = false;

    const nodeRiskOverrides =
      args?.safety?.nodeRiskOverrides &&
      typeof args.safety.nodeRiskOverrides === 'object' &&
      !Array.isArray(args.safety.nodeRiskOverrides)
        ? (args.safety.nodeRiskOverrides as Record<string, WorkflowRiskProfile>)
        : {};
    const acceptedRiskOverrideNodeIds: string[] = [];
    const acceptedRiskOverrides = new Map<string, WorkflowRiskProfile>();
    for (const [nodeId, override] of Object.entries(nodeRiskOverrides)) {
      if (override !== 'safe' && override !== 'idempotent' && override !== 'dangerous') {
        warnings.push({
          code: 'INVALID_NODE_RISK_OVERRIDE',
          category: 'validation',
          path: `/safety/nodeRiskOverrides/${nodeId}`,
          nodeId,
          message: 'nodeRiskOverrides values must be safe, idempotent, or dangerous',
        });
        continue;
      }
      const node = workingFlow.nodes.find((candidate) => String(candidate.id) === nodeId);
      const actualRisk = node ? getNodeWorkflowRisk(node) : 'unknown';
      if (riskRank(override) < riskRank(actualRisk) && !hasApprovalReference) {
        warnings.push({
          code: 'UNTRUSTED_RISK_DOWNGRADE_IGNORED',
          category: 'safety',
          path: `/safety/nodeRiskOverrides/${nodeId}`,
          nodeId,
          message:
            'Risk downgrade overrides require a trusted approval reference and are ignored in analyze-only mode.',
        });
        continue;
      }
      if (override !== actualRisk) {
        acceptedRiskOverrideNodeIds.push(nodeId);
      }
      acceptedRiskOverrides.set(nodeId, override);
    }
    if (acceptedRiskOverrides.size > 0) {
      staticSideEffects = summarizeWorkflowSideEffects(workingFlow, acceptedRiskOverrides);
      sideEffects = mergeWorkflowSideEffectSummaries(
        staticSideEffects,
        runtimeSideEffectEvidence.summary,
      );
      staticRisk = classifyWorkflowRisk(staticSideEffects);
      risk = maxWorkflowRisk(staticRisk, runtimeSideEffectEvidence.risk);
    }
    if (riskRank(runtimeSideEffectEvidence.risk) > riskRank(staticRisk)) {
      warnings.push({
        code: 'STABILIZE_RUNTIME_SIDE_EFFECT_EVIDENCE',
        category: 'safety',
        message:
          'Recent runtime observations indicate stronger side-effect risk than static node classification.',
      });
      runtimeSideEffectWarningEmitted = true;
    }

    const requestsExternalSideEffects = args?.safety?.allowExternalSideEffects === true;
    const maxDangerousRuns =
      typeof args?.safety?.maxDangerousRuns === 'number' && Number.isFinite(args.safety.maxDangerousRuns)
        ? Math.max(0, Math.min(3, Math.floor(args.safety.maxDangerousRuns)))
        : 0;
    const resetValidation = await buildWorkflowResetValidation({
      args,
      targetFlow: workingFlow,
      hasApprovalReference,
    });
    const segmentPlan = buildWorkflowSegmentPlan(
      workingFlow,
      args,
      runtimeSideEffectEvidence,
      acceptedRiskOverrides,
    );
    const hasAutoRiskBoundary =
      segmentPlan.mode === 'stopBeforeDangerous' && Boolean(segmentPlan.stopBeforeNodeId);
    const boundaryError = await validateStabilizeReplayBoundary(args, executionMode);
    const sandboxReplayBoundaryError =
      executionMode === 'sandboxReplay'
        ? getSandboxReplayBoundaryError(args, resetValidation, segmentPlan)
        : undefined;
    let blockedReason: string | undefined;
    if (runtimeMigrationBlock) {
      blockedReason = `workflow runtime compatibility requires workflow_migrate before stabilization: ${runtimeMigrationBlock.staleReason ?? runtimeMigrationBlock.decision}`;
    } else if (workflowStatusRequiresResume && !hasApprovalReference) {
      blockedReason = `workflow quality status ${initialQuality.status} requires trusted resume approval and revalidation`;
    } else if ((risk === 'dangerous' || risk === 'unknown') && executionMode === 'auto' && !hasAutoRiskBoundary) {
      blockedReason = `${risk} workflow defaults to analyze-only`;
    } else if (
      (risk === 'dangerous' || risk === 'unknown') &&
      (requestsExternalSideEffects || maxDangerousRuns > 0 || executionMode === 'userApprovedReplay') &&
      !hasApprovalReference
    ) {
      blockedReason = 'external side effects require a trusted approval reference';
    } else if (sandboxReplayBoundaryError && !boundaryError) {
      blockedReason = sandboxReplayBoundaryError.message;
    }

    if (blockedReason) {
      warnings.push({
        code: 'STABILIZE_REPLAY_BLOCKED',
        category: 'safety',
        message: blockedReason,
      });
    }
    if (resetValidation.blockedReason) {
      warnings.push({
        code: 'STABILIZE_RESET_BLOCKED',
        category: 'safety',
        message: resetValidation.blockedReason,
      });
    }
    if (boundaryError) {
      warnings.push({
        code: 'STABILIZE_TEST_ENVIRONMENT_BLOCKED',
        category: 'safety',
        path: boundaryError.path,
        message: boundaryError.message,
      });
    }
    if (sandboxReplayBoundaryError) {
      warnings.push({
        code: sandboxReplayBoundaryError.code,
        category: 'safety',
        path: sandboxReplayBoundaryError.path,
        message: sandboxReplayBoundaryError.message,
      });
    }
    if (executionMode === 'sandboxReplay') {
      warnings.push({
        code: 'STABILIZE_SANDBOX_REPLAY_LIMITED',
        category: 'safety',
        message:
          'sandboxReplay is bounded test replay in a declared environment; browser automation does not guarantee rollback of external side effects.',
      });
    }
    if (segmentPlan.mode === 'stopBeforeDangerous' && segmentPlan.stopBeforeNodeId) {
      warnings.push({
        code: 'STABILIZE_AUTO_SEGMENT_BOUNDARY',
        category: 'safety',
        nodeId: segmentPlan.stopBeforeNodeId,
        message: `Validation will stop before ${segmentPlan.boundaryRisk ?? 'risky'} node ${segmentPlan.stopBeforeNodeId}.`,
      });
    } else if (
      segmentPlan.mode === 'stopBeforeDangerous' &&
      segmentPlan.ambiguousBoundaryNodeIds &&
      segmentPlan.ambiguousBoundaryNodeIds.length > 0
    ) {
      warnings.push({
        code: 'STABILIZE_AUTO_SEGMENT_BOUNDARY_AMBIGUOUS',
        category: 'safety',
        message:
          'stopBeforeDangerous found multiple first risky nodes across workflow branches; use an explicit segment or trusted approval.',
      });
    } else if (segmentPlan.mode === 'stopBeforeDangerous') {
      warnings.push({
        code: 'STABILIZE_AUTO_SEGMENT_BOUNDARY_NOT_FOUND',
        category: 'safety',
        message:
          'No dangerous or unknown node was found for stopBeforeDangerous segmentation; validation uses normal safety gating.',
      });
    }

    let validationBlockedReason =
      blockedReason ??
      resetValidation.blockedReason ??
      boundaryError?.message ??
      sandboxReplayBoundaryError?.message;
    const canRunValidation = !validationBlockedReason && executionMode !== 'analyzeOnly';
    const requestedValidationIterations =
      (risk === 'dangerous' || risk === 'unknown') && !hasAutoRiskBoundary
        ? Math.min(iterations, maxDangerousRuns)
        : iterations;
    if (canRunValidation && requestedValidationIterations === 0) {
      warnings.push({
        code: 'STABILIZE_NO_AUTHORIZED_RUNS',
        category: 'safety',
        message:
          'No validation runs are authorized for this risk profile. Increase safety.maxDangerousRuns with trusted approval or use a safe/idempotent workflow.',
      });
    }

    let validationDebugRuns: WorkflowDebugRun[] = [];
    let runtimeSafetyBlockWarningEmitted = false;
    const refreshRuntimeSideEffectEvidence = (): void => {
      runtimeSideEffectEvidence = collectRuntimeSideEffectEvidence([...recentRuns, ...validationDebugRuns], {
        disabledNodeIds,
      });
      sideEffects = mergeWorkflowSideEffectSummaries(
        staticSideEffects,
        runtimeSideEffectEvidence.summary,
      );
      risk = maxWorkflowRisk(staticRisk, runtimeSideEffectEvidence.risk);
      if (
        !runtimeSideEffectWarningEmitted &&
        riskRank(runtimeSideEffectEvidence.risk) > riskRank(staticRisk)
      ) {
        warnings.push({
          code: 'STABILIZE_RUNTIME_SIDE_EFFECT_EVIDENCE',
          category: 'safety',
          message:
            'Validation runtime observations indicate stronger side-effect risk than static node classification.',
        });
        runtimeSideEffectWarningEmitted = true;
      }
    };
    const blockFurtherAutomaticStabilizationForRuntimeRisk = (): boolean => {
      if (
        validationBlockedReason ||
        executionMode !== 'auto' ||
        hasApprovalReference ||
        hasAutoRiskBoundary ||
        (risk !== 'dangerous' && risk !== 'unknown')
      ) {
        return false;
      }
      validationBlockedReason = `${risk} workflow runtime evidence blocks further automatic stabilization`;
      if (!runtimeSafetyBlockWarningEmitted) {
        warnings.push({
          code: 'STABILIZE_REPLAY_BLOCKED',
          category: 'safety',
          message: validationBlockedReason,
        });
        runtimeSafetyBlockWarningEmitted = true;
      }
      return true;
    };

    const baselineValidation =
      canRunValidation && requestedValidationIterations > 0
        ? await executeStabilizeValidationRuns(
            workingFlow,
            args,
            'baseline',
            requestedValidationIterations,
            initialRevision,
            warnings,
            segmentPlan,
            resetValidation.plan,
            {
              stopAfterTargetRun: (targetDebugRuns) => {
                validationDebugRuns = targetDebugRuns;
                refreshRuntimeSideEffectEvidence();
                return blockFurtherAutomaticStabilizationForRuntimeRisk();
              },
            },
          )
        : { targetRuns: [], resetRuns: [], targetDebugRuns: [] };
    const baselineRuns = baselineValidation.targetRuns;
    validationDebugRuns = baselineValidation.targetDebugRuns;
    refreshRuntimeSideEffectEvidence();
    blockFurtherAutomaticStabilizationForRuntimeRisk();
    const baselineEvidenceRuns = [...recentRuns, ...baselineValidation.targetDebugRuns];
    const selectorRepairPlansBeforeApply = planSelectorRepairs(workingFlow, baselineEvidenceRuns);
    const waitRepairPlansBeforeApply = planWaitRepairs(workingFlow, baselineEvidenceRuns);
    const assertionRepairSuggestionsBeforeApply = buildAssertionRepairSuggestions(
      workingFlow,
      baselineEvidenceRuns,
    );
    const recommendationsBeforeApply = buildRepairRecommendations(
      workingFlow,
      hints,
      baselineEvidenceRuns,
    );
    const resetRuns = [...baselineValidation.resetRuns];
    const baselineScore = scoreStabilizeRuns(baselineRuns);
    const shouldApply = args?.apply === true && args?.dryRun !== true && !validationBlockedReason;
    const rollbackSnapshot = shouldApply
      ? createWorkflowRepairRollbackSnapshot(workingFlow)
      : undefined;
    const changes: WorkflowRepairChange[] = [];
    let parameterization: ReturnType<typeof applyFlowParameterSuggestions> | undefined;

    if (shouldApply && args?.repair?.parameterize !== false && hasRecordingParameterSuggestions(workingFlow)) {
      parameterization = applyFlowParameterSuggestions(workingFlow);
      if (parameterization.changed) {
        changes.push({
          code: 'parameter_suggestions_applied',
          message: `Applied ${parameterization.applied} recorded parameter suggestion(s).`,
        });
      }
    }
    if (shouldApply && args?.repair?.defaultStabilityPolicy !== false) {
      changes.push(...applyDefaultStabilityPolicy(workingFlow));
    }
    if (shouldApply && args?.repair?.selectors !== false) {
      changes.push(...applySelectorRepairPlans(workingFlow, selectorRepairPlansBeforeApply));
    }
    if (shouldApply && args?.repair?.waits !== false) {
      changes.push(...applyWaitRepairPlans(workingFlow, waitRepairPlansBeforeApply));
    }
    if (args?.apply === true && validationBlockedReason) {
      warnings.push({
        code: 'STABILIZE_APPLY_SKIPPED',
        category: 'safety',
        message: 'Automatic repair apply was skipped because validation replay is blocked by safety policy.',
      });
    }

    const applied = shouldApply && changes.length > 0;
    if (args?.dryRun !== true && hasApprovalReference) {
      workingFlow = appendWorkflowAuditEvent(workingFlow, {
        kind: 'approval_use',
        actor: 'mcp',
        revision: calculateWorkflowRevision(workingFlow),
        reason: 'workflow_stabilize_authorization',
        metadata: {
          approvalId: approvalCheck.approval?.approvalId ?? getApprovalIdReference(args),
          approvedBy: approvalCheck.approval?.approvedBy ?? 'unknown',
          approvedAt: approvalCheck.approval?.approvedAt ?? '',
          expiresAt: approvalCheck.approval?.expiresAt ?? '',
          executionMode: validationBlockedReason ? 'analyzeOnly' : executionMode,
          allowExternalSideEffects: requestsExternalSideEffects,
          maxDangerousRuns,
          scope: approvalCheck.approval?.scope ?? {},
        },
      });
    }
    if (args?.dryRun !== true && acceptedRiskOverrideNodeIds.length > 0) {
      workingFlow = appendWorkflowAuditEvent(workingFlow, {
        kind: 'risk_override',
        actor: 'mcp',
        revision: calculateWorkflowRevision(workingFlow),
        reason: 'workflow_stabilize_node_risk_override',
        metadata: {
          nodeIds: acceptedRiskOverrideNodeIds.slice(0, 30),
          overrideCount: acceptedRiskOverrideNodeIds.length,
        },
      });
    }
    let postRepairRevision: string | undefined;
    let appliedRepairRevision: string | undefined;
    if (applied) {
      appliedRepairRevision = recordWorkflowRepairHistory(
        workingFlow,
        initialRevision,
        changes,
        'workflow_stabilize',
        rollbackSnapshot,
      );
      workingFlow.updatedAt = new Date().toISOString();
      try {
        workingFlow = await saveFlowToV3(workingFlow, {
          expectedRevision: initialRevision,
          revisionConflictMessage:
            'workflow_stabilize could not apply repairs because the workflow changed during validation',
        });
      } catch (error) {
        const conflict = getFlowRevisionConflict(error);
        if (conflict) {
          return createWorkflowRevisionConflictError(
            conflict,
            'workflow_stabilize could not apply repairs because the workflow changed during validation',
          );
        }
        throw error;
      }
      postRepairRevision = calculateWorkflowRevision(workingFlow);
    }

    const postRepairValidation =
      applied && !validationBlockedReason && requestedValidationIterations > 0
        ? await executeStabilizeValidationRuns(
            workingFlow,
            args,
            'postRepair',
            requestedValidationIterations,
            postRepairRevision ?? calculateWorkflowRevision(workingFlow),
            warnings,
            segmentPlan,
            resetValidation.plan,
            {
              stopAfterTargetRun: (targetDebugRuns) => {
                validationDebugRuns = [
                  ...baselineValidation.targetDebugRuns,
                  ...targetDebugRuns,
                ];
                refreshRuntimeSideEffectEvidence();
                return blockFurtherAutomaticStabilizationForRuntimeRisk();
              },
            },
          )
        : { targetRuns: [], resetRuns: [], targetDebugRuns: [] };
    resetRuns.push(...postRepairValidation.resetRuns);
    validationDebugRuns = [
      ...baselineValidation.targetDebugRuns,
      ...postRepairValidation.targetDebugRuns,
    ];
    refreshRuntimeSideEffectEvidence();
    blockFurtherAutomaticStabilizationForRuntimeRisk();
    const finalEvidenceRuns = [...recentRuns, ...validationDebugRuns];
    const postRepairRuns = postRepairValidation.targetRuns;
    const postRepairScore = scoreStabilizeRuns(postRepairRuns);
    const finalScore = postRepairRuns.length > 0 ? postRepairScore : baselineScore;
    const finalHints = applied ? collectFlowHints(workingFlow) : hints;
    const selectorRepairPlans = applied
      ? planSelectorRepairs(workingFlow, finalEvidenceRuns)
      : selectorRepairPlansBeforeApply;
    const waitRepairPlans = applied
      ? planWaitRepairs(workingFlow, finalEvidenceRuns)
      : waitRepairPlansBeforeApply;
    const assertionRepairSuggestions = applied
      ? buildAssertionRepairSuggestions(workingFlow, finalEvidenceRuns)
      : assertionRepairSuggestionsBeforeApply;
    const recommendations = applied
      ? buildRepairRecommendations(workingFlow, finalHints, finalEvidenceRuns)
      : recommendationsBeforeApply;
    const failedRuns = recentRuns.filter((run) => run.status === 'failed').length;
    const passedRuns = recentRuns.filter((run) => run.status === 'succeeded').length;
    const capabilities = buildWorkflowCapabilityMatrix(workingFlow, 'stabilize');
    const failedValidationRun =
      [...postRepairRuns, ...baselineRuns].find((run) => !run.success && run.debugArgs) ??
      [...postRepairRuns, ...baselineRuns].find((run) => !run.success);
    const rollbackSuggestion =
      postRepairRuns.length > 0 && postRepairScore.passRate < baselineScore.passRate
        ? {
            beforeRevision: initialRevision,
            afterRevision: postRepairRevision,
            repairRevision: appliedRepairRevision,
            reason: 'post-repair validation passRate is lower than baseline',
            automaticRollbackAvailable: Boolean(appliedRepairRevision),
            tool: TOOL_NAMES.RECORD_REPLAY.WORKFLOW_REPAIR_ROLLBACK,
            args: {
              ...(publishedInfo?.slug ? { workflow: publishedInfo.slug } : { flowId: workingFlow.id }),
              ...(appliedRepairRevision ? { repairRevision: appliedRepairRevision } : {}),
              requireCurrentRevision: postRepairRevision,
            },
          }
        : undefined;
    const validationRunsForQuality = postRepairRuns.length > 0 ? postRepairRuns : baselineRuns;
    const segmentOnlyValidation =
      args?.safety?.segments?.mode === 'explicit' ||
      args?.safety?.segments?.mode === 'stopBeforeDangerous' ||
      validationRunsForQuality.some((run) => isBoundaryStoppedStatus(run.status));
    const minValidationRuns = Math.max(1, requestedValidationIterations);
    let quality: ReturnType<typeof buildWorkflowToolDescriptor>['quality'] | undefined;
    if (validationRunsForQuality.length > 0) {
      const qualityRevision = postRepairRevision ?? calculateWorkflowRevision(workingFlow);
      const qualityRecord = await buildStabilizeQualityRecord({
        flow: workingFlow,
        args,
        risk,
        executionMode: validationBlockedReason ? 'analyzeOnly' : executionMode,
        runs: validationRunsForQuality,
        revision: qualityRevision,
        minPassRate,
        minValidationRuns,
        capabilities,
        warnings,
        runGroupId: stabilizeRunGroupId,
      });
      if (args?.dryRun !== true) {
        const previousQuality = buildWorkflowQualitySummary(workingFlow);
        let nextWorkingFlow: FlowV3 = {
          ...workingFlow,
          meta: {
            ...(workingFlow.meta ?? {}),
            quality: qualityRecord,
            runtime: {
              ...(workingFlow.meta?.runtime ?? {}),
              protocolVersion: WEBPAGE_MCP_PROTOCOL_VERSION,
              capabilityVersion: WEBPAGE_MCP_CAPABILITY_VERSION,
              dslVersion: FLOW_DSL_VERSION,
              nodeSemanticsVersion: FLOW_NODE_SEMANTICS_VERSION,
            },
          },
        };
        const nextQuality = buildWorkflowQualitySummary(nextWorkingFlow);
        const statusChanged = previousQuality.status !== nextQuality.status;
        const downgrade =
          previousQuality.current &&
          (!nextQuality.current || nextQuality.slo.status === 'breached');
        if (statusChanged || downgrade) {
          nextWorkingFlow = appendWorkflowAuditEvent(nextWorkingFlow, {
            kind: downgrade ? 'quality_downgrade' : 'quality_status_change',
            actor: 'mcp',
            revision: calculateWorkflowRevision(nextWorkingFlow),
            previousStatus: previousQuality.status,
            nextStatus: nextQuality.status,
            reason:
              workflowStatusRequiresResume && hasApprovalReference
                ? 'workflow_stabilize_resume_revalidation'
                : nextQuality.staleReason ?? (downgrade ? 'slo_breach' : 'workflow_stabilize_status_change'),
            metadata: {
              tool: TOOL_NAMES.RECORD_REPLAY.WORKFLOW_STABILIZE,
              passRate: nextQuality.passRate,
              minPassRate,
              sloStatus: nextQuality.slo.status,
              sloBreaches: nextQuality.slo.breaches,
              ...(approvalCheck.approval
                ? {
                    approvalId: approvalCheck.approval.approvalId,
                    approvedBy: approvalCheck.approval.approvedBy,
                  }
                : {}),
            },
          });
        }
        try {
          workingFlow = await saveFlowToV3(nextWorkingFlow, {
            expectedRevision: postRepairRevision ?? initialRevision,
            revisionConflictMessage:
              'workflow_stabilize could not record quality because the workflow changed during validation',
          });
        } catch (error) {
          const conflict = getFlowRevisionConflict(error);
          if (conflict) {
            return createWorkflowRevisionConflictError(
              conflict,
              'workflow_stabilize could not record quality because the workflow changed during validation',
            );
          }
          throw error;
        }
      }
      quality = buildWorkflowToolDescriptor({
        ...workingFlow,
        meta: {
          ...(workingFlow.meta ?? {}),
          quality: qualityRecord,
        },
      }).quality;
    } else {
      quality = buildWorkflowToolDescriptor(workingFlow).quality;
    }
    const runtimeMetrics = buildStabilizeRuntimeMetrics({
      flow: workingFlow,
      validationRuns: [...baselineRuns, ...postRepairRuns],
      inspectedRuns: recentRuns,
      capabilities,
      applied,
      changes,
      rollbackSuggested: Boolean(rollbackSuggestion),
      approvalUsed: hasApprovalReference,
      passRate: finalScore.passRate,
      qualityCurrent: quality?.current ?? buildWorkflowQualitySummary(workingFlow).current,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            flowId: workingFlow.id,
            workflow: publishedInfo?.slug,
            applied,
            stable:
              !segmentOnlyValidation &&
              finalScore.iterations > 0 &&
              finalScore.passRate >= minPassRate,
            score: {
              ...finalScore,
              inspectedPassedRuns: passedRuns,
              inspectedFailedRuns: failedRuns,
            },
            quality,
            baselineScore,
            ...(postRepairRuns.length > 0 ? { postRepairScore } : {}),
            summary: {
              nodeCount: countFlowNodes(workingFlow),
              hintCount: finalHints.length,
              recommendationCount: recommendations.length,
              changeCount: changes.length,
              inspectedRunCount: recentRuns.length,
              resetRunCount: resetRuns.length,
              baselineRunCount: baselineRuns.length,
              postRepairRunCount: postRepairRuns.length,
              runGroupId: stabilizeRunGroupId,
              clientCapabilities: buildClientCapabilitySummary(clientCapabilities),
            },
            safety: {
              risk,
              executionMode: validationBlockedReason ? 'analyzeOnly' : executionMode,
              requestedIterations: iterations,
              minPassRate,
              executedIterations: baselineRuns.length + postRepairRuns.length,
              blocked: Boolean(validationBlockedReason),
              ...(validationBlockedReason ? { blockedReason: validationBlockedReason } : {}),
              sideEffects,
              runtimeEvidence: runtimeSideEffectEvidence,
              segments: {
                mode: segmentPlan.mode,
                ...(segmentPlan.stopBeforeNodeId
                  ? { stopBeforeNodeId: segmentPlan.stopBeforeNodeId }
                  : {}),
                ...(segmentPlan.endNodeId ? { endNodeId: segmentPlan.endNodeId } : {}),
                ...(segmentPlan.autoBoundary
                  ? {
                      autoBoundary: true,
                      boundaryNodeId: segmentPlan.boundaryNodeId,
                      boundaryKind: segmentPlan.boundaryKind,
                      boundaryRisk: segmentPlan.boundaryRisk,
                      boundarySource: segmentPlan.boundarySource,
                    }
                  : {}),
                ...(segmentPlan.ambiguousBoundaryNodeIds
                  ? { ambiguousBoundaryNodeIds: segmentPlan.ambiguousBoundaryNodeIds }
                  : {}),
              },
              ...(executionMode === 'sandboxReplay'
                ? {
                    sandboxReplay: {
                      mode: 'bounded_test_replay',
                      rollback: 'not_guaranteed',
                      requires: ['testEnvironment', 'testAccountOrResetOrSegment'],
                    },
                  }
                : {}),
              approvalReferenceAccepted: hasApprovalReference,
              ...(approvalCheck.approval
                ? {
                    approval: {
                      approvalId: approvalCheck.approval.approvalId,
                      approvedBy: approvalCheck.approval.approvedBy,
                      approvedAt: approvalCheck.approval.approvedAt,
                      expiresAt: approvalCheck.approval.expiresAt,
                      scope: approvalCheck.approval.scope,
                    },
                  }
                : {}),
            },
            reset: {
              requested: resetValidation.requested,
              ...(resetValidation.plan
                ? {
                    workflow: resetValidation.plan.workflow,
                    flowId: resetValidation.plan.flow.id,
                    revision: resetValidation.plan.revision,
                    requireStable: resetValidation.plan.requireStable,
                    maxRuns: resetValidation.plan.maxRuns,
                    risk: resetValidation.plan.risk,
                    quality: {
                      level: resetValidation.plan.quality.level,
                      status: resetValidation.plan.quality.status,
                      current: resetValidation.plan.quality.current,
                      staleReason: resetValidation.plan.quality.staleReason,
                    },
                  }
                : {}),
              ...(resetValidation.blockedReason ? { blockedReason: resetValidation.blockedReason } : {}),
              ...(resetValidation.errors.length > 0 ? { errors: resetValidation.errors } : {}),
              runCount: resetRuns.length,
              failed: resetRuns.some((run) => !run.success),
            },
            resumable: {
              runGroupId: stabilizeRunGroupId,
              boundedTimeoutMs: 120000,
              cancellationCapability: clientCapabilities.mcp
                ? clientCapabilities.cancellation
                  ? 'supported'
                  : 'unconfirmed'
                : 'not_applicable',
            },
            capabilities,
            metrics: runtimeMetrics,
            audit: {
              events: workingFlow.meta?.audit?.events ?? [],
            },
            hints: finalHints,
            recommendations,
            recommendationsBeforeApply,
            selectorDiagnostics: buildSelectorDiagnostics(workingFlow, finalEvidenceRuns),
            selectorRepairs: selectorRepairPlans,
            ...(applied ? { selectorRepairsBeforeApply: selectorRepairPlansBeforeApply } : {}),
            waitRepairs: waitRepairPlans,
            assertionRepairs: assertionRepairSuggestions,
            ...(applied ? { waitRepairsBeforeApply: waitRepairPlansBeforeApply } : {}),
            ...(applied ? { assertionRepairsBeforeApply: assertionRepairSuggestionsBeforeApply } : {}),
            changes,
            ...(parameterization ? { parameterization } : {}),
            ...(rollbackSuggestion ? { rollbackSuggestion } : {}),
            runs: postRepairRuns.length > 0 ? postRepairRuns : baselineRuns,
            baselineRuns,
            ...(postRepairRuns.length > 0 ? { postRepairRuns } : {}),
            ...(resetRuns.length > 0 ? { resetRuns } : {}),
            artifacts: {
              policy: args?.debug?.captureArtifacts ?? 'failureOnly',
              debugArgs: {
                tool: TOOL_NAMES.RECORD_REPLAY.WORKFLOW_DEBUG_VIEW,
                ...(failedValidationRun?.runId ? { runId: failedValidationRun.runId } : {}),
                ...(failedValidationRun?.currentNodeId ? { nodeId: failedValidationRun.currentNodeId } : {}),
                ...(publishedInfo?.slug ? { workflow: publishedInfo.slug } : { flowId: workingFlow.id }),
                includeArtifacts: true,
                maxEvents: 100,
              },
            },
            warnings,
            nextActions: [
              {
                tool: TOOL_NAMES.RECORD_REPLAY.WORKFLOW_DEBUG_VIEW,
                args: {
                  ...(publishedInfo?.slug ? { workflow: publishedInfo.slug } : { flowId: workingFlow.id }),
                  ...(failedValidationRun?.runId ? { runId: failedValidationRun.runId } : {}),
                  includeArtifacts: true,
                },
              },
              {
                tool: TOOL_NAMES.RECORD_REPLAY.WORKFLOW_REPAIR,
                args: {
                  ...(publishedInfo?.slug ? { workflow: publishedInfo.slug } : { flowId: workingFlow.id }),
                  apply: false,
                },
              },
              ...(rollbackSuggestion
                ? [
                    {
                      tool: TOOL_NAMES.RECORD_REPLAY.WORKFLOW_REPAIR_ROLLBACK,
                      args: rollbackSuggestion.args,
                    },
                  ]
                : []),
            ],
          }),
        },
      ],
      isError: false,
    };
  }
}

class WorkflowMigrateTool {
  name = TOOL_NAMES.RECORD_REPLAY.WORKFLOW_MIGRATE;

  async execute(args: any): Promise<ToolResult> {
    const requestedFlowId = typeof args?.flowId === 'string' ? args.flowId.trim() : '';
    const requestedWorkflow = typeof args?.workflow === 'string' ? args.workflow.trim() : '';
    const rollbackMigrationId =
      typeof args?.rollbackMigrationId === 'string' ? args.rollbackMigrationId.trim() : '';
    const dryRun = args?.dryRun !== false;
    if (args?.apply === true && args?.dryRun !== false) {
      return createErrorResponse('apply=true requires dryRun=false');
    }
    if (!requestedFlowId && !requestedWorkflow && args?.all !== true) {
      return createErrorResponse('flowId, workflow, or all=true is required');
    }
    if (rollbackMigrationId && args?.all === true) {
      return createErrorResponse('rollbackMigrationId requires a single flowId or workflow target');
    }

    if (rollbackMigrationId) {
      const flow = await resolveFlowForWorkflowTool(args);
      if (!flow) {
        return createErrorResponse(
          requestedFlowId
            ? `Flow not found: ${requestedFlowId}`
            : `Published workflow not found: ${requestedWorkflow}`,
        );
      }
      const snapshot = getMigrationRollbackSnapshot(flow, rollbackMigrationId);
      if (!snapshot) {
        return createErrorResponse(`No migration rollback snapshot found for ${rollbackMigrationId}`);
      }
      if (dryRun) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                dryRun: true,
                rollback: {
                  migrationId: rollbackMigrationId,
                  flowId: flow.id,
                  workflow: getPublishedFlowInfo(flow)?.slug,
                  snapshot,
                  externalSideEffectsReversible: false,
                },
              }),
            },
          ],
          isError: false,
        };
      }
      let rolledBack: FlowV3;
      const rollbackExpectedRevision = calculateWorkflowRevision(flow);
      try {
        rolledBack = await saveFlowToV3(
          applyWorkflowMigrationRollback(flow, rollbackMigrationId, snapshot),
          {
            expectedRevision: rollbackExpectedRevision,
            revisionConflictMessage:
              'workflow_migrate rollback could not apply because the workflow changed after rollback analysis',
          },
        );
      } catch (error) {
        const conflict = getFlowRevisionConflict(error);
        if (conflict) {
          return createWorkflowRevisionConflictError(
            conflict,
            'workflow_migrate rollback could not apply because the workflow changed after rollback analysis',
          );
        }
        throw error;
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              dryRun: false,
              rollback: {
                migrationId: rollbackMigrationId,
                flowId: rolledBack.id,
                workflow: getPublishedFlowInfo(rolledBack)?.slug,
                quality: buildWorkflowQualitySummary(rolledBack),
                externalSideEffectsReversible: false,
              },
            }),
          },
        ],
        isError: false,
      };
    }

    const migrationId = createWorkflowMigrationId();
    const flows =
      args?.all === true
        ? await createStoragePort().flows.list()
        : await (async () => {
            const flow = await resolveFlowForWorkflowTool(args);
            return flow ? [flow] : [];
          })();
    if (flows.length === 0) {
      return createErrorResponse(
        requestedFlowId
          ? `Flow not found: ${requestedFlowId}`
          : requestedWorkflow
            ? `Published workflow not found: ${requestedWorkflow}`
            : 'No workflows found',
      );
    }

    const reports: Array<Record<string, unknown>> = [];
    for (const flow of flows) {
      const report = buildWorkflowMigrationPlan(flow, migrationId);
      if (!dryRun && report.changed === true) {
        try {
          const migrated = await saveFlowToV3(applyWorkflowMigration(flow, migrationId), {
            expectedRevision: calculateWorkflowRevision(flow),
            revisionConflictMessage:
              'workflow_migrate could not apply because the workflow changed after migration planning',
          });
          reports.push({
            ...buildWorkflowMigrationPlan(migrated, migrationId),
            applied: true,
            auditRecorded: true,
          });
        } catch (error) {
          const conflict = getFlowRevisionConflict(error);
          reports.push({
            ...report,
            applied: false,
            ...(conflict
              ? {
                  errorCode: conflict.code,
                  expectedRevision: conflict.expectedRevision ?? null,
                  currentRevision: conflict.currentRevision ?? null,
                }
              : {}),
            error: error instanceof Error ? error.message : String(error),
            recoverable: true,
          });
        }
      } else {
        reports.push({
          ...report,
          applied: false,
        });
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: !reports.some((report) => typeof report.error === 'string'),
            dryRun,
            migrationId,
            summary: {
              inspected: reports.length,
              changed: reports.filter((report) => report.changed === true).length,
              applied: reports.filter((report) => report.applied === true).length,
              failed: reports.filter((report) => typeof report.error === 'string').length,
            },
            flows: reports,
          }),
        },
      ],
      isError: reports.some((report) => typeof report.error === 'string'),
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
    const initialRevision = calculateWorkflowRevision(flow);
    const requireCurrentRevision =
      typeof args?.requireCurrentRevision === 'string' ? args.requireCurrentRevision.trim() : '';
    if (requireCurrentRevision && requireCurrentRevision !== initialRevision) {
      return createWorkflowRevisionConflictError(
        {
          code: 'STALE_WORKFLOW_REVISION',
          flowId,
          expectedRevision: requireCurrentRevision,
          currentRevision: initialRevision,
        },
        'flow_update requireCurrentRevision does not match the current workflow revision',
      );
    }

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
    try {
      await saveFlowToV3(flow, {
        expectedRevision: initialRevision,
        revisionConflictMessage:
          'flow_update could not save because the workflow changed during update',
      });
    } catch (error) {
      const conflict = getFlowRevisionConflict(error);
      if (conflict) {
        return createWorkflowRevisionConflictError(
          conflict,
          'flow_update could not save because the workflow changed during update',
        );
      }
      throw error;
    }

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
export const workflowRepairRollbackTool = new WorkflowRepairRollbackTool();
export const workflowStabilizeTool = new WorkflowStabilizeTool();
export const workflowMigrateTool = new WorkflowMigrateTool();
export const workflowApprovalStoreTool = new WorkflowApprovalStoreTool();
export const workflowReleaseReadinessTool = new WorkflowReleaseReadinessTool();
