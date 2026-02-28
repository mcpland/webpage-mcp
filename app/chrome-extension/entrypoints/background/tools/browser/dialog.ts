import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

interface HandleDialogParams {
  action: 'accept' | 'dismiss';
  promptText?: string;
  tabId?: number;
  windowId?: number;
}

/**
 * Handle JavaScript dialogs (alert/confirm/prompt) via CDP Page.handleJavaScriptDialog
 */
class HandleDialogTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.HANDLE_DIALOG;

  async execute(args: HandleDialogParams): Promise<ToolResult> {
    const { action, promptText, tabId, windowId } = args || ({} as HandleDialogParams);
    if (!action || (action !== 'accept' && action !== 'dismiss')) {
      return createErrorResponse('action must be "accept" or "dismiss"');
    }

    try {
      const explicit = await this.tryGetTab(tabId);
      const tab = explicit || (await this.getActiveTabInWindow(windowId));
      if (!tab?.id) return createErrorResponse('No active tab found');
      const targetTabId = tab.id!;

      // Use shared CDP session manager for safe attach/detach with refcount
      await cdpSessionManager.withSession(targetTabId, 'dialog', async () => {
        await cdpSessionManager.sendCommand(targetTabId, 'Page.enable');
        await cdpSessionManager.sendCommand(targetTabId, 'Page.handleJavaScriptDialog', {
          accept: action === 'accept',
          promptText: action === 'accept' ? promptText : undefined,
        });
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              action,
              promptText: promptText || null,
              tabId: targetTabId,
              windowId: tab.windowId,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Failed to handle dialog: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const handleDialogTool = new HandleDialogTool();
