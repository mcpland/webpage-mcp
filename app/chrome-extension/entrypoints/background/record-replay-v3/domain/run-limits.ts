import type { RunRecordV3, RunStatus } from "./events";
import { findJsonResourceLimitViolation } from "./json-limits";

export const RUN_RESOURCE_LIMITS = Object.freeze({
  maxStoredRuns: 1_000,
  maxRunsPerFlow: 250,
  maxRunUtf8Bytes: 256 * 1024,
  maxStringUtf8Bytes: 64 * 1024,
  maxJsonDepth: 32,
  maxJsonValues: 20_000,
  maxAttempts: 10,
  terminalTtlMs: 30 * 24 * 60 * 60 * 1000,
  maxPruneRunsPerWrite: 50,
  defaultListLimit: 25,
  maxListLimit: 100,
  maxListUtf8Bytes: 4 * 1024 * 1024,
});

export interface RunListOptions {
  offset?: number;
  limit?: number;
  flowId?: string;
  status?: RunStatus;
  /** Internal callers may request a smaller aggregate budget. */
  maxBytes?: number;
}

export interface RunRetentionPolicy {
  maxStoredRuns: number;
  maxRunsPerFlow: number;
  terminalTtlMs: number;
  maxPruneRunsPerWrite: number;
}

const RUN_STATUSES = new Set<RunStatus>([
  "queued",
  "running",
  "paused",
  "succeeded",
  "failed",
  "canceled",
  "stopped_at_boundary",
]);

export function findRunResourceLimitViolation(value: unknown): string | null {
  return findJsonResourceLimitViolation(
    value,
    {
      maxUtf8Bytes: RUN_RESOURCE_LIMITS.maxRunUtf8Bytes,
      maxStringUtf8Bytes: RUN_RESOURCE_LIMITS.maxStringUtf8Bytes,
      maxDepth: RUN_RESOURCE_LIMITS.maxJsonDepth,
      maxValues: RUN_RESOURCE_LIMITS.maxJsonValues,
    },
    "run",
  );
}

export function normalizeRunListOptions(
  options: RunListOptions = {},
): Required<Pick<RunListOptions, "offset" | "limit">> &
  Pick<RunListOptions, "flowId" | "status"> & { maxBytes: number } {
  const offset = options.offset ?? 0;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > RUN_RESOURCE_LIMITS.maxStoredRuns
  ) {
    throw new Error(
      `offset must be an integer between 0 and ${RUN_RESOURCE_LIMITS.maxStoredRuns}`,
    );
  }
  const limit = options.limit ?? RUN_RESOURCE_LIMITS.defaultListLimit;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > RUN_RESOURCE_LIMITS.maxListLimit
  ) {
    throw new Error(
      `limit must be an integer between 0 and ${RUN_RESOURCE_LIMITS.maxListLimit}`,
    );
  }
  if (
    options.flowId !== undefined &&
    (typeof options.flowId !== "string" || !options.flowId)
  ) {
    throw new Error("flowId must be a non-empty string");
  }
  if (options.status !== undefined && !RUN_STATUSES.has(options.status)) {
    throw new Error("status is invalid");
  }
  const maxBytes = options.maxBytes ?? RUN_RESOURCE_LIMITS.maxListUtf8Bytes;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > RUN_RESOURCE_LIMITS.maxListUtf8Bytes
  ) {
    throw new Error(
      `maxBytes must be an integer between 1 and ${RUN_RESOURCE_LIMITS.maxListUtf8Bytes}`,
    );
  }
  return {
    offset,
    limit,
    maxBytes,
    ...(options.flowId ? { flowId: options.flowId } : {}),
    ...(options.status ? { status: options.status } : {}),
  };
}

function boundedPositiveInteger(
  value: unknown,
  fallback: number,
  hardMax: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return fallback;
  return Math.min(Math.floor(value), hardMax);
}

export function resolveRunRetentionPolicy(
  overrides: Partial<RunRetentionPolicy> = {},
): RunRetentionPolicy {
  const maxStoredRuns = boundedPositiveInteger(
    overrides.maxStoredRuns,
    RUN_RESOURCE_LIMITS.maxStoredRuns,
    RUN_RESOURCE_LIMITS.maxStoredRuns,
  );
  return {
    maxStoredRuns,
    maxRunsPerFlow: Math.min(
      maxStoredRuns,
      boundedPositiveInteger(
        overrides.maxRunsPerFlow,
        RUN_RESOURCE_LIMITS.maxRunsPerFlow,
        RUN_RESOURCE_LIMITS.maxRunsPerFlow,
      ),
    ),
    terminalTtlMs: boundedPositiveInteger(
      overrides.terminalTtlMs,
      RUN_RESOURCE_LIMITS.terminalTtlMs,
      RUN_RESOURCE_LIMITS.terminalTtlMs,
    ),
    maxPruneRunsPerWrite: boundedPositiveInteger(
      overrides.maxPruneRunsPerWrite,
      RUN_RESOURCE_LIMITS.maxPruneRunsPerWrite,
      RUN_RESOURCE_LIMITS.maxPruneRunsPerWrite,
    ),
  };
}

export function runMatchesListOptions(
  run: RunRecordV3,
  options: Pick<RunListOptions, "flowId" | "status">,
): boolean {
  return (
    (!options.flowId || run.flowId === options.flowId) &&
    (!options.status || run.status === options.status)
  );
}
