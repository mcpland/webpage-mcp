/**
 * @fileoverview Record-Replay V3 Queue Contracts
 * @description
 * Verifies the persistence + atomic claim contracts for RunQueue:
 * - Basic CRUD operations (enqueue, get, list)
 * - Atomic claimNext with priority DESC + createdAt ASC (FIFO) ordering
 * - Lease management (markRunning, markPaused, markDone)
 * - Concurrent claim behavior
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_QUEUE_CONFIG,
  type RunQueueItem,
} from '@/entrypoints/background/record-replay-v3/engine/queue/queue';

import {
  createQueueStore,
  closeRrV3Db,
  deleteRrV3Db,
} from '@/entrypoints/background/record-replay-v3';

describe('V3 Queue contracts', () => {
  beforeEach(async () => {
    await deleteRrV3Db();
    closeRrV3Db();
  });

  describe('Basic CRUD', () => {
    it('enqueue creates a queued item with correct defaults', async () => {
      const queue = createQueueStore();

      const item = await queue.enqueue({
        id: 'run-1',
        flowId: 'flow-1',
        priority: 5,
      });

      expect(item).toMatchObject({
        id: 'run-1',
        flowId: 'flow-1',
        priority: 5,
        status: 'queued',
        attempt: 0,
      });
      expect(item.createdAt).toBeGreaterThan(0);
      expect(item.updatedAt).toBeGreaterThan(0);
    });

    it('get retrieves an enqueued item', async () => {
      const queue = createQueueStore();

      await queue.enqueue({ id: 'run-1', flowId: 'flow-1', priority: 1 });

      const retrieved = await queue.get('run-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe('run-1');
    });

    it('get returns null for non-existent item', async () => {
      const queue = createQueueStore();

      const retrieved = await queue.get('non-existent');
      expect(retrieved).toBeNull();
    });

    it('list returns all items when no filter', async () => {
      const queue = createQueueStore();

      await queue.enqueue({ id: 'run-1', flowId: 'flow-1', priority: 1 });
      await queue.enqueue({ id: 'run-2', flowId: 'flow-1', priority: 2 });

      const items = await queue.list();
      expect(items).toHaveLength(2);
    });

    it('list filters by status', async () => {
      const queue = createQueueStore();

      await queue.enqueue({ id: 'run-1', flowId: 'flow-1', priority: 1 });
      await queue.enqueue({ id: 'run-2', flowId: 'flow-1', priority: 2 });
      await queue.markRunning('run-1', 'owner-1', Date.now());

      const queued = await queue.list('queued');
      const running = await queue.list('running');

      expect(queued).toHaveLength(1);
      expect(queued[0].id).toBe('run-2');
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe('run-1');
    });
  });

  describe('Atomic claimNext', () => {
    it('returns null when queue is empty', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      const claimed = await queue.claimNext('owner-1', now);
      expect(claimed).toBeNull();
    });

    it('claims the highest priority item first', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      // Enqueue with different priorities (lower number = lower priority)
      await queue.enqueue({ id: 'low', flowId: 'flow-1', priority: 1 });
      await queue.enqueue({ id: 'high', flowId: 'flow-1', priority: 10 });
      await queue.enqueue({ id: 'medium', flowId: 'flow-1', priority: 5 });

      const claimed = await queue.claimNext('owner-1', now);
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe('high');
      expect(claimed!.status).toBe('running');
      expect(claimed!.priority).toBe(10);
    });

    it('claims FIFO within same priority (earlier createdAt first)', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      // Enqueue items with same priority
      // Small delays ensure different createdAt timestamps
      await queue.enqueue({ id: 'first', flowId: 'flow-1', priority: 5 });
      await new Promise((r) => setTimeout(r, 5));
      await queue.enqueue({ id: 'second', flowId: 'flow-1', priority: 5 });
      await new Promise((r) => setTimeout(r, 5));
      await queue.enqueue({ id: 'third', flowId: 'flow-1', priority: 5 });

      // First claim should get 'first'
      const claim1 = await queue.claimNext('owner-1', now);
      expect(claim1!.id).toBe('first');

      // Second claim should get 'second'
      const claim2 = await queue.claimNext('owner-1', now);
      expect(claim2!.id).toBe('second');

      // Third claim should get 'third'
      const claim3 = await queue.claimNext('owner-1', now);
      expect(claim3!.id).toBe('third');

      // Fourth claim should return null
      const claim4 = await queue.claimNext('owner-1', now);
      expect(claim4).toBeNull();
    });

    it('atomically updates item to running with lease', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      await queue.enqueue({ id: 'run-1', flowId: 'flow-1', priority: 1 });

      const claimed = await queue.claimNext('owner-1', now);

      expect(claimed).toMatchObject({
        id: 'run-1',
        status: 'running',
        attempt: 1,
        lease: {
          ownerId: 'owner-1',
        },
      });
      expect(claimed!.lease!.expiresAt).toBeGreaterThan(now);
      expect(claimed!.updatedAt).toBeGreaterThanOrEqual(now);
    });

    it('persists the claimed item as running in the store', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      await queue.enqueue({ id: 'run-1', flowId: 'flow-1', priority: 1 });
      const claimed = await queue.claimNext('owner-1', now);
      expect(claimed).not.toBeNull();

      // Verify persistence via get()
      const stored = await queue.get('run-1');
      expect(stored).toMatchObject({
        id: 'run-1',
        status: 'running',
        attempt: 1,
        lease: { ownerId: 'owner-1' },
      });
    });

    it('increments attempt on each claim', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      await queue.enqueue({ id: 'run-1', flowId: 'flow-1', priority: 1 });

      // First claim
      let claimed = await queue.claimNext('owner-1', now);
      expect(claimed!.attempt).toBe(1);

      // Re-queue by marking as queued (simulating retry)
      await queue.markDone('run-1', now);
      await queue.enqueue({ id: 'run-1', flowId: 'flow-1', priority: 1 });

      // Second claim
      claimed = await queue.claimNext('owner-2', now);
      expect(claimed!.attempt).toBe(1); // New enqueue resets attempt
    });

    it('throws on invalid ownerId', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      await expect(queue.claimNext('', now)).rejects.toThrow('ownerId is required');
    });

    it('throws on invalid now timestamp', async () => {
      const queue = createQueueStore();

      await expect(queue.claimNext('owner-1', NaN)).rejects.toThrow('Invalid now');
      await expect(queue.claimNext('owner-1', Infinity)).rejects.toThrow('Invalid now');
    });

    it('concurrent claims do not return the same item', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      // Enqueue multiple items
      await queue.enqueue({ id: 'run-1', flowId: 'flow-1', priority: 1 });
      await queue.enqueue({ id: 'run-2', flowId: 'flow-1', priority: 1 });
      await queue.enqueue({ id: 'run-3', flowId: 'flow-1', priority: 1 });

      // Claim concurrently
      const claims = await Promise.all([
        queue.claimNext('owner-1', now),
        queue.claimNext('owner-2', now),
        queue.claimNext('owner-3', now),
      ]);

      // Filter out nulls
      const claimed = claims.filter((c): c is RunQueueItem => c !== null);
      expect(claimed).toHaveLength(3);

      // All claimed items should have unique IDs
      const ids = claimed.map((c) => c.id);
      expect(new Set(ids).size).toBe(3);

      // All should be running
      expect(claimed.every((c) => c.status === 'running')).toBe(true);
    });

    it('skips non-queued items', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      await queue.enqueue({ id: 'run-1', flowId: 'flow-1', priority: 10 });
      await queue.enqueue({ id: 'run-2', flowId: 'flow-1', priority: 5 });

      // Mark the higher priority one as running
      await queue.markRunning('run-1', 'owner-1', now);

      // claimNext should skip run-1 and return run-2
      const claimed = await queue.claimNext('owner-2', now);
      expect(claimed!.id).toBe('run-2');
    });
  });

  describe('Status transitions', () => {
    it('markRunning updates status and creates lease', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      await queue.enqueue({ id: 'run-1', flowId: 'flow-1', priority: 1 });
      await queue.markRunning('run-1', 'owner-1', now);

      const item = await queue.get('run-1');
      expect(item!.status).toBe('running');
      expect(item!.lease).toMatchObject({
        ownerId: 'owner-1',
      });
      expect(item!.attempt).toBe(1);
    });

    it('markPaused updates status while keeping lease', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      await queue.enqueue({ id: 'run-1', flowId: 'flow-1', priority: 1 });
      await queue.markRunning('run-1', 'owner-1', now);
      await queue.markPaused('run-1', 'owner-1', now + 1000);

      const item = await queue.get('run-1');
      expect(item!.status).toBe('paused');
      expect(item!.lease!.ownerId).toBe('owner-1');
    });

    it('markDone removes item from queue', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      await queue.enqueue({ id: 'run-1', flowId: 'flow-1', priority: 1 });
      await queue.markDone('run-1', now);

      const item = await queue.get('run-1');
      expect(item).toBeNull();
    });

    it('cancel removes item from queue', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      await queue.enqueue({ id: 'run-1', flowId: 'flow-1', priority: 1 });
      await queue.cancel('run-1', now, 'User cancelled');

      const item = await queue.get('run-1');
      expect(item).toBeNull();
    });

    it('markRunning throws for non-existent item', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      await expect(queue.markRunning('non-existent', 'owner-1', now)).rejects.toThrow(
        'Queue item "non-existent" not found',
      );
    });

    it('markPaused throws for non-existent item', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      await expect(queue.markPaused('non-existent', 'owner-1', now)).rejects.toThrow(
        'Queue item "non-existent" not found',
      );
    });
  });

  describe('Lease heartbeat', () => {
    it('renews leases for running and paused items owned by ownerId', async () => {
      const queue = createQueueStore();
      const t0 = 1_700_000_000_000;
      const t1 = t0 + 1_234;

      await queue.enqueue({ id: 'run-running', flowId: 'flow-1', priority: 1 });
      await queue.enqueue({ id: 'run-paused', flowId: 'flow-1', priority: 1 });
      await queue.enqueue({ id: 'run-other', flowId: 'flow-1', priority: 1 });

      await queue.markRunning('run-running', 'owner-1', t0);
      await queue.markPaused('run-paused', 'owner-1', t0);
      await queue.markRunning('run-other', 'owner-2', t0);

      const otherBefore = await queue.get('run-other');
      const otherExpiresAtBefore = otherBefore!.lease!.expiresAt;

      await queue.heartbeat('owner-1', t1);

      const running = await queue.get('run-running');
      const paused = await queue.get('run-paused');
      const otherAfter = await queue.get('run-other');

      // Owner-1's items should have renewed leases
      expect(running!.lease!.expiresAt).toBe(t1 + DEFAULT_QUEUE_CONFIG.leaseTtlMs);
      expect(paused!.lease!.expiresAt).toBe(t1 + DEFAULT_QUEUE_CONFIG.leaseTtlMs);
      // Owner-2's item should be unchanged
      expect(otherAfter!.lease!.expiresAt).toBe(otherExpiresAtBefore);
    });

    it('is a no-op when the owner has no leased items', async () => {
      const queue = createQueueStore();
      await expect(queue.heartbeat('owner-1', 1_700_000_000_000)).resolves.toBeUndefined();
    });

    it('throws on invalid ownerId', async () => {
      const queue = createQueueStore();
      await expect(queue.heartbeat('', Date.now())).rejects.toThrow('ownerId is required');
    });

    it('throws on invalid now timestamp', async () => {
      const queue = createQueueStore();
      await expect(queue.heartbeat('owner-1', NaN)).rejects.toThrow('Invalid now');
    });
  });

  describe('Lease reclamation', () => {
    it('requeues an expired running item and clears the lease', async () => {
      const queue = createQueueStore();
      const t0 = 1_700_000_000_000;

      await queue.enqueue({ id: 'run-1', flowId: 'flow-1', priority: 1 });
      await queue.markRunning('run-1', 'owner-1', t0);

      const expiresAt = t0 + DEFAULT_QUEUE_CONFIG.leaseTtlMs;

      // Not expired when expiresAt === now (expiry is strictly < now)
      expect(await queue.reclaimExpiredLeases(expiresAt)).toEqual([]);

      // Expired when expiresAt < now
      expect(await queue.reclaimExpiredLeases(expiresAt + 1)).toEqual(['run-1']);

      const item = await queue.get('run-1');
      expect(item).toMatchObject({ id: 'run-1', status: 'queued', attempt: 1 });
      expect(item!.lease).toBeUndefined();
    });

    it('requeues an expired paused item and keeps attempt count', async () => {
      const queue = createQueueStore();
      const t0 = 1_700_000_000_000;

      await queue.enqueue({ id: 'run-2', flowId: 'flow-1', priority: 1 });
      // markPaused doesn't increment attempt (only markRunning/claimNext does)
      await queue.markPaused('run-2', 'owner-1', t0);

      const expiresAt = t0 + DEFAULT_QUEUE_CONFIG.leaseTtlMs;

      expect(await queue.reclaimExpiredLeases(expiresAt + 1)).toEqual(['run-2']);

      const item = await queue.get('run-2');
      expect(item).toMatchObject({ id: 'run-2', status: 'queued', attempt: 0 });
      expect(item!.lease).toBeUndefined();
    });

    it('reclaims multiple expired items in one call', async () => {
      const queue = createQueueStore();
      const t0 = 1_700_000_000_000;

      await queue.enqueue({ id: 'run-1', flowId: 'flow-1', priority: 1 });
      await queue.enqueue({ id: 'run-2', flowId: 'flow-1', priority: 1 });
      await queue.enqueue({ id: 'run-3', flowId: 'flow-1', priority: 1 });

      await queue.markRunning('run-1', 'owner-1', t0);
      await queue.markPaused('run-2', 'owner-1', t0);
      // run-3 stays queued (no lease)

      const expiresAt = t0 + DEFAULT_QUEUE_CONFIG.leaseTtlMs;
      const reclaimed = await queue.reclaimExpiredLeases(expiresAt + 1);

      expect(reclaimed.sort()).toEqual(['run-1', 'run-2']);

      // All should be back to queued
      const run1 = await queue.get('run-1');
      const run2 = await queue.get('run-2');
      const run3 = await queue.get('run-3');

      expect(run1!.status).toBe('queued');
      expect(run2!.status).toBe('queued');
      expect(run3!.status).toBe('queued');
    });

    it('returns empty array when no items are expired', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      await queue.enqueue({ id: 'run-1', flowId: 'flow-1', priority: 1 });
      await queue.markRunning('run-1', 'owner-1', now);

      // Check before expiration
      const reclaimed = await queue.reclaimExpiredLeases(now);
      expect(reclaimed).toEqual([]);
    });

    it('throws on invalid now timestamp', async () => {
      const queue = createQueueStore();
      await expect(queue.reclaimExpiredLeases(NaN)).rejects.toThrow('Invalid now');
    });

    it('reclaimed item can be claimed again with incremented attempt', async () => {
      const queue = createQueueStore();
      const t0 = 1_700_000_000_000;

      await queue.enqueue({ id: 'run-1', flowId: 'flow-1', priority: 1 });

      // First claim: attempt becomes 1
      const claim1 = await queue.claimNext('owner-1', t0);
      expect(claim1!.attempt).toBe(1);

      // Simulate lease expiration and reclaim
      const expiresAt = t0 + DEFAULT_QUEUE_CONFIG.leaseTtlMs;
      await queue.reclaimExpiredLeases(expiresAt + 1);

      // Verify item is back to queued with attempt preserved
      const afterReclaim = await queue.get('run-1');
      expect(afterReclaim!.status).toBe('queued');
      expect(afterReclaim!.attempt).toBe(1);

      // Second claim: attempt becomes 2
      const claim2 = await queue.claimNext('owner-2', expiresAt + 100);
      expect(claim2!.id).toBe('run-1');
      expect(claim2!.attempt).toBe(2);
    });
  });

  describe('Priority ordering edge cases', () => {
    it('handles negative priorities', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      await queue.enqueue({ id: 'neg', flowId: 'flow-1', priority: -5 });
      await queue.enqueue({ id: 'zero', flowId: 'flow-1', priority: 0 });
      await queue.enqueue({ id: 'pos', flowId: 'flow-1', priority: 5 });

      const claim1 = await queue.claimNext('owner-1', now);
      expect(claim1!.id).toBe('pos'); // Highest priority first

      const claim2 = await queue.claimNext('owner-1', now);
      expect(claim2!.id).toBe('zero');

      const claim3 = await queue.claimNext('owner-1', now);
      expect(claim3!.id).toBe('neg');
    });

    it('handles large priority values', async () => {
      const queue = createQueueStore();
      const now = Date.now();

      await queue.enqueue({ id: 'max', flowId: 'flow-1', priority: Number.MAX_SAFE_INTEGER });
      await queue.enqueue({ id: 'min', flowId: 'flow-1', priority: Number.MIN_SAFE_INTEGER });
      await queue.enqueue({ id: 'mid', flowId: 'flow-1', priority: 0 });

      const claim1 = await queue.claimNext('owner-1', now);
      expect(claim1!.id).toBe('max');

      const claim2 = await queue.claimNext('owner-1', now);
      expect(claim2!.id).toBe('mid');

      const claim3 = await queue.claimNext('owner-1', now);
      expect(claim3!.id).toBe('min');
    });
  });
});
