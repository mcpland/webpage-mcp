import { findJsonResourceLimitViolation } from "./json-limits";

export const EVENT_RESOURCE_LIMITS = Object.freeze({
  maxEventUtf8Bytes: 64 * 1024,
  maxStringUtf8Bytes: 32 * 1024,
  maxJsonDepth: 32,
  maxJsonValues: 10_000,
  defaultListLimit: 250,
  maxListLimit: 250,
  maxListUtf8Bytes: 4 * 1024 * 1024,
  maxPruneDeletesPerAppend: 512,
});

export interface EventListOptions {
  fromSeq?: number;
  limit?: number;
  /** Internal callers may request a smaller aggregate budget. */
  maxBytes?: number;
}

export function findEventResourceLimitViolation(value: unknown): string | null {
  return findJsonResourceLimitViolation(
    value,
    {
      maxUtf8Bytes: EVENT_RESOURCE_LIMITS.maxEventUtf8Bytes,
      maxStringUtf8Bytes: EVENT_RESOURCE_LIMITS.maxStringUtf8Bytes,
      maxDepth: EVENT_RESOURCE_LIMITS.maxJsonDepth,
      maxValues: EVENT_RESOURCE_LIMITS.maxJsonValues,
    },
    "event",
  );
}

export function normalizeEventListOptions(options: EventListOptions = {}): {
  fromSeq: number;
  limit: number;
  maxBytes: number;
} {
  const fromSeq = options.fromSeq ?? 0;
  if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
    throw new Error("fromSeq must be a non-negative safe integer");
  }

  const limit = options.limit ?? EVENT_RESOURCE_LIMITS.defaultListLimit;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > EVENT_RESOURCE_LIMITS.maxListLimit
  ) {
    throw new Error(
      `limit must be an integer between 0 and ${EVENT_RESOURCE_LIMITS.maxListLimit}`,
    );
  }
  const maxBytes = options.maxBytes ?? EVENT_RESOURCE_LIMITS.maxListUtf8Bytes;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > EVENT_RESOURCE_LIMITS.maxListUtf8Bytes
  ) {
    throw new Error(
      `maxBytes must be an integer between 1 and ${EVENT_RESOURCE_LIMITS.maxListUtf8Bytes}`,
    );
  }
  return { fromSeq, limit, maxBytes };
}
