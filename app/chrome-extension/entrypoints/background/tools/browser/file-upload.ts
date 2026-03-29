import { createErrorResponse, ToolResult } from '@/common/tool-handler';
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

interface InternalLocalFileUploadParams {
  selector: string;
  filePath: string;
  multiple?: boolean;
  tabId?: number;
  windowId?: number;
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

    console.log(`Starting file upload operation with options:`, args);

    // Validate input
    if (!selector) {
      return createErrorResponse('Selector is required for file upload');
    }

    if (filePath) {
      return createErrorResponse(
        'Direct local file paths are not supported for uploads. Use fileUrl or base64Data instead.',
      );
    }

    if (!fileUrl && !base64Data) {
      return createErrorResponse('One of fileUrl or base64Data must be provided');
    }

    try {
      const tempFilePath = await this.prepareFileFromRemote({
        fileUrl,
        base64Data,
        fileName: fileName || 'uploaded-file',
      });
      if (!tempFilePath) {
        return createErrorResponse('Failed to prepare file for upload');
      }

      return await this.uploadPreparedFiles(
        {
          selector,
          multiple,
          tabId: args.tabId,
          windowId: args.windowId,
        },
        [tempFilePath],
      );
    } catch (error) {
      console.error('Error in file upload operation:', error);

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
            files,
            selector,
            fileCount: files.length,
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
      const timeout = setTimeout(() => {
        console.error('File preparation request timed out');
        resolve(null);
      }, 30000); // 30 second timeout

      // Create listener for the response
      const handleMessage = (message: any) => {
        if (
          message.type === 'file_operation_response' &&
          message.responseToRequestId === requestId
        ) {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(handleMessage);

          if (message.payload?.success && message.payload?.filePath) {
            resolve(message.payload.filePath);
          } else {
            console.error(
              'Native host failed to prepare file:',
              message.error || message.payload?.error,
            );
            resolve(null);
          }
        }
      };

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
          console.error('Error sending message to background:', error);
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(handleMessage);
          resolve(null);
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
      return {
        base64Data,
        fileName: fileName || 'uploaded-file',
      };
    }
    if (!fileUrl) {
      return null;
    }

    try {
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch file URL (${response.status})`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const encoded = this.arrayBufferToBase64(arrayBuffer);
      const normalizedName = fileName || this.inferFileNameFromUrl(fileUrl);
      return {
        base64Data: encoded,
        fileName: normalizedName,
      };
    } catch (error) {
      console.error('Failed to fetch file URL for upload:', error);
      return null;
    }
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
