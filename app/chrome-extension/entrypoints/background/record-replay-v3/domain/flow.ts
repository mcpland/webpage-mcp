/**
 * @fileoverview Flow type definition
 * @description Defining Flow IR (Intermediate Representation) in Record-Replay V3
 */

import type { WorkflowSideEffectProfile } from "webpage-mcp-shared";
import type { ISODateTimeString, JsonObject } from "./json";
import type { EdgeId, EdgeLabel, FlowId, NodeId } from "./ids";
import type { FlowPolicy, NodePolicy } from "./policy";
import type { VariableDefinition } from "./variables";

/** Flow Schema version */
export const FLOW_SCHEMA_VERSION = 3 as const;
export const FLOW_DSL_VERSION = "2026-05-09" as const;
export const FLOW_NODE_SEMANTICS_VERSION = "2026-05-09.workflow-nodes" as const;

/**
 * Edge V3
 * @description DAG The edge in , connects two nodes
 */
export interface EdgeV3 {
  /** Edge unique identifier */
  id: EdgeId;
  /** Source node ID */
  from: NodeId;
  /** Target node ID */
  to: NodeId;
  /** Edge labels (for conditional branching and error handling) */
  label?: EdgeLabel;
}

/** Node type (extensible) */
export type NodeKind = string;

/**
 * Node V3
 * @description DAG The nodes in represent an executable operation
 */
export interface NodeV3 {
  /** Node unique identifier */
  id: NodeId;
  /** Node type */
  kind: NodeKind;
  /** Node name (for display) */
  name?: string;
  /** Whether to disable */
  disabled?: boolean;
  /** Side-effect and retry safety classification */
  sideEffect?: WorkflowSideEffectProfile;
  /** Node level policy */
  policy?: NodePolicy;
  /** Node configuration (type determined by kind) */
  config: JsonObject;
  /** UI layout information */
  ui?: { x: number; y: number };
}

/**
 * Flow metadata binding
 * @description Define the association of Flow with a specific domain name/path/URL
 */
export interface FlowBinding {
  kind: "domain" | "path" | "url";
  value: string;
}

export interface FlowToolMetadata {
  published?: boolean;
  slug?: string;
  category?: string;
  description?: string;
}

export interface FlowExposedOutput {
  nodeId: NodeId;
  as: string;
  path?: Array<string | number>;
  schema?: JsonObject;
  required?: boolean;
  sensitive?: boolean;
  allowPlaintext?: boolean;
}

export interface FlowRecordingParameterSuggestion {
  nodeId: NodeId;
  kind: "fill" | "navigate";
  suggestedKey: string;
  currentValue: string;
}

export interface FlowRecordingMeta {
  originUrl?: string;
  originTitle?: string;
  originTabId?: number;
  browser?: string;
  userAgent?: string;
  startedAt?: ISODateTimeString;
  stoppedAt?: ISODateTimeString;
  durationMs?: number;
  stepCount?: number;
  parameterSuggestions?: FlowRecordingParameterSuggestion[];
}

export interface FlowStopBarrierFailure {
  tabId: number;
  skipped?: boolean;
  reason?: string;
  topTimedOut?: boolean;
  topError?: string;
  subframesFailed?: number;
}

export interface FlowStopBarrierMeta {
  ok: boolean;
  sessionId?: string;
  stoppedAt?: ISODateTimeString;
  failed?: FlowStopBarrierFailure[];
}

export type FlowQualityLevel = "unverified" | "stable" | "verified";
export type FlowQualityStatus = "draft" | "stable" | "verified" | "stale" | "paused" | "blocked";
export type FlowQualityCapabilityStatus = "full" | "partial" | "none" | "unknown";
export type FlowQualityRisk = "safe" | "idempotent" | "dangerous" | "unknown";
export type FlowQualityOracle = "none" | "assertion" | "declaredOutput" | "expectedOutcome";
export type FlowQualityOracleStrength = "weak" | "normal" | "strong";

export interface FlowQualityValidationContext {
  argsHash?: string;
  argsHashAlgorithm?: "hmac-sha256";
  startUrl?: string;
  tabTarget?: string;
  background?: boolean;
  executionMode?: string;
  testEnvironment?: string;
  siteFingerprint?: string;
  runGroupId?: string;
  tabOwnership?: "owned" | "current";
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  locale?: string;
  timezone?: string;
  userAgentHash?: string;
  browserVersion?: string;
  extensionVersion?: string;
  mcpServerVersion?: string;
  protocolVersion?: string;
  capabilityVersion?: string;
  profileHash?: string;
  accountLabel?: string;
  permissionSetHash?: string;
  cookieStateHash?: string;
}

export interface FlowQualityVerification {
  oracle?: FlowQualityOracle;
  oracleStrength?: FlowQualityOracleStrength;
  required?: boolean;
  missingReason?: string;
  verifiedAt?: ISODateTimeString;
}

export interface FlowQualityCapabilities {
  replayValidation?: FlowQualityCapabilityStatus;
  domSnapshot?: FlowQualityCapabilityStatus;
  accessibilitySnapshot?: FlowQualityCapabilityStatus;
  navigationEvents?: FlowQualityCapabilityStatus;
  networkEvents?: FlowQualityCapabilityStatus;
  mutationEvents?: FlowQualityCapabilityStatus;
  selectorResolution?: FlowQualityCapabilityStatus;
  screenshots?: FlowQualityCapabilityStatus;
  crossOriginFrames?: FlowQualityCapabilityStatus;
  closedShadowDom?: FlowQualityCapabilityStatus;
  downloads?: FlowQualityCapabilityStatus;
  mfa?: FlowQualityCapabilityStatus;
  captcha?: FlowQualityCapabilityStatus;
  unsupportedReasons?: string[];
}

export interface FlowQualityExcludedRuns {
  count: number;
  reasons: string[];
}

export interface FlowQualityValidationRecord {
  id: string;
  tool: string;
  revision: string;
  runGroupId?: string;
  completedAt: ISODateTimeString;
  phase?: "baseline" | "postRepair";
  passRate: number;
  stabilityScore: number;
  countedRuns: number;
  passedRuns: number;
  failedRuns: number;
  excludedRuns?: FlowQualityExcludedRuns;
  runIds?: string[];
  validationContext?: FlowQualityValidationContext;
  risk?: FlowQualityRisk;
  segmentOnly?: boolean;
}

export interface FlowQualityMeta {
  lastAnalyzedAt?: ISODateTimeString;
  lastStabilizedAt?: ISODateTimeString;
  revision?: string;
  status?: FlowQualityStatus;
  level?: FlowQualityLevel;
  stabilityScore?: number;
  passRate?: number;
  validationRuns?: number;
  countedValidationRuns?: number;
  passedRuns?: number;
  failedRuns?: number;
  excludedRuns?: FlowQualityExcludedRuns;
  minValidationRuns?: number;
  lastFailureNodeId?: string;
  lastFailureCode?: string;
  risk?: FlowQualityRisk;
  validationContext?: FlowQualityValidationContext;
  verification?: FlowQualityVerification;
  capabilities?: FlowQualityCapabilities;
  lastValidatedAt?: ISODateTimeString;
  freshnessExpiresAt?: ISODateTimeString;
  consecutiveFailureCount?: number;
  staleReason?: string;
  revalidation?: {
    policy?: "manual" | "onFailure" | "scheduled" | "siteChange";
    status?: "current" | "queued" | "in_progress" | "missed" | "deferred";
    nextRevalidateAt?: ISODateTimeString;
    lastAttemptedAt?: ISODateTimeString;
    lastRevalidateReason?: string;
    lastDeferredReason?: string;
    autoDowngrade?: boolean;
  };
  slo?: {
    targetPassRate?: number;
    minValidationRuns?: number;
    maxP95RunMs?: number;
    maxFalseRepairRate?: number;
  };
  artifactRunIds?: string[];
  warnings?: string[];
  validationRecords?: FlowQualityValidationRecord[];
}

export interface FlowRuntimeMeta {
  protocolVersion?: string;
  capabilityVersion?: string;
  dslVersion?: string;
  nodeSemanticsVersion?: string;
  minExtensionVersion?: string;
  minMcpServerVersion?: string;
  clientCapabilities?: string[];
  featureFlags?: string[];
}

export interface FlowRepairHistoryEntry {
  repairRevision?: string;
  baseRevision?: string;
  resultingRevision?: string;
  appliedAt: ISODateTimeString;
  patchSummary?: string;
  beforeQuality?: number;
  afterQuality?: number;
  rollbackRevision?: string;
  changes?: Array<{ code?: string; message?: string; nodeId?: string }>;
  provenance?: {
    source?: string;
    pageContentUsed?: boolean;
  };
  rollback?: {
    beforeRevision?: string;
    available?: boolean;
    reason?: string;
    snapshot?: JsonObject;
  };
}

export interface FlowRepairsMeta {
  currentRepairRevision?: string;
  history?: FlowRepairHistoryEntry[];
}

export type FlowAuditEventKind =
  | "workflow_publish"
  | "workflow_unpublish"
  | "approval_create"
  | "approval_revoke"
  | "approval_use"
  | "risk_override"
  | "repair_apply"
  | "repair_rollback"
  | "schema_migration"
  | "quality_downgrade"
  | "quality_status_change"
  | "secret_ref_use"
  | "policy_change";

export interface FlowAuditEvent {
  id: string;
  kind: FlowAuditEventKind;
  actor: "mcp" | "runtime" | "system";
  ts: ISODateTimeString;
  flowId?: FlowId;
  workflow?: string;
  revision?: string;
  runId?: string;
  previousStatus?: FlowQualityStatus;
  nextStatus?: FlowQualityStatus;
  reason?: string;
  metadata?: JsonObject;
}

export interface FlowAuditMeta {
  events?: FlowAuditEvent[];
}

export interface FlowMeta {
  domain?: string;
  tags?: string[];
  bindings?: FlowBinding[];
  tool?: FlowToolMetadata;
  exposedOutputs?: FlowExposedOutput[];
  recording?: FlowRecordingMeta;
  stopBarrier?: FlowStopBarrierMeta;
  quality?: FlowQualityMeta;
  runtime?: FlowRuntimeMeta;
  repairs?: FlowRepairsMeta;
  audit?: FlowAuditMeta;
}

/**
 * Flow V3
 * @description Complete Flow definition, including nodes, edges and configurations
 */
export interface FlowV3 {
  /** Schema version */
  schemaVersion: typeof FLOW_SCHEMA_VERSION;
  /** Flow unique identifier */
  id: FlowId;
  /** Flow Name */
  name: string;
  /** Flow Description */
  description?: string;
  /** creation time */
  createdAt: ISODateTimeString;
  /** Update time */
  updatedAt: ISODateTimeString;

  /** Entry node ID (specified explicitly, does not rely on in-degree inference) */
  entryNodeId: NodeId;
  /** node list */
  nodes: NodeV3[];
  /** edge list */
  edges: EdgeV3[];

  /** variable definition */
  variables?: VariableDefinition[];
  /** Flow level strategy */
  policy?: FlowPolicy;
  /** Metadata */
  meta?: FlowMeta;
}

/**
 * Find node by ID
 */
export function findNodeById(flow: FlowV3, nodeId: NodeId): NodeV3 | undefined {
  return flow.nodes.find((n) => n.id === nodeId);
}

/**
 * Find all edges starting from a specified node
 */
export function findEdgesFrom(flow: FlowV3, nodeId: NodeId): EdgeV3[] {
  return flow.edges.filter((e) => e.from === nodeId);
}

/**
 * Find all edges pointing to a specified node
 */
export function findEdgesTo(flow: FlowV3, nodeId: NodeId): EdgeV3[] {
  return flow.edges.filter((e) => e.to === nodeId);
}
