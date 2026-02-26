/**
 * @fileoverview Record-Replay V3 Debugger Contracts
 * @description Verifies DebugController behavior via command handling + state changes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type {
  EdgeV3,
  FlowV3,
  NodeV3,
  RunEvent,
  RunRecordV3,
  NodeDefinition,
  NodeExecutionResult,
  DebuggerState,
} from '@/entrypoints/background/record-replay-v3';

import {
  EDGE_LABELS,
  FLOW_SCHEMA_VERSION,
  RUN_SCHEMA_VERSION,
  InMemoryEventsBus,
  PluginRegistry,
  RR_ERROR_CODES,
  createNotImplementedStoragePort,
  createRRError,
  createRunRunnerFactory,
  resetBreakpointRegistry,
  DebugController,
  createRunnerRegistry,
} from '@/entrypoints/background/record-replay-v3';

import type {
  RunId,
  PersistentVarRecord,
  PersistentVarsStore,
  RunsStore,
  FlowsStore,
} from '@/entrypoints/background/record-replay-v3';

// ==================== Test Helpers ====================

type TestNodeConfig = {
  action: 'succeed' | 'fail' | 'slow';
  delayMs?: number;
};

function createTestNodeDefinition(
  callsByNodeId: Map<string, number>,
  resolvers: Map<string, () => void>,
): NodeDefinition<'test', TestNodeConfig> {
  return {
    kind: 'test',
    schema: z
      .object({
        action: z.enum(['succeed', 'fail', 'slow']),
        delayMs: z.number().optional(),
      })
      .passthrough(),
    execute: async (ctx, node): Promise<NodeExecutionResult> => {
      const prev = callsByNodeId.get(ctx.nodeId) ?? 0;
      callsByNodeId.set(ctx.nodeId, prev + 1);

      const cfg = node.config as unknown as TestNodeConfig;

      if (cfg.action === 'slow') {
        // Wait for external resolution
        await new Promise<void>((resolve) => {
          resolvers.set(ctx.nodeId, resolve);
        });
      }

      if (cfg.action === 'fail') {
        return {
          status: 'failed',
          error: createRRError(RR_ERROR_CODES.TOOL_ERROR, `test failure (${ctx.nodeId})`),
        };
      }

      return { status: 'succeeded' };
    },
  };
}

function createFlow(entryNodeId: string, nodes: NodeV3[], edges: EdgeV3[]): FlowV3 {
  const iso = new Date(0).toISOString();
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id: 'flow-debug',
    name: 'debug contract flow',
    createdAt: iso,
    updatedAt: iso,
    entryNodeId,
    nodes,
    edges,
  };
}

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

function createInMemoryFlowsStore(): { store: FlowsStore; byId: Map<string, FlowV3> } {
  const byId = new Map<string, FlowV3>();
  const store: FlowsStore = {
    list: async () => Array.from(byId.values()),
    get: async (id) => byId.get(id) ?? null,
    save: async (flow) => {
      byId.set(flow.id, flow);
    },
    delete: async (id) => {
      byId.delete(id);
    },
  };
  return { store, byId };
}

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

// ==================== Tests ====================

describe('V3 Debugger contracts', () => {
  beforeEach(() => {
    resetBreakpointRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('attach/detach', () => {
    it('attach returns state with attached status', async () => {
      const bus = new InMemoryEventsBus();
      const { store: runs, byId: runsById } = createInMemoryRunsStore();
      const { store: flows, byId: flowsById } = createInMemoryFlowsStore();

      const flow = createFlow('A', [{ id: 'A', kind: 'test', config: { action: 'succeed' } }], []);
      flowsById.set(flow.id, flow);

      // Create a run record
      const runId = 'run-attach';
      runsById.set(runId, {
        schemaVersion: RUN_SCHEMA_VERSION,
        id: runId,
        flowId: flow.id,
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempt: 0,
        maxAttempts: 1,
        nextSeq: 1,
      });

      const storage = createNotImplementedStoragePort();
      storage.runs = runs;
      storage.flows = flows;
      storage.persistentVars = createInMemoryPersistentVarsStore();

      const runners = createRunnerRegistry();
      const controller = new DebugController({ storage, events: bus, runners });
      controller.start();

      const response = await controller.handle({ type: 'debug.attach', runId });
      expect(response.ok).toBe(true);
      if (response.ok && response.state) {
        expect(response.state.status).toBe('attached');
        expect(response.state.runId).toBe(runId);
      }

      controller.stop();
    });

    it('detach returns state with detached status', async () => {
      const bus = new InMemoryEventsBus();
      const { store: runs, byId: runsById } = createInMemoryRunsStore();

      const runId = 'run-detach';
      runsById.set(runId, {
        schemaVersion: RUN_SCHEMA_VERSION,
        id: runId,
        flowId: 'flow-1',
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempt: 0,
        maxAttempts: 1,
        nextSeq: 1,
      });

      const storage = createNotImplementedStoragePort();
      storage.runs = runs;

      const runners = createRunnerRegistry();
      const controller = new DebugController({ storage, events: bus, runners });
      controller.start();

      // First attach
      await controller.handle({ type: 'debug.attach', runId });

      // Then detach
      const response = await controller.handle({ type: 'debug.detach', runId });
      expect(response.ok).toBe(true);
      if (response.ok && response.state) {
        expect(response.state.status).toBe('detached');
      }

      controller.stop();
    });
  });

  describe('breakpoints', () => {
    it('setBreakpoints updates breakpoint list', async () => {
      const bus = new InMemoryEventsBus();
      const { store: runs, byId: runsById } = createInMemoryRunsStore();

      const runId = 'run-bp';
      runsById.set(runId, {
        schemaVersion: RUN_SCHEMA_VERSION,
        id: runId,
        flowId: 'flow-1',
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempt: 0,
        maxAttempts: 1,
        nextSeq: 1,
      });

      const storage = createNotImplementedStoragePort();
      storage.runs = runs;

      const runners = createRunnerRegistry();
      const controller = new DebugController({ storage, events: bus, runners });
      controller.start();

      await controller.handle({ type: 'debug.attach', runId });

      const response = await controller.handle({
        type: 'debug.setBreakpoints',
        runId,
        nodeIds: ['A', 'B', 'C'],
      });

      expect(response.ok).toBe(true);
      if (response.ok && response.state) {
        expect(response.state.breakpoints.map((bp) => bp.nodeId)).toEqual(['A', 'B', 'C']);
      }

      controller.stop();
    });

    it('addBreakpoint adds to existing list', async () => {
      const bus = new InMemoryEventsBus();
      const { store: runs, byId: runsById } = createInMemoryRunsStore();

      const runId = 'run-bp-add';
      runsById.set(runId, {
        schemaVersion: RUN_SCHEMA_VERSION,
        id: runId,
        flowId: 'flow-1',
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempt: 0,
        maxAttempts: 1,
        nextSeq: 1,
      });

      const storage = createNotImplementedStoragePort();
      storage.runs = runs;

      const runners = createRunnerRegistry();
      const controller = new DebugController({ storage, events: bus, runners });
      controller.start();

      await controller.handle({ type: 'debug.setBreakpoints', runId, nodeIds: ['A'] });
      const response = await controller.handle({ type: 'debug.addBreakpoint', runId, nodeId: 'B' });

      expect(response.ok).toBe(true);
      if (response.ok && response.state) {
        expect(response.state.breakpoints.map((bp) => bp.nodeId)).toContain('A');
        expect(response.state.breakpoints.map((bp) => bp.nodeId)).toContain('B');
      }

      controller.stop();
    });

    it('removeBreakpoint removes from list', async () => {
      const bus = new InMemoryEventsBus();
      const { store: runs, byId: runsById } = createInMemoryRunsStore();

      const runId = 'run-bp-remove';
      runsById.set(runId, {
        schemaVersion: RUN_SCHEMA_VERSION,
        id: runId,
        flowId: 'flow-1',
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempt: 0,
        maxAttempts: 1,
        nextSeq: 1,
      });

      const storage = createNotImplementedStoragePort();
      storage.runs = runs;

      const runners = createRunnerRegistry();
      const controller = new DebugController({ storage, events: bus, runners });
      controller.start();

      await controller.handle({ type: 'debug.setBreakpoints', runId, nodeIds: ['A', 'B'] });
      const response = await controller.handle({
        type: 'debug.removeBreakpoint',
        runId,
        nodeId: 'A',
      });

      expect(response.ok).toBe(true);
      if (response.ok && response.state) {
        expect(response.state.breakpoints.map((bp) => bp.nodeId)).toEqual(['B']);
      }

      controller.stop();
    });
  });

  describe('getState', () => {
    it('returns current debug state', async () => {
      const bus = new InMemoryEventsBus();
      const { store: runs, byId: runsById } = createInMemoryRunsStore();

      const runId = 'run-getstate';
      runsById.set(runId, {
        schemaVersion: RUN_SCHEMA_VERSION,
        id: runId,
        flowId: 'flow-1',
        status: 'paused',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        currentNodeId: 'A',
        attempt: 0,
        maxAttempts: 1,
        nextSeq: 1,
      });

      const storage = createNotImplementedStoragePort();
      storage.runs = runs;

      const runners = createRunnerRegistry();
      const controller = new DebugController({ storage, events: bus, runners });
      controller.start();

      const response = await controller.handle({ type: 'debug.getState', runId });

      expect(response.ok).toBe(true);
      if (response.ok && response.state) {
        expect(response.state.runId).toBe(runId);
        expect(response.state.execution).toBe('paused');
        expect(response.state.currentNodeId).toBe('A');
      }

      controller.stop();
    });
  });

  describe('variables', () => {
    it('getVar returns variable value from active runner', async () => {
      const calls = new Map<string, number>();
      const resolvers = new Map<string, () => void>();
      const plugins = new PluginRegistry();
      plugins.registerNode(createTestNodeDefinition(calls, resolvers));

      const bus = new InMemoryEventsBus();
      const { store: runs, byId: runsById } = createInMemoryRunsStore();
      const { store: flows, byId: flowsById } = createInMemoryFlowsStore();

      const flow = createFlow('A', [{ id: 'A', kind: 'test', config: { action: 'slow' } }], []);
      flowsById.set(flow.id, flow);

      const storage = createNotImplementedStoragePort();
      storage.runs = runs;
      storage.flows = flows;
      storage.persistentVars = createInMemoryPersistentVarsStore();

      const runners = createRunnerRegistry();
      const factory = createRunRunnerFactory({ storage, events: bus, plugins });

      const runId = 'run-getvar';
      const runner = factory.create(runId, { flow, tabId: 1, args: { myVar: 'hello' } });
      runners.register(runId, runner);

      const controller = new DebugController({ storage, events: bus, runners });
      controller.start();

      // Start the runner (it will wait on node A)
      const startPromise = runner.start();

      // Wait a bit for the runner to start
      await new Promise((r) => setTimeout(r, 10));

      // Get variable
      const response = await controller.handle({ type: 'debug.getVar', runId, name: 'myVar' });

      expect(response.ok).toBe(true);
      if (response.ok) {
        expect(response.value).toBe('hello');
      }

      // Clean up - resolve the slow node
      resolvers.get('A')?.();
      await startPromise;

      controller.stop();
    });

    it('setVar updates variable in active runner', async () => {
      const calls = new Map<string, number>();
      const resolvers = new Map<string, () => void>();
      const plugins = new PluginRegistry();
      plugins.registerNode(createTestNodeDefinition(calls, resolvers));

      const bus = new InMemoryEventsBus();
      const { store: runs } = createInMemoryRunsStore();
      const { store: flows, byId: flowsById } = createInMemoryFlowsStore();

      const flow = createFlow('A', [{ id: 'A', kind: 'test', config: { action: 'slow' } }], []);
      flowsById.set(flow.id, flow);

      const storage = createNotImplementedStoragePort();
      storage.runs = runs;
      storage.flows = flows;
      storage.persistentVars = createInMemoryPersistentVarsStore();

      const runners = createRunnerRegistry();
      const factory = createRunRunnerFactory({ storage, events: bus, plugins });

      const runId = 'run-setvar';
      const runner = factory.create(runId, { flow, tabId: 1 });
      runners.register(runId, runner);

      const controller = new DebugController({ storage, events: bus, runners });
      controller.start();

      // Start the runner
      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 10));

      // Set variable
      const setResponse = await controller.handle({
        type: 'debug.setVar',
        runId,
        name: 'newVar',
        value: 42,
      });
      expect(setResponse.ok).toBe(true);

      // Get variable back
      const getResponse = await controller.handle({ type: 'debug.getVar', runId, name: 'newVar' });
      expect(getResponse.ok).toBe(true);
      if (getResponse.ok) {
        expect(getResponse.value).toBe(42);
      }

      // Clean up
      resolvers.get('A')?.();
      await startPromise;

      controller.stop();
    });
  });

  describe('state subscription', () => {
    it('subscribe receives state changes', async () => {
      const bus = new InMemoryEventsBus();
      const { store: runs, byId: runsById } = createInMemoryRunsStore();

      const runId = 'run-subscribe';
      runsById.set(runId, {
        schemaVersion: RUN_SCHEMA_VERSION,
        id: runId,
        flowId: 'flow-1',
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempt: 0,
        maxAttempts: 1,
        nextSeq: 1,
      });

      const storage = createNotImplementedStoragePort();
      storage.runs = runs;

      const runners = createRunnerRegistry();
      const controller = new DebugController({ storage, events: bus, runners });
      controller.start();

      const receivedStates: DebuggerState[] = [];
      controller.subscribe((state) => receivedStates.push(state), { runId });

      // Attach to trigger state notification
      await controller.handle({ type: 'debug.attach', runId });

      expect(receivedStates.length).toBeGreaterThan(0);
      expect(receivedStates[0].runId).toBe(runId);
      expect(receivedStates[0].status).toBe('attached');

      controller.stop();
    });
  });
});
