/**
 * Step Executor Interface
 *
 * Provides a unified interface for step execution that supports multiple execution modes.
 * This abstraction allows seamless switching between legacy and actions execution.
 *
 * Architecture:
 * - StepExecutorInterface: Base interface for all executors
 * - LegacyStepExecutor: Uses the existing executeStep from nodes/
 * - ActionsStepExecutor: Uses ActionRegistry from actions/
 * - HybridStepExecutor: Tries actions first, falls back to legacy
 */

import type { Step } from '../../types';
import type { ExecCtx, ExecResult } from '../../nodes/types';
import { executeStep as legacyExecuteStep } from '../../nodes';
import type { ActionRegistry } from '../../actions/registry';
import {
  createStepExecutor,
  isActionSupported,
  type StepExecutionAttempt,
} from '../../actions/adapter';
import type { ExecutionModeConfig } from '../execution-mode';
import { shouldUseActions } from '../execution-mode';

/**
 * Step execution result with additional metadata
 */
export interface StepExecutionResult {
  /** The execution result from the step */
  result: ExecResult;
  /** Which executor was used */
  executor: 'legacy' | 'actions';
  /** Whether fallback was used (only in hybrid mode) */
  fallback?: boolean;
  /** Reason for fallback (only when fallback=true) */
  fallbackReason?: string;
}

/**
 * Options for step execution
 */
export interface StepExecutionOptions {
  /** Current tab ID */
  tabId: number;
  /** Run ID for logging/tracing */
  runId?: string;
  /** Logger for recording fallback information */
  pushLog?: (entry: unknown) => void;
  /** Remaining time budget from global deadline */
  remainingBudgetMs?: number;
}

/**
 * Base interface for step executors
 */
export interface StepExecutorInterface {
  /**
   * Execute a single step
   */
  execute(ctx: ExecCtx, step: Step, options: StepExecutionOptions): Promise<StepExecutionResult>;

  /**
   * Check if executor supports a step type
   */
  supports(stepType: string): boolean;
}

/**
 * Legacy step executor using nodes/executeStep
 *
 * This executor delegates to the existing node execution system.
 * The options parameter is accepted but not used - retry/timeout/navigation
 * waiting are handled by StepRunner to maintain existing behavior.
 */
export class LegacyStepExecutor implements StepExecutorInterface {
  async execute(
    ctx: ExecCtx,
    step: Step,
    _options: StepExecutionOptions,
  ): Promise<StepExecutionResult> {
    // Note: tabId from options is not used here because legacy executeStep
    // queries the active tab internally. In hybrid/actions mode, tabId is
    // passed through to ActionRegistry handlers.
    const result = await legacyExecuteStep(ctx, step);
    return {
      result: result || {},
      executor: 'legacy',
    };
  }

  supports(_stepType: string): boolean {
    // Legacy executor supports all step types via its own registry
    return true;
  }
}

/**
 * Actions step executor using ActionRegistry
 *
 * In strict mode, any unsupported step type throws an error.
 * This executor does NOT fall back to legacy - use HybridStepExecutor for fallback behavior.
 *
 * Respects ExecutionModeConfig for:
 * - skipActionsRetry: Disables ActionRegistry retry (StepRunner owns retry)
 * - skipActionsNavWait: Disables handler nav-wait (StepRunner owns nav-wait)
 */
export class ActionsStepExecutor implements StepExecutorInterface {
  private executor: ReturnType<typeof createStepExecutor>;

  constructor(
    private registry: ActionRegistry,
    private config: ExecutionModeConfig,
  ) {
    this.executor = createStepExecutor(registry);
  }

  async execute(
    ctx: ExecCtx,
    step: Step,
    options: StepExecutionOptions,
  ): Promise<StepExecutionResult> {
    // Use strict=true: throws on unsupported types instead of returning { supported: false }
    // This ensures all steps must be handled by ActionRegistry in actions-only mode
    const attempt = (await this.executor(ctx, step, options.tabId, {
      runId: options.runId,
      pushLog: options.pushLog,
      strict: true,
      // Pass policy skip flags from config (default to true = skip)
      skipRetry: this.config.skipActionsRetry !== false,
      skipNavWait: this.config.skipActionsNavWait !== false,
    })) as StepExecutionAttempt;

    // With strict=true, we should never get { supported: false } - it would throw instead
    // This check exists for type safety and defensive programming
    if (!attempt.supported) {
      throw new Error(attempt.reason);
    }

    return {
      result: attempt.result,
      executor: 'actions',
    };
  }

  supports(stepType: string): boolean {
    // Use adapter's type guard to check if step type is supported
    return isActionSupported(stepType);
  }
}

/**
 * Hybrid step executor that tries actions first, falls back to legacy
 *
 * Respects ExecutionModeConfig for:
 * - actionsAllowlist/legacyOnlyTypes: Controls which steps use actions vs legacy
 * - skipActionsRetry: Disables ActionRegistry retry (StepRunner owns retry)
 * - skipActionsNavWait: Disables handler nav-wait (StepRunner owns nav-wait)
 * - logFallbacks: Whether to log when falling back to legacy
 */
export class HybridStepExecutor implements StepExecutorInterface {
  private actionsExecutor: ReturnType<typeof createStepExecutor>;

  constructor(
    private registry: ActionRegistry,
    private config: ExecutionModeConfig,
  ) {
    this.actionsExecutor = createStepExecutor(registry);
  }

  async execute(
    ctx: ExecCtx,
    step: Step,
    options: StepExecutionOptions,
  ): Promise<StepExecutionResult> {
    // Check if step should use actions based on config
    if (!shouldUseActions(step, this.config)) {
      // Use legacy directly
      const result = await legacyExecuteStep(ctx, step);
      return {
        result: result || {},
        executor: 'legacy',
      };
    }

    // Try actions first
    const attempt = (await this.actionsExecutor(ctx, step, options.tabId, {
      runId: options.runId,
      pushLog: options.pushLog,
      strict: false, // Don't throw on unsupported, return { supported: false }
      // Pass policy skip flags from config (default to true = skip)
      skipRetry: this.config.skipActionsRetry !== false,
      skipNavWait: this.config.skipActionsNavWait !== false,
    })) as StepExecutionAttempt;

    if (attempt.supported) {
      return {
        result: attempt.result,
        executor: 'actions',
      };
    }

    // Fall back to legacy
    if (this.config.logFallbacks) {
      options.pushLog?.({
        stepId: step.id,
        status: 'warning',
        message: `Falling back to legacy execution: ${attempt.reason}`,
      });
    }

    const legacyResult = await legacyExecuteStep(ctx, step);
    return {
      result: legacyResult || {},
      executor: 'legacy',
      fallback: true,
      fallbackReason: attempt.reason,
    };
  }

  supports(stepType: string): boolean {
    // Hybrid executor supports all types (via fallback)
    return true;
  }
}

/**
 * Factory function to create the appropriate executor based on config
 */
export function createExecutor(
  config: ExecutionModeConfig,
  registry?: ActionRegistry,
): StepExecutorInterface {
  switch (config.mode) {
    case 'legacy':
      return new LegacyStepExecutor();

    case 'actions':
      if (!registry) {
        throw new Error('ActionRegistry required for actions execution mode');
      }
      return new ActionsStepExecutor(registry, config);

    case 'hybrid':
      if (!registry) {
        throw new Error('ActionRegistry required for hybrid execution mode');
      }
      return new HybridStepExecutor(registry, config);

    default: {
      // TypeScript exhaustiveness check
      const _exhaustive: never = config.mode;
      throw new Error(`Unknown execution mode: ${_exhaustive}`);
    }
  }
}
