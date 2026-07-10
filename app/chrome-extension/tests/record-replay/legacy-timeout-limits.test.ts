import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionRegistry } from '@/entrypoints/background/record-replay/actions/registry';
import type {
  ActionExecutionContext,
  ActionHandler,
  ExecutableAction,
} from '@/entrypoints/background/record-replay/actions/types';
import {
  LEGACY_TIMEOUT_LIMITS,
  boundedActionTimeout,
} from '@/entrypoints/background/record-replay/engine/policies/timeout-limits';

describe('legacy action timeout limits', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createPendingExecution(timeout: unknown, scope: unknown = 'attempt') {
    const registry = new ActionRegistry();
    const run = vi.fn(() => new Promise<never>(() => {}));
    registry.register({ type: 'delay', run } as unknown as ActionHandler<'delay'>);
    const action = {
      id: 'action-1',
      type: 'delay',
      params: { sleep: 0 },
      policy: { timeout: { ms: timeout, scope } },
    } as unknown as ExecutableAction<'delay'>;
    const ctx: ActionExecutionContext = {
      vars: {},
      tabId: 1,
      log: vi.fn(),
    };
    return { execution: registry.execute(ctx, action), run };
  }

  it('normalizes every supplied timeout to a finite one-hour ceiling', () => {
    expect(boundedActionTimeout(Number.MAX_SAFE_INTEGER)).toBe(
      LEGACY_TIMEOUT_LIMITS.maxActionMs,
    );
    expect(boundedActionTimeout(Infinity)).toBe(LEGACY_TIMEOUT_LIMITS.maxActionMs);
    expect(boundedActionTimeout(NaN)).toBe(LEGACY_TIMEOUT_LIMITS.maxActionMs);
    expect(boundedActionTimeout(-1)).toBe(0);
    expect(boundedActionTimeout(12.9)).toBe(12);
  });

  it.each([
    ['oversized attempt timeout', Number.MAX_SAFE_INTEGER, 'attempt'],
    ['non-finite attempt timeout', Infinity, 'attempt'],
    ['oversized action deadline', Number.MAX_SAFE_INTEGER, 'action'],
    ['invalid scope', Number.MAX_SAFE_INTEGER, 'unexpected'],
  ])('caps %s before creating a timer', async (_label, timeout, scope) => {
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    const { execution, run } = createPendingExecution(timeout, scope);

    expect(run).toHaveBeenCalledOnce();
    expect(timerSpy).toHaveBeenCalledWith(expect.any(Function), LEGACY_TIMEOUT_LIMITS.maxActionMs);

    await vi.advanceTimersByTimeAsync(LEGACY_TIMEOUT_LIMITS.maxActionMs);
    await expect(execution).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'TIMEOUT' },
    });
  });
});
