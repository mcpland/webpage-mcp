import { NETWORK_CAPTURE_LIMITS } from './network-capture-limits';

/** A read-only preparation step needs no cleanup if Chrome replies after cancellation. */
export async function getCaptureTab(tabId: number, signal?: AbortSignal): Promise<chrome.tabs.Tab> {
  signal?.throwIfAborted();
  const tab = chrome.tabs.get(tabId);
  if (!signal) return tab;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([tab, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Track children from the moment their opener starts extending a capture to them. */
export class PendingInheritedCaptures {
  private readonly starts = new Map<number, {
    openerTabId: number;
    rootTabId: number;
    controller: AbortController;
    done: Promise<void>;
  }>();

  get size(): number {
    return this.starts.size;
  }

  canStart(tabId: number, activeCount: number): boolean {
    return !this.starts.has(tabId) && activeCount + this.starts.size < NETWORK_CAPTURE_LIMITS.maxTabs;
  }

  async run(
    tabId: number,
    openerTabId: number,
    rootTabId: number,
    start: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    // Give Chrome time to initialize the new tab, but let a stop release it immediately.
    const ready = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      controller.signal.onabort = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    const done = ready.then(() => {
      controller.signal.onabort = null;
      if (!controller.signal.aborted) return start(controller.signal);
    });
    this.starts.set(tabId, { openerTabId, rootTabId, controller, done });
    try {
      await done;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      this.starts.delete(tabId);
    }
  }

  async cancel(stoppedTabId: number): Promise<void> {
    const cleanup: Promise<void>[] = [];
    for (const start of this.starts.values()) {
      if (start.rootTabId !== stoppedTabId && start.openerTabId !== stoppedTabId) continue;
      start.controller.abort();
      cleanup.push(start.done);
    }
    await Promise.allSettled(cleanup);
  }
}
