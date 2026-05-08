import type { FlowId } from "../domain/ids";
import type {
  FlowAuditEvent,
  FlowAuditEventKind,
  FlowMeta,
  FlowQualityMeta,
  FlowQualityOracleStrength,
  FlowQualityStatus,
  FlowToolMetadata,
  FlowV3,
} from "../domain/flow";
import {
  FLOW_DSL_VERSION,
  FLOW_NODE_SEMANTICS_VERSION,
  FLOW_SCHEMA_VERSION,
} from "../domain/flow";
import { isSensitiveVariableLike } from "./sensitive";
import {
  createEmptyWorkflowSideEffectSummary,
  isKnownWorkflowSideEffectKind,
  normalizeWorkflowNodeSideEffectProfile,
  type WorkflowSideEffectProfile,
  type WorkflowSideEffectSummary,
} from "webpage-mcp-shared";
import type { JsonObject } from "../domain/json";

export interface PublishedFlowInfoV3 {
  id: FlowId;
  slug: string;
  revision: string;
  version: typeof FLOW_SCHEMA_VERSION;
  name: string;
  description?: string;
  category?: string;
}

export interface PublishedFlowDetailsV3 extends PublishedFlowInfoV3 {
  variables?: FlowV3["variables"];
  schemaHash: string;
  parameters: WorkflowParameterSchema;
  exampleArgs: Record<string, unknown>;
  backgroundSupport: WorkflowBackgroundSupport;
  sideEffects: WorkflowSideEffectDescriptor;
  quality: WorkflowQualitySummary;
  outputs?: NonNullable<FlowV3["meta"]>["exposedOutputs"];
}

export interface WorkflowParameterSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties: boolean;
}

export interface WorkflowBackgroundSupport {
  supported: boolean;
  modes: Array<"currentTab" | "newTab" | "background">;
  caveats: string[];
}

export interface WorkflowSideEffectDescriptor {
  summary: WorkflowSideEffectSummary;
  nodes: Array<{
    id: string;
    kind: string;
    sideEffect: WorkflowSideEffectProfile;
  }>;
}

export interface WorkflowToolDescriptor {
  revision: string;
  schemaHash: string;
  parameters: WorkflowParameterSchema;
  exampleArgs: Record<string, unknown>;
  backgroundSupport: WorkflowBackgroundSupport;
  sideEffects: WorkflowSideEffectDescriptor;
  quality: WorkflowQualitySummary;
  outputs?: NonNullable<FlowV3["meta"]>["exposedOutputs"];
}

export interface WorkflowQualitySummary {
  level: NonNullable<FlowQualityMeta["level"]>;
  status: FlowQualityStatus;
  stabilityScore: number;
  passRate: number;
  validatedRunCount: number;
  countedValidationRuns: number;
  passedRuns: number;
  failedRuns: number;
  minValidationRuns: number;
  revision?: string;
  current: boolean;
  staleReason: string | null;
  unverified: boolean;
  lastValidatedAt?: string;
  lastStabilizedAt?: string;
  freshnessExpiresAt?: string;
  nextRevalidateAt?: string;
  revalidationStatus:
    | "current"
    | "stale"
    | "overdue"
    | "missed"
    | "deferred"
    | "queued"
    | "in_progress"
    | "not_configured";
  revalidationReason?: string;
  slo: {
    targetPassRate: number;
    minValidationRuns: number;
    maxP95RunMs?: number;
    maxFalseRepairRate?: number;
    status: "met" | "warning" | "breached" | "unknown";
    breaches: string[];
  };
  verification: {
    oracle: NonNullable<NonNullable<FlowQualityMeta["verification"]>["oracle"]>;
    oracleStrength: NonNullable<FlowQualityMeta["verification"]>["oracleStrength"];
    required?: boolean;
    missingReason?: string;
    verifiedAt?: string;
  };
  capabilities?: NonNullable<FlowQualityMeta["capabilities"]>;
  warnings: string[];
}

export interface WorkflowAuditEventInput {
  kind: FlowAuditEventKind;
  actor?: FlowAuditEvent["actor"];
  workflow?: string;
  revision?: string;
  runId?: string;
  previousStatus?: FlowQualityStatus;
  nextStatus?: FlowQualityStatus;
  reason?: string;
  metadata?: JsonObject;
}

export interface WorkflowPublishGateOptions {
  requireStable?: boolean;
  requireVerified?: boolean;
  minStabilityScore?: number;
  minValidationRuns?: number;
  minPassRate?: number;
  allowWeakOracle?: boolean;
}

export interface WorkflowPublishGateResult {
  allowed: boolean;
  errors: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
  quality: WorkflowQualitySummary;
}

export const TOOL_SLUG_MAX_LENGTH = 64;
const TOOL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function trimIfString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (nested !== undefined) {
      result[key] = canonicalize(nested);
    }
  }
  return result;
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function createAuditEventId(kind: FlowAuditEventKind, ts: string): string {
  return `audit-${kind}-${fnv1a32(`${ts}:${Math.random().toString(36).slice(2)}`)}`;
}

export function appendWorkflowAuditEvent(
  flow: FlowV3,
  input: WorkflowAuditEventInput,
): FlowV3 {
  const ts = new Date().toISOString();
  const event: FlowAuditEvent = {
    id: createAuditEventId(input.kind, ts),
    kind: input.kind,
    actor: input.actor ?? "mcp",
    ts: ts as FlowAuditEvent["ts"],
    flowId: flow.id,
    ...(input.workflow ? { workflow: input.workflow } : {}),
    ...(input.revision ? { revision: input.revision } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.previousStatus ? { previousStatus: input.previousStatus } : {}),
    ...(input.nextStatus ? { nextStatus: input.nextStatus } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  const existing = Array.isArray(flow.meta?.audit?.events) ? flow.meta.audit.events : [];
  return {
    ...flow,
    meta: {
      ...(flow.meta ?? {}),
      audit: {
        ...(flow.meta?.audit ?? {}),
        events: [...existing, event].slice(-50),
      },
    },
  };
}

function normalizeToolMetadataForRevision(tool: FlowToolMetadata | undefined) {
  if (!tool) {
    return undefined;
  }
  return {
    published: tool.published === true,
    ...(tool.slug ? { slug: tool.slug } : {}),
    ...(tool.category ? { category: tool.category } : {}),
    ...(tool.description ? { description: tool.description } : {}),
  };
}

export function calculateWorkflowRevision(flow: FlowV3): string {
  const revisionInput = {
    schemaVersion: flow.schemaVersion,
    entryNodeId: flow.entryNodeId,
    nodes: (flow.nodes || []).map((node) => ({
      id: node.id,
      kind: node.kind,
      ...(node.name ? { name: node.name } : {}),
      ...(node.disabled === true ? { disabled: true } : {}),
      config: node.config,
      ...(node.policy ? { policy: node.policy } : {}),
      ...(node.sideEffect ? { sideEffect: node.sideEffect } : {}),
    })),
    edges: flow.edges || [],
    variables: flow.variables || [],
    ...(flow.policy ? { policy: flow.policy } : {}),
    meta: {
      tool: normalizeToolMetadataForRevision(flow.meta?.tool),
      exposedOutputs: flow.meta?.exposedOutputs || [],
    },
  };
  return `rev-fnv1a32-${fnv1a32(canonicalStringify(revisionInput))}`;
}

export function calculateWorkflowSchemaHash(flow: FlowV3): string {
  const schemaInput = {
    parameters: buildWorkflowParameterSchema(flow),
    outputs: flow.meta?.exposedOutputs || [],
  };
  return `fnv1a32:${fnv1a32(canonicalStringify(schemaInput))}`;
}

function clampScore(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

function getQualityStaleReason(
  flow: FlowV3,
  quality: FlowQualityMeta | undefined,
  currentRevision: string,
  nowMs: number,
): string | null {
  if (!quality) {
    return "missing_quality";
  }
  if (!quality.revision) {
    return "missing_quality_revision";
  }
  if (quality.revision !== currentRevision) {
    return "revision_mismatch";
  }
  if (
    quality.freshnessExpiresAt &&
    Number.isFinite(Date.parse(quality.freshnessExpiresAt)) &&
    Date.parse(quality.freshnessExpiresAt) <= nowMs
  ) {
    return "freshness_expired";
  }
  if (
    quality.revalidation?.nextRevalidateAt &&
    Number.isFinite(Date.parse(quality.revalidation.nextRevalidateAt)) &&
    Date.parse(quality.revalidation.nextRevalidateAt) <= nowMs
  ) {
    return "revalidation_overdue";
  }
  if ((quality.consecutiveFailureCount ?? 0) >= 3) {
    return "consecutive_failures";
  }
  if (
    flow.meta?.runtime?.dslVersion &&
    flow.meta.runtime.dslVersion !== FLOW_DSL_VERSION
  ) {
    return "dsl_version_mismatch";
  }
  if (
    flow.meta?.runtime?.nodeSemanticsVersion &&
    flow.meta.runtime.nodeSemanticsVersion !== FLOW_NODE_SEMANTICS_VERSION
  ) {
    return "node_semantics_mismatch";
  }
  return quality.staleReason ?? null;
}

function getRevalidationStatus(
  quality: FlowQualityMeta | undefined,
  staleReason: string | null,
  nowMs: number,
): WorkflowQualitySummary["revalidationStatus"] {
  if (!quality?.revalidation?.policy) {
    return "not_configured";
  }
  if (
    quality.revalidation.status === "missed" ||
    quality.revalidation.status === "deferred" ||
    quality.revalidation.status === "queued" ||
    quality.revalidation.status === "in_progress"
  ) {
    return quality.revalidation.status;
  }
  if (staleReason) {
    return staleReason === "revalidation_overdue" ? "overdue" : "stale";
  }
  const nextRevalidateAt = quality.revalidation.nextRevalidateAt;
  if (
    nextRevalidateAt &&
    Number.isFinite(Date.parse(nextRevalidateAt)) &&
    Date.parse(nextRevalidateAt) <= nowMs
  ) {
    return "overdue";
  }
  return "current";
}

function buildWorkflowSloSummary(
  quality: FlowQualityMeta | undefined,
): WorkflowQualitySummary["slo"] {
  const targetPassRate = clampScore(quality?.slo?.targetPassRate ?? 1);
  const minValidationRuns = Math.max(
    1,
    Math.floor(quality?.slo?.minValidationRuns ?? quality?.minValidationRuns ?? 3),
  );
  const maxP95RunMs =
    typeof quality?.slo?.maxP95RunMs === "number" && Number.isFinite(quality.slo.maxP95RunMs)
      ? Math.max(1, Math.floor(quality.slo.maxP95RunMs))
      : undefined;
  const maxFalseRepairRate =
    typeof quality?.slo?.maxFalseRepairRate === "number" &&
    Number.isFinite(quality.slo.maxFalseRepairRate)
      ? clampScore(quality.slo.maxFalseRepairRate)
      : undefined;
  const breaches: string[] = [];
  if (!quality) {
    return {
      targetPassRate,
      minValidationRuns,
      ...(maxP95RunMs ? { maxP95RunMs } : {}),
      ...(maxFalseRepairRate !== undefined ? { maxFalseRepairRate } : {}),
      status: "unknown",
      breaches: ["missing_quality"],
    };
  }
  const countedRuns = Math.max(0, Math.floor(quality.countedValidationRuns ?? quality.validationRuns ?? 0));
  const passRate = clampScore(quality.passRate);
  if (countedRuns < minValidationRuns) breaches.push("insufficient_validation_runs");
  if (passRate < targetPassRate) breaches.push("pass_rate_below_target");
  if ((quality.consecutiveFailureCount ?? 0) >= 3) breaches.push("consecutive_failures");
  return {
    targetPassRate,
    minValidationRuns,
    ...(maxP95RunMs ? { maxP95RunMs } : {}),
    ...(maxFalseRepairRate !== undefined ? { maxFalseRepairRate } : {}),
    status: breaches.length === 0 ? "met" : countedRuns > 0 ? "breached" : "warning",
    breaches,
  };
}

export function buildWorkflowQualitySummary(
  flow: FlowV3,
  options: { nowMs?: number } = {},
): WorkflowQualitySummary {
  const currentRevision = calculateWorkflowRevision(flow);
  const quality = flow.meta?.quality;
  const nowMs = options.nowMs ?? Date.now();
  const staleReason = getQualityStaleReason(flow, quality, currentRevision, nowMs);
  const explicitStatus = quality?.status;
  const suspendedOrBlocked = explicitStatus === "paused" || explicitStatus === "blocked";
  const current = Boolean(quality) && !staleReason && !suspendedOrBlocked;
  const level = quality?.level ?? "unverified";
  const status =
    !quality
      ? "draft"
      : suspendedOrBlocked
        ? explicitStatus
      : staleReason
        ? "stale"
        : quality.status ?? (level === "verified" ? "verified" : level === "stable" ? "stable" : "draft");
  const warnings = new Set<string>(quality?.warnings ?? []);
  if (!quality) warnings.add("missing_quality");
  if (staleReason) warnings.add(staleReason);
  if ((quality?.verification?.oracle ?? "none") === "none") {
    warnings.add("missing_business_oracle");
  }
  const slo = buildWorkflowSloSummary(quality);
  if (slo.status === "breached") {
    warnings.add("slo_breached");
  } else if (slo.status === "warning") {
    warnings.add("slo_warning");
  }
  if (quality?.revalidation?.status === "missed") {
    warnings.add("revalidation_missed");
  } else if (quality?.revalidation?.status === "deferred") {
    warnings.add("revalidation_deferred");
  }
  const revalidationReason =
    quality?.revalidation?.lastDeferredReason ?? quality?.revalidation?.lastRevalidateReason;

  return {
    level,
    status,
    stabilityScore: clampScore(quality?.stabilityScore),
    passRate: clampScore(quality?.passRate),
    validatedRunCount: Math.max(0, Math.floor(quality?.validationRuns ?? 0)),
    countedValidationRuns: Math.max(
      0,
      Math.floor(quality?.countedValidationRuns ?? quality?.validationRuns ?? 0),
    ),
    passedRuns: Math.max(0, Math.floor(quality?.passedRuns ?? 0)),
    failedRuns: Math.max(0, Math.floor(quality?.failedRuns ?? 0)),
    minValidationRuns: Math.max(
      1,
      Math.floor(quality?.minValidationRuns ?? quality?.slo?.minValidationRuns ?? 3),
    ),
    ...(quality?.revision ? { revision: quality.revision } : {}),
    current,
    staleReason,
    unverified: level === "unverified" || !quality,
    ...(quality?.lastValidatedAt ? { lastValidatedAt: quality.lastValidatedAt } : {}),
    ...(quality?.lastStabilizedAt ? { lastStabilizedAt: quality.lastStabilizedAt } : {}),
    ...(quality?.freshnessExpiresAt ? { freshnessExpiresAt: quality.freshnessExpiresAt } : {}),
    ...(quality?.revalidation?.nextRevalidateAt
      ? { nextRevalidateAt: quality.revalidation.nextRevalidateAt }
      : {}),
    revalidationStatus: getRevalidationStatus(quality, staleReason, nowMs),
    ...(revalidationReason ? { revalidationReason } : {}),
    slo,
    verification: {
      oracle: quality?.verification?.oracle ?? "none",
      oracleStrength: quality?.verification?.oracleStrength ?? "weak",
      ...(quality?.verification?.required !== undefined
        ? { required: quality.verification.required }
        : {}),
      ...(quality?.verification?.missingReason
        ? { missingReason: quality.verification.missingReason }
        : {}),
      ...(quality?.verification?.verifiedAt ? { verifiedAt: quality.verification.verifiedAt } : {}),
    },
    ...(quality?.capabilities ? { capabilities: quality.capabilities } : {}),
    warnings: Array.from(warnings).sort(),
  };
}

function oracleStrengthRank(strength: FlowQualityOracleStrength | undefined): number {
  return strength === "strong" ? 3 : strength === "normal" ? 2 : strength === "weak" ? 1 : 0;
}

export function evaluateWorkflowPublishGate(
  flow: FlowV3,
  options: WorkflowPublishGateOptions = {},
): WorkflowPublishGateResult {
  const quality = buildWorkflowQualitySummary(flow);
  const errors: WorkflowPublishGateResult["errors"] = [];
  const warnings: WorkflowPublishGateResult["warnings"] = [];
  const descriptor = buildWorkflowToolDescriptor(flow);
  const minValidationRuns = Math.max(
    1,
    Math.floor(options.minValidationRuns ?? quality.minValidationRuns),
  );
  const minPassRate = clampScore(options.minPassRate ?? flow.meta?.quality?.slo?.targetPassRate ?? 1);
  const minStabilityScore = clampScore(options.minStabilityScore ?? 0);
  const requireStable = options.requireStable === true || options.requireVerified === true;

  if (descriptor.sideEffects.summary.dangerous > 0 || descriptor.sideEffects.summary.unknown > 0) {
    warnings.push({
      code: "PUBLISH_SIDE_EFFECTS_REQUIRE_REVIEW",
      message: "Workflow has dangerous or unknown side effects and should be run only in an approved environment.",
    });
  }
  if (quality.verification.oracle === "none") {
    warnings.push({
      code: "PUBLISH_MISSING_BUSINESS_ORACLE",
      message: "Workflow has no business oracle; it can be stable but not verified.",
    });
  }
  if (quality.slo.status === "breached") {
    warnings.push({
      code: "PUBLISH_SLO_BREACHED",
      message: `Workflow SLO is breached: ${quality.slo.breaches.join(", ") || "unknown"}.`,
    });
  }

  if (requireStable) {
    if (!quality.current) {
      errors.push({
        code: "PUBLISH_QUALITY_STALE",
        message: `Workflow quality is not current: ${quality.staleReason ?? "unknown"}`,
      });
    }
    if (quality.countedValidationRuns < minValidationRuns) {
      errors.push({
        code: "PUBLISH_INSUFFICIENT_VALIDATION_RUNS",
        message: `Workflow needs at least ${minValidationRuns} counted validation run(s); found ${quality.countedValidationRuns}.`,
      });
    }
    if (quality.passRate < minPassRate) {
      errors.push({
        code: "PUBLISH_PASS_RATE_BELOW_THRESHOLD",
        message: `Workflow passRate ${quality.passRate} is below required ${minPassRate}.`,
      });
    }
    if (quality.stabilityScore < minStabilityScore) {
      errors.push({
        code: "PUBLISH_STABILITY_SCORE_BELOW_THRESHOLD",
        message: `Workflow stabilityScore ${quality.stabilityScore} is below required ${minStabilityScore}.`,
      });
    }
    if (quality.slo.status === "breached") {
      errors.push({
        code: "PUBLISH_SLO_BREACHED",
        message: `Workflow SLO is breached: ${quality.slo.breaches.join(", ") || "unknown"}.`,
      });
    }
    if (quality.level !== "stable" && quality.level !== "verified") {
      errors.push({
        code: "PUBLISH_QUALITY_NOT_STABLE",
        message: `Workflow quality level must be stable or verified; found ${quality.level}.`,
      });
    }
  } else if (!quality.current || quality.unverified) {
    warnings.push({
      code: "PUBLISH_UNVERIFIED_WARNING",
      message: "Workflow is being published without a current stable quality record.",
    });
  }

  if (options.requireVerified === true) {
    if (quality.level !== "verified") {
      errors.push({
        code: "PUBLISH_QUALITY_NOT_VERIFIED",
        message: `Workflow quality level must be verified; found ${quality.level}.`,
      });
    }
    if (quality.verification.oracle === "none") {
      errors.push({
        code: "PUBLISH_MISSING_VERIFICATION_ORACLE",
        message: "requireVerified needs an assertion, declared output, expected outcome, or equivalent business oracle.",
      });
    }
    if (
      oracleStrengthRank(quality.verification.oracleStrength) < 2 &&
      options.allowWeakOracle !== true
    ) {
      errors.push({
        code: "PUBLISH_WEAK_ORACLE",
        message: "Weak verification oracles do not satisfy requireVerified unless explicitly allowed.",
      });
    }
  }

  return {
    allowed: errors.length === 0,
    errors,
    warnings,
    quality,
  };
}

export function toToolSlug(name: string): string {
  return (name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, TOOL_SLUG_MAX_LENGTH);
}

export function normalizeToolSlug(
  input: unknown,
  fallbackName: string,
): string {
  const fallback = toToolSlug(fallbackName);
  const normalized = typeof input === "string" ? toToolSlug(input) : "";
  const slug = normalized || fallback;

  if (!slug) {
    throw new Error("Published workflows require a non-empty slug");
  }
  if (!TOOL_SLUG_PATTERN.test(slug)) {
    throw new Error(
      "Published workflow slug must contain only lowercase letters, numbers, and single hyphens",
    );
  }

  return slug;
}

export function isFlowPublished(flow: FlowV3): boolean {
  return flow.meta?.tool?.published === true;
}

export function getPublishedFlowInfo(flow: FlowV3): PublishedFlowInfoV3 | null {
  if (!isFlowPublished(flow)) {
    return null;
  }

  const slug = normalizeToolSlug(flow.meta?.tool?.slug, flow.name);
  const description = trimIfString(flow.meta?.tool?.description) || trimIfString(flow.description);
  const category = trimIfString(flow.meta?.tool?.category);

  return {
    id: flow.id,
    slug,
    revision: calculateWorkflowRevision(flow),
    version: FLOW_SCHEMA_VERSION,
    name: flow.name,
    ...(description ? { description } : {}),
    ...(category ? { category } : {}),
  };
}

export function listPublishedFlowInfos(flows: FlowV3[]): PublishedFlowInfoV3[] {
  return flows
    .map((flow) => getPublishedFlowInfo(flow))
    .filter((info): info is PublishedFlowInfoV3 => Boolean(info))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function sanitizePublishedVariables(
  variables: FlowV3["variables"] | undefined,
): FlowV3["variables"] | undefined {
  if (!Array.isArray(variables)) {
    return undefined;
  }

  const sanitized = variables
    .filter((variable) => !isSensitiveVariableLike(variable))
    .map((variable) => ({
      name: variable.name,
      ...(variable.label ? { label: variable.label } : {}),
      ...(variable.description ? { description: variable.description } : {}),
      ...(typeof variable.required === "boolean"
        ? { required: variable.required }
        : {}),
      ...(variable.default !== undefined ? { default: variable.default } : {}),
      ...(variable.kind ? { kind: variable.kind } : {}),
      ...(Array.isArray(variable.options) ? { options: variable.options } : {}),
      ...(variable.item ? { item: variable.item } : {}),
      ...(variable.scope ? { scope: variable.scope } : {}),
    }));

  return sanitized.length > 0 ? sanitized : undefined;
}

function inferVariableKind(variable: NonNullable<FlowV3["variables"]>[number]): string {
  if (variable.kind) return variable.kind;
  if (typeof variable.default === "number") return "number";
  if (typeof variable.default === "boolean") return "boolean";
  if (Array.isArray(variable.default)) return "array";
  if (variable.default && typeof variable.default === "object") return "json";
  return "string";
}

function schemaForVariable(
  variable: NonNullable<FlowV3["variables"]>[number],
): Record<string, unknown> {
  const kind = inferVariableKind(variable);
  const sensitive = isSensitiveVariableLike(variable);
  const schema: Record<string, unknown> = {
    type:
      kind === "number"
        ? "number"
        : kind === "boolean"
          ? "boolean"
          : kind === "array"
            ? "array"
            : kind === "json"
              ? ["object", "array", "string", "number", "boolean", "null"]
              : "string",
  };
  if (variable.label) schema.title = variable.label;
  if (variable.description) schema.description = variable.description;
  if (sensitive) {
    schema.description = [schema.description, "Sensitive value; default is not exposed."]
      .filter(Boolean)
      .join(" ");
  }
  if (kind === "enum" && Array.isArray(variable.options) && variable.options.length > 0) {
    schema.enum = variable.options;
  }
  if (kind === "array" && variable.item) {
    schema.items = { type: variable.item === "json" ? "object" : variable.item };
  }
  if (!sensitive && variable.default !== undefined) {
    schema.default = variable.default;
  }
  return schema;
}

export function buildWorkflowParameterSchema(flow: FlowV3): WorkflowParameterSchema {
  const properties: WorkflowParameterSchema["properties"] = {};
  const required: string[] = [];
  for (const variable of flow.variables || []) {
    if (!variable?.name) continue;
    properties[variable.name] = schemaForVariable(variable);
    if (variable.required === true && variable.default === undefined) {
      required.push(variable.name);
    }
  }
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export function buildWorkflowExampleArgs(flow: FlowV3): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const variable of flow.variables || []) {
    if (!variable?.name) continue;
    if (isSensitiveVariableLike(variable)) {
      args[variable.name] = `<${variable.name}>`;
    } else if (variable.default !== undefined) {
      args[variable.name] = variable.default;
    } else if (variable.kind === "number") {
      args[variable.name] = 1;
    } else if (variable.kind === "boolean") {
      args[variable.name] = true;
    } else if (variable.kind === "array") {
      args[variable.name] = [];
    } else if (variable.kind === "json") {
      args[variable.name] = {};
    } else if (variable.kind === "enum" && Array.isArray(variable.options) && variable.options.length > 0) {
      args[variable.name] = variable.options[0];
    } else {
      args[variable.name] = `<${variable.name}>`;
    }
  }
  return args;
}

export function buildWorkflowSideEffectDescriptor(flow: FlowV3): WorkflowSideEffectDescriptor {
  const summary = createEmptyWorkflowSideEffectSummary();
  const executableNodes = (Array.isArray(flow.nodes) ? flow.nodes : []).filter(
    (node) => node.kind !== "trigger",
  );
  const nodes = executableNodes.map((node) => {
    const sideEffect = normalizeWorkflowNodeSideEffectProfile(
      node.kind,
      node.config,
      node.sideEffect,
    );
    summary[sideEffect.category] += 1;
    if (!isKnownWorkflowSideEffectKind(node.kind)) summary.unknown += 1;
    return {
      id: node.id,
      kind: node.kind,
      sideEffect,
    };
  });
  return { summary, nodes };
}

export function buildWorkflowBackgroundSupport(flow: FlowV3): WorkflowBackgroundSupport {
  const caveats: string[] = [];
  for (const node of flow.nodes || []) {
    if (node.kind === "screenshot") {
      const config = node.config || {};
      const selector =
        typeof config.selector === "string" ? config.selector.trim() : "";
      if (config.fullPage === true || selector) {
        caveats.push(
          `Node ${node.id} uses full-page or selector screenshot capture, which requires foreground capture.`,
        );
      }
    }
  }
  return {
    supported: caveats.length === 0,
    modes: caveats.length === 0 ? ["currentTab", "newTab", "background"] : ["currentTab", "newTab"],
    caveats,
  };
}

export function buildWorkflowToolDescriptor(flow: FlowV3): WorkflowToolDescriptor {
  return {
    revision: calculateWorkflowRevision(flow),
    schemaHash: calculateWorkflowSchemaHash(flow),
    parameters: buildWorkflowParameterSchema(flow),
    exampleArgs: buildWorkflowExampleArgs(flow),
    backgroundSupport: buildWorkflowBackgroundSupport(flow),
    sideEffects: buildWorkflowSideEffectDescriptor(flow),
    quality: buildWorkflowQualitySummary(flow),
    ...(Array.isArray(flow.meta?.exposedOutputs) && flow.meta.exposedOutputs.length > 0
      ? { outputs: flow.meta.exposedOutputs.map((output) => ({ ...output })) }
      : {}),
  };
}

export function listPublishedFlowDetails(
  flows: FlowV3[],
): PublishedFlowDetailsV3[] {
  const details: PublishedFlowDetailsV3[] = [];
  for (const flow of flows) {
    const info = getPublishedFlowInfo(flow);
    if (!info) {
      continue;
    }
    const publishedVariables = sanitizePublishedVariables(flow.variables);
    details.push({
      ...info,
      ...(publishedVariables ? { variables: publishedVariables } : {}),
      ...buildWorkflowToolDescriptor(flow),
    });
  }
  return details.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function ensurePublishedSlugAvailable(
  flows: FlowV3[],
  targetFlowId: FlowId,
  slug: string,
): void {
  const collision = flows.find((flow) => {
    if (flow.id === targetFlowId || !isFlowPublished(flow)) {
      return false;
    }

    return normalizeToolSlug(flow.meta?.tool?.slug, flow.name) === slug;
  });

  if (collision) {
    throw new Error(
      `Published workflow slug "${slug}" is already used by flow "${collision.id}"`,
    );
  }
}

export function mergeFlowToolMetadata(
  meta: FlowMeta | undefined,
  patch: Partial<FlowToolMetadata>,
): FlowMeta {
  const nextMeta: FlowMeta = {
    ...(meta ?? {}),
    tool: {
      ...(meta?.tool ?? {}),
      ...patch,
    },
  };

  return nextMeta;
}
