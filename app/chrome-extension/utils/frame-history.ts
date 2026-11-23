export type FrameHistoryRead = 'back' | 'forward' | 'current';

// Chrome serializes this function for scripting.executeScript. Keep it self-contained.
export function inspectFrameHistory(direction: FrameHistoryRead | 'observe'): string[] | number {
  if (window === window.top) return [];
  const nav = (window as Window & { navigation?: {
    currentEntry: NavigationHistoryEntry | null;
    entries(): NavigationHistoryEntry[];
  } }).navigation;
  const current = nav?.currentEntry;
  if (!nav || !current) {
    // Opaque frames have no Navigation API entries. One listener per document
    // observes browser popstate without reading the page's history state.
    const scope = window as Window & { __webpageMcpPopstate?: { count: number } };
    if (!scope.__webpageMcpPopstate) {
      const observed = { count: 0 };
      window.addEventListener('popstate', (event) => { if (event.isTrusted) observed.count++; }, { capture: true });
      scope.__webpageMcpPopstate = observed;
    }
    return scope.__webpageMcpPopstate.count;
  }
  if (direction === 'observe') return [];
  if (direction === 'current') return [current.key];
  return nav.entries().filter((entry) => direction === 'back'
    ? entry.index < current.index : entry.index > current.index).map((entry) => entry.key);
}
