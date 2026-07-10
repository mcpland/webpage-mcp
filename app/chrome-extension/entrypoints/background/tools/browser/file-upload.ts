import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { toDownloadDisplayName } from '@/entrypoints/background/download-paths';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { hasDisallowedPublicUrlScheme } from './common';

interface FileUploadToolParams {
  selector: string; // CSS selector for the file input element
  filePath?: string; // Unsupported local file path input retained for explicit rejection
  fileUrl?: string; // URL to download file from
  base64Data?: string; // Base64 encoded file data
  fileName?: string; // Optional filename when using base64 or URL
  multiple?: boolean; // Whether to allow multiple files
  tabId?: number; // Target existing tab id
  windowId?: number; // When no tabId, pick active tab from this window
}

interface InternalLocalFileUploadParams {
  selector: string;
  filePath: string;
  multiple?: boolean;
  tabId?: number;
  windowId?: number;
}

const FILE_UPLOAD_PUBLIC_PAGE_ERROR =
  'Only http:// and https:// pages are supported by chrome_upload_file';
const MAX_FILE_UPLOAD_BYTES = 16 * 1024 * 1024;
const FILE_URL_DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_BASE64_ENCODED_CHARACTERS = Math.ceil((MAX_FILE_UPLOAD_BYTES * 4) / 3) + 4;

function formatByteLimit(bytes: number): string {
  return `${bytes / (1024 * 1024)} MiB`;
}

function estimateBase64DecodedBytes(value: string): number {
  let contentStart = 0;
  if (value.slice(0, 5).toLowerCase() === 'data:') {
    const commaIndex = value.indexOf(',');
    if (commaIndex >= 0 && value.slice(0, commaIndex).trimEnd().toLowerCase().endsWith(';base64')) {
      contentStart = commaIndex + 1;
    }
  }

  let encodedCharacters = 0;
  let trailingPadding = 0;
  for (let index = contentStart; index < value.length; index += 1) {
    const character = value[index];
    if (/\s/.test(character)) {
      continue;
    }
    encodedCharacters += 1;
    if (character === '=') {
      trailingPadding += 1;
    } else {
      trailingPadding = 0;
    }
  }

  return Math.max(0, Math.floor((encodedCharacters * 3) / 4) - Math.min(trailingPadding, 2));
}

function isPublicUploadPage(url?: string | null): boolean {
  return typeof url === 'string' && url.trim().length > 0 && !hasDisallowedPublicUrlScheme(url);
}

/**
 * Tool for uploading files to web forms using Chrome DevTools Protocol
 * Similar to Playwright's setInputFiles implementation
 */
class FileUploadTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILE_UPLOAD;
  constructor() {
    super();
  }

  /**
   * Execute file upload operation using Chrome DevTools Protocol
   */
  async execute(args: FileUploadToolParams): Promise<ToolResult> {
    const { selector, filePath, fileUrl, base64Data, fileName, multiple = false } = args;
    const normalizedFileUrl =
      typeof fileUrl === 'string' && fileUrl.trim() ? fileUrl.trim() : undefined;

    console.log('Starting file upload operation', {
      source: base64Data ? 'base64' : normalizedFileUrl ? 'url' : 'none',
      selectorProvided: typeof selector === 'string' && selector.length > 0,
      fileNameProvided: typeof fileName === 'string' && fileName.length > 0,
      multiple,
      tabId: Number.isInteger(args.tabId) ? args.tabId : undefined,
      windowId: Number.isInteger(args.windowId) ? args.windowId : undefined,
    });

    // Validate input
    if (!selector) {
      return createErrorResponse('Selector is required for file upload');
    }

    if (filePath) {
      return createErrorResponse(
        'Direct local file paths are not supported for uploads. Use fileUrl or base64Data instead.',
      );
    }

    if (normalizedFileUrl && hasDisallowedPublicUrlScheme(normalizedFileUrl)) {
      return createErrorResponse('Only http:// and https:// URLs are allowed for fileUrl uploads.');
    }

    if (!normalizedFileUrl && !base64Data) {
      return createErrorResponse('One of fileUrl or base64Data must be provided');
    }

    if (
      base64Data &&
      (base64Data.length > MAX_BASE64_ENCODED_CHARACTERS + 4096 ||
        estimateBase64DecodedBytes(base64Data) > MAX_FILE_UPLOAD_BYTES)
    ) {
      return createErrorResponse(
        `Upload file exceeds the ${formatByteLimit(MAX_FILE_UPLOAD_BYTES)} limit.`,
      );
    }

    try {
      const explicit = await this.tryGetTab(args.tabId);
      const uploadTarget = explicit || (await this.getActiveTabInWindow(args.windowId));
      if (!uploadTarget?.id) {
        return createErrorResponse('No active tab found');
      }
      if (!isPublicUploadPage(uploadTarget.url)) {
        return createErrorResponse(FILE_UPLOAD_PUBLIC_PAGE_ERROR);
      }

      const tempFilePath = await this.prepareFileFromRemote({
        fileUrl: normalizedFileUrl,
        base64Data,
        fileName: fileName || 'uploaded-file',
      });
      if (!tempFilePath) {
        return createErrorResponse('Failed to prepare file for upload');
      }

      try {
        return await this.uploadPreparedFiles(
          {
            selector,
            multiple,
            tabId: uploadTarget.id,
          },
          [tempFilePath],
        );
      } finally {
        await this.cleanupPreparedRemoteFile(tempFilePath);
      }
    } catch (error) {
      console.error(
        'Error in file upload operation:',
        error instanceof Error ? error.message : String(error),
      );

      return createErrorResponse(
        `Error uploading file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async uploadLocalFile(args: InternalLocalFileUploadParams): Promise<ToolResult> {
    const selector = args.selector?.trim();
    const filePath = args.filePath?.trim();

    if (!selector) {
      return createErrorResponse('Selector is required for file upload');
    }
    if (!filePath) {
      return createErrorResponse('filePath is required for internal file upload');
    }

    try {
      return await this.uploadPreparedFiles(
        {
          selector,
          multiple: args.multiple,
          tabId: args.tabId,
          windowId: args.windowId,
        },
        [filePath],
      );
    } catch (error) {
      console.error('Error in internal file upload operation:', error);
      return createErrorResponse(
        `Error uploading file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // All debugger attach/detach is centrally managed by cdpSessionManager

  private async uploadPreparedFiles(
    args: Pick<FileUploadToolParams, 'selector' | 'multiple' | 'tabId' | 'windowId'>,
    files: string[],
  ): Promise<ToolResult> {
    const { selector, tabId: targetTabId, windowId } = args;

    const explicit = await this.tryGetTab(targetTabId);
    const tab = explicit || (await this.getActiveTabOrThrowInWindow(windowId));
    if (!tab.id) return createErrorResponse('No active tab found');
    if (!isPublicUploadPage(tab.url)) {
      return createErrorResponse(FILE_UPLOAD_PUBLIC_PAGE_ERROR);
    }
    const tabId = tab.id;

    await cdpSessionManager.withSession(tabId, 'file-upload', async () => {
      await cdpSessionManager.sendCommand(tabId, 'DOM.enable', {});
      await cdpSessionManager.sendCommand(tabId, 'Runtime.enable', {});

      const { root } = (await cdpSessionManager.sendCommand(tabId, 'DOM.getDocument', {
        depth: -1,
        pierce: true,
      })) as { root: { nodeId: number } };

      const { nodeId } = (await cdpSessionManager.sendCommand(tabId, 'DOM.querySelector', {
        nodeId: root.nodeId,
        selector,
      })) as { nodeId: number };

      if (!nodeId || nodeId === 0) {
        throw new Error(`Element with selector "${selector}" not found`);
      }

      const { node } = (await cdpSessionManager.sendCommand(tabId, 'DOM.describeNode', {
        nodeId,
      })) as { node: { nodeName: string; attributes?: string[] } };

      if (node.nodeName !== 'INPUT') {
        throw new Error(`Element with selector "${selector}" is not an input element`);
      }

      const attributes = node.attributes || [];
      let isFileInput = false;
      for (let i = 0; i < attributes.length; i += 2) {
        if (attributes[i] === 'type' && attributes[i + 1] === 'file') {
          isFileInput = true;
          break;
        }
      }

      if (!isFileInput) {
        throw new Error(`Element with selector "${selector}" is not a file input (type="file")`);
      }

      await cdpSessionManager.sendCommand(tabId, 'DOM.setFileInputFiles', {
        nodeId,
        files,
      });

      await cdpSessionManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: `
          (function() {
            const element = document.querySelector('${selector.replace(/'/g, "\\'")}');
            if (element) {
              const event = new Event('change', { bubbles: true });
              element.dispatchEvent(event);
              return true;
            }
            return false;
          })()
        `,
      });
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'File(s) uploaded successfully',
            files: files
              .map((file) => toDownloadDisplayName(file))
              .filter((file): file is string => typeof file === 'string' && file.length > 0),
            selector,
            fileCount: files.length,
            pathRedacted: true,
          }),
        },
      ],
      isError: false,
    };
  }

  /**
   * Prepare file from URL or base64 data using native messaging host
   */
  private async prepareFileFromRemote(options: {
    fileUrl?: string;
    base64Data?: string;
    fileName: string;
  }): Promise<string | null> {
    const prepared = await this.resolveFilePayload(options);
    if (!prepared) {
      return null;
    }

    const { base64Data, fileName } = prepared;

    return new Promise((resolve) => {
      const requestId = `file-upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      let settled = false;

      const finish = (filePath: string | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(handleMessage);
        resolve(filePath);
      };

      const handleMessage = (message: any) => {
        if (
          message.type === 'file_operation_response' &&
          message.responseToRequestId === requestId
        ) {
          if (message.payload?.success && message.payload?.filePath) {
            finish(message.payload.filePath);
          } else {
            console.error(
              'Native host failed to prepare file:',
              message.error || message.payload?.error,
            );
            finish(null);
          }
        }
      };

      const timeout = setTimeout(() => {
        console.error('File preparation request timed out');
        finish(null);
      }, 30000); // 30 second timeout

      // Add listener
      chrome.runtime.onMessage.addListener(handleMessage);

      // Send message to background script to forward to native host
      chrome.runtime
        .sendMessage({
          type: 'forward_to_native',
          message: {
            type: 'file_operation',
            requestId: requestId,
            payload: {
              action: 'prepareFile',
              base64Data,
              fileName,
            },
          },
        })
        .catch((error) => {
          console.error(
            'Error sending message to background:',
            error instanceof Error ? error.message : String(error),
          );
          finish(null);
        });
    });
  }

  private async resolveFilePayload(options: {
    fileUrl?: string;
    base64Data?: string;
    fileName: string;
  }): Promise<{ base64Data: string; fileName: string } | null> {
    const { fileUrl, base64Data, fileName } = options;
    if (base64Data) {
      if (
        base64Data.length > MAX_BASE64_ENCODED_CHARACTERS + 4096 ||
        estimateBase64DecodedBytes(base64Data) > MAX_FILE_UPLOAD_BYTES
      ) {
        throw new Error(`Upload file exceeds the ${formatByteLimit(MAX_FILE_UPLOAD_BYTES)} limit.`);
      }
      return {
        base64Data,
        fileName: fileName || 'uploaded-file',
      };
    }
    if (!fileUrl) {
      return null;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FILE_URL_DOWNLOAD_TIMEOUT_MS);

      let response: Response;
      let arrayBuffer: ArrayBuffer;
      try {
        response = await fetch(fileUrl, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Failed to fetch file URL (${response.status})`);
        }

        const contentLengthHeader = response.headers.get('content-length');
        if (contentLengthHeader && /^\d+$/.test(contentLengthHeader.trim())) {
          const contentLength = Number(contentLengthHeader);
          if (!Number.isFinite(contentLength) || contentLength > MAX_FILE_UPLOAD_BYTES) {
            throw new Error(
              `Upload file exceeds the ${formatByteLimit(MAX_FILE_UPLOAD_BYTES)} limit.`,
            );
          }
        }

        arrayBuffer = await this.readBoundedResponseBody(response, MAX_FILE_UPLOAD_BYTES);
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`File URL download timed out after ${FILE_URL_DOWNLOAD_TIMEOUT_MS} ms.`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
      const encoded = this.arrayBufferToBase64(arrayBuffer);
      const normalizedName = fileName || this.inferFileNameFromUrl(fileUrl);
      return {
        base64Data: encoded,
        fileName: normalizedName,
      };
    } catch (error) {
      console.error(
        'Failed to fetch file URL for upload:',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async cleanupPreparedRemoteFile(filePath: string): Promise<void> {
    const requestId = `file-cleanup-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    try {
      await new Promise<void>((resolve) => {
        let settled = false;

        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(handleMessage);
          resolve();
        };

        const handleMessage = (message: any) => {
          if (
            message.type === 'file_operation_response' &&
            message.responseToRequestId === requestId
          ) {
            finish();
          }
        };

        const timeout = setTimeout(finish, 10000);
        chrome.runtime.onMessage.addListener(handleMessage);
        chrome.runtime
          .sendMessage({
            type: 'forward_to_native',
            message: {
              type: 'file_operation',
              requestId,
              payload: {
                action: 'cleanupFile',
                filePath,
              },
            },
          })
          .catch(finish);
      });
    } catch {
      // Cleanup is best-effort and must not replace the original upload result.
    }
  }

  private async readBoundedResponseBody(response: Response, limit: number): Promise<ArrayBuffer> {
    if (!response.body) {
      return new ArrayBuffer(0);
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (!value) {
          continue;
        }

        totalBytes += value.byteLength;
        if (totalBytes > limit) {
          await reader.cancel('Upload file exceeds byte limit').catch(() => undefined);
          throw new Error(`Upload file exceeds the ${formatByteLimit(limit)} limit.`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined.buffer;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';

    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
  }

  private inferFileNameFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const raw = parsed.pathname.split('/').pop() || '';
      const decoded = decodeURIComponent(raw).trim();
      if (decoded) {
        return decoded;
      }
    } catch {
      // Fall through to default filename
    }
    return 'uploaded-file';
  }
}

export const fileUploadTool = new FileUploadTool();

/**
 * Internal-only helper for replay engines that need to upload user-selected local files
 * without re-exposing local paths through the public MCP tool surface.
 */
export async function uploadLocalFileToInputInternal(
  args: InternalLocalFileUploadParams,
): Promise<ToolResult> {
  return await fileUploadTool.uploadLocalFile(args);
}
