/**
 * Click and Double-Click Action Handlers
 *
 * Handles click interactions:
 * - Single click
 * - Double click
 * - Post-click navigation/network wait
 * - Selector fallback with logging
 */

import { handleCallTool } from '@/entrypoints/background/tools';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { ENGINE_CONSTANTS } from '../../engine/constants';
import {
  maybeQuickWaitForNav,
  waitForNavigationDone,
  waitForNetworkIdle,
} from '../../engine/policies/wait';
import { failed, invalid, ok } from '../registry';
import type {
  Action,
  ActionExecutionContext,
  ActionExecutionResult,
  ActionHandler,
} from '../types';
import {
  clampInt,
  ensureElementVisible,
  logSelectorFallback,
  readTabUrl,
  selectorLocator,
  toSelectorTarget,
} from './common';

/**
 * Shared click execution logic for both click and dblclick
 */
async function executeClick<T extends 'click' | 'dblclick'>(
  ctx: ActionExecutionContext,
  action: Action<T>,
): Promise<ActionExecutionResult<T>> {
  const vars = ctx.vars;
  const tabId = ctx.tabId;
  // Check if StepRunner owns nav-wait (skip internal nav-wait logic)
  const skipNavWait = ctx.execution?.skipNavWait === true;

  if (typeof tabId !== 'number') {
    return failed('TAB_NOT_FOUND', 'No active tab found');
  }

  // Ensure page is read before locating element
  await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: { tabId } });

  // Only read beforeUrl if we need to do nav-wait
  const beforeUrl = skipNavWait ? '' : await readTabUrl(tabId);
  const { selectorTarget, firstCandidateType, firstCssOrAttr } = toSelectorTarget(
    action.params.target,
    vars,
  );

  // Locate element using shared selector locator
  const located = await selectorLocator.locate(tabId, selectorTarget, {
    frameId: ctx.frameId,
    preferRef: false,
  });

  const frameId = located?.frameId ?? ctx.frameId;
  const refToUse = located?.ref ?? selectorTarget.ref;
  const selectorToUse = !located?.ref ? firstCssOrAttr : undefined;

  if (!refToUse && !selectorToUse) {
    return failed('TARGET_NOT_FOUND', 'Could not locate target element');
  }

  // Verify element visibility if we have a ref
  if (located?.ref) {
    const isVisible = await ensureElementVisible(tabId, located.ref, frameId);
    if (!isVisible) {
      return failed('ELEMENT_NOT_VISIBLE', 'Target element is not visible');
    }
  }

  // Execute click with tool timeout
  const toolTimeout = clampInt(action.policy?.timeout?.ms ?? 10000, 1000, 30000);

  const clickResult = await handleCallTool({
    name: TOOL_NAMES.BROWSER.CLICK,
    args: {
      ref: refToUse,
      selector: selectorToUse,
      waitForNavigation: false,
      timeout: toolTimeout,
      frameId,
      tabId,
      double: action.type === 'dblclick',
    },
  });

  if ((clickResult as { isError?: boolean })?.isError) {
    const errorContent = (clickResult as { content?: Array<{ text?: string }> })?.content;
    const errorMsg = errorContent?.[0]?.text || `${action.type} action failed`;
    return failed('UNKNOWN', errorMsg);
  }

  // Log selector fallback if used
  const resolvedBy = located?.resolvedBy || (located?.ref ? 'ref' : '');
  const fallbackUsed =
    resolvedBy && firstCandidateType && resolvedBy !== 'ref' && resolvedBy !== firstCandidateType;

  if (fallbackUsed) {
    logSelectorFallback(ctx, action.id, String(firstCandidateType), String(resolvedBy));
  }

  // Skip post-click wait if StepRunner handles it
  if (skipNavWait) {
    return { status: 'success' };
  }

  // Post-click wait handling (only when handler owns nav-wait)
  const waitMs = clampInt(
    action.policy?.timeout?.ms ?? ENGINE_CONSTANTS.DEFAULT_WAIT_MS,
    0,
    ENGINE_CONSTANTS.MAX_WAIT_MS,
  );
  const after = action.params.after ?? {};

  if (after.waitForNavigation) {
    await waitForNavigationDone(beforeUrl, waitMs, tabId);
  } else if (after.waitForNetworkIdle) {
    const totalMs = clampInt(waitMs, 1000, ENGINE_CONSTANTS.MAX_WAIT_MS);
    const idleMs = Math.min(1500, Math.max(500, Math.floor(totalMs / 3)));
    await waitForNetworkIdle(totalMs, idleMs, tabId);
  } else {
    // Quick sniff for navigation that might have been triggered
    await maybeQuickWaitForNav(beforeUrl, waitMs, tabId);
  }

  return { status: 'success' };
}

/**
 * Validate click target configuration
 */
function validateClickTarget(target: {
  ref?: string;
  candidates?: unknown[];
}): { ok: true } | { ok: false; errors: [string, ...string[]] } {
  const hasRef = typeof target?.ref === 'string' && target.ref.trim().length > 0;
  const hasCandidates = Array.isArray(target?.candidates) && target.candidates.length > 0;

  if (hasRef || hasCandidates) {
    return ok();
  }
  return invalid('Missing target selector or ref');
}

export const clickHandler: ActionHandler<'click'> = {
  type: 'click',

  validate: (action) =>
    validateClickTarget(action.params.target as { ref?: string; candidates?: unknown[] }),

  describe: (action) => {
    const target = action.params.target;
    if (typeof (target as { ref?: string }).ref === 'string') {
      return `Click element ${(target as { ref: string }).ref}`;
    }
    return 'Click element';
  },

  run: async (ctx, action) => {
    return await executeClick(ctx, action);
  },
};

export const dblclickHandler: ActionHandler<'dblclick'> = {
  type: 'dblclick',

  validate: (action) =>
    validateClickTarget(action.params.target as { ref?: string; candidates?: unknown[] }),

  describe: (action) => {
    const target = action.params.target;
    if (typeof (target as { ref?: string }).ref === 'string') {
      return `Double-click element ${(target as { ref: string }).ref}`;
    }
    return 'Double-click element';
  },

  run: async (ctx, action) => {
    return await executeClick(ctx, action);
  },
};
