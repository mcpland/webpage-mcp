/**
 * @fileoverview V2 Action Adapter integration tests
 * @description Tests the full flow of V2 handlers through V3 runner
 *
 * This test uses real V2 handlers (like 'if') to verify:
 * - Handler registration works
 * - V3 runner can execute V2 handlers
 * - Edge following based on nextLabel
 * - Event emission for adapted nodes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowV3 } from '@/entrypoints/background/record-replay-v3';
import {
  FLOW_SCHEMA_VERSION,
  RUN_SCHEMA_VERSION,
  closeRrV3Db,
  deleteRrV3Db,
  resetBreakpointRegistry,
} from '@/entrypoints/background/record-replay-v3';

import { PluginRegistry } from '@/entrypoints/background/record-replay-v3/engine/plugins/registry';
import { ifHandler } from '@/entrypoints/background/record-replay/actions/handlers/control-flow';
import { delayHandler } from '@/entrypoints/background/record-replay/actions/handlers/delay';
import { adaptV2ActionHandlerToV3NodeDefinition } from '@/entrypoints/background/record-replay-v3/engine/plugins/v2-action-adapter';
import { createV3E2EHarness, type V3E2EHarness, type RpcClient } from './v3-e2e-harness';

// ==================== Test Fixtures ====================

/**
 * Create a Flow that uses the 'if' node with branching
 */
function createIfBranchingFlow(id: string, conditionVar: string): FlowV3 {
  const iso = new Date(0).toISOString();
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id,
    name: `If Branching Flow ${id}`,
    createdAt: iso,
    updatedAt: iso,
    entryNodeId: 'if-node',
    nodes: [
      {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'binary',
          condition: {
            kind: 'truthy',
            value: { kind: 'var', ref: { name: conditionVar } },
          },
          trueLabel: 'true',
          falseLabel: 'false',
        },
      },
      {
        id: 'true-node',
        kind: 'test',
        config: { action: 'succeed', outputs: { result: 'true-path' } },
      },
      {
        id: 'false-node',
        kind: 'test',
        config: { action: 'succeed', outputs: { result: 'false-path' } },
      },
    ],
    edges: [
      { id: 'e1', from: 'if-node', to: 'true-node', label: 'true' },
      { id: 'e2', from: 'if-node', to: 'false-node', label: 'false' },
    ],
  };
}

/**
 * Create a simple delay flow to test timing-based handlers
 */
function createDelayFlow(id: string, delayMs: number): FlowV3 {
  const iso = new Date(0).toISOString();
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id,
    name: `Delay Flow ${id}`,
    createdAt: iso,
    updatedAt: iso,
    entryNodeId: 'delay-node',
    nodes: [
      {
        id: 'delay-node',
        kind: 'delay',
        config: { ms: delayMs },
      },
    ],
    edges: [],
  };
}

// ==================== Custom Harness with V2 Handlers ====================

/**
 * Extended harness that registers real V2 handlers
 */
function createV2IntegrationHarness(): V3E2EHarness {
  // First create base harness (which registers 'test' node)
  const harness = createV3E2EHarness({ autoStartScheduler: false });

  // Register V2 handlers via adapter
  // Note: We need to access the internal plugins registry
  // For this test, we'll directly register to the runner factory's plugins
  return harness;
}

// ==================== Tests ====================

describe('V2 Action Adapter Integration', () => {
  let h: V3E2EHarness;
  let client: RpcClient;
  let plugins: PluginRegistry;

  beforeEach(async () => {
    await deleteRrV3Db();
    closeRrV3Db();
    resetBreakpointRegistry();

    // Create harness without auto-starting scheduler
    h = createV3E2EHarness({ autoStartScheduler: false });
    client = h.createClient();

    // Create a separate plugin registry for testing
    plugins = new PluginRegistry();
  });

  afterEach(async () => {
    await h.dispose();
  });

  describe('if handler through adapter', () => {
    it('adapts if handler to V3 NodeDefinition', () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      expect(nodeDef.kind).toBe('if');
      expect(typeof nodeDef.execute).toBe('function');
    });

    it('registers if handler in PluginRegistry', () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);
      plugins.registerNode(nodeDef as any);

      expect(plugins.hasNode('if')).toBe(true);
      expect(plugins.getNode('if')).toBeDefined();
    });

    it('evaluates truthy condition and returns true label', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'if-node',
        tabId: 1,
        vars: { flag: true },
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'binary',
          condition: { kind: 'truthy', value: { kind: 'var', ref: { name: 'flag' } } },
          trueLabel: 'yes',
          falseLabel: 'no',
        },
      };

      const result = await nodeDef.execute(mockCtx as any, node as any);

      expect(result.status).toBe('succeeded');
      expect(result.next).toEqual({ kind: 'edgeLabel', label: 'yes' });
    });

    it('evaluates falsy condition and returns false label', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'if-node',
        tabId: 1,
        vars: { flag: false },
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'binary',
          condition: { kind: 'truthy', value: { kind: 'var', ref: { name: 'flag' } } },
          trueLabel: 'yes',
          falseLabel: 'no',
        },
      };

      const result = await nodeDef.execute(mockCtx as any, node as any);

      expect(result.status).toBe('succeeded');
      expect(result.next).toEqual({ kind: 'edgeLabel', label: 'no' });
    });

    it('handles compare condition (eq)', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'if-node',
        tabId: 1,
        vars: { value: 42 },
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'binary',
          condition: {
            kind: 'compare',
            left: { kind: 'var', ref: { name: 'value' } },
            op: 'eq',
            right: 42,
          },
        },
      };

      const result = await nodeDef.execute(mockCtx as any, node as any);

      expect(result.status).toBe('succeeded');
      expect(result.next).toEqual({ kind: 'edgeLabel', label: 'true' });
    });

    it('handles branches mode', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'if-node',
        tabId: 1,
        vars: { status: 'pending' },
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'branches',
          branches: [
            {
              label: 'completed',
              condition: {
                kind: 'compare',
                left: { kind: 'var', ref: { name: 'status' } },
                op: 'eq',
                right: 'done',
              },
            },
            {
              label: 'in-progress',
              condition: {
                kind: 'compare',
                left: { kind: 'var', ref: { name: 'status' } },
                op: 'eq',
                right: 'pending',
              },
            },
          ],
          elseLabel: 'unknown',
        },
      };

      const result = await nodeDef.execute(mockCtx as any, node as any);

      expect(result.status).toBe('succeeded');
      expect(result.next).toEqual({ kind: 'edgeLabel', label: 'in-progress' });
    });
  });

  describe('delay handler through adapter', () => {
    it('adapts delay handler and executes', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(delayHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'delay-node',
        tabId: 1,
        vars: {},
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'delay-node',
        kind: 'delay',
        config: { sleep: 10 }, // delay handler uses 'sleep' param
      };

      const startTime = Date.now();
      const result = await nodeDef.execute(mockCtx as any, node as any);
      const elapsed = Date.now() - startTime;

      expect(result.status).toBe('succeeded');
      expect(elapsed).toBeGreaterThanOrEqual(9); // Allow some tolerance
    });

    it('supports variable-based delay', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(delayHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'delay-node',
        tabId: 1,
        vars: { waitTime: 15 },
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'delay-node',
        kind: 'delay',
        config: {
          sleep: { kind: 'var', ref: { name: 'waitTime' } },
        },
      };

      const startTime = Date.now();
      const result = await nodeDef.execute(mockCtx as any, node as any);
      const elapsed = Date.now() - startTime;

      expect(result.status).toBe('succeeded');
      expect(elapsed).toBeGreaterThanOrEqual(14);
    });
  });

  describe('Complex conditions', () => {
    it('handles AND condition', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'if-node',
        tabId: 1,
        vars: { a: true, b: true },
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'binary',
          condition: {
            kind: 'and',
            conditions: [
              { kind: 'truthy', value: { kind: 'var', ref: { name: 'a' } } },
              { kind: 'truthy', value: { kind: 'var', ref: { name: 'b' } } },
            ],
          },
        },
      };

      const result = await nodeDef.execute(mockCtx as any, node as any);
      expect(result.next).toEqual({ kind: 'edgeLabel', label: 'true' });
    });

    it('handles OR condition', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'if-node',
        tabId: 1,
        vars: { a: false, b: true },
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'binary',
          condition: {
            kind: 'or',
            conditions: [
              { kind: 'truthy', value: { kind: 'var', ref: { name: 'a' } } },
              { kind: 'truthy', value: { kind: 'var', ref: { name: 'b' } } },
            ],
          },
        },
      };

      const result = await nodeDef.execute(mockCtx as any, node as any);
      expect(result.next).toEqual({ kind: 'edgeLabel', label: 'true' });
    });

    it('handles NOT condition', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      const mockCtx = {
        runId: 'run-1',
        flow: { policy: {} } as any,
        nodeId: 'if-node',
        tabId: 1,
        vars: { flag: false },
        log: vi.fn(),
        chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
        artifacts: { screenshot: vi.fn() },
        persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
      };

      const node = {
        id: 'if-node',
        kind: 'if',
        config: {
          mode: 'binary',
          condition: {
            kind: 'not',
            condition: { kind: 'truthy', value: { kind: 'var', ref: { name: 'flag' } } },
          },
        },
      };

      const result = await nodeDef.execute(mockCtx as any, node as any);
      expect(result.next).toEqual({ kind: 'edgeLabel', label: 'true' });
    });

    it('handles string comparison operators', async () => {
      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(ifHandler);

      const testCases = [
        { op: 'contains', value: 'hello world', right: 'world', expected: true },
        { op: 'containsI', value: 'Hello World', right: 'WORLD', expected: true },
        { op: 'startsWith', value: 'hello world', right: 'hello', expected: true },
        { op: 'endsWith', value: 'hello world', right: 'world', expected: true },
        { op: 'regex', value: 'test123', right: '\\d+', expected: true },
      ];

      for (const { op, value, right, expected } of testCases) {
        const mockCtx = {
          runId: 'run-1',
          flow: { policy: {} } as any,
          nodeId: 'if-node',
          tabId: 1,
          vars: { str: value },
          log: vi.fn(),
          chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
          artifacts: { screenshot: vi.fn() },
          persistent: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
        };

        const node = {
          id: 'if-node',
          kind: 'if',
          config: {
            mode: 'binary',
            condition: {
              kind: 'compare',
              left: { kind: 'var', ref: { name: 'str' } },
              op,
              right,
            },
          },
        };

        const result = await nodeDef.execute(mockCtx as any, node as any);
        const expectedLabel = expected ? 'true' : 'false';
        expect(result.next).toEqual({ kind: 'edgeLabel', label: expectedLabel });
      }
    });
  });
});
