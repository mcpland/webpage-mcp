import { findJsonResourceLimitViolation } from "./json-limits";

export const QUEUE_RESOURCE_LIMITS = Object.freeze({
  maxStoredItems: 256,
  maxQueuedItems: 200,
  maxQueuedItemsPerFlow: 25,
  maxItemUtf8Bytes: 64 * 1024,
  maxStringUtf8Bytes: 32 * 1024,
  maxJsonDepth: 32,
  maxJsonValues: 10_000,
  maxListUtf8Bytes: 17 * 1024 * 1024,
  maxIdUtf8Bytes: 512,
  maxOwnerIdUtf8Bytes: 512,
  maxLeaseTtlMs: 5 * 60 * 1_000,
  maxPriorityMagnitude: Number.MAX_SAFE_INTEGER,
  maxAttempts: 10,
  maxClaimConstraints: 256,
});

export function findQueueItemResourceLimitViolation(
  item: unknown,
): string | null {
  return findJsonResourceLimitViolation(
    item,
    {
      maxUtf8Bytes: QUEUE_RESOURCE_LIMITS.maxItemUtf8Bytes,
      maxStringUtf8Bytes: QUEUE_RESOURCE_LIMITS.maxStringUtf8Bytes,
      maxDepth: QUEUE_RESOURCE_LIMITS.maxJsonDepth,
      maxValues: QUEUE_RESOURCE_LIMITS.maxJsonValues,
    },
    "queue item",
  );
}
