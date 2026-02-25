import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

interface FileUploadToolParams {
  selector: string; // CSS selector for the file input element
  filePath?: string; // Local file path
  fileUrl?: string; // URL to download file from
  base64Data?: string; // Base64 encoded file data
  fileName?: string; // Optional filename when using base64 or URL
  multiple?: boolean; // Whether to allow multiple files
  tabId?: number; // Target existing tab id
  windowId?: number; // When no tabId, pick active tab from this window
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

    if (!filePath && !fileUrl && !base64Data) {
      return createErrorResponse('One of filePath, fileUrl, or base64Data must be provided');
    }

    try {
      // Resolve tab
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) return createErrorResponse('No active tab found');
      const tabId = tab.id;

      // Prepare file paths
      let files: string[] = [];

      if (filePath) {
        // Direct file path provided
        files = [filePath];
      } else if (fileUrl || base64Data) {
        // For URL or base64, we need to use the native messaging host
        // to download or save the file temporarily
        const tempFilePath = await this.prepareFileFromRemote({
          fileUrl,
          base64Data,
          fileName: fileName || 'uploaded-file',
        });
        if (!tempFilePath) {
          return createErrorResponse('Failed to prepare file for upload');
        }
        files = [tempFilePath];
      }

      // Use shared CDP session manager to attach/do work/detach safely
      await cdpSessionManager.withSession(tabId, 'file-upload', async () => {
        // Enable necessary CDP domains
        await cdpSessionManager.sendCommand(tabId, 'DOM.enable', {});
        await cdpSessionManager.sendCommand(tabId, 'Runtime.enable', {});

        // Get the document
        const { root } = (await cdpSessionManager.sendCommand(tabId, 'DOM.getDocument', {
          depth: -1,
          pierce: true,
        })) as { root: { nodeId: number } };

        // Find the file input element using the selector
        const { nodeId } = (await cdpSessionManager.sendCommand(tabId, 'DOM.querySelector', {
          nodeId: root.nodeId,
          selector: selector,
        })) as { nodeId: number };

        if (!nodeId || nodeId === 0) {
          throw new Error(`Element with selector "${selector}" not found`);
        }

        // Verify it's actually a file input
        const { node } = (await cdpSessionManager.sendCommand(tabId, 'DOM.describeNode', {
          nodeId,
        })) as { node: { nodeName: string; attributes?: string[] } };

        if (node.nodeName !== 'INPUT') {
          throw new Error(`Element with selector "${selector}" is not an input element`);
        }

        // Check if it's a file input by looking for type="file" in attributes
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

        // Set the files on the input element
        await cdpSessionManager.sendCommand(tabId, 'DOM.setFileInputFiles', {
          nodeId,
          files,
        });

        // Trigger change event to ensure the page reacts to the file upload
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
              files: files,
              selector: selector,
              fileCount: files.length,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in file upload operation:', error);

      // Session manager handles detach; nothing extra needed here

      return createErrorResponse(
        `Error uploading file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // All debugger attach/detach is centrally managed by cdpSessionManager

  /**
   * Prepare file from URL or base64 data using native messaging host
   */
  private async prepareFileFromRemote(options: {
    fileUrl?: string;
    base64Data?: string;
    fileName: string;
  }): Promise<string | null> {
    const { fileUrl, base64Data, fileName } = options;

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
              fileUrl,
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
}

export const fileUploadTool = new FileUploadTool();
