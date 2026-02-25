/**
 * @fileoverview 崩溃恢复测试 (P3-06)
 * @description
 * Tests for:
 * - recoverOrphanLeases (queue-level)
 * - RecoveryCoordinator (orchestration)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RunRecordV3,
  RunEvent,
} from '@/entrypoints/background/record-replay-v3/domain/events';
import type { StoragePort } from '@/entrypoints/background/record-replay-v3/engine/storage/storage-port';
import type { EventsBus } from '@/entrypoints/background/record-replay-v3/engine/transport/events-bus';
import type { RunQueueItem } from '@/entrypoints/background/record-replay-v3/engine/queue/queue';
import { DEFAULT_QUEUE_CONFIG } from '@/entrypoints/background/record-replay-v3/engine/queue/queue';
import {
  createQueueStore,
  closeRrV3Db,
  deleteRrV3Db,
} from '@/entrypoints/background/record-replay-v3';
import { recoverFromCrash } from '@/entrypoints/background/record-replay-v3/engine/recovery/recovery-coordinator';

// ==================== Queue-level Tests ====================

describe('recoverOrphanLeases', () => {
  beforeEach(async () => {
    await deleteRrV3Db();
    closeRrV3Db();
  });

  it('requeues orphan running items and adopts orphan paused items', async () => {
    const queue = createQueueStore();
    const t0 = 1_700_000_000_000;
    const t1 = t0 + 1234;

    await queue.enqueue({ id: 'run-running' as any, flowId: 'flow-1' as any, priority: 1 });
    await queue.enqueue({ id: 'run-paused' as any, flowId: 'flow-1' as any, priority: 1 });

    await queue.markRunning('run-running' as any, 'old-owner', t0);
    await queue.markPaused('run-paused' as any, 'old-owner', t0);

    const recovered = await queue.recoverOrphanLeases('new-owner', t1);

    expect(recovered).toEqual({
      requeuedRunning: [{ runId: 'run-running', prevOwnerId: 'old-owner' }],
      adoptedPaused: [{ runId: 'run-paused', prevOwnerId: 'old-owner' }],
    });

    const runningAfter = await queue.get('run-running' as any);
    expect(runningAfter).toMatchObject({ id: 'run-running', status: 'queued', attempt: 1 });
    expect(runningAfter!.lease).toBeUndefined();

    const pausedAfter = await queue.get('run-paused' as any);
    expect(pausedAfter).toMatchObject({
      id: 'run-paused',
      status: 'paused',
      attempt: 0,
      lease: { ownerId: 'new-owner' },
    });
    expect(pausedAfter!.lease!.expiresAt).toBe(t1 + DEFAULT_QUEUE_CONFIG.leaseTtlMs);
  });

  it('skips items already owned by the current ownerId', async () => {
    const queue = createQueueStore();
    const t0 = 1_700_000_000_000;

    await queue.enqueue({ id: 'run-running' as any, flowId: 'flow-1' as any, priority: 1 });
    await queue.enqueue({ id: 'run-paused' as any, flowId: 'flow-1' as any, priority: 1 });

    await queue.markRunning('run-running' as any, 'owner-1', t0);
    await queue.markPaused('run-paused' as any, 'owner-1', t0);

    const recovered = await queue.recoverOrphanLeases('owner-1', t0 + 1);
    expect(recovered).toEqual({ requeuedRunning: [], adoptedPaused: [] });

    const runningAfter = await queue.get('run-running' as any);
    expect(runningAfter).toMatchObject({
      id: 'run-running',
      status: 'running',
      lease: { ownerId: 'owner-1' },
    });

    const pausedAfter = await queue.get('run-paused' as any);
    expect(pausedAfter).toMatchObject({
      id: 'run-paused',
      status: 'paused',
      lease: { ownerId: 'owner-1' },
    });
  });

  it('handles items without lease (defensive)', async () => {
    const queue = createQueueStore();
    const t0 = 1_700_000_000_000;

    // Enqueue and claim, but the item will have lease
    await queue.enqueue({ id: 'run-1' as any, flowId: 'flow-1' as any });

    // Directly mark as running (with lease)
    await queue.markRunning('run-1' as any, 'old-owner', t0);

    // Recover with new owner
    const recovered = await queue.recoverOrphanLeases('new-owner', t0 + 1);
    expect(recovered.requeuedRunning).toHaveLength(1);
    expect(recovered.requeuedRunning[0].runId).toBe('run-1');
  });

  it('preserves attempt count during recovery', async () => {
    const queue = createQueueStore();
    const t0 = 1_700_000_000_000;

    await queue.enqueue({ id: 'run-1' as any, flowId: 'flow-1' as any });

    // Simulate multiple claim cycles
    await queue.claimNext('owner-1', t0); // attempt becomes 1
    // Simulate crash by recovering with new owner
    await queue.recoverOrphanLeases('owner-2', t0 + 1);

    const item = await queue.get('run-1' as any);
    expect(item?.status).toBe('queued');
    expect(item?.attempt).toBe(1); // Preserved, not reset

    // Next claim will increment
    const claimed = await queue.claimNext('owner-2', t0 + 2);
    expect(claimed?.attempt).toBe(2);
  });

  it('rejects empty ownerId', async () => {
    const queue = createQueueStore();
    await expect(queue.recoverOrphanLeases('', Date.now())).rejects.toThrow('ownerId is required');
  });

  it('rejects invalid now', async () => {
    const queue = createQueueStore();
    await expect(queue.recoverOrphanLeases('owner', NaN)).rejects.toThrow('Invalid now');
    await expect(queue.recoverOrphanLeases('owner', Infinity)).rejects.toThrow('Invalid now');
  });
});

// ==================== RecoveryCoordinator Tests ====================

describe('RecoveryCoordinator', () => {
  function createMockStorage(): StoragePort & {
    _queueMap: Map<string, RunQueueItem>;
    _runsMap: Map<string, RunRecordV3>;
  } {
    const queueMap = new Map<string, RunQueueItem>();
    const runsMap = new Map<string, RunRecordV3>();

    const queue = {
      list: vi.fn(async () => Array.from(queueMap.values())),
      get: vi.fn(async (runId: string) => queueMap.get(runId) ?? null),
      markDone: vi.fn(async (runId: string) => {
        queueMap.delete(runId);
      }),
      recoverOrphanLeases: vi.fn(async (ownerId: string, now: number) => {
        const requeuedRunning: Array<{ runId: string; prevOwnerId?: string }> = [];
        const adoptedPaused: Array<{ runId: string; prevOwnerId?: string }> = [];

        for (const [runId, item] of queueMap) {
          if (item.status === 'running') {
            const isOrphan = !item.lease || item.lease.ownerId !== ownerId;
            if (isOrphan) {
              const prevOwnerId = item.lease?.ownerId;
              item.status = 'queued';
              item.updatedAt = now;
              delete (item as any).lease;
              requeuedRunning.push({ runId, ...(prevOwnerId ? { prevOwnerId } : {}) });
            }
          } else if (item.status === 'paused') {
            const isOrphan = !item.lease || item.lease.ownerId !== ownerId;
            if (isOrphan) {
              const prevOwnerId = item.lease?.ownerId;
              item.updatedAt = now;
              item.lease = { ownerId, expiresAt: now + 15_000 };
              adoptedPaused.push({ runId, ...(prevOwnerId ? { prevOwnerId } : {}) });
            }
          }
        }

        return { requeuedRunning, adoptedPaused };
      }),
    };

    const runs = {
      get: vi.fn(async (id: string) => runsMap.get(id) ?? null),
      patch: vi.fn(async (id: string, patch: Partial<RunRecordV3>) => {
        const existing = runsMap.get(id);
        if (existing) {
          runsMap.set(id, { ...existing, ...patch });
        }
      }),
    };

    return {
      flows: {} as any,
      runs: runs as any,
      events: {} as any,
      queue: queue as any,
      persistentVars: {} as any,
      triggers: {} as any,
      _queueMap: queueMap,
      _runsMap: runsMap,
    };
  }

  function createMockEventsBus(): EventsBus & { _events: RunEvent[] } {
    const events: RunEvent[] = [];
    return {
      subscribe: vi.fn(() => () => {}),
      append: vi.fn(async (event: any) => {
        const fullEvent = { ...event, ts: event.ts ?? Date.now(), seq: events.length + 1 };
        events.push(fullEvent);
        return fullEvent;
      }),
      list: vi.fn(async () => []),
      _events: events,
    } as EventsBus & { _events: RunEvent[] };
  }

  function createRunRecord(id: string, status: string): RunRecordV3 {
    return {
      schemaVersion: 3,
      id: id as any,
      flowId: 'flow-1' as any,
      status: status as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempt: 1,
      maxAttempts: 3,
      nextSeq: 0,
    };
  }

  function createQueueItem(id: string, status: string, ownerId?: string): RunQueueItem {
    return {
      id: id as any,
      flowId: 'flow-1' as any,
      status: status as any,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      priority: 0,
      attempt: 1,
      maxAttempts: 3,
      lease: ownerId ? { ownerId, expiresAt: Date.now() + 15_000 } : undefined,
    };
  }

  it('requeues orphan running and emits run.recovered event', async () => {
    const storage = createMockStorage();
    const events = createMockEventsBus();
    const fixedNow = 1_700_000_000_000;

    // Setup: running item with old owner
    storage._queueMap.set('run-1', createQueueItem('run-1', 'running', 'old-owner'));
    storage._runsMap.set('run-1', createRunRecord('run-1', 'running'));

    const result = await recoverFromCrash({
      storage,
      events,
      ownerId: 'new-owner',
      now: () => fixedNow,
    });

    expect(result.requeuedRunning).toEqual(['run-1']);
    expect(result.adoptedPaused).toEqual([]);
    expect(result.cleanedTerminal).toEqual([]);

    // Check RunRecord was patched
    expect(storage.runs.patch).toHaveBeenCalledWith('run-1', {
      status: 'queued',
      updatedAt: fixedNow,
    });

    // Check event was emitted
    expect(events._events).toHaveLength(1);
    expect(events._events[0]).toMatchObject({
      runId: 'run-1',
      type: 'run.recovered',
      reason: 'sw_restart',
      fromStatus: 'running',
      toStatus: 'queued',
      prevOwnerId: 'old-owner',
    });
  });

  it('adopts orphan paused without emitting event', async () => {
    const storage = createMockStorage();
    const events = createMockEventsBus();
    const fixedNow = 1_700_000_000_000;

    // Setup: paused item with old owner
    storage._queueMap.set('run-1', createQueueItem('run-1', 'paused', 'old-owner'));
    storage._runsMap.set('run-1', createRunRecord('run-1', 'paused'));

    const result = await recoverFromCrash({
      storage,
      events,
      ownerId: 'new-owner',
      now: () => fixedNow,
    });

    expect(result.requeuedRunning).toEqual([]);
    expect(result.adoptedPaused).toEqual(['run-1']);
    expect(result.cleanedTerminal).toEqual([]);

    // No event for adopted paused (they stay paused)
    expect(events._events).toHaveLength(0);
  });

  it('cleans terminal runs from queue', async () => {
    const storage = createMockStorage();
    const events = createMockEventsBus();

    // Setup: terminal run still in queue (crash between runner finish and scheduler markDone)
    storage._queueMap.set('run-1', createQueueItem('run-1', 'running', 'old-owner'));
    storage._runsMap.set('run-1', createRunRecord('run-1', 'succeeded'));

    const result = await recoverFromCrash({
      storage,
      events,
      ownerId: 'new-owner',
      now: () => Date.now(),
    });

    expect(result.cleanedTerminal).toEqual(['run-1']);
    expect(storage.queue.markDone).toHaveBeenCalledWith('run-1', expect.any(Number));
  });

  it('cleans queue items without RunRecord', async () => {
    const storage = createMockStorage();
    const events = createMockEventsBus();

    // Setup: queue item without RunRecord (orphan)
    storage._queueMap.set('run-orphan', createQueueItem('run-orphan', 'queued'));
    // Note: no corresponding RunRecord

    const result = await recoverFromCrash({
      storage,
      events,
      ownerId: 'new-owner',
      now: () => Date.now(),
    });

    expect(result.cleanedTerminal).toEqual(['run-orphan']);
  });

  it('skips items already owned by current ownerId', async () => {
    const storage = createMockStorage();
    const events = createMockEventsBus();

    // Setup: running item with current owner
    storage._queueMap.set('run-1', createQueueItem('run-1', 'running', 'current-owner'));
    storage._runsMap.set('run-1', createRunRecord('run-1', 'running'));

    const result = await recoverFromCrash({
      storage,
      events,
      ownerId: 'current-owner',
      now: () => Date.now(),
    });

    expect(result.requeuedRunning).toEqual([]);
    expect(result.adoptedPaused).toEqual([]);
    expect(result.cleanedTerminal).toEqual([]);
    expect(events._events).toHaveLength(0);
  });

  it('handles mixed recovery scenario', async () => {
    const storage = createMockStorage();
    const events = createMockEventsBus();
    const fixedNow = 1_700_000_000_000;

    // Setup: various scenarios
    storage._queueMap.set(
      'run-running-orphan',
      createQueueItem('run-running-orphan', 'running', 'old-owner'),
    );
    storage._runsMap.set('run-running-orphan', createRunRecord('run-running-orphan', 'running'));

    storage._queueMap.set(
      'run-paused-orphan',
      createQueueItem('run-paused-orphan', 'paused', 'old-owner'),
    );
    storage._runsMap.set('run-paused-orphan', createRunRecord('run-paused-orphan', 'paused'));

    storage._queueMap.set('run-terminal', createQueueItem('run-terminal', 'running', 'old-owner'));
    storage._runsMap.set('run-terminal', createRunRecord('run-terminal', 'failed'));

    storage._queueMap.set(
      'run-current-owner',
      createQueueItem('run-current-owner', 'running', 'new-owner'),
    );
    storage._runsMap.set('run-current-owner', createRunRecord('run-current-owner', 'running'));

    const result = await recoverFromCrash({
      storage,
      events,
      ownerId: 'new-owner',
      now: () => fixedNow,
    });

    expect(result.cleanedTerminal).toContain('run-terminal');
    expect(result.requeuedRunning).toContain('run-running-orphan');
    expect(result.adoptedPaused).toContain('run-paused-orphan');
    // Current owner items are not affected
    expect(result.requeuedRunning).not.toContain('run-current-owner');
  });

  it('throws if ownerId is empty', async () => {
    const storage = createMockStorage();
    const events = createMockEventsBus();

    await expect(
      recoverFromCrash({
        storage,
        events,
        ownerId: '',
        now: () => Date.now(),
      }),
    ).rejects.toThrow('ownerId is required');
  });
});
