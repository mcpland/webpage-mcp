import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type TabRemovedListener = Parameters<
  typeof chrome.tabs.onRemoved.addListener
>[0];
type NavigationCommittedListener = Parameters<
  typeof chrome.webNavigation.onCommitted.addListener
>[0];

describe('screenshot context lifecycle', () => {
  const tabRemovedListeners = new Set<TabRemovedListener>();
  const navigationCommittedListeners = new Set<NavigationCommittedListener>();

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    tabRemovedListeners.clear();
    navigationCommittedListeners.clear();

    vi.mocked(chrome.tabs.onRemoved.addListener).mockImplementation(
      (listener) => {
        tabRemovedListeners.add(listener);
      },
    );
    vi.mocked(chrome.tabs.onRemoved.removeListener).mockImplementation(
      (listener) => {
        tabRemovedListeners.delete(listener);
      },
    );
    vi.mocked(chrome.webNavigation.onCommitted.addListener).mockImplementation(
      (listener) => {
        navigationCommittedListeners.add(listener);
      },
    );
    vi.mocked(
      chrome.webNavigation.onCommitted.removeListener,
    ).mockImplementation((listener) => {
      navigationCommittedListeners.delete(listener);
    });
  });

  afterEach(async () => {
    const { disposeScreenshotContextLifecycle } =
      await import('@/utils/screenshot-context');
    disposeScreenshotContextLifecycle();
    vi.useRealTimers();
  });

  it('expires contexts after the five-minute TTL', async () => {
    const { screenshotContextManager } =
      await import('@/utils/screenshot-context');
    screenshotContextManager.setContext(1, {
      screenshotWidth: 1000,
      screenshotHeight: 800,
      viewportWidth: 500,
      viewportHeight: 400,
    });

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(screenshotContextManager.getContext(1)).toBeDefined();

    vi.advanceTimersByTime(1);
    expect(screenshotContextManager.getContext(1)).toBeUndefined();
  });

  it('clears a context as soon as its tab is removed', async () => {
    const { initScreenshotContextLifecycle, screenshotContextManager } =
      await import('@/utils/screenshot-context');
    initScreenshotContextLifecycle();
    screenshotContextManager.setContext(7, {
      screenshotWidth: 1000,
      screenshotHeight: 800,
      viewportWidth: 500,
      viewportHeight: 400,
    });

    for (const listener of tabRemovedListeners) {
      listener(7, { isWindowClosing: false, windowId: 3 });
    }

    expect(screenshotContextManager.getContext(7)).toBeUndefined();
  });

  it('clears only the navigated tab on a top-frame commit', async () => {
    const { initScreenshotContextLifecycle, screenshotContextManager } =
      await import('@/utils/screenshot-context');
    initScreenshotContextLifecycle();
    const context = {
      screenshotWidth: 1000,
      screenshotHeight: 800,
      viewportWidth: 500,
      viewportHeight: 400,
    };
    screenshotContextManager.setContext(11, context);
    screenshotContextManager.setContext(12, context);

    for (const listener of navigationCommittedListeners) {
      listener({
        tabId: 11,
        frameId: 2,
      } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    }
    expect(screenshotContextManager.getContext(11)).toBeDefined();

    for (const listener of navigationCommittedListeners) {
      listener({
        tabId: 11,
        frameId: 0,
      } as chrome.webNavigation.WebNavigationTransitionCallbackDetails);
    }

    expect(screenshotContextManager.getContext(11)).toBeUndefined();
    expect(screenshotContextManager.getContext(12)).toBeDefined();
  });

  it('registers once and disposes listeners and contexts idempotently', async () => {
    const {
      disposeScreenshotContextLifecycle,
      initScreenshotContextLifecycle,
      screenshotContextManager,
    } = await import('@/utils/screenshot-context');

    const firstDispose = initScreenshotContextLifecycle();
    const secondDispose = initScreenshotContextLifecycle();
    screenshotContextManager.setContext(21, {
      screenshotWidth: 1000,
      screenshotHeight: 800,
      viewportWidth: 500,
      viewportHeight: 400,
    });

    expect(firstDispose).toBe(secondDispose);
    expect(chrome.tabs.onRemoved.addListener).toHaveBeenCalledOnce();
    expect(chrome.webNavigation.onCommitted.addListener).toHaveBeenCalledOnce();
    expect(tabRemovedListeners).toHaveLength(1);
    expect(navigationCommittedListeners).toHaveLength(1);

    firstDispose();
    disposeScreenshotContextLifecycle();

    expect(chrome.tabs.onRemoved.removeListener).toHaveBeenCalledOnce();
    expect(
      chrome.webNavigation.onCommitted.removeListener,
    ).toHaveBeenCalledOnce();
    expect(tabRemovedListeners).toHaveLength(0);
    expect(navigationCommittedListeners).toHaveLength(0);
    expect(screenshotContextManager.getContext(21)).toBeUndefined();
  });
});
