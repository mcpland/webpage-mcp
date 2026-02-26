/**
 * Execution Mode Configuration
 *
 * Controls whether step execution uses the legacy node system or the new ActionRegistry.
 * Provides a migration path from legacy to actions with hybrid mode for gradual rollout.
 *
 * Modes:
 * - 'legacy': Use the existing executeStep from nodes/index.ts (default, safest)
 * - 'actions': Use ActionRegistry exclusively (strict mode, throws on unsupported)
 * - 'hybrid': Try ActionRegistry first, fall back to legacy for unsupported types
 */

import type { Step } from '../types';

/**
 * Execution mode determines how steps are executed
 */
export type ExecutionMode = 'legacy' | 'actions' | 'hybrid';

/**
 * Configuration for execution mode
 */
export interface ExecutionModeConfig {
  /**
   * The execution mode to use
   * @default 'legacy'
   */
  mode: ExecutionMode;

  /**
   * Step types that should always use legacy execution (denylist for actions)
   * Only applies in hybrid mode
   */
  legacyOnlyTypes?: Set<string>;

  /**
   * Step types that should use actions execution (allowlist)
   * Only applies in hybrid mode.
   * - If undefined: uses MINIMAL_HYBRID_ACTION_TYPES (safest default)
   * - If empty Set (size=0): falls back to MIGRATED_ACTION_TYPES policy
   * - If non-empty Set: only these types use actions
   */
  actionsAllowlist?: Set<string>;

  /**
   * Whether to log when falling back from actions to legacy in hybrid mode
   * @default true
   */
  logFallbacks?: boolean;

  /**
   * Skip ActionRegistry's built-in retry policy.
   * When true, action.policy.retry is removed before execution.
   * @default true - StepRunner already handles retry via withRetry()
   *
   * Note: ActionRegistry timeout is NOT disabled (provides per-action timeout safety).
   */
  skipActionsRetry?: boolean;

  /**
   * Skip ActionRegistry's navigation waiting when StepRunner handles it
   * @default true - StepRunner already handles navigation waiting
   */
  skipActionsNavWait?: boolean;
}

/**
 * Default execution mode configuration
 * Starts with legacy mode for maximum safety during migration
 */
export const DEFAULT_EXECUTION_MODE_CONFIG: ExecutionModeConfig = {
  mode: 'legacy',
  logFallbacks: true,
  skipActionsRetry: true,
  skipActionsNavWait: true,
};

/**
 * Minimal allowlist for initial hybrid rollout.
 *
 * This keeps high-risk step types (navigation/click/tab management) on legacy
 * until policy (retry/timeout/nav-wait) and tab cursor semantics are unified.
 *
 * These types are chosen for their low risk:
 * - No navigation side effects
 * - No tab management
 * - No complex timing requirements
 * - Simple input/output semantics
 */
export const MINIMAL_HYBRID_ACTION_TYPES = new Set<string>([
  'fill', // Form input - no navigation
  'key', // Keyboard input - no navigation
  'scroll', // Viewport manipulation - no navigation
  'drag', // Drag and drop - local operation
  'wait', // Condition waiting - no side effects
  'delay', // Simple delay - no side effects
  'screenshot', // Capture only - no side effects
  'assert', // Validation only - no side effects
]);

/**
 * Step types that are fully migrated and tested with ActionRegistry
 * These are safe to run in actions mode
 *
 * NOTE: Start conservative and expand gradually as testing confirms equivalence.
 * Types NOT included here will fall back to legacy in hybrid mode.
 *
 * Criteria for inclusion:
 * 1. Handler implementation matches legacy behavior exactly
 * 2. Step data structure is compatible (no complex transformation needed)
 * 3. No timing-sensitive dependencies (like script when:'after' defer)
 */
export const MIGRATED_ACTION_TYPES = new Set<string>([
  // Navigation - well tested, simple mapping
  'navigate',
  // Interaction - well tested, core functionality
  'click',
  'dblclick',
  'fill',
  'key',
  'scroll',
  'drag',
  // Timing - simple logic, no complex state
  'wait',
  'delay',
  // Screenshot - simple, no side effects
  'screenshot',
  // Assert - validation only, no state changes
  'assert',
]);

/**
 * Step types that need more validation before migration
 * These are supported by ActionRegistry but may have behavior differences
 */
export const NEEDS_VALIDATION_TYPES = new Set<string>([
  // Data extraction - need to verify selector/js mode equivalence
  'extract',
  // HTTP - body type handling may differ
  'http',
  // Script - when:'after' defer semantics differ from legacy
  'script',
  // Tabs - tabId tracking needs careful integration
  'openTab',
  'switchTab',
  'closeTab',
  'handleDownload',
  // Control flow - condition evaluation may differ
  'if',
  'foreach',
  'while',
  'switchFrame',
]);

/**
 * Step types that must use legacy execution
 * These have complex integration requirements not yet supported by ActionRegistry
 */
export const LEGACY_ONLY_TYPES = new Set<string>([
  // Complex legacy types not yet migrated
  'triggerEvent',
  'setAttribute',
  'loopElements',
  'executeFlow',
]);

/**
 * Determine whether a step should use actions execution based on config
 */
export function shouldUseActions(step: Step, config: ExecutionModeConfig): boolean {
  if (config.mode === 'legacy') {
    return false;
  }

  if (config.mode === 'actions') {
    return true;
  }

  // Hybrid mode: check allowlist/denylist
  const stepType = step.type;

  // Denylist takes precedence
  if (config.legacyOnlyTypes?.has(stepType)) {
    return false;
  }

  // If allowlist is specified and non-empty, step must be in it
  if (config.actionsAllowlist && config.actionsAllowlist.size > 0) {
    return config.actionsAllowlist.has(stepType);
  }

  // Default to using actions for supported types
  return MIGRATED_ACTION_TYPES.has(stepType);
}

/**
 * Create a hybrid execution mode config for gradual migration.
 *
 * By default uses MINIMAL_HYBRID_ACTION_TYPES as allowlist, which excludes
 * high-risk types (navigate/click/tab management) from actions execution.
 *
 * @param overrides - Optional overrides for the config
 * @param overrides.actionsAllowlist - Set of step types to execute via actions.
 *   If provided with size > 0, only these types use actions.
 *   If empty Set, falls back to MIGRATED_ACTION_TYPES.
 *   If undefined, uses MINIMAL_HYBRID_ACTION_TYPES (safest default).
 */
export function createHybridConfig(overrides?: Partial<ExecutionModeConfig>): ExecutionModeConfig {
  return {
    ...DEFAULT_EXECUTION_MODE_CONFIG,
    mode: 'hybrid',
    legacyOnlyTypes: new Set(LEGACY_ONLY_TYPES),
    actionsAllowlist: new Set(MINIMAL_HYBRID_ACTION_TYPES),
    ...overrides,
  };
}

/**
 * Create a strict actions mode config for testing.
 * All steps must be handled by ActionRegistry or throw.
 *
 * Note: Even in actions mode, StepRunner remains the policy authority for
 * retry/nav-wait. This ensures consistent behavior across all execution modes
 * and avoids double-strategy issues.
 */
export function createActionsOnlyConfig(
  overrides?: Partial<ExecutionModeConfig>,
): ExecutionModeConfig {
  return {
    ...DEFAULT_EXECUTION_MODE_CONFIG,
    mode: 'actions',
    // Keep StepRunner as policy authority - skip ActionRegistry's internal policies
    skipActionsRetry: true,
    skipActionsNavWait: true,
    ...overrides,
  };
}
