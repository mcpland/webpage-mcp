import type { ISODateTimeString, JsonObject } from "../domain/json";
import type { NodeId } from "../domain/ids";
import type {
  FlowBinding,
  FlowExposedOutput,
  FlowMeta,
  FlowRecordingMeta,
  FlowStopBarrierMeta,
  FlowToolMetadata,
  FlowV3,
} from "../domain/flow";
import type { VariableDefinition } from "../domain/variables";
import { normalizeToolSlug } from "./publish";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
    if (!Array.isArray(value.variables)) {
      throw new Error("flow.variables must be an array");
    }
    const variables: VariableDefinition[] = [];
    const varNameSet = new Set<string>();
    for (let i = 0; i < value.variables.length; i++) {
      const variable = value.variables[i];
      if (!variable || typeof variable !== "object" || Array.isArray(variable)) {
        throw new Error(`flow.variables[${i}] must be an object`);
      }
      const varObj = variable as JsonObject;
      if (!varObj.name || typeof varObj.name !== "string" || !varObj.name.trim()) {
        throw new Error(`flow.variables[${i}].name is required`);
      }
      const varName = varObj.name.trim();
      if (varNameSet.has(varName)) {
        throw new Error(`Duplicate variable name: "${varName}"`);
      }
      varNameSet.add(varName);
      variables.push({
        ...varObj,
        name: varName,
      } as VariableDefinition);
    }
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

  return Object.keys(meta).length > 0 ? meta : undefined;
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
