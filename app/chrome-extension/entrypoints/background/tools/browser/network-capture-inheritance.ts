import { readWithSignal } from '@/utils/read-with-signal';
import { NETWORK_CAPTURE_LIMITS } from './network-capture-limits';

export function getCaptureTab(tabId: number, signal?: AbortSignal): Promise<chrome.tabs.Tab> {
  return readWithSignal(() => chrome.tabs.get(tabId), signal);
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

  async cancel(tabId: number, match: 'openerTabId' | 'rootTabId'): Promise<void> {
    const cleanup: Promise<void>[] = [];
    for (const start of this.starts.values()) {
      if (start[match] !== tabId) continue;
      start.controller.abort();
      cleanup.push(start.done);
    }
    await Promise.allSettled(cleanup);
  }
}
