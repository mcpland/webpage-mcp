import { beforeEach, describe, expect, it, vi } from 'vitest';

type ListenerLifecycle = {
  captureData: Map<number, unknown>;
  setupListeners: () => void;
  cleanupCapture: (tabId: number) => void;
};

type TabRemovedListener = (tabId: number, removeInfo: chrome.tabs.TabRemoveInfo) => void;

describe('network capture webRequest listener lifecycle', () => {
  let tabRemovedListener: TabRemovedListener | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tabRemovedListener = undefined;
    vi.mocked(chrome.tabs.onRemoved.addListener).mockImplementation((listener) => {
      tabRemovedListener = listener;
    });

    const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
    chrome.webRequest = {
      onBeforeRequest: event(),
      onSendHeaders: event(),
      onHeadersReceived: event(),
      onCompleted: event(),
      onErrorOccurred: event(),
    } as unknown as typeof chrome.webRequest;
  });

  async function loadLifecycle(): Promise<ListenerLifecycle> {
    const { networkCaptureStartTool } = await import(
      '@/entrypoints/background/tools/browser/network-capture-web-request'
    );
    return networkCaptureStartTool as unknown as ListenerLifecycle;
  }

  function expectAllListenersRemoved(): void {
    expect(chrome.webRequest.onBeforeRequest.removeListener).toHaveBeenCalledOnce();
    expect(chrome.webRequest.onSendHeaders.removeListener).toHaveBeenCalledOnce();
    expect(chrome.webRequest.onHeadersReceived.removeListener).toHaveBeenCalledOnce();
    expect(chrome.webRequest.onCompleted.removeListener).toHaveBeenCalledOnce();
    expect(chrome.webRequest.onErrorOccurred.removeListener).toHaveBeenCalledOnce();
  }

  it('removes global listeners when the final capture is cleaned up', async () => {
    const lifecycle = await loadLifecycle();
    lifecycle.captureData.set(7, {});
    lifecycle.setupListeners();

    lifecycle.cleanupCapture(7);

    expectAllListenersRemoved();
  });

  it('keeps listeners until every concurrent capture has stopped', async () => {
    const lifecycle = await loadLifecycle();
    lifecycle.captureData.set(7, {});
    lifecycle.captureData.set(8, {});
    lifecycle.setupListeners();

    lifecycle.cleanupCapture(7);
    expect(chrome.webRequest.onBeforeRequest.removeListener).not.toHaveBeenCalled();

    lifecycle.cleanupCapture(8);
    expectAllListenersRemoved();
  });

  it('releases listeners when closing a tab removes the final capture', async () => {
    const lifecycle = await loadLifecycle();
    lifecycle.captureData.set(7, {});
    lifecycle.setupListeners();
    expect(tabRemovedListener).toBeTypeOf('function');

    tabRemovedListener!(7, { isWindowClosing: false, windowId: 2 });

    expectAllListenersRemoved();
  });
});
