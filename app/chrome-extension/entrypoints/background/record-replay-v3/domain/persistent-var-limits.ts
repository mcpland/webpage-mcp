import { findJsonResourceLimitViolation } from "./json-limits";

export const PERSISTENT_VAR_RESOURCE_LIMITS = Object.freeze({
  maxEntries: 128,
  maxKeyUtf8Bytes: 512,
  maxValueUtf8Bytes: 32 * 1024,
  maxStringUtf8Bytes: 16 * 1024,
  maxValueDepth: 32,
  maxValueCount: 10_000,
  maxListUtf8Bytes: 4 * 1024 * 1024,
});

export function findPersistentVarKeyViolation(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("$")) {
    return "persistent variable key must be a string starting with $";
  }
  return findJsonResourceLimitViolation(
    value,
    {
      maxUtf8Bytes: PERSISTENT_VAR_RESOURCE_LIMITS.maxKeyUtf8Bytes + 2,
      maxStringUtf8Bytes: PERSISTENT_VAR_RESOURCE_LIMITS.maxKeyUtf8Bytes,
      maxDepth: 1,
      maxValues: 1,
    },
    "persistent variable key",
  );
}

export function findPersistentVarValueViolation(value: unknown): string | null {
  return findJsonResourceLimitViolation(
    value,
    {
      maxUtf8Bytes: PERSISTENT_VAR_RESOURCE_LIMITS.maxValueUtf8Bytes,
      maxStringUtf8Bytes: PERSISTENT_VAR_RESOURCE_LIMITS.maxStringUtf8Bytes,
      maxDepth: PERSISTENT_VAR_RESOURCE_LIMITS.maxValueDepth,
      maxValues: PERSISTENT_VAR_RESOURCE_LIMITS.maxValueCount,
    },
    "persistent variable value",
  );
}
