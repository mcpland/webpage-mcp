/**
 * Control Flow Action Handlers
 *
 * Handles flow control operations:
 * - if: Conditional branching
 * - foreach: Loop over array
 * - while: Loop with condition
 * - switchFrame: Switch to a different frame
 *
 * Note: The actual loop iteration is handled by the Scheduler.
 * These handlers return control directives that tell the Scheduler how to proceed.
 */

import {
  failed,
  invalid,
  ok,
  tryResolveNumber,
  tryResolveString,
  tryResolveValue,
} from '../registry';
import type {
  ActionHandler,
  Condition,
  ControlDirective,
  EdgeLabel,
  VariableStore,
} from '../types';

/** Default max iterations for while loops */
const DEFAULT_MAX_ITERATIONS = 1000;

// ================================
// Condition Evaluation
// ================================

/**
 * Evaluate a condition against variables
 */
function evaluateCondition(condition: Condition, vars: VariableStore): boolean {
  switch (condition.kind) {
    case 'expr': {
      // Expression evaluation not supported in default resolver
      // Return false for safety
      return false;
    }

    case 'compare': {
      const leftResult = tryResolveValue(condition.left, vars);
      const rightResult = tryResolveValue(condition.right, vars);

      if (!leftResult.ok || !rightResult.ok) return false;

      const left = leftResult.value;
      const right = rightResult.value;

      switch (condition.op) {
        case 'eq':
          return left === right;
        case 'eqi':
          return String(left).toLowerCase() === String(right).toLowerCase();
        case 'neq':
          return left !== right;
        case 'gt':
          return Number(left) > Number(right);
        case 'gte':
          return Number(left) >= Number(right);
        case 'lt':
          return Number(left) < Number(right);
        case 'lte':
          return Number(left) <= Number(right);
        case 'contains':
          return String(left).includes(String(right));
        case 'containsI':
          return String(left).toLowerCase().includes(String(right).toLowerCase());
        case 'notContains':
          return !String(left).includes(String(right));
        case 'notContainsI':
          return !String(left).toLowerCase().includes(String(right).toLowerCase());
        case 'startsWith':
          return String(left).startsWith(String(right));
        case 'endsWith':
          return String(left).endsWith(String(right));
        case 'regex': {
          try {
            const regex = new RegExp(String(right));
            return regex.test(String(left));
          } catch {
            return false;
          }
        }
        default:
          return false;
      }
    }

    case 'truthy': {
      const result = tryResolveValue(condition.value, vars);
      if (!result.ok) return false;
      return Boolean(result.value);
    }

    case 'falsy': {
      const result = tryResolveValue(condition.value, vars);
      if (!result.ok) return true;
      return !result.value;
    }

    case 'not':
      return !evaluateCondition(condition.condition, vars);

    case 'and':
      return condition.conditions.every((c) => evaluateCondition(c, vars));

    case 'or':
      return condition.conditions.some((c) => evaluateCondition(c, vars));

    default:
      return false;
  }
}

// ================================
// if Handler
// ================================

export const ifHandler: ActionHandler<'if'> = {
  type: 'if',

  validate: (action) => {
    const params = action.params;

    if (params.mode === 'binary') {
      if (!params.condition) {
        return invalid('Binary if requires a condition');
      }
    } else if (params.mode === 'branches') {
      if (!params.branches || params.branches.length === 0) {
        return invalid('Branches if requires at least one branch');
      }
    } else {
      return invalid(`Unknown if mode: ${String((params as { mode: string }).mode)}`);
    }

    return ok();
  },

  describe: (action) => {
    if (action.params.mode === 'binary') {
      return 'If condition';
    }
    const branchCount = action.params.mode === 'branches' ? action.params.branches.length : 0;
    return `If (${branchCount} branches)`;
  },

  run: async (ctx, action) => {
    const params = action.params;

    if (params.mode === 'binary') {
      const result = evaluateCondition(params.condition, ctx.vars);
      const label: EdgeLabel = result
        ? (params.trueLabel ?? 'true')
        : (params.falseLabel ?? 'false');
      return { status: 'success', nextLabel: label };
    }

    // Branches mode
    if (params.mode === 'branches') {
      for (const branch of params.branches) {
        if (evaluateCondition(branch.condition, ctx.vars)) {
          return { status: 'success', nextLabel: branch.label };
        }
      }
      // No branch matched, use else label
      const elseLabel = params.elseLabel ?? 'default';
      return { status: 'success', nextLabel: elseLabel };
    }

    return failed('VALIDATION_ERROR', 'Invalid if mode');
  },
};

// ================================
// foreach Handler
// ================================

export const foreachHandler: ActionHandler<'foreach'> = {
  type: 'foreach',

  validate: (action) => {
    const params = action.params;

    if (!params.listVar) {
      return invalid('foreach requires a listVar');
    }

    if (!params.subflowId) {
      return invalid('foreach requires a subflowId');
    }

    return ok();
  },

  describe: (action) => {
    return `For each in ${action.params.listVar}`;
  },

  run: async (ctx, action) => {
    const params = action.params;

    // Check if listVar exists and is an array
    const list = ctx.vars[params.listVar];
    if (!Array.isArray(list)) {
      return failed('VALIDATION_ERROR', `Variable "${params.listVar}" is not an array`);
    }

    if (list.length === 0) {
      // Empty list, nothing to iterate
      return { status: 'success' };
    }

    // Return control directive for scheduler to handle
    const directive: ControlDirective = {
      kind: 'foreach',
      listVar: params.listVar,
      itemVar: params.itemVar || 'item',
      subflowId: params.subflowId,
      concurrency: params.concurrency,
    };

    return { status: 'success', control: directive };
  },
};

// ================================
// while Handler
// ================================

export const whileHandler: ActionHandler<'while'> = {
  type: 'while',

  validate: (action) => {
    const params = action.params;

    if (!params.condition) {
      return invalid('while requires a condition');
    }

    if (!params.subflowId) {
      return invalid('while requires a subflowId');
    }

    return ok();
  },

  describe: () => {
    return 'While loop';
  },

  run: async (ctx, action) => {
    const params = action.params;

    // Check if condition is currently true
    const conditionResult = evaluateCondition(params.condition, ctx.vars);

    if (!conditionResult) {
      // Condition is false, don't enter loop
      return { status: 'success' };
    }

    // Return control directive for scheduler to handle
    const directive: ControlDirective = {
      kind: 'while',
      condition: params.condition,
      subflowId: params.subflowId,
      maxIterations: params.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    };

    return { status: 'success', control: directive };
  },
};

// ================================
// switchFrame Handler
// ================================

export const switchFrameHandler: ActionHandler<'switchFrame'> = {
  type: 'switchFrame',

  validate: (action) => {
    const target = action.params.target;

    if (!target) {
      return invalid('switchFrame requires a target');
    }

    if (target.kind !== 'top' && target.kind !== 'index' && target.kind !== 'urlContains') {
      return invalid(`Unknown frame target kind: ${String((target as { kind: string }).kind)}`);
    }

    return ok();
  },

  describe: (action) => {
    const target = action.params.target;
    if (target.kind === 'top') return 'Switch to top frame';
    if (target.kind === 'index') return `Switch to frame #${target.index}`;
    if (target.kind === 'urlContains') return 'Switch frame (by URL)';
    return 'Switch frame';
  },

  run: async (ctx, action) => {
    const target = action.params.target;
    const tabId = ctx.tabId;

    if (typeof tabId !== 'number') {
      return failed('TAB_NOT_FOUND', 'No active tab found');
    }

    try {
      if (target.kind === 'top') {
        // Reset to main frame (frameId = 0)
        ctx.frameId = 0;
        return { status: 'success' };
      }

      // Get all frames in the tab
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      if (!frames || frames.length === 0) {
        return failed('FRAME_NOT_FOUND', 'No frames found in tab');
      }

      let targetFrame: chrome.webNavigation.GetAllFrameResultDetails | undefined;

      if (target.kind === 'index') {
        const indexResult = tryResolveNumber(target.index, ctx.vars);
        if (!indexResult.ok) {
          return failed('VALIDATION_ERROR', `Failed to resolve frame index: ${indexResult.error}`);
        }
        const index = Math.floor(indexResult.value);

        // Find frame by index (excluding main frame which is 0)
        const childFrames = frames.filter((f) => f.frameId !== 0);
        if (index < 0 || index >= childFrames.length) {
          return failed(
            'FRAME_NOT_FOUND',
            `Frame index ${index} out of bounds (${childFrames.length} frames)`,
          );
        }
        targetFrame = childFrames[index];
      } else if (target.kind === 'urlContains') {
        const urlResult = tryResolveString(target.value, ctx.vars);
        if (!urlResult.ok) {
          return failed('VALIDATION_ERROR', `Failed to resolve URL pattern: ${urlResult.error}`);
        }
        const urlPattern = urlResult.value.trim().toLowerCase();

        // Empty pattern is invalid
        if (!urlPattern) {
          return failed('VALIDATION_ERROR', 'URL pattern cannot be empty');
        }

        targetFrame = frames.find((f) => f.url && f.url.toLowerCase().includes(urlPattern));
      }

      if (!targetFrame) {
        return failed('FRAME_NOT_FOUND', 'No matching frame found');
      }

      // The frameId will be used by subsequent actions
      // Store it in context (this is typically handled by scheduler)
      ctx.frameId = targetFrame.frameId;

      return { status: 'success' };
    } catch (e) {
      return failed(
        'FRAME_NOT_FOUND',
        `Failed to switch frame: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};
