import { describe, expect, it, vi } from 'vitest';

import {
  ifHandler,
  whileHandler,
} from '@/entrypoints/background/record-replay/actions/handlers/control-flow';
import type {
  ActionExecutionContext,
  Condition,
  VariableStore,
} from '@/entrypoints/background/record-replay/actions/types';
import { ControlFlowRunner } from '@/entrypoints/background/record-replay/engine/runners/control-flow-runner';
import { evaluateSchedulerCondition } from '@/entrypoints/background/record-replay/engine/scheduler';

function context(vars: VariableStore): ActionExecutionContext {
  return {
    vars,
    tabId: 1,
    log: vi.fn(),
  };
}

function rr(code: string): Condition {
  return { kind: 'expr', expr: { language: 'rr', code } };
}

function ifAction(params: unknown) {
  return { id: 'if-expression', type: 'if', params } as never;
}

describe('action control-flow expression conditions', () => {
  it('evaluates rr expressions in binary if actions', async () => {
    const result = await ifHandler.run(
      context({ total: 7, enabled: true }),
      ifAction({
        mode: 'binary',
        condition: rr('vars.total >= 5 && vars.enabled'),
        trueLabel: 'accepted',
        falseLabel: 'rejected',
      }),
    );

    expect(result).toMatchObject({ status: 'success', nextLabel: 'accepted' });
  });

  it('evaluates rr expressions in ordered branches', async () => {
    const result = await ifHandler.run(
      context({ score: 80 }),
      ifAction({
        mode: 'branches',
        branches: [
          { id: 'low', label: 'low', condition: rr('vars.score < 50') },
          { id: 'high', label: 'high', condition: rr('vars.score >= 75') },
        ],
        elseLabel: 'middle',
      }),
    );

    expect(result).toMatchObject({ status: 'success', nextLabel: 'high' });
  });

  it('evaluates rr expressions nested in boolean conditions', async () => {
    const result = await ifHandler.run(
      context({ count: 3, blocked: false, fallback: false }),
      ifAction({
        mode: 'binary',
        condition: {
          kind: 'and',
          conditions: [
            rr('vars.count === 3'),
            { kind: 'not', condition: rr('vars.blocked') },
            {
              kind: 'or',
              conditions: [rr('vars.fallback'), rr('vars.count > 1')],
            },
          ],
        },
      }),
    );

    expect(result).toMatchObject({ status: 'success', nextLabel: 'true' });
  });

  it('re-evaluates rr expressions across action while iterations', async () => {
    const vars: VariableStore = { count: 0 };
    const initial = await whileHandler.run(context(vars), {
      id: 'while-expression',
      type: 'while',
      params: {
        condition: rr('vars.count < 3'),
        subflowId: 'increment',
        maxIterations: 10,
      },
    } as never);
    expect(initial.status).toBe('success');
    if (initial.status !== 'success' || !initial.control) {
      throw new Error('Expected while control directive');
    }

    const runSubflowById = vi.fn(async () => {
      vars.count = Number(vars.count) + 1;
    });
    const runner = new ControlFlowRunner({
      vars,
      logger: {} as never,
      evalCondition: (condition) => evaluateSchedulerCondition(condition, vars),
      runSubflowById,
      isPaused: () => false,
    });

    await runner.run(initial.control, { vars } as never);

    expect(vars.count).toBe(3);
    expect(runSubflowById).toHaveBeenCalledTimes(3);
  });

  it('keeps legacy scheduler condition shapes compatible', () => {
    const vars = { count: 3, ready: true };

    expect(
      evaluateSchedulerCondition({ expression: 'vars.count === 3' }, vars),
    ).toBe(true);
    expect(evaluateSchedulerCondition({ var: 'count', equals: 3 }, vars)).toBe(true);
    expect(evaluateSchedulerCondition({ var: 'ready' }, vars)).toBe(true);
  });

  it('reports unsupported languages and invalid grammar as validation failures', async () => {
    const unsupported = ifAction({
      mode: 'binary',
      condition: { kind: 'expr', expr: { language: 'js', code: 'true' } },
    });
    const malformed = ifAction({
      mode: 'binary',
      condition: rr('vars.value ? true : false'),
    });
    const malformedWhile = {
      id: 'while-malformed',
      type: 'while',
      params: {
        condition: rr('vars.value ? true : false'),
        subflowId: 'noop',
      },
    } as never;

    expect(ifHandler.validate?.(unsupported)).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('only support the "rr" language')],
    });
    expect(ifHandler.validate?.(malformed)).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('Invalid rr expression')],
    });
    expect(whileHandler.validate?.(malformedWhile)).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('Invalid rr expression')],
    });

    const bypassedValidation = await ifHandler.run(context({ value: true }), malformed);
    expect(bypassedValidation).toMatchObject({
      status: 'failed',
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('Invalid rr expression'),
      },
    });
  });
});
