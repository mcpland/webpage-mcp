import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cdpMocks = vi.hoisted(() => ({
  withSession: vi.fn(),
  sendCommand: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    withSession: cdpMocks.withSession,
    sendCommand: cdpMocks.sendCommand,
  },
}));

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
    cdpMocks.withSession.mockReset();
    cdpMocks.sendCommand.mockReset();
    cdpMocks.withSession.mockImplementation(async (_tabId, _owner, fn) => await fn());
    cdpMocks.sendCommand.mockImplementation(async (_tabId, method) => {
      if (method === 'Page.getLayoutMetrics') {
        return {
          layoutViewport: {
            clientWidth: 1280,
            clientHeight: 720,
          },
        };
      }
      if (method === 'Page.captureScreenshot') {
        return {
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+tmS0AAAAASUVORK5CYII=',
        };
      }
      return undefined;
    });

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

  it('redacts local download paths when saving a screenshot file', async () => {
    const { screenshotTool } = await loadScreenshotTool();
    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    const downloadsDownload = chrome.downloads.download as ReturnType<typeof vi.fn>;
    tabsGet.mockResolvedValue(makeTab());
    downloadsDownload.mockResolvedValue(42);

    const result = await screenshotTool.execute({
      tabId: 7,
      background: true,
      name: 'secret-shot',
      savePng: true,
      storeBase64: false,
    });

    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));
    expect(result.isError).toBe(false);
    expect(payload.downloadId).toBe(42);
    expect(payload.filename).toMatch(/^secret-shot_.*\.png$/);
    expect(payload.pathRedacted).toBe(true);
    expect('fullPath' in payload).toBe(false);
  });

  it('rejects background full-page captures before using visible-tab capture', async () => {
    const { screenshotTool } = await loadScreenshotTool();
    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    const captureVisibleTab = chrome.tabs.captureVisibleTab as ReturnType<typeof vi.fn>;
    tabsGet.mockResolvedValue(makeTab());
    const injectContentScript = vi
      .spyOn(screenshotTool as any, 'injectContentScript')
      .mockResolvedValue(undefined);

    const result = await screenshotTool.execute({
      tabId: 7,
      background: true,
      fullPage: true,
      storeBase64: true,
      savePng: false,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Background screenshots support only viewport capture',
    );
    expect(cdpMocks.withSession).not.toHaveBeenCalled();
    expect(injectContentScript).not.toHaveBeenCalled();
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it('does not fall back to visible-tab capture when background CDP capture fails', async () => {
    const { screenshotTool } = await loadScreenshotTool();
    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    const captureVisibleTab = chrome.tabs.captureVisibleTab as ReturnType<typeof vi.fn>;
    tabsGet.mockResolvedValue(makeTab());
    cdpMocks.sendCommand.mockImplementation(async (_tabId, method) => {
      if (method === 'Page.getLayoutMetrics') {
        return { layoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      }
      if (method === 'Page.captureScreenshot') {
        throw new Error('debugger unavailable');
      }
      return undefined;
    });

    const result = await screenshotTool.execute({
      tabId: 7,
      background: true,
      storeBase64: true,
      savePng: false,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Background screenshot failed via CDP: debugger unavailable',
    );
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });
});
