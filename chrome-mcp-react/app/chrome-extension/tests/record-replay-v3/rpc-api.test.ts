/* eslint-disable @typescript-eslint/no-unsafe-function-type */
/**
 * @fileoverview Record-Replay V3 RPC API Tests
 * @description
 * Tests for the queue management RPC APIs:
 * - rr_v3.enqueueRun
 * - rr_v3.listQueue
 * - rr_v3.cancelQueueItem
 *
 * Tests for Flow CRUD RPC APIs:
 * - rr_v3.saveFlow
 * - rr_v3.deleteFlow
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowV3 } from '@/entrypoints/background/record-replay-v3/domain/flow';
import type { RunRecordV3 } from '@/entrypoints/background/record-replay-v3/domain/events';
import type { StoragePort } from '@/entrypoints/background/record-replay-v3/engine/storage/storage-port';
import type { EventsBus } from '@/entrypoints/background/record-replay-v3/engine/transport/events-bus';
import type { RunScheduler } from '@/entrypoints/background/record-replay-v3/engine/queue/scheduler';
import type { RunQueueItem } from '@/entrypoints/background/record-replay-v3/engine/queue/queue';
import { RpcServer } from '@/entrypoints/background/record-replay-v3/engine/transport/rpc-server';

// ==================== Test Utilities ====================

function createMockStorage(): StoragePort {
  const flowsMap = new Map<string, FlowV3>();
  const runsMap = new Map<string, RunRecordV3>();
  const queueMap = new Map<string, RunQueueItem>();
  const eventsLog: Array<{ runId: string; type: string }> = [];

  return {
    flows: {
      list: vi.fn(async () => Array.from(flowsMap.values())),
      get: vi.fn(async (id: string) => flowsMap.get(id) ?? null),
      save: vi.fn(async (flow: FlowV3) => {
        flowsMap.set(flow.id, flow);
      }),
      delete: vi.fn(async (id: string) => {
        flowsMap.delete(id);
      }),
    },
    runs: {
      list: vi.fn(async () => Array.from(runsMap.values())),
      get: vi.fn(async (id: string) => runsMap.get(id) ?? null),
      save: vi.fn(async (record: RunRecordV3) => {
        runsMap.set(record.id, record);
      }),
      patch: vi.fn(async (id: string, patch: Partial<RunRecordV3>) => {
        const existing = runsMap.get(id);
        if (existing) {
          runsMap.set(id, { ...existing, ...patch });
        }
      }),
    },
    events: {
      append: vi.fn(async (event: { runId: string; type: string }) => {
        eventsLog.push(event);
        return { ...event, ts: Date.now(), seq: eventsLog.length };
      }),
      list: vi.fn(async () => eventsLog),
    },
    queue: {
      enqueue: vi.fn(async (input) => {
        const now = Date.now();
        const item: RunQueueItem = {
          ...input,
          priority: input.priority ?? 0,
          maxAttempts: input.maxAttempts ?? 1,
          status: 'queued',
          createdAt: now,
          updatedAt: now,
          attempt: 0,
        };
        queueMap.set(input.id, item);
        return item;
      }),
      claimNext: vi.fn(async () => null),
      heartbeat: vi.fn(async () => {}),
      reclaimExpiredLeases: vi.fn(async () => []),
      markRunning: vi.fn(async () => {}),
      markPaused: vi.fn(async () => {}),
      markDone: vi.fn(async () => {}),
      cancel: vi.fn(async (runId: string) => {
        queueMap.delete(runId);
      }),
      get: vi.fn(async (runId: string) => queueMap.get(runId) ?? null),
      list: vi.fn(async (status?: string) => {
        const items = Array.from(queueMap.values());
        if (status) {
          return items.filter((item) => item.status === status);
        }
        return items;
      }),
    },
    persistentVars: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => ({ key: '', value: null, updatedAt: 0 })),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => []),
    },
    triggers: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
    // Expose internal maps for assertions
    _internal: { flowsMap, runsMap, queueMap, eventsLog },
  } as unknown as StoragePort & {
    _internal: {
      flowsMap: Map<string, FlowV3>;
      runsMap: Map<string, RunRecordV3>;
      queueMap: Map<string, RunQueueItem>;
      eventsLog: Array<{ runId: string; type: string }>;
    };
  };
}

function createMockEventsBus(): EventsBus {
  const subscribers: Array<(event: unknown) => void> = [];
  return {
    subscribe: vi.fn((callback: (event: unknown) => void) => {
      subscribers.push(callback);
      return () => {
        const idx = subscribers.indexOf(callback);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    }),
    append: vi.fn(async (event) => {
      const fullEvent = { ...event, ts: Date.now(), seq: 1 };
      subscribers.forEach((cb) => cb(fullEvent));
      return fullEvent as ReturnType<EventsBus['append']> extends Promise<infer T> ? T : never;
    }),
    list: vi.fn(async () => []),
  } as EventsBus;
}

function createMockScheduler(): RunScheduler {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    kick: vi.fn(async () => {}),
    getState: vi.fn(() => ({
      started: false,
      ownerId: 'test-owner',
      maxParallelRuns: 3,
      activeRunIds: [],
    })),
    dispose: vi.fn(),
  };
}

function createTestFlow(id: string, options: { withNodes?: boolean } = {}): FlowV3 {
  const now = new Date().toISOString();
  const nodes =
    options.withNodes !== false
      ? [
          { id: 'node-start', kind: 'test', config: {} },
          { id: 'node-end', kind: 'test', config: {} },
        ]
      : [];
  return {
    schemaVersion: 3,
    id: id as FlowV3['id'],
    name: `Test Flow ${id}`,
    entryNodeId: 'node-start' as FlowV3['entryNodeId'],
    nodes: nodes as FlowV3['nodes'],
    edges: [{ id: 'edge-1', from: 'node-start', to: 'node-end' }] as FlowV3['edges'],
    variables: [],
    createdAt: now,
    updatedAt: now,
  };
}

// Helper type for accessing internal maps in mock storage
interface MockStorageInternal {
  flowsMap: Map<string, FlowV3>;
  runsMap: Map<string, RunRecordV3>;
  queueMap: Map<string, RunQueueItem>;
  eventsLog: Array<{ runId: string; type: string }>;
}

// Access _internal property with type safety
function getInternal(storage: StoragePort): MockStorageInternal {
  return (storage as unknown as { _internal: MockStorageInternal })._internal;
}

// ==================== Tests ====================

describe('V3 RPC Queue Management APIs', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let events: EventsBus;
  let scheduler: RunScheduler;
  let server: RpcServer;
  let runIdCounter: number;
  let fixedNow: number;

  beforeEach(() => {
    storage = createMockStorage();
    events = createMockEventsBus();
    scheduler = createMockScheduler();
    runIdCounter = 0;
    fixedNow = 1_700_000_000_000;

    server = new RpcServer({
      storage,
      events,
      scheduler,
      generateRunId: () => `run-${++runIdCounter}`,
      now: () => fixedNow,
    });
  });

  describe('rr_v3.enqueueRun', () => {
    it('creates run record, enqueues, emits event, and kicks scheduler', async () => {
      // Setup: add a flow
      const flow = createTestFlow('flow-1');
      getInternal(storage).flowsMap.set(flow.id, flow);

      // Act: call enqueueRun via handleRequest
      const result = await (server as unknown as { handleRequest: Function }).handleRequest(
        { method: 'rr_v3.enqueueRun', params: { flowId: 'flow-1' }, requestId: 'req-1' },
        { subscriptions: new Set() },
      );

      // Assert: run record created
      expect(storage.runs.save).toHaveBeenCalledTimes(1);
      const savedRun = (storage.runs.save as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(savedRun).toMatchObject({
        id: 'run-1',
        flowId: 'flow-1',
        status: 'queued',
        attempt: 0,
        maxAttempts: 1,
      });

      // Assert: enqueued
      expect(storage.queue.enqueue).toHaveBeenCalledTimes(1);

      // Assert: event emitted via EventsBus
      expect(events.append).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          type: 'run.queued',
          flowId: 'flow-1',
        }),
      );

      // Assert: scheduler kicked
      expect(scheduler.kick).toHaveBeenCalledTimes(1);

      // Assert: result
      expect(result).toMatchObject({
        runId: 'run-1',
        position: 1,
      });
    });

    it('throws if flowId is missing', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          { method: 'rr_v3.enqueueRun', params: {}, requestId: 'req-1' },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('flowId is required');
    });

    it('throws if flow does not exist', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          { method: 'rr_v3.enqueueRun', params: { flowId: 'non-existent' }, requestId: 'req-1' },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Flow "non-existent" not found');
    });

    it('respects custom priority and maxAttempts', async () => {
      const flow = createTestFlow('flow-1');
      getInternal(storage).flowsMap.set(flow.id, flow);

      await (server as unknown as { handleRequest: Function }).handleRequest(
        {
          method: 'rr_v3.enqueueRun',
          params: { flowId: 'flow-1', priority: 10, maxAttempts: 3 },
          requestId: 'req-1',
        },
        { subscriptions: new Set() },
      );

      expect(storage.queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 10,
          maxAttempts: 3,
        }),
      );
    });

    it('passes args and debug config', async () => {
      const flow = createTestFlow('flow-1');
      getInternal(storage).flowsMap.set(flow.id, flow);

      const args = { url: 'https://example.com' };
      const debug = { pauseOnStart: true, breakpoints: ['node-1'] };

      await (server as unknown as { handleRequest: Function }).handleRequest(
        {
          method: 'rr_v3.enqueueRun',
          params: { flowId: 'flow-1', args, debug },
          requestId: 'req-1',
        },
        { subscriptions: new Set() },
      );

      expect(storage.runs.save).toHaveBeenCalledWith(
        expect.objectContaining({
          args,
          debug,
        }),
      );
    });

    it('rejects NaN priority', async () => {
      const flow = createTestFlow('flow-1');
      getInternal(storage).flowsMap.set(flow.id, flow);

      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: 'rr_v3.enqueueRun',
            params: { flowId: 'flow-1', priority: NaN },
            requestId: 'req-1',
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('priority must be a finite number');
    });

    it('rejects Infinity maxAttempts', async () => {
      const flow = createTestFlow('flow-1');
      getInternal(storage).flowsMap.set(flow.id, flow);

      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: 'rr_v3.enqueueRun',
            params: { flowId: 'flow-1', maxAttempts: Infinity },
            requestId: 'req-1',
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('maxAttempts must be a finite number');
    });

    it('rejects maxAttempts < 1', async () => {
      const flow = createTestFlow('flow-1');
      getInternal(storage).flowsMap.set(flow.id, flow);

      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: 'rr_v3.enqueueRun',
            params: { flowId: 'flow-1', maxAttempts: 0 },
            requestId: 'req-1',
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('maxAttempts must be >= 1');
    });

    it('persists startNodeId in RunRecord when provided', async () => {
      // Setup: add a flow with multiple nodes
      const flow = createTestFlow('flow-start-node');
      getInternal(storage).flowsMap.set(flow.id, flow);

      // Act: enqueue with startNodeId
      const targetNodeId = flow.nodes[0].id; // Use the first node
      await (server as unknown as { handleRequest: Function }).handleRequest(
        {
          method: 'rr_v3.enqueueRun',
          params: { flowId: 'flow-start-node', startNodeId: targetNodeId },
          requestId: 'req-1',
        },
        { subscriptions: new Set() },
      );

      // Assert: RunRecord should have startNodeId
      const runsMap = getInternal(storage).runsMap;
      expect(runsMap.size).toBe(1);
      const runRecord = Array.from(runsMap.values())[0];
      expect(runRecord.startNodeId).toBe(targetNodeId);
    });

    it('throws if startNodeId does not exist in flow', async () => {
      // Setup: add a flow
      const flow = createTestFlow('flow-invalid-start');
      getInternal(storage).flowsMap.set(flow.id, flow);

      // Act & Assert
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: 'rr_v3.enqueueRun',
            params: { flowId: 'flow-invalid-start', startNodeId: 'non-existent-node' },
            requestId: 'req-1',
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('startNodeId "non-existent-node" not found in flow');
    });
  });

  describe('rr_v3.listQueue', () => {
    it('returns all queue items sorted by priority DESC and createdAt ASC', async () => {
      // Setup: add items with different priorities and times
      getInternal(storage).queueMap.set('run-1', {
        id: 'run-1',
        flowId: 'flow-1',
        status: 'queued',
        priority: 5,
        createdAt: 1000,
        updatedAt: 1000,
        attempt: 0,
        maxAttempts: 1,
      });
      getInternal(storage).queueMap.set('run-2', {
        id: 'run-2',
        flowId: 'flow-1',
        status: 'queued',
        priority: 10,
        createdAt: 2000,
        updatedAt: 2000,
        attempt: 0,
        maxAttempts: 1,
      });
      getInternal(storage).queueMap.set('run-3', {
        id: 'run-3',
        flowId: 'flow-1',
        status: 'queued',
        priority: 10,
        createdAt: 1500,
        updatedAt: 1500,
        attempt: 0,
        maxAttempts: 1,
      });

      const result = (await (server as unknown as { handleRequest: Function }).handleRequest(
        { method: 'rr_v3.listQueue', params: {}, requestId: 'req-1' },
        { subscriptions: new Set() },
      )) as RunQueueItem[];

      // run-3 (priority 10, earlier) > run-2 (priority 10, later) > run-1 (priority 5)
      expect(result.map((r) => r.id)).toEqual(['run-3', 'run-2', 'run-1']);
    });

    it('filters by status', async () => {
      getInternal(storage).queueMap.set('run-1', {
        id: 'run-1',
        flowId: 'flow-1',
        status: 'queued',
        priority: 0,
        createdAt: 1000,
        updatedAt: 1000,
        attempt: 0,
        maxAttempts: 1,
      });
      getInternal(storage).queueMap.set('run-2', {
        id: 'run-2',
        flowId: 'flow-1',
        status: 'running',
        priority: 0,
        createdAt: 2000,
        updatedAt: 2000,
        attempt: 1,
        maxAttempts: 1,
      });

      const result = (await (server as unknown as { handleRequest: Function }).handleRequest(
        { method: 'rr_v3.listQueue', params: { status: 'queued' }, requestId: 'req-1' },
        { subscriptions: new Set() },
      )) as RunQueueItem[];

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('run-1');
    });

    it('rejects invalid status', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          { method: 'rr_v3.listQueue', params: { status: 'invalid' }, requestId: 'req-1' },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('status must be one of: queued, running, paused');
    });
  });

  describe('rr_v3.cancelQueueItem', () => {
    it('cancels queue item, patches run, and emits event', async () => {
      // Setup
      getInternal(storage).queueMap.set('run-1', {
        id: 'run-1',
        flowId: 'flow-1',
        status: 'queued',
        priority: 0,
        createdAt: 1000,
        updatedAt: 1000,
        attempt: 0,
        maxAttempts: 1,
      });
      getInternal(storage).runsMap.set('run-1', {
        schemaVersion: 3,
        id: 'run-1',
        flowId: 'flow-1',
        status: 'queued',
        createdAt: 1000,
        updatedAt: 1000,
        attempt: 0,
        maxAttempts: 1,
        nextSeq: 0,
      });

      const result = await (server as unknown as { handleRequest: Function }).handleRequest(
        { method: 'rr_v3.cancelQueueItem', params: { runId: 'run-1' }, requestId: 'req-1' },
        { subscriptions: new Set() },
      );

      // Assert: queue.cancel called
      expect(storage.queue.cancel).toHaveBeenCalledWith('run-1', fixedNow, undefined);

      // Assert: run patched
      expect(storage.runs.patch).toHaveBeenCalledWith('run-1', {
        status: 'canceled',
        updatedAt: fixedNow,
        finishedAt: fixedNow,
      });

      // Assert: event emitted via EventsBus
      expect(events.append).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          type: 'run.canceled',
        }),
      );

      // Assert: result
      expect(result).toMatchObject({ ok: true, runId: 'run-1' });
    });

    it('throws if runId is missing', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          { method: 'rr_v3.cancelQueueItem', params: {}, requestId: 'req-1' },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('runId is required');
    });

    it('throws if queue item does not exist', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: 'rr_v3.cancelQueueItem',
            params: { runId: 'non-existent' },
            requestId: 'req-1',
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Queue item "non-existent" not found');
    });

    it('throws if queue item is not queued', async () => {
      getInternal(storage).queueMap.set('run-1', {
        id: 'run-1',
        flowId: 'flow-1',
        status: 'running',
        priority: 0,
        createdAt: 1000,
        updatedAt: 1000,
        attempt: 1,
        maxAttempts: 1,
      });

      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          { method: 'rr_v3.cancelQueueItem', params: { runId: 'run-1' }, requestId: 'req-1' },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Cannot cancel queue item "run-1" with status "running"');
    });

    it('includes reason in cancel event', async () => {
      getInternal(storage).queueMap.set('run-1', {
        id: 'run-1',
        flowId: 'flow-1',
        status: 'queued',
        priority: 0,
        createdAt: 1000,
        updatedAt: 1000,
        attempt: 0,
        maxAttempts: 1,
      });

      await (server as unknown as { handleRequest: Function }).handleRequest(
        {
          method: 'rr_v3.cancelQueueItem',
          params: { runId: 'run-1', reason: 'User requested cancellation' },
          requestId: 'req-1',
        },
        { subscriptions: new Set() },
      );

      expect(storage.queue.cancel).toHaveBeenCalledWith(
        'run-1',
        fixedNow,
        'User requested cancellation',
      );
      expect(events.append).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'User requested cancellation',
        }),
      );
    });
  });
});

describe('V3 RPC Flow CRUD APIs', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let events: EventsBus;
  let scheduler: RunScheduler;
  let server: RpcServer;
  let fixedNow: number;

  beforeEach(() => {
    storage = createMockStorage();
    events = createMockEventsBus();
    scheduler = createMockScheduler();
    fixedNow = 1_700_000_000_000;

    server = new RpcServer({
      storage,
      events,
      scheduler,
      now: () => fixedNow,
    });
  });

  describe('rr_v3.saveFlow', () => {
    it('saves a new flow with all required fields', async () => {
      const flowInput = {
        name: 'My New Flow',
        entryNodeId: 'node-1',
        nodes: [
          { id: 'node-1', kind: 'click', config: { selector: '#btn' } },
          { id: 'node-2', kind: 'delay', config: { ms: 1000 } },
        ],
        edges: [{ id: 'e1', from: 'node-1', to: 'node-2' }],
      };

      const result = (await (server as unknown as { handleRequest: Function }).handleRequest(
        { method: 'rr_v3.saveFlow', params: { flow: flowInput }, requestId: 'req-1' },
        { subscriptions: new Set() },
      )) as FlowV3;

      // Assert: flow saved
      expect(storage.flows.save).toHaveBeenCalledTimes(1);

      // Assert: returned flow has all fields
      expect(result.schemaVersion).toBe(3);
      expect(result.id).toMatch(/^flow_\d+_[a-z0-9]+$/);
      expect(result.name).toBe('My New Flow');
      expect(result.entryNodeId).toBe('node-1');
      expect(result.nodes).toHaveLength(2);
      expect(result.edges).toHaveLength(1);
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });

    it('updates an existing flow', async () => {
      // Setup: add existing flow with a past timestamp
      const existing = createTestFlow('flow-1');
      const pastDate = new Date(Date.now() - 100000).toISOString(); // 100 seconds ago
      existing.createdAt = pastDate;
      existing.updatedAt = pastDate;
      getInternal(storage).flowsMap.set(existing.id, existing);

      const flowInput = {
        id: 'flow-1',
        name: 'Updated Flow',
        entryNodeId: 'node-start',
        nodes: [{ id: 'node-start', kind: 'navigate', config: { url: 'https://example.com' } }],
        edges: [],
        createdAt: existing.createdAt, // Preserve original createdAt
      };

      const result = (await (server as unknown as { handleRequest: Function }).handleRequest(
        { method: 'rr_v3.saveFlow', params: { flow: flowInput }, requestId: 'req-1' },
        { subscriptions: new Set() },
      )) as FlowV3;

      // Assert: flow updated
      expect(result.id).toBe('flow-1');
      expect(result.name).toBe('Updated Flow');
      expect(result.createdAt).toBe(existing.createdAt);
      expect(result.updatedAt).not.toBe(existing.updatedAt);
    });

    it('preserves createdAt when updating without providing it', async () => {
      // Setup: add existing flow with a past timestamp
      const existing = createTestFlow('flow-1');
      const pastDate = new Date(Date.now() - 100000).toISOString();
      existing.createdAt = pastDate;
      existing.updatedAt = pastDate;
      getInternal(storage).flowsMap.set(existing.id, existing);

      // Update without providing createdAt - should inherit from existing
      const flowInput = {
        id: 'flow-1',
        name: 'Updated Without CreatedAt',
        entryNodeId: 'node-start',
        nodes: [{ id: 'node-start', kind: 'test', config: {} }],
        edges: [],
        // Note: createdAt is NOT provided
      };

      const result = (await (server as unknown as { handleRequest: Function }).handleRequest(
        { method: 'rr_v3.saveFlow', params: { flow: flowInput }, requestId: 'req-1' },
        { subscriptions: new Set() },
      )) as FlowV3;

      // Assert: createdAt is inherited from existing flow
      expect(result.createdAt).toBe(existing.createdAt);
      expect(result.updatedAt).not.toBe(existing.updatedAt);
    });

    it('throws if flow is missing', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          { method: 'rr_v3.saveFlow', params: {}, requestId: 'req-1' },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('flow is required');
    });

    it('throws if name is missing', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: 'rr_v3.saveFlow',
            params: {
              flow: {
                entryNodeId: 'node-1',
                nodes: [{ id: 'node-1', kind: 'test', config: {} }],
              },
            },
            requestId: 'req-1',
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('flow.name is required');
    });

    it('throws if entryNodeId is missing', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: 'rr_v3.saveFlow',
            params: {
              flow: {
                name: 'Test',
                nodes: [{ id: 'node-1', kind: 'test', config: {} }],
              },
            },
            requestId: 'req-1',
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('flow.entryNodeId is required');
    });

    it('throws if entryNodeId does not exist in nodes', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: 'rr_v3.saveFlow',
            params: {
              flow: {
                name: 'Test',
                entryNodeId: 'non-existent',
                nodes: [{ id: 'node-1', kind: 'test', config: {} }],
              },
            },
            requestId: 'req-1',
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Entry node "non-existent" does not exist in flow');
    });

    it('throws if edge references non-existent source node', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: 'rr_v3.saveFlow',
            params: {
              flow: {
                name: 'Test',
                entryNodeId: 'node-1',
                nodes: [{ id: 'node-1', kind: 'test', config: {} }],
                edges: [{ id: 'e1', from: 'non-existent', to: 'node-1' }],
              },
            },
            requestId: 'req-1',
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Edge "e1" references non-existent source node "non-existent"');
    });

    it('throws if edge references non-existent target node', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: 'rr_v3.saveFlow',
            params: {
              flow: {
                name: 'Test',
                entryNodeId: 'node-1',
                nodes: [{ id: 'node-1', kind: 'test', config: {} }],
                edges: [{ id: 'e1', from: 'node-1', to: 'non-existent' }],
              },
            },
            requestId: 'req-1',
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Edge "e1" references non-existent target node "non-existent"');
    });

    it('validates node structure', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: 'rr_v3.saveFlow',
            params: {
              flow: {
                name: 'Test',
                entryNodeId: 'node-1',
                nodes: [{ id: 'node-1' }], // missing kind
              },
            },
            requestId: 'req-1',
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('flow.nodes[0].kind is required');
    });

    it('generates edge ID if not provided', async () => {
      const result = (await (server as unknown as { handleRequest: Function }).handleRequest(
        {
          method: 'rr_v3.saveFlow',
          params: {
            flow: {
              name: 'Test',
              entryNodeId: 'node-1',
              nodes: [
                { id: 'node-1', kind: 'test', config: {} },
                { id: 'node-2', kind: 'test', config: {} },
              ],
              edges: [{ from: 'node-1', to: 'node-2' }], // no id
            },
          },
          requestId: 'req-1',
        },
        { subscriptions: new Set() },
      )) as FlowV3;

      expect(result.edges[0].id).toMatch(/^edge_0_[a-z0-9]+$/);
    });

    it('saves flow with optional fields', async () => {
      const result = (await (server as unknown as { handleRequest: Function }).handleRequest(
        {
          method: 'rr_v3.saveFlow',
          params: {
            flow: {
              name: 'Test',
              description: 'A test flow',
              entryNodeId: 'node-1',
              nodes: [
                { id: 'node-1', kind: 'test', config: {}, name: 'Start Node', disabled: false },
              ],
              edges: [],
              // 符合 VariableDefinition 类型：name 必填，description/default/label 可选
              variables: [
                { name: 'url', description: 'Target URL', default: 'https://example.com' },
              ],
              // 符合 FlowPolicy 类型
              policy: { runTimeoutMs: 30000, defaultNodePolicy: { onError: { kind: 'stop' } } },
              meta: { tags: ['test', 'demo'] },
            },
          },
          requestId: 'req-1',
        },
        { subscriptions: new Set() },
      )) as FlowV3;

      expect(result.description).toBe('A test flow');
      expect(result.variables).toHaveLength(1);
      expect(result.policy).toEqual({
        runTimeoutMs: 30000,
        defaultNodePolicy: { onError: { kind: 'stop' } },
      });
      expect(result.meta).toEqual({ tags: ['test', 'demo'] });
      expect(result.nodes[0].name).toBe('Start Node');
    });

    it('throws if variable is missing name', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: 'rr_v3.saveFlow',
            params: {
              flow: {
                name: 'Test',
                entryNodeId: 'node-1',
                nodes: [{ id: 'node-1', kind: 'test', config: {} }],
                variables: [{ description: 'Missing name field' }],
              },
            },
            requestId: 'req-1',
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('flow.variables[0].name is required');
    });

    it('throws if duplicate variable names', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: 'rr_v3.saveFlow',
            params: {
              flow: {
                name: 'Test',
                entryNodeId: 'node-1',
                nodes: [{ id: 'node-1', kind: 'test', config: {} }],
                variables: [
                  { name: 'myVar' },
                  { name: 'myVar' }, // duplicate
                ],
              },
            },
            requestId: 'req-1',
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Duplicate variable name: "myVar"');
    });

    it('throws if duplicate node IDs', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: 'rr_v3.saveFlow',
            params: {
              flow: {
                name: 'Test',
                entryNodeId: 'node-1',
                nodes: [
                  { id: 'node-1', kind: 'test', config: {} },
                  { id: 'node-1', kind: 'test', config: {} }, // duplicate
                ],
              },
            },
            requestId: 'req-1',
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Duplicate node ID: "node-1"');
    });

    it('throws if duplicate edge IDs', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: 'rr_v3.saveFlow',
            params: {
              flow: {
                name: 'Test',
                entryNodeId: 'node-1',
                nodes: [
                  { id: 'node-1', kind: 'test', config: {} },
                  { id: 'node-2', kind: 'test', config: {} },
                ],
                edges: [
                  { id: 'e1', from: 'node-1', to: 'node-2' },
                  { id: 'e1', from: 'node-2', to: 'node-1' }, // duplicate
                ],
              },
            },
            requestId: 'req-1',
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Duplicate edge ID: "e1"');
    });
  });

  describe('rr_v3.deleteFlow', () => {
    it('deletes an existing flow', async () => {
      // Setup: add flow
      const flow = createTestFlow('flow-1');
      getInternal(storage).flowsMap.set(flow.id, flow);

      const result = await (server as unknown as { handleRequest: Function }).handleRequest(
        { method: 'rr_v3.deleteFlow', params: { flowId: 'flow-1' }, requestId: 'req-1' },
        { subscriptions: new Set() },
      );

      expect(storage.flows.delete).toHaveBeenCalledWith('flow-1');
      expect(result).toEqual({ ok: true, flowId: 'flow-1' });
    });

    it('throws if flowId is missing', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          { method: 'rr_v3.deleteFlow', params: {}, requestId: 'req-1' },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('flowId is required');
    });

    it('throws if flow does not exist', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          { method: 'rr_v3.deleteFlow', params: { flowId: 'non-existent' }, requestId: 'req-1' },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Flow "non-existent" not found');
    });

    it('throws if flow has linked triggers', async () => {
      // Setup: add flow and trigger
      const flow = createTestFlow('flow-1');
      getInternal(storage).flowsMap.set(flow.id, flow);

      // Mock triggers.list to return a trigger linked to this flow
      (storage.triggers.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'trigger-1', kind: 'manual', flowId: 'flow-1', enabled: true },
      ]);

      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          { method: 'rr_v3.deleteFlow', params: { flowId: 'flow-1' }, requestId: 'req-1' },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Cannot delete flow "flow-1": it has 1 linked trigger(s): trigger-1');
    });

    it('throws if flow has multiple linked triggers', async () => {
      // Setup
      const flow = createTestFlow('flow-1');
      getInternal(storage).flowsMap.set(flow.id, flow);

      (storage.triggers.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 'trigger-1', kind: 'manual', flowId: 'flow-1', enabled: true },
        { id: 'trigger-2', kind: 'cron', flowId: 'flow-1', enabled: true, cron: '0 * * * *' },
      ]);

      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          { method: 'rr_v3.deleteFlow', params: { flowId: 'flow-1' }, requestId: 'req-1' },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow(
        'Cannot delete flow "flow-1": it has 2 linked trigger(s): trigger-1, trigger-2',
      );
    });

    it('throws if flow has queued runs', async () => {
      // Setup
      const flow = createTestFlow('flow-1');
      getInternal(storage).flowsMap.set(flow.id, flow);

      // Add queued run
      getInternal(storage).queueMap.set('run-1', {
        id: 'run-1',
        flowId: 'flow-1',
        status: 'queued',
        priority: 0,
        createdAt: 1000,
        updatedAt: 1000,
        attempt: 0,
        maxAttempts: 1,
      });

      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          { method: 'rr_v3.deleteFlow', params: { flowId: 'flow-1' }, requestId: 'req-1' },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Cannot delete flow "flow-1": it has 1 queued run(s): run-1');
    });

    it('allows deletion when runs are running (not queued)', async () => {
      // Setup
      const flow = createTestFlow('flow-1');
      getInternal(storage).flowsMap.set(flow.id, flow);

      // Add running run (not queued) - should NOT block deletion
      getInternal(storage).queueMap.set('run-1', {
        id: 'run-1',
        flowId: 'flow-1',
        status: 'running', // running, not queued
        priority: 0,
        createdAt: 1000,
        updatedAt: 1000,
        attempt: 1,
        maxAttempts: 1,
      });

      const result = await (server as unknown as { handleRequest: Function }).handleRequest(
        { method: 'rr_v3.deleteFlow', params: { flowId: 'flow-1' }, requestId: 'req-1' },
        { subscriptions: new Set() },
      );

      expect(result).toEqual({ ok: true, flowId: 'flow-1' });
    });
  });

  describe('rr_v3.getFlow', () => {
    it('returns flow by id', async () => {
      const flow = createTestFlow('flow-1');
      getInternal(storage).flowsMap.set(flow.id, flow);

      const result = await (server as unknown as { handleRequest: Function }).handleRequest(
        { method: 'rr_v3.getFlow', params: { flowId: 'flow-1' }, requestId: 'req-1' },
        { subscriptions: new Set() },
      );

      expect(result).toEqual(flow);
    });

    it('returns null for non-existent flow', async () => {
      const result = await (server as unknown as { handleRequest: Function }).handleRequest(
        { method: 'rr_v3.getFlow', params: { flowId: 'non-existent' }, requestId: 'req-1' },
        { subscriptions: new Set() },
      );

      expect(result).toBeNull();
    });

    it('throws if flowId is missing', async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          { method: 'rr_v3.getFlow', params: {}, requestId: 'req-1' },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('flowId is required');
    });
  });

  describe('rr_v3.listFlows', () => {
    it('returns all flows', async () => {
      const flow1 = createTestFlow('flow-1');
      const flow2 = createTestFlow('flow-2');
      getInternal(storage).flowsMap.set(flow1.id, flow1);
      getInternal(storage).flowsMap.set(flow2.id, flow2);

      const result = (await (server as unknown as { handleRequest: Function }).handleRequest(
        { method: 'rr_v3.listFlows', params: {}, requestId: 'req-1' },
        { subscriptions: new Set() },
      )) as FlowV3[];

      expect(result).toHaveLength(2);
      expect(result.map((f) => f.id).sort()).toEqual(['flow-1', 'flow-2']);
    });

    it('returns empty array when no flows exist', async () => {
      const result = await (server as unknown as { handleRequest: Function }).handleRequest(
        { method: 'rr_v3.listFlows', params: {}, requestId: 'req-1' },
        { subscriptions: new Set() },
      );

      expect(result).toEqual([]);
    });
  });
});
