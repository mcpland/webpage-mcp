// Simple in-memory screenshot context manager per tab
// Used to scale coordinates from screenshot space to viewport space

export interface ScreenshotContext {
  // Final screenshot dimensions (in CSS pixels after any scaling)
  screenshotWidth: number;
  screenshotHeight: number;
  // Viewport dimensions (CSS pixels)
  viewportWidth: number;
  viewportHeight: number;
  // Device pixel ratio at capture time (optional, for reference)
  devicePixelRatio?: number;
  // Hostname of the page when the screenshot was taken (used for domain safety checks)
  hostname?: string;
  // Timestamp
  timestamp: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes

const contexts = new Map<number, ScreenshotContext>();

type TabRemovedEvent = typeof chrome.tabs.onRemoved;
type NavigationCommittedEvent = typeof chrome.webNavigation.onCommitted;
type TabRemovedListener = Parameters<TabRemovedEvent['addListener']>[0];
type NavigationCommittedListener = Parameters<
  NavigationCommittedEvent['addListener']
>[0];

interface LifecycleRegistration {
  tabRemovedEvent: TabRemovedEvent;
  navigationCommittedEvent?: NavigationCommittedEvent;
}

let lifecycleRegistration: LifecycleRegistration | undefined;

const handleTabRemoved: TabRemovedListener = (tabId) => {
  contexts.delete(tabId);
};

const handleNavigationCommitted: NavigationCommittedListener = (details) => {
  if (details.frameId === 0) {
    contexts.delete(details.tabId);
  }
};

export const screenshotContextManager = {
  setContext(tabId: number, ctx: Omit<ScreenshotContext, 'timestamp'>) {
    contexts.set(tabId, { ...ctx, timestamp: Date.now() });
  },
  getContext(tabId: number): ScreenshotContext | undefined {
    const ctx = contexts.get(tabId);
    if (!ctx) return undefined;
    if (Date.now() - ctx.timestamp > TTL_MS) {
      contexts.delete(tabId);
      return undefined;
    }
    return ctx;
  },
  clear(tabId: number) {
    contexts.delete(tabId);
  },
};

/**
 * Bind screenshot contexts to their owning tab/document lifetime.
 *
 * Chrome discards extension event listeners when a service worker stops, so a
 * fresh worker can register normally. Within one worker lifetime this function
 * is idempotent, preventing duplicate listeners when background setup is
 * invoked more than once (for example during development reloads).
 */
export function initScreenshotContextLifecycle(): () => void {
  if (lifecycleRegistration) {
    return disposeScreenshotContextLifecycle;
  }

  const tabRemovedEvent = chrome.tabs.onRemoved;
  const navigationCommittedEvent = chrome.webNavigation?.onCommitted;

  tabRemovedEvent.addListener(handleTabRemoved);
  navigationCommittedEvent?.addListener(handleNavigationCommitted);
  lifecycleRegistration = { tabRemovedEvent, navigationCommittedEvent };

  return disposeScreenshotContextLifecycle;
}

/** Remove lifecycle listeners and discard all in-memory contexts. */
export function disposeScreenshotContextLifecycle(): void {
  const registration = lifecycleRegistration;
  if (!registration) {
    return;
  }

  lifecycleRegistration = undefined;
  registration.tabRemovedEvent.removeListener(handleTabRemoved);
  registration.navigationCommittedEvent?.removeListener(
    handleNavigationCommitted,
  );
  contexts.clear();
}

// Scale screenshot-space coordinates (x,y) to viewport CSS pixels
export function scaleCoordinates(
  x: number,
  y: number,
  ctx: ScreenshotContext,
): { x: number; y: number } {
  if (!ctx.screenshotWidth || !ctx.screenshotHeight || !ctx.viewportWidth || !ctx.viewportHeight) {
    return { x, y };
  }
  const sx = (x / ctx.screenshotWidth) * ctx.viewportWidth;
  const sy = (y / ctx.screenshotHeight) * ctx.viewportHeight;
  return { x: Math.round(sx), y: Math.round(sy) };
}
