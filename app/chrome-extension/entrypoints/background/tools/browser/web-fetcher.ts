import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import {
  boundInteractiveElements,
  INTERACTIVE_ELEMENTS_LIMITS,
  normalizeInteractiveElementsQuery,
  truncateInteractiveString,
} from './interactive-elements-limits';

interface WebFetcherToolParams {
  htmlContent?: boolean; // get the visible HTML content of the current page. default: false
  textContent?: boolean; // get the visible text content of the current page. default: true
  url?: string; // optional URL to fetch content from (if not provided, uses active tab)
  selector?: string; // optional CSS selector to get content from a specific element
  tabId?: number; // target existing tab id
  background?: boolean; // do not activate/focus
  windowId?: number; // target window id to pick active tab or create tab
}

export const WEB_FETCHER_LIMITS = {
  selectorBytes: 4 * 1024,
  urlBytes: 16 * 1024,
  titleBytes: 8 * 1024,
  htmlBytes: 512 * 1024,
  textBytes: 100 * 1024,
  metadataFieldBytes: 8 * 1024,
  articleFieldBytes: 8 * 1024,
  errorBytes: 4 * 1024,
  resultJsonBytes: 700 * 1024,
} as const;

function utf8BytesForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function utf8ByteLength(value: string, stopAfter = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  for (const character of value) {
    bytes += utf8BytesForCodePoint(character.codePointAt(0) ?? 0);
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

function truncateUtf8(value: unknown, maximumBytes: number): { value: string; truncated: boolean } {
  const input = typeof value === 'string' ? value : '';
  let bytes = 0;
  let end = 0;
  for (const character of input) {
    const characterBytes = utf8BytesForCodePoint(character.codePointAt(0) ?? 0);
    if (bytes + characterBytes > maximumBytes) {
      return { value: input.slice(0, end), truncated: true };
    }
    bytes += characterBytes;
    end += character.length;
  }
  return { value: input, truncated: false };
}

function boundedFields(
  value: unknown,
  keys: readonly string[],
  maximumFieldBytes: number,
): { value: Record<string, string>; truncated: boolean } {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const output: Record<string, string> = {};
  let truncated = false;
  for (const key of keys) {
    const bounded = truncateUtf8(input[key], maximumFieldBytes);
    output[key] = bounded.value;
    truncated ||= bounded.truncated;
  }
  return { value: output, truncated };
}

function serializeBoundedResult(result: Record<string, unknown>, primaryField?: string): string {
  let serialized = JSON.stringify(result);
  if (utf8ByteLength(serialized, WEB_FETCHER_LIMITS.resultJsonBytes) <= WEB_FETCHER_LIMITS.resultJsonBytes) {
    return serialized;
  }

  result.truncated = true;
  const originalPrimary =
    primaryField && typeof result[primaryField] === 'string' ? (result[primaryField] as string) : '';
  if (primaryField === 'htmlContent') {
    delete result.htmlContent;
    result.htmlContentError = 'HTML content exceeded the bounded JSON result size';
    serialized = JSON.stringify(result);
  }
  if (primaryField && primaryField !== 'htmlContent') {
    let low = 0;
    let high = originalPrimary.length;
    let best = '';
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      let candidate = originalPrimary.slice(0, middle);
      if (/^[\uD800-\uDBFF]/u.test(candidate.slice(-1))) candidate = candidate.slice(0, -1);
      result[primaryField] = candidate;
      const candidateJson = JSON.stringify(result);
      if (
        utf8ByteLength(candidateJson, WEB_FETCHER_LIMITS.resultJsonBytes) <=
        WEB_FETCHER_LIMITS.resultJsonBytes
      ) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    result[primaryField] = best;
    serialized = JSON.stringify(result);
  }

  if (utf8ByteLength(serialized, WEB_FETCHER_LIMITS.resultJsonBytes) > WEB_FETCHER_LIMITS.resultJsonBytes) {
    delete result.article;
    delete result.metadata;
    serialized = JSON.stringify(result);
  }
  if (utf8ByteLength(serialized, WEB_FETCHER_LIMITS.resultJsonBytes) > WEB_FETCHER_LIMITS.resultJsonBytes) {
    return JSON.stringify({
      success: false,
      truncated: true,
      error: 'Web content exceeded the bounded result size',
    });
  }
  return serialized;
}

function hasDisallowedPublicPageScheme(url: string): boolean {
  const match = url.trim().match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
  if (!match) {
    return false;
  }

  const protocol = match[1]?.toLowerCase();
  return protocol !== 'http' && protocol !== 'https';
}

class WebFetcherTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WEB_FETCHER;

  /**
   * Execute web fetcher operation
   */
  async execute(args: WebFetcherToolParams): Promise<ToolResult> {
    // Handle mutually exclusive parameters: if htmlContent is true, textContent is forced to false
    const htmlContent = args.htmlContent === true;
    const textContent = htmlContent ? false : args.textContent !== false; // Default is true, unless htmlContent is true or textContent is explicitly set to false
    const rawUrl = args.url;
    let url: string | undefined;
    const selector = args.selector;
    const explicitTabId = args.tabId;
    const background = args.background === true;
    const windowId = args.windowId;

    try {
      if (rawUrl !== undefined && typeof rawUrl !== 'string') {
        return createErrorResponse('url must be a string');
      }
      if (
        typeof rawUrl === 'string' &&
        utf8ByteLength(rawUrl, WEB_FETCHER_LIMITS.urlBytes) > WEB_FETCHER_LIMITS.urlBytes
      ) {
        return createErrorResponse(
          `url exceeds the ${WEB_FETCHER_LIMITS.urlBytes}-byte UTF-8 limit`,
        );
      }
      url = typeof rawUrl === 'string' ? rawUrl.trim() : undefined;
      if (selector !== undefined && typeof selector !== 'string') {
        return createErrorResponse('selector must be a string');
      }
      if (
        selector &&
        utf8ByteLength(selector, WEB_FETCHER_LIMITS.selectorBytes) >
          WEB_FETCHER_LIMITS.selectorBytes
      ) {
        return createErrorResponse(
          `selector exceeds the ${WEB_FETCHER_LIMITS.selectorBytes}-byte UTF-8 limit`,
        );
      }
      if (selector && /:has\s*\(/iu.test(selector)) {
        return createErrorResponse(
          'selector must not use the resource-intensive :has() pseudo-class',
        );
      }
      console.log(`Starting web fetcher with options:`, {
        htmlContent,
        textContent,
        urlProvided: Boolean(url),
        selectorProvided: Boolean(selector),
      });
      if (url && hasDisallowedPublicPageScheme(url)) {
        return createErrorResponse(
          'Only http:// and https:// pages are supported by chrome_get_web_content',
        );
      }

      // Get tab to fetch content from
      let tab;

      if (typeof explicitTabId === 'number') {
        tab = await chrome.tabs.get(explicitTabId);
      } else if (url) {
        // If URL is provided, check if it's already open
        console.log('Checking whether the requested URL is already open');
        const allTabs = await chrome.tabs.query({});
        const targetUrl = url.endsWith('/') ? url.slice(0, -1) : url;

        // Find tab with matching URL
        const matchingTabs = allTabs.filter((t) => {
          // Normalize URLs for comparison (remove trailing slashes)
          const tabUrl = t.url?.endsWith('/') ? t.url.slice(0, -1) : t.url;
          return tabUrl === targetUrl;
        });

        if (matchingTabs.length > 0) {
          // Use existing tab
          tab = matchingTabs[0];
          console.log(`Found an existing matching tab, tab ID: ${tab.id}`);
        } else {
          // Create new tab with the URL
          console.log('No existing matching tab found; creating a new tab');
          tab = await chrome.tabs.create({ url, active: background ? false : true });

          // Wait for page to load
          console.log('Waiting for page to load...');
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      } else {
        // Use active tab (prefer specified window)
        const tabs =
          typeof windowId === 'number'
            ? await chrome.tabs.query({ active: true, windowId })
            : await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]) {
          return createErrorResponse('No active tab found');
        }
        tab = tabs[0];
      }

      if (!tab.id) {
        return createErrorResponse('Tab has no ID');
      }
      if (hasDisallowedPublicPageScheme(String(tab.url || ''))) {
        return createErrorResponse(
          'Only http:// and https:// pages are supported by chrome_get_web_content',
        );
      }

      // Optionally bring tab/window to foreground
      if (!background) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      }

      // Prepare result object
      const boundedUrl = truncateUtf8(tab.url, WEB_FETCHER_LIMITS.urlBytes);
      const boundedTitle = truncateUtf8(tab.title, WEB_FETCHER_LIMITS.titleBytes);
      const result: Record<string, unknown> = {
        success: true,
        url: boundedUrl.value,
        title: boundedTitle.value,
      };
      if (boundedUrl.truncated || boundedTitle.truncated) result.truncated = true;

      await this.injectContentScript(tab.id, ['inject-scripts/web-fetcher-helper.js']);

      // Get HTML content if requested
      if (htmlContent) {
        const htmlResponse = await this.sendMessageToTab(tab.id, {
          action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_HTML_CONTENT,
          selector: selector,
        });

        if (htmlResponse?.success) {
          const boundedHtml = truncateUtf8(
            htmlResponse.htmlContent,
            WEB_FETCHER_LIMITS.htmlBytes,
          );
          result.htmlContent = boundedHtml.value;
          if (htmlResponse.truncated === true || boundedHtml.truncated) result.truncated = true;
        } else {
          const boundedError = truncateUtf8(
            htmlResponse?.error,
            WEB_FETCHER_LIMITS.errorBytes,
          ).value;
          console.error('Failed to get HTML content:', boundedError);
          result.htmlContentError = boundedError;
        }
      }

      // Get text content if requested (and htmlContent is not true)
      if (textContent) {
        const textResponse = await this.sendMessageToTab(tab.id, {
          action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_TEXT_CONTENT,
          selector: selector,
        });

        if (textResponse?.success) {
          const boundedText = truncateUtf8(
            textResponse.textContent,
            WEB_FETCHER_LIMITS.textBytes,
          );
          result.textContent = boundedText.value;
          if (textResponse.truncated === true || boundedText.truncated) result.truncated = true;

          // Include article metadata if available
          if (textResponse.article) {
            const article = boundedFields(
              textResponse.article,
              ['title', 'byline', 'siteName', 'excerpt', 'lang'],
              WEB_FETCHER_LIMITS.articleFieldBytes,
            );
            result.article = article.value;
            if (article.truncated) result.truncated = true;
          }

          // Include page metadata if available
          if (textResponse.metadata) {
            const metadata = boundedFields(
              textResponse.metadata,
              ['title', 'description', 'author', 'keywords', 'published', 'siteName'],
              WEB_FETCHER_LIMITS.metadataFieldBytes,
            );
            result.metadata = metadata.value;
            if (metadata.truncated) result.truncated = true;
          }
        } else {
          const boundedError = truncateUtf8(
            textResponse?.error,
            WEB_FETCHER_LIMITS.errorBytes,
          ).value;
          console.error('Failed to get text content:', boundedError);
          result.textContentError = boundedError;
        }
      }

      // Interactive elements feature has been removed

      return {
        content: [
          {
            type: 'text',
            text: serializeBoundedResult(result, htmlContent ? 'htmlContent' : 'textContent'),
          },
        ],
        isError: false,
      };
    } catch (error) {
      const prefix = 'Error fetching web content: ';
      const detail = truncateUtf8(
        error instanceof Error ? error.message : String(error),
        WEB_FETCHER_LIMITS.errorBytes - utf8ByteLength(prefix),
      ).value;
      const message = `${prefix}${detail}`;
      console.error(message);
      return createErrorResponse(message);
    }
  }
}

export const webFetcherTool = new WebFetcherTool();

interface GetInteractiveElementsToolParams {
  textQuery?: string; // Text to search for within interactive elements (fuzzy search)
  selector?: string; // CSS selector to filter interactive elements
  includeCoordinates?: boolean; // Include element coordinates in the response (default: true)
  types?: string[]; // Types of interactive elements to include (default: all types)
  tabId?: number; // target existing tab id
  windowId?: number; // target window id to pick active tab
}

class GetInteractiveElementsTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GET_INTERACTIVE_ELEMENTS;

  /**
   * Execute get interactive elements operation
   */
  async execute(args: GetInteractiveElementsToolParams): Promise<ToolResult> {
    try {
      const query = normalizeInteractiveElementsQuery(args);
      const input = args && typeof args === 'object' ? args : ({} as GetInteractiveElementsToolParams);
      const { tabId, windowId } = input;
      const explicit = await this.tryGetTab(tabId);
      const tab = explicit || (await this.getActiveTabInWindow(windowId));
      if (!tab) {
        return createErrorResponse('No active tab found');
      }
      if (!tab.id) {
        return createErrorResponse('Active tab has no ID');
      }

      // Ensure content script is injected
      await this.injectContentScript(tab.id, ['inject-scripts/interactive-elements-helper.js']);

      // Send message to content script
      const result = await this.sendMessageToTab(tab.id, {
        action: TOOL_MESSAGE_TYPES.GET_INTERACTIVE_ELEMENTS,
        ...query,
      });

      if (!result.success) {
        return createErrorResponse(
          truncateInteractiveString(
            result.error || 'Failed to get interactive elements',
            INTERACTIVE_ELEMENTS_LIMITS.errorBytes,
          ),
        );
      }

      const bounded = boundInteractiveElements(result.elements);
      const truncated = result.truncated === true || bounded.truncated;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              elements: bounded.elements,
              count: bounded.elements.length,
              truncated,
              query: {
                ...(query.textQuery ? { textQuery: query.textQuery } : {}),
                ...(query.selector ? { selector: query.selector } : {}),
                types: query.types || 'all',
              },
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in get interactive elements operation:', error);
      return createErrorResponse(
        `Error getting interactive elements: ${truncateInteractiveString(
          error instanceof Error ? error.message : String(error),
          INTERACTIVE_ELEMENTS_LIMITS.errorBytes,
        )}`,
      );
    }
  }
}

export const getInteractiveElementsTool = new GetInteractiveElementsTool();
