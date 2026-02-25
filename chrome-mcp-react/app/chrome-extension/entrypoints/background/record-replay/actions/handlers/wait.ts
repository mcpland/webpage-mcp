/**
 * Wait Action Handler
 *
 * Handles various wait conditions:
 * - Sleep (fixed delay)
 * - Network idle
 * - Navigation complete
 * - Text appears/disappears
 * - Selector visible/hidden
 */

import { ENGINE_CONSTANTS } from '../../engine/constants';
import { waitForNavigation, waitForNetworkIdle } from '../../rr-utils';
import { failed, invalid, ok, tryResolveNumber } from '../registry';
import type { ActionHandler } from '../types';
import { clampInt, resolveString, sendMessageToTab } from './common';

export const waitHandler: ActionHandler<'wait'> = {
  type: 'wait',

  validate: (action) => {
    const condition = action.params.condition;
    if (!condition || typeof condition !== 'object') {
      return invalid('Missing condition parameter');
    }
    if (!('kind' in condition)) {
      return invalid('Condition must have a kind property');
    }
    return ok();
  },

  describe: (action) => {
    const condition = action.params.condition;
    if (!condition) return 'Wait';

    switch (condition.kind) {
      case 'sleep': {
        const ms = typeof condition.sleep === 'number' ? condition.sleep : '(dynamic)';
        return `Wait ${ms}ms`;
      }
      case 'networkIdle':
        return 'Wait for network idle';
      case 'navigation':
        return 'Wait for navigation';
      case 'text': {
        const appear = condition.appear !== false;
        const text = typeof condition.text === 'string' ? condition.text : '(dynamic)';
        const displayText = text.length > 20 ? text.slice(0, 20) + '...' : text;
        return `Wait for text "${displayText}" to ${appear ? 'appear' : 'disappear'}`;
      }
      case 'selector': {
        const visible = condition.visible !== false;
        return `Wait for selector to be ${visible ? 'visible' : 'hidden'}`;
      }
      default:
        return 'Wait';
    }
  },

  run: async (ctx, action) => {
    const vars = ctx.vars;
    const tabId = ctx.tabId;

    if (typeof tabId !== 'number') {
      return failed('TAB_NOT_FOUND', 'No active tab found');
    }

    const timeoutMs = action.policy?.timeout?.ms;
    const frameIds = typeof ctx.frameId === 'number' ? [ctx.frameId] : undefined;
    const condition = action.params.condition;

    // Handle sleep condition
    if (condition.kind === 'sleep') {
      const msResolved = tryResolveNumber(condition.sleep, vars);
      if (!msResolved.ok) {
        return failed('VALIDATION_ERROR', msResolved.error);
      }
      const ms = Math.max(0, Number(msResolved.value ?? 0));
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { status: 'success' };
    }

    // Handle network idle condition
    if (condition.kind === 'networkIdle') {
      const totalMs = clampInt(timeoutMs ?? 5000, 1000, ENGINE_CONSTANTS.MAX_WAIT_MS);
      let idleMs: number;

      if (condition.idleMs !== undefined) {
        const idleResolved = tryResolveNumber(condition.idleMs, vars);
        idleMs = idleResolved.ok
          ? clampInt(idleResolved.value, 200, 5000)
          : Math.min(1500, Math.max(500, Math.floor(totalMs / 3)));
      } else {
        idleMs = Math.min(1500, Math.max(500, Math.floor(totalMs / 3)));
      }

      await waitForNetworkIdle(totalMs, idleMs);
      return { status: 'success' };
    }

    // Handle navigation condition
    if (condition.kind === 'navigation') {
      const timeout = timeoutMs === undefined ? undefined : Math.max(0, Number(timeoutMs));
      await waitForNavigation(timeout);
      return { status: 'success' };
    }

    // Handle text condition
    if (condition.kind === 'text') {
      const textResolved = resolveString(condition.text, vars);
      if (!textResolved.ok) {
        return failed('VALIDATION_ERROR', textResolved.error);
      }

      const appear = condition.appear !== false;
      const timeout = clampInt(timeoutMs ?? 10000, 0, ENGINE_CONSTANTS.MAX_WAIT_MS);

      // Inject wait helper script
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds } as chrome.scripting.InjectionTarget,
          files: ['inject-scripts/wait-helper.js'],
          world: 'ISOLATED',
        });
      } catch (e) {
        return failed('SCRIPT_FAILED', `Failed to inject wait helper: ${(e as Error).message}`);
      }

      // Execute wait for text
      const response = await sendMessageToTab<{ success?: boolean }>(
        tabId,
        { action: 'waitForText', text: textResolved.value, appear, timeout },
        ctx.frameId,
      );

      if (!response.ok) {
        return failed('TIMEOUT', `Wait for text failed: ${response.error}`);
      }
      if (response.value?.success !== true) {
        return failed(
          'TIMEOUT',
          `Text "${textResolved.value}" did not ${appear ? 'appear' : 'disappear'} within timeout`,
        );
      }

      return { status: 'success' };
    }

    // Handle selector condition
    if (condition.kind === 'selector') {
      const selectorResolved = resolveString(condition.selector, vars);
      if (!selectorResolved.ok) {
        return failed('VALIDATION_ERROR', selectorResolved.error);
      }

      const visible = condition.visible !== false;
      const timeout = clampInt(timeoutMs ?? 10000, 0, ENGINE_CONSTANTS.MAX_WAIT_MS);

      // Inject wait helper script
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds } as chrome.scripting.InjectionTarget,
          files: ['inject-scripts/wait-helper.js'],
          world: 'ISOLATED',
        });
      } catch (e) {
        return failed('SCRIPT_FAILED', `Failed to inject wait helper: ${(e as Error).message}`);
      }

      // Execute wait for selector
      const response = await sendMessageToTab<{ success?: boolean }>(
        tabId,
        { action: 'waitForSelector', selector: selectorResolved.value, visible, timeout },
        ctx.frameId,
      );

      if (!response.ok) {
        return failed('TIMEOUT', `Wait for selector failed: ${response.error}`);
      }
      if (response.value?.success !== true) {
        return failed(
          'TIMEOUT',
          `Selector "${selectorResolved.value}" did not become ${visible ? 'visible' : 'hidden'} within timeout`,
        );
      }

      return { status: 'success' };
    }

    return failed(
      'VALIDATION_ERROR',
      `Unsupported wait condition kind: ${(condition as { kind: string }).kind}`,
    );
  },
};
