import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('OffscreenManager', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('clients', undefined);

    delete (chrome.runtime as unknown as Record<string, unknown>).getContexts;
    chrome.runtime.getURL = vi.fn((path: string) => `chrome-extension://test-extension-id/${path}`);
    chrome.offscreen = {
      createDocument: vi.fn().mockResolvedValue(undefined),
      closeDocument: vi.fn().mockResolvedValue(undefined),
      hasDocument: vi.fn().mockResolvedValue(false),
      Reason: chrome.offscreen?.Reason,
    } as typeof chrome.offscreen;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses runtime.getContexts when the modern API is available', async () => {
    const getContexts = vi.fn().mockResolvedValue([{ contextType: 'OFFSCREEN_DOCUMENT' }]);
    (
      chrome.runtime as typeof chrome.runtime & {
        getContexts: typeof getContexts;
      }
    ).getContexts = getContexts;

    const { OffscreenManager } = await import('@/utils/offscreen-manager');
    await OffscreenManager.getInstance().ensureOffscreenDocument();

    expect(getContexts).toHaveBeenCalledWith({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('uses service worker clients on Chrome 109 through 115', async () => {
    const matchAll = vi.fn().mockResolvedValue([
      { url: 'chrome-extension://test-extension-id/offscreen.html' },
    ]);
    vi.stubGlobal('clients', { matchAll });

    const { OffscreenManager } = await import('@/utils/offscreen-manager');
    await OffscreenManager.getInstance().ensureOffscreenDocument();

    expect(matchAll).toHaveBeenCalledOnce();
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('creates the document through the Chrome 109 fallback when none exists', async () => {
    vi.stubGlobal('clients', { matchAll: vi.fn().mockResolvedValue([]) });

    const { OffscreenManager } = await import('@/utils/offscreen-manager');
    await OffscreenManager.getInstance().ensureOffscreenDocument();

    expect(chrome.offscreen.createDocument).toHaveBeenCalledWith({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Need to run semantic similarity engine with workers',
    });
  });
});
