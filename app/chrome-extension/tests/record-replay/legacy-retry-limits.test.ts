import { beforeEach, describe, expect, it, vi } from 'vitest';

const nestedFlowMocks = vi.hoisted(() => ({
  executeStep: vi.fn(),
  getFlow: vi.fn(),
}));

vi.mock('@/entrypoints/background/record-replay/flow-store', () => ({
  getFlow: nestedFlowMocks.getFlow,
}));
vi.mock('@/entrypoints/background/record-replay/rr-utils', () => ({
  defaultEdgesOnly: vi.fn((edges) => edges),
  topoOrder: vi.fn((nodes) => nodes),
  mapDagNodeToStep: vi.fn((node) => node.step),
  waitForNetworkIdle: vi.fn(),
  waitForNavigation: vi.fn(),
}));
vi.mock('@/entrypoints/background/record-replay/nodes', () => ({
  executeStep: nestedFlowMocks.executeStep,
}));

import {
  LEGACY_RETRY_LIMITS,
  boundedRetryDelay,
} from '@/entrypoints/background/record-replay/engine/policies/retry-limits';
import { withRetry } from '@/entrypoints/background/record-replay/engine/policies/retry';
import { ActionRegistry } from '@/entrypoints/background/record-replay/actions/registry';
import { executeFlowNode } from '@/entrypoints/background/record-replay/nodes/execute-flow';
import type {
  ActionExecutionContext,
  ActionHandler,
  ExecutableAction,
} from '@/entrypoints/background/record-replay/actions/types';

describe('legacy retry resource limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi
          .fn()
          .mockResolvedValue({ id: 1, url: 'https://example.com/', status: 'complete' }),
      },
    });
  });

  it('caps retry counts and rejects non-finite counts', async () => {
    const cappedRun = vi.fn(async () => {
      throw new Error('retry');
    });
    await expect(withRetry(cappedRun, undefined, { count: 1_000_000 })).rejects.toThrow('retry');
    expect(cappedRun).toHaveBeenCalledTimes(LEGACY_RETRY_LIMITS.maxRetries + 1);

    const invalidRun = vi.fn(async () => {
      throw new Error('invalid');
    });
    await expect(withRetry(invalidRun, undefined, { count: Infinity })).rejects.toThrow('invalid');
    expect(invalidRun).toHaveBeenCalledOnce();
  });

  it('caps exponential, linear, and caller-supplied retry intervals', () => {
    expect(boundedRetryDelay(Number.MAX_SAFE_INTEGER, 1_000, 'exp')).toBe(
      LEGACY_RETRY_LIMITS.maxIntervalMs,
    );
    expect(boundedRetryDelay(500_000, 10, 'linear')).toBe(
      LEGACY_RETRY_LIMITS.maxIntervalMs,
    );
    expect(boundedRetryDelay(10_000, 2, 'exp', 15_000)).toBe(15_000);
    expect(boundedRetryDelay(10_000, 2, 'exp', Infinity)).toBe(0);
  });

  it('caps ActionRegistry retries before entering the execution loop', async () => {
    const registry = new ActionRegistry();
    const run = vi.fn(async () => ({
      status: 'failed' as const,
      error: { code: 'UNKNOWN' as const, message: 'retry' },
    }));
    registry.register({ type: 'delay', run } as ActionHandler<'delay'>);
    const action = {
      id: 'action-1',
      type: 'delay',
      params: { sleep: 0 },
      policy: { retry: { retries: 1_000_000, intervalMs: 0 } },
    } as ExecutableAction<'delay'>;
    const ctx: ActionExecutionContext = {
      vars: {},
      tabId: 1,
      log: vi.fn(),
    };

    await expect(registry.execute(ctx, action)).resolves.toMatchObject({ status: 'failed' });
    expect(run).toHaveBeenCalledTimes(LEGACY_RETRY_LIMITS.maxRetries + 1);
  });

  it('caps retries in legacy inline executeFlow nodes', async () => {
    nestedFlowMocks.getFlow.mockResolvedValue({
      nodes: [
        {
          step: {
            id: 'nested-step',
            type: 'delay',
            retry: { count: 1_000_000, intervalMs: 0, backoff: 'exp' },
          },
        },
      ],
      edges: [],
    });
    nestedFlowMocks.executeStep.mockRejectedValue(new Error('nested failure'));
    const logger = vi.fn();

    await expect(
      executeFlowNode.run(
        { vars: {}, logger, tabId: 1 },
        { id: 'parent', type: 'executeFlow', flowId: 'child', inline: true } as any,
      ),
    ).rejects.toThrow('nested failure');
    expect(nestedFlowMocks.executeStep).toHaveBeenCalledTimes(
      LEGACY_RETRY_LIMITS.maxRetries + 1,
    );
  });
});
