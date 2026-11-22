import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { answerDialog, isTimeoutError, sendTimedDialogCommand } from '@/utils/cdp-input';
import { describeDialog, dialogTracker, type PendingDialog } from '@/utils/dialog-tracker';
import { hasDisallowedPublicUrlScheme } from './common';

interface HandleDialogParams {
  action: 'accept' | 'dismiss';
  promptText?: string;
  tabId?: number;
  windowId?: number;
}

const RESPONSIVENESS_PROBE_TIMEOUT_MS = 1500;
const FOLLOW_UP_DIALOG_GRACE_MS = 300;

const UNTRACKED_DIALOG_MESSAGE =
  'A JavaScript dialog appears to be blocking this tab, but it opened while no debugger session was observing the page, so Chrome cannot answer it remotely. ' +
  'Ask the user to close it, or reload the tab with chrome_navigate({ refresh: true }) to discard it. ' +
  'To avoid this, pass dialog: "accept" | "dismiss" to the click or key action that opens the dialog.';

/** True when the page's main thread still answers the debugger. */
async function isPageResponsive(tabId: number): Promise<boolean> {
  try {
    await sendTimedDialogCommand(
      tabId,
      'Runtime.evaluate',
      {
        expression: '1',
        returnByValue: true,
      },
      RESPONSIVENESS_PROBE_TIMEOUT_MS,
      'Page responsiveness probe',
    );
    return true;
  } catch (error) {
    return !isTimeoutError(error);
  }
}

/**
 * Answer JavaScript dialogs (alert/confirm/prompt/beforeunload) via CDP.
 *
 * `Page.enable` must not be sent first: while a dialog is open it waits on the
 * blocked renderer forever. `Page.handleJavaScriptDialog` is served by the
 * browser and answers any dialog observed by the attached debugger session
 * (dialog-aware click/key actions keep that session alive until it closes).
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
      if (hasDisallowedPublicUrlScheme(String(tab.url || ''))) {
        return createErrorResponse(
          'Only http:// and https:// pages are supported by chrome_handle_dialog',
        );
      }
      const targetTabId = tab.id;
      dialogTracker.ensureListening();
      const tracked = dialogTracker.get(targetTabId);

      let nextDialog: PendingDialog | null;
      try {
        nextDialog = await cdpSessionManager.withSession(targetTabId, 'dialog', async () => {
          await answerDialog(targetTabId, { action, promptText }, tracked);
          // Keep the observing session attached between the close and the next opening.
          const watcher = dialogTracker.waitForDialog(targetTabId);
          try {
            return await Promise.race([
              watcher.promise,
              new Promise<null>((resolve) => setTimeout(() => resolve(null), FOLLOW_UP_DIALOG_GRACE_MS)),
            ]);
          } finally {
            watcher.cancel();
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/no dialog is showing/i.test(message)) {
          if (!(await isPageResponsive(targetTabId))) {
            return createErrorResponse(UNTRACKED_DIALOG_MESSAGE);
          }
          return createErrorResponse('No JavaScript dialog is open on this tab.');
        }
        if (isTimeoutError(error)) {
          return createErrorResponse(
            `Timed out while answering the dialog. ${UNTRACKED_DIALOG_MESSAGE}`,
          );
        }
        throw error;
      }

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
              ...(tracked ? { dialog: describeDialog(tracked) } : {}),
              ...(nextDialog
                ? {
                    nextDialog: describeDialog(nextDialog),
                    message: `Another ${nextDialog.type} dialog opened: "${nextDialog.message}". Call chrome_handle_dialog again to answer it.`,
                  }
                : {}),
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
