/**
 * Navigate Action Handler
 *
 * Handles page navigation actions:
 * - Navigate to URL
 * - Page refresh
 * - Wait for navigation completion
 */

import { handleCallTool } from '@/entrypoints/background/tools';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { ENGINE_CONSTANTS } from '../../engine/constants';
import { ensureReadPageIfWeb, waitForNavigationDone } from '../../engine/policies/wait';
import { failed, invalid, ok } from '../registry';
import type { ActionHandler } from '../types';
import { clampInt, readTabUrl, resolveString } from './common';

export const navigateHandler: ActionHandler<'navigate'> = {
  type: 'navigate',

  validate: (action) => {
    const hasRefresh = action.params.refresh === true;
    const hasUrl = action.params.url !== undefined;
    return hasRefresh || hasUrl ? ok() : invalid('Missing url or refresh parameter');
  },

  describe: (action) => {
    if (action.params.refresh) return 'Refresh page';
    const url = typeof action.params.url === 'string' ? action.params.url : '(dynamic)';
    return `Navigate to ${url}`;
  },

  run: async (ctx, action) => {
    const vars = ctx.vars;
    const tabId = ctx.tabId;
    // Check if StepRunner owns nav-wait (skip internal nav-wait logic)
    const skipNavWait = ctx.execution?.skipNavWait === true;

    if (typeof tabId !== 'number') {
      return failed('TAB_NOT_FOUND', 'No active tab found');
    }

    // Only read beforeUrl and calculate waitMs if we need to do nav-wait
    const beforeUrl = skipNavWait ? '' : await readTabUrl(tabId);
    const waitMs = skipNavWait
      ? 0
      : clampInt(
          action.policy?.timeout?.ms ?? ENGINE_CONSTANTS.DEFAULT_WAIT_MS,
          0,
          ENGINE_CONSTANTS.MAX_WAIT_MS,
        );

    // Handle page refresh
    if (action.params.refresh) {
      const result = await handleCallTool({
        name: TOOL_NAMES.BROWSER.NAVIGATE,
        args: { refresh: true, tabId },
      });

      if ((result as { isError?: boolean })?.isError) {
        const errorContent = (result as { content?: Array<{ text?: string }> })?.content;
        const errorMsg = errorContent?.[0]?.text || 'Page refresh failed';
        return failed('NAVIGATION_FAILED', errorMsg);
      }

      // Skip nav-wait if StepRunner handles it
      if (!skipNavWait) {
        await waitForNavigationDone(beforeUrl, waitMs, tabId);
        await ensureReadPageIfWeb(tabId);
      }
      return { status: 'success' };
    }

    // Handle URL navigation
    const urlResolved = resolveString(action.params.url, vars);
    if (!urlResolved.ok) {
      return failed('VALIDATION_ERROR', urlResolved.error);
    }

    const url = urlResolved.value.trim();
    if (!url) {
      return failed('VALIDATION_ERROR', 'URL is empty');
    }

    const result = await handleCallTool({
      name: TOOL_NAMES.BROWSER.NAVIGATE,
      args: { url, tabId },
    });

    if ((result as { isError?: boolean })?.isError) {
      const errorContent = (result as { content?: Array<{ text?: string }> })?.content;
      const errorMsg = errorContent?.[0]?.text || `Navigation to ${url} failed`;
      return failed('NAVIGATION_FAILED', errorMsg);
    }

    // Skip nav-wait if StepRunner handles it
    if (!skipNavWait) {
      await waitForNavigationDone(beforeUrl, waitMs, tabId);
      await ensureReadPageIfWeb(tabId);
    }

    return { status: 'success' };
  },
};
