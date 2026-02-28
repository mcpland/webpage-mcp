import type { ExecCtx } from './types';

/**
 * Resolve the runtime tab for a replay step.
 * Prefer the scheduler-provided ctx.tabId, then fall back to active tab.
 */
export async function resolveNodeTabId(ctx: ExecCtx): Promise<number> {
  if (typeof ctx.tabId === 'number') {
    const tab = await chrome.tabs.get(ctx.tabId).catch(() => null);
    if (typeof tab?.id === 'number') {
      return tab.id;
    }
    ctx.tabId = undefined;
  }

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (typeof active?.id !== 'number') {
    throw new Error('Active tab not found');
  }
  ctx.tabId = active.id;
  return active.id;
}
