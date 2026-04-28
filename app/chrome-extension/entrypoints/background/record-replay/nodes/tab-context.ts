import type { ExecCtx } from './types';

/**
 * Resolve the runtime tab for a replay step.
 * Legacy replay must use the scheduler-provided workflow tab. Falling back to
 * the active tab makes background/currentTab/newTab execution depend on focus.
 */
export async function resolveNodeTabId(ctx: ExecCtx): Promise<number> {
  if (typeof ctx.tabId !== 'number') {
    throw new Error('Workflow tab is not set for legacy step execution');
  }

  const requestedTabId = ctx.tabId;
  const tab = await chrome.tabs.get(requestedTabId).catch(() => null);
  if (typeof tab?.id === 'number') {
    return tab.id;
  }

  ctx.tabId = undefined;
  throw new Error(`Workflow tab ${requestedTabId} not found`);
}
