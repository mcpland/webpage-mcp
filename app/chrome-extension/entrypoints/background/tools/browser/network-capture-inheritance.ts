import { NETWORK_CAPTURE_LIMITS } from './network-capture-limits';

/** Track children from the moment their opener starts extending a capture to them. */
export class PendingInheritedCaptures {
  private readonly starts = new Map<number, {
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

  async run(tabId: number, rootTabId: number, start: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    const done = start(controller.signal);
    this.starts.set(tabId, { rootTabId, controller, done });
    try {
      await done;
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      this.starts.delete(tabId);
    }
  }

  async cancel(rootTabId: number): Promise<void> {
    const cleanup: Promise<void>[] = [];
    for (const start of this.starts.values()) {
      if (start.rootTabId !== rootTabId) continue;
      start.controller.abort();
      cleanup.push(start.done);
    }
    await Promise.allSettled(cleanup);
  }
}
