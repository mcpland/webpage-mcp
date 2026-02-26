/**
 * Adapter Layer: Step ↔ Action
 *
 * Provides conversion utilities between the legacy Step system and the new Action system.
 * This adapter enables gradual migration while maintaining backward compatibility.
 *
 * Architecture:
 * - `stepToAction`: Converts a Step to an ExecutableAction
 * - `execCtxToActionCtx`: Converts ExecCtx to ActionExecutionContext
 * - `actionResultToExecResult`: Converts ActionExecutionResult to ExecResult
 * - `createStepExecutor`: Factory for a Step executor backed by ActionRegistry
 */

import type { ExecCtx, ExecResult } from '../nodes/types';
import type { Step } from '../types';
import type { ActionRegistry } from './registry';
import type {
  ActionExecutionContext,
  ActionExecutionResult,
  ActionPolicy,
  ExecutableAction,
  ExecutableActionType,
  ExecutionFlags,
  VariableStore,
} from './types';

// ================================
// Type Mapping
// ================================

/**
 * Map legacy step types to new action types
 * Most types map 1:1, but some require special handling
 */
const STEP_TYPE_TO_ACTION_TYPE: Record<string, ExecutableActionType> = {
  // Interaction
  click: 'click',
  dblclick: 'dblclick',
  fill: 'fill',
  key: 'key',
  scroll: 'scroll',
  drag: 'drag',

  // Timing
  wait: 'wait',
  delay: 'delay',

  // Validation
  assert: 'assert',

  // Data
  extract: 'extract',
  script: 'script',
  http: 'http',
  screenshot: 'screenshot',

  // Navigation / Tabs
  navigate: 'navigate',
  openTab: 'openTab',
  switchTab: 'switchTab',
  closeTab: 'closeTab',
  handleDownload: 'handleDownload',

  // Control Flow
  if: 'if',
  foreach: 'foreach',
  while: 'while',
  switchFrame: 'switchFrame',

  // TODO: Add when handlers are implemented
  // triggerEvent: 'triggerEvent',
  // setAttribute: 'setAttribute',
  // loopElements: 'loopElements',
  // executeFlow: 'executeFlow',
};

// ================================
// Context Conversion
// ================================

/**
 * Convert legacy ExecCtx to ActionExecutionContext
 */
export function execCtxToActionCtx(
  ctx: ExecCtx,
  tabId: number,
  options?: {
    stepId?: string;
    runId?: string;
    pushLog?: (entry: unknown) => void;
    /** Execution flags to pass to action handlers */
    execution?: ExecutionFlags;
  },
): ActionExecutionContext {
  // Use provided stepId for proper log attribution, fallback to 'action' only if not provided
  const logStepId = options?.stepId || 'action';
  return {
    vars: ctx.vars as VariableStore,
    tabId,
    frameId: ctx.frameId,
    runId: options?.runId,
    log: (message: string, level?: 'info' | 'warn' | 'error') => {
      ctx.logger({
        stepId: logStepId,
        status: level === 'error' ? 'failed' : level === 'warn' ? 'warning' : 'success',
        message,
      });
    },
    pushLog: options?.pushLog,
    execution: options?.execution,
  };
}

// ================================
// Step → Action Conversion
// ================================

/**
 * Convert a legacy Step to an ExecutableAction
 *
 * The conversion maps step properties to action params and policy.
 * Unknown step types are passed through as-is for forward compatibility.
 */
export function stepToAction(step: Step): ExecutableAction | null {
  const actionType = STEP_TYPE_TO_ACTION_TYPE[step.type];

  if (!actionType) {
    // Unsupported step type
    return null;
  }

  // Build policy if step has timeout or retry config
  let policy: ActionPolicy | undefined;
  if (step.timeoutMs || step.retry) {
    policy = {};

    if (step.timeoutMs) {
      policy.timeout = { ms: step.timeoutMs };
    }

    if (step.retry) {
      policy.retry = {
        retries: step.retry.count ?? 0,
        intervalMs: step.retry.intervalMs ?? 0,
        // Step backoff only supports 'none' | 'exp', map to Action backoff type
        backoff: step.retry.backoff === 'exp' ? 'exp' : 'none',
      };
    }
  }

  // Build base action - use type assertion for generic action
  // Note: Step doesn't have name/disabled at base level, they are on NodeBase
  const action = {
    id: step.id,
    type: actionType,
    params: extractParams(step),
    policy,
  } as ExecutableAction;

  return action;
}

/**
 * Legacy SelectorCandidate format: { type, value, weight? }
 * Action SelectorCandidate format: { type, selector/xpath/text/etc, weight? }
 */
interface LegacySelectorCandidate {
  type: string;
  value: string;
  weight?: number;
}

interface LegacyTargetLocator {
  ref?: string;
  candidates: LegacySelectorCandidate[];
  // Additional fields from recorder
  selector?: string;
  tag?: string;
}

/**
 * Parse legacy ARIA value format
 * Formats:
 * - "role[name=...]" (e.g., "button[name=\"Submit\"]")
 * - "aria-label=..." (role-less, just name)
 */
function parseAriaValue(value: string): { role?: string; name: string } {
  // Try "role[name=...]" format
  const roleMatch = value.match(/^([a-zA-Z]+)\[name=["']?(.+?)["']?\]$/);
  if (roleMatch) {
    return { role: roleMatch[1], name: roleMatch[2] };
  }

  // Try "aria-label=..." format
  const labelMatch = value.match(/^aria-label=["']?(.+?)["']?$/);
  if (labelMatch) {
    return { name: labelMatch[1] };
  }

  // Fallback: treat entire value as name
  return { name: value };
}

/**
 * Convert legacy SelectorCandidate to Action SelectorCandidate
 */
function convertSelectorCandidate(legacy: LegacySelectorCandidate): Record<string, unknown> {
  const base: Record<string, unknown> = { type: legacy.type };
  if (typeof legacy.weight === 'number') {
    base.weight = legacy.weight;
  }

  switch (legacy.type) {
    case 'css':
    case 'attr':
      // CSS and attr use 'selector' field
      base.selector = legacy.value;
      break;
    case 'xpath':
      // XPath uses 'xpath' field
      base.xpath = legacy.value;
      break;
    case 'text':
      // Text uses 'text' field
      base.text = legacy.value;
      break;
    case 'aria': {
      // ARIA: parse "role[name=...]" or "aria-label=..." format
      const parsed = parseAriaValue(legacy.value);
      if (parsed.role) {
        base.role = parsed.role;
      }
      base.name = parsed.name;
      break;
    }
    default:
      // Unknown type, pass through as-is
      base.value = legacy.value;
  }

  return base;
}

/**
 * Convert legacy TargetLocator to Action ElementTarget
 * Preserves additional fields like selector and tag for locator optimization
 */
function convertTargetLocator(target: LegacyTargetLocator): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (target.ref) {
    result.ref = target.ref;
  }

  // Preserve selector field for fast-path (e.g., #id selectors)
  if (typeof target.selector === 'string' && target.selector.trim()) {
    result.selector = target.selector;
  }

  // Preserve tag hint for text/aria matching
  if (typeof target.tag === 'string' && target.tag.trim()) {
    result.hint = { tagName: target.tag };
  }

  if (Array.isArray(target.candidates) && target.candidates.length > 0) {
    result.candidates = target.candidates.map(convertSelectorCandidate);
  }

  return result;
}

/**
 * Check if a value looks like a legacy TargetLocator that needs conversion
 *
 * Detection criteria:
 * 1. Must be an object with candidates array
 * 2. Candidates must use legacy format (has 'value' field, not 'selector'/'xpath'/'text')
 *
 * This prevents double-conversion of already-converted Action format targets.
 */
function isLegacyTargetLocator(value: unknown): value is LegacyTargetLocator {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;

  // Must have candidates array
  if (!Array.isArray(obj.candidates)) {
    // If only has ref without candidates, check if it's legacy format
    return typeof obj.ref === 'string' && !obj.hint;
  }

  // Check first candidate to determine format
  const firstCandidate = obj.candidates[0];
  if (!firstCandidate || typeof firstCandidate !== 'object') {
    return false;
  }

  const candidate = firstCandidate as Record<string, unknown>;
  // Legacy format uses 'value' field
  // Action format uses 'selector', 'xpath', 'text', etc. (NOT 'value')
  const hasValueField = typeof candidate.value === 'string';
  const hasActionFields =
    typeof candidate.selector === 'string' ||
    typeof candidate.xpath === 'string' ||
    typeof candidate.text === 'string' ||
    typeof candidate.name === 'string';

  // It's legacy if it has 'value' field and doesn't have action-specific fields
  return hasValueField && !hasActionFields;
}

/**
 * Extract action params from step
 * Each step type has its own param structure
 *
 * This function also converts legacy data structures to Action-compatible formats:
 * - TargetLocator.candidates: { type, value } -> { type, selector/xpath/text }
 */
function extractParams(step: Step): Record<string, unknown> {
  // The step already contains params inline, so we extract them
  // excluding common fields that go into the action base
  // Use unknown first to satisfy TypeScript's type narrowing
  const stepObj = step as unknown as Record<string, unknown>;
  const { id, type, timeoutMs, retry, screenshotOnFail, ...params } = stepObj;

  // Convert TargetLocator fields if present
  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'target' && isLegacyTargetLocator(value)) {
      converted[key] = convertTargetLocator(value);
    } else if (key === 'start' && isLegacyTargetLocator(value)) {
      // For drag step
      converted[key] = convertTargetLocator(value);
    } else if (key === 'end' && isLegacyTargetLocator(value)) {
      // For drag step
      converted[key] = convertTargetLocator(value);
    } else {
      converted[key] = value;
    }
  }

  return converted;
}

// ================================
// Result Conversion
// ================================

/**
 * Convert ActionExecutionResult to legacy ExecResult
 */
export function actionResultToExecResult(result: ActionExecutionResult): ExecResult {
  const execResult: ExecResult = {};

  // Map nextLabel for control flow
  if (result.nextLabel) {
    execResult.nextLabel = result.nextLabel;
  }

  // Map control directives
  if (result.control) {
    execResult.control = result.control;
  }

  // If action already handled logging, mark it
  if (result.status === 'success') {
    execResult.alreadyLogged = false; // Let StepRunner handle logging
  }

  return execResult;
}

// ================================
// Executor Factory
// ================================

/**
 * Result from attempting to execute a step via actions
 */
export type StepExecutionAttempt =
  | { supported: true; result: ExecResult }
  | { supported: false; reason: string };

/**
 * Options for step executor
 */
export interface StepExecutorOptions {
  runId?: string;
  pushLog?: (entry: unknown) => void;
  /**
   * If true, throws on unsupported step types instead of returning { supported: false }
   * Use this in strict mode where all steps must go through ActionRegistry
   */
  strict?: boolean;
  /**
   * Skip ActionRegistry retry policy.
   * When true, the action's retry policy is removed before execution.
   * Use this when StepRunner already handles retry via withRetry().
   */
  skipRetry?: boolean;
  /**
   * Skip navigation waiting inside action handlers.
   * When true, handlers like click/navigate skip their internal nav-wait logic.
   * Use this when StepRunner already handles navigation waiting.
   */
  skipNavWait?: boolean;
}

/**
 * Create a step executor that uses ActionRegistry
 *
 * This is the main integration point - it creates a function that can
 * replace the legacy `executeStep` call in StepRunner.
 *
 * The executor returns a discriminated union indicating whether the step
 * was supported by ActionRegistry. This allows hybrid mode to fall back
 * to legacy execution gracefully.
 */
export function createStepExecutor(registry: ActionRegistry) {
  return async function executeStepViaActions(
    ctx: ExecCtx,
    step: Step,
    tabId: number,
    options?: StepExecutorOptions,
  ): Promise<StepExecutionAttempt> {
    // Convert step to action
    let action = stepToAction(step);

    if (!action) {
      const reason = `Unsupported step type for ActionRegistry: ${step.type}`;
      if (options?.strict) {
        throw new Error(reason);
      }
      return { supported: false, reason };
    }

    // Skip retry policy if StepRunner handles it
    // This avoids double retry: StepRunner.withRetry() + ActionRegistry.retry
    if (options?.skipRetry === true && action.policy?.retry) {
      action = { ...action, policy: { ...action.policy, retry: undefined } };
    }

    // Check if handler exists
    const handler = registry.get(action.type);
    if (!handler) {
      const reason = `No handler registered for action type: ${action.type}`;
      if (options?.strict) {
        throw new Error(reason);
      }
      return { supported: false, reason };
    }

    // Build execution flags for handlers
    const execution: ExecutionFlags | undefined =
      options?.skipNavWait === true ? { skipNavWait: true } : undefined;

    // Convert context with proper stepId for log attribution
    const actionCtx = execCtxToActionCtx(ctx, tabId, {
      stepId: step.id,
      runId: options?.runId,
      pushLog: options?.pushLog,
      execution,
    });

    // Execute via registry (includes retry, timeout, hooks)
    const result = await registry.execute(actionCtx, action);

    // Handle failure - still return as supported, but throw the error
    if (result.status === 'failed') {
      const error = result.error;
      throw new Error(
        error?.message || `Action ${action.type} failed: ${error?.code || 'UNKNOWN'}`,
      );
    }

    // Sync vars back (in case action modified them)
    Object.assign(ctx.vars, actionCtx.vars);

    // Sync frameId back (in case switchFrame modified it)
    if (actionCtx.frameId !== undefined) {
      ctx.frameId = actionCtx.frameId;
    }

    // Sync tabId back (in case openTab/switchTab changed it)
    // Chrome tabId is always a positive safe integer
    if (result.status === 'success') {
      const nextTabId = result.newTabId;
      if (typeof nextTabId === 'number' && Number.isSafeInteger(nextTabId) && nextTabId > 0) {
        ctx.tabId = nextTabId;
      }
    }

    // Convert result
    return { supported: true, result: actionResultToExecResult(result) };
  };
}

// ================================
// Type Guards
// ================================

/**
 * Check if a step type is supported by ActionRegistry
 */
export function isActionSupported(stepType: string): boolean {
  return stepType in STEP_TYPE_TO_ACTION_TYPE;
}

/**
 * Get the action type for a step type
 */
export function getActionType(stepType: string): ExecutableActionType | undefined {
  return STEP_TYPE_TO_ACTION_TYPE[stepType];
}
