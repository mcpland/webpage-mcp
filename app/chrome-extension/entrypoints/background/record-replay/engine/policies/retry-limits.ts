export const LEGACY_RETRY_LIMITS = Object.freeze({
  maxRetries: 10,
  maxIntervalMs: 10 * 60 * 1_000,
});

function boundedInteger(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.floor(value)));
}

export function boundedRetryCount(value: unknown): number {
  return boundedInteger(value, LEGACY_RETRY_LIMITS.maxRetries);
}

export function boundedRetryInterval(value: unknown): number {
  return boundedInteger(value, LEGACY_RETRY_LIMITS.maxIntervalMs);
}

export function boundedRetryDelay(
  intervalMs: unknown,
  retryIndex: number,
  backoff: unknown,
  maxIntervalMs?: unknown,
): number {
  const base = boundedRetryInterval(intervalMs);
  const index = boundedRetryCount(retryIndex);
  const requestedCap =
    maxIntervalMs === undefined
      ? LEGACY_RETRY_LIMITS.maxIntervalMs
      : boundedRetryInterval(maxIntervalMs);

  let delay = base;
  if (backoff === 'linear') delay = base * (index + 1);
  if (backoff === 'exp') delay = base * 2 ** index;

  return Math.min(delay, requestedCap, LEGACY_RETRY_LIMITS.maxIntervalMs);
}
