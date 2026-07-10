import { describe, expect, it } from 'vitest';

import { ExecutionStatusCache } from '@/entrypoints/background/web-editor/execution-status-cache';

describe('Web Editor execution status cache', () => {
  it('evicts the oldest entry when the hard size limit is reached', () => {
    let now = 1_000;
    const cache = new ExecutionStatusCache({ maxEntries: 2, ttlMs: 10_000, now: () => now });

    cache.set('request-1', 'starting');
    now += 1;
    cache.set('request-2', 'running');
    now += 1;
    cache.set('request-3', 'completed');

    expect(cache.size).toBe(2);
    expect(cache.get('request-1')).toBeUndefined();
    expect(cache.get('request-2')?.status).toBe('running');
    expect(cache.get('request-3')?.status).toBe('completed');
  });

  it('moves an updated request behind older entries before eviction', () => {
    let now = 1_000;
    const cache = new ExecutionStatusCache({ maxEntries: 2, ttlMs: 10_000, now: () => now });

    cache.set('request-1', 'starting');
    now += 1;
    cache.set('request-2', 'running');
    now += 1;
    cache.set('request-1', 'completed');
    now += 1;
    cache.set('request-3', 'running');

    expect(cache.get('request-1')?.status).toBe('completed');
    expect(cache.get('request-2')).toBeUndefined();
    expect(cache.get('request-3')?.status).toBe('running');
  });

  it('removes expired entries on read and write', () => {
    let now = 1_000;
    const cache = new ExecutionStatusCache({ maxEntries: 2, ttlMs: 100, now: () => now });
    cache.set('request-1', 'running');

    now = 1_101;
    expect(cache.get('request-1')).toBeUndefined();

    cache.set('request-2', 'running');
    now = 1_202;
    cache.set('request-3', 'running');
    expect(cache.get('request-2')).toBeUndefined();
    expect(cache.size).toBe(1);
  });
});
