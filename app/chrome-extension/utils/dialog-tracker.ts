import { cdpSessionManager } from './cdp-session-manager';

/**
 * Tracks JavaScript dialogs (alert/confirm/prompt/beforeunload) reported by
 * debugger sessions that have the Page domain enabled.
 *
 * Chrome only lets the session that observed `Page.javascriptDialogOpening`
 * answer the dialog; a session attached afterwards gets "No dialog is
 * showing", and `Page.enable` itself blocks while the dialog holds the
 * renderer. The tracker therefore keeps a debugger lease for every pending
 * dialog so the observing session stays attached until the dialog closes.
 */

export interface PendingDialog {
  tabId: number;
  type: string;
  message: string;
  defaultPrompt?: string;
  url?: string;
  openedAt: number;
}

export interface DialogResponse {
  action: 'accept' | 'dismiss';
  promptText?: string;
}

const LEASE_OWNER = 'dialog-pending';
const MAX_MESSAGE_CHARS = 2000;
const MAX_URL_CHARS = 2048;

function clip(value: unknown, maximum: number): string {
  const text = typeof value === 'string' ? value : '';
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

/** Normalize a tool's `dialog` argument. Returns an Error for invalid input. */
export function parseDialogResponse(value: unknown): DialogResponse | undefined | Error {
  if (value === undefined || value === null) return undefined;
  if (value === 'accept' || value === 'dismiss') return { action: value };
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.action !== 'accept' && record.action !== 'dismiss') {
      return new Error('dialog.action must be "accept" or "dismiss"');
    }
    if (record.promptText !== undefined && typeof record.promptText !== 'string') {
      return new Error('dialog.promptText must be a string');
    }
    return {
      action: record.action,
      ...(typeof record.promptText === 'string' ? { promptText: record.promptText } : {}),
    };
  }
  return new Error('dialog must be "accept", "dismiss", or { action, promptText }');
}

/** Public, bounded description of a dialog for tool results. */
export function describeDialog(dialog: PendingDialog): Record<string, unknown> {
  return {
    type: dialog.type,
    message: dialog.message,
    ...(dialog.defaultPrompt ? { defaultPrompt: dialog.defaultPrompt } : {}),
  };
}

class DialogTracker {
  private readonly pending = new Map<number, PendingDialog>();
  private readonly waiters = new Map<number, Set<(dialog: PendingDialog) => void>>();
  private readonly leases = new Map<number, Promise<boolean>>();
  private listening = false;

  ensureListening(): void {
    if (this.listening) return;
    const debuggerApi = typeof chrome !== 'undefined' ? chrome.debugger : undefined;
    if (!debuggerApi?.onEvent?.addListener) return;
    debuggerApi.onEvent.addListener(this.handleEvent);
    // Prefer CDPSessionManager's filtered detach notifications so delayed
    // local canceled_by_user events from a prior detach never tear down a
    // newer live dialog session.
    if (typeof cdpSessionManager.onExternalDetach === 'function') {
      cdpSessionManager.onExternalDetach((tabId) => this.forget(tabId));
    } else {
      debuggerApi.onDetach?.addListener?.(this.handleDetach);
    }
    chrome.tabs?.onRemoved?.addListener?.(this.handleTabRemoved);
    this.listening = true;
  }

  get(tabId: number): PendingDialog | undefined {
    return this.pending.get(tabId);
  }

  /** Resolves with the next dialog that opens on `tabId` (or one already open). */
  waitForDialog(tabId: number): { promise: Promise<PendingDialog>; cancel: () => void } {
    let listener: ((dialog: PendingDialog) => void) | undefined;
    const promise = new Promise<PendingDialog>((resolve) => {
      const existing = this.pending.get(tabId);
      if (existing) {
        resolve(existing);
        return;
      }
      listener = resolve;
      let set = this.waiters.get(tabId);
      if (!set) {
        set = new Set();
        this.waiters.set(tabId, set);
      }
      set.add(listener);
    });
    return {
      promise,
      cancel: () => {
        if (!listener) return;
        const set = this.waiters.get(tabId);
        set?.delete(listener);
        if (set && set.size === 0) this.waiters.delete(tabId);
      },
    };
  }

  /** Forget `dialog` only if it is still the tab's pending dialog. */
  forgetIf(tabId: number, dialog: PendingDialog | undefined): void {
    if (dialog && this.pending.get(tabId) === dialog) this.forget(tabId);
  }

  /** Drop a dialog (closed or no longer answerable) and release its lease. */
  forget(tabId: number): void {
    this.pending.delete(tabId);
    const lease = this.leases.get(tabId);
    if (!lease) return;
    this.leases.delete(tabId);
    void lease
      .then((held) => (held ? cdpSessionManager.detach(tabId, LEASE_OWNER) : undefined))
      .catch(() => {});
  }

  private readonly handleEvent = (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object,
  ): void => {
    const tabId = source?.tabId;
    if (typeof tabId !== 'number') return;
    if (method === 'Page.javascriptDialogOpening') {
      const raw = (params || {}) as Record<string, unknown>;
      const dialog: PendingDialog = {
        tabId,
        type: clip(raw.type, 32) || 'alert',
        message: clip(raw.message, MAX_MESSAGE_CHARS),
        ...(typeof raw.defaultPrompt === 'string' && raw.defaultPrompt
          ? { defaultPrompt: clip(raw.defaultPrompt, MAX_MESSAGE_CHARS) }
          : {}),
        ...(typeof raw.url === 'string' ? { url: clip(raw.url, MAX_URL_CHARS) } : {}),
        openedAt: Date.now(),
      };
      this.pending.set(tabId, dialog);
      if (!this.leases.has(tabId)) {
        // Only hold a lease on the already-attached observing session; never
        // initiate a fresh debugger attach after an external detach.
        const lease =
          typeof cdpSessionManager.attachIfExisting === 'function'
            ? cdpSessionManager.attachIfExisting(tabId, LEASE_OWNER).catch(() => false)
            : cdpSessionManager.attach(tabId, LEASE_OWNER).then(
                () => true,
                () => false,
              );
        this.leases.set(tabId, lease);
      }
      const set = this.waiters.get(tabId);
      if (set) {
        this.waiters.delete(tabId);
        for (const resolve of set) resolve(dialog);
      }
    } else if (method === 'Page.javascriptDialogClosed') {
      this.forget(tabId);
    }
  };

  private readonly handleDetach = (source: chrome.debugger.Debuggee): void => {
    // The observing session is gone; the dialog can no longer be answered remotely.
    if (typeof source?.tabId === 'number') this.forget(source.tabId);
  };

  private readonly handleTabRemoved = (tabId: number): void => {
    this.forget(tabId);
  };
}

export const dialogTracker = new DialogTracker();
