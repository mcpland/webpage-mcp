/**
 * Screenshot Action Handler
 *
 * Captures screenshots and optionally stores base64 data in variables.
 * Supports full page, selector-based, and viewport screenshots.
 */

import { readScreenshotData } from '../../screenshot-result';
import { handleCallTool } from '@/entrypoints/background/tools';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { failed, invalid, ok } from '../registry';
import type { ActionHandler } from '../types';
import { resolveString } from './common';

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

    const screenshot = readScreenshotData(res);
    if ('error' in screenshot) return failed('UNKNOWN', screenshot.error);
    const base64Data = screenshot.data;

    // Store in variables if saveAs specified
    if (action.params.saveAs) {
      ctx.vars[action.params.saveAs] = base64Data;
    }

    return { status: 'success', output: { base64Data } };
  },
};
