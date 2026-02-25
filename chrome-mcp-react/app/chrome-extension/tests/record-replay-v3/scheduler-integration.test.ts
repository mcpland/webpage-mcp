/**
 * @fileoverview 并行调度集成测试 (P3-07)
 * @description
 * End-to-end tests for Scheduler + Queue + LeaseManager + Recovery
 * Uses real IndexedDB storage (fake-indexeddb) to verify integration.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunId } from '@/entrypoints/background/record-replay-v3/domain/ids';
import type { RunRecordV3 } from '@/entrypoints/background/record-replay-v3/domain/events';
import type { RunQueueItem } from '@/entrypoints/background/record-replay-v3/engine/queue/queue';
import { DEFAULT_QUEUE_CONFIG } from '@/entrypoints/background/record-replay-v3/engine/queue/queue';
import {
  createLeaseManager,
  generateOwnerId,
} from '@/entrypoints/background/record-replay-v3/engine/queue/leasing';
import {
  createRunScheduler,
  type RunExecutor,
} from '@/entrypoints/background/record-replay-v3/engine/queue/scheduler';
import { InMemoryKeepaliveController } from '@/entrypoints/background/record-replay-v3/engine/keepalive/offscreen-keepalive';
import {
  createQueueStore,
  createRunsStore,
  closeRrV3Db,
  deleteRrV3Db,
} from '@/entrypoints/background/record-replay-v3';
import { recoverFromCrash } from '@/entrypoints/background/record-replay-v3/engine/recovery/recovery-coordinator';

// ==================== Test Utilities ====================

function createMockEventsBus() {
  const events: unknown[] = [];
  return {
    subscribe: vi.fn(() => () => {}),
    append: vi.fn(async (event: unknown) => {
      const fullEvent = { ...(event as object), ts: Date.now(), seq: events.length + 1 };
      events.push(fullEvent);
      return fullEvent;
    }),
    list: vi.fn(async () => []),
    _events: events,
  };
}

function createMockStorage(
  queueStore: ReturnType<typeof createQueueStore>,
  runsStore: ReturnType<typeof createRunsStore>,
) {
  return {
    flows: {} as any,
    runs: runsStore,
    events: {} as any,
    queue: queueStore,
    persistentVars: {} as any,
    triggers: {} as any,
  };
}

function createRunRecord(id: string, status: string): RunRecordV3 {
  return {
    schemaVersion: 3,
    id: id as RunId,
    flowId: 'flow-1' as any,
    status: status as any,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    attempt: 0,
    maxAttempts: 3,
    nextSeq: 0,
  };
}

// ==================== Integration Tests ====================

describe('V3 Scheduler Integration', () => {
  beforeEach(async () => {
    await deleteRrV3Db();
    closeRrV3Db();
  });

  describe('End-to-end scheduling', () => {
    it('scheduler claims from real queue, executes, and marks done', async () => {
      const queue = createQueueStore();
      const keepalive = new InMemoryKeepaliveController();
      const leaseManager = createLeaseManager(queue, DEFAULT_QUEUE_CONFIG);
      const ownerId = generateOwnerId();

      const executed: string[] = [];
      const executor: RunExecutor = async (item) => {
        executed.push(item.id);
        // Simulate short execution
        await new Promise((resolve) => setTimeout(resolve, 10));
      };

      // Enqueue items
      await queue.enqueue({ id: 'run-1' as any, flowId: 'flow-1' as any, priority: 0 });
      await queue.enqueue({ id: 'run-2' as any, flowId: 'flow-1' as any, priority: 0 });

      const scheduler = createRunScheduler({
        queue,
        leaseManager,
        keepalive,
        config: { ...DEFAULT_QUEUE_CONFIG, maxParallelRuns: 1 },
        ownerId,
        execute: executor,
        tuning: { pollIntervalMs: 0, reclaimIntervalMs: 0 },
      });

      scheduler.start();

      // Wait for execution
      await new Promise((resolve) => setTimeout(resolve, 100));

      scheduler.stop();

      // Both runs should be executed
      expect(executed).toContain('run-1');
      expect(executed).toContain('run-2');

      // Queue should be empty
      const remaining = await queue.list();
      expect(remaining).toHaveLength(0);
    });

    it('respects maxParallelRuns with real queue', async () => {
      const queue = createQueueStore();
      const keepalive = new InMemoryKeepaliveController();
      const leaseManager = createLeaseManager(queue, DEFAULT_QUEUE_CONFIG);
      const ownerId = generateOwnerId();

      let concurrentCount = 0;
      let maxConcurrent = 0;
      const executionTimes: Map<string, { start: number; end?: number }> = new Map();

      const executor: RunExecutor = async (item) => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        executionTimes.set(item.id, { start: Date.now() });

        await new Promise((resolve) => setTimeout(resolve, 50));

        executionTimes.get(item.id)!.end = Date.now();
        concurrentCount--;
      };

      // Enqueue 5 items
      for (let i = 0; i < 5; i++) {
        await queue.enqueue({ id: `run-${i}` as any, flowId: 'flow-1' as any, priority: 0 });
      }

      const scheduler = createRunScheduler({
        queue,
        leaseManager,
        keepalive,
        config: { ...DEFAULT_QUEUE_CONFIG, maxParallelRuns: 2 },
        ownerId,
        execute: executor,
        tuning: { pollIntervalMs: 10, reclaimIntervalMs: 0 },
      });

      scheduler.start();

      // Wait for all executions
      await new Promise((resolve) => setTimeout(resolve, 500));

      scheduler.stop();

      // Max concurrent should not exceed 2
      expect(maxConcurrent).toBeLessThanOrEqual(2);

      // All runs should complete
      expect(executionTimes.size).toBe(5);
    });

    it('maintains FIFO within same priority', async () => {
      const queue = createQueueStore();
      const keepalive = new InMemoryKeepaliveController();
      const leaseManager = createLeaseManager(queue, DEFAULT_QUEUE_CONFIG);
      const ownerId = generateOwnerId();

      const executionOrder: string[] = [];
      const executor: RunExecutor = async (item) => {
        executionOrder.push(item.id);
        await new Promise((resolve) => setTimeout(resolve, 10));
      };

      // Enqueue in order with same priority
      await queue.enqueue({ id: 'run-1' as any, flowId: 'flow-1' as any, priority: 0 });
      await new Promise((resolve) => setTimeout(resolve, 5)); // Ensure different createdAt
      await queue.enqueue({ id: 'run-2' as any, flowId: 'flow-1' as any, priority: 0 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await queue.enqueue({ id: 'run-3' as any, flowId: 'flow-1' as any, priority: 0 });

      const scheduler = createRunScheduler({
        queue,
        leaseManager,
        keepalive,
        config: { ...DEFAULT_QUEUE_CONFIG, maxParallelRuns: 1 }, // Serial execution
        ownerId,
        execute: executor,
        tuning: { pollIntervalMs: 0, reclaimIntervalMs: 0 },
      });

      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 200));

      scheduler.stop();

      // Should execute in FIFO order
      expect(executionOrder).toEqual(['run-1', 'run-2', 'run-3']);
    });

    it('higher priority runs first', async () => {
      const queue = createQueueStore();
      const keepalive = new InMemoryKeepaliveController();
      const leaseManager = createLeaseManager(queue, DEFAULT_QUEUE_CONFIG);
      const ownerId = generateOwnerId();

      const executionOrder: string[] = [];
      const executor: RunExecutor = async (item) => {
        executionOrder.push(item.id);
        await new Promise((resolve) => setTimeout(resolve, 10));
      };

      // Enqueue with different priorities (low first)
      await queue.enqueue({ id: 'run-low' as any, flowId: 'flow-1' as any, priority: 0 });
      await queue.enqueue({ id: 'run-high' as any, flowId: 'flow-1' as any, priority: 10 });
      await queue.enqueue({ id: 'run-medium' as any, flowId: 'flow-1' as any, priority: 5 });

      const scheduler = createRunScheduler({
        queue,
        leaseManager,
        keepalive,
        config: { ...DEFAULT_QUEUE_CONFIG, maxParallelRuns: 1 },
        ownerId,
        execute: executor,
        tuning: { pollIntervalMs: 0, reclaimIntervalMs: 0 },
      });

      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 200));

      scheduler.stop();

      // Should execute in priority order (high -> medium -> low)
      expect(executionOrder).toEqual(['run-high', 'run-medium', 'run-low']);
    });
  });

  describe('Lease management', () => {
    it('heartbeat keeps leases alive during long runs', async () => {
      const queue = createQueueStore();
      const keepalive = new InMemoryKeepaliveController();
      const config = {
        ...DEFAULT_QUEUE_CONFIG,
        leaseTtlMs: 100, // Short TTL for testing
        heartbeatIntervalMs: 30, // Frequent heartbeat
      };
      const leaseManager = createLeaseManager(queue, config);
      const ownerId = generateOwnerId();

      let runningItem: RunQueueItem | null = null;
      const executor: RunExecutor = async (item) => {
        runningItem = item;
        // Run longer than TTL
        await new Promise((resolve) => setTimeout(resolve, 200));
      };

      await queue.enqueue({ id: 'long-run' as any, flowId: 'flow-1' as any });

      const scheduler = createRunScheduler({
        queue,
        leaseManager,
        keepalive,
        config: { ...config, maxParallelRuns: 1 },
        ownerId,
        execute: executor,
        tuning: { pollIntervalMs: 0, reclaimIntervalMs: 0 },
      });

      scheduler.start();

      // Wait for run to be claimed
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runningItem).not.toBeNull();

      // Check that lease is being renewed
      const itemMidRun = await queue.get('long-run' as any);
      expect(itemMidRun?.status).toBe('running');
      expect(itemMidRun?.lease?.ownerId).toBe(ownerId);

      // Wait for completion
      await new Promise((resolve) => setTimeout(resolve, 200));

      scheduler.stop();

      // Run should complete successfully
      const remaining = await queue.list();
      expect(remaining).toHaveLength(0);
    });

    it('expired leases are reclaimed by periodic scan', async () => {
      const queue = createQueueStore();
      const keepalive = new InMemoryKeepaliveController();
      const leaseManager = createLeaseManager(queue, DEFAULT_QUEUE_CONFIG);

      // Note: markRunning uses DEFAULT_LEASE_TTL_MS (15s) internally.
      // To simulate an expired lease, we pass a past time that makes
      // expiresAt (pastTime + 15s) be in the past relative to now.
      const pastTime = Date.now() - DEFAULT_QUEUE_CONFIG.leaseTtlMs - 100; // expired 100ms ago
      await queue.enqueue({ id: 'orphan-run' as any, flowId: 'flow-1' as any });
      await queue.markRunning('orphan-run' as any, 'dead-owner', pastTime);

      // Verify lease exists and is expired
      const expiredItem = await queue.get('orphan-run' as any);
      expect(expiredItem?.status).toBe('running');
      expect(expiredItem?.lease?.expiresAt).toBe(pastTime + DEFAULT_QUEUE_CONFIG.leaseTtlMs);
      expect(expiredItem?.lease?.expiresAt).toBeLessThan(Date.now());

      // Manually trigger reclaim to simulate what scheduler does periodically
      const reclaimedIds = await leaseManager.reclaimExpiredLeases(Date.now());
      expect(reclaimedIds).toContain('orphan-run');

      // Now queue item should be back to queued
      const reclaimedItem = await queue.get('orphan-run' as any);
      expect(reclaimedItem?.status).toBe('queued');

      // New scheduler should pick it up
      const ownerId = generateOwnerId();
      const executed: string[] = [];
      const executor: RunExecutor = async (item) => {
        executed.push(item.id);
      };

      const scheduler = createRunScheduler({
        queue,
        leaseManager,
        keepalive,
        config: { ...DEFAULT_QUEUE_CONFIG, maxParallelRuns: 1 },
        ownerId,
        execute: executor,
        tuning: { pollIntervalMs: 0, reclaimIntervalMs: 0 },
      });

      scheduler.start();

      await new Promise((resolve) => setTimeout(resolve, 100));

      scheduler.stop();

      // Orphan run should be executed
      expect(executed).toContain('orphan-run');
    });
  });

  describe('Crash recovery simulation', () => {
    it('recovers orphan running items after restart', async () => {
      const queue = createQueueStore();
      const runsStore = createRunsStore();
      const events = createMockEventsBus();

      // Simulate crash scenario: run was running when SW died
      await queue.enqueue({ id: 'crashed-run' as any, flowId: 'flow-1' as any });
      await queue.markRunning('crashed-run' as any, 'old-sw-owner', Date.now());
      await runsStore.save(createRunRecord('crashed-run', 'running'));

      // Simulate restart with new owner
      const newOwnerId = generateOwnerId();
      const storage = createMockStorage(queue, runsStore);

      const result = await recoverFromCrash({
        storage,
        events: events as any,
        ownerId: newOwnerId,
        now: () => Date.now(),
      });

      // Run should be requeued
      expect(result.requeuedRunning).toContain('crashed-run');

      // Queue item should be back to queued
      const item = await queue.get('crashed-run' as any);
      expect(item?.status).toBe('queued');
      expect(item?.lease).toBeUndefined();

      // RunRecord should be updated
      const run = await runsStore.get('crashed-run' as any);
      expect(run?.status).toBe('queued');

      // Event should be emitted
      expect(events._events.some((e: any) => e.type === 'run.recovered')).toBe(true);
    });

    it('adopts orphan paused items after restart', async () => {
      const queue = createQueueStore();
      const runsStore = createRunsStore();
      const events = createMockEventsBus();

      // Simulate crash scenario: run was paused when SW died
      await queue.enqueue({ id: 'paused-run' as any, flowId: 'flow-1' as any });
      await queue.markPaused('paused-run' as any, 'old-sw-owner', Date.now());
      await runsStore.save(createRunRecord('paused-run', 'paused'));

      // Simulate restart with new owner
      const newOwnerId = generateOwnerId();
      const storage = createMockStorage(queue, runsStore);

      const result = await recoverFromCrash({
        storage,
        events: events as any,
        ownerId: newOwnerId,
        now: () => Date.now(),
      });

      // Run should be adopted (stays paused)
      expect(result.adoptedPaused).toContain('paused-run');

      // Queue item should still be paused with new owner
      const item = await queue.get('paused-run' as any);
      expect(item?.status).toBe('paused');
      expect(item?.lease?.ownerId).toBe(newOwnerId);
    });

    it('preserves attempt count across recovery', async () => {
      const queue = createQueueStore();
      const runsStore = createRunsStore();
      const events = createMockEventsBus();

      // Simulate a run that has already been attempted
      await queue.enqueue({ id: 'retried-run' as any, flowId: 'flow-1' as any });
      await queue.claimNext('old-owner', Date.now()); // attempt becomes 1
      await runsStore.save({ ...createRunRecord('retried-run', 'running'), attempt: 1 });

      // Simulate restart
      const newOwnerId = generateOwnerId();
      const storage = createMockStorage(queue, runsStore);

      await recoverFromCrash({
        storage,
        events: events as any,
        ownerId: newOwnerId,
        now: () => Date.now(),
      });

      // Queue item should preserve attempt count
      const item = await queue.get('retried-run' as any);
      expect(item?.status).toBe('queued');
      expect(item?.attempt).toBe(1); // Not reset

      // Next claim will increment
      const claimed = await queue.claimNext(newOwnerId, Date.now());
      expect(claimed?.attempt).toBe(2);
    });

    it('cleans terminal runs left in queue due to crash', async () => {
      const queue = createQueueStore();
      const runsStore = createRunsStore();
      const events = createMockEventsBus();

      // Simulate crash scenario: run completed but queue item wasn't removed
      await queue.enqueue({ id: 'completed-run' as any, flowId: 'flow-1' as any });
      await queue.markRunning('completed-run' as any, 'old-owner', Date.now());
      await runsStore.save(createRunRecord('completed-run', 'succeeded'));

      // Simulate restart
      const newOwnerId = generateOwnerId();
      const storage = createMockStorage(queue, runsStore);

      const result = await recoverFromCrash({
        storage,
        events: events as any,
        ownerId: newOwnerId,
        now: () => Date.now(),
      });

      // Run should be cleaned
      expect(result.cleanedTerminal).toContain('completed-run');

      // Queue should be empty
      const remaining = await queue.list();
      expect(remaining).toHaveLength(0);
    });

    it('recovery then scheduler works correctly', async () => {
      const queue = createQueueStore();
      const runsStore = createRunsStore();
      const events = createMockEventsBus();
      const keepalive = new InMemoryKeepaliveController();

      // Simulate crash scenario
      await queue.enqueue({ id: 'recover-run' as any, flowId: 'flow-1' as any });
      await queue.markRunning('recover-run' as any, 'old-owner', Date.now());
      await runsStore.save(createRunRecord('recover-run', 'running'));

      // Recovery
      const newOwnerId = generateOwnerId();
      const storage = createMockStorage(queue, runsStore);

      await recoverFromCrash({
        storage,
        events: events as any,
        ownerId: newOwnerId,
        now: () => Date.now(),
      });

      // Now start scheduler
      const leaseManager = createLeaseManager(queue, DEFAULT_QUEUE_CONFIG);
      const executed: string[] = [];
      const executor: RunExecutor = async (item) => {
        executed.push(item.id);
      };

      const scheduler = createRunScheduler({
        queue,
        leaseManager,
        keepalive,
        config: { ...DEFAULT_QUEUE_CONFIG, maxParallelRuns: 1 },
        ownerId: newOwnerId,
        execute: executor,
        tuning: { pollIntervalMs: 0, reclaimIntervalMs: 0 },
      });

      scheduler.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      scheduler.stop();

      // Recovered run should be executed
      expect(executed).toContain('recover-run');
    });
  });

  describe('Concurrency', () => {
    it('handles multiple concurrent enqueue/claim cycles', async () => {
      const queue = createQueueStore();
      const keepalive = new InMemoryKeepaliveController();
      const leaseManager = createLeaseManager(queue, DEFAULT_QUEUE_CONFIG);
      const ownerId = generateOwnerId();

      const executed = new Set<string>();
      const executor: RunExecutor = async (item) => {
        executed.add(item.id);
        await new Promise((resolve) => setTimeout(resolve, 20));
      };

      const scheduler = createRunScheduler({
        queue,
        leaseManager,
        keepalive,
        config: { ...DEFAULT_QUEUE_CONFIG, maxParallelRuns: 3 },
        ownerId,
        execute: executor,
        tuning: { pollIntervalMs: 10, reclaimIntervalMs: 0 },
      });

      scheduler.start();

      // Concurrent enqueues while scheduler is running
      const enqueuePromises = [];
      for (let i = 0; i < 10; i++) {
        enqueuePromises.push(
          queue
            .enqueue({
              id: `run-${i}` as any,
              flowId: 'flow-1' as any,
              priority: Math.random() * 10,
            })
            .then(() => scheduler.kick()),
        );
      }

      await Promise.all(enqueuePromises);

      // Wait for all to complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      scheduler.stop();

      // All runs should be executed exactly once
      expect(executed.size).toBe(10);
    });

    it('no double execution under concurrent kicks', async () => {
      const queue = createQueueStore();
      const keepalive = new InMemoryKeepaliveController();
      const leaseManager = createLeaseManager(queue, DEFAULT_QUEUE_CONFIG);
      const ownerId = generateOwnerId();

      const executionCounts = new Map<string, number>();
      const executor: RunExecutor = async (item) => {
        executionCounts.set(item.id, (executionCounts.get(item.id) ?? 0) + 1);
        await new Promise((resolve) => setTimeout(resolve, 50));
      };

      // Pre-enqueue
      for (let i = 0; i < 5; i++) {
        await queue.enqueue({ id: `run-${i}` as any, flowId: 'flow-1' as any });
      }

      const scheduler = createRunScheduler({
        queue,
        leaseManager,
        keepalive,
        config: { ...DEFAULT_QUEUE_CONFIG, maxParallelRuns: 2 },
        ownerId,
        execute: executor,
        tuning: { pollIntervalMs: 0, reclaimIntervalMs: 0 },
      });

      scheduler.start();

      // Hammer with concurrent kicks
      const kickPromises = [];
      for (let i = 0; i < 20; i++) {
        kickPromises.push(scheduler.kick());
      }
      await Promise.all(kickPromises);

      // Wait for completion
      await new Promise((resolve) => setTimeout(resolve, 500));

      scheduler.stop();

      // Each run should execute exactly once
      for (const [runId, count] of executionCounts) {
        expect(count, `${runId} executed ${count} times`).toBe(1);
      }
    });
  });
});
