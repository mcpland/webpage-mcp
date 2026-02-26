// engine/policies/wait.ts — wrappers around rr-utils navigation/network waits
// Keep logic centralized to avoid duplication in schedulers and nodes

import { handleCallTool } from '@/entrypoints/background/tools';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { waitForNavigation as rrWaitForNavigation, waitForNetworkIdle } from '../../rr-utils';

export async function waitForNavigationDone(prevUrl: string, timeoutMs?: number) {
  await rrWaitForNavigation(timeoutMs, prevUrl);
}

export async function ensureReadPageIfWeb() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tabs?.[0]?.url || '';
    if (/^(https?:|file:)/i.test(url)) {
      await handleCallTool({ name: TOOL_NAMES.BROWSER.READ_PAGE, args: {} });
    }
  } catch {}
}

export async function maybeQuickWaitForNav(prevUrl: string, timeoutMs?: number) {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if (typeof tabId !== 'number') return;
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
            );
          } catch {}
        }
        resolve();
      };
      const mark = () => {
        seen = true;
      };
      const onCommitted = (d: any) => {
        if (d.tabId === tabId && d.frameId === 0 && d.timeStamp >= startedAt) mark();
      };
      const onCompleted = (d: any) => {
        if (d.tabId === tabId && d.frameId === 0 && d.timeStamp >= startedAt) mark();
      };
      const onHistoryStateUpdated = (d: any) => {
        if (d.tabId === tabId && d.frameId === 0 && d.timeStamp >= startedAt) mark();
      };
      const onUpdated = (updatedId: number, change: chrome.tabs.TabChangeInfo) => {
        if (updatedId !== tabId) return;
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
