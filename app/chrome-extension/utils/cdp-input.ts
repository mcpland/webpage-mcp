import { runInBackgroundFocusQueue } from '@/entrypoints/background/tab-queue';
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
export const RESPONSIVENESS_PROBE_TIMEOUT_MS = 1500;
/** How quickly a page that just resumed must answer before it counts as blocked. */
const FOLLOW_UP_PROBE_TIMEOUT_MS = 500;
/** Upper bound for a blocking dialog's opening event to arrive. */
const FOLLOW_UP_EVENT_WAIT_MS = 3000;

export class PageUnresponsiveError extends Error {
  constructor() {
    super(
      'The page is not responding to the debugger; a JavaScript dialog is probably already open. ' +
        'Use chrome_handle_dialog, or reload the tab with chrome_navigate({ refresh: true }) to discard it.',
    );
    this.name = 'PageUnresponsiveError';
  }
}

/**
 * Thrown when the debugger could not be attached or initialized before any
 * input was dispatched, so callers may safely fall back to DOM helpers.
 */
export class CdpUnavailableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'CdpUnavailableError';
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

// Chrome cannot cancel an individual command. Abort the command signal so the
// session manager releases its lease before rejecting, while bounding the wait
// even if an underlying mock ignores AbortSignal.
export async function sendTimedDialogCommand(
  tabId: number,
  method: string,
  params: object | undefined,
  timeoutMs: number,
  label: string,
  externalSignal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let onExternalAbort: (() => void) | undefined;

  const sendPromise = cdpSessionManager.sendCommand(tabId, method, params, controller.signal);
  const abortFallback = new Promise<never>((_, reject) => {
    const triggerAbort = (reason: unknown) => {
      controller.abort(reason);
      // Let sendCommand's finally { await detach() } run first when it honors signal.
      fallbackTimer = setTimeout(() => reject(reason), 0);
    };
    timer = setTimeout(() => {
      triggerAbort(new InputTimeoutError(label, timeoutMs));
    }, timeoutMs);
    if (externalSignal) {
      onExternalAbort = () => {
        triggerAbort(externalSignal.reason ?? new Error('Dialog command aborted'));
      };
      if (externalSignal.aborted) onExternalAbort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  });

  try {
    await Promise.race([sendPromise, abortFallback]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    if (onExternalAbort) externalSignal?.removeEventListener('abort', onExternalAbort);
    controller.abort();
  }
}

/** Hidden Chrome tabs can acknowledge native mouse input without delivering it.
 * Emulate renderer focus before measuring the target, without activating the tab.
 */
export async function withBackgroundClickFocus<T>(
  tabId: number,
  click: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return runInBackgroundFocusQueue(tabId, async () => {
    try {
      await cdpSessionManager.attach(tabId, 'background-click');
    } catch {
      // The click tool can still use its element-based fallback without a debugger.
      signal?.throwIfAborted();
      return click();
    }
    try {
      await sendTimedDialogCommand(tabId, 'Emulation.setFocusEmulationEnabled',
        { enabled: true }, PAGE_ENABLE_TIMEOUT_MS, 'Enable background focus', signal);
      signal?.throwIfAborted();
      return await click();
    } finally {
      // Other tools may still hold debugger leases; detaching only our lease
      // does not necessarily clear emulation. Cleanup also runs after cancellation.
      try {
        await sendTimedDialogCommand(tabId, 'Emulation.setFocusEmulationEnabled',
          { enabled: false }, PAGE_ENABLE_TIMEOUT_MS, 'Restore background focus');
      } catch (error) {
        // A click may have closed the tab. Keep its outcome so callers don't replay it.
        console.warn('Could not restore background focus on tab', tabId, error);
      } finally {
        await cdpSessionManager.detach(tabId, 'background-click');
      }
    }
  }, signal);
}

/** True when the page's main thread still answers the debugger. */
export async function isPageResponsive(
  tabId: number,
  timeoutMs = RESPONSIVENESS_PROBE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return true;
  try {
    await sendTimedDialogCommand(
      tabId,
      'Runtime.evaluate',
      { expression: '1', returnByValue: true },
      timeoutMs,
      'Page responsiveness probe',
      signal,
    );
    return true;
  } catch (error) {
    if (signal?.aborted) return true;
    return !isTimeoutError(error);
  }
}

function cancellableSleep(ms: number): { promise: Promise<null>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/**
 * After a dialog was answered, wait for the dialog the page may open next
 * (a confirm followed by an alert). Chrome can report that dialog well after
 * it blocked the page (headless Chrome took ~500ms), longer than any fixed
 * grace. A page that stops answering right after it resumed is showing it,
 * so its event is awaited instead of leaving the page blocked and unobserved.
 */
export async function waitForFollowUpDialog(
  tabId: number,
  next: Promise<PendingDialog>,
  graceMs: number,
): Promise<PendingDialog | null> {
  const earlySleep = cancellableSleep(graceMs);
  try {
    const early = await Promise.race([next, earlySleep.promise]);
    if (early) return early;
  } finally {
    earlySleep.cancel();
  }

  const probeAbort = new AbortController();
  let eventSleep: { promise: Promise<null>; cancel: () => void } | undefined;
  try {
    return await Promise.race([
      next,
      isPageResponsive(tabId, FOLLOW_UP_PROBE_TIMEOUT_MS, probeAbort.signal).then((responsive) => {
        if (responsive || probeAbort.signal.aborted) return null;
        eventSleep = cancellableSleep(FOLLOW_UP_EVENT_WAIT_MS);
        return Promise.race([next, eventSleep.promise]);
      }),
    ]);
  } finally {
    probeAbort.abort();
    eventSleep?.cancel();
  }
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'InputTimeoutError';
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
  dialog = dialogTracker.get(tabId),
): Promise<void> {
  await sendTimedDialogCommand(
    tabId,
    'Page.handleJavaScriptDialog',
    {
      accept: response.action === 'accept',
      ...(response.action === 'accept' && response.promptText !== undefined
        ? { promptText: response.promptText }
        : {}),
    },
    DIALOG_ANSWER_TIMEOUT_MS,
    'Answering the JavaScript dialog',
  );
  // The closed event also clears it; never drop a newer dialog that the page
  // opened in the meantime.
  dialogTracker.forgetIf(tabId, dialog);
}

export async function runCdpInputWithDialogs(
  tabId: number,
  owner: string,
  dispatch: (signal: AbortSignal) => Promise<unknown>,
  options: { dialog?: DialogResponse; graceMs?: number } = {},
): Promise<CdpInputResult> {
  dialogTracker.ensureListening();
  // Fail fast when a dialog is already tracked on this tab instead of waiting
  // on Page.enable or accidentally dispatching input behind the open dialog.
  if (dialogTracker.get(tabId)) {
    throw new PageUnresponsiveError();
  }
  try {
    await cdpSessionManager.attach(tabId, owner);
  } catch (error) {
    throw new CdpUnavailableError(error);
  }
  let watcher = dialogTracker.waitForDialog(tabId);
  const dispatchAbort = new AbortController();
  try {
    try {
      await sendTimedDialogCommand(
        tabId,
        'Page.enable',
        undefined,
        PAGE_ENABLE_TIMEOUT_MS,
        'Page.enable',
      );
    } catch (error) {
      if (isTimeoutError(error)) throw new PageUnresponsiveError();
      throw new CdpUnavailableError(error);
    }

    const inputDone = Promise.resolve().then(() => dispatch(dispatchAbort.signal));
    // While a dialog is open the dispatch stays pending; never leave it unobserved.
    inputDone.catch(() => {});

    const graceMs = options.graceMs ?? DIALOG_GRACE_MS;
    const first = await Promise.race([inputDone.then(() => null), watcher.promise]);
    let dialog: PendingDialog | null = first;
    if (!dialog && graceMs > 0) {
      const graceSleep = cancellableSleep(graceMs);
      try {
        dialog = await Promise.race([watcher.promise, graceSleep.promise]);
      } finally {
        graceSleep.cancel();
      }
    }
    if (!dialog) return {};
    if (!options.dialog) {
      // Stop any remaining steps of a multi-step dispatch from resuming out-of-band
      // once the user later answers the dialog.
      dispatchAbort.abort();
      return { dialog: outcome(dialog, false) };
    }

    // Answer the dialog and any dialogs the same handler opens right after it
    // (for example a confirm followed by an alert).
    const answered: DialogOutcome[] = [];
    while (dialog && answered.length < MAX_CHAINED_DIALOGS) {
      watcher.cancel();
      await answerDialog(tabId, options.dialog, dialog);
      answered.push(outcome(dialog, options.dialog.action));
      watcher = dialogTracker.waitForDialog(tabId);
      const next = watcher.promise;
      dialog = await Promise.race([
        next,
        withTimeout(inputDone, INPUT_SETTLE_TIMEOUT_MS, 'Input dispatch').then(
          () => waitForFollowUpDialog(tabId, next, graceMs),
          () => null,
        ),
      ]);
    }
    if (dialog) {
      // Chained dialog cap reached while another dialog is still open: surface it
      // as unhandled so callers and page-change detection know the tab is blocked.
      dispatchAbort.abort();
      const pending = outcome(dialog, false);
      answered.push(pending);
      return { dialog: pending, dialogs: answered };
    }
    return answered.length > 1
      ? { dialog: answered[0], dialogs: answered }
      : { dialog: answered[0] };
  } finally {
    dispatchAbort.abort();
    watcher.cancel();
    await cdpSessionManager.detach(tabId, owner);
  }
}

/** Human-readable hint for a dialog that is still waiting for an answer. */
export function pendingDialogHint(dialog: DialogOutcome): string {
  return `A JavaScript ${dialog.type} dialog is open: "${dialog.message}". Answer it with chrome_handle_dialog, or pass dialog: "accept" | "dismiss" with the action.`;
}
