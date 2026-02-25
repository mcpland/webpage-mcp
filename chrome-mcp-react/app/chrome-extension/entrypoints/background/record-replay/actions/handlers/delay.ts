/**
 * Delay Action Handler
 *
 * Provides a simple pause in execution flow.
 * Supports variable resolution for dynamic delay times.
 */

import { failed, invalid, ok, tryResolveNumber } from '../registry';
import type { ActionHandler } from '../types';

/** Maximum delay time to prevent integer overflow in setTimeout */
const MAX_DELAY_MS = 2_147_483_647;

export const delayHandler: ActionHandler<'delay'> = {
  type: 'delay',

  validate: (action) => {
    if (action.params.sleep === undefined) {
      return invalid('Missing sleep parameter');
    }
    return ok();
  },

  describe: (action) => {
    const ms = typeof action.params.sleep === 'number' ? action.params.sleep : '(dynamic)';
    return `Delay ${ms}ms`;
  },

  run: async (ctx, action) => {
    const resolved = tryResolveNumber(action.params.sleep, ctx.vars);
    if (!resolved.ok) {
      return failed('VALIDATION_ERROR', resolved.error);
    }

    const ms = Math.max(0, Math.min(MAX_DELAY_MS, Math.floor(resolved.value)));

    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }

    return { status: 'success' };
  },
};
