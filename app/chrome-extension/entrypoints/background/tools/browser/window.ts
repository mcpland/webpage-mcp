import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { hasDisallowedPublicUrlScheme } from './common';
import {
  measureJsonBytes,
  measureUtf8Bytes,
  truncateJsonString,
} from './bounded-tool-output';

export const WINDOW_DISCOVERY_MAX_WINDOWS = 32;
export const WINDOW_DISCOVERY_MAX_TABS = 500;
export const WINDOW_DISCOVERY_MAX_OUTPUT_UTF8_BYTES = 1024 * 1024;
const WINDOW_TAB_MAX_URL_JSON_BYTES = 8 * 1024;
const WINDOW_TAB_MAX_TITLE_JSON_BYTES = 4 * 1024;
const WINDOW_OUTPUT_ENVELOPE_RESERVE_BYTES = 4 * 1024;

interface StructuredTab {
  tabId: number;
  url: string | null;
  title: string | null;
  active: boolean;
  restricted: boolean;
}

interface StructuredWindow {
  windowId: number;
  tabs: StructuredTab[];
}

function shouldExposePublicTabDetails(url?: string | null): boolean {
  return (
    typeof url === 'string' &&
    url.trim().length > 0 &&
    !hasDisallowedPublicUrlScheme(url)
  );
}

class WindowTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS;

  async execute(): Promise<ToolResult> {
    try {
      const windows = await chrome.windows.getAll({ populate: false });
      const structuredWindows: StructuredWindow[] = [];
      let tabCount = 0;
      let retainedBytes = 2;
      let truncated = windows.length > WINDOW_DISCOVERY_MAX_WINDOWS;
      const windowLimit = Math.min(
        windows.length,
        WINDOW_DISCOVERY_MAX_WINDOWS,
      );

      let stopDiscovery = false;
      for (let windowIndex = 0; windowIndex < windowLimit; windowIndex += 1) {
        if (tabCount >= WINDOW_DISCOVERY_MAX_TABS) {
          truncated = true;
          break;
        }
        const browserWindow = windows[windowIndex];
        if (
          typeof browserWindow.id !== 'number' ||
          !Number.isFinite(browserWindow.id)
        ) {
          continue;
        }
        const tabs = await chrome.tabs.query({ windowId: browserWindow.id });
        const structuredWindow: StructuredWindow = {
          windowId: browserWindow.id,
          tabs: [],
        };

        for (let tabIndex = 0; tabIndex < tabs.length; tabIndex += 1) {
          if (tabCount >= WINDOW_DISCOVERY_MAX_TABS) {
            truncated = true;
            stopDiscovery = true;
            break;
          }
          const tab = tabs[tabIndex];
          const boundedUrl = truncateJsonString(
            tab.url,
            WINDOW_TAB_MAX_URL_JSON_BYTES,
          );
          const isPublicTab = shouldExposePublicTabDetails(boundedUrl);
          const structuredTab: StructuredTab = {
            tabId:
              typeof tab.id === 'number' && Number.isFinite(tab.id)
                ? tab.id
                : 0,
            url: isPublicTab ? boundedUrl : null,
            title: isPublicTab
              ? truncateJsonString(
                  tab.title,
                  WINDOW_TAB_MAX_TITLE_JSON_BYTES,
                )
              : null,
            active: tab.active === true,
            restricted: !isPublicTab,
          };
          const nextBytes = measureJsonBytes(structuredTab) + 1;
          if (
            retainedBytes + nextBytes >
            WINDOW_DISCOVERY_MAX_OUTPUT_UTF8_BYTES -
              WINDOW_OUTPUT_ENVELOPE_RESERVE_BYTES
          ) {
            truncated = true;
            stopDiscovery = true;
            break;
          }
          structuredWindow.tabs.push(structuredTab);
          tabCount += 1;
          retainedBytes += nextBytes;
        }

        retainedBytes += measureJsonBytes({
          windowId: structuredWindow.windowId,
          tabs: [],
        });
        structuredWindows.push(structuredWindow);
        if (stopDiscovery) break;
      }

      const result: {
        windowCount: number;
        tabCount: number;
        windows: StructuredWindow[];
        truncated?: true;
        totalWindowCount?: number;
      } = {
        windowCount: structuredWindows.length,
        tabCount,
        windows: structuredWindows,
      };
      if (truncated) {
        result.truncated = true;
        result.totalWindowCount = windows.length;
      }

      let serialized = JSON.stringify(result);
      while (
        measureUtf8Bytes(serialized, WINDOW_DISCOVERY_MAX_OUTPUT_UTF8_BYTES) >
          WINDOW_DISCOVERY_MAX_OUTPUT_UTF8_BYTES &&
        result.windows.length > 0
      ) {
        const lastWindow = result.windows.at(-1);
        if (lastWindow?.tabs.length) {
          lastWindow.tabs.pop();
          result.tabCount -= 1;
        } else {
          result.windows.pop();
          result.windowCount = result.windows.length;
        }
        result.truncated = true;
        result.totalWindowCount = windows.length;
        serialized = JSON.stringify(result);
      }

      return {
        content: [{ type: 'text', text: serialized }],
        isError: false,
      };
    } catch (error) {
      console.error('Error in WindowTool.execute:', error);
      return createErrorResponse(
        `Error getting windows and tabs information: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const windowTool = new WindowTool();
