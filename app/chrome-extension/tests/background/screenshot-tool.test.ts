import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCREENSHOT_LIMITS, TOOL_NAMES, TOOL_SCHEMAS } from 'webpage-mcp-shared';

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
      if (method === 'Runtime.evaluate') {
        return { result: { value: 1 } };
      }
      return undefined;
    });

    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1, height: 1, close: vi.fn() })),
    );
    vi.stubGlobal('OffscreenCanvas', vi.fn());

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

  it('publishes integer screenshot dimensions with the shared ceilings', () => {
    const schema = TOOL_SCHEMAS.find((tool) => tool.name === TOOL_NAMES.BROWSER.SCREENSHOT);
    const properties = schema?.inputSchema.properties as Record<string, any>;

    expect(properties.width).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: SCREENSHOT_LIMITS.MAX_USER_DIMENSION_CSS,
    });
    expect(properties.height).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: SCREENSHOT_LIMITS.MAX_USER_DIMENSION_CSS,
    });
    expect(properties.maxHeight).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: SCREENSHOT_LIMITS.MAX_FULL_PAGE_HEIGHT_CSS,
    });
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
      if (method === 'Runtime.evaluate') {
        return { result: { value: 1 } };
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

  it.each([
    ['width', 0],
    ['height', 1.5],
    ['width', SCREENSHOT_LIMITS.MAX_USER_DIMENSION_CSS + 1],
    ['maxHeight', SCREENSHOT_LIMITS.MAX_FULL_PAGE_HEIGHT_CSS + 1],
  ] as const)('rejects invalid user %s before resolving a tab', async (field, value) => {
    const { screenshotTool } = await loadScreenshotTool();
    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    const captureVisibleTab = chrome.tabs.captureVisibleTab as ReturnType<typeof vi.fn>;

    const result = await screenshotTool.execute({
      tabId: 7,
      [field]: value,
      storeBase64: false,
      savePng: false,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      `Screenshot ${field}`,
    );
    expect(tabsGet).not.toHaveBeenCalled();
    expect(captureVisibleTab).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'an excessive DPR',
      details: {
        totalWidth: 1280,
        totalHeight: 720,
        viewportWidth: 1280,
        viewportHeight: 720,
        devicePixelRatio: SCREENSHOT_LIMITS.MAX_DEVICE_PIXEL_RATIO + 0.01,
        currentScrollX: 0,
        currentScrollY: 0,
      },
      expected: 'device pixel ratio',
    },
    {
      name: 'a stitched canvas one row over its pixel budget',
      details: {
        totalWidth: 8000,
        totalHeight: 8001,
        viewportWidth: 8000,
        viewportHeight: 1000,
        devicePixelRatio: 1,
        currentScrollX: 0,
        currentScrollY: 0,
      },
      expected: 'pixel budget',
    },
    {
      name: 'more chunks than the capture budget',
      details: {
        totalWidth: 1000,
        totalHeight: 30000,
        viewportWidth: 1000,
        viewportHeight: 500,
        devicePixelRatio: 1,
        currentScrollX: 0,
        currentScrollY: 0,
      },
      expected: 'part limit',
    },
  ])('rejects $name before capture or canvas allocation', async ({ details, expected }) => {
    const { screenshotTool } = await loadScreenshotTool();
    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    const captureVisibleTab = chrome.tabs.captureVisibleTab as ReturnType<typeof vi.fn>;
    const canvasConstructor = OffscreenCanvas as unknown as ReturnType<typeof vi.fn>;
    tabsGet.mockResolvedValue(makeTab());
    vi.spyOn(screenshotTool as any, 'injectContentScript').mockResolvedValue(undefined);
    vi.spyOn(screenshotTool as any, 'sendMessageToTab').mockImplementation(
      async (...callArgs: unknown[]) => {
        const message = callArgs[1] as { action: string };
        if (message.action === 'preparePageForCapture') return { success: true };
        if (message.action === 'getPageDetails') return details;
        return { success: true };
      },
    );

    const result = await screenshotTool.execute({
      tabId: 7,
      fullPage: true,
      storeBase64: false,
      savePng: false,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(expected);
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(canvasConstructor).not.toHaveBeenCalled();
  });

  it('rejects a contextual physical edge overflow before capture', async () => {
    const { screenshotTool } = await loadScreenshotTool();
    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    const captureVisibleTab = chrome.tabs.captureVisibleTab as ReturnType<typeof vi.fn>;
    const canvasConstructor = OffscreenCanvas as unknown as ReturnType<typeof vi.fn>;
    tabsGet.mockResolvedValue(makeTab());
    vi.spyOn(screenshotTool as any, 'injectContentScript').mockResolvedValue(undefined);
    vi.spyOn(screenshotTool as any, 'sendMessageToTab').mockImplementation(
      async (...callArgs: unknown[]) => {
        const message = callArgs[1] as { action: string };
        if (message.action === 'preparePageForCapture') return { success: true };
        if (message.action === 'getPageDetails') {
          return {
            totalWidth: 1000,
            totalHeight: 1000,
            viewportWidth: 1000,
            viewportHeight: 1000,
            devicePixelRatio: SCREENSHOT_LIMITS.MAX_DEVICE_PIXEL_RATIO,
            currentScrollX: 0,
            currentScrollY: 0,
          };
        }
        return { success: true };
      },
    );

    const result = await screenshotTool.execute({
      tabId: 7,
      fullPage: true,
      width: SCREENSHOT_LIMITS.MAX_USER_DIMENSION_CSS,
      height: 100,
      storeBase64: false,
      savePng: false,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain('edge limit');
    expect(captureVisibleTab).not.toHaveBeenCalled();
    expect(canvasConstructor).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'the runtime hard ceiling',
      maxHeight: undefined,
      expectedHeight: SCREENSHOT_LIMITS.MAX_FULL_PAGE_HEIGHT_CSS,
    },
    { label: 'a smaller caller ceiling', maxHeight: 500, expectedHeight: 500 },
  ])('limits a tall page to $label', async ({ maxHeight, expectedHeight }) => {
    const { screenshotTool } = await loadScreenshotTool();
    const captureVisibleTab = chrome.tabs.captureVisibleTab as ReturnType<typeof vi.fn>;
    captureVisibleTab.mockResolvedValue('data:image/png;base64,AA==');
    const close = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({
        width: 1000,
        height: SCREENSHOT_LIMITS.MAX_FULL_PAGE_HEIGHT_CSS,
        close,
      })),
    );
    const canvasConstructor = vi.fn(function (this: any, width: number, height: number) {
      this.width = width;
      this.height = height;
      this.getContext = vi.fn(() => ({
        fillStyle: '',
        fillRect: vi.fn(),
        drawImage: vi.fn(),
      }));
      this.convertToBlob = vi.fn(async () => new Blob(['x'], { type: 'image/png' }));
    });
    vi.stubGlobal('OffscreenCanvas', canvasConstructor);

    const capture = await (screenshotTool as any)._captureFullPage(
      7,
      { fullPage: true, maxHeight },
      {
        totalWidth: 1000,
        totalHeight: SCREENSHOT_LIMITS.MAX_FULL_PAGE_HEIGHT_CSS + 10_000,
        viewportWidth: 1000,
        viewportHeight: SCREENSHOT_LIMITS.MAX_FULL_PAGE_HEIGHT_CSS,
        devicePixelRatio: 1,
        currentScrollX: 0,
        currentScrollY: 0,
      },
    );

    expect(capture.heightCss).toBe(expectedHeight);
    expect(canvasConstructor).toHaveBeenCalledWith(1000, expectedHeight);
    expect(captureVisibleTab).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(2);
  });
});
