import { TOOL_NAMES } from 'webpage-mcp-shared';
import type { ToolResult } from '@/common/tool-handler';
import { hasDisallowedPublicUrlScheme } from './browser/common';

/**
 * Page-change summary for interaction tools.
 *
 * Without it a caller cannot tell from a click's result that the page
 * navigated (its refs are now stale) or that a link opened a new tab, and
 * spends another call (read_page, get_windows_and_tabs) finding out.
 */

/**
 * Extra time after the action for a navigation or popup to start. Links, form
 * submits and window.open already start within the CDP input's own dialog
 * grace period, so this only catches effects scheduled just after it.
 */
export const PAGE_CHANGE_SETTLE_MS = 50;
/** Upper bound for letting a navigation the action started finish loading. */
export const PAGE_CHANGE_LOAD_WAIT_MS = 5_000;
const LOAD_POLL_MS = 100;
const MAX_REPORTED_NEW_TABS = 5;

const COMPUTER_INPUT_ACTIONS = new Set([
  'left_click',
  'right_click',
  'double_click',
  'triple_click',
  'left_click_drag',
  'key',
  'type',
  'fill',
  'fill_form',
]);
const TEXT_ENTRY_ACTIONS = new Set(['type', 'fill', 'fill_form']);

/**
 * How long to wait after this call for page effects to start, or undefined
 * when the call is not a page interaction. Text entry rarely navigates, so it
 * is only checked, not waited for, unless it submits.
 */
export function pageChangeSettleMs(toolName: string, args: unknown): number | undefined {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const submit = record.submit === true;
  switch (toolName) {
    case TOOL_NAMES.BROWSER.CLICK:
    case TOOL_NAMES.BROWSER.KEYBOARD:
      return PAGE_CHANGE_SETTLE_MS;
    case TOOL_NAMES.BROWSER.FILL:
      return submit ? PAGE_CHANGE_SETTLE_MS : 0;
    case TOOL_NAMES.BROWSER.COMPUTER: {
      const action = String(record.action || '');
      if (!COMPUTER_INPUT_ACTIONS.has(action)) return undefined;
      return TEXT_ENTRY_ACTIONS.has(action) && !submit ? 0 : PAGE_CHANGE_SETTLE_MS;
    }
    default:
      return undefined;
  }
}

export interface PageChangeSummary {
  /** The tab's URL changed or it started loading (link, form submit, reload). */
  navigated?: true;
  url?: string;
  title?: string;
  /** The navigation had not finished loading within PAGE_CHANGE_LOAD_WAIT_MS. */
  loading?: true;
  /** Tabs the action opened (target=_blank links, window.open). */
  newTabs?: Array<{ tabId: number; url?: string; title?: string }>;
  tabClosed?: true;
}

export interface PageChangeObserver {
  finish(result: ToolResult): Promise<PageChangeSummary | undefined>;
  cancel(): void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function currentUrl(tab: chrome.tabs.Tab): string {
  return (tab as chrome.tabs.Tab & { pendingUrl?: string }).pendingUrl || tab.url || '';
}

/** URL and title, left out for pages other than http(s) (as get_windows_and_tabs does). */
function publicPageFields(tab: chrome.tabs.Tab): { url?: string; title?: string } {
  const url = currentUrl(tab);
  if (!url || hasDisallowedPublicUrlScheme(url)) return {};
  return { url, ...(tab.title ? { title: tab.title } : {}) };
}

function hasPendingDialog(result: ToolResult): boolean {
  const first = result?.content?.[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return false;
  try {
    const parsed = JSON.parse(first.text);
    return (
      parsed?.dialog?.handled === false ||
      (Array.isArray(parsed?.dialogs) &&
        parsed.dialogs.some((item: { handled?: unknown }) => item?.handled === false))
    );
  } catch {
    return false;
  }
}

/**
 * Start watching `tabId` before an interaction runs. Returns undefined when
 * the tab cannot be observed.
 */
export async function observePageChanges(
  tabId: number,
  settleMs: number,
  signal?: AbortSignal,
): Promise<PageChangeObserver | undefined> {
  if (signal?.aborted) return undefined;
  if (!chrome.tabs?.onCreated?.addListener || !chrome.tabs?.onUpdated?.addListener) {
    return undefined;
  }
  const before = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!before || signal?.aborted) return undefined;
  const beforeUrl = currentUrl(before);

  const openedTabIds = new Set<number>();
  const hasWebNavigation =
    typeof chrome.webNavigation?.onCommitted?.addListener === 'function' &&
    typeof chrome.webNavigation?.onCommitted?.removeListener === 'function';
  let urlChanged = false;
  let sawLoading = false;
  let topFrameCommitted = false;

  const onCreated = (tab: chrome.tabs.Tab) => {
    if (tab.openerTabId === tabId && typeof tab.id === 'number') openedTabIds.add(tab.id);
  };
  const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
    if (updatedTabId !== tabId) return;
    if (changeInfo.url !== undefined && changeInfo.url !== beforeUrl) urlChanged = true;
    if (changeInfo.status === 'loading') sawLoading = true;
  };
  const onCommitted = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
    if (details.tabId === tabId && details.frameId === 0) topFrameCommitted = true;
  };
  chrome.tabs.onCreated.addListener(onCreated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  if (hasWebNavigation) chrome.webNavigation.onCommitted.addListener(onCommitted);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    chrome.tabs.onCreated.removeListener(onCreated);
    chrome.tabs.onUpdated.removeListener(onUpdated);
    if (hasWebNavigation) chrome.webNavigation.onCommitted.removeListener(onCommitted);
    signal?.removeEventListener('abort', stop);
  };
  signal?.addEventListener('abort', stop, { once: true });

  const describeNewTabs = async () => {
    const tabs = await Promise.all(
      [...openedTabIds]
        .slice(0, MAX_REPORTED_NEW_TABS)
        .map((id) => chrome.tabs.get(id).catch(() => undefined)),
    );
    return tabs
      .filter((tab): tab is chrome.tabs.Tab => typeof tab?.id === 'number')
      .map((tab) => ({ tabId: tab.id as number, ...publicPageFields(tab) }));
  };

  return {
    cancel: stop,
    async finish(result) {
      try {
        if (signal?.aborted) return undefined;
        if (settleMs > 0) await sleep(settleMs, signal);
        if (signal?.aborted) return undefined;
        let after = await chrome.tabs.get(tabId).catch(() => undefined);
        if (signal?.aborted) return undefined;
        const urlDiffers = after !== undefined && currentUrl(after) !== beforeUrl;
        const stillLoading = after !== undefined && after.status !== 'complete';
        // When webNavigation.onCommitted is available, ignore transient
        // status='loading' events (downloads, dynamic iframes, cancelled loads)
        // that completed on the same URL without a top-frame commit.
        const navigated =
          after !== undefined &&
          (urlChanged ||
            urlDiffers ||
            topFrameCommitted ||
            stillLoading ||
            (!hasWebNavigation && sawLoading));
        // A pending dialog blocks the page, so its navigation cannot finish.
        if (navigated && !hasPendingDialog(result)) {
          const deadline = Date.now() + PAGE_CHANGE_LOAD_WAIT_MS;
          while (after && after.status !== 'complete' && !signal?.aborted && Date.now() < deadline) {
            await sleep(LOAD_POLL_MS, signal);
            if (signal?.aborted) return undefined;
            after = await chrome.tabs.get(tabId).catch(() => undefined);
          }
        }
        if (signal?.aborted) return undefined;

        const summary: PageChangeSummary = {};
        if (!after) {
          summary.tabClosed = true;
        } else if (navigated) {
          summary.navigated = true;
          Object.assign(summary, publicPageFields(after));
          if (after.status !== 'complete') summary.loading = true;
        }
        const newTabs = await describeNewTabs();
        if (newTabs.length > 0) summary.newTabs = newTabs;
        return Object.keys(summary).length > 0 ? summary : undefined;
      } finally {
        stop();
      }
    },
  };
}

/** Merge a summary into a JSON tool result as `pageChange`. */
export function withPageChange(
  result: ToolResult,
  summary: PageChangeSummary | undefined,
): ToolResult {
  if (!summary || result?.isError) return result;
  const [first, ...rest] = result.content ?? [];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return result;
  try {
    const parsed = JSON.parse(first.text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
    const merged = {
      ...parsed,
      // Keep the click tool's flag consistent with what was observed.
      ...(summary.navigated && 'navigationOccurred' in parsed ? { navigationOccurred: true } : {}),
      pageChange: summary,
    };
    return { ...result, content: [{ ...first, text: JSON.stringify(merged) }, ...rest] };
  } catch {
    return result;
  }
}
