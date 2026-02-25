/**
 * @fileoverview V3 Spec Smoke Test
 * @description 验证 V3 类型定义和常量可正常导入使用
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ==================== Domain Types ====================
import {
  // JSON types
  type JsonValue,
  type JsonObject,
  type UnixMillis,

  // ID types
  type FlowId,
  type NodeId,
  type RunId,
  EDGE_LABELS,

  // Error types
  RR_ERROR_CODES,
  type RRError,
  createRRError,

  // Policy types
  type TimeoutPolicy,
  type RetryPolicy,
  type OnErrorPolicy,
  type NodePolicy,
  mergeNodePolicy,

  // Variable types
  type PersistentVariableName,
  isPersistentVariable,
  parseVariablePointer,

  // Flow types
  FLOW_SCHEMA_VERSION,
  type FlowV3,
  type NodeV3,
  type EdgeV3,
  findNodeById,

  // Event types
  type RunEvent,
  type RunStatus,
  type Unsubscribe,
  RUN_SCHEMA_VERSION,
  type RunRecordV3,
  isTerminalStatus,
  isActiveStatus,

  // Debug types
  type DebuggerState,
  type DebuggerCommand,
  createInitialDebuggerState,

  // Trigger types
  type TriggerKind,
  type TriggerSpec,
  isTriggerEnabled,
} from '@/entrypoints/background/record-replay-v3';

describe('V3 Domain Types', () => {
  describe('Constants', () => {
    it('should export EDGE_LABELS', () => {
      expect(EDGE_LABELS).toBeDefined();
      expect(EDGE_LABELS.DEFAULT).toBe('default');
      expect(EDGE_LABELS.ON_ERROR).toBe('onError');
      expect(EDGE_LABELS.TRUE).toBe('true');
      expect(EDGE_LABELS.FALSE).toBe('false');
    });

    it('should export RR_ERROR_CODES', () => {
      expect(RR_ERROR_CODES).toBeDefined();
      expect(RR_ERROR_CODES.TIMEOUT).toBe('TIMEOUT');
      expect(RR_ERROR_CODES.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
      expect(RR_ERROR_CODES.DAG_CYCLE).toBe('DAG_CYCLE');
    });

    it('should export schema versions', () => {
      expect(FLOW_SCHEMA_VERSION).toBe(3);
      expect(RUN_SCHEMA_VERSION).toBe(3);
    });
  });

  describe('Error utilities', () => {
    it('should create RRError', () => {
      const error = createRRError(RR_ERROR_CODES.TIMEOUT, 'Operation timed out', {
        retryable: true,
        data: { timeout: 5000 },
      });

      expect(error.code).toBe('TIMEOUT');
      expect(error.message).toBe('Operation timed out');
      expect(error.retryable).toBe(true);
      expect(error.data).toEqual({ timeout: 5000 });
    });

    it('should support error chaining', () => {
      const cause = createRRError(RR_ERROR_CODES.NETWORK_REQUEST_FAILED, 'Network error');
      const error = createRRError(RR_ERROR_CODES.TOOL_ERROR, 'Tool failed', { cause });

      expect(error.cause).toBeDefined();
      expect(error.cause?.code).toBe('NETWORK_REQUEST_FAILED');
    });
  });

  describe('Policy utilities', () => {
    it('should merge node policies', () => {
      const flowDefault: NodePolicy = {
        timeout: { ms: 30000 },
        retry: { retries: 3, intervalMs: 1000 },
      };

      const nodePolicy: NodePolicy = {
        timeout: { ms: 60000 },
      };

      const merged = mergeNodePolicy(flowDefault, nodePolicy);

      expect(merged.timeout?.ms).toBe(60000); // Node overrides
      expect(merged.retry?.retries).toBe(3); // Flow default
    });

    it('should handle undefined policies', () => {
      expect(mergeNodePolicy(undefined, undefined)).toEqual({});
      expect(mergeNodePolicy({ timeout: { ms: 5000 } }, undefined)).toEqual({
        timeout: { ms: 5000 },
      });
    });
  });

  describe('Variable utilities', () => {
    it('should detect persistent variables', () => {
      expect(isPersistentVariable('$user')).toBe(true);
      expect(isPersistentVariable('$config.theme')).toBe(true);
      expect(isPersistentVariable('normalVar')).toBe(false);
    });

    it('should parse variable pointers', () => {
      const ptr1 = parseVariablePointer('$user.name');
      expect(ptr1?.scope).toBe('persistent');
      expect(ptr1?.name).toBe('$user');
      expect(ptr1?.path).toEqual(['name']);

      const ptr2 = parseVariablePointer('localVar');
      expect(ptr2?.scope).toBe('run');
      expect(ptr2?.name).toBe('localVar');
    });
  });

  describe('Flow utilities', () => {
    const mockFlow: FlowV3 = {
      schemaVersion: FLOW_SCHEMA_VERSION,
      id: 'flow-1',
      name: 'Test Flow',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      entryNodeId: 'node-1',
      nodes: [
        { id: 'node-1', kind: 'click', config: {} },
        { id: 'node-2', kind: 'fill', config: {} },
      ],
      edges: [{ id: 'edge-1', from: 'node-1', to: 'node-2' }],
    };

    it('should find node by id', () => {
      const node = findNodeById(mockFlow, 'node-1');
      expect(node).toBeDefined();
      expect(node?.kind).toBe('click');

      expect(findNodeById(mockFlow, 'non-existent')).toBeUndefined();
    });
  });

  describe('Event utilities', () => {
    it('should check terminal status', () => {
      expect(isTerminalStatus('succeeded')).toBe(true);
      expect(isTerminalStatus('failed')).toBe(true);
      expect(isTerminalStatus('canceled')).toBe(true);
      expect(isTerminalStatus('running')).toBe(false);
      expect(isTerminalStatus('queued')).toBe(false);
    });

    it('should check active status', () => {
      expect(isActiveStatus('running')).toBe(true);
      expect(isActiveStatus('paused')).toBe(true);
      expect(isActiveStatus('succeeded')).toBe(false);
      expect(isActiveStatus('queued')).toBe(false);
    });
  });

  describe('Debug utilities', () => {
    it('should create initial debugger state', () => {
      const state = createInitialDebuggerState('run-1');

      expect(state.runId).toBe('run-1');
      expect(state.status).toBe('detached');
      expect(state.execution).toBe('running');
      expect(state.breakpoints).toEqual([]);
      expect(state.stepMode).toBe('none');
    });
  });

  describe('Trigger utilities', () => {
    it('should check trigger enabled', () => {
      const enabledTrigger: TriggerSpec = {
        id: 'trigger-1',
        kind: 'manual',
        enabled: true,
        flowId: 'flow-1',
      };

      const disabledTrigger: TriggerSpec = {
        id: 'trigger-2',
        kind: 'manual',
        enabled: false,
        flowId: 'flow-1',
      };

      expect(isTriggerEnabled(enabledTrigger)).toBe(true);
      expect(isTriggerEnabled(disabledTrigger)).toBe(false);
    });
  });
});

// ==================== Engine Types ====================
import {
  // Kernel
  type ExecutionKernel,
  type RunStartRequest,
  createNotImplementedKernel,

  // Queue
  type RunQueue,
  type RunQueueItem,
  DEFAULT_QUEUE_CONFIG,
  createNotImplementedQueue,

  // Plugins
  type NodeDefinition,
  type PluginRegistry,
  getPluginRegistry,
  resetPluginRegistry,

  // Transport
  RR_V3_PORT_NAME,
  type RpcMessage,
  createRpcRequest,
  InMemoryEventsBus,
} from '@/entrypoints/background/record-replay-v3';

describe('V3 Engine Types', () => {
  describe('Kernel', () => {
    it('should create not-implemented kernel', () => {
      const kernel = createNotImplementedKernel();
      expect(kernel).toBeDefined();
      expect(() => kernel.onEvent(() => {})).toThrow('not implemented');
    });
  });

  describe('Queue', () => {
    it('should export default queue config', () => {
      expect(DEFAULT_QUEUE_CONFIG).toBeDefined();
      expect(DEFAULT_QUEUE_CONFIG.maxParallelRuns).toBe(3);
      expect(DEFAULT_QUEUE_CONFIG.leaseTtlMs).toBe(15000);
    });

    it('should create not-implemented queue', () => {
      const queue = createNotImplementedQueue();
      expect(queue).toBeDefined();
    });
  });

  describe('Plugin Registry', () => {
    beforeEach(() => {
      resetPluginRegistry();
    });

    it('should get global registry', () => {
      const registry = getPluginRegistry();
      expect(registry).toBeDefined();
      expect(registry.listNodeKinds()).toEqual([]);
    });

    it('should register and retrieve nodes', () => {
      const registry = getPluginRegistry();

      const mockNodeDef: NodeDefinition = {
        kind: 'test-node',
        schema: { parse: (x: unknown) => x } as NodeDefinition['schema'],
        execute: async () => ({ status: 'succeeded' }),
      };

      registry.registerNode(mockNodeDef);
      expect(registry.hasNode('test-node')).toBe(true);
      expect(registry.getNode('test-node')).toBe(mockNodeDef);
    });
  });

  describe('Transport', () => {
    it('should export port name', () => {
      expect(RR_V3_PORT_NAME).toBe('rr_v3');
    });

    it('should create RPC request', () => {
      const req = createRpcRequest('rr_v3.listRuns', { limit: 10 });

      expect(req.type).toBe('rr_v3.request');
      expect(req.method).toBe('rr_v3.listRuns');
      expect(req.params).toEqual({ limit: 10 });
      expect(req.requestId).toBeDefined();
    });
  });

  describe('EventsBus (InMemory)', () => {
    it('should append and list events', async () => {
      const bus = new InMemoryEventsBus();

      const event = await bus.append({
        runId: 'run-1',
        type: 'run.started',
        flowId: 'flow-1',
        tabId: 1,
      });

      expect(event.seq).toBe(1);
      expect(event.ts).toBeDefined();

      const events = await bus.list({ runId: 'run-1' });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('run.started');
    });

    it('should support subscriptions', async () => {
      const bus = new InMemoryEventsBus();
      const received: RunEvent[] = [];

      const unsub = bus.subscribe((event) => received.push(event));

      await bus.append({ runId: 'run-1', type: 'run.queued', flowId: 'flow-1' });

      expect(received).toHaveLength(1);

      unsub();

      await bus.append({ runId: 'run-1', type: 'run.started', flowId: 'flow-1', tabId: 1 });

      // Should not receive after unsubscribe
      expect(received).toHaveLength(1);
    });
  });
});

// ==================== Storage Types ====================
import {
  RR_V3_DB_NAME,
  RR_V3_DB_VERSION,
  RR_V3_STORES,
} from '@/entrypoints/background/record-replay-v3';

describe('V3 Storage Constants', () => {
  it('should export database constants', () => {
    expect(RR_V3_DB_NAME).toBe('rr_v3');
    expect(RR_V3_DB_VERSION).toBe(1);
  });

  it('should export store names', () => {
    expect(RR_V3_STORES.FLOWS).toBe('flows');
    expect(RR_V3_STORES.RUNS).toBe('runs');
    expect(RR_V3_STORES.EVENTS).toBe('events');
    expect(RR_V3_STORES.QUEUE).toBe('queue');
    expect(RR_V3_STORES.PERSISTENT_VARS).toBe('persistent_vars');
    expect(RR_V3_STORES.TRIGGERS).toBe('triggers');
  });
});

// ==================== Version ====================
import { RR_V3_VERSION, IS_RR_V3 } from '@/entrypoints/background/record-replay-v3';

describe('V3 Version', () => {
  it('should export version info', () => {
    expect(RR_V3_VERSION).toBe('3.0.0');
    expect(IS_RR_V3).toBe(true);
  });
});
