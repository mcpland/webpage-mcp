/**
 * Fill Action Handler
 *
 * Handles form input actions:
 * - Text input
 * - File upload
 * - Auto-scroll and focus
 * - Selector fallback with logging
 */

import { handleCallTool } from '@/entrypoints/background/tools';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { failed, invalid, ok } from '../registry';
import type { ActionHandler } from '../types';
import {
  ensureElementVisible,
  logSelectorFallback,
  resolveString,
  selectorLocator,
  sendMessageToTab,
  toSelectorTarget,
} from './common';

export const fillHandler: ActionHandler<'fill'> = {
  type: 'fill',

  validate: (action) => {
    const target = action.params.target as { ref?: string; candidates?: unknown[] };
    const hasRef = typeof target?.ref === 'string' && target.ref.trim().length > 0;
    const hasCandidates = Array.isArray(target?.candidates) && target.candidates.length > 0;
    const hasValue = action.params.value !== undefined;

    if (!hasValue) {
      return invalid('Missing value parameter');
    }
    if (!hasRef && !hasCandidates) {
      return invalid('Missing target selector or ref');
    }
    return ok();
  },

  describe: (action) => {
    const value = typeof action.params.value === 'string' ? action.params.value : '(dynamic)';
    const displayValue = value.length > 20 ? value.slice(0, 20) + '...' : value;
    return `Fill "${displayValue}"`;
  },

  run: async (ctx, action) => {
    const vars = ctx.vars;
    const tabId = ctx.tabId;

    if (typeof tabId !== 'number') {
      return failed('TAB_NOT_FOUND', 'No active tab found');
    }

    // Ensure page is read before locating element
    await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: { tabId } });

    // Resolve fill value
    const valueResolved = resolveString(action.params.value, vars);
    if (!valueResolved.ok) {
      return failed('VALIDATION_ERROR', valueResolved.error);
    }
    const value = valueResolved.value;

    // Locate target element
    const { selectorTarget, firstCandidateType, firstCssOrAttr } = toSelectorTarget(
      action.params.target,
      vars,
    );

    const located = await selectorLocator.locate(tabId, selectorTarget, {
      frameId: ctx.frameId,
      preferRef: false,
    });

    const frameId = located?.frameId ?? ctx.frameId;
    const refToUse = located?.ref ?? selectorTarget.ref;
    const cssSelector = !located?.ref ? firstCssOrAttr : undefined;

    if (!refToUse && !cssSelector) {
      return failed('TARGET_NOT_FOUND', 'Could not locate target element');
    }

    // Verify element visibility if we have a ref
    if (located?.ref) {
      const isVisible = await ensureElementVisible(tabId, located.ref, frameId);
      if (!isVisible) {
        return failed('ELEMENT_NOT_VISIBLE', 'Target element is not visible');
      }
    }

    // Check for file input and handle file upload
    // Use firstCssOrAttr to check input type even when ref is available
    const selectorForTypeCheck = firstCssOrAttr || cssSelector;
    if (selectorForTypeCheck) {
      const attrResult = await sendMessageToTab<{ value?: string }>(
        tabId,
        { action: 'getAttributeForSelector', selector: selectorForTypeCheck, name: 'type' },
        frameId,
      );
      const inputType = (attrResult.ok ? (attrResult.value?.value ?? '') : '').toLowerCase();

      if (inputType === 'file') {
        const uploadResult = await handleCallTool({
          name: TOOL_NAMES.BROWSER.FILE_UPLOAD,
          args: { selector: selectorForTypeCheck, filePath: value, tabId },
        });

        if ((uploadResult as { isError?: boolean })?.isError) {
          const errorContent = (uploadResult as { content?: Array<{ text?: string }> })?.content;
          const errorMsg = errorContent?.[0]?.text || 'File upload failed';
          return failed('UNKNOWN', errorMsg);
        }

        // Log fallback if used
        const resolvedBy = located?.resolvedBy || (located?.ref ? 'ref' : '');
        const fallbackUsed =
          resolvedBy &&
          firstCandidateType &&
          resolvedBy !== 'ref' &&
          resolvedBy !== firstCandidateType;
        if (fallbackUsed) {
          logSelectorFallback(ctx, action.id, String(firstCandidateType), String(resolvedBy));
        }

        return { status: 'success' };
      }
    }

    // Scroll element into view (best-effort)
    if (cssSelector) {
      try {
        await handleCallTool({
          name: TOOL_NAMES.BROWSER.INJECT_SCRIPT,
          args: {
            type: 'MAIN',
            jsScript: `try{var el=document.querySelector(${JSON.stringify(cssSelector)});if(el){el.scrollIntoView({behavior:'instant',block:'center',inline:'nearest'});}}catch(e){}`,
            tabId,
          },
        });
      } catch {
        // Ignore scroll errors
      }
    }

    // Focus element (best-effort, ignore errors)
    if (located?.ref) {
      await sendMessageToTab(tabId, { action: 'focusByRef', ref: located.ref }, frameId);
    } else if (cssSelector) {
      await handleCallTool({
        name: TOOL_NAMES.BROWSER.INJECT_SCRIPT,
        args: {
          type: 'MAIN',
          jsScript: `try{var el=document.querySelector(${JSON.stringify(cssSelector)});if(el&&el.focus){el.focus();}}catch(e){}`,
          tabId,
        },
      });
    }

    // Execute fill
    const fillResult = await handleCallTool({
      name: TOOL_NAMES.BROWSER.FILL,
      args: {
        ref: refToUse,
        selector: cssSelector,
        value,
        frameId,
        tabId,
      },
    });

    if ((fillResult as { isError?: boolean })?.isError) {
      const errorContent = (fillResult as { content?: Array<{ text?: string }> })?.content;
      const errorMsg = errorContent?.[0]?.text || 'Fill action failed';
      return failed('UNKNOWN', errorMsg);
    }

    // Log fallback if used
    const resolvedBy = located?.resolvedBy || (located?.ref ? 'ref' : '');
    const fallbackUsed =
      resolvedBy && firstCandidateType && resolvedBy !== 'ref' && resolvedBy !== firstCandidateType;

    if (fallbackUsed) {
      logSelectorFallback(ctx, action.id, String(firstCandidateType), String(resolvedBy));
    }

    return { status: 'success' };
  },
};
