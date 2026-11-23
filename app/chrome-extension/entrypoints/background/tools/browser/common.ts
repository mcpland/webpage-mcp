import { watchLegacyFrameVisits } from './legacy-history';
import { inspectFrameHistory, watchConsumedPopstate, type FrameHistoryRead } from '@/utils/frame-history';
import { readWithSignal } from '@/utils/read-with-signal';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { captureFrameOnAction, isAutoCaptureActive } from './gif-recorder';
import { readPageTool } from './read-page';

// Default window dimensions
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 720;
const NAVIGATION_POLL_MS = 100;
// An optional renderer read must leave time for browser-side history traversal
// even when JavaScript is suspended by DevTools or a native dialog.
const FRAME_HISTORY_READ_TIMEOUT_MS = 250;
const NAVIGATION_WAIT_TIMEOUT_MS = 8000;
// Upper bound for waiting until the page finishes loading after it commits.
const NAVIGATION_LOAD_TIMEOUT_MS = 20_000;
// Reload/history navigations that never report "loading" within this window
// are treated as already settled (for example same-document history entries).
const NAVIGATION_START_GRACE_MS = 1000;

type NavigateOpenMode = 'current_tab' | 'new_tab' | 'new_window';
type NavigationWaitUntil = 'load' | 'commit';

interface TabHistory {
  currentIndex: number;
  entries: Array<{ id: number }>;
}

function readTabHistory(tabId: number, signal: AbortSignal): Promise<TabHistory | undefined> {
  return cdpSessionManager.sendCommand<TabHistory>(tabId, 'Page.getNavigationHistory', undefined, signal)
    .catch(() => undefined);
}

async function readFrameHistory(tabId: number, frameId: number, direction: FrameHistoryRead, signal: AbortSignal) {
  // Navigation API keys are scoped to a frame and survive same-document traversal.
  // An isolated world can read them while another client owns the debugger.
  return readWithSignal(() => chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] }, world: 'ISOLATED', injectImmediately: true,
    args: [direction],
    func: inspectFrameHistory,
  }), signal).then(entries => entries.find(entry => entry.frameId === frameId)).catch(() => undefined);
}

interface NavigateToolParams {
  url?: string;
  openMode?: NavigateOpenMode;
  newTab?: boolean;
  newWindow?: boolean;
  width?: number;
  height?: number;
  refresh?: boolean;
  tabId?: number;
  windowId?: number;
  background?: boolean; // when true, do not activate tab or focus window
  waitUntil?: NavigationWaitUntil; // 'load' (default) or 'commit'
  includeSnapshot?: boolean | { filter?: 'interactive' | 'all'; scope?: 'viewport' | 'page' };
}

type SnapshotOptions = { filter?: 'interactive'; scope?: 'viewport' | 'page' };

function parseSnapshotOptions(value: unknown): SnapshotOptions | undefined | Error {
  if (value === undefined || value === null || value === false) return undefined;
  // A compact interactive tree is what an agent needs to act next.
  if (value === true) return { filter: 'interactive' };
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.filter !== undefined && record.filter !== 'interactive' && record.filter !== 'all') {
      return new Error('includeSnapshot.filter must be "interactive" or "all"');
    }
    if (record.scope !== undefined && record.scope !== 'viewport' && record.scope !== 'page') {
      return new Error('includeSnapshot.scope must be "viewport" or "page"');
    }
    return {
      ...(record.filter === 'interactive' ? { filter: 'interactive' as const } : {}),
      ...(record.scope ? { scope: record.scope as 'viewport' | 'page' } : {}),
    };
  }
  return new Error('includeSnapshot must be a boolean or { filter, scope }');
}

function navigatedTabId(result: ToolResult): number | undefined {
  try {
    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));
    if (typeof payload.tabId === 'number') return payload.tabId;
    const firstTab = Array.isArray(payload.tabs) ? payload.tabs[0] : undefined;
    return typeof firstTab?.tabId === 'number' ? firstTab.tabId : undefined;
  } catch {
    return undefined;
  }
}

export function hasDisallowedPublicUrlScheme(url: string): boolean {
  const match = url.trim().match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
  if (!match) {
    return false;
  }

  const protocol = match[1]?.toLowerCase();
  return protocol !== 'http' && protocol !== 'https';
}

function isChromeNewTabUrl(url: string): boolean {
  return /^chrome:\/\/newtab(?:\/|$|[?#])/i.test(url.trim());
}

const CLOSE_TABS_PUBLIC_PAGE_ERROR =
  'Only http:// and https:// pages are supported by chrome_close_tabs';

function urlsMatch(targetUrl: string, observedUrl: string): boolean {
  if (targetUrl === observedUrl) {
    return true;
  }

  try {
    return new URL(targetUrl).href === new URL(observedUrl).href;
  } catch {
    return false;
  }
}

function getNavigateTargetPageError(operation: 'refresh' | 'history'): string {
  return operation === 'refresh'
    ? 'Only http:// and https:// pages are supported by chrome_navigate refresh'
    : 'Only http:// and https:// pages are supported by chrome_navigate browser history navigation';
}

/**
 * Tool for navigating to URLs in browser tabs or windows
 */
class NavigateTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NAVIGATE;

  /**
   * Trigger GIF auto-capture after successful navigation
   */
  private async triggerAutoCapture(tabId: number, url?: string): Promise<void> {
    if (!isAutoCaptureActive(tabId)) {
      return;
    }
    try {
      await captureFrameOnAction(tabId, { type: 'navigate', url });
    } catch (error) {
      console.warn('[NavigateTool] Auto-capture failed:', error);
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private normalizeOpenMode(
    args: NavigateToolParams,
    _explicitTab: chrome.tabs.Tab | null,
  ): NavigateOpenMode {
    if (args.openMode === 'new_window' || args.newWindow === true) {
      return 'new_window';
    }

    if (args.openMode === 'new_tab' || args.newTab === true) {
      return 'new_tab';
    }

    if (args.openMode === 'current_tab') {
      return 'current_tab';
    }

    // Default policy: open a brand-new tab. The previous default ("current_tab")
    // silently clobbered the user's active tab whenever a model called
    // chrome_navigate({ url }), which is the natural mapping of "open X" in
    // human intent but the wrong destructive operation in practice.
    //
    // Two intentional non-defaults:
    // - tabId alone no longer implies current_tab. Internal callers that want
    //   in-place navigation against a specific tab must pass
    //   `openMode: 'current_tab'` explicitly (record-replay handlers do this).
    // - Bare width/height does not promote to new_window; size hints are only
    //   honoured when the caller explicitly asks for a new_window.
    return 'new_tab';
  }

  private isHttpLikeTabUrl(url: string): boolean {
    return /^https?:\/\//i.test(url);
  }

  /**
   * Wait until the navigation committed and, unless waitUntil is "commit",
   * until the page finished loading. Returning at commit made follow-up
   * screenshots, coordinate clicks and reads race a half-loaded document.
   */
  private async waitForUpdatedTab(
    tabId: number,
    options: {
      previousUrl?: string;
      targetUrl?: string;
      timeoutMs?: number;
      waitUntil?: NavigationWaitUntil;
    } = {},
  ): Promise<chrome.tabs.Tab> {
    // Navigating a tab to the URL it is already on still reloads the document;
    // waitForCommittedTab would otherwise return on poll 0 because urlsMatch is already true.
    if (
      options.previousUrl &&
      options.targetUrl &&
      urlsMatch(options.previousUrl, options.targetUrl)
    ) {
      return this.waitForNavigationToSettle(
        tabId,
        options.previousUrl,
        options.waitUntil ?? 'load',
      );
    }
    const startedAt = Date.now();
    const committed = await this.waitForCommittedTab(tabId, options);
    if (options.waitUntil === 'commit' || committed.status === 'complete') {
      return committed;
    }
    return this.waitForLoadComplete(
      committed.id ?? tabId,
      startedAt + NAVIGATION_LOAD_TIMEOUT_MS,
    );
  }

  private async waitForLoadComplete(
    tabId: number,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<chrome.tabs.Tab> {
    let current = await chrome.tabs.get(tabId);
    while (current.status !== 'complete' && Date.now() < deadline) {
      signal?.throwIfAborted();
      await this.sleep(NAVIGATION_POLL_MS);
      current = await chrome.tabs.get(tabId);
    }
    return current;
  }

  private async navigateHistory(
    tabId: number,
    originalTab: chrome.tabs.Tab,
    direction: 'back' | 'forward',
    waitUntil: NavigationWaitUntil,
    callerSignal?: AbortSignal,
  ): Promise<chrome.tabs.Tab> {
    const previousUrl = String(originalTab.url || '');
    // Entries may share a URL, including pushState and full-document navigations.
    // Arm before calling goBack/goForward so a cached or same-document commit is observable.
    const timeoutMs = waitUntil === 'load' ? NAVIGATION_LOAD_TIMEOUT_MS : NAVIGATION_WAIT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    signal.throwIfAborted();
    const navigation = chrome.webNavigation;
    const frames = navigation?.getAllFrames
      ? await readWithSignal(() => navigation.getAllFrames({ tabId }).catch(() => null), signal)
      : null;
    const frameReads = new AbortController();
    const frameSignal = AbortSignal.any([frameReads.signal, signal]);
    const legacyDocuments = new Map<string, boolean>();
    const stopEvent = `webpage-mcp-history-${crypto.randomUUID()}`;
    const baselineFor = async (frameId: number) => {
      const entry = await readFrameHistory(tabId, frameId, direction, frameSignal);
      const result = entry?.result;
      if (!entry?.documentId || !result || typeof result !== 'object' || !('lateCount' in result)) return entry;
      const documentId = entry.documentId;
      frameSignal.throwIfAborted();
      const target = { tabId, documentIds: [documentId] };
      legacyDocuments.set(documentId, false);
      void chrome.scripting.executeScript({
        target, world: 'MAIN', injectImmediately: true, func: watchConsumedPopstate,
        args: [stopEvent, Math.max(1, deadline - Date.now())],
      }).then(results => {
        if (results.some(r => r.documentId === documentId && r.result === true)) legacyDocuments.set(documentId, true);
      }).catch(() => {});
      // Wait for the installation task, not the later event it is observing.
      await readWithSignal(() => chrome.scripting.executeScript({
        target, world: 'MAIN', injectImmediately: true, func: () => true,
      }), frameSignal).catch(() => undefined);
      return { ...entry, result: result.lateCount };
    };
    const baselines = new Map((frames ?? []).filter(frame => frame.frameId !== 0).map(({ frameId }) =>
      [frameId, baselineFor(frameId).catch(() => undefined)] as const));
    // Give the renderer a head start without holding a top-level traversal behind
    // a dialog. Keep each outstanding read for a later event from that frame.
    const [before] = baselines.size ? await Promise.all([
      readTabHistory(tabId, signal),
      readWithSignal(() => Promise.all(baselines.values()), AbortSignal.any([
        signal, AbortSignal.timeout(FRAME_HISTORY_READ_TIMEOUT_MS),
      ])).catch(() => undefined),
    ]) : [];
    const destinations = before && new Set((direction === 'back'
      ? before.entries.slice(0, before.currentIndex)
      : before.entries.slice(before.currentIndex + 1)).map((entry) => entry.id));
    let committedUrl: string | undefined;
    const updatedFrames = new Set<number>();
    const readingFrames = new Set<number>();
    const traversingDocuments = new Set<string>();
    let childUpdated = false;
    let childTraversed = false;
    const onCommit = (details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
      if (details.tabId !== tabId) return;
      if (details.frameId === 0) committedUrl = details.url;
      else {
        childUpdated = true;
        updatedFrames.add(details.frameId);
        if (details.transitionType === 'auto_subframe' && details.documentId) {
          traversingDocuments.add(details.documentId);
        }
        if (details.transitionQualifiers?.includes('forward_back')) childTraversed = true;
      }
    };
    let visitedLegacyFrame: ((documentId: string) => boolean) | undefined;
    const checkUpdatedFrames = (frames: number[]) => {
      for (const frameId of frames) {
        if (readingFrames.has(frameId)) {
          updatedFrames.add(frameId);
          continue;
        }
        const baseline = baselines.get(frameId);
        if (!baseline) continue;
        readingFrames.add(frameId);
        void Promise.all([baseline, readFrameHistory(tabId, frameId, 'current', frameSignal)])
          .then(([previous, current]) => {
            if (!current && previous) {
              updatedFrames.add(frameId); // A transient read error does not invalidate the browser event.
              return;
            }
            const entry = current?.result;
            if (Array.isArray(entry) && Array.isArray(previous?.result)) {
              if (previous.result.includes(entry[0])) childTraversed = true;
            } else if (typeof entry === 'number' && typeof previous?.result === 'number' &&
              current?.documentId && current.documentId === previous.documentId && traversingDocuments.has(current.documentId)) {
              if (entry > previous.result || legacyDocuments.get(current.documentId) || visitedLegacyFrame?.(current.documentId)) childTraversed = true;
              else updatedFrames.add(frameId); // popstate may follow the browser event.
            }
          }).finally(() => readingFrames.delete(frameId));
      }
    };
    const events = [navigation?.onCommitted, navigation?.onHistoryStateUpdated, navigation?.onReferenceFragmentUpdated];
    for (const event of events) event?.addListener(onCommit);
    try {
      signal.throwIfAborted();
      if (!originalTab.incognito && (!before || legacyDocuments.size)) {
        visitedLegacyFrame = watchLegacyFrameVisits(tabId, frames ?? [], legacyDocuments, frameSignal);
      }
      if (direction === 'back') await chrome.tabs.goBack(tabId);
      else await chrome.tabs.goForward(tabId);

      for (;;) {
        signal.throwIfAborted();
        const current = await chrome.tabs.get(tabId);
        // Chrome can report a child traversing pushState entries without a forward_back
        // qualifier. Confirm it reached an existing joint session-history entry.
        const topTraversed = current.url && (current.url !== previousUrl || current.url === committedUrl);
        if (!topTraversed && (childUpdated || updatedFrames.size) && !childTraversed) {
          // Consume only events already observed. Chrome can deliver another one
          // while the debugger is returning a snapshot from the previous event.
          const changedFrames = [...updatedFrames];
          updatedFrames.clear();
          const readJointHistory = childUpdated && destinations?.size;
          childUpdated = false;
          const history = readJointHistory ? await readTabHistory(tabId, signal) : undefined;
          const entry = history?.entries[history.currentIndex];
          if (entry && destinations) childTraversed ||= destinations.has(entry.id);
          // A stale snapshot at the starting entry is inconclusive. Movement to a
          // different known entry in the opposite direction contradicts this event.
          const contradictsDirection = entry && before && before.entries.some((item, index) =>
            item.id === entry.id && (direction === 'back' ? index > before.currentIndex : index < before.currentIndex));
          if (!childTraversed && !contradictsDirection) {
            // A newer event for the same frame already has a joint-history read queued.
            checkUpdatedFrames(changedFrames.filter(frameId => !updatedFrames.has(frameId)));
          }
        }
        if (topTraversed || (current.url && childTraversed)) {
          if (waitUntil === 'commit' || current.status === 'complete') return current;
          return this.waitForLoadComplete(tabId, deadline, callerSignal);
        }
        if (Date.now() >= deadline) {
          throw new Error('Timed out waiting for history navigation to commit');
        }
        await this.sleep(NAVIGATION_POLL_MS);
      }
    } finally {
      frameReads.abort();
      for (const documentId of legacyDocuments.keys()) {
        void chrome.scripting.executeScript({
          target: { tabId, documentIds: [documentId] }, world: 'MAIN', injectImmediately: true,
          func: (event: string) => { window.dispatchEvent(new Event(event)); }, args: [stopEvent],
        }).catch(() => {});
      }
      for (const event of events) event?.removeListener(onCommit);
    }
  }

  private async waitForNavigationToSettle(
    tabId: number,
    previousUrl: string,
    waitUntil: NavigationWaitUntil,
  ): Promise<chrome.tabs.Tab> {
    if (waitUntil === 'commit') return chrome.tabs.get(tabId);
    const startedAt = Date.now();
    let started = false;
    for (;;) {
      const current = await chrome.tabs.get(tabId);
      if (current.status !== 'complete' || (current.url || '') !== previousUrl) {
        started = true;
      }
      const now = Date.now();
      if (current.status === 'complete' && (started || now - startedAt >= NAVIGATION_START_GRACE_MS)) {
        return current;
      }
      if (now - startedAt >= NAVIGATION_LOAD_TIMEOUT_MS) return current;
      await this.sleep(NAVIGATION_POLL_MS);
    }
  }

  private async waitForCommittedTab(
    tabId: number,
    options: {
      previousUrl?: string;
      targetUrl?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<chrome.tabs.Tab> {
    const timeoutMs = options.timeoutMs ?? NAVIGATION_WAIT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let lastSeen = await chrome.tabs.get(tabId);
    let sawNavigationSignal = !options.previousUrl;

    while (Date.now() < deadline) {
      const current = await chrome.tabs.get(tabId);
      lastSeen = current;

      const currentUrl = current.url || '';
      const changedFromPrevious =
        !!options.previousUrl &&
        !!currentUrl &&
        currentUrl !== options.previousUrl;

      if (
        options.targetUrl &&
        currentUrl &&
        urlsMatch(options.targetUrl, currentUrl)
      ) {
        return current;
      }

      // Fallback for callers without a known targetUrl (e.g., reload/back/forward
      // style flows): treat any committed URL change as completion.
      if (
        !options.targetUrl &&
        options.previousUrl &&
        currentUrl &&
        currentUrl !== options.previousUrl
      ) {
        return current;
      }

      if (changedFromPrevious || current.status !== 'complete') {
        sawNavigationSignal = true;
      }

      // Final fallback: navigation marked complete. When a targetUrl is supplied
      // but redirects commit to a different URL, return only after a real
      // navigation signal so we do not report the pre-navigation page.
      if (
        current.status === 'complete' &&
        currentUrl &&
        (!options.previousUrl || changedFromPrevious) &&
        (!options.targetUrl || sawNavigationSignal)
      ) {
        return current;
      }

      await this.sleep(NAVIGATION_POLL_MS);
    }

    return lastSeen;
  }

  private async resolveTargetWindowForNewTab(
    preferredWindowId?: number,
    explicitTab?: chrome.tabs.Tab | null,
  ): Promise<chrome.windows.Window | null> {
    const candidateWindowIds = new Set<number>();
    if (typeof preferredWindowId === 'number') {
      candidateWindowIds.add(preferredWindowId);
    }
    if (typeof explicitTab?.windowId === 'number') {
      candidateWindowIds.add(explicitTab.windowId);
    }

    for (const candidateWindowId of candidateWindowIds) {
      try {
        return await chrome.windows.get(candidateWindowId, { populate: false });
      } catch {
        // Ignore invalid target windows and continue fallback resolution.
      }
    }

    try {
      return await chrome.windows.getLastFocused({ populate: false });
    } catch {
      return null;
    }
  }

  private loadState(tab: chrome.tabs.Tab, waitUntil: NavigationWaitUntil): Record<string, unknown> {
    return {
      status: tab.status,
      ...(typeof tab.title === 'string' && tab.title ? { title: tab.title } : {}),
      ...(waitUntil === 'load' && tab.status !== 'complete'
        ? {
            warnings: [
              `The page was still loading after ${NAVIGATION_LOAD_TIMEOUT_MS / 1000}s; its content may be incomplete.`,
            ],
          }
        : {}),
    };
  }

  private buildTabResult(
    tab: chrome.tabs.Tab,
    message: string,
    waitUntil: NavigationWaitUntil,
  ): ToolResult {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message,
            tabId: tab.id,
            windowId: tab.windowId,
            url: tab.url,
            ...this.loadState(tab, waitUntil),
          }),
        },
      ],
      isError: false,
    };
  }

  private buildWindowResult(
    createdWindow: chrome.windows.Window,
    message: string,
    tabs: chrome.tabs.Tab[],
    waitUntil: NavigationWaitUntil = 'load',
  ): ToolResult {
    const primary = tabs.length === 1 ? tabs[0] : undefined;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message,
            windowId: createdWindow.id,
            ...(primary ? this.loadState(primary, waitUntil) : {}),
            tabs: tabs.map((tab) => ({
              tabId: tab.id,
              url: tab.url,
              ...this.loadState(tab, waitUntil),
            })),
          }),
        },
      ],
      isError: false,
    };
  }

  async execute(args: NavigateToolParams, context?: { signal?: AbortSignal }): Promise<ToolResult> {
    const snapshot = parseSnapshotOptions(args?.includeSnapshot);
    if (snapshot instanceof Error) return createErrorResponse(snapshot.message);
    const result = await this.navigate(args, context?.signal);
    if (!snapshot || result.isError) return result;
    // Opening a page is almost always followed by reading it; do both in one call.
    const tabId = navigatedTabId(result);
    if (typeof tabId !== 'number') return result;
    const tree = await readPageTool.execute({ tabId, background: true, ...snapshot });
    const snapshotBlock = tree.isError
      ? {
          type: 'text' as const,
          text: JSON.stringify({ snapshotError: (tree.content[0] as { text?: string })?.text }),
        }
      : tree.content[0];
    return { ...result, content: [...result.content, snapshotBlock] };
  }

  private async navigate(args: NavigateToolParams, signal?: AbortSignal): Promise<ToolResult> {
    const {
      openMode,
      newTab = false,
      newWindow = false,
      width,
      height,
      url,
      refresh = false,
      tabId,
      background,
      windowId,
    } = args;
    if (args.waitUntil !== undefined && args.waitUntil !== 'load' && args.waitUntil !== 'commit') {
      return createErrorResponse('waitUntil must be "load" or "commit"');
    }
    const waitUntil: NavigationWaitUntil = args.waitUntil ?? 'load';

    console.log(
      `Attempting to ${refresh ? 'refresh current tab' : `open URL: ${url}`} with options:`,
      args,
    );

    try {
      const explicitTab = await this.tryGetTab(tabId);
      if (tabId !== undefined && !explicitTab &&
          (refresh || url === 'back' || url === 'forward' || this.normalizeOpenMode(args, null) === 'current_tab')) {
        return createErrorResponse(`Target tab ${tabId} is no longer available`);
      }

      // Handle refresh option first
      if (refresh) {
        console.log('Refreshing current active tab');
        // Get target tab (explicit or active in provided window)
        const targetTab =
          explicitTab || (await this.getActiveTabOrThrowInWindow(windowId));
        if (!targetTab.id)
          return createErrorResponse('No target tab found to refresh');
        if (hasDisallowedPublicUrlScheme(String(targetTab.url || ''))) {
          return createErrorResponse(getNavigateTargetPageError('refresh'));
        }
        const urlBeforeReload = String(targetTab.url || '');
        await chrome.tabs.reload(targetTab.id);

        console.log(`Refreshed tab ID: ${targetTab.id}`);

        const updatedTab = await this.waitForNavigationToSettle(
          targetTab.id,
          urlBeforeReload,
          waitUntil,
        );
        if (hasDisallowedPublicUrlScheme(String(updatedTab.url || ''))) {
          return createErrorResponse(getNavigateTargetPageError('refresh'));
        }

        // Trigger auto-capture on refresh
        await this.triggerAutoCapture(updatedTab.id!, updatedTab.url);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Successfully refreshed current tab',
                tabId: updatedTab.id,
                windowId: updatedTab.windowId,
                url: updatedTab.url,
                ...this.loadState(updatedTab, waitUntil),
              }),
            },
          ],
          isError: false,
        };
      }

      // Validate that url is provided when not refreshing
      if (!url) {
        return createErrorResponse(
          'URL parameter is required when refresh is not true',
        );
      }

      // Handle history navigation: url="back" or url="forward"
      if (url === 'back' || url === 'forward') {
        const targetTab =
          explicitTab || (await this.getActiveTabOrThrowInWindow(windowId));
        if (!targetTab.id) {
          return createErrorResponse(
            'No target tab found for history navigation',
          );
        }
        if (hasDisallowedPublicUrlScheme(String(targetTab.url || ''))) {
          return createErrorResponse(getNavigateTargetPageError('history'));
        }

        // Respect background flag for focus behavior
        await this.ensureFocus(targetTab, {
          signal,
          activate: background !== true,
          focusWindow: background !== true,
        });

        const updatedTab = await this.navigateHistory(targetTab.id, targetTab, url, waitUntil, signal);
        if (hasDisallowedPublicUrlScheme(String(updatedTab.url || ''))) {
          return createErrorResponse(getNavigateTargetPageError('history'));
        }

        // Trigger auto-capture on history navigation
        await this.triggerAutoCapture(updatedTab.id!, updatedTab.url);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Successfully navigated ${url} in browser history`,
                tabId: updatedTab.id,
                windowId: updatedTab.windowId,
                url: updatedTab.url,
                ...this.loadState(updatedTab, waitUntil),
              }),
            },
          ],
          isError: false,
        };
      }

      if (hasDisallowedPublicUrlScheme(url) && !isChromeNewTabUrl(url)) {
        return createErrorResponse(
          'Only http://, https://, and chrome://newtab/ URLs are allowed for chrome_navigate',
        );
      }

      const effectiveOpenMode = this.normalizeOpenMode(
        { openMode, newTab, newWindow, width, height },
        explicitTab,
      );
      console.log(`Resolved navigation mode: ${effectiveOpenMode}`);

      if (effectiveOpenMode === 'current_tab') {
        const targetTab =
          explicitTab || (await this.getActiveTabOrThrowInWindow(windowId));
        if (!targetTab.id) {
          return createErrorResponse('No target tab found to navigate');
        }

        const targetTabUrl = String(targetTab.url || '');
        // Fallback when the resolved current tab is not safe to navigate
        // in-place. Anything that is neither an HTTP(S) page nor a chrome
        // new-tab page (empty url, about:blank, chrome://settings, extension
        // pages, file://, devtools, etc.) is routed to a fresh tab so that
        // implicit `current_tab` calls cannot corrupt non-web surfaces.
        const targetIsHttpLike = this.isHttpLikeTabUrl(targetTabUrl);
        const targetIsChromeNewTab = isChromeNewTabUrl(targetTabUrl);
        if (!targetIsHttpLike && !targetIsChromeNewTab) {
          const targetWindow = await this.resolveTargetWindowForNewTab(
            windowId,
            targetTab,
          );
          if (!targetWindow?.id) {
            return createErrorResponse(
              'Target tab is not an HTTP(S) page and no target window was found',
            );
          }

          const createdTab = await chrome.tabs.create({
            url,
            windowId: targetWindow.id,
            active: background === true ? false : true,
          });
          if (!createdTab.id) {
            return createErrorResponse('Failed to create new tab');
          }
          if (background !== true) {
            await chrome.windows.update(targetWindow.id, { focused: true });
          }

          const updatedTab = await this.waitForUpdatedTab(createdTab.id, {
            targetUrl: url,
            waitUntil,
          });
          await this.triggerAutoCapture(updatedTab.id!, updatedTab.url);
          return this.buildTabResult(
            updatedTab,
            'Opened URL in new tab because target tab is not an HTTP(S) page',
            waitUntil,
          );
        }

        const activeTargetTab =
          background === true
            ? targetTab
            : await this.activateTabIfNeeded(targetTab);
        const activeTargetTabId = activeTargetTab.id;
        if (!activeTargetTabId) {
          return createErrorResponse('No target tab found to navigate');
        }
        const beforeUrl = targetTab.url || '';
        await chrome.tabs.update(activeTargetTabId, { url });
        const updatedTab = await this.waitForUpdatedTab(activeTargetTabId, {
          previousUrl: beforeUrl,
          targetUrl: url,
          waitUntil,
        });

        await this.ensureFocus(updatedTab, {
          activate: background !== true,
          focusWindow: background !== true,
        });
        await this.triggerAutoCapture(updatedTab.id!, updatedTab.url);
        return this.buildTabResult(updatedTab, 'Navigated current tab', waitUntil);
      }

      if (effectiveOpenMode === 'new_window') {
        console.log('Opening URL in a new window.');
        const createdWindow = await chrome.windows.create({
          url,
          width: typeof width === 'number' ? width : DEFAULT_WINDOW_WIDTH,
          height: typeof height === 'number' ? height : DEFAULT_WINDOW_HEIGHT,
          focused: background === true ? false : true,
        });

        if (createdWindow && createdWindow.id !== undefined) {
          console.log(`URL opened in new Window ID: ${createdWindow.id}`);
          const windowTabs =
            createdWindow.tabs && createdWindow.tabs.length > 0
              ? createdWindow.tabs
              : await chrome.tabs.query({ windowId: createdWindow.id });
          const firstTab = windowTabs[0];
          if (firstTab?.id) {
            const updatedFirstTab = await this.waitForUpdatedTab(firstTab.id, {
              targetUrl: url,
              waitUntil,
            });
            await this.triggerAutoCapture(
              updatedFirstTab.id!,
              updatedFirstTab.url,
            );
            return this.buildWindowResult(
              createdWindow,
              'Opened URL in new window',
              [updatedFirstTab],
              waitUntil,
            );
          }

          return this.buildWindowResult(
            createdWindow,
            'Opened URL in new window',
            windowTabs,
            waitUntil,
          );
        }
      }

      console.log('Opening URL in a new tab.');
      const targetWindow = await this.resolveTargetWindowForNewTab(
        windowId,
        explicitTab,
      );
      if (targetWindow && targetWindow.id !== undefined) {
        const createdTab = await chrome.tabs.create({
          url,
          windowId: targetWindow.id,
          active: background === true ? false : true,
        });
        if (!createdTab.id) {
          return createErrorResponse('Failed to create new tab');
        }
        if (background !== true) {
          await chrome.windows.update(targetWindow.id, { focused: true });
        }

        const updatedTab = await this.waitForUpdatedTab(createdTab.id, {
          targetUrl: url,
          waitUntil,
        });
        await this.triggerAutoCapture(updatedTab.id!, updatedTab.url);
        return this.buildTabResult(updatedTab, 'Opened URL in new tab', waitUntil);
      }

      console.warn(
        'No target window found, falling back to creating a new window.',
      );
      const fallbackWindow = await chrome.windows.create({
        url,
        width: DEFAULT_WINDOW_WIDTH,
        height: DEFAULT_WINDOW_HEIGHT,
        focused: background === true ? false : true,
      });

      if (fallbackWindow && fallbackWindow.id !== undefined) {
        const fallbackTabs =
          fallbackWindow.tabs && fallbackWindow.tabs.length > 0
            ? fallbackWindow.tabs
            : await chrome.tabs.query({ windowId: fallbackWindow.id });
        const firstTab = fallbackTabs[0];
        if (firstTab?.id) {
          const updatedFirstTab = await this.waitForUpdatedTab(firstTab.id, {
            targetUrl: url,
            waitUntil,
          });
          await this.triggerAutoCapture(
            updatedFirstTab.id!,
            updatedFirstTab.url,
          );
          return this.buildWindowResult(
            fallbackWindow,
            'Opened URL in new window',
            [updatedFirstTab],
            waitUntil,
          );
        }

        return this.buildWindowResult(
          fallbackWindow,
          'Opened URL in new window',
          fallbackTabs,
          waitUntil,
        );
      }

      // If all attempts fail, return a generic error
      return createErrorResponse('Failed to open URL: Unknown error occurred');
    } catch (error) {
      if (chrome.runtime.lastError) {
        console.error(
          `Chrome API Error: ${chrome.runtime.lastError.message}`,
          error,
        );
        return createErrorResponse(
          `Chrome API Error: ${chrome.runtime.lastError.message}`,
        );
      } else {
        console.error('Error in navigate:', error);
        return createErrorResponse(
          `Error navigating to URL: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
export const navigateTool = new NavigateTool();

interface CloseTabsToolParams {
  tabIds?: number[];
  url?: string;
  tabId?: number;
  windowId?: number;
}

/**
 * Tool for closing browser tabs
 */
class CloseTabsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLOSE_TABS;

  async execute(args: CloseTabsToolParams): Promise<ToolResult> {
    const { tabIds, url, tabId, windowId } = args;
    let urlPattern = url;

    try {
      // If URL is provided, close all tabs matching that URL
      if (urlPattern) {
        console.log(`Searching for tabs with URL: ${url}`);
        if (hasDisallowedPublicUrlScheme(urlPattern)) {
          return createErrorResponse(CLOSE_TABS_PUBLIC_PAGE_ERROR);
        }
        try {
          // Build a proper Chrome match pattern from a concrete URL.
          // If caller already provided a match pattern with '*', use as-is.
          if (!urlPattern.includes('*')) {
            // Ignore search/hash; match by origin + pathname prefix.
            // Use URL to normalize; fallback to simple suffixing when parsing fails.
            try {
              const u = new URL(urlPattern);
              const basePath = u.pathname || '/';
              const pathWithWildcard = basePath.endsWith('/')
                ? `${basePath}*`
                : `${basePath}/*`;
              urlPattern = `${u.protocol}//${u.host}${pathWithWildcard}`;
            } catch {
              // Not a fully-qualified URL; ensure it ends with wildcard
              urlPattern = urlPattern.endsWith('/')
                ? `${urlPattern}*`
                : `${urlPattern}/*`;
            }
          }
        } catch {
          // Best-effort: ensure we have some wildcard
          urlPattern = urlPattern.endsWith('*')
            ? urlPattern
            : urlPattern.endsWith('/')
              ? `${urlPattern}*`
              : `${urlPattern}/*`;
        }

        const tabs = (await chrome.tabs.query({ url: urlPattern })).filter(
          (tab) => !hasDisallowedPublicUrlScheme(String(tab.url || '')),
        );

        if (!tabs || tabs.length === 0) {
          console.log(`No tabs found with URL pattern: ${urlPattern}`);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  message: `No tabs found with URL pattern: ${urlPattern}`,
                  closedCount: 0,
                }),
              },
            ],
            isError: false,
          };
        }

        console.log(
          `Found ${tabs.length} tabs with URL pattern: ${urlPattern}`,
        );
        const tabIdsToClose = tabs
          .map((tab) => tab.id)
          .filter((id): id is number => id !== undefined);

        if (tabIdsToClose.length === 0) {
          return createErrorResponse('Found tabs but could not get their IDs');
        }

        await chrome.tabs.remove(tabIdsToClose);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Closed ${tabIdsToClose.length} tabs with URL: ${url}`,
                closedCount: tabIdsToClose.length,
                closedTabIds: tabIdsToClose,
              }),
            },
          ],
          isError: false,
        };
      }

      // If tabIds are provided, close those tabs
      if (tabIds && tabIds.length > 0) {
        console.log(`Closing tabs with IDs: ${tabIds.join(', ')}`);

        // Verify that all tabIds exist
        const existingTabs = await Promise.all(
          tabIds.map(async (tabId) => {
            try {
              return await chrome.tabs.get(tabId);
            } catch (error) {
              console.warn(`Tab with ID ${tabId} not found`);
              return null;
            }
          }),
        );

        const validTabIds = existingTabs
          .filter((tab): tab is chrome.tabs.Tab => tab !== null)
          .map((tab) => tab.id)
          .filter((id): id is number => id !== undefined);
        const hasRestrictedTab = existingTabs.some(
          (tab) => tab && hasDisallowedPublicUrlScheme(String(tab.url || '')),
        );

        if (hasRestrictedTab) {
          return createErrorResponse(CLOSE_TABS_PUBLIC_PAGE_ERROR);
        }

        if (validTabIds.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  message: 'None of the provided tab IDs exist',
                  closedCount: 0,
                }),
              },
            ],
            isError: false,
          };
        }

        await chrome.tabs.remove(validTabIds);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: `Closed ${validTabIds.length} tabs`,
                closedCount: validTabIds.length,
                closedTabIds: validTabIds,
                invalidTabIds: tabIds.filter((id) => !validTabIds.includes(id)),
              }),
            },
          ],
          isError: false,
        };
      }

      // If no tabIds or URL provided, close the current active tab
      console.log('No tabIds or URL provided, closing target active tab');
      const explicit = await this.tryGetTab(tabId);
      const activeTab =
        explicit ||
        (typeof windowId === 'number'
          ? (await chrome.tabs.query({ active: true, windowId }))[0]
          : (
              await chrome.tabs.query({ active: true, currentWindow: true })
            )[0]);

      if (!activeTab || !activeTab.id) {
        return createErrorResponse('No active tab found');
      }
      if (hasDisallowedPublicUrlScheme(String(activeTab.url || ''))) {
        return createErrorResponse(CLOSE_TABS_PUBLIC_PAGE_ERROR);
      }

      await chrome.tabs.remove(activeTab.id);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Closed active tab',
              closedCount: 1,
              closedTabIds: [activeTab.id],
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in CloseTabsTool.execute:', error);
      return createErrorResponse(
        `Error closing tabs: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const closeTabsTool = new CloseTabsTool();

interface SwitchTabToolParams {
  tabId?: number;
  url?: string;
  title?: string;
  windowId?: number;
  background?: boolean;
}

const SWITCH_TAB_MAX_OTHER_MATCHES = 5;

function normalizeTabUrlForMatch(url: string): string {
  return url.trim().toLowerCase().replace(/\/$/, '');
}

/**
 * Pick the HTTP(S) tab whose URL and/or title contain the given text
 * (case-insensitive). An exact URL match wins, then the most recently used tab.
 */
async function findTabsBySelector(selector: {
  url?: string;
  title?: string;
  windowId?: number;
}): Promise<chrome.tabs.Tab[]> {
  const tabs = await chrome.tabs.query(
    typeof selector.windowId === 'number' ? { windowId: selector.windowId } : {},
  );
  const rawUrlNeedle = selector.url?.trim().toLowerCase();
  const exactUrlNeedle = rawUrlNeedle ? normalizeTabUrlForMatch(rawUrlNeedle) : undefined;
  const titleNeedle = selector.title?.trim().toLowerCase();
  const isExact = (tab: chrome.tabs.Tab) =>
    exactUrlNeedle !== undefined &&
    exactUrlNeedle.length > 0 &&
    normalizeTabUrlForMatch(String(tab.url || '')) === exactUrlNeedle;
  const matches = tabs.filter((tab) => {
    const url = String(tab.url || '');
    if (typeof tab.id !== 'number' || !/^https?:\/\//i.test(url)) return false;
    if (rawUrlNeedle !== undefined) {
      const lowerUrl = url.toLowerCase();
      if (!lowerUrl.includes(rawUrlNeedle) && !isExact(tab)) return false;
    }
    if (
      titleNeedle !== undefined &&
      !String(tab.title || '').toLowerCase().includes(titleNeedle)
    ) {
      return false;
    }
    return true;
  });
  const lastAccessed = (tab: chrome.tabs.Tab) =>
    (tab as chrome.tabs.Tab & { lastAccessed?: number }).lastAccessed ?? 0;
  return matches.sort(
    (a, b) => Number(isExact(b)) - Number(isExact(a)) || lastAccessed(b) - lastAccessed(a),
  );
}

/**
 * Tool for switching the active tab
 */
class SwitchTabTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SWITCH_TAB;

  async execute(args: SwitchTabToolParams): Promise<ToolResult> {
    const { tabId, windowId, background } = args;
    const url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : undefined;
    const title =
      typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined;

    if (typeof tabId !== 'number' && !url && !title) {
      return createErrorResponse(
        'chrome_switch_tab needs a tabId, or a url and/or title to find the tab by.',
      );
    }

    try {
      let targetTab: chrome.tabs.Tab;
      let otherMatches: chrome.tabs.Tab[] = [];
      if (typeof tabId === 'number') {
        targetTab = await chrome.tabs.get(tabId);
      } else {
        const matches = await findTabsBySelector({ url, title, windowId });
        if (!matches[0]) {
          const wanted = [url && `url containing "${url}"`, title && `title containing "${title}"`]
            .filter(Boolean)
            .join(' and ');
          return createErrorResponse(
            `No open HTTP(S) tab has a ${wanted}. Use chrome_navigate to open it, or get_windows_and_tabs to list tabs.`,
          );
        }
        [targetTab, ...otherMatches] = matches;
      }
      if (hasDisallowedPublicUrlScheme(String(targetTab.url || ''))) {
        return createErrorResponse(
          'Only http:// and https:// pages are supported by chrome_switch_tab',
        );
      }
      const targetTabId = targetTab.id as number;

      if (background !== true) {
        // Focus the window that actually holds the tab, or it stays hidden
        // behind the current window.
        if (typeof targetTab.windowId === 'number') {
          await chrome.windows.update(targetTab.windowId, { focused: true });
        }
        await chrome.tabs.update(targetTabId, { active: true });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message:
                background === true
                  ? `Successfully selected tab ID: ${targetTabId} without activating it`
                  : `Successfully switched to tab ID: ${targetTabId}`,
              tabId: targetTab.id,
              windowId: targetTab.windowId,
              url: targetTab.url,
              title: targetTab.title,
              ...(otherMatches.length > 0
                ? {
                    otherMatches: otherMatches
                      .slice(0, SWITCH_TAB_MAX_OTHER_MATCHES)
                      .map((tab) => ({ tabId: tab.id, title: tab.title, url: tab.url })),
                    matchCount: otherMatches.length + 1,
                  }
                : {}),
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      if (chrome.runtime.lastError) {
        console.error(
          `Chrome API Error: ${chrome.runtime.lastError.message}`,
          error,
        );
        return createErrorResponse(
          `Chrome API Error: ${chrome.runtime.lastError.message}`,
        );
      } else {
        console.error('Error in SwitchTabTool.execute:', error);
        return createErrorResponse(
          `Error switching tab: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

export const switchTabTool = new SwitchTabTool();
