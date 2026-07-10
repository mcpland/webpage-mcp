// engine/policies/retry.ts — unified retry/backoff policy

import {
  boundedRetryCount,
  boundedRetryDelay,
  boundedRetryInterval,
} from './retry-limits';

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
  const max = boundedRetryCount(opts?.count);
  const base = boundedRetryInterval(opts?.intervalMs);
  const backoff: BackoffKind = opts?.backoff === 'exp' ? 'exp' : 'none';
  let attempt = 0;
  while (true) {
    try {
      return await run();
    } catch (e) {
      if (attempt >= max) throw e;
      if (onRetry) await onRetry(attempt, e);
      const delay = boundedRetryDelay(base, attempt, backoff);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      attempt += 1;
    }
  }
}
