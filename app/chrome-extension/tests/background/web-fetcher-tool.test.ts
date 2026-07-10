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

  it('rejects an oversized UTF-8 selector before resolving a tab', async () => {
    const { webFetcherTool } = await loadWebFetcherTool();
    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    const injectContentScript = vi
      .spyOn(webFetcherTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);

    const result = await webFetcherTool.execute({
      tabId: 7,
      selector: '😀'.repeat(1025),
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      '4096-byte UTF-8 limit',
    );
    expect(tabsGet).not.toHaveBeenCalled();
    expect(injectContentScript).not.toHaveBeenCalled();
  });

  it('rejects an oversized URL before trimming or resolving a tab', async () => {
    const { WEB_FETCHER_LIMITS, webFetcherTool } = await loadWebFetcherTool();
    const tabsQuery = chrome.tabs.query as ReturnType<typeof vi.fn>;
    const tabsCreate = chrome.tabs.create as ReturnType<typeof vi.fn>;

    const result = await webFetcherTool.execute({
      url: `https://example.com/${'a'.repeat(WEB_FETCHER_LIMITS.urlBytes)}`,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      `${WEB_FETCHER_LIMITS.urlBytes}-byte UTF-8 limit`,
    );
    expect(tabsQuery).not.toHaveBeenCalled();
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it('rejects :has selectors before resolving a tab', async () => {
    const { webFetcherTool } = await loadWebFetcherTool();
    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;

    const result = await webFetcherTool.execute({
      tabId: 7,
      selector: 'body:has(.target)',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(':has()');
    expect(tabsGet).not.toHaveBeenCalled();
  });

  it('bounds an untrusted HTML response and its JSON encoding', async () => {
    const { WEB_FETCHER_LIMITS, webFetcherTool } = await loadWebFetcherTool();
    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    tabsGet.mockResolvedValue(makeTab());
    vi.spyOn(webFetcherTool as any, 'injectContentScript').mockResolvedValue(undefined);
    vi.spyOn(webFetcherTool as any, 'sendMessageToTab').mockResolvedValue({
      success: true,
      htmlContent: '\u0000'.repeat(WEB_FETCHER_LIMITS.htmlBytes),
    });

    const result = await webFetcherTool.execute({
      tabId: 7,
      htmlContent: true,
      background: true,
    });
    const serialized = String((result.content[0] as { text?: string })?.text || '');
    const parsed = JSON.parse(serialized);

    expect(result.isError).toBe(false);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
      WEB_FETCHER_LIMITS.resultJsonBytes,
    );
    expect(parsed).toMatchObject({ success: true, truncated: true });
    expect(parsed).not.toHaveProperty('htmlContent');
    expect(parsed.htmlContentError).toContain('bounded JSON result size');
  });

  it('copies only bounded article and metadata fields from an untrusted response', async () => {
    const { WEB_FETCHER_LIMITS, webFetcherTool } = await loadWebFetcherTool();
    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    tabsGet.mockResolvedValue(makeTab());
    vi.spyOn(webFetcherTool as any, 'injectContentScript').mockResolvedValue(undefined);
    vi.spyOn(webFetcherTool as any, 'sendMessageToTab').mockResolvedValue({
      success: true,
      textContent: 'ok',
      article: {
        title: 'a'.repeat(WEB_FETCHER_LIMITS.articleFieldBytes + 1),
        content: 'must not cross the background boundary',
        attackerControlled: 'must not cross the background boundary',
      },
      metadata: {
        description: 'm'.repeat(WEB_FETCHER_LIMITS.metadataFieldBytes + 1),
        attackerControlled: 'must not cross the background boundary',
      },
    });

    const result = await webFetcherTool.execute({ tabId: 7, background: true });
    const parsed = JSON.parse(String((result.content[0] as { text?: string })?.text || ''));

    expect(parsed).toMatchObject({ success: true, truncated: true, textContent: 'ok' });
    expect(parsed.article.title).toHaveLength(WEB_FETCHER_LIMITS.articleFieldBytes);
    expect(parsed.metadata.description).toHaveLength(WEB_FETCHER_LIMITS.metadataFieldBytes);
    expect(parsed.article).not.toHaveProperty('content');
    expect(parsed.article).not.toHaveProperty('attackerControlled');
    expect(parsed.metadata).not.toHaveProperty('attackerControlled');
  });
});
