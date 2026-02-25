// engine/policies/retry.ts — unified retry/backoff policy

export type BackoffKind = 'none' | 'exp';

export interface RetryOptions {
  count?: number; // max attempts beyond the first run
  intervalMs?: number;
  backoff?: BackoffKind;
}

export async function withRetry<T>(
  run: () => Promise<T>,
  onRetry?: (attempt: number, err: any) => Promise<void> | void,
  opts?: RetryOptions,
): Promise<T> {
  const max = Math.max(0, Number(opts?.count ?? 0));
  const base = Math.max(0, Number(opts?.intervalMs ?? 0));
  const backoff = (opts?.backoff || 'none') as BackoffKind;
  let attempt = 0;
  while (true) {
    try {
      return await run();
    } catch (e) {
      if (attempt >= max) throw e;
      if (onRetry) await onRetry(attempt, e);
      const delay = base > 0 ? (backoff === 'exp' ? base * Math.pow(2, attempt) : base) : 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      attempt += 1;
    }
  }
}
