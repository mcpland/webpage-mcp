import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { captureFrameOnAction, isAutoCaptureActive } from './gif-recorder';

// Default window dimensions
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 720;
const NAVIGATION_POLL_MS = 100;
const NAVIGATION_WAIT_TIMEOUT_MS = 8000;

type NavigateOpenMode = 'current_tab' | 'new_tab' | 'new_window';

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
    explicitTab: chrome.tabs.Tab | null,
  ): NavigateOpenMode {
    if (
      args.openMode === 'new_window' ||
      args.newWindow === true ||
      typeof args.width === 'number' ||
      typeof args.height === 'number'
    ) {
      return 'new_window';
    }

    if (args.openMode === 'new_tab' || args.newTab === true) {
      return 'new_tab';
    }

    if (
      args.openMode === 'current_tab' ||
      typeof explicitTab?.id === 'number'
    ) {
      return 'current_tab';
    }

    return 'current_tab';
  }

  private async waitForUpdatedTab(
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

  private buildTabResult(tab: chrome.tabs.Tab, message: string): ToolResult {
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
  ): ToolResult {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message,
            windowId: createdWindow.id,
            tabs: tabs.map((tab) => ({
              tabId: tab.id,
              url: tab.url,
            })),
          }),
        },
      ],
      isError: false,
    };
  }

  async execute(args: NavigateToolParams): Promise<ToolResult> {
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

    console.log(
      `Attempting to ${refresh ? 'refresh current tab' : `open URL: ${url}`} with options:`,
      args,
    );

    try {
      const explicitTab = await this.tryGetTab(tabId);

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
        await chrome.tabs.reload(targetTab.id);

        console.log(`Refreshed tab ID: ${targetTab.id}`);

        // Get updated tab information
        const updatedTab = await chrome.tabs.get(targetTab.id);
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
          activate: background !== true,
          focusWindow: background !== true,
        });

        if (url === 'forward') {
          await chrome.tabs.goForward(targetTab.id);
          console.log(`Navigated forward in tab ID: ${targetTab.id}`);
        } else {
          await chrome.tabs.goBack(targetTab.id);
          console.log(`Navigated back in tab ID: ${targetTab.id}`);
        }

        const updatedTab = await chrome.tabs.get(targetTab.id);
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
        if (
          hasDisallowedPublicUrlScheme(targetTabUrl) &&
          !isChromeNewTabUrl(targetTabUrl)
        ) {
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
          });
          await this.triggerAutoCapture(updatedTab.id!, updatedTab.url);
          return this.buildTabResult(
            updatedTab,
            'Opened URL in new tab because target tab is not an HTTP(S) page',
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
        });

        await this.ensureFocus(updatedTab, {
          activate: background !== true,
          focusWindow: background !== true,
        });
        await this.triggerAutoCapture(updatedTab.id!, updatedTab.url);
        return this.buildTabResult(updatedTab, 'Navigated current tab');
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
            });
            await this.triggerAutoCapture(
              updatedFirstTab.id!,
              updatedFirstTab.url,
            );
            return this.buildWindowResult(
              createdWindow,
              'Opened URL in new window',
              [updatedFirstTab],
            );
          }

          return this.buildWindowResult(
            createdWindow,
            'Opened URL in new window',
            windowTabs,
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
        });
        await this.triggerAutoCapture(updatedTab.id!, updatedTab.url);
        return this.buildTabResult(updatedTab, 'Opened URL in new tab');
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
          });
          await this.triggerAutoCapture(
            updatedFirstTab.id!,
            updatedFirstTab.url,
          );
          return this.buildWindowResult(
            fallbackWindow,
            'Opened URL in new window',
            [updatedFirstTab],
          );
        }

        return this.buildWindowResult(
          fallbackWindow,
          'Opened URL in new window',
          fallbackTabs,
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
    console.log(`Attempting to close tabs with options:`, args);

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
  tabId: number;
  windowId?: number;
  background?: boolean;
}

/**
 * Tool for switching the active tab
 */
class SwitchTabTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SWITCH_TAB;

  async execute(args: SwitchTabToolParams): Promise<ToolResult> {
    const { tabId, windowId, background } = args;

    console.log(
      `Attempting to switch to tab ID: ${tabId} in window ID: ${windowId}`,
    );

    try {
      const targetTab = await chrome.tabs.get(tabId);
      if (hasDisallowedPublicUrlScheme(String(targetTab.url || ''))) {
        return createErrorResponse(
          'Only http:// and https:// pages are supported by chrome_switch_tab',
        );
      }

      if (background !== true) {
        if (windowId !== undefined) {
          await chrome.windows.update(windowId, { focused: true });
        }
        await chrome.tabs.update(tabId, { active: true });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message:
                background === true
                  ? `Successfully selected tab ID: ${tabId} without activating it`
                  : `Successfully switched to tab ID: ${tabId}`,
              tabId: targetTab.id,
              windowId: targetTab.windowId,
              url: targetTab.url,
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
