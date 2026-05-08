/**
 * @fileoverview Record-Replay V3 service-level E2E Integration testing
 * @description
 * Verify the complete V3 process: RPC → enqueue → schedule → run → complete
 *
 * Test using:
 * - Real IndexedDB storage (fake-indexeddb)
 * - service-level RPC（Directly call the internal handler to avoid Port mock)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FlowV3, RunEvent, RunRecordV3 } from '@/entrypoints/background/record-replay-v3';
import {
  FLOW_SCHEMA_VERSION,
  RUN_SCHEMA_VERSION,
  closeRrV3Db,
  deleteRrV3Db,
} from '@/entrypoints/background/record-replay-v3';
import { resetBreakpointRegistry } from '@/entrypoints/background/record-replay-v3/engine/kernel/breakpoints';
import { recoverFromCrash } from '@/entrypoints/background/record-replay-v3/engine/recovery/recovery-coordinator';

import { createV3E2EHarness, type V3E2EHarness, type RpcClient } from './v3-e2e-harness';

// ==================== Test Fixtures ====================

/**
 * Create a test flow
 */
function createTestFlow(
  id: string,
  nodeConfig: { action: 'succeed' | 'fail' } = { action: 'succeed' },
): FlowV3 {
  const iso = new Date(0).toISOString();
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id,
    name: `E2E Flow ${id}`,
    createdAt: iso,
    updatedAt: iso,
    entryNodeId: 'node-1',
    nodes: [{ id: 'node-1', kind: 'test', config: nodeConfig }],
    edges: [],
  };
}

function createThreeNodeFlow(id: string): FlowV3 {
  const iso = new Date(0).toISOString();
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id,
    name: `Segment Flow ${id}`,
    createdAt: iso,
    updatedAt: iso,
    entryNodeId: 'node-1',
    nodes: [
      { id: 'node-1', kind: 'test', config: { action: 'succeed', outputs: { one: true } } },
      { id: 'node-2', kind: 'test', config: { action: 'succeed', outputs: { two: true } } },
      { id: 'node-3', kind: 'test', config: { action: 'succeed', outputs: { three: true } } },
    ],
    edges: [
      { id: 'edge-1', from: 'node-1', to: 'node-2' },
      { id: 'edge-2', from: 'node-2', to: 'node-3' },
    ],
  };
}

/**
 * Create a RunRecord for testing
 */
function createRunRecord(
  runId: string,
  flowId: string,
  status: RunRecordV3['status'],
): RunRecordV3 {
  const t0 = Date.now();
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    id: runId,
    flowId,
    status,
    createdAt: t0,
    updatedAt: t0,
    startedAt: status === 'running' ? t0 : undefined,
    attempt: 0,
    maxAttempts: 1,
    nextSeq: 0,
  };
}

/**
 * Extract list of event types
 */
function eventTypes(events: RunEvent[], runId: string): string[] {
  return events.filter((e) => e.runId === runId).map((e) => e.type);
}

// ==================== E2E Tests ====================

describe('V3 service-level E2E', () => {
  let h: V3E2EHarness;
  let client: RpcClient;

  beforeEach(async () => {
    await deleteRrV3Db();
    closeRrV3Db();
    resetBreakpointRegistry();

    h = createV3E2EHarness();
    client = h.createClient();
  });

  afterEach(async () => {
    await h.dispose();
  });

  describe('Happy path', () => {
    it('enqueueRun → schedule → runner → succeeded', async () => {
      // Prepare to flow
      const flow = createTestFlow('flow-happy');
      await h.storage.flows.save(flow);

      // Enqueue run
      const result = await client.call<{ runId: string; position: number }>('rr_v3.enqueueRun', {
        flowId: flow.id,
      });
      expect(result.runId).toBeDefined();
      expect(result.position).toBeGreaterThanOrEqual(1);

      // wait for completion
      const run = await h.waitForTerminal(result.runId);
      expect(run.status).toBe('succeeded');

      // Waiting for queue item to be removed
      await h.waitForQueueItemGone(result.runId);

      // Verify sequence of events
      const events = await h.listEvents(result.runId);
      const types = eventTypes(events, result.runId);

      expect(types).toContain('run.queued');
      expect(types).toContain('run.started');
      expect(types).toContain('node.queued');
      expect(types).toContain('node.started');
      expect(types).toContain('node.succeeded');
      expect(types).toContain('run.succeeded');

      // Verify sequence of events
      expect(types.indexOf('run.queued')).toBeLessThan(types.indexOf('run.started'));
      expect(types.indexOf('run.started')).toBeLessThan(types.indexOf('run.succeeded'));
    });

    it('failed node leads to run.failed', async () => {
      const flow = createTestFlow('flow-fail', { action: 'fail' });
      await h.storage.flows.save(flow);

      const result = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow.id,
      });

      const run = await h.waitForTerminal(result.runId);
      expect(run.status).toBe('failed');
      expect(run.error).toBeDefined();

      await h.waitForQueueItemGone(result.runId);

      const events = await h.listEvents(result.runId);
      const types = eventTypes(events, result.runId);

      expect(types).toContain('run.failed');
      expect(types).toContain('node.failed');
    });

    it('stopBeforeNodeId stops a segment before executing the boundary node', async () => {
      const flow = createThreeNodeFlow('flow-stop-before');
      await h.storage.flows.save(flow);

      const result = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow.id,
        stopBeforeNodeId: 'node-2',
      });

      const run = await h.waitForTerminal(result.runId);
      expect(run.status).toBe('stopped_at_boundary');
      expect(run.currentNodeId).toBe('node-2');
      expect(run.outputs).toEqual({ one: true });

      await h.waitForQueueItemGone(result.runId);

      const events = await h.listEvents(result.runId);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'run.stopped_at_boundary',
          boundary: { kind: 'stopBeforeNode', nodeId: 'node-2' },
        }),
      );
      expect(events).toContainEqual(expect.objectContaining({ type: 'node.started', nodeId: 'node-1' }));
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: 'node.started', nodeId: 'node-2' }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: 'node.started', nodeId: 'node-3' }),
      );
    });

    it('endNodeId stops a segment after the boundary node succeeds', async () => {
      const flow = createThreeNodeFlow('flow-end-node');
      await h.storage.flows.save(flow);

      const result = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow.id,
        endNodeId: 'node-2',
      });

      const run = await h.waitForTerminal(result.runId);
      expect(run.status).toBe('stopped_at_boundary');
      expect(run.currentNodeId).toBe('node-2');
      expect(run.outputs).toEqual({ one: true, two: true });

      await h.waitForQueueItemGone(result.runId);

      const events = await h.listEvents(result.runId);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'run.stopped_at_boundary',
          boundary: { kind: 'endNode', nodeId: 'node-2' },
        }),
      );
      expect(events).toContainEqual(expect.objectContaining({ type: 'node.started', nodeId: 'node-1' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'node.started', nodeId: 'node-2' }));
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: 'node.started', nodeId: 'node-3' }),
      );
    });
  });

  describe('Event streaming', () => {
    it('subscribe → receive rr_v3.event messages', async () => {
      const flow = createTestFlow('flow-stream');
      await h.storage.flows.save(flow);

      // Subscribe to all Run
      await client.call('rr_v3.subscribe');

      // Join the team
      const { runId } = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow.id,
      });

      await h.waitForTerminal(runId);
      await h.waitForQueueItemGone(runId);

      // Verify streaming events
      const streamed = client.getStreamedEvents().filter((e) => e.runId === runId);
      const streamedTypes = streamed.map((e) => e.type);

      expect(streamedTypes).toContain('run.queued');
      expect(streamedTypes).toContain('run.started');
      expect(streamedTypes).toContain('run.succeeded');
    });

    it('subscribe with runId filter only receives events for that run', async () => {
      const flow1 = createTestFlow('flow-1');
      const flow2 = createTestFlow('flow-2');
      await h.storage.flows.save(flow1);
      await h.storage.flows.save(flow2);

      // Enter the team first run1
      const { runId: runId1 } = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow1.id,
      });
      await h.waitForTerminal(runId1);

      // The subscription only receives events for runId1 (but runId1 has completed)
      await client.call('rr_v3.subscribe', { runId: runId1 });
      client.clearMessages();

      // Enqueue run2
      const { runId: runId2 } = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow2.id,
      });
      await h.waitForTerminal(runId2);

      // Events from run2 should not be received
      const streamedForRun2 = client.getStreamedEvents().filter((e) => e.runId === runId2);
      expect(streamedForRun2).toHaveLength(0);
    });
  });

  describe('Control plane', () => {
    it('pause/resume: pauseRun marks queue paused, resumeRun completes succeeded', async () => {
      const flow = createTestFlow('flow-control');
      await h.storage.flows.save(flow);

      // Enable pauseOnStart when enqueuing
      const { runId } = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow.id,
        debug: { pauseOnStart: true },
      });

      // Wait for run.paused event
      await h.waitForEvent(runId, (e) => e.type === 'run.paused');

      // Pause queue item
      await client.call('rr_v3.pauseRun', { runId });
      const pausedItem = await h.storage.queue.get(runId);
      expect(pausedItem?.status).toBe('paused');

      // restore
      await client.call('rr_v3.resumeRun', { runId });

      // wait for completion
      const run = await h.waitForTerminal(runId);
      expect(run.status).toBe('succeeded');
      await h.waitForQueueItemGone(runId);
    });

    it('cancel: cancelRun transitions run to canceled', async () => {
      const flow = createTestFlow('flow-cancel');
      await h.storage.flows.save(flow);

      const { runId } = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow.id,
        debug: { pauseOnStart: true },
      });

      await h.waitForEvent(runId, (e) => e.type === 'run.paused');

      // Pause the queue item first
      await client.call('rr_v3.pauseRun', { runId });

      // Cancel
      await client.call('rr_v3.cancelRun', { runId, reason: 'E2E cancel test' });

      const run = await h.waitForTerminal(runId);
      expect(run.status).toBe('canceled');
      await h.waitForQueueItemGone(runId);
    });

    it('cancel queued run removes it from queue', async () => {
      // Create a new harness without automatically starting the scheduler
      await h.dispose();
      h = createV3E2EHarness({ autoStartScheduler: false });
      client = h.createClient();

      const flow = createTestFlow('flow-cancel-queued');
      await h.storage.flows.save(flow);

      const { runId } = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow.id,
      });

      // There should be this item in the queue
      let item = await h.storage.queue.get(runId);
      expect(item?.status).toBe('queued');

      // Cancel
      await client.call('rr_v3.cancelRun', { runId });

      // Queue item should be removed (queue.get returns null when not found)
      item = await h.storage.queue.get(runId);
      expect(item).toBeNull();

      // Run The status should be canceled
      const run = await h.storage.runs.get(runId);
      expect(run?.status).toBe('canceled');
    });
  });

  describe('Recovery', () => {
    it('orphan running lease is requeued and run can complete', async () => {
      // Stop the current harness and create a new scheduler without starting it
      await h.dispose();
      h = createV3E2EHarness({ autoStartScheduler: false, ownerId: 'owner-new' });
      client = h.createClient();

      const flow = createTestFlow('flow-recovery');
      await h.storage.flows.save(flow);

      const runId = 'run-orphan';
      await h.storage.runs.save(createRunRecord(runId, flow.id, 'running'));

      // Create orphan queue item (held by old owner)
      await h.storage.queue.enqueue({ id: runId, flowId: flow.id, priority: 0 });
      await h.storage.queue.markRunning(runId, 'owner-old', Date.now());

      // Perform recovery
      const recovery = await recoverFromCrash({
        storage: h.storage,
        events: h.events,
        ownerId: h.ownerId,
        now: () => Date.now(),
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      expect(recovery.requeuedRunning).toContain(runId);

      // The queue item should return to the queued state
      const queueItemAfter = await h.storage.queue.get(runId);
      expect(queueItemAfter?.status).toBe('queued');
      expect(queueItemAfter?.lease).toBeUndefined();

      // There should be a run.recovered event
      const events = await h.listEvents(runId);
      expect(events.some((e) => e.type === 'run.recovered')).toBe(true);

      // Start the scheduler and Run should continue executing.
      h.scheduler.start();

      const run = await h.waitForTerminal(runId);
      expect(run.status).toBe('succeeded');
      await h.waitForQueueItemGone(runId);
    });

    it('adopts orphan paused items', async () => {
      await h.dispose();
      h = createV3E2EHarness({ autoStartScheduler: false, ownerId: 'owner-new' });
      client = h.createClient();

      const flow = createTestFlow('flow-adopt');
      await h.storage.flows.save(flow);

      const runId = 'run-paused-orphan';
      await h.storage.runs.save(createRunRecord(runId, flow.id, 'paused'));

      await h.storage.queue.enqueue({ id: runId, flowId: flow.id, priority: 0 });
      await h.storage.queue.markPaused(runId, 'owner-old', Date.now());

      const recovery = await recoverFromCrash({
        storage: h.storage,
        events: h.events,
        ownerId: h.ownerId,
        now: () => Date.now(),
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      expect(recovery.adoptedPaused).toContain(runId);

      // The queue item should still be paused, but with the new owner
      const queueItem = await h.storage.queue.get(runId);
      expect(queueItem?.status).toBe('paused');
      expect(queueItem?.lease?.ownerId).toBe(h.ownerId);
    });

    it('cleans terminal runs left in queue', async () => {
      await h.dispose();
      h = createV3E2EHarness({ autoStartScheduler: false, ownerId: 'owner-new' });
      client = h.createClient();

      const flow = createTestFlow('flow-clean');
      await h.storage.flows.save(flow);

      const runId = 'run-completed-orphan';
      await h.storage.runs.save(createRunRecord(runId, flow.id, 'succeeded'));

      // Simulated crash scenario: Run completes but queue items are not cleared
      await h.storage.queue.enqueue({ id: runId, flowId: flow.id, priority: 0 });
      await h.storage.queue.markRunning(runId, 'owner-old', Date.now());

      const recovery = await recoverFromCrash({
        storage: h.storage,
        events: h.events,
        ownerId: h.ownerId,
        now: () => Date.now(),
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      expect(recovery.cleanedTerminal).toContain(runId);

      // Queue should be empty
      const remaining = await h.storage.queue.list();
      expect(remaining).toHaveLength(0);
    });
  });

  describe('Query APIs', () => {
    it('getRun returns run record', async () => {
      const flow = createTestFlow('flow-get');
      await h.storage.flows.save(flow);

      const { runId } = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow.id,
      });

      await h.waitForTerminal(runId);

      const run = await client.call<RunRecordV3 | null>('rr_v3.getRun', { runId });
      expect(run).not.toBeNull();
      expect(run?.id).toBe(runId);
      expect(run?.status).toBe('succeeded');
    });

    it('listRuns returns all runs', async () => {
      const flow = createTestFlow('flow-list');
      await h.storage.flows.save(flow);

      const { runId: runId1 } = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow.id,
      });
      await h.waitForTerminal(runId1);

      const { runId: runId2 } = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow.id,
      });
      await h.waitForTerminal(runId2);

      const runs = await client.call<RunRecordV3[]>('rr_v3.listRuns');
      expect(runs.length).toBeGreaterThanOrEqual(2);
      expect(runs.some((r) => r.id === runId1)).toBe(true);
      expect(runs.some((r) => r.id === runId2)).toBe(true);
    });

    it('getEvents returns run events', async () => {
      const flow = createTestFlow('flow-events');
      await h.storage.flows.save(flow);

      const { runId } = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow.id,
      });
      await h.waitForTerminal(runId);

      const events = await client.call<RunEvent[]>('rr_v3.getEvents', { runId });
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === 'run.queued')).toBe(true);
      expect(events.some((e) => e.type === 'run.succeeded')).toBe(true);
    });

    it('listQueue returns queue items', async () => {
      await h.dispose();
      h = createV3E2EHarness({ autoStartScheduler: false });
      client = h.createClient();

      const flow = createTestFlow('flow-queue');
      await h.storage.flows.save(flow);

      await client.call('rr_v3.enqueueRun', { flowId: flow.id });
      await client.call('rr_v3.enqueueRun', { flowId: flow.id });

      const queue = await client.call<unknown[]>('rr_v3.listQueue');
      expect(queue.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Error handling', () => {
    it('enqueueRun with non-existent flow throws error', async () => {
      await expect(
        client.call('rr_v3.enqueueRun', { flowId: 'non-existent-flow' }),
      ).rejects.toThrow();
    });

    it('getRun with non-existent runId returns null', async () => {
      const run = await client.call<RunRecordV3 | null>('rr_v3.getRun', {
        runId: 'non-existent-run',
      });
      expect(run).toBeNull();
    });

    it('pauseRun with invalid runId throws error', async () => {
      await expect(client.call('rr_v3.pauseRun', { runId: 'invalid-run' })).rejects.toThrow();
    });
  });
});
