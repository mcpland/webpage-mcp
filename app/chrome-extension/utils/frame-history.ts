export type FrameHistoryRead = 'back' | 'forward' | 'current';

// Chrome serializes this function for scripting.executeScript. Keep it self-contained.
export function inspectFrameHistory(direction: FrameHistoryRead | 'observe'): string[] | number | { lateCount: number } {
  if (window === window.top) return [];
  const nav = (window as Window & { navigation?: {
    currentEntry: NavigationHistoryEntry | null;
    entries(): NavigationHistoryEntry[];
  } }).navigation;
  const current = nav?.currentEntry;
  if (!nav || !current) {
    // Opaque frames have no Navigation API entries. One listener per document
    // observes browser popstate without reading the page's history state.
    const scope = window as Window & { __webpageMcpPopstate?: { count: number; early?: boolean } };
    if (!scope.__webpageMcpPopstate) {
      const observed = { count: 0, early: direction === 'observe' };
      window.addEventListener('popstate', (event) => { if (event.isTrusted) observed.count++; }, { capture: true });
      scope.__webpageMcpPopstate = observed;
    }
    const observed = scope.__webpageMcpPopstate;
    if (!observed.early && (direction === 'back' || direction === 'forward')) return { lateCount: observed.count };
    return observed.count;
  }
  if (direction === 'observe') return [];
  if (direction === 'current') return [current.key];
  return nav.entries().filter((entry) => direction === 'back'
    ? entry.index < current.index : entry.index > current.index).map((entry) => entry.key);
}

/** A pre-existing page may consume the native event before a newly installed listener runs.
 * Observe that specific call in its own realm while leaving propagation and history state intact.
 * Chrome serializes the function into the target document.
 */
export function watchConsumedPopstate(stopEvent: string, remainingMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const prototype = window.PopStateEvent?.prototype;
    if (!prototype) return resolve(false);
    const key = Symbol.for('webpageMcp.consumedPopstate');
    const scope = window as Window & { [key]?: Set<() => void> };
    let observers = scope[key];
    if (!observers) {
      if (Object.hasOwn(prototype, 'stopImmediatePropagation') || !Object.isExtensible(prototype)) {
        return resolve(false);
      }
      const original = prototype.stopImmediatePropagation;
      function observed(this: Event) {
        original.call(this);
        if (this.isTrusted && this.type === 'popstate' && this.target === window && this.eventPhase !== 0) {
          for (const notify of observers!) notify();
        }
      }
      Object.defineProperty(prototype, 'stopImmediatePropagation', {
        value: observed, configurable: true, writable: true,
      });
      observers = scope[key] = new Set();
    }
    const registeredMethod = prototype.stopImmediatePropagation;
    const finish = (seen: boolean) => {
      clearTimeout(timer);
      window.removeEventListener(stopEvent, stop, true);
      observers.delete(notify);
      if (observers.size === 0 && scope[key] === observers) {
        if (prototype.stopImmediatePropagation === registeredMethod) Reflect.deleteProperty(prototype, 'stopImmediatePropagation');
        delete scope[key];
      }
      resolve(seen);
    };
    const stop = () => finish(false);
    const notify = () => finish(true);
    const timer = setTimeout(stop, remainingMs);
    observers.add(notify);
    window.addEventListener(stopEvent, stop, { capture: true, once: true });
  });
}
