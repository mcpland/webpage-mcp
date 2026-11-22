import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  answerDialog,
  isPageResponsive,
  isTimeoutError,
  waitForFollowUpDialog,
  withTimeout,
} from '@/utils/cdp-input';
import { describeDialog, dialogTracker, type PendingDialog } from '@/utils/dialog-tracker';
import { hasDisallowedPublicUrlScheme } from './common';

interface HandleDialogParams {
  action: 'accept' | 'dismiss';
  promptText?: string;
  tabId?: number;
  windowId?: number;
}

const DIALOG_CONNECT_TIMEOUT_MS = 5000;
const FOLLOW_UP_DIALOG_GRACE_MS = 300;

const UNTRACKED_DIALOG_MESSAGE =
  'A JavaScript dialog appears to be blocking this tab, but it opened while no debugger session was observing the page, so Chrome cannot answer it remotely. ' +
  'Ask the user to close it, or reload the tab with chrome_navigate({ refresh: true }) to discard it. ' +
  'To avoid this, pass dialog: "accept" | "dismiss" to the click or key action that opens the dialog.';

async function withDialogSession<T>(tabId: number, action: () => Promise<T>): Promise<T> {
  const owner = Symbol('dialog');
  const connecting = cdpSessionManager.attach(tabId, owner);
  try {
    await withTimeout(connecting, DIALOG_CONNECT_TIMEOUT_MS, 'Dialog debugger connection');
  } catch (error) {
    if (isTimeoutError(error)) {
      // Chrome cannot cancel attach. A late connection may only release this request's lease.
      void connecting.then(() => cdpSessionManager.detach(tabId, owner)).catch(() => {});
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await cdpSessionManager.detach(tabId, owner);
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

      let outcome:
        | { kind: 'ok'; nextDialog: PendingDialog | null }
        | { kind: 'error'; message: string };
      try {
        outcome = await withDialogSession(targetTabId, async () => {
          try {
            await answerDialog(targetTabId, { action, promptText }, tracked);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/no dialog is showing/i.test(message)) {
              // Drop any stale tracked dialog so its lease does not leak or poison later waits.
              dialogTracker.forgetIf(targetTabId, tracked);
              if (!(await isPageResponsive(targetTabId))) {
                return { kind: 'error' as const, message: UNTRACKED_DIALOG_MESSAGE };
              }
              return {
                kind: 'error' as const,
                message: 'No JavaScript dialog is open on this tab.',
              };
            }
            throw error;
          }
          // Keep the observing session attached between the close and the next opening.
          const watcher = dialogTracker.waitForDialog(targetTabId);
          try {
            const nextDialog = await waitForFollowUpDialog(
              targetTabId,
              watcher.promise,
              FOLLOW_UP_DIALOG_GRACE_MS,
            );
            return { kind: 'ok' as const, nextDialog };
          } finally {
            watcher.cancel();
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isTimeoutError(error)) {
          return createErrorResponse(`${message}. ${UNTRACKED_DIALOG_MESSAGE}`);
        }
        throw error;
      }

      if (outcome.kind === 'error') {
        return createErrorResponse(outcome.message);
      }
      const nextDialog = outcome.nextDialog;

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
