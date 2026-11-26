import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { toDownloadDisplayName } from '@/entrypoints/background/download-paths';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

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

interface RemoteUpload {
  fileUrl?: string;
  base64Data?: string;
  fileName: string;
}

interface InternalLocalFileUploadParams {
  signal?: AbortSignal;
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
const MAX_FILE_INPUT_SELECTOR_BYTES = 4 * 1024;

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
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function normalizeFileInputSelector(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Selector is required for file upload');
  }
  const selector = value.trim();
  if (
    selector.length > MAX_FILE_INPUT_SELECTOR_BYTES ||
    new TextEncoder().encode(selector).byteLength > MAX_FILE_INPUT_SELECTOR_BYTES
  ) {
    throw new Error(
      `Selector exceeds the ${MAX_FILE_INPUT_SELECTOR_BYTES}-byte UTF-8 limit`,
    );
  }
  if (/:has\s*\(/iu.test(selector)) {
    throw new Error('Selector must not use the resource-intensive :has() pseudo-class');
  }
  return selector;
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
    const { filePath, fileUrl, base64Data, fileName, multiple = false } = args;
    let selector: string;
    try {
      selector = normalizeFileInputSelector(args.selector);
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
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
    if (filePath) {
      return createErrorResponse(
        'Direct local file paths are not supported for uploads. Use fileUrl or base64Data instead.',
      );
    }

    if (normalizedFileUrl && !isPublicUploadPage(normalizedFileUrl)) {
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

    if (fileName !== undefined && (typeof fileName !== 'string' || fileName.length > 255 || new TextEncoder().encode(fileName).length > 255)) {
      return createErrorResponse('fileName must be a string of at most 255 UTF-8 bytes');
    }
    try {
      return await this.setInputFile({ ...args, selector }, {
        fileUrl: normalizedFileUrl, base64Data,
        fileName: fileName?.split(/[/\\]/).pop() || 'uploaded-file',
      });
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
    let selector: string;
    try {
      selector = normalizeFileInputSelector(args.selector);
    } catch (error) {
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
    const filePath = args.filePath?.trim();

    if (!filePath) {
      return createErrorResponse('filePath is required for internal file upload');
    }

    try {
      return await this.setInputFile(
        {
          selector,
          multiple: args.multiple,
          tabId: args.tabId,
          windowId: args.windowId,
        },
        filePath,
        args.signal,
      );
    } catch (error) {
      console.error('Error in internal file upload operation:', error);
      return createErrorResponse(
        `Error uploading file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // All debugger attach/detach is centrally managed by cdpSessionManager

  private async setInputFile(
    args: Pick<FileUploadToolParams, 'selector' | 'multiple' | 'tabId' | 'windowId'>,
    source: string | RemoteUpload,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const { selector, tabId: targetTabId, windowId } = args;

    const explicit = await this.getRequestedTab(targetTabId);
    const tab = explicit || (await this.getActiveTabOrThrowInWindow(windowId));
    if (!tab.id) return createErrorResponse('No active tab found');
    if (!isPublicUploadPage(tab.url)) {
      return createErrorResponse(FILE_UPLOAD_PUBLIC_PAGE_ERROR);
    }
    const tabId = tab.id;

    await cdpSessionManager.withSession(tabId, 'file-upload', async () => {
      await cdpSessionManager.sendCommand(tabId, 'DOM.enable', {}, signal);
      await cdpSessionManager.sendCommand(tabId, 'Runtime.enable', {}, signal);

      const { root } = (await cdpSessionManager.sendCommand(tabId, 'DOM.getDocument', {
        // DOM.querySelector already searches descendants from this root. Do not
        // materialize an attacker-controlled full DOM in the extension process.
        depth: 0,
        pierce: true,
      }, signal)) as { root: { nodeId: number } };

      const { nodeId } = (await cdpSessionManager.sendCommand(tabId, 'DOM.querySelector', {
        nodeId: root.nodeId,
        selector,
      }, signal)) as { nodeId: number };

      if (!nodeId || nodeId === 0) {
        throw new Error(`Element with selector "${selector}" not found`);
      }

      // Resolve the input in an isolated world before downloading. Its objectId belongs to
      // this document and cannot be reused by a replacement page during a slow download.
      const { frameTree } = await cdpSessionManager.sendCommand<{ frameTree: { frame: { id: string } } }>(
        tabId, 'Page.getFrameTree', {}, signal,
      );
      const { executionContextId } = await cdpSessionManager.sendCommand<{ executionContextId: number }>(
        tabId, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'webpage-mcp-upload' }, signal,
      );
      const { object } = (await cdpSessionManager.sendCommand(tabId, 'DOM.resolveNode', {
        nodeId, executionContextId,
      }, signal)) as { object?: { objectId?: string } };
      const objectId = object?.objectId;
      if (!objectId) {
        throw new Error(`Unable to resolve file input for selector "${selector}"`);
      }

      try {
        const validation = (await cdpSessionManager.sendCommand(
          tabId,
          'Runtime.callFunctionOn',
          {
            objectId,
            functionDeclaration: `function () {
              return {
                url: this.ownerDocument.URL,
                isInput: this instanceof HTMLInputElement,
                isFileInput:
                  this instanceof HTMLInputElement &&
                  String(this.getAttribute('type') || '').toLowerCase() === 'file'
              };
            }`,
            returnByValue: true,
          }, signal,
        )) as {
          result?: { value?: { url?: string; isInput?: boolean; isFileInput?: boolean } };
        };
        if (!validation.result?.value?.isInput) {
          throw new Error(`Element with selector "${selector}" is not an input element`);
        }
        if (!validation.result.value.isFileInput) {
          throw new Error(
            `Element with selector "${selector}" is not a file input (type="file")`,
          );
        }

        if (validation.result.value.url !== tab.url) {
          throw new Error('The upload target changed before the file was selected');
        }
        if (typeof source === 'string') {
          await cdpSessionManager.sendCommand(tabId, 'DOM.setFileInputFiles', { objectId, files: [source] }, signal);
        } else {
          const file = await this.resolveFilePayload(source);
          // A native temporary path would disappear while the page still holds its lazy File.
          // Give the form a browser-owned File so subsequent reads and submissions remain valid.
          const selected = await cdpSessionManager.sendCommand<{ result?: { value?: boolean } }>(
            tabId, 'Runtime.callFunctionOn', {
              objectId,
              functionDeclaration: `function (encoded, name, mimeType) {
                if (!this.isConnected || this.type !== 'file') return false;
                const binary = atob(encoded);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                const transfer = new DataTransfer();
                transfer.items.add(new File([bytes], name, { type: mimeType }));
                this.files = transfer.files;
                this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                this.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }`,
              arguments: [file.base64Data, source.fileName, file.mimeType].map(value => ({ value })),
              returnByValue: true,
            }, signal,
          );
          if (selected.result?.value !== true) throw new Error('Unable to set the file on the selected input');
        }
      } finally {
        await cdpSessionManager
          .sendCommand(tabId, 'Runtime.releaseObject', { objectId })
          .catch(() => undefined);
      }
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'File(s) uploaded successfully',
            files: [typeof source === 'string' ? toDownloadDisplayName(source) : source.fileName],
            selector,
            fileCount: 1,
            pathRedacted: true,
          }),
        },
      ],
      isError: false,
    };
  }

  private async resolveFilePayload(options: RemoteUpload): Promise<{ base64Data: string; mimeType: string }> {
    const { fileUrl, base64Data } = options;
    if (base64Data) {
      const prefix = /^data:([^;,]*)(?:;[^,]*)?;base64,/i.exec(base64Data);
      return {
        base64Data: base64Data.slice(prefix?.[0].length ?? 0).replace(/-/g, '+').replace(/_/g, '/'),
        mimeType: prefix?.[1] || '',
      };
    }
    if (!fileUrl) throw new Error('A file URL or Base64 payload is required');

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
      return { base64Data: encoded, mimeType: response.headers.get('content-type')?.split(';')[0].trim() || '' };
    } catch (error) {
      console.error(
        'Failed to fetch file URL for upload:',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
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
