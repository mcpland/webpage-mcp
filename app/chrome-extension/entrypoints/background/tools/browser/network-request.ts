import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { hasDisallowedPublicUrlScheme } from './common';

const DEFAULT_NETWORK_REQUEST_TIMEOUT = 30000; // For sending a single request via content script
const NON_PUBLIC_REQUEST_URL_ERROR =
  'Only http:// and https:// URLs are allowed for chrome_network_request.';
const NON_PUBLIC_FORM_DATA_URL_ERROR =
  'Only http:// and https:// URLs are allowed for chrome_network_request formData attachments.';

interface NetworkRequestToolParams {
  url: string; // URL is always required
  method?: string; // Defaults to GET
  headers?: Record<string, string>; // User-provided headers
  body?: any; // User-provided body
  timeout?: number; // Timeout for the network request itself
  // Optional multipart/form-data descriptor. When provided, overrides body and lets the helper build FormData.
  // Shape: { fields?: Record<string, string|number|boolean>, files?: Array<{ name: string, fileUrl?: string, base64Data?: string, filename?: string, contentType?: string }> }
  // Or a compact array: [ [name, fileSpec, filename?], ... ] where fileSpec can be 'url:...' or 'base64:...'
  formData?: any;
  tabId?: number;
  windowId?: number;
}

function hasDisallowedPublicRequestUrl(url: unknown): boolean {
  return typeof url === 'string' && url.trim().length > 0 && hasDisallowedPublicUrlScheme(url);
}

function getFormDataDescriptorError(formData: unknown): string | null {
  if (!formData) {
    return null;
  }

  if (Array.isArray(formData)) {
    for (const item of formData) {
      if (!Array.isArray(item) || item.length < 2) {
        continue;
      }

      const spec = String(item[1] || '').trim();
      if (/^url:/i.test(spec)) {
        const sourceUrl = spec.replace(/^url:/i, '').trim();
        if (hasDisallowedPublicRequestUrl(sourceUrl)) {
          return NON_PUBLIC_FORM_DATA_URL_ERROR;
        }
      }
    }
    return null;
  }

  if (typeof formData !== 'object') {
    return null;
  }

  const files = Array.isArray((formData as { files?: unknown[] }).files)
    ? (formData as { files: unknown[] }).files
    : [];

  for (const file of files) {
    const fileUrl = (file as { fileUrl?: unknown })?.fileUrl;
    if (hasDisallowedPublicRequestUrl(fileUrl)) {
      return NON_PUBLIC_FORM_DATA_URL_ERROR;
    }
  }

  return null;
}

/**
 * NetworkRequestTool - Sends network requests based on provided parameters.
 */
class NetworkRequestTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NETWORK_REQUEST;

  async execute(args: NetworkRequestToolParams): Promise<ToolResult> {
    const {
      url,
      method = 'GET',
      headers = {},
      body,
      timeout = DEFAULT_NETWORK_REQUEST_TIMEOUT,
      tabId,
      windowId,
    } = args;

    console.log(`NetworkRequestTool: Executing with options:`, args);

    if (!url) {
      return createErrorResponse('URL parameter is required.');
    }
    if (hasDisallowedPublicRequestUrl(url)) {
      return createErrorResponse(NON_PUBLIC_REQUEST_URL_ERROR);
    }

    const formDataError = getFormDataDescriptorError(args.formData);
    if (formDataError) {
      return createErrorResponse(formDataError);
    }

    try {
      const explicit = await this.tryGetTab(tabId);
      const tab = explicit || (await this.getActiveTabInWindow(windowId));
      if (!tab?.id) {
        return createErrorResponse('No active tab found or tab has no ID.');
      }
      const targetTabId = tab.id;

      // Ensure content script is available in the target tab
      await this.injectContentScript(targetTabId, ['inject-scripts/network-helper.js']);

      console.log(
        `NetworkRequestTool: Sending to content script: URL=${url}, Method=${method}, Headers=${Object.keys(headers).join(',')}, BodyType=${typeof body}`,
      );

      const resultFromContentScript = await this.sendMessageToTab(targetTabId, {
        action: TOOL_MESSAGE_TYPES.NETWORK_SEND_REQUEST,
        url: url,
        method: method,
        headers: headers,
        body: body,
        formData: args.formData || null,
        timeout: timeout,
      });

      console.log(`NetworkRequestTool: Response from content script:`, resultFromContentScript);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(resultFromContentScript),
          },
        ],
        isError: !resultFromContentScript?.success,
      };
    } catch (error: any) {
      console.error('NetworkRequestTool: Error sending network request:', error);
      return createErrorResponse(
        `Error sending network request: ${error.message || String(error)}`,
      );
    }
  }
}

export const networkRequestTool = new NetworkRequestTool();
