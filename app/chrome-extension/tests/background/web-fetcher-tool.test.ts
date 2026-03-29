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

async function loadWebFetcherTool() {
  return await import('@/entrypoints/background/tools/browser/web-fetcher');
}

describe('webFetcherTool', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      tabs: {
        create: vi.fn(),
        get: vi.fn(),
        query: vi.fn(),
        update: vi.fn(),
      },
      windows: {
        update: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('rejects file URLs before creating or querying tabs', async () => {
    const { webFetcherTool } = await loadWebFetcherTool();
    const tabsQuery = chrome.tabs.query as ReturnType<typeof vi.fn>;
    const tabsCreate = chrome.tabs.create as ReturnType<typeof vi.fn>;
    const injectContentScript = vi
      .spyOn(webFetcherTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);

    const result = await webFetcherTool.execute({
      url: 'file:///tmp/secret.txt',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_get_web_content',
    );
    expect(tabsQuery).not.toHaveBeenCalled();
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(injectContentScript).not.toHaveBeenCalled();
  });

  it('rejects existing file URL tabs before injecting content scripts', async () => {
    const { webFetcherTool } = await loadWebFetcherTool();
    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    tabsGet.mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const injectContentScript = vi
      .spyOn(webFetcherTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);
    const sendMessageToTab = vi
      .spyOn(webFetcherTool as any, 'sendMessageToTab')
      .mockResolvedValue({ success: true, textContent: 'secret' });

    const result = await webFetcherTool.execute({ tabId: 7 });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_get_web_content',
    );
    expect(tabsGet).toHaveBeenCalledWith(7);
    expect(injectContentScript).not.toHaveBeenCalled();
    expect(sendMessageToTab).not.toHaveBeenCalled();
  });
});
