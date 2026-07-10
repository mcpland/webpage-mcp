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
  maxRunTimeoutMs: 24 * 60 * 60 * 1000,
  maxNodeTimeoutMs: 60 * 60 * 1000,
  maxRetries: 10,
  maxRetryIntervalMs: 10 * 60 * 1000,
  maxRetryErrorCodes: 64,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteIntegerViolation(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): string | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? null
    : `${path} must be an integer between ${minimum} and ${maximum}`;
}

function findRetryPolicyViolation(value: unknown, path: string): string | null {
  if (!isRecord(value)) return `${path} must be an object`;
  if (value.retries !== undefined) {
    const violation = finiteIntegerViolation(
      value.retries,
      `${path}.retries`,
      0,
      FLOW_RESOURCE_LIMITS.maxRetries,
    );
    if (violation) return violation;
  }
  for (const field of ["intervalMs", "maxIntervalMs"] as const) {
    if (value[field] === undefined) continue;
    const violation = finiteIntegerViolation(
      value[field],
      `${path}.${field}`,
      0,
      FLOW_RESOURCE_LIMITS.maxRetryIntervalMs,
    );
    if (violation) return violation;
  }
  if (
    Array.isArray(value.retryOn) &&
    value.retryOn.length > FLOW_RESOURCE_LIMITS.maxRetryErrorCodes
  ) {
    return `${path}.retryOn exceeds the ${FLOW_RESOURCE_LIMITS.maxRetryErrorCodes}-item limit`;
  }
  return null;
}

function findOnErrorPolicyViolation(
  value: unknown,
  path: string,
): string | null {
  if (!isRecord(value)) return `${path} must be an object`;
  if (value.kind === "retry" && value.override !== undefined) {
    return findRetryPolicyViolation(value.override, `${path}.override`);
  }
  return null;
}

function findNodePolicyViolation(value: unknown, path: string): string | null {
  if (!isRecord(value)) return `${path} must be an object`;
  if (value.timeout !== undefined) {
    if (!isRecord(value.timeout)) return `${path}.timeout must be an object`;
    const violation = finiteIntegerViolation(
      value.timeout.ms,
      `${path}.timeout.ms`,
      1,
      FLOW_RESOURCE_LIMITS.maxNodeTimeoutMs,
    );
    if (violation) return violation;
  }
  if (value.retry !== undefined) {
    const violation = findRetryPolicyViolation(value.retry, `${path}.retry`);
    if (violation) return violation;
  }
  if (value.onError !== undefined) {
    const violation = findOnErrorPolicyViolation(
      value.onError,
      `${path}.onError`,
    );
    if (violation) return violation;
  }
  return null;
}

function findExecutionPolicyViolation(
  flow: Record<string, unknown>,
): string | null {
  if (flow.policy !== undefined) {
    if (!isRecord(flow.policy)) return "flow.policy must be an object";
    if (flow.policy.runTimeoutMs !== undefined) {
      const violation = finiteIntegerViolation(
        flow.policy.runTimeoutMs,
        "flow.policy.runTimeoutMs",
        1,
        FLOW_RESOURCE_LIMITS.maxRunTimeoutMs,
      );
      if (violation) return violation;
    }
    if (flow.policy.defaultNodePolicy !== undefined) {
      const violation = findNodePolicyViolation(
        flow.policy.defaultNodePolicy,
        "flow.policy.defaultNodePolicy",
      );
      if (violation) return violation;
    }
    if (flow.policy.unsupportedNodePolicy !== undefined) {
      const violation = findOnErrorPolicyViolation(
        flow.policy.unsupportedNodePolicy,
        "flow.policy.unsupportedNodePolicy",
      );
      if (violation) return violation;
    }
  }

  if (Array.isArray(flow.nodes)) {
    for (let index = 0; index < flow.nodes.length; index += 1) {
      const node = flow.nodes[index];
      if (!isRecord(node) || node.policy === undefined) continue;
      const violation = findNodePolicyViolation(
        node.policy,
        `flow.nodes[${index}].policy`,
      );
      if (violation) return violation;
    }
  }
  return null;
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

  const executionViolation = findExecutionPolicyViolation(
    value as Record<string, unknown>,
  );
  if (executionViolation) return executionViolation;
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
