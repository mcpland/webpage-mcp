import type { ISODateTimeString, JsonObject } from "../domain/json";
import type { NodeId } from "../domain/ids";
import type {
  FlowBinding,
  FlowExposedOutput,
  FlowMeta,
  FlowQualityCapabilityStatus,
  FlowQualityCapabilities,
  FlowQualityExcludedRuns,
  FlowQualityMeta,
  FlowQualityOracle,
  FlowQualityOracleStrength,
  FlowQualityRisk,
  FlowQualityStatus,
  FlowQualityValidationContext,
  FlowQualityValidationRecord,
  FlowRepairsMeta,
  FlowRecordingMeta,
  FlowRepairHistoryEntry,
  FlowRuntimeMeta,
  FlowStopBarrierMeta,
  FlowToolMetadata,
  FlowV3,
} from "../domain/flow";
import { normalizeVariableDefinitions } from "../domain/variables";
import { normalizeToolSlug } from "./publish";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

function optionalIsoString(value: unknown): ISODateTimeString | undefined {
  const text = trimmedString(value);
  return text as ISODateTimeString | undefined;
}

function normalizeStringArray(value: unknown, maxItems = 20): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value
    .map((entry) => trimmedString(entry))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, maxItems);
  return strings.length > 0 ? strings : undefined;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

interface FlowToolMetadataNormalizationOptions {
  generateSlugWhenPublished?: boolean;
}

export function normalizeFlowOptionalFields(
  value: JsonObject,
  flowName: string,
  nodeIdSet: Set<string>,
): Pick<FlowV3, "description" | "variables" | "policy" | "meta"> {
  const normalized: Pick<FlowV3, "description" | "variables" | "policy" | "meta"> = {};

  if (value.description !== undefined && value.description !== null) {
    if (typeof value.description !== "string") {
      throw new Error("flow.description must be a string");
    }
    normalized.description = value.description;
  }

  if (value.variables !== undefined && value.variables !== null) {
    const variables = normalizeVariableDefinitions(value.variables, "flow.variables");
    if (variables.length > 0) {
      normalized.variables = variables;
    }
  }

  if (value.policy !== undefined && value.policy !== null) {
    if (typeof value.policy !== "object" || Array.isArray(value.policy)) {
      throw new Error("flow.policy must be an object");
    }
    normalized.policy = value.policy as FlowV3["policy"];
  }

  if (value.meta !== undefined && value.meta !== null) {
    if (typeof value.meta !== "object" || Array.isArray(value.meta)) {
      throw new Error("flow.meta must be an object");
    }
    const meta = normalizeFlowMeta(value.meta as JsonObject, flowName, nodeIdSet);
    if (meta) {
      normalized.meta = meta;
    }
  }

  return normalized;
}

export function normalizeFlowToolMetadata(
  value: JsonObject,
  flowName: string,
  options: FlowToolMetadataNormalizationOptions = {},
): FlowToolMetadata | undefined {
  const tool: FlowToolMetadata = {};

  if (value.published !== undefined && value.published !== null) {
    if (typeof value.published !== "boolean") {
      throw new Error("flow.meta.tool.published must be a boolean");
    }
    tool.published = value.published;
  }

  if (value.slug !== undefined && value.slug !== null) {
    if (typeof value.slug !== "string") {
      throw new Error("flow.meta.tool.slug must be a string");
    }
    tool.slug = normalizeToolSlug(value.slug, flowName);
  } else if (tool.published && options.generateSlugWhenPublished !== false) {
    tool.slug = normalizeToolSlug(undefined, flowName);
  }

  if (value.category !== undefined && value.category !== null) {
    if (typeof value.category !== "string") {
      throw new Error("flow.meta.tool.category must be a string");
    }
    const category = value.category.trim();
    if (category) {
      tool.category = category;
    }
  }

  if (value.description !== undefined && value.description !== null) {
    if (typeof value.description !== "string") {
      throw new Error("flow.meta.tool.description must be a string");
    }
    const description = value.description.trim();
    if (description) {
      tool.description = description;
    }
  }

  return Object.keys(tool).length > 0 ? tool : undefined;
}

export function sanitizeFlowToolMetadata(
  value: unknown,
  flowName: string,
  options: FlowToolMetadataNormalizationOptions = {},
): FlowToolMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as JsonObject;
  const sanitizedInput: JsonObject = {};

  if (typeof record.published === "boolean") {
    sanitizedInput.published = record.published;
  }
  if (typeof record.slug === "string" && record.slug.trim()) {
    sanitizedInput.slug = record.slug;
  }
  if (typeof record.category === "string") {
    sanitizedInput.category = record.category;
  }
  if (typeof record.description === "string") {
    sanitizedInput.description = record.description;
  }

  return normalizeFlowToolMetadata(sanitizedInput, flowName, options);
}

function normalizeFlowMeta(
  value: JsonObject,
  flowName: string,
  nodeIdSet: Set<string>,
): FlowMeta | undefined {
  const meta: FlowMeta = {};

  const explicitDomain =
    typeof value.domain === "string" && value.domain.trim()
      ? value.domain.trim()
      : undefined;
  if (explicitDomain) {
    meta.domain = explicitDomain;
  }

  if (value.tags !== undefined && value.tags !== null) {
    if (!Array.isArray(value.tags)) {
      throw new Error("flow.meta.tags must be an array");
    }
    const tags = value.tags
      .map((tag, index) => {
        if (typeof tag !== "string") {
          throw new Error(`flow.meta.tags[${index}] must be a string`);
        }
        return tag.trim();
      })
      .filter(Boolean);
    if (tags.length > 0) {
      meta.tags = Array.from(new Set(tags));
    }
  }

  const bindings = normalizeFlowBindings(value.bindings, explicitDomain);
  if (bindings.length > 0) {
    meta.bindings = bindings;
    if (!meta.domain) {
      const domainBinding = bindings.find((binding) => binding.kind === "domain");
      if (domainBinding) {
        meta.domain = domainBinding.value;
      }
    }
  }

  if (value.tool !== undefined && value.tool !== null) {
    if (typeof value.tool !== "object" || Array.isArray(value.tool)) {
      throw new Error("flow.meta.tool must be an object");
    }
    const tool = normalizeFlowToolMetadata(value.tool as JsonObject, flowName);
    if (tool) {
      meta.tool = tool;
    }
  }

  if (value.exposedOutputs !== undefined && value.exposedOutputs !== null) {
    meta.exposedOutputs = normalizeFlowExposedOutputs(value.exposedOutputs, nodeIdSet);
  }

  if (value.recording !== undefined && value.recording !== null) {
    if (typeof value.recording !== "object" || Array.isArray(value.recording)) {
      throw new Error("flow.meta.recording must be an object");
    }
    const recording = normalizeFlowRecording(value.recording as JsonObject, nodeIdSet);
    if (recording) {
      meta.recording = recording;
    }
  }

  if (value.stopBarrier !== undefined && value.stopBarrier !== null) {
    if (typeof value.stopBarrier !== "object" || Array.isArray(value.stopBarrier)) {
      throw new Error("flow.meta.stopBarrier must be an object");
    }
    meta.stopBarrier = normalizeFlowStopBarrier(value.stopBarrier as JsonObject);
  }

  if (value.quality !== undefined && value.quality !== null) {
    if (!isRecord(value.quality)) {
      throw new Error("flow.meta.quality must be an object");
    }
    const quality = normalizeFlowQualityMeta(value.quality);
    if (quality) {
      meta.quality = quality;
    }
  }

  if (value.runtime !== undefined && value.runtime !== null) {
    if (!isRecord(value.runtime)) {
      throw new Error("flow.meta.runtime must be an object");
    }
    const runtime = normalizeFlowRuntimeMeta(value.runtime);
    if (runtime) {
      meta.runtime = runtime;
    }
  }

  if (value.repairs !== undefined && value.repairs !== null) {
    if (!isRecord(value.repairs)) {
      throw new Error("flow.meta.repairs must be an object");
    }
    const repairs = normalizeFlowRepairsMeta(value.repairs);
    if (repairs) {
      meta.repairs = repairs;
    }
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}

const QUALITY_STATUS_VALUES = ["draft", "stable", "verified", "stale", "paused", "blocked"] as const;
const QUALITY_LEVEL_VALUES = ["unverified", "stable", "verified"] as const;
const QUALITY_RISK_VALUES = ["safe", "idempotent", "dangerous", "unknown"] as const;
const QUALITY_CAPABILITY_VALUES = ["full", "partial", "none", "unknown"] as const;
const QUALITY_ORACLE_VALUES = ["none", "assertion", "declaredOutput", "expectedOutcome"] as const;
const QUALITY_ORACLE_STRENGTH_VALUES = ["weak", "normal", "strong"] as const;
const REVALIDATION_POLICY_VALUES = ["manual", "onFailure", "scheduled", "siteChange"] as const;

function normalizeFlowQualityExcludedRuns(value: unknown): FlowQualityExcludedRuns | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const count = optionalNumber(value.count);
  const reasons = normalizeStringArray(value.reasons, 10);
  if (count === undefined && !reasons) {
    return undefined;
  }
  return {
    count: count !== undefined ? Math.max(0, Math.floor(count)) : 0,
    ...(reasons ? { reasons } : { reasons: [] }),
  };
}

function normalizeFlowQualityValidationContext(
  value: unknown,
): FlowQualityValidationContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const context: FlowQualityValidationContext = {};
  const stringFields = [
    "argsHash",
    "argsHashAlgorithm",
    "startUrl",
    "tabTarget",
    "executionMode",
    "testEnvironment",
    "siteFingerprint",
    "runGroupId",
    "locale",
    "timezone",
    "userAgentHash",
    "browserVersion",
    "extensionVersion",
    "mcpServerVersion",
    "protocolVersion",
    "capabilityVersion",
    "profileHash",
    "accountLabel",
    "permissionSetHash",
    "cookieStateHash",
  ] as const;
  for (const field of stringFields) {
    const text = trimmedString(value[field]);
    if (text) {
      (context as Record<string, unknown>)[field] = text;
    }
  }
  if (context.argsHashAlgorithm !== "hmac-sha256") {
    delete context.argsHashAlgorithm;
  }
  const tabOwnership = enumValue(value.tabOwnership, ["owned", "current"] as const);
  if (tabOwnership) {
    context.tabOwnership = tabOwnership;
  }
  const background = optionalBoolean(value.background);
  if (background !== undefined) {
    context.background = background;
  }
  if (isRecord(value.viewport)) {
    const width = optionalNumber(value.viewport.width);
    const height = optionalNumber(value.viewport.height);
    if (width !== undefined && height !== undefined) {
      const deviceScaleFactor = optionalNumber(value.viewport.deviceScaleFactor);
      context.viewport = {
        width: Math.max(0, Math.floor(width)),
        height: Math.max(0, Math.floor(height)),
        ...(deviceScaleFactor !== undefined ? { deviceScaleFactor } : {}),
      };
    }
  }
  return Object.keys(context).length > 0 ? context : undefined;
}

function normalizeFlowQualityVerification(value: unknown): FlowQualityMeta["verification"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const oracle = enumValue<FlowQualityOracle>(value.oracle, QUALITY_ORACLE_VALUES);
  const oracleStrength = enumValue<FlowQualityOracleStrength>(
    value.oracleStrength,
    QUALITY_ORACLE_STRENGTH_VALUES,
  );
  const required = optionalBoolean(value.required);
  const missingReason = trimmedString(value.missingReason);
  const verifiedAt = optionalIsoString(value.verifiedAt);
  const verification = {
    ...(oracle ? { oracle } : {}),
    ...(oracleStrength ? { oracleStrength } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(missingReason ? { missingReason } : {}),
    ...(verifiedAt ? { verifiedAt } : {}),
  };
  return Object.keys(verification).length > 0 ? verification : undefined;
}

function normalizeFlowQualityCapabilities(value: unknown): FlowQualityCapabilities | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const capabilities: FlowQualityCapabilities = {};
  const fields = [
    "replayValidation",
    "domSnapshot",
    "accessibilitySnapshot",
    "navigationEvents",
    "networkEvents",
    "mutationEvents",
    "selectorResolution",
    "screenshots",
    "crossOriginFrames",
    "closedShadowDom",
    "downloads",
    "mfa",
    "captcha",
  ] as const;
  for (const field of fields) {
    const status = enumValue<FlowQualityCapabilityStatus>(
      value[field],
      QUALITY_CAPABILITY_VALUES,
    );
    if (status) {
      capabilities[field] = status;
    }
  }
  const unsupportedReasons = normalizeStringArray(value.unsupportedReasons, 20);
  if (unsupportedReasons) {
    capabilities.unsupportedReasons = unsupportedReasons;
  }
  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}

function normalizeFlowQualityValidationRecord(
  value: unknown,
): FlowQualityValidationRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = trimmedString(value.id);
  const tool = trimmedString(value.tool);
  const revision = trimmedString(value.revision);
  const completedAt = optionalIsoString(value.completedAt);
  if (!id || !tool || !revision || !completedAt) {
    return undefined;
  }
  const phase = enumValue(value.phase, ["baseline", "postRepair"] as const);
  const risk = enumValue<FlowQualityRisk>(value.risk, QUALITY_RISK_VALUES);
  const countedRuns = optionalNumber(value.countedRuns);
  const passedRuns = optionalNumber(value.passedRuns);
  const failedRuns = optionalNumber(value.failedRuns);
  const passRate = optionalNumber(value.passRate);
  const stabilityScore = optionalNumber(value.stabilityScore);
  const segmentOnly = optionalBoolean(value.segmentOnly);
  return {
    id,
    tool,
    revision,
    completedAt,
    ...(trimmedString(value.runGroupId) ? { runGroupId: trimmedString(value.runGroupId) } : {}),
    ...(phase ? { phase } : {}),
    passRate: passRate !== undefined ? passRate : 0,
    stabilityScore: stabilityScore !== undefined ? stabilityScore : 0,
    countedRuns: countedRuns !== undefined ? Math.max(0, Math.floor(countedRuns)) : 0,
    passedRuns: passedRuns !== undefined ? Math.max(0, Math.floor(passedRuns)) : 0,
    failedRuns: failedRuns !== undefined ? Math.max(0, Math.floor(failedRuns)) : 0,
    ...(normalizeFlowQualityExcludedRuns(value.excludedRuns)
      ? { excludedRuns: normalizeFlowQualityExcludedRuns(value.excludedRuns) }
      : {}),
    ...(normalizeStringArray(value.runIds, 50) ? { runIds: normalizeStringArray(value.runIds, 50) } : {}),
    ...(normalizeFlowQualityValidationContext(value.validationContext)
      ? { validationContext: normalizeFlowQualityValidationContext(value.validationContext) }
      : {}),
    ...(risk ? { risk } : {}),
    ...(segmentOnly !== undefined ? { segmentOnly } : {}),
  };
}

function normalizeFlowQualityMeta(value: JsonObject): FlowQualityMeta | undefined {
  const quality: FlowQualityMeta = {};
  const isoFields = [
    "lastAnalyzedAt",
    "lastStabilizedAt",
    "lastValidatedAt",
    "freshnessExpiresAt",
  ] as const;
  for (const field of isoFields) {
    const text = optionalIsoString(value[field]);
    if (text) {
      quality[field] = text;
    }
  }
  const revision = trimmedString(value.revision);
  if (revision) quality.revision = revision;
  const status = enumValue<FlowQualityStatus>(value.status, QUALITY_STATUS_VALUES);
  if (status) quality.status = status;
  const level = enumValue(value.level, QUALITY_LEVEL_VALUES);
  if (level) quality.level = level;
  const risk = enumValue<FlowQualityRisk>(value.risk, QUALITY_RISK_VALUES);
  if (risk) quality.risk = risk;

  const numberFields = [
    "stabilityScore",
    "passRate",
    "validationRuns",
    "countedValidationRuns",
    "passedRuns",
    "failedRuns",
    "minValidationRuns",
    "consecutiveFailureCount",
  ] as const;
  for (const field of numberFields) {
    const number = optionalNumber(value[field]);
    if (number !== undefined) {
      (quality as Record<string, unknown>)[field] =
        field === "stabilityScore" || field === "passRate"
          ? Math.max(0, Math.min(1, number))
          : Math.max(0, Math.floor(number));
    }
  }

  const lastFailureNodeId = trimmedString(value.lastFailureNodeId);
  if (lastFailureNodeId) quality.lastFailureNodeId = lastFailureNodeId as NodeId;
  const lastFailureCode = trimmedString(value.lastFailureCode);
  if (lastFailureCode) quality.lastFailureCode = lastFailureCode;
  const staleReason = trimmedString(value.staleReason);
  if (staleReason) quality.staleReason = staleReason;

  const excludedRuns = normalizeFlowQualityExcludedRuns(value.excludedRuns);
  if (excludedRuns) quality.excludedRuns = excludedRuns;
  const validationContext = normalizeFlowQualityValidationContext(value.validationContext);
  if (validationContext) quality.validationContext = validationContext;
  const verification = normalizeFlowQualityVerification(value.verification);
  if (verification) quality.verification = verification;
  const capabilities = normalizeFlowQualityCapabilities(value.capabilities);
  if (capabilities) quality.capabilities = capabilities;

  if (isRecord(value.revalidation)) {
    const policy = enumValue(value.revalidation.policy, REVALIDATION_POLICY_VALUES);
    const nextRevalidateAt = optionalIsoString(value.revalidation.nextRevalidateAt);
    const lastRevalidateReason = trimmedString(value.revalidation.lastRevalidateReason);
    const autoDowngrade = optionalBoolean(value.revalidation.autoDowngrade);
    quality.revalidation = {
      ...(policy ? { policy } : {}),
      ...(nextRevalidateAt ? { nextRevalidateAt } : {}),
      ...(lastRevalidateReason ? { lastRevalidateReason } : {}),
      ...(autoDowngrade !== undefined ? { autoDowngrade } : {}),
    };
  }

  if (isRecord(value.slo)) {
    const targetPassRate = optionalNumber(value.slo.targetPassRate);
    const minValidationRuns = optionalNumber(value.slo.minValidationRuns);
    const maxP95RunMs = optionalNumber(value.slo.maxP95RunMs);
    const maxFalseRepairRate = optionalNumber(value.slo.maxFalseRepairRate);
    quality.slo = {
      ...(targetPassRate !== undefined ? { targetPassRate } : {}),
      ...(minValidationRuns !== undefined ? { minValidationRuns: Math.floor(minValidationRuns) } : {}),
      ...(maxP95RunMs !== undefined ? { maxP95RunMs: Math.floor(maxP95RunMs) } : {}),
      ...(maxFalseRepairRate !== undefined ? { maxFalseRepairRate } : {}),
    };
  }

  const artifactRunIds = normalizeStringArray(value.artifactRunIds, 50);
  if (artifactRunIds) quality.artifactRunIds = artifactRunIds;
  const warnings = normalizeStringArray(value.warnings, 30);
  if (warnings) quality.warnings = warnings;
  if (Array.isArray(value.validationRecords)) {
    const records = value.validationRecords
      .map((entry) => normalizeFlowQualityValidationRecord(entry))
      .filter((entry): entry is FlowQualityValidationRecord => Boolean(entry))
      .slice(-20);
    if (records.length > 0) {
      quality.validationRecords = records;
    }
  }

  return Object.keys(quality).length > 0 ? quality : undefined;
}

function normalizeFlowRuntimeMeta(value: JsonObject): FlowRuntimeMeta | undefined {
  const runtime: FlowRuntimeMeta = {};
  const stringFields = [
    "protocolVersion",
    "capabilityVersion",
    "dslVersion",
    "nodeSemanticsVersion",
    "minExtensionVersion",
    "minMcpServerVersion",
  ] as const;
  for (const field of stringFields) {
    const text = trimmedString(value[field]);
    if (text) {
      runtime[field] = text;
    }
  }
  const clientCapabilities = normalizeStringArray(value.clientCapabilities, 30);
  if (clientCapabilities) runtime.clientCapabilities = clientCapabilities;
  const featureFlags = normalizeStringArray(value.featureFlags, 30);
  if (featureFlags) runtime.featureFlags = featureFlags;
  return Object.keys(runtime).length > 0 ? runtime : undefined;
}

function normalizeRepairHistoryEntry(value: unknown): FlowRepairHistoryEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const appliedAt = optionalIsoString(value.appliedAt);
  if (!appliedAt) {
    return undefined;
  }
  const entry: FlowRepairHistoryEntry = { appliedAt };
  const stringFields = [
    "repairRevision",
    "baseRevision",
    "resultingRevision",
    "patchSummary",
    "rollbackRevision",
  ] as const;
  for (const field of stringFields) {
    const text = trimmedString(value[field]);
    if (text) {
      entry[field] = text;
    }
  }
  const beforeQuality = optionalNumber(value.beforeQuality);
  if (beforeQuality !== undefined) entry.beforeQuality = beforeQuality;
  const afterQuality = optionalNumber(value.afterQuality);
  if (afterQuality !== undefined) entry.afterQuality = afterQuality;
  if (Array.isArray(value.changes)) {
    const changes = value.changes
      .filter(isRecord)
      .map((change) => ({
        ...(trimmedString(change.code) ? { code: trimmedString(change.code) } : {}),
        ...(trimmedString(change.message) ? { message: trimmedString(change.message) } : {}),
        ...(trimmedString(change.nodeId) ? { nodeId: trimmedString(change.nodeId) } : {}),
      }))
      .filter((change) => Object.keys(change).length > 0)
      .slice(0, 50);
    if (changes.length > 0) entry.changes = changes;
  }
  if (isRecord(value.provenance)) {
    entry.provenance = {
      ...(trimmedString(value.provenance.source) ? { source: trimmedString(value.provenance.source) } : {}),
      ...(optionalBoolean(value.provenance.pageContentUsed) !== undefined
        ? { pageContentUsed: optionalBoolean(value.provenance.pageContentUsed) }
        : {}),
    };
  }
  if (isRecord(value.rollback)) {
    entry.rollback = {
      ...(trimmedString(value.rollback.beforeRevision)
        ? { beforeRevision: trimmedString(value.rollback.beforeRevision) }
        : {}),
      ...(optionalBoolean(value.rollback.available) !== undefined
        ? { available: optionalBoolean(value.rollback.available) }
        : {}),
      ...(trimmedString(value.rollback.reason) ? { reason: trimmedString(value.rollback.reason) } : {}),
    };
  }
  return entry;
}

function normalizeFlowRepairsMeta(value: JsonObject): FlowRepairsMeta | undefined {
  const repairs: FlowRepairsMeta = {};
  const currentRepairRevision = trimmedString(value.currentRepairRevision);
  if (currentRepairRevision) repairs.currentRepairRevision = currentRepairRevision;
  if (Array.isArray(value.history)) {
    const history = value.history
      .map((entry) => normalizeRepairHistoryEntry(entry))
      .filter((entry): entry is FlowRepairHistoryEntry => Boolean(entry))
      .slice(-20);
    if (history.length > 0) {
      repairs.history = history;
    }
  }
  return Object.keys(repairs).length > 0 ? repairs : undefined;
}

function normalizeFlowBindings(
  value: unknown,
  explicitDomain?: string,
): FlowBinding[] {
  const bindings: FlowBinding[] = [];
  const seen = new Set<string>();

  const pushBinding = (
    kind: FlowBinding["kind"],
    rawValue: string,
    source: string,
  ): void => {
    const bindingValue = rawValue.trim();
    if (!bindingValue) {
      throw new Error(`${source}.value must be a non-empty string`);
    }
    const key = `${kind}:${bindingValue}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    bindings.push({ kind, value: bindingValue });
  };

  if (explicitDomain) {
    pushBinding("domain", explicitDomain, "flow.meta.domain");
  }

  if (value === undefined || value === null) {
    return bindings;
  }
  if (!Array.isArray(value)) {
    throw new Error("flow.meta.bindings must be an array");
  }

  value.forEach((binding, index) => {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      throw new Error(`flow.meta.bindings[${index}] must be an object`);
    }
    const record = binding as JsonObject;
    const kindValue = record.kind ?? record.type;
    if (kindValue !== "domain" && kindValue !== "path" && kindValue !== "url") {
      throw new Error(
        `flow.meta.bindings[${index}].kind must be one of: domain, path, url`,
      );
    }
    if (typeof record.value !== "string") {
      throw new Error(`flow.meta.bindings[${index}].value must be a string`);
    }
    pushBinding(kindValue, record.value, `flow.meta.bindings[${index}]`);
  });

  return bindings;
}

function normalizeFlowExposedOutputs(
  value: unknown,
  nodeIdSet: Set<string>,
): FlowExposedOutput[] | undefined {
  if (!Array.isArray(value)) {
    throw new Error("flow.meta.exposedOutputs must be an array");
  }

  const outputs: FlowExposedOutput[] = [];
  const aliases = new Set<string>();
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`flow.meta.exposedOutputs[${index}] must be an object`);
    }
    const record = entry as JsonObject;
    if (typeof record.nodeId !== "string" || !record.nodeId.trim()) {
      throw new Error(`flow.meta.exposedOutputs[${index}].nodeId is required`);
    }
    const nodeId = record.nodeId.trim();
    if (!nodeIdSet.has(nodeId)) {
      throw new Error(
        `flow.meta.exposedOutputs[${index}].nodeId "${nodeId}" does not exist`,
      );
    }
    if (typeof record.as !== "string" || !record.as.trim()) {
      throw new Error(`flow.meta.exposedOutputs[${index}].as is required`);
    }
    const alias = record.as.trim();
    if (aliases.has(alias)) {
      throw new Error(`Duplicate exposed output alias: "${alias}"`);
    }
    aliases.add(alias);
    outputs.push({ nodeId: nodeId as NodeId, as: alias });
  });

  return outputs.length > 0 ? outputs : undefined;
}

function normalizeFlowRecording(
  value: JsonObject,
  nodeIdSet: Set<string>,
): FlowRecordingMeta | undefined {
  const recording: FlowRecordingMeta = {};

  const stringFields = [
    "originUrl",
    "originTitle",
    "browser",
    "userAgent",
    "startedAt",
    "stoppedAt",
  ] as const;
  for (const field of stringFields) {
    const raw = value[field];
    if (raw === undefined || raw === null) {
      continue;
    }
    if (typeof raw !== "string") {
      throw new Error(`flow.meta.recording.${field} must be a string`);
    }
    const trimmed = raw.trim();
    if (trimmed) {
      recording[field] = trimmed as never;
    }
  }

  const numberFields = ["originTabId", "durationMs", "stepCount"] as const;
  for (const field of numberFields) {
    const raw = value[field];
    if (raw === undefined || raw === null) {
      continue;
    }
    if (!isFiniteNumber(raw)) {
      throw new Error(`flow.meta.recording.${field} must be a finite number`);
    }
    recording[field] = raw as never;
  }

  if (value.parameterSuggestions !== undefined && value.parameterSuggestions !== null) {
    if (!Array.isArray(value.parameterSuggestions)) {
      throw new Error("flow.meta.recording.parameterSuggestions must be an array");
    }
    recording.parameterSuggestions = value.parameterSuggestions.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(
          `flow.meta.recording.parameterSuggestions[${index}] must be an object`,
        );
      }
      const record = entry as JsonObject;
      if (typeof record.nodeId !== "string" || !record.nodeId.trim()) {
        throw new Error(
          `flow.meta.recording.parameterSuggestions[${index}].nodeId is required`,
        );
      }
      const nodeId = record.nodeId.trim();
      if (!nodeIdSet.has(nodeId)) {
        throw new Error(
          `flow.meta.recording.parameterSuggestions[${index}].nodeId "${nodeId}" does not exist`,
        );
      }
      if (record.kind !== "fill" && record.kind !== "navigate") {
        throw new Error(
          `flow.meta.recording.parameterSuggestions[${index}].kind must be "fill" or "navigate"`,
        );
      }
      if (typeof record.suggestedKey !== "string" || !record.suggestedKey.trim()) {
        throw new Error(
          `flow.meta.recording.parameterSuggestions[${index}].suggestedKey is required`,
        );
      }
      if (typeof record.currentValue !== "string") {
        throw new Error(
          `flow.meta.recording.parameterSuggestions[${index}].currentValue must be a string`,
        );
      }
      return {
        nodeId: nodeId as NodeId,
        kind: record.kind,
        suggestedKey: record.suggestedKey.trim(),
        currentValue: record.currentValue,
      };
    });
  }

  return Object.keys(recording).length > 0 ? recording : undefined;
}

function normalizeFlowStopBarrier(value: JsonObject): FlowStopBarrierMeta {
  if (typeof value.ok !== "boolean") {
    throw new Error("flow.meta.stopBarrier.ok must be a boolean");
  }

  const stopBarrier: FlowStopBarrierMeta = {
    ok: value.ok,
  };

  if (value.sessionId !== undefined && value.sessionId !== null) {
    if (typeof value.sessionId !== "string") {
      throw new Error("flow.meta.stopBarrier.sessionId must be a string");
    }
    const sessionId = value.sessionId.trim();
    if (sessionId) {
      stopBarrier.sessionId = sessionId;
    }
  }

  if (value.stoppedAt !== undefined && value.stoppedAt !== null) {
    if (typeof value.stoppedAt !== "string") {
      throw new Error("flow.meta.stopBarrier.stoppedAt must be a string");
    }
    const stoppedAt = value.stoppedAt.trim();
    if (stoppedAt) {
      stopBarrier.stoppedAt = stoppedAt as ISODateTimeString;
    }
  }

  if (value.failed !== undefined && value.failed !== null) {
    if (!Array.isArray(value.failed)) {
      throw new Error("flow.meta.stopBarrier.failed must be an array");
    }
    stopBarrier.failed = value.failed.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`flow.meta.stopBarrier.failed[${index}] must be an object`);
      }
      const record = entry as JsonObject;
      if (!isFiniteNumber(record.tabId)) {
        throw new Error(
          `flow.meta.stopBarrier.failed[${index}].tabId must be a finite number`,
        );
      }
      if (
        record.skipped !== undefined &&
        record.skipped !== null &&
        typeof record.skipped !== "boolean"
      ) {
        throw new Error(
          `flow.meta.stopBarrier.failed[${index}].skipped must be a boolean`,
        );
      }
      if (
        record.topTimedOut !== undefined &&
        record.topTimedOut !== null &&
        typeof record.topTimedOut !== "boolean"
      ) {
        throw new Error(
          `flow.meta.stopBarrier.failed[${index}].topTimedOut must be a boolean`,
        );
      }
      if (
        record.reason !== undefined &&
        record.reason !== null &&
        typeof record.reason !== "string"
      ) {
        throw new Error(`flow.meta.stopBarrier.failed[${index}].reason must be a string`);
      }
      if (
        record.topError !== undefined &&
        record.topError !== null &&
        typeof record.topError !== "string"
      ) {
        throw new Error(
          `flow.meta.stopBarrier.failed[${index}].topError must be a string`,
        );
      }
      if (
        record.subframesFailed !== undefined &&
        record.subframesFailed !== null &&
        !isFiniteNumber(record.subframesFailed)
      ) {
        throw new Error(
          `flow.meta.stopBarrier.failed[${index}].subframesFailed must be a finite number`,
        );
      }

      return {
        tabId: record.tabId,
        skipped: record.skipped as boolean | undefined,
        reason: record.reason as string | undefined,
        topTimedOut: record.topTimedOut as boolean | undefined,
        topError: record.topError as string | undefined,
        subframesFailed: record.subframesFailed as number | undefined,
      };
    });
  }

  return stopBarrier;
}
