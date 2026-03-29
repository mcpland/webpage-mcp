import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 7,
    index: 0,
    windowId: 2,
    title: 'Example',
    url: 'https://example.com/',
    status: 'complete',
    active: true,
    ...overrides,
  } as chrome.tabs.Tab;
}

async function loadScreenshotTool() {
  return await import('@/entrypoints/background/tools/browser/screenshot');
}

describe('screenshotTool', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      tabs: {
        MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND: 2,
        captureVisibleTab: vi.fn(),
        get: vi.fn(),
        query: vi.fn(),
      },
      downloads: {
        download: vi.fn(),
        search: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('rejects file URL tabs before capturing screenshots', async () => {
    const { screenshotTool } = await loadScreenshotTool();
    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    const captureVisibleTab = chrome.tabs.captureVisibleTab as ReturnType<typeof vi.fn>;
    tabsGet.mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const injectContentScript = vi
      .spyOn(screenshotTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);

    const result = await screenshotTool.execute({
      tabId: 7,
      storeBase64: true,
      savePng: false,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_screenshot',
    );
    expect(tabsGet).toHaveBeenCalledWith(7);
    expect(injectContentScript).not.toHaveBeenCalled();
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });
});
