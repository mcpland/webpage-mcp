import { cdpSessionManager } from './cdp-session-manager';
import {
  describeDialog,
  dialogTracker,
  type DialogResponse,
  type PendingDialog,
} from './dialog-tracker';

/**
 * Runs CDP input (mouse/keyboard) so that a JavaScript dialog opened by the
 * input can never hang the caller.
 *
 * `Input.dispatchMouseEvent`/`dispatchKeyEvent` only resolve after the page has
 * handled the event, and a modal dialog opened by that handler blocks the page
 * until the dialog is answered. With the Page domain enabled the dialog is
 * reported as an event instead, so the action returns as soon as it opens and
 * either answers it (when the caller asked to) or reports it for
 * chrome_handle_dialog.
 */

export const PAGE_ENABLE_TIMEOUT_MS = 2000;
export const DIALOG_GRACE_MS = 150;
const DIALOG_ANSWER_TIMEOUT_MS = 5000;
const INPUT_SETTLE_TIMEOUT_MS = 5000;
const MAX_CHAINED_DIALOGS = 3;

export class PageUnresponsiveError extends Error {
  constructor() {
    super(
      'The page is not responding to the debugger; a JavaScript dialog is probably already open. ' +
        'Use chrome_handle_dialog, or reload the tab with chrome_navigate({ refresh: true }) to discard it.',
    );
    this.name = 'PageUnresponsiveError';
  }
}

class InputTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'InputTimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new InputTimeoutError(label, timeoutMs)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'InputTimeoutError';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DialogOutcome {
  type: string;
  message: string;
  defaultPrompt?: string;
  /** How the dialog was answered, or false when it is still open. */
  handled: false | 'accept' | 'dismiss';
}

export interface CdpInputResult {
  dialog?: DialogOutcome;
  /** Present when the input opened more than one dialog in a row. */
  dialogs?: DialogOutcome[];
}

function outcome(dialog: PendingDialog, handled: DialogOutcome['handled']): DialogOutcome {
  return { ...(describeDialog(dialog) as Omit<DialogOutcome, 'handled'>), handled };
}

export async function answerDialog(
  tabId: number,
  response: DialogResponse,
  dialog?: PendingDialog,
): Promise<void> {
  await withTimeout(
    cdpSessionManager.sendCommand(tabId, 'Page.handleJavaScriptDialog', {
      accept: response.action === 'accept',
      ...(response.action === 'accept' && response.promptText !== undefined
        ? { promptText: response.promptText }
        : {}),
    }),
    DIALOG_ANSWER_TIMEOUT_MS,
    'Answering the JavaScript dialog',
  );
  // The closed event also clears it; never drop a newer dialog that the page
  // opened in the meantime.
  dialogTracker.forgetIf(tabId, dialog ?? dialogTracker.get(tabId));
}

export async function runCdpInputWithDialogs(
  tabId: number,
  owner: string,
  dispatch: () => Promise<unknown>,
  options: { dialog?: DialogResponse; graceMs?: number } = {},
): Promise<CdpInputResult> {
  dialogTracker.ensureListening();
  await cdpSessionManager.attach(tabId, owner);
  let watcher = dialogTracker.waitForDialog(tabId);
  try {
    try {
      await withTimeout(
        cdpSessionManager.sendCommand(tabId, 'Page.enable'),
        PAGE_ENABLE_TIMEOUT_MS,
        'Page.enable',
      );
    } catch (error) {
      if (isTimeoutError(error)) throw new PageUnresponsiveError();
      throw error;
    }

    const inputDone = Promise.resolve().then(dispatch);
    // While a dialog is open the dispatch stays pending; never leave it unobserved.
    inputDone.catch(() => {});

    const graceMs = options.graceMs ?? DIALOG_GRACE_MS;
    const first = await Promise.race([inputDone.then(() => null), watcher.promise]);
    let dialog: PendingDialog | null =
      first ??
      (graceMs > 0
        ? await Promise.race([watcher.promise, sleep(graceMs).then(() => null)])
        : null);
    if (!dialog) return {};
    if (!options.dialog) return { dialog: outcome(dialog, false) };

    // Answer the dialog and any dialogs the same handler opens right after it
    // (for example a confirm followed by an alert).
    const answered: DialogOutcome[] = [];
    while (dialog && answered.length < MAX_CHAINED_DIALOGS) {
      watcher.cancel();
      await answerDialog(tabId, options.dialog, dialog);
      answered.push(outcome(dialog, options.dialog.action));
      watcher = dialogTracker.waitForDialog(tabId);
      dialog = await Promise.race([
        watcher.promise,
        withTimeout(inputDone, INPUT_SETTLE_TIMEOUT_MS, 'Input dispatch').then(
          () => null,
          () => null,
        ),
      ]);
    }
    return answered.length > 1
      ? { dialog: answered[0], dialogs: answered }
      : { dialog: answered[0] };
  } finally {
    watcher.cancel();
    await cdpSessionManager.detach(tabId, owner);
  }
}

/** Human-readable hint for a dialog that is still waiting for an answer. */
export function pendingDialogHint(dialog: DialogOutcome): string {
  return `A JavaScript ${dialog.type} dialog is open: "${dialog.message}". Answer it with chrome_handle_dialog, or pass dialog: "accept" | "dismiss" with the action.`;
}
