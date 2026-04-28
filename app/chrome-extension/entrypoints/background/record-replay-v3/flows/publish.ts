import type { FlowId } from "../domain/ids";
import type { FlowMeta, FlowToolMetadata, FlowV3 } from "../domain/flow";
import { FLOW_SCHEMA_VERSION } from "../domain/flow";
import { isSensitiveVariableLike } from "./sensitive";
import {
  createEmptyWorkflowSideEffectSummary,
  isKnownWorkflowSideEffectKind,
  normalizeWorkflowNodeSideEffectProfile,
  type WorkflowSideEffectProfile,
  type WorkflowSideEffectSummary,
} from "webpage-mcp-shared";

export interface PublishedFlowInfoV3 {
  id: FlowId;
  slug: string;
  version: typeof FLOW_SCHEMA_VERSION;
  name: string;
  description?: string;
  category?: string;
}

export interface PublishedFlowDetailsV3 extends PublishedFlowInfoV3 {
  variables?: FlowV3["variables"];
  parameters: WorkflowParameterSchema;
  exampleArgs: Record<string, unknown>;
  backgroundSupport: WorkflowBackgroundSupport;
  sideEffects: WorkflowSideEffectDescriptor;
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
  parameters: WorkflowParameterSchema;
  exampleArgs: Record<string, unknown>;
  backgroundSupport: WorkflowBackgroundSupport;
  sideEffects: WorkflowSideEffectDescriptor;
  outputs?: NonNullable<FlowV3["meta"]>["exposedOutputs"];
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
    parameters: buildWorkflowParameterSchema(flow),
    exampleArgs: buildWorkflowExampleArgs(flow),
    backgroundSupport: buildWorkflowBackgroundSupport(flow),
    sideEffects: buildWorkflowSideEffectDescriptor(flow),
    ...(Array.isArray(flow.meta?.exposedOutputs) && flow.meta.exposedOutputs.length > 0
      ? { outputs: flow.meta.exposedOutputs.map((output) => ({ ...output })) }
      : {}),
  };
}

export function listPublishedFlowDetails(
  flows: FlowV3[],
): PublishedFlowDetailsV3[] {
  return flows
    .map((flow) => {
      const info = getPublishedFlowInfo(flow);
      const publishedVariables = sanitizePublishedVariables(flow.variables);
      if (!info) {
        return null;
      }
      return {
        ...info,
        ...(publishedVariables ? { variables: publishedVariables } : {}),
        ...buildWorkflowToolDescriptor(flow),
      };
    })
    .filter((info): info is PublishedFlowDetailsV3 => Boolean(info))
    .sort((a, b) => a.slug.localeCompare(b.slug));
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
