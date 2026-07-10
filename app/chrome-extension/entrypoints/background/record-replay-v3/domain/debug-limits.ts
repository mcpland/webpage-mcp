import { findJsonResourceLimitViolation } from "./json-limits";

export const DEBUG_RESOURCE_LIMITS = Object.freeze({
  maxSessions: 64,
  maxBreakpointManagers: 64,
  maxBreakpointsPerRun: 256,
  maxVariableNameUtf8Bytes: 512,
  maxVariableValueUtf8Bytes: 64 * 1024,
  maxVariableValueDepth: 32,
  maxVariableValueCount: 10_000,
});

export function findDebugVariableValueViolation(value: unknown): string | null {
  return findJsonResourceLimitViolation(
    value,
    {
      maxUtf8Bytes: DEBUG_RESOURCE_LIMITS.maxVariableValueUtf8Bytes,
      maxStringUtf8Bytes: DEBUG_RESOURCE_LIMITS.maxVariableValueUtf8Bytes,
      maxDepth: DEBUG_RESOURCE_LIMITS.maxVariableValueDepth,
      maxValues: DEBUG_RESOURCE_LIMITS.maxVariableValueCount,
    },
    "debug variable value",
  );
}
