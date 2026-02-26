/**
 * Adapter Policy Contract Tests
 *
 * Verifies that skipRetry and skipNavWait flags correctly modify
 * action execution behavior:
 * - skipRetry: removes action.policy.retry before execution
 * - skipNavWait: sets ctx.execution.skipNavWait for handlers
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createStepExecutor } from '@/entrypoints/background/record-replay/actions/adapter';
import { createMockExecCtx, createMockStep } from './_test-helpers';

describe('adapter policy flags contract', () => {
  let registryExecute: ReturnType<typeof vi.fn>;
  let mockRegistry: any;

  beforeEach(() => {
    registryExecute = vi.fn(async () => ({ status: 'success' }));
    mockRegistry = {
      get: vi.fn(() => ({ type: 'fill' })), // Returns truthy = handler exists
      execute: registryExecute,
    };
  });

  describe('skipRetry flag', () => {
    it('removes action.policy.retry when skipRetry is true', async () => {
      const executor = createStepExecutor(mockRegistry);

      await executor(
        createMockExecCtx(),
        createMockStep('fill', {
          retry: { count: 3, intervalMs: 100, backoff: 'exp' },
          target: { candidates: [{ type: 'css', value: '#input' }] },
          value: 'test',
        }),
        1, // tabId
        { skipRetry: true },
      );

      expect(registryExecute).toHaveBeenCalledTimes(1);
      const [, action] = registryExecute.mock.calls[0];
      expect(action.policy?.retry).toBeUndefined();
    });

    it('preserves action.policy.retry when skipRetry is false', async () => {
      const executor = createStepExecutor(mockRegistry);

      await executor(
        createMockExecCtx(),
        createMockStep('fill', {
          retry: { count: 3, intervalMs: 100, backoff: 'exp' },
          target: { candidates: [{ type: 'css', value: '#input' }] },
          value: 'test',
        }),
        1,
        { skipRetry: false },
      );

      expect(registryExecute).toHaveBeenCalledTimes(1);
      const [, action] = registryExecute.mock.calls[0];
      expect(action.policy?.retry).toBeDefined();
      expect(action.policy.retry.retries).toBe(3);
    });

    it('preserves action.policy.retry when skipRetry is not specified', async () => {
      const executor = createStepExecutor(mockRegistry);

      await executor(
        createMockExecCtx(),
        createMockStep('fill', {
          retry: { count: 2, intervalMs: 50 },
          target: { candidates: [{ type: 'css', value: '#input' }] },
          value: 'test',
        }),
        1,
        {}, // No skipRetry
      );

      const [, action] = registryExecute.mock.calls[0];
      expect(action.policy?.retry).toBeDefined();
    });
  });

  describe('skipNavWait flag', () => {
    it('sets ctx.execution.skipNavWait when skipNavWait is true', async () => {
      const executor = createStepExecutor(mockRegistry);

      await executor(
        createMockExecCtx(),
        createMockStep('click', {
          target: { candidates: [{ type: 'css', value: '#btn' }] },
        }),
        1,
        { skipNavWait: true },
      );

      expect(registryExecute).toHaveBeenCalledTimes(1);
      const [actionCtx] = registryExecute.mock.calls[0];
      expect(actionCtx.execution?.skipNavWait).toBe(true);
    });

    it('does not set ctx.execution when skipNavWait is false', async () => {
      const executor = createStepExecutor(mockRegistry);

      await executor(
        createMockExecCtx(),
        createMockStep('click', {
          target: { candidates: [{ type: 'css', value: '#btn' }] },
        }),
        1,
        { skipNavWait: false },
      );

      const [actionCtx] = registryExecute.mock.calls[0];
      expect(actionCtx.execution).toBeUndefined();
    });

    it('does not set ctx.execution when skipNavWait is not specified', async () => {
      const executor = createStepExecutor(mockRegistry);

      await executor(
        createMockExecCtx(),
        createMockStep('navigate', {
          url: 'https://example.com',
        }),
        1,
        {}, // No skipNavWait
      );

      const [actionCtx] = registryExecute.mock.calls[0];
      expect(actionCtx.execution).toBeUndefined();
    });
  });

  describe('combined flags', () => {
    it('applies both skipRetry and skipNavWait together', async () => {
      const executor = createStepExecutor(mockRegistry);

      await executor(
        createMockExecCtx(),
        createMockStep('click', {
          retry: { count: 5, intervalMs: 200 },
          target: { candidates: [{ type: 'css', value: '#btn' }] },
        }),
        1,
        { skipRetry: true, skipNavWait: true },
      );

      const [actionCtx, action] = registryExecute.mock.calls[0];
      expect(action.policy?.retry).toBeUndefined();
      expect(actionCtx.execution?.skipNavWait).toBe(true);
    });
  });
});
