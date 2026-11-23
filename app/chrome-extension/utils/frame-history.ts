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
    const prototype = window.Event?.prototype;
    const PopState = window.PopStateEvent;
    if (!prototype || typeof PopState !== 'function') return resolve(false);
    const key = Symbol.for('webpageMcp.consumedPopstate.v2');
    type Observation = { observers: Set<() => void>; restore: () => void };
    const scope = window as Window & { [key]?: Observation };
    let observation = scope[key];
    if (!observation) {
      // Both event.stopImmediatePropagation() and an explicit call through
      // Event.prototype reach this native method in the legacy document.
      const stop = Object.getOwnPropertyDescriptor(prototype, 'stopImmediatePropagation');
      const observers = new Set<() => void>();
      const observe = (event: Event | undefined) => {
        if (event instanceof PopState && event.isTrusted && event.type === 'popstate' &&
            event.target === window && event.eventPhase !== 0) {
          for (const notify of observers) notify();
        }
      };
      const restorers: Array<() => void> = [];
      if (stop?.writable && typeof stop.value === 'function') {
        const originalStop = stop.value;
        function observedStop(this: Event) {
          const result = originalStop.call(this);
          observe(this);
          return result;
        }
        Object.defineProperty(prototype, 'stopImmediatePropagation', { ...stop, value: observedStop });
        restorers.push(() => {
          if (Object.getOwnPropertyDescriptor(prototype, 'stopImmediatePropagation')?.value === observedStop) {
            Object.defineProperty(prototype, 'stopImmediatePropagation', stop);
          }
        });
      }
      // Old listeners can cache the native stop method and read either state getter.
      // Observe the event in flight without requesting, copying or replacing page state.
      const watchStateRead = (owner: object | undefined, activeEvent: (receiver: unknown) => Event | undefined) => {
        if (!owner) return;
        const state = Object.getOwnPropertyDescriptor(owner, 'state');
        if (!state?.configurable || !state.get) return;
        const getState = state.get;
        function observedState(this: unknown) {
          const value = getState.call(this);
          observe(activeEvent(this));
          return value;
        }
        Object.defineProperty(owner, 'state', { ...state, get: observedState });
        restorers.push(() => {
          if (Object.getOwnPropertyDescriptor(owner, 'state')?.get === observedState) {
            Object.defineProperty(owner, 'state', state);
          }
        });
      };
      watchStateRead(PopState.prototype, event => event as PopStateEvent);
      watchStateRead(window.History?.prototype, history => history === window.history ? window.event : undefined);
      if (!restorers.length) return resolve(false);
      observation = scope[key] = { observers, restore: () => { for (const restore of restorers) restore(); } };
    }
    const { observers, restore } = observation;
    const finish = (seen: boolean) => {
      clearTimeout(timer);
      window.removeEventListener(stopEvent, stop, true);
      observers.delete(notify);
      if (observers.size === 0 && scope[key] === observation) {
        restore();
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
