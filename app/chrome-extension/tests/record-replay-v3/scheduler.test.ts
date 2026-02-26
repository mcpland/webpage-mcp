/**
 * @fileoverview Record-Replay V3 Scheduler Unit Tests
 * @description
 * Verifies maxParallelRuns enforcement and basic orchestration behavior:
 * - Never exceeds configured parallelism
 * - Automatically backfills when a run completes
 * - Reclaim interval is respected
 */

import { describe, expect, it } from 'vitest';

import type {
  RunQueueConfig,
  RunQueueItem,
} from '@/entrypoints/background/record-replay-v3/engine/queue/queue';
import type { LeaseManager } from '@/entrypoints/background/record-replay-v3/engine/queue/leasing';
import {
  createRunScheduler,
  type RunExecutor,
} from '@/entrypoints/background/record-replay-v3/engine/queue/scheduler';

// ==================== Test Utilities ====================

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeClaimedItem(id: string): RunQueueItem {
  return {
    id,
    flowId: 'flow-1',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    priority: 0,
    attempt: 1,
    maxAttempts: 1,
  };
}

function createSilentLogger(): Pick<Console, 'debug' | 'info' | 'warn' | 'error'> {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

// Keepalive mocks
type KeepaliveLike = { acquire(tag: string): () => void };

const noopKeepalive: KeepaliveLike = {
  acquire: () => () => {},
};

function createKeepaliveProbe(): {
  keepalive: KeepaliveLike;
  acquiredTags: string[];
  releasedCount: () => number;
} {
  const acquiredTags: string[] = [];
  let released = 0;

  const keepalive: KeepaliveLike = {
    acquire: (tag: string) => {
      acquiredTags.push(tag);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        released += 1;
      };
    },
  };

  return { keepalive, acquiredTags, releasedCount: () => released };
}

// ==================== Tests ====================

describe('V3 RunScheduler', () => {
  describe('maxParallelRuns enforcement', () => {
    it('enforces maxParallelRuns and backfills when a run finishes', async () => {
      const config: RunQueueConfig = {
        maxParallelRuns: 2,
        leaseTtlMs: 15_000,
        heartbeatIntervalMs: 5_000,
      };

      const ownerId = 'owner-1';
      const fixedNow = 1_700_000_000_000;

      const items: RunQueueItem[] = [
        makeClaimedItem('run-1'),
        makeClaimedItem('run-2'),
        makeClaimedItem('run-3'),
      ];

      let claimCalls = 0;
      const thirdClaimHappened = createDeferred<void>();
      const doneIds: string[] = [];

      const queue = {
        claimNext: async () => {
          claimCalls += 1;
          if (claimCalls === 3) thirdClaimHappened.resolve(undefined);
          return items.shift() ?? null;
        },
        markDone: async (runId: string) => {
          doneIds.push(runId);
        },
      };

      const started: string[] = [];
      const runDeferreds = new Map<string, Deferred<void>>();
      const run3Started = createDeferred<void>();

      const execute: RunExecutor = async (item) => {
        started.push(item.id);
        const d = createDeferred<void>();
        runDeferreds.set(item.id, d);
        if (item.id === 'run-3') run3Started.resolve(undefined);
        return d.promise;
      };

      let heartbeatStarted = 0;
      let heartbeatStopped = 0;
      const leaseManager: Pick<
        LeaseManager,
        'startHeartbeat' | 'stopHeartbeat' | 'reclaimExpiredLeases'
      > = {
        startHeartbeat: () => {
          heartbeatStarted += 1;
        },
        stopHeartbeat: () => {
          heartbeatStopped += 1;
        },
        reclaimExpiredLeases: async () => [],
      };

      const keepaliveProbe = createKeepaliveProbe();

      const scheduler = createRunScheduler({
        queue,
        leaseManager,
        keepalive: keepaliveProbe.keepalive,
        config,
        ownerId,
        execute,
        now: () => fixedNow,
        tuning: { pollIntervalMs: 0, reclaimIntervalMs: 0 },
        logger: createSilentLogger(),
      });

      scheduler.start();

      // Verify keepalive was acquired on start
      expect(keepaliveProbe.acquiredTags).toEqual(['scheduler']);

      await scheduler.kick();

      expect(heartbeatStarted).toBe(1);
      expect(started).toEqual(['run-1', 'run-2']);
      expect(claimCalls).toBe(2);
      expect(scheduler.getState().activeRunIds.sort()).toEqual(['run-1', 'run-2']);

      // Complete one run and expect an automatic backfill (run-3)
      runDeferreds.get('run-1')!.resolve(undefined);

      await thirdClaimHappened.promise;
      await run3Started.promise;

      expect(claimCalls).toBe(3);
      expect(started).toEqual(['run-1', 'run-2', 'run-3']);
      expect(doneIds).toContain('run-1');
      expect(scheduler.getState().activeRunIds.sort()).toEqual(['run-2', 'run-3']);

      // Drain remaining runs for a clean shutdown
      runDeferreds.get('run-2')!.resolve(undefined);
      runDeferreds.get('run-3')!.resolve(undefined);
      await scheduler.kick();

      scheduler.stop();
      expect(heartbeatStopped).toBe(1);

      // Verify keepalive was released on stop
      expect(keepaliveProbe.releasedCount()).toBe(1);
    });

    it('does not claim when maxParallelRuns is 0', async () => {
      const config: RunQueueConfig = {
        maxParallelRuns: 0,
        leaseTtlMs: 15_000,
        heartbeatIntervalMs: 5_000,
      };

      let claimCalls = 0;
      const queue = {
        claimNext: async () => {
          claimCalls += 1;
          return null;
        },
        markDone: async () => {},
      };

      const leaseManager: Pick<
        LeaseManager,
        'startHeartbeat' | 'stopHeartbeat' | 'reclaimExpiredLeases'
      > = {
        startHeartbeat: () => {},
        stopHeartbeat: () => {},
        reclaimExpiredLeases: async () => [],
      };

      const scheduler = createRunScheduler({
        queue,
        leaseManager,
        keepalive: noopKeepalive,
        config,
        ownerId: 'owner-1',
        execute: async () => {},
        tuning: { pollIntervalMs: 0, reclaimIntervalMs: 0 },
        logger: createSilentLogger(),
      });

      scheduler.start();
      await scheduler.kick();

      expect(claimCalls).toBe(0);
      scheduler.stop();
    });

    it('stops claiming when queue is empty', async () => {
      const config: RunQueueConfig = {
        maxParallelRuns: 5,
        leaseTtlMs: 15_000,
        heartbeatIntervalMs: 5_000,
      };

      const items: RunQueueItem[] = [makeClaimedItem('run-1'), makeClaimedItem('run-2')];

      let claimCalls = 0;
      const queue = {
        claimNext: async () => {
          claimCalls += 1;
          return items.shift() ?? null;
        },
        markDone: async () => {},
      };

      const leaseManager: Pick<
        LeaseManager,
        'startHeartbeat' | 'stopHeartbeat' | 'reclaimExpiredLeases'
      > = {
        startHeartbeat: () => {},
        stopHeartbeat: () => {},
        reclaimExpiredLeases: async () => [],
      };

      const runDeferreds = new Map<string, Deferred<void>>();
      const execute: RunExecutor = async (item) => {
        const d = createDeferred<void>();
        runDeferreds.set(item.id, d);
        return d.promise;
      };

      const scheduler = createRunScheduler({
        queue,
        leaseManager,
        keepalive: noopKeepalive,
        config,
        ownerId: 'owner-1',
        execute,
        tuning: { pollIntervalMs: 0, reclaimIntervalMs: 0 },
        logger: createSilentLogger(),
      });

      scheduler.start();
      await scheduler.kick();

      // Should have claimed all available items (2) then stopped when queue returned null
      // Note: claimNext is called until it returns null to fill all slots up to maxParallelRuns
      expect(claimCalls).toBeGreaterThanOrEqual(3); // At least: 2 successful + 1 null
      expect(scheduler.getState().activeRunIds.sort()).toEqual(['run-1', 'run-2']);

      runDeferreds.get('run-1')!.resolve(undefined);
      runDeferreds.get('run-2')!.resolve(undefined);
      scheduler.stop();
    });
  });

  describe('lease reclamation', () => {
    it('reclaims expired leases at the configured interval', async () => {
      const config: RunQueueConfig = {
        maxParallelRuns: 0,
        leaseTtlMs: 15_000,
        heartbeatIntervalMs: 5_000,
      };

      let t = 1000;

      const reclaimCalls: number[] = [];
      const leaseManager: Pick<
        LeaseManager,
        'startHeartbeat' | 'stopHeartbeat' | 'reclaimExpiredLeases'
      > = {
        startHeartbeat: () => {},
        stopHeartbeat: () => {},
        reclaimExpiredLeases: async (now) => {
          reclaimCalls.push(now);
          return [];
        },
      };

      const queue = {
        claimNext: async () => null,
        markDone: async () => {},
      };

      const scheduler = createRunScheduler({
        queue,
        leaseManager,
        keepalive: noopKeepalive,
        config,
        ownerId: 'owner-1',
        execute: async () => {},
        now: () => t,
        tuning: { pollIntervalMs: 0, reclaimIntervalMs: 100 },
        logger: createSilentLogger(),
      });

      scheduler.start();
      await scheduler.kick();
      expect(reclaimCalls).toEqual([1000]);

      // Not enough time has passed
      t = 1099;
      await scheduler.kick();
      expect(reclaimCalls).toEqual([1000]);

      // Now enough time has passed
      t = 1100;
      await scheduler.kick();
      expect(reclaimCalls).toEqual([1000, 1100]);

      scheduler.stop();
    });

    it('does not reclaim when reclaimIntervalMs is 0', async () => {
      const config: RunQueueConfig = {
        maxParallelRuns: 0,
        leaseTtlMs: 15_000,
        heartbeatIntervalMs: 5_000,
      };

      const reclaimCalls: number[] = [];
      const leaseManager: Pick<
        LeaseManager,
        'startHeartbeat' | 'stopHeartbeat' | 'reclaimExpiredLeases'
      > = {
        startHeartbeat: () => {},
        stopHeartbeat: () => {},
        reclaimExpiredLeases: async (now) => {
          reclaimCalls.push(now);
          return [];
        },
      };

      const queue = {
        claimNext: async () => null,
        markDone: async () => {},
      };

      const scheduler = createRunScheduler({
        queue,
        leaseManager,
        keepalive: noopKeepalive,
        config,
        ownerId: 'owner-1',
        execute: async () => {},
        tuning: { pollIntervalMs: 0, reclaimIntervalMs: 0 },
        logger: createSilentLogger(),
      });

      scheduler.start();
      await scheduler.kick();
      await scheduler.kick();
      await scheduler.kick();

      expect(reclaimCalls).toEqual([]);
      scheduler.stop();
    });
  });

  describe('error handling', () => {
    it('throws if ownerId is empty', () => {
      const config: RunQueueConfig = {
        maxParallelRuns: 1,
        leaseTtlMs: 15_000,
        heartbeatIntervalMs: 5_000,
      };

      expect(() =>
        createRunScheduler({
          queue: { claimNext: async () => null, markDone: async () => {} },
          leaseManager: {
            startHeartbeat: () => {},
            stopHeartbeat: () => {},
            reclaimExpiredLeases: async () => [],
          },
          keepalive: noopKeepalive,
          config,
          ownerId: '',
          execute: async () => {},
        }),
      ).toThrow('ownerId is required');
    });

    it('continues scheduling when executor throws', async () => {
      const config: RunQueueConfig = {
        maxParallelRuns: 1,
        leaseTtlMs: 15_000,
        heartbeatIntervalMs: 5_000,
      };

      const items: RunQueueItem[] = [makeClaimedItem('run-1'), makeClaimedItem('run-2')];

      let claimCalls = 0;
      const doneIds: string[] = [];
      const queue = {
        claimNext: async () => {
          claimCalls += 1;
          return items.shift() ?? null;
        },
        markDone: async (runId: string) => {
          doneIds.push(runId);
        },
      };

      const leaseManager: Pick<
        LeaseManager,
        'startHeartbeat' | 'stopHeartbeat' | 'reclaimExpiredLeases'
      > = {
        startHeartbeat: () => {},
        stopHeartbeat: () => {},
        reclaimExpiredLeases: async () => [],
      };

      let executeCount = 0;
      const run2Started = createDeferred<void>();
      const execute: RunExecutor = async (item) => {
        executeCount += 1;
        if (item.id === 'run-1') {
          throw new Error('Simulated failure');
        }
        run2Started.resolve(undefined);
      };

      const scheduler = createRunScheduler({
        queue,
        leaseManager,
        keepalive: noopKeepalive,
        config,
        ownerId: 'owner-1',
        execute,
        tuning: { pollIntervalMs: 0, reclaimIntervalMs: 0 },
        logger: createSilentLogger(),
      });

      scheduler.start();
      await scheduler.kick();

      // Wait for run-2 to start (backfill after run-1 failure)
      await run2Started.promise;

      expect(executeCount).toBe(2);
      expect(doneIds).toContain('run-1');

      scheduler.stop();
    });
  });

  describe('state inspection', () => {
    it('getState returns correct information', () => {
      const config: RunQueueConfig = {
        maxParallelRuns: 3,
        leaseTtlMs: 15_000,
        heartbeatIntervalMs: 5_000,
      };

      const scheduler = createRunScheduler({
        queue: { claimNext: async () => null, markDone: async () => {} },
        leaseManager: {
          startHeartbeat: () => {},
          stopHeartbeat: () => {},
          reclaimExpiredLeases: async () => [],
        },
        keepalive: noopKeepalive,
        config,
        ownerId: 'test-owner',
        execute: async () => {},
        logger: createSilentLogger(),
      });

      const state = scheduler.getState();
      expect(state.started).toBe(false);
      expect(state.ownerId).toBe('test-owner');
      expect(state.maxParallelRuns).toBe(3);
      expect(state.activeRunIds).toEqual([]);

      scheduler.start();
      expect(scheduler.getState().started).toBe(true);

      scheduler.stop();
      expect(scheduler.getState().started).toBe(false);
    });

    it('dispose stops the scheduler and clears state', () => {
      const config: RunQueueConfig = {
        maxParallelRuns: 1,
        leaseTtlMs: 15_000,
        heartbeatIntervalMs: 5_000,
      };

      const keepaliveProbe = createKeepaliveProbe();
      let heartbeatStopped = 0;
      const scheduler = createRunScheduler({
        queue: { claimNext: async () => null, markDone: async () => {} },
        leaseManager: {
          startHeartbeat: () => {},
          stopHeartbeat: () => {
            heartbeatStopped += 1;
          },
          reclaimExpiredLeases: async () => [],
        },
        keepalive: keepaliveProbe.keepalive,
        config,
        ownerId: 'test-owner',
        execute: async () => {},
        logger: createSilentLogger(),
      });

      scheduler.start();
      scheduler.dispose();

      expect(scheduler.getState().started).toBe(false);
      expect(heartbeatStopped).toBe(1);
      expect(keepaliveProbe.releasedCount()).toBe(1);
    });
  });
});
