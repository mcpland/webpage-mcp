/**
 * Screenshot Action Handler
 *
 * Captures screenshots and optionally stores base64 data in variables.
 * Supports full page, selector-based, and viewport screenshots.
 */

import { handleCallTool } from '@/entrypoints/background/tools';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { failed, invalid, ok } from '../registry';
import type { ActionHandler } from '../types';
import { resolveString } from './common';

/** Extract text content from tool result */
function extractToolText(result: unknown): string | undefined {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  const text = content?.find((c) => c?.type === 'text' && typeof c.text === 'string')?.text;
  return typeof text === 'string' && text.trim() ? text : undefined;
}

export const screenshotHandler: ActionHandler<'screenshot'> = {
  type: 'screenshot',

  validate: (action) => {
    const saveAs = action.params.saveAs;
    if (saveAs !== undefined && (!saveAs || String(saveAs).trim().length === 0)) {
      return invalid('saveAs must be a non-empty variable name when provided');
    }
    return ok();
  },

  describe: (action) => {
    if (action.params.fullPage) return 'Screenshot (full page)';
    if (typeof action.params.selector === 'string') {
      const sel =
        action.params.selector.length > 30
          ? action.params.selector.slice(0, 30) + '...'
          : action.params.selector;
      return `Screenshot: ${sel}`;
    }
    if (action.params.selector) return 'Screenshot (dynamic selector)';
    return 'Screenshot';
  },

  run: async (ctx, action) => {
    const tabId = ctx.tabId;
    if (typeof tabId !== 'number') {
      return failed('TAB_NOT_FOUND', 'No active tab found for screenshot action');
    }

    // Resolve optional selector
    let selector: string | undefined;
    if (action.params.selector !== undefined) {
      const resolved = resolveString(action.params.selector, ctx.vars);
      if (!resolved.ok) return failed('VALIDATION_ERROR', resolved.error);
      const s = resolved.value.trim();
      if (s) selector = s;
    }

    // Call screenshot tool
    const res = await handleCallTool({
      name: TOOL_NAMES.BROWSER.SCREENSHOT,
      args: {
        name: 'workflow',
        storeBase64: true,
        fullPage: action.params.fullPage === true,
        selector,
        tabId,
        background:
          typeof action.params.background === 'boolean'
            ? action.params.background
            : ctx.execution?.backgroundTabs === true,
      },
    });

    if ((res as { isError?: boolean })?.isError) {
      return failed('UNKNOWN', extractToolText(res) || 'Screenshot failed');
    }

    // Parse response
    const text = extractToolText(res);
    if (!text) {
      return failed('UNKNOWN', 'Screenshot tool returned an empty response');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return failed('UNKNOWN', 'Screenshot tool returned invalid JSON');
    }

    const base64Data = (payload as { base64Data?: unknown })?.base64Data;
    if (typeof base64Data !== 'string' || base64Data.length === 0) {
      return failed('UNKNOWN', 'Screenshot tool returned empty base64Data');
    }

    // Store in variables if saveAs specified
    if (action.params.saveAs) {
      ctx.vars[action.params.saveAs] = base64Data;
    }

    return { status: 'success', output: { base64Data } };
  },
};
