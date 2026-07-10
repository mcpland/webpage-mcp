export const LEGACY_TIMEOUT_LIMITS = Object.freeze({
  maxActionMs: 60 * 60 * 1_000,
});

/** A supplied timeout always resolves to a finite timer value. */
export function boundedActionTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return LEGACY_TIMEOUT_LIMITS.maxActionMs;
  }
  return Math.min(LEGACY_TIMEOUT_LIMITS.maxActionMs, Math.max(0, Math.floor(value)));
}
