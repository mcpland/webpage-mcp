/**
 * Quick Panel Tabs Handler
 *
 * Background service worker bridge for Quick Panel (content script) to:
 * - Enumerate tabs for search suggestions
 * - Activate a selected tab
 * - Close a tab
 *
 * Note: Content scripts cannot access chrome.tabs.* directly.
 */

import {
  BACKGROUND_MESSAGE_TYPES,
  type QuickPanelActivateTabMessage,
  type QuickPanelActivateTabResponse,
  type QuickPanelCloseTabMessage,
  type QuickPanelCloseTabResponse,
  type QuickPanelTabSummary,
  type QuickPanelTabsQueryMessage,
  type QuickPanelTabsQueryResponse,
} from '@/common/message-types';
import { isExtensionTopFrameSender } from '@/common/runtime-sender-auth';

// ============================================================
// Constants
// ============================================================

const LOG_PREFIX = '[QuickPanelTabs]';

export const QUICK_PANEL_TAB_LIMITS = Object.freeze({
  maxResults: 100,
  maxTitleChars: 256,
  maxUrlChars: 2_048,
  maxFavIconUrlChars: 2_048,
});

// ============================================================
// Helpers
// ============================================================

function isValidTabId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isValidWindowId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isTrustedQuickPanelSender(sender: chrome.runtime.MessageSender): boolean {
  return isExtensionTopFrameSender(sender) && isValidTabId(sender.tab.id);
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function getLastAccessed(tab: chrome.tabs.Tab): number | undefined {
  const anyTab = tab as unknown as { lastAccessed?: unknown };
  const value = anyTab.lastAccessed;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncateString(value: unknown, maxChars: number): { value: string; truncated: boolean } {
  if (typeof value !== 'string') return { value: '', truncated: false };
  return value.length > maxChars
    ? { value: value.slice(0, maxChars), truncated: true }
    : { value, truncated: false };
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || String(err);
  }
  return String(err);
}

/**
 * Convert a chrome.tabs.Tab to our summary format.
 * Returns null if tab is invalid.
 */
function toTabSummary(
  tab: chrome.tabs.Tab,
): { summary: QuickPanelTabSummary; truncated: boolean } | null {
  if (!isValidTabId(tab.id)) return null;

  const windowId = isValidWindowId(tab.windowId) ? tab.windowId : null;
  if (windowId === null) return null;

  const title = truncateString(tab.title, QUICK_PANEL_TAB_LIMITS.maxTitleChars);
  const url = truncateString(tab.url, QUICK_PANEL_TAB_LIMITS.maxUrlChars);
  const favIconUrl = truncateString(tab.favIconUrl, QUICK_PANEL_TAB_LIMITS.maxFavIconUrlChars);
  return {
    truncated: title.truncated || url.truncated || favIconUrl.truncated,
    summary: {
      tabId: tab.id,
      windowId,
      title: title.value,
      url: url.value,
      ...(favIconUrl.value ? { favIconUrl: favIconUrl.value } : {}),
      active: normalizeBoolean(tab.active),
      pinned: normalizeBoolean(tab.pinned),
      audible: normalizeBoolean(tab.audible),
      muted: normalizeBoolean(tab.mutedInfo?.muted),
      index: Number.isSafeInteger(tab.index) && tab.index >= 0 ? tab.index : 0,
      lastAccessed: getLastAccessed(tab),
    },
  };
}

// ============================================================
// Message Handlers
// ============================================================

async function handleTabsQuery(
  message: QuickPanelTabsQueryMessage,
  sender: chrome.runtime.MessageSender,
): Promise<QuickPanelTabsQueryResponse> {
  try {
    if (!isTrustedQuickPanelSender(sender)) {
      return { success: false, error: 'Quick Panel tab request denied' };
    }

    const requestedScope = message.payload?.includeAllWindows;
    if (requestedScope !== undefined && typeof requestedScope !== 'boolean') {
      return { success: false, error: 'includeAllWindows must be a boolean' };
    }
    const includeAllWindows = requestedScope ?? true;

    // Extract current context from sender
    const currentWindowId = isValidWindowId(sender.tab?.windowId) ? sender.tab!.windowId : null;
    const currentTabId = isValidTabId(sender.tab?.id) ? sender.tab!.id : null;

    // Quick Panel should only be called from content scripts (which have sender.tab)
    // Reject requests without valid sender tab context for security
    if (!includeAllWindows && currentWindowId === null) {
      return {
        success: false,
        error: 'Invalid request: sender tab context required for window-scoped queries',
      };
    }

    // Build query info based on scope
    const queryInfo: chrome.tabs.QueryInfo = includeAllWindows
      ? {}
      : { windowId: currentWindowId! };

    const tabs = await chrome.tabs.query(queryInfo);

    // Convert to summaries, filtering out invalid tabs
    const summaries: QuickPanelTabSummary[] = [];
    let truncated = tabs.length > QUICK_PANEL_TAB_LIMITS.maxResults;
    for (const tab of tabs) {
      if (summaries.length >= QUICK_PANEL_TAB_LIMITS.maxResults) break;
      const result = toTabSummary(tab);
      if (result) {
        summaries.push(result.summary);
        truncated ||= result.truncated;
      }
    }

    return {
      success: true,
      tabs: summaries,
      currentTabId,
      currentWindowId,
      ...(truncated ? { truncated: true } : {}),
    };
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error querying tabs:`, err);
    return {
      success: false,
      error: safeErrorMessage(err) || 'Failed to query tabs',
    };
  }
}

async function handleActivateTab(
  message: QuickPanelActivateTabMessage,
  sender: chrome.runtime.MessageSender,
): Promise<QuickPanelActivateTabResponse> {
  try {
    if (!isTrustedQuickPanelSender(sender)) {
      return { success: false, error: 'Quick Panel tab request denied' };
    }

    const tabId = message.payload?.tabId;
    const windowId = message.payload?.windowId;

    if (!isValidTabId(tabId)) {
      return { success: false, error: 'Invalid tabId' };
    }

    // Focus the window first if provided
    if (isValidWindowId(windowId)) {
      try {
        await chrome.windows.update(windowId, { focused: true });
      } catch {
        // Best-effort: tab activation may still succeed without focusing window.
      }
    }

    // Activate the tab
    await chrome.tabs.update(tabId, { active: true });

    return { success: true };
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error activating tab:`, err);
    return {
      success: false,
      error: safeErrorMessage(err) || 'Failed to activate tab',
    };
  }
}

async function handleCloseTab(
  message: QuickPanelCloseTabMessage,
  sender: chrome.runtime.MessageSender,
): Promise<QuickPanelCloseTabResponse> {
  try {
    if (!isTrustedQuickPanelSender(sender)) {
      return { success: false, error: 'Quick Panel tab request denied' };
    }

    const tabId = message.payload?.tabId;

    if (!isValidTabId(tabId)) {
      return { success: false, error: 'Invalid tabId' };
    }

    await chrome.tabs.remove(tabId);

    return { success: true };
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error closing tab:`, err);
    return {
      success: false,
      error: safeErrorMessage(err) || 'Failed to close tab',
    };
  }
}

// ============================================================
// Initialization
// ============================================================

let initialized = false;

/**
 * Initialize the Quick Panel Tabs handler.
 * Safe to call multiple times - subsequent calls are no-ops.
 */
export function initQuickPanelTabsHandler(): void {
  if (initialized) return;
  initialized = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Tabs query
    if (message?.type === BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_TABS_QUERY) {
      handleTabsQuery(message as QuickPanelTabsQueryMessage, sender).then(sendResponse);
      return true; // Will respond asynchronously
    }

    // Tab activate
    if (message?.type === BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_TAB_ACTIVATE) {
      handleActivateTab(message as QuickPanelActivateTabMessage, sender).then(sendResponse);
      return true;
    }

    // Tab close
    if (message?.type === BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_TAB_CLOSE) {
      handleCloseTab(message as QuickPanelCloseTabMessage, sender).then(sendResponse);
      return true;
    }

    return false; // Not handled by this listener
  });

  console.debug(`${LOG_PREFIX} Initialized`);
}
