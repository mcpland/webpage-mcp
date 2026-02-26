/**
 * Step Executor Routing Contract Tests
 *
 * Verifies that step execution routes correctly based on ExecutionModeConfig:
 * - legacy mode: always uses legacy executeStep
 * - hybrid mode: uses actions for allowlisted types, legacy for others
 * - actions mode: always uses ActionRegistry (strict)
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock legacy executeStep - must be defined inline in vi.mock factory
vi.mock('@/entrypoints/background/record-replay/nodes', () => ({
  executeStep: vi.fn(async () => ({})),
}));

// Mock createStepExecutor from adapter - must be defined inline in vi.mock factory
vi.mock('@/entrypoints/background/record-replay/actions/adapter', () => ({
  createStepExecutor: vi.fn(() => vi.fn(async () => ({ supported: true, result: {} }))),
  isActionSupported: vi.fn((type: string) => {
    const supported = ['fill', 'key', 'scroll', 'click', 'navigate', 'delay', 'wait'];
    return supported.includes(type);
  }),
}));

import { createMockExecCtx, createMockStep, createMockRegistry } from './_test-helpers';
import {
  DEFAULT_EXECUTION_MODE_CONFIG,
  createHybridConfig,
  createActionsOnlyConfig,
  MINIMAL_HYBRID_ACTION_TYPES,
} from '@/entrypoints/background/record-replay/engine/execution-mode';
import {
  LegacyStepExecutor,
  ActionsStepExecutor,
  HybridStepExecutor,
  createExecutor,
} from '@/entrypoints/background/record-replay/engine/runners/step-executor';
import { executeStep as legacyExecuteStep } from '@/entrypoints/background/record-replay/nodes';
import { createStepExecutor as createAdapterExecutor } from '@/entrypoints/background/record-replay/actions/adapter';

describe('ExecutionModeConfig contract', () => {
  describe('DEFAULT_EXECUTION_MODE_CONFIG', () => {
    it('defaults to legacy mode', () => {
      expect(DEFAULT_EXECUTION_MODE_CONFIG.mode).toBe('legacy');
    });

    it('defaults skipActionsRetry to true', () => {
      expect(DEFAULT_EXECUTION_MODE_CONFIG.skipActionsRetry).toBe(true);
    });

    it('defaults skipActionsNavWait to true', () => {
      expect(DEFAULT_EXECUTION_MODE_CONFIG.skipActionsNavWait).toBe(true);
    });
  });

  describe('createHybridConfig', () => {
    it('sets mode to hybrid', () => {
      const config = createHybridConfig();
      expect(config.mode).toBe('hybrid');
    });

    it('uses MINIMAL_HYBRID_ACTION_TYPES as default allowlist', () => {
      const config = createHybridConfig();
      expect(config.actionsAllowlist).toBeDefined();
      expect(config.actionsAllowlist?.has('fill')).toBe(true);
      expect(config.actionsAllowlist?.has('key')).toBe(true);
      expect(config.actionsAllowlist?.has('scroll')).toBe(true);
      // High-risk types should NOT be in minimal allowlist
      expect(config.actionsAllowlist?.has('click')).toBe(false);
      expect(config.actionsAllowlist?.has('navigate')).toBe(false);
    });

    it('allows overriding actionsAllowlist', () => {
      const config = createHybridConfig({
        actionsAllowlist: new Set(['fill', 'click']),
      });
      expect(config.actionsAllowlist?.has('fill')).toBe(true);
      expect(config.actionsAllowlist?.has('click')).toBe(true);
      expect(config.actionsAllowlist?.has('key')).toBe(false);
    });
  });

  describe('createActionsOnlyConfig', () => {
    it('sets mode to actions', () => {
      const config = createActionsOnlyConfig();
      expect(config.mode).toBe('actions');
    });

    it('keeps StepRunner as policy authority (skip flags true)', () => {
      const config = createActionsOnlyConfig();
      expect(config.skipActionsRetry).toBe(true);
      expect(config.skipActionsNavWait).toBe(true);
    });
  });
});

describe('LegacyStepExecutor', () => {
  const mockLegacyExecuteStep = legacyExecuteStep as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLegacyExecuteStep.mockClear();
  });

  it('always uses legacy executeStep', async () => {
    const executor = new LegacyStepExecutor();
    const ctx = createMockExecCtx();
    const step = createMockStep('fill');

    await executor.execute(ctx, step, { tabId: 1 });

    expect(mockLegacyExecuteStep).toHaveBeenCalledWith(ctx, step);
  });

  it('returns executor type as legacy', async () => {
    const executor = new LegacyStepExecutor();
    const result = await executor.execute(createMockExecCtx(), createMockStep('click'), {
      tabId: 1,
    });

    expect(result.executor).toBe('legacy');
  });

  it('supports all step types', () => {
    const executor = new LegacyStepExecutor();
    expect(executor.supports('fill')).toBe(true);
    expect(executor.supports('unknown_type')).toBe(true);
  });
});

describe('HybridStepExecutor routing', () => {
  const mockLegacyExecuteStep = legacyExecuteStep as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLegacyExecuteStep.mockClear();
  });

  it('uses legacy for non-allowlisted types', async () => {
    const config = createHybridConfig({ actionsAllowlist: new Set(['fill']) });
    const mockReg = createMockRegistry();
    const executor = new HybridStepExecutor(mockReg as any, config);

    await executor.execute(
      createMockExecCtx(),
      createMockStep('click', { target: { candidates: [] } }),
      { tabId: 1 },
    );

    expect(mockLegacyExecuteStep).toHaveBeenCalled();
  });

  it('returns legacy executor type for non-allowlisted types', async () => {
    const config = createHybridConfig({ actionsAllowlist: new Set(['fill']) });
    const mockReg = createMockRegistry();
    const executor = new HybridStepExecutor(mockReg as any, config);

    const result = await executor.execute(
      createMockExecCtx(),
      createMockStep('navigate', { url: 'https://example.com' }),
      { tabId: 1 },
    );

    expect(result.executor).toBe('legacy');
  });
});

describe('createExecutor factory', () => {
  it('creates LegacyStepExecutor for legacy mode', () => {
    const executor = createExecutor({ ...DEFAULT_EXECUTION_MODE_CONFIG, mode: 'legacy' });
    expect(executor).toBeInstanceOf(LegacyStepExecutor);
  });

  it('creates ActionsStepExecutor for actions mode', () => {
    const mockReg = createMockRegistry();
    const executor = createExecutor(createActionsOnlyConfig(), mockReg as any);
    expect(executor).toBeInstanceOf(ActionsStepExecutor);
  });

  it('creates HybridStepExecutor for hybrid mode', () => {
    const mockReg = createMockRegistry();
    const executor = createExecutor(createHybridConfig(), mockReg as any);
    expect(executor).toBeInstanceOf(HybridStepExecutor);
  });

  it('throws if actions mode has no registry', () => {
    expect(() => createExecutor(createActionsOnlyConfig())).toThrow(
      'ActionRegistry required for actions execution mode',
    );
  });

  it('throws if hybrid mode has no registry', () => {
    expect(() => createExecutor(createHybridConfig())).toThrow(
      'ActionRegistry required for hybrid execution mode',
    );
  });
});

describe('MINIMAL_HYBRID_ACTION_TYPES', () => {
  it('contains only low-risk action types', () => {
    const expected = ['fill', 'key', 'scroll', 'drag', 'wait', 'delay', 'screenshot', 'assert'];
    for (const type of expected) {
      expect(MINIMAL_HYBRID_ACTION_TYPES.has(type)).toBe(true);
    }
  });

  it('excludes high-risk types (navigate, click, tab management)', () => {
    const excluded = ['navigate', 'click', 'dblclick', 'openTab', 'switchTab', 'closeTab'];
    for (const type of excluded) {
      expect(MINIMAL_HYBRID_ACTION_TYPES.has(type)).toBe(false);
    }
  });
});
