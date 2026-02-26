/**
 * @fileoverview Record-Replay V3 RunRunner onError Contracts
 * @description Verifies RunRunner onError behavior via event stream + final Run status.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type {
  EdgeV3,
  FlowV3,
  NodeV3,
  RunEvent,
  RunRecordV3,
  RunRunner,
  NodeDefinition,
  NodeExecutionResult,
} from '@/entrypoints/background/record-replay-v3';

import {
  EDGE_LABELS,
  FLOW_SCHEMA_VERSION,
  InMemoryEventsBus,
  PluginRegistry,
  RR_ERROR_CODES,
  createNotImplementedStoragePort,
  createRRError,
  createRunRunnerFactory,
  resetBreakpointRegistry,
} from '@/entrypoints/background/record-replay-v3';

import type {
  RunId,
  PersistentVarRecord,
  PersistentVarsStore,
  RunsStore,
} from '@/entrypoints/background/record-replay-v3';

// ==================== Test Helpers ====================

type TestNodeConfig = {
  action: 'succeed' | 'fail' | 'flaky';
  failTimes?: number;
  errorCode?: string;
};

/**
 * Create a test node definition that can succeed, fail, or be flaky
 */
function createTestNodeDefinition(
  callsByNodeId: Map<string, number>,
): NodeDefinition<'test', TestNodeConfig> {
  return {
    kind: 'test',
    schema: z
      .object({
        action: z.enum(['succeed', 'fail', 'flaky']),
        failTimes: z.number().int().min(0).optional(),
        errorCode: z.string().optional(),
      })
      .passthrough(),
    execute: async (ctx, node): Promise<NodeExecutionResult> => {
      const prev = callsByNodeId.get(ctx.nodeId) ?? 0;
      const cur = prev + 1;
      callsByNodeId.set(ctx.nodeId, cur);

      const cfg = node.config as unknown as TestNodeConfig;
      const error = createRRError(
        (cfg.errorCode ?? RR_ERROR_CODES.TOOL_ERROR) as typeof RR_ERROR_CODES.TOOL_ERROR,
        `test failure (${ctx.nodeId})`,
      );

      if (cfg.action === 'succeed') return { status: 'succeeded' };
      if (cfg.action === 'fail') return { status: 'failed', error };

      // flaky: fail for the first `failTimes` calls
      const failTimes = Math.max(0, cfg.failTimes ?? 0);
      if (cur <= failTimes) return { status: 'failed', error };
      return { status: 'succeeded' };
    },
  };
}

/**
 * Create a test flow
 */
function createFlow(entryNodeId: string, nodes: NodeV3[], edges: EdgeV3[]): FlowV3 {
  const iso = new Date(0).toISOString();
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id: 'flow-onerror',
    name: 'onError contract flow',
    createdAt: iso,
    updatedAt: iso,
    entryNodeId,
    nodes,
    edges,
  };
}

/**
 * Create an in-memory RunsStore for testing
 */
function createInMemoryRunsStore(): { store: RunsStore; byId: Map<RunId, RunRecordV3> } {
  const byId = new Map<RunId, RunRecordV3>();
  const store: RunsStore = {
    list: async () => Array.from(byId.values()),
    get: async (id) => byId.get(id) ?? null,
    save: async (record) => {
      byId.set(record.id, record);
    },
    patch: async (id, patch) => {
      const existing = byId.get(id);
      if (!existing) {
        throw createRRError(RR_ERROR_CODES.INTERNAL, `Run "${id}" not found`);
      }
      byId.set(id, {
        ...existing,
        ...patch,
        id: existing.id,
        schemaVersion: existing.schemaVersion,
        updatedAt: Date.now(),
      });
    },
  };
  return { store, byId };
}

/**
 * Create an in-memory PersistentVarsStore for testing
 */
function createInMemoryPersistentVarsStore(): PersistentVarsStore {
  const byKey = new Map<string, PersistentVarRecord>();
  return {
    get: async (key) => byKey.get(key as string) as PersistentVarRecord | undefined,
    set: async (key, value) => {
      const prev = byKey.get(key as string);
      const record: PersistentVarRecord = {
        key,
        value,
        updatedAt: Date.now(),
        version: (prev?.version ?? 0) + 1,
      };
      byKey.set(key as string, record);
      return record;
    },
    delete: async (key) => {
      byKey.delete(key as string);
    },
    list: async (prefix) => {
      const all = Array.from(byKey.values());
      if (!prefix) return all;
      return all.filter((r) => r.key.startsWith(prefix));
    },
  };
}

/**
 * Extract node IDs from node.started events
 */
function startedNodeIds(events: RunEvent[]): string[] {
  return events
    .filter((e) => e.type === 'node.started')
    .map((e) => (e as Extract<RunEvent, { type: 'node.started' }>).nodeId);
}

/**
 * Extract node.failed events for a specific node
 */
function nodeFailedEvents(
  events: RunEvent[],
  nodeId: string,
): Array<Extract<RunEvent, { type: 'node.failed' }>> {
  return events.filter(
    (e): e is Extract<RunEvent, { type: 'node.failed' }> =>
      e.type === 'node.failed' && e.nodeId === nodeId,
  );
}

/**
 * List events from InMemoryEventsBus
 */
async function listEvents(bus: InMemoryEventsBus, runId: RunId): Promise<RunEvent[]> {
  return bus.list({ runId });
}

/**
 * Create a complete runner context for testing
 */
function createRunnerContext(
  runId: RunId,
  flow: FlowV3,
): {
  runner: RunRunner;
  bus: InMemoryEventsBus;
  runsById: Map<RunId, RunRecordV3>;
  calls: Map<string, number>;
} {
  const calls = new Map<string, number>();
  const plugins = new PluginRegistry();
  plugins.registerNode(createTestNodeDefinition(calls));

  const bus = new InMemoryEventsBus();
  const { store: runs, byId: runsById } = createInMemoryRunsStore();

  const storage = createNotImplementedStoragePort();
  storage.runs = runs;
  storage.persistentVars = createInMemoryPersistentVarsStore();

  const factory = createRunRunnerFactory({ storage, events: bus, plugins });
  const runner = factory.create(runId, { flow, tabId: 1 });

  return { runner, bus, runsById, calls };
}

// ==================== Tests ====================

describe('V3 RunRunner onError contracts', () => {
  beforeEach(() => {
    resetBreakpointRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stop: node failure ends run as failed', async () => {
    const runId = 'run-stop';
    const flow = createFlow(
      'A',
      [
        {
          id: 'A',
          kind: 'test',
          config: { action: 'fail' },
          policy: { onError: { kind: 'stop' } },
        },
        { id: 'B', kind: 'test', config: { action: 'succeed' } },
      ],
      [{ id: 'e1', from: 'A', to: 'B', label: EDGE_LABELS.DEFAULT }],
    );

    const { runner, bus, runsById } = createRunnerContext(runId, flow);
    const result = await runner.start();
    expect(result.status).toBe('failed');
    expect(runsById.get(runId)?.status).toBe('failed');

    const events = await listEvents(bus, runId);
    expect(nodeFailedEvents(events, 'A')[0].decision).toBe('stop');
    expect(startedNodeIds(events)).toEqual(['A']);
  });

  it('continue: node failure continues to next node', async () => {
    const runId = 'run-continue';
    const flow = createFlow(
      'A',
      [
        {
          id: 'A',
          kind: 'test',
          config: { action: 'fail' },
          policy: { onError: { kind: 'continue' } },
        },
        { id: 'B', kind: 'test', config: { action: 'succeed' } },
      ],
      [{ id: 'e1', from: 'A', to: 'B', label: EDGE_LABELS.DEFAULT }],
    );

    const { runner, bus, runsById } = createRunnerContext(runId, flow);
    const result = await runner.start();
    expect(result.status).toBe('succeeded');
    expect(runsById.get(runId)?.status).toBe('succeeded');

    const events = await listEvents(bus, runId);
    expect(nodeFailedEvents(events, 'A')[0].decision).toBe('continue');
    expect(startedNodeIds(events)).toEqual(['A', 'B']);
  });

  it('goto edgeLabel: node failure jumps to ON_ERROR edge target', async () => {
    const runId = 'run-goto-edge';
    const flow = createFlow(
      'A',
      [
        {
          id: 'A',
          kind: 'test',
          config: { action: 'fail' },
          policy: {
            onError: { kind: 'goto', target: { kind: 'edgeLabel', label: EDGE_LABELS.ON_ERROR } },
          },
        },
        { id: 'B', kind: 'test', config: { action: 'succeed' } },
        { id: 'C', kind: 'test', config: { action: 'succeed' } },
      ],
      [
        { id: 'e1', from: 'A', to: 'B', label: EDGE_LABELS.DEFAULT },
        { id: 'e2', from: 'A', to: 'C', label: EDGE_LABELS.ON_ERROR },
      ],
    );

    const { runner, bus, runsById } = createRunnerContext(runId, flow);
    const result = await runner.start();
    expect(result.status).toBe('succeeded');
    expect(runsById.get(runId)?.status).toBe('succeeded');

    const events = await listEvents(bus, runId);
    expect(nodeFailedEvents(events, 'A')[0].decision).toBe('goto');
    expect(startedNodeIds(events)).toEqual(['A', 'C']);
  });

  it('goto nodeId: node failure jumps to specified node', async () => {
    const runId = 'run-goto-node';
    const flow = createFlow(
      'A',
      [
        {
          id: 'A',
          kind: 'test',
          config: { action: 'fail' },
          policy: { onError: { kind: 'goto', target: { kind: 'node', nodeId: 'C' } } },
        },
        { id: 'B', kind: 'test', config: { action: 'succeed' } },
        { id: 'C', kind: 'test', config: { action: 'succeed' } },
      ],
      [{ id: 'e1', from: 'A', to: 'B', label: EDGE_LABELS.DEFAULT }],
    );

    const { runner, bus, runsById } = createRunnerContext(runId, flow);
    const result = await runner.start();
    expect(result.status).toBe('succeeded');
    expect(runsById.get(runId)?.status).toBe('succeeded');

    const events = await listEvents(bus, runId);
    expect(nodeFailedEvents(events, 'A')[0].decision).toBe('goto');
    expect(startedNodeIds(events)).toEqual(['A', 'C']);
  });

  it('retry: retries the configured number of times and can succeed', async () => {
    const runId = 'run-retry-succeed';
    const flow = createFlow(
      'A',
      [
        {
          id: 'A',
          kind: 'test',
          config: { action: 'flaky', failTimes: 2 },
          policy: { onError: { kind: 'retry' }, retry: { retries: 2, intervalMs: 0 } },
        },
      ],
      [],
    );

    const { runner, bus, runsById } = createRunnerContext(runId, flow);
    const result = await runner.start();
    expect(result.status).toBe('succeeded');
    expect(runsById.get(runId)?.status).toBe('succeeded');

    const events = await listEvents(bus, runId);
    const started = events.filter((e) => e.type === 'node.started') as Array<
      Extract<RunEvent, { type: 'node.started' }>
    >;
    expect(started.map((e) => e.attempt)).toEqual([1, 2, 3]);

    const failed = nodeFailedEvents(events, 'A');
    expect(failed.map((e) => e.decision)).toEqual(['retry', 'retry']);
  });

  it('retry: uses backoff and fails after retries are exhausted', async () => {
    const runId = 'run-retry-fail';
    const flow = createFlow(
      'A',
      [
        {
          id: 'A',
          kind: 'test',
          config: { action: 'fail' },
          policy: {
            onError: { kind: 'retry' },
            retry: { retries: 2, intervalMs: 100, backoff: 'linear' },
          },
        },
      ],
      [],
    );

    const { runner, bus, runsById } = createRunnerContext(runId, flow);

    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const startPromise = runner.start();
    await vi.runAllTimersAsync();
    const result = await startPromise;

    expect(result.status).toBe('failed');
    expect(runsById.get(runId)?.status).toBe('failed');

    const delays = setTimeoutSpy.mock.calls
      .map((call) => call[1])
      .filter((ms): ms is number => typeof ms === 'number' && ms > 0);
    // Linear backoff: 100, 200
    expect(delays).toContain(100);
    expect(delays).toContain(200);

    const events = await listEvents(bus, runId);
    const started = events.filter((e) => e.type === 'node.started') as Array<
      Extract<RunEvent, { type: 'node.started' }>
    >;
    expect(started.map((e) => e.attempt)).toEqual([1, 2, 3]);

    const failed = nodeFailedEvents(events, 'A');
    expect(failed).toHaveLength(3);
    // Last retry should still be 'retry' as that's the decision made before checking max attempts
    expect(failed.map((e) => e.decision)).toEqual(['retry', 'retry', 'retry']);
  });

  it('default: without onError policy, uses ON_ERROR edge when present', async () => {
    const runId = 'run-default-goto';
    const flow = createFlow(
      'A',
      [
        { id: 'A', kind: 'test', config: { action: 'fail' } },
        { id: 'B', kind: 'test', config: { action: 'succeed' } },
        { id: 'C', kind: 'test', config: { action: 'succeed' } },
      ],
      [
        { id: 'e1', from: 'A', to: 'B', label: EDGE_LABELS.DEFAULT },
        { id: 'e2', from: 'A', to: 'C', label: EDGE_LABELS.ON_ERROR },
      ],
    );

    const { runner, bus, runsById } = createRunnerContext(runId, flow);
    const result = await runner.start();
    expect(result.status).toBe('succeeded');
    expect(runsById.get(runId)?.status).toBe('succeeded');

    const events = await listEvents(bus, runId);
    expect(nodeFailedEvents(events, 'A')[0].decision).toBe('goto');
    expect(startedNodeIds(events)).toEqual(['A', 'C']);
  });

  it('default: without onError policy and without ON_ERROR edge, stops', async () => {
    const runId = 'run-default-stop';
    const flow = createFlow(
      'A',
      [
        { id: 'A', kind: 'test', config: { action: 'fail' } },
        { id: 'B', kind: 'test', config: { action: 'succeed' } },
      ],
      [{ id: 'e1', from: 'A', to: 'B', label: EDGE_LABELS.DEFAULT }],
    );

    const { runner, bus, runsById } = createRunnerContext(runId, flow);
    const result = await runner.start();
    expect(result.status).toBe('failed');
    expect(runsById.get(runId)?.status).toBe('failed');

    const events = await listEvents(bus, runId);
    expect(nodeFailedEvents(events, 'A')[0].decision).toBe('stop');
    expect(startedNodeIds(events)).toEqual(['A']);
  });
});
