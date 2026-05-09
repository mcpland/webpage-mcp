/**
 * Scroll Action Handler
 *
 * Supports three scroll modes:
 * - offset: Scroll the window to absolute coordinates
 * - element: Scroll an element into view
 * - container: Scroll within a container element
 */

import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { handleCallTool } from '@/entrypoints/background/tools';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { failed, invalid, ok, tryResolveNumber } from '../registry';
import type { ActionHandler, ElementTarget } from '../types';
import {
  hasElementTargetSpec,
  logSelectorFallback,
  selectorLocator,
  sendMessageToTab,
  toSelectorTarget,
} from './common';

/** Strip frame prefix from composite selector */
function stripCompositeSelector(selector: string): string {
  const raw = String(selector || '').trim();
  if (!raw || !raw.includes('|>')) return raw;
  const parts = raw
    .split('|>')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : raw;
}

/** Format offset value for description */
function describeOffset(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '(dynamic)';
}

export const scrollHandler: ActionHandler<'scroll'> = {
  type: 'scroll',

  validate: (action) => {
    const mode = action.params.mode;
    if (mode !== 'offset' && mode !== 'element' && mode !== 'container') {
      return invalid(`Unsupported scroll mode: ${String(mode)}`);
    }

    if ((mode === 'element' || mode === 'container') && !hasElementTargetSpec(action.params.target)) {
      return invalid(`Scroll mode "${mode}" requires a target ref, selector, or selector candidates`);
    }

    return ok();
  },

  describe: (action) => {
    const mode = action.params.mode;
    if (mode === 'offset') {
      const x = describeOffset(action.params.offset?.x);
      const y = describeOffset(action.params.offset?.y);
      return `Scroll window to x=${x}, y=${y}`;
    }
    if (mode === 'container') return 'Scroll container';
    return 'Scroll to element';
  },

  run: async (ctx, action) => {
    const vars = ctx.vars;
    const tabId = ctx.tabId;

    if (typeof tabId !== 'number') {
      return failed('TAB_NOT_FOUND', 'No active tab found for scroll action');
    }

    const mode = action.params.mode;

    // ----------------------------
    // Offset mode: window scroll
    // ----------------------------
    if (mode === 'offset') {
      let top: number | undefined;
      let left: number | undefined;

      if (action.params.offset?.y !== undefined) {
        const yResolved = tryResolveNumber(action.params.offset.y, vars);
        if (!yResolved.ok) return failed('VALIDATION_ERROR', yResolved.error);
        top = yResolved.value;
      }

      if (action.params.offset?.x !== undefined) {
        const xResolved = tryResolveNumber(action.params.offset.x, vars);
        if (!xResolved.ok) return failed('VALIDATION_ERROR', xResolved.error);
        left = xResolved.value;
      }

      const frameIds = typeof ctx.frameId === 'number' ? [ctx.frameId] : undefined;

      try {
        const injected = await chrome.scripting.executeScript({
          target: { tabId, frameIds } as chrome.scripting.InjectionTarget,
          world: 'MAIN',
          func: (t: number | null, l: number | null) => {
            try {
              const hasTop = typeof t === 'number' && Number.isFinite(t);
              const hasLeft = typeof l === 'number' && Number.isFinite(l);
              if (!hasTop && !hasLeft) return true;

              window.scrollTo({
                top: hasTop ? t : window.scrollY,
                left: hasLeft ? l : window.scrollX,
                behavior: 'auto',
              });
              return true;
            } catch {
              return false;
            }
          },
          args: [top ?? null, left ?? null],
        });

        const result = Array.isArray(injected) ? injected[0]?.result : undefined;
        if (result !== true) {
          return failed('SCRIPT_FAILED', 'Window scroll script returned failure');
        }
      } catch (e) {
        return failed(
          'SCRIPT_FAILED',
          `Failed to scroll window: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      return { status: 'success' };
    }

    // ----------------------------
    // Element/Container mode
    // ----------------------------
    const target = action.params.target as ElementTarget | undefined;
    if (!target) {
      return failed('VALIDATION_ERROR', `Scroll mode "${mode}" requires a target`);
    }

    await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: { tabId } });

    const { selectorTarget, firstCandidateType, firstCssOrAttr } = toSelectorTarget(target, vars);
    const located = await selectorLocator.locate(tabId, selectorTarget, {
      frameId: ctx.frameId,
      preferRef: false,
      verifyFingerprint: true,
    });

    const frameId = located?.frameId ?? ctx.frameId;
    const refToUse = located?.ref ?? selectorTarget.ref;

    // Resolve selector from ref or fallback
    let selector: string | undefined;
    if (refToUse) {
      const resolved = await sendMessageToTab<{ success?: boolean; selector?: string }>(
        tabId,
        { action: TOOL_MESSAGE_TYPES.RESOLVE_REF, ref: refToUse },
        frameId,
      );
      if (
        resolved.ok &&
        resolved.value?.success !== false &&
        typeof resolved.value?.selector === 'string'
      ) {
        const sel = resolved.value.selector.trim();
        if (sel) selector = sel;
      }
    }

    if (!selector && firstCssOrAttr) {
      const stripped = stripCompositeSelector(firstCssOrAttr);
      if (stripped) selector = stripped;
    }

    if (!selector) {
      return failed('TARGET_NOT_FOUND', 'Could not resolve a CSS selector for the scroll target');
    }

    // Resolve offset for container mode
    let scrollTop: number | undefined;
    let scrollLeft: number | undefined;
    if (mode === 'container') {
      if (action.params.offset?.y !== undefined) {
        const yResolved = tryResolveNumber(action.params.offset.y, vars);
        if (!yResolved.ok) return failed('VALIDATION_ERROR', yResolved.error);
        scrollTop = yResolved.value;
      }

      if (action.params.offset?.x !== undefined) {
        const xResolved = tryResolveNumber(action.params.offset.x, vars);
        if (!xResolved.ok) return failed('VALIDATION_ERROR', xResolved.error);
        scrollLeft = xResolved.value;
      }
    }

    // Execute scroll script
    try {
      const frameIds = typeof frameId === 'number' ? [frameId] : undefined;
      const injected = await chrome.scripting.executeScript({
        target: { tabId, frameIds } as chrome.scripting.InjectionTarget,
        world: 'MAIN',
        func: (
          sel: string,
          scrollMode: 'element' | 'container',
          top: number | null,
          left: number | null,
        ) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (!el) return false;

          if (scrollMode === 'element') {
            el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
            return true;
          }

          // Container scroll
          const hasTop = typeof top === 'number' && Number.isFinite(top);
          const hasLeft = typeof left === 'number' && Number.isFinite(left);

          if (typeof el.scrollTo === 'function') {
            el.scrollTo({
              top: hasTop ? top : el.scrollTop,
              left: hasLeft ? left : el.scrollLeft,
              behavior: 'instant',
            });
          } else {
            if (hasTop) el.scrollTop = top;
            if (hasLeft) el.scrollLeft = left;
          }
          return true;
        },
        args: [selector, mode, scrollTop ?? null, scrollLeft ?? null],
      });

      const result = Array.isArray(injected) ? injected[0]?.result : undefined;
      if (result !== true) {
        return failed('TARGET_NOT_FOUND', `Scroll target not found: ${selector}`);
      }
    } catch (e) {
      return failed(
        'SCRIPT_FAILED',
        `Failed to execute scroll: ${e instanceof Error ? e.message : String(e)}`,
      );
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
