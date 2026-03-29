import type { FlowId } from "../domain/ids";
import type { FlowMeta, FlowToolMetadata, FlowV3 } from "../domain/flow";
import { FLOW_SCHEMA_VERSION } from "../domain/flow";

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
  meta?: FlowV3["meta"];
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
    .filter((variable) => variable?.sensitive !== true)
    .map((variable) => ({
      name: variable.name,
      ...(variable.label ? { label: variable.label } : {}),
      ...(variable.description ? { description: variable.description } : {}),
      ...(typeof variable.required === "boolean"
        ? { required: variable.required }
        : {}),
      ...(variable.default !== undefined ? { default: variable.default } : {}),
      ...(variable.scope ? { scope: variable.scope } : {}),
    }));

  return sanitized.length > 0 ? sanitized : undefined;
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
        ...(flow.meta ? { meta: flow.meta } : {}),
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
