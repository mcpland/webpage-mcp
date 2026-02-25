/**
 * @fileoverview V2 Action Adapter unit tests
 * @description Tests for adaptV2ActionHandlerToV3NodeDefinition
 *
 * Coverage:
 * - varsPatch generation (set/delete)
 * - nextLabel mapping
 * - Error code mapping
 * - Tab/frame state vars
 * - paused/control directive handling
 * - Output capture
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  ActionExecutionContext,
  ActionExecutionResult,
  ActionHandler,
} from '@/entrypoints/background/record-replay/actions/types';
import type {
  NodeExecutionContext,
  NodeExecutionResult,
} from '@/entrypoints/background/record-replay-v3/engine/plugins/types';
import type { FlowV3 } from '@/entrypoints/background/record-replay-v3/domain/flow';
import type { RunId, NodeId } from '@/entrypoints/background/record-replay-v3/domain/ids';
import { RR_ERROR_CODES } from '@/entrypoints/background/record-replay-v3/domain/errors';
import { FLOW_SCHEMA_VERSION } from '@/entrypoints/background/record-replay-v3/domain/flow';

import { adaptV2ActionHandlerToV3NodeDefinition } from '@/entrypoints/background/record-replay-v3/engine/plugins/v2-action-adapter';

// ==================== Test Fixtures ====================

function createMockV3Context(overrides: Partial<NodeExecutionContext> = {}): NodeExecutionContext {
  const flow: FlowV3 = {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id: 'test-flow',
    name: 'Test Flow',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    entryNodeId: 'node-1',
    nodes: [],
    edges: [],
  };

  return {
    runId: 'run-1' as RunId,
    flow,
    nodeId: 'node-1' as NodeId,
    tabId: 1,
    vars: {},
    log: vi.fn(),
    chooseNext: (label: string) => ({ kind: 'edgeLabel' as const, label }),
    artifacts: {
      screenshot: vi.fn().mockResolvedValue({ ok: true, base64: 'mock-base64' }),
    },
    persistent: {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

function createMockNode(id = 'node-1', config: Record<string, unknown> = {}) {
  return {
    id: id as NodeId,
    kind: 'test' as const,
    config,
  };
}

type TestActionType = 'test';

function createMockHandler(
  runFn: (
    ctx: ActionExecutionContext,
    action: unknown,
  ) => Promise<ActionExecutionResult<TestActionType>>,
): ActionHandler<TestActionType> {
  return {
    type: 'test' as TestActionType,
    run: runFn,
  };
}

// ==================== Tests ====================

describe('adaptV2ActionHandlerToV3NodeDefinition', () => {
  describe('Basic execution', () => {
    it('returns succeeded for successful V2 handler', async () => {
      const handler = createMockHandler(async () => ({
        status: 'success',
      }));

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context();
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('succeeded');
    });

    it('maps V2 failed status to V3 failed', async () => {
      const handler = createMockHandler(async () => ({
        status: 'failed',
        error: { code: 'TIMEOUT', message: 'Timed out' },
      }));

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context();
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe(RR_ERROR_CODES.TIMEOUT);
      expect(result.error?.message).toBe('Timed out');
    });

    it('handles V2 handler throwing exception', async () => {
      const handler = createMockHandler(async () => {
        throw new Error('Unexpected error');
      });

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context();
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe(RR_ERROR_CODES.INTERNAL);
      expect(result.error?.message).toContain('Unexpected error');
    });
  });

  describe('varsPatch generation', () => {
    it('generates set patch for new variable', async () => {
      const handler = createMockHandler(async (ctx) => {
        ctx.vars['newVar'] = 'value';
        return { status: 'success' };
      });

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context({ vars: {} });
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('succeeded');
      expect(result.varsPatch).toContainEqual({ op: 'set', name: 'newVar', value: 'value' });
    });

    it('generates set patch for modified variable', async () => {
      const handler = createMockHandler(async (ctx) => {
        ctx.vars['existing'] = 'modified';
        return { status: 'success' };
      });

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context({ vars: { existing: 'original' } });
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('succeeded');
      expect(result.varsPatch).toContainEqual({ op: 'set', name: 'existing', value: 'modified' });
    });

    it('generates delete patch for removed variable', async () => {
      const handler = createMockHandler(async (ctx) => {
        delete ctx.vars['toDelete'];
        return { status: 'success' };
      });

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context({ vars: { toDelete: 'value' } });
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('succeeded');
      expect(result.varsPatch).toContainEqual({ op: 'delete', name: 'toDelete' });
    });

    it('handles deep object changes', async () => {
      const handler = createMockHandler(async (ctx) => {
        ctx.vars['obj'] = { nested: { value: 42 } };
        return { status: 'success' };
      });

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context({ vars: { obj: { nested: { value: 1 } } } });
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('succeeded');
      expect(result.varsPatch).toContainEqual({
        op: 'set',
        name: 'obj',
        value: { nested: { value: 42 } },
      });
    });

    it('does not generate patch when vars unchanged', async () => {
      const handler = createMockHandler(async () => ({
        status: 'success',
      }));

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context({ vars: { existing: 'value' } });
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('succeeded');
      expect(result.varsPatch).toBeUndefined();
    });
  });

  describe('nextLabel mapping', () => {
    it('maps nextLabel to chooseNext result', async () => {
      const handler = createMockHandler(async () => ({
        status: 'success',
        nextLabel: 'true',
      }));

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context();
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('succeeded');
      expect(result.next).toEqual({ kind: 'edgeLabel', label: 'true' });
    });

    it('does not set next when no nextLabel', async () => {
      const handler = createMockHandler(async () => ({
        status: 'success',
      }));

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context();
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('succeeded');
      expect(result.next).toBeUndefined();
    });
  });

  describe('Error code mapping', () => {
    const errorCodes: Array<{ v2Code: string; v3Code: string }> = [
      { v2Code: 'VALIDATION_ERROR', v3Code: RR_ERROR_CODES.VALIDATION_ERROR },
      { v2Code: 'TIMEOUT', v3Code: RR_ERROR_CODES.TIMEOUT },
      { v2Code: 'TAB_NOT_FOUND', v3Code: RR_ERROR_CODES.TAB_NOT_FOUND },
      { v2Code: 'FRAME_NOT_FOUND', v3Code: RR_ERROR_CODES.FRAME_NOT_FOUND },
      { v2Code: 'TARGET_NOT_FOUND', v3Code: RR_ERROR_CODES.TARGET_NOT_FOUND },
      { v2Code: 'ELEMENT_NOT_VISIBLE', v3Code: RR_ERROR_CODES.ELEMENT_NOT_VISIBLE },
      { v2Code: 'NAVIGATION_FAILED', v3Code: RR_ERROR_CODES.NAVIGATION_FAILED },
      { v2Code: 'NETWORK_REQUEST_FAILED', v3Code: RR_ERROR_CODES.NETWORK_REQUEST_FAILED },
      { v2Code: 'SCRIPT_FAILED', v3Code: RR_ERROR_CODES.SCRIPT_FAILED },
      { v2Code: 'DOWNLOAD_FAILED', v3Code: RR_ERROR_CODES.TOOL_ERROR },
      { v2Code: 'ASSERTION_FAILED', v3Code: RR_ERROR_CODES.TOOL_ERROR },
      { v2Code: 'UNKNOWN', v3Code: RR_ERROR_CODES.INTERNAL },
    ];

    errorCodes.forEach(({ v2Code, v3Code }) => {
      it(`maps V2 ${v2Code} to V3 ${v3Code}`, async () => {
        const handler = createMockHandler(async () => ({
          status: 'failed',
          error: { code: v2Code as any, message: 'Test error' },
        }));

        const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
        const ctx = createMockV3Context();
        const node = createMockNode();

        const result = await nodeDef.execute(ctx, node as any);

        expect(result.status).toBe('failed');
        expect(result.error?.code).toBe(v3Code);
      });
    });
  });

  describe('Tab/frame state vars', () => {
    it('persists newTabId as __rr_v2__tabId', async () => {
      const handler = createMockHandler(async () => ({
        status: 'success',
        newTabId: 42,
      }));

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context();
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('succeeded');
      expect(result.varsPatch).toContainEqual({
        op: 'set',
        name: '__rr_v2__tabId',
        value: 42,
      });
    });

    it('persists ctx.frameId as __rr_v2__frameId', async () => {
      const handler = createMockHandler(async (ctx) => {
        ctx.frameId = 5;
        return { status: 'success' };
      });

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context();
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('succeeded');
      expect(result.varsPatch).toContainEqual({
        op: 'set',
        name: '__rr_v2__frameId',
        value: 5,
      });
    });

    it('reads tabId from __rr_v2__tabId var', async () => {
      let capturedTabId: number | undefined;
      const handler = createMockHandler(async (ctx) => {
        capturedTabId = ctx.tabId;
        return { status: 'success' };
      });

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context({
        tabId: 1,
        vars: { __rr_v2__tabId: 99 },
      });
      const node = createMockNode();

      await nodeDef.execute(ctx, node as any);

      expect(capturedTabId).toBe(99);
    });

    it('reads frameId from __rr_v2__frameId var', async () => {
      let capturedFrameId: number | undefined;
      const handler = createMockHandler(async (ctx) => {
        capturedFrameId = ctx.frameId;
        return { status: 'success' };
      });

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context({
        vars: { __rr_v2__frameId: 7 },
      });
      const node = createMockNode();

      await nodeDef.execute(ctx, node as any);

      expect(capturedFrameId).toBe(7);
    });

    it('supports custom state var names', async () => {
      const handler = createMockHandler(async () => ({
        status: 'success',
        newTabId: 42,
      }));

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler, {
        stateVars: { tabIdVar: 'custom_tab', frameIdVar: 'custom_frame' },
      });
      const ctx = createMockV3Context();
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.varsPatch).toContainEqual({
        op: 'set',
        name: 'custom_tab',
        value: 42,
      });
    });
  });

  describe('Unsupported V2 behaviors', () => {
    it('returns failed for paused status', async () => {
      const handler = createMockHandler(async () => ({
        status: 'paused',
      }));

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context();
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe(RR_ERROR_CODES.RUN_PAUSED);
    });

    it('returns failed for control directive (foreach)', async () => {
      const handler = createMockHandler(async () => ({
        status: 'success',
        control: {
          kind: 'foreach' as const,
          listVar: 'items',
          itemVar: 'item',
          subflowId: 'subflow-1',
        },
      }));

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context();
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe(RR_ERROR_CODES.UNSUPPORTED_NODE);
      expect(result.error?.message).toContain('foreach');
    });

    it('returns failed for control directive (while)', async () => {
      const handler = createMockHandler(async () => ({
        status: 'success',
        control: {
          kind: 'while' as const,
          condition: { left: 'a', op: '==', right: 'b' },
          subflowId: 'subflow-1',
          maxIterations: 10,
        },
      }));

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context();
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe(RR_ERROR_CODES.UNSUPPORTED_NODE);
      expect(result.error?.message).toContain('while');
    });
  });

  describe('Output capture', () => {
    it('captures output in outputs map', async () => {
      const handler = createMockHandler(async () => ({
        status: 'success',
        output: { extracted: 'data' },
      }));

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context();
      const node = createMockNode('extract-node');

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('succeeded');
      expect(result.outputs).toEqual({
        'extract-node': { extracted: 'data' },
      });
    });

    it('respects includeOutput: false option', async () => {
      const handler = createMockHandler(async () => ({
        status: 'success',
        output: { extracted: 'data' },
      }));

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler, {
        includeOutput: false,
      });
      const ctx = createMockV3Context();
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('succeeded');
      expect(result.outputs).toBeUndefined();
    });

    it('does not include outputs when no output', async () => {
      const handler = createMockHandler(async () => ({
        status: 'success',
      }));

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context();
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('succeeded');
      expect(result.outputs).toBeUndefined();
    });
  });

  describe('Validation', () => {
    it('calls handler validate and returns error on failure', async () => {
      const handler: ActionHandler<TestActionType> = {
        type: 'test' as TestActionType,
        validate: () => ({ ok: false, errors: ['Invalid config'] }),
        run: async () => ({ status: 'success' }),
      };

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context();
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe(RR_ERROR_CODES.VALIDATION_ERROR);
      expect(result.error?.message).toContain('Invalid config');
    });

    it('proceeds with execution when validation passes', async () => {
      const handler: ActionHandler<TestActionType> = {
        type: 'test' as TestActionType,
        validate: () => ({ ok: true }),
        run: async () => ({ status: 'success' }),
      };

      const nodeDef = adaptV2ActionHandlerToV3NodeDefinition(handler);
      const ctx = createMockV3Context();
      const node = createMockNode();

      const result = await nodeDef.execute(ctx, node as any);

      expect(result.status).toBe('succeeded');
    });
  });
});
