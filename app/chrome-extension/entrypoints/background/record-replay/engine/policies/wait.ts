// engine/policies/wait.ts — wrappers around rr-utils navigation/network waits
// Keep logic centralized to avoid duplication in schedulers and nodes

import { handleCallTool } from '@/entrypoints/background/tools';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { waitForNavigation as rrWaitForNavigation, waitForNetworkIdle } from '../../rr-utils';

export async function waitForNavigationDone(
  prevUrl: string,
  timeoutMs?: number,
  tabId?: number,
) {
  await rrWaitForNavigation(timeoutMs, prevUrl, tabId);
}

export async function ensureReadPageIfWeb(tabId?: number) {
  try {
    let resolvedTabId = tabId;
    if (typeof resolvedTabId === 'number') {
      const tab = await chrome.tabs.get(resolvedTabId).catch(() => null);
      if (!tab?.id) resolvedTabId = undefined;
    }
    let url = '';
    if (typeof resolvedTabId === 'number') {
      const tab = await chrome.tabs.get(resolvedTabId).catch(() => null);
      url = tab?.url || '';
    } else {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      resolvedTabId = tabs?.[0]?.id;
      url = tabs?.[0]?.url || '';
    }
    if (/^(https?:|file:)/i.test(url)) {
      await handleCallTool({
        name: TOOL_NAMES.BROWSER.READ_PAGE,
        args: typeof resolvedTabId === 'number' ? { tabId: resolvedTabId } : {},
      });
    }
  } catch {}
}

export async function maybeQuickWaitForNav(prevUrl: string, timeoutMs?: number, tabId?: number) {
  try {
    let resolvedTabId = tabId;
    if (typeof resolvedTabId === 'number') {
      const tab = await chrome.tabs.get(resolvedTabId).catch(() => null);
      if (!tab?.id) resolvedTabId = undefined;
    }
    if (typeof resolvedTabId !== 'number') {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      resolvedTabId = tabs?.[0]?.id;
    }
    if (typeof resolvedTabId !== 'number') return;
    const sniffMs = 350;
    const startedAt = Date.now();
    let seen = false;
    await new Promise<void>((resolve) => {
      let timer: any = null;
      const cleanup = () => {
        try {
          chrome.webNavigation.onCommitted.removeListener(onCommitted);
        } catch {}
        try {
          chrome.webNavigation.onCompleted.removeListener(onCompleted);
        } catch {}
        try {
          (chrome.webNavigation as any).onHistoryStateUpdated?.removeListener?.(
            onHistoryStateUpdated,
          );
        } catch {}
        try {
          chrome.tabs.onUpdated.removeListener(onUpdated);
        } catch {}
        if (timer) {
          try {
            clearTimeout(timer);
          } catch {}
        }
      };
      const finish = async () => {
        cleanup();
        if (seen) {
          try {
            await rrWaitForNavigation(
              prevUrl ? Math.min(timeoutMs || 15000, 30000) : undefined,
              prevUrl,
              resolvedTabId,
            );
          } catch {}
        }
        resolve();
      };
      const mark = () => {
        seen = true;
      };
      const onCommitted = (d: any) => {
        if (d.tabId === resolvedTabId && d.frameId === 0 && d.timeStamp >= startedAt) mark();
      };
      const onCompleted = (d: any) => {
        if (d.tabId === resolvedTabId && d.frameId === 0 && d.timeStamp >= startedAt) mark();
      };
      const onHistoryStateUpdated = (d: any) => {
        if (d.tabId === resolvedTabId && d.frameId === 0 && d.timeStamp >= startedAt) mark();
      };
      const onUpdated = (updatedId: number, change: chrome.tabs.TabChangeInfo) => {
        if (updatedId !== resolvedTabId) return;
        if (change.status === 'loading') mark();
        if (typeof change.url === 'string' && (!prevUrl || change.url !== prevUrl)) mark();
      };

      chrome.webNavigation.onCommitted.addListener(onCommitted);
      chrome.webNavigation.onCompleted.addListener(onCompleted);
      try {
        (chrome.webNavigation as any).onHistoryStateUpdated?.addListener?.(onHistoryStateUpdated);
      } catch {}
      chrome.tabs.onUpdated.addListener(onUpdated);
      timer = setTimeout(finish, sniffMs);
    });
  } catch {}
}

export { waitForNetworkIdle };
