/**
 * @fileoverview Record-Replay V3 service-level E2E 集成测试
 * @description
 * 验证完整的 V3 流程：RPC → enqueue → schedule → run → complete
 *
 * 测试使用：
 * - 真实 IndexedDB 存储（fake-indexeddb）
 * - service-level RPC（直接调用内部 handler，避免 Port mock）
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FlowV3, RunEvent, RunRecordV3 } from '@/entrypoints/background/record-replay-v3';
import {
  FLOW_SCHEMA_VERSION,
  RUN_SCHEMA_VERSION,
  closeRrV3Db,
  deleteRrV3Db,
  resetBreakpointRegistry,
  recoverFromCrash,
} from '@/entrypoints/background/record-replay-v3';

import { createV3E2EHarness, type V3E2EHarness, type RpcClient } from './v3-e2e-harness';

// ==================== Test Fixtures ====================

/**
 * 创建测试用 Flow
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

/**
 * 创建测试用 RunRecord
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
 * 提取事件类型列表
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
      // 准备 Flow
      const flow = createTestFlow('flow-happy');
      await h.storage.flows.save(flow);

      // Enqueue run
      const result = await client.call<{ runId: string; position: number }>('rr_v3.enqueueRun', {
        flowId: flow.id,
      });
      expect(result.runId).toBeDefined();
      expect(result.position).toBeGreaterThanOrEqual(1);

      // 等待完成
      const run = await h.waitForTerminal(result.runId);
      expect(run.status).toBe('succeeded');

      // 等待队列项被移除
      await h.waitForQueueItemGone(result.runId);

      // 验证事件序列
      const events = await h.listEvents(result.runId);
      const types = eventTypes(events, result.runId);

      expect(types).toContain('run.queued');
      expect(types).toContain('run.started');
      expect(types).toContain('node.queued');
      expect(types).toContain('node.started');
      expect(types).toContain('node.succeeded');
      expect(types).toContain('run.succeeded');

      // 验证事件顺序
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
  });

  describe('Event streaming', () => {
    it('subscribe → receive rr_v3.event messages', async () => {
      const flow = createTestFlow('flow-stream');
      await h.storage.flows.save(flow);

      // 订阅所有 Run
      await client.call('rr_v3.subscribe');

      // 入队
      const { runId } = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow.id,
      });

      await h.waitForTerminal(runId);
      await h.waitForQueueItemGone(runId);

      // 验证流式推送的事件
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

      // 先入队 run1
      const { runId: runId1 } = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow1.id,
      });
      await h.waitForTerminal(runId1);

      // 订阅只接收 runId1 的事件（但 runId1 已完成）
      await client.call('rr_v3.subscribe', { runId: runId1 });
      client.clearMessages();

      // 入队 run2
      const { runId: runId2 } = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow2.id,
      });
      await h.waitForTerminal(runId2);

      // 应该不收到 run2 的事件
      const streamedForRun2 = client.getStreamedEvents().filter((e) => e.runId === runId2);
      expect(streamedForRun2).toHaveLength(0);
    });
  });

  describe('Control plane', () => {
    it('pause/resume: pauseRun marks queue paused, resumeRun completes succeeded', async () => {
      const flow = createTestFlow('flow-control');
      await h.storage.flows.save(flow);

      // 入队时启用 pauseOnStart
      const { runId } = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow.id,
        debug: { pauseOnStart: true },
      });

      // 等待 run.paused 事件
      await h.waitForEvent(runId, (e) => e.type === 'run.paused');

      // 暂停 queue item
      await client.call('rr_v3.pauseRun', { runId });
      const pausedItem = await h.storage.queue.get(runId);
      expect(pausedItem?.status).toBe('paused');

      // 恢复
      await client.call('rr_v3.resumeRun', { runId });

      // 等待完成
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

      // 先暂停 queue item
      await client.call('rr_v3.pauseRun', { runId });

      // 取消
      await client.call('rr_v3.cancelRun', { runId, reason: 'E2E cancel test' });

      const run = await h.waitForTerminal(runId);
      expect(run.status).toBe('canceled');
      await h.waitForQueueItemGone(runId);
    });

    it('cancel queued run removes it from queue', async () => {
      // 创建一个新的 harness，不自动启动 scheduler
      await h.dispose();
      h = createV3E2EHarness({ autoStartScheduler: false });
      client = h.createClient();

      const flow = createTestFlow('flow-cancel-queued');
      await h.storage.flows.save(flow);

      const { runId } = await client.call<{ runId: string }>('rr_v3.enqueueRun', {
        flowId: flow.id,
      });

      // 队列中应该有这个 item
      let item = await h.storage.queue.get(runId);
      expect(item?.status).toBe('queued');

      // 取消
      await client.call('rr_v3.cancelRun', { runId });

      // Queue item should be removed (queue.get returns null when not found)
      item = await h.storage.queue.get(runId);
      expect(item).toBeNull();

      // Run 状态应该是 canceled
      const run = await h.storage.runs.get(runId);
      expect(run?.status).toBe('canceled');
    });
  });

  describe('Recovery', () => {
    it('orphan running lease is requeued and run can complete', async () => {
      // 停止当前 harness，创建新的不启动 scheduler
      await h.dispose();
      h = createV3E2EHarness({ autoStartScheduler: false, ownerId: 'owner-new' });
      client = h.createClient();

      const flow = createTestFlow('flow-recovery');
      await h.storage.flows.save(flow);

      const runId = 'run-orphan';
      await h.storage.runs.save(createRunRecord(runId, flow.id, 'running'));

      // 创建 orphan 队列项（旧 owner 持有）
      await h.storage.queue.enqueue({ id: runId, flowId: flow.id, priority: 0 });
      await h.storage.queue.markRunning(runId, 'owner-old', Date.now());

      // 执行恢复
      const recovery = await recoverFromCrash({
        storage: h.storage,
        events: h.events,
        ownerId: h.ownerId,
        now: () => Date.now(),
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });

      expect(recovery.requeuedRunning).toContain(runId);

      // 队列项应该回到 queued 状态
      const queueItemAfter = await h.storage.queue.get(runId);
      expect(queueItemAfter?.status).toBe('queued');
      expect(queueItemAfter?.lease).toBeUndefined();

      // 应该有 run.recovered 事件
      const events = await h.listEvents(runId);
      expect(events.some((e) => e.type === 'run.recovered')).toBe(true);

      // 启动 scheduler，Run 应该能继续执行
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

      // 队列项应该仍是 paused，但 owner 换成新的
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

      // 模拟崩溃场景：Run 完成但队列项未清理
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

      // 队列应该为空
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
