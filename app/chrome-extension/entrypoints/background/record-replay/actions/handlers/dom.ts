/**
 * DOM Tools Action Handlers
 *
 * Handles DOM manipulation actions:
 * - triggerEvent: Dispatch a custom DOM Event on an element
 * - setAttribute: Set or remove an attribute on an element
 *
 * Design notes:
 * - Both handlers follow the same pattern as click.ts
 * - Element location uses selectorLocator from shared code
 * - CSS selector resolution supports ref fallback
 */

import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { handleCallTool } from '@/entrypoints/background/tools';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { failed, invalid, ok, tryResolveJson } from '../registry';
import type {
  ActionExecutionResult,
  ActionHandler,
  ElementTarget,
  JsonValue,
  VariableStore,
} from '../types';
import {
  hasElementTargetSpec,
  interpolateBraces,
  logSelectorFallback,
  resolveString,
  selectorLocator,
  sendMessageToTab,
  toSelectorTarget,
} from './common';

// ================================
// Type Definitions
// ================================

interface ResolveRefResponse {
  success?: boolean;
  selector?: string;
  error?: string;
}

interface DomScriptResult {
  success: boolean;
  error?: string;
}

interface ResolvedTarget {
  selector: string;
  frameId: number | undefined;
  firstCandidateType?: string;
  resolvedBy?: string;
}

// ================================
// Shared Utilities
// ================================

/**
 * Strip frame prefix from composite selector (e.g., "frame|>selector" -> "selector")
 */
function stripCompositePrefix(selector: string): string {
  const raw = String(selector || '').trim();
  if (!raw.includes('|>')) return raw;

  const parts = raw
    .split('|>')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : raw;
}

/**
 * Resolve ElementTarget to a CSS selector string
 *
 * Resolution order:
 * 1. Try to locate element using selectorLocator
 * 2. If ref found, resolve it to CSS selector via content script
 * 3. Fall back to first CSS/attr candidate if no ref
 */
async function resolveTargetSelector(
  tabId: number,
  target: ElementTarget,
  vars: VariableStore,
  contextFrameId: number | undefined,
): Promise<{ ok: true; value: ResolvedTarget } | { ok: false; error: string }> {
  const { selectorTarget, firstCandidateType, firstCssOrAttr } = toSelectorTarget(target, vars);

  // Locate element using shared selector locator
  const located = await selectorLocator.locate(tabId, selectorTarget, {
    frameId: contextFrameId,
    preferRef: false,
    verifyFingerprint: true,
  });

  const frameId = located?.frameId ?? contextFrameId;
  const refToUse = located?.ref ?? selectorTarget.ref;

  // Must have either ref or CSS/attr candidate
  if (!refToUse && !firstCssOrAttr) {
    return { ok: false, error: 'Could not locate target element' };
  }

  let selector: string | undefined;

  // Try to resolve ref to CSS selector
  if (refToUse) {
    const resolved = await sendMessageToTab<ResolveRefResponse>(
      tabId,
      { action: TOOL_MESSAGE_TYPES.RESOLVE_REF, ref: refToUse },
      frameId,
    );

    if (resolved.ok && resolved.value?.success !== false && resolved.value?.selector) {
      const sel = resolved.value.selector.trim();
      if (sel) selector = sel;
    }
  }

  // Fall back to CSS/attr candidate
  if (!selector && firstCssOrAttr) {
    const stripped = stripCompositePrefix(firstCssOrAttr);
    if (stripped) selector = stripped;
  }

  if (!selector) {
    return { ok: false, error: 'Could not resolve a CSS selector for the target element' };
  }

  return {
    ok: true,
    value: {
      selector,
      frameId,
      firstCandidateType,
      // Only mark as 'ref' if locator actually resolved via ref
      resolvedBy: located?.resolvedBy || (located?.ref ? 'ref' : undefined),
    },
  };
}

/**
 * Log selector fallback if a different selector type was used
 */
function maybeLogFallback(
  ctx: Parameters<typeof logSelectorFallback>[0],
  actionId: string,
  resolved: ResolvedTarget,
): void {
  const { resolvedBy, firstCandidateType } = resolved;

  const fallbackUsed =
    resolvedBy && firstCandidateType && resolvedBy !== 'ref' && resolvedBy !== firstCandidateType;

  if (fallbackUsed) {
    logSelectorFallback(ctx, actionId, String(firstCandidateType), String(resolvedBy));
  }
}

// ================================
// triggerEvent Handler
// ================================

export const triggerEventHandler: ActionHandler<'triggerEvent'> = {
  type: 'triggerEvent',

  validate: (action) => {
    if (!hasElementTargetSpec(action.params.target)) {
      return invalid('triggerEvent requires a target ref, selector, or selector candidates');
    }

    const event = action.params.event;
    if (event === undefined || event === null) {
      return invalid('Missing event parameter');
    }
    if (typeof event === 'string' && event.trim().length === 0) {
      return invalid('event must be a non-empty string');
    }

    return ok();
  },

  describe: (action) => {
    const ev = typeof action.params.event === 'string' ? action.params.event : '(dynamic)';
    const display = ev.length > 30 ? ev.slice(0, 30) + '...' : ev;
    return `Trigger event "${display}"`;
  },

  run: async (ctx, action): Promise<ActionExecutionResult<'triggerEvent'>> => {
    const { tabId, vars, frameId } = ctx;

    if (typeof tabId !== 'number') {
      return failed('TAB_NOT_FOUND', 'No active tab found for triggerEvent action');
    }

    // Resolve event type
    const eventResolved = resolveString(action.params.event, vars);
    if (!eventResolved.ok) {
      return failed('VALIDATION_ERROR', eventResolved.error);
    }

    const eventType = eventResolved.value.trim();
    if (!eventType) {
      return failed('VALIDATION_ERROR', 'Event type is empty');
    }

    // Event options
    const bubbles = action.params.bubbles !== false;
    const cancelable = action.params.cancelable === true;

    // Ensure page is read for element location
    await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: { tabId } });

    // Resolve target selector
    const targetResolved = await resolveTargetSelector(tabId, action.params.target, vars, frameId);
    if (!targetResolved.ok) {
      return failed('TARGET_NOT_FOUND', targetResolved.error);
    }

    const { selector, frameId: resolvedFrameId } = targetResolved.value;
    const frameIds = typeof resolvedFrameId === 'number' ? [resolvedFrameId] : undefined;

    // Execute event dispatch in page context
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId, frameIds } as chrome.scripting.InjectionTarget,
        world: 'MAIN',
        func: (
          sel: string,
          type: string,
          bubbles: boolean,
          cancelable: boolean,
        ): DomScriptResult => {
          try {
            const el = document.querySelector(sel);
            if (!el) {
              // Use special error code to distinguish from script execution errors
              return { success: false, error: `[TARGET_NOT_FOUND] Element not found: ${sel}` };
            }

            const event = new Event(type, { bubbles, cancelable });
            el.dispatchEvent(event);
            return { success: true };
          } catch (e) {
            return { success: false, error: e instanceof Error ? e.message : String(e) };
          }
        },
        args: [selector, eventType, bubbles, cancelable],
      });

      const result = Array.isArray(injected) ? injected[0]?.result : undefined;
      if (!result || typeof result !== 'object') {
        return failed('SCRIPT_FAILED', 'triggerEvent script returned invalid result');
      }

      const typed = result as DomScriptResult;
      if (!typed.success) {
        // Parse error code from message if present (e.g., "[TARGET_NOT_FOUND] ...")
        const errorMsg = typed.error || `Failed to dispatch "${eventType}"`;
        const code = errorMsg.startsWith('[TARGET_NOT_FOUND]')
          ? 'TARGET_NOT_FOUND'
          : 'SCRIPT_FAILED';
        return failed(code, errorMsg.replace(/^\[TARGET_NOT_FOUND\]\s*/, ''));
      }
    } catch (e) {
      return failed(
        'SCRIPT_FAILED',
        `Failed to trigger event "${eventType}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    maybeLogFallback(ctx, action.id, targetResolved.value);

    return { status: 'success' };
  },
};

// ================================
// setAttribute Handler
// ================================

export const setAttributeHandler: ActionHandler<'setAttribute'> = {
  type: 'setAttribute',

  validate: (action) => {
    if (!hasElementTargetSpec(action.params.target)) {
      return invalid('setAttribute requires a target ref, selector, or selector candidates');
    }

    const name = action.params.name;
    if (name === undefined || name === null) {
      return invalid('Missing name parameter');
    }
    if (typeof name === 'string' && name.trim().length === 0) {
      return invalid('name must be a non-empty string');
    }

    return ok();
  },

  describe: (action) => {
    const name = typeof action.params.name === 'string' ? action.params.name : '(dynamic)';
    const display = name.length > 30 ? name.slice(0, 30) + '...' : name;
    return action.params.remove ? `Remove attribute "${display}"` : `Set attribute "${display}"`;
  },

  run: async (ctx, action): Promise<ActionExecutionResult<'setAttribute'>> => {
    const { tabId, vars, frameId } = ctx;

    if (typeof tabId !== 'number') {
      return failed('TAB_NOT_FOUND', 'No active tab found for setAttribute action');
    }

    // Resolve attribute name
    const nameResolved = resolveString(action.params.name, vars);
    if (!nameResolved.ok) {
      return failed('VALIDATION_ERROR', nameResolved.error);
    }

    const attrName = nameResolved.value.trim();
    if (!attrName) {
      return failed('VALIDATION_ERROR', 'Attribute name is empty');
    }

    const remove = action.params.remove === true;

    // Resolve attribute value (only if not removing)
    let attrValue: JsonValue = null;
    if (!remove && action.params.value !== undefined) {
      const valueResolved = tryResolveJson(action.params.value, vars);
      if (!valueResolved.ok) {
        return failed('VALIDATION_ERROR', valueResolved.error);
      }

      // Apply template interpolation for string values
      attrValue =
        typeof valueResolved.value === 'string'
          ? interpolateBraces(valueResolved.value, vars)
          : valueResolved.value;
    }

    // Ensure page is read for element location
    await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: { tabId } });

    // Resolve target selector
    const targetResolved = await resolveTargetSelector(tabId, action.params.target, vars, frameId);
    if (!targetResolved.ok) {
      return failed('TARGET_NOT_FOUND', targetResolved.error);
    }

    const { selector, frameId: resolvedFrameId } = targetResolved.value;
    const frameIds = typeof resolvedFrameId === 'number' ? [resolvedFrameId] : undefined;

    // Execute attribute modification in page context
    try {
      const injected = await chrome.scripting.executeScript({
        target: { tabId, frameIds } as chrome.scripting.InjectionTarget,
        world: 'MAIN',
        func: (sel: string, name: string, value: JsonValue, remove: boolean): DomScriptResult => {
          try {
            const el = document.querySelector(sel);
            if (!el) {
              // Use special error code to distinguish from script execution errors
              return { success: false, error: `[TARGET_NOT_FOUND] Element not found: ${sel}` };
            }

            if (remove) {
              el.removeAttribute(name);
            } else {
              // Convert value to string for setAttribute
              const strValue =
                value === null || value === undefined
                  ? ''
                  : typeof value === 'string'
                    ? value
                    : String(value);
              el.setAttribute(name, strValue);
            }

            return { success: true };
          } catch (e) {
            return { success: false, error: e instanceof Error ? e.message : String(e) };
          }
        },
        args: [selector, attrName, attrValue, remove],
      });

      const result = Array.isArray(injected) ? injected[0]?.result : undefined;
      if (!result || typeof result !== 'object') {
        return failed('SCRIPT_FAILED', 'setAttribute script returned invalid result');
      }

      const typed = result as DomScriptResult;
      if (!typed.success) {
        const actionDesc = remove ? 'remove' : 'set';
        // Parse error code from message if present (e.g., "[TARGET_NOT_FOUND] ...")
        const errorMsg = typed.error || `Failed to ${actionDesc} attribute "${attrName}"`;
        const code = errorMsg.startsWith('[TARGET_NOT_FOUND]')
          ? 'TARGET_NOT_FOUND'
          : 'SCRIPT_FAILED';
        return failed(code, errorMsg.replace(/^\[TARGET_NOT_FOUND\]\s*/, ''));
      }
    } catch (e) {
      const actionDesc = remove ? 'remove' : 'set';
      return failed(
        'SCRIPT_FAILED',
        `Failed to ${actionDesc} attribute "${attrName}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    maybeLogFallback(ctx, action.id, targetResolved.value);

    return { status: 'success' };
  },
};
