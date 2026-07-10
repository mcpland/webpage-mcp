import type { FlowV3 } from "./flow";
import { findJsonResourceLimitViolation } from "./json-limits";

export const FLOW_RESOURCE_LIMITS = Object.freeze({
  maxStoredFlows: 128,
  maxNodes: 5_000,
  maxEdges: 20_000,
  maxVariables: 256,
  maxFlowUtf8Bytes: 16 * 1024 * 1024,
  maxNodeConfigUtf8Bytes: 1024 * 1024,
  maxStringUtf8Bytes: 256 * 1024,
  maxJsonDepth: 64,
  maxJsonValues: 200_000,
});

export interface FlowListOptions {
  offset?: number;
  limit?: number;
}

export function normalizeFlowListOptions(options: FlowListOptions = {}): {
  offset: number;
  limit: number;
} {
  const offset =
    Number.isSafeInteger(options.offset) && (options.offset ?? -1) >= 0
      ? Math.min(options.offset!, FLOW_RESOURCE_LIMITS.maxStoredFlows)
      : 0;
  const limit =
    Number.isSafeInteger(options.limit) && (options.limit ?? 0) > 0
      ? Math.min(options.limit!, FLOW_RESOURCE_LIMITS.maxStoredFlows)
      : FLOW_RESOURCE_LIMITS.maxStoredFlows;
  return { offset, limit };
}

export function findFlowResourceLimitViolation(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "flow must be an object";
  }

  const flow = value as Partial<FlowV3>;
  if (
    Array.isArray(flow.nodes) &&
    flow.nodes.length > FLOW_RESOURCE_LIMITS.maxNodes
  ) {
    return `flow.nodes exceeds the ${FLOW_RESOURCE_LIMITS.maxNodes}-node limit`;
  }
  if (
    Array.isArray(flow.edges) &&
    flow.edges.length > FLOW_RESOURCE_LIMITS.maxEdges
  ) {
    return `flow.edges exceeds the ${FLOW_RESOURCE_LIMITS.maxEdges}-edge limit`;
  }
  if (
    Array.isArray(flow.variables) &&
    flow.variables.length > FLOW_RESOURCE_LIMITS.maxVariables
  ) {
    return `flow.variables exceeds the ${FLOW_RESOURCE_LIMITS.maxVariables}-variable limit`;
  }

  if (Array.isArray(flow.nodes)) {
    for (let index = 0; index < flow.nodes.length; index += 1) {
      const node = flow.nodes[index];
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const violation = findJsonResourceLimitViolation(
        (node as { config?: unknown }).config ?? {},
        {
          maxUtf8Bytes: FLOW_RESOURCE_LIMITS.maxNodeConfigUtf8Bytes,
          maxStringUtf8Bytes: FLOW_RESOURCE_LIMITS.maxStringUtf8Bytes,
          maxDepth: FLOW_RESOURCE_LIMITS.maxJsonDepth,
          maxValues: FLOW_RESOURCE_LIMITS.maxJsonValues,
        },
        `flow.nodes[${index}].config`,
      );
      if (violation) return violation;
    }
  }

  return findJsonResourceLimitViolation(
    value,
    {
      maxUtf8Bytes: FLOW_RESOURCE_LIMITS.maxFlowUtf8Bytes,
      maxStringUtf8Bytes: FLOW_RESOURCE_LIMITS.maxStringUtf8Bytes,
      maxDepth: FLOW_RESOURCE_LIMITS.maxJsonDepth,
      maxValues: FLOW_RESOURCE_LIMITS.maxJsonValues,
    },
    "flow",
  );
}
