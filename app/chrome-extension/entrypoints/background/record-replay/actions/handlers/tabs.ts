/**
 * Tab Management Action Handlers
 *
 * Handles browser tab operations:
 * - openTab: Open a new tab or window
 * - switchTab: Switch to a different tab
 * - closeTab: Close tab(s)
 * - handleDownload: Monitor and capture download information
 */

import { failed, invalid, ok, tryResolveString } from '../registry';
import type { ActionHandler, DownloadInfo, DownloadState, VariableStore } from '../types';

/** Default timeout for tab operations */
const DEFAULT_TAB_TIMEOUT_MS = 10000;

/** Default timeout for download operations */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60000;

// ================================
// openTab Handler
// ================================

export const openTabHandler: ActionHandler<'openTab'> = {
  type: 'openTab',

  validate: () => ok(),

  describe: (action) => {
    const url = typeof action.params.url === 'string' ? action.params.url : undefined;
    const displayUrl = url ? (url.length > 30 ? url.slice(0, 30) + '...' : url) : 'blank';
    return action.params.newWindow ? `Open window: ${displayUrl}` : `Open tab: ${displayUrl}`;
  },

  run: async (ctx, action) => {
    const params = action.params;

    // Resolve URL if provided
    let url: string | undefined;
    if (params.url !== undefined) {
      const urlResult = tryResolveString(params.url, ctx.vars);
      if (!urlResult.ok) {
        return failed('VALIDATION_ERROR', `Failed to resolve URL: ${urlResult.error}`);
      }
      url = urlResult.value.trim() || undefined;
    }

    try {
      let tabId: number;

      if (params.newWindow) {
        // Create new window
        const window = await chrome.windows.create({
          url: url || 'about:blank',
          focused: true,
        });

        const tab = window?.tabs?.[0];
        if (!tab?.id) {
          return failed('TAB_NOT_FOUND', 'Failed to create new window');
        }
        tabId = tab.id;
      } else {
        // Create new tab in current window
        const tab = await chrome.tabs.create({
          url: url || 'about:blank',
          active: true,
        });

        if (!tab.id) {
          return failed('TAB_NOT_FOUND', 'Failed to create new tab');
        }
        tabId = tab.id;
      }

      // Wait for tab to be ready if URL was specified
      if (url) {
        await waitForTabComplete(tabId, DEFAULT_TAB_TIMEOUT_MS);
      }

      // Return newTabId for ctx.tabId sync
      return { status: 'success', newTabId: tabId };
    } catch (e) {
      return failed('UNKNOWN', `Failed to open tab: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

// ================================
// switchTab Handler
// ================================

export const switchTabHandler: ActionHandler<'switchTab'> = {
  type: 'switchTab',

  validate: (action) => {
    const params = action.params;
    const hasTabId = params.tabId !== undefined;
    const hasUrlContains = params.urlContains !== undefined;
    const hasTitleContains = params.titleContains !== undefined;

    if (!hasTabId && !hasUrlContains && !hasTitleContains) {
      return invalid('switchTab requires tabId, urlContains, or titleContains');
    }

    return ok();
  },

  describe: (action) => {
    if (action.params.tabId !== undefined) {
      return `Switch to tab #${action.params.tabId}`;
    }
    if (action.params.urlContains !== undefined) {
      return `Switch tab (URL contains)`;
    }
    if (action.params.titleContains !== undefined) {
      return `Switch tab (title contains)`;
    }
    return 'Switch tab';
  },

  run: async (ctx, action) => {
    const params = action.params;

    try {
      let targetTabId: number | undefined;

      if (params.tabId !== undefined) {
        targetTabId = params.tabId;
      } else {
        // Find tab by URL or title
        const tabs = await chrome.tabs.query({});

        if (params.urlContains !== undefined) {
          const urlResult = tryResolveString(params.urlContains, ctx.vars);
          if (!urlResult.ok) {
            return failed('VALIDATION_ERROR', `Failed to resolve urlContains: ${urlResult.error}`);
          }
          const urlPattern = urlResult.value.trim().toLowerCase();

          // Empty pattern is invalid
          if (!urlPattern) {
            return failed('VALIDATION_ERROR', 'urlContains pattern cannot be empty');
          }

          const matchingTab = tabs.find(
            (tab) => tab.url && tab.url.toLowerCase().includes(urlPattern),
          );
          targetTabId = matchingTab?.id;
        } else if (params.titleContains !== undefined) {
          const titleResult = tryResolveString(params.titleContains, ctx.vars);
          if (!titleResult.ok) {
            return failed(
              'VALIDATION_ERROR',
              `Failed to resolve titleContains: ${titleResult.error}`,
            );
          }
          const titlePattern = titleResult.value.trim().toLowerCase();

          // Empty pattern is invalid
          if (!titlePattern) {
            return failed('VALIDATION_ERROR', 'titleContains pattern cannot be empty');
          }

          const matchingTab = tabs.find(
            (tab) => tab.title && tab.title.toLowerCase().includes(titlePattern),
          );
          targetTabId = matchingTab?.id;
        }
      }

      if (targetTabId === undefined) {
        return failed('TAB_NOT_FOUND', 'No matching tab found');
      }

      // Activate the tab
      await chrome.tabs.update(targetTabId, { active: true });

      // Focus the window containing the tab
      const tab = await chrome.tabs.get(targetTabId);
      if (tab.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }

      // Return newTabId for ctx.tabId sync
      return { status: 'success', newTabId: targetTabId };
    } catch (e) {
      return failed(
        'UNKNOWN',
        `Failed to switch tab: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};

// ================================
// closeTab Handler
// ================================

export const closeTabHandler: ActionHandler<'closeTab'> = {
  type: 'closeTab',

  validate: () => ok(),

  describe: (action) => {
    if (action.params.tabIds && action.params.tabIds.length > 0) {
      return `Close ${action.params.tabIds.length} tab(s)`;
    }
    if (action.params.url !== undefined) {
      return 'Close tab (by URL)';
    }
    return 'Close current tab';
  },

  run: async (ctx, action) => {
    const params = action.params;

    try {
      let tabIds: number[] = [];

      if (params.tabIds && params.tabIds.length > 0) {
        // Close specific tabs
        tabIds = [...params.tabIds];
      } else if (params.url !== undefined) {
        // Find and close tabs by URL
        const urlResult = tryResolveString(params.url, ctx.vars);
        if (!urlResult.ok) {
          return failed('VALIDATION_ERROR', `Failed to resolve URL: ${urlResult.error}`);
        }
        const urlPattern = urlResult.value.trim().toLowerCase();

        // Empty pattern is invalid
        if (!urlPattern) {
          return failed('VALIDATION_ERROR', 'URL pattern cannot be empty');
        }

        const tabs = await chrome.tabs.query({});
        tabIds = tabs
          .filter((tab) => tab.url && tab.url.toLowerCase().includes(urlPattern) && tab.id)
          .map((tab) => tab.id!);
      } else {
        // Close current tab
        if (typeof ctx.tabId === 'number') {
          tabIds = [ctx.tabId];
        }
      }

      if (tabIds.length === 0) {
        return failed('TAB_NOT_FOUND', 'No tabs to close');
      }

      await chrome.tabs.remove(tabIds);
      return { status: 'success' };
    } catch (e) {
      return failed(
        'UNKNOWN',
        `Failed to close tab: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};

// ================================
// handleDownload Handler
// ================================

export const handleDownloadHandler: ActionHandler<'handleDownload'> = {
  type: 'handleDownload',

  validate: () => ok(),

  describe: (action) => {
    if (action.params.filenameContains !== undefined) {
      return 'Handle download (by filename)';
    }
    return 'Handle download';
  },

  run: async (ctx, action) => {
    const params = action.params;
    const timeoutMs = action.policy?.timeout?.ms ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    const waitForComplete = params.waitForComplete !== false;

    // Resolve filename pattern if provided
    let filenamePattern: string | undefined;
    if (params.filenameContains !== undefined) {
      const result = tryResolveString(params.filenameContains, ctx.vars);
      if (!result.ok) {
        return failed('VALIDATION_ERROR', `Failed to resolve filenameContains: ${result.error}`);
      }
      filenamePattern = result.value.toLowerCase();
    }

    return new Promise((resolve) => {
      const startTime = Date.now();
      let downloadId: number | undefined;
      let downloadInfo: DownloadInfo | undefined;
      let resolved = false;

      const cleanup = () => {
        chrome.downloads.onCreated.removeListener(onCreated);
        chrome.downloads.onChanged.removeListener(onChanged);
      };

      const finish = (result: Awaited<ReturnType<ActionHandler<'handleDownload'>['run']>>) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve(result);
        }
      };

      const onCreated = (item: chrome.downloads.DownloadItem) => {
        // Check if this download matches our criteria
        if (filenamePattern) {
          const filename = item.filename.toLowerCase();
          if (!filename.includes(filenamePattern)) return;
        }

        downloadId = item.id;
        downloadInfo = {
          id: String(item.id),
          filename: item.filename,
          url: item.url,
          state: item.state as DownloadState,
          size: item.totalBytes > 0 ? item.totalBytes : undefined,
        };

        if (!waitForComplete || item.state === 'complete') {
          storeAndFinish();
        }
      };

      const onChanged = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id !== downloadId) return;

        if (delta.state) {
          if (downloadInfo) {
            downloadInfo.state = delta.state.current as DownloadState;
          }

          if (delta.state.current === 'complete') {
            storeAndFinish();
          } else if (delta.state.current === 'interrupted') {
            finish(failed('DOWNLOAD_FAILED', 'Download was interrupted'));
          }
        }

        if (delta.filename && downloadInfo) {
          downloadInfo.filename = delta.filename.current || downloadInfo.filename;
        }

        if (delta.totalBytes && downloadInfo && delta.totalBytes.current) {
          downloadInfo.size = delta.totalBytes.current;
        }
      };

      const storeAndFinish = () => {
        if (params.saveAs && downloadInfo) {
          ctx.vars[params.saveAs] = downloadInfo as unknown as VariableStore[string];
        }
        finish({
          status: 'success',
          output: downloadInfo ? { download: downloadInfo } : undefined,
        });
      };

      // Set up listeners
      chrome.downloads.onCreated.addListener(onCreated);
      chrome.downloads.onChanged.addListener(onChanged);

      // Set up timeout
      const checkTimeout = () => {
        if (resolved) return;
        if (Date.now() - startTime > timeoutMs) {
          finish(failed('TIMEOUT', `Download timeout after ${timeoutMs}ms`));
        } else {
          setTimeout(checkTimeout, 500);
        }
      };
      setTimeout(checkTimeout, 500);
    });
  },
};

// ================================
// Helper Functions
// ================================

/**
 * Wait for a tab to complete loading
 */
async function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const checkStatus = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);

        if (tab.status === 'complete') {
          resolve();
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`Tab load timeout after ${timeoutMs}ms`));
          return;
        }

        setTimeout(checkStatus, 100);
      } catch (e) {
        reject(e);
      }
    };

    checkStatus();
  });
}
