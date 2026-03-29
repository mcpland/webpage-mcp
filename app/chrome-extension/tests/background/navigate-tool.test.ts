import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  captureFrameOnAction: vi.fn(),
  isAutoCaptureActive: vi.fn(),
  tabsCreate: vi.fn(),
  tabsGet: vi.fn(),
  tabsGoBack: vi.fn(),
  tabsGoForward: vi.fn(),
  tabsQuery: vi.fn(),
  tabsReload: vi.fn(),
  tabsUpdate: vi.fn(),
  windowsCreate: vi.fn(),
  windowsGet: vi.fn(),
  windowsGetLastFocused: vi.fn(),
  windowsUpdate: vi.fn(),
}));

vi.mock('@/entrypoints/background/tools/browser/gif-recorder', () => ({
  captureFrameOnAction: mocks.captureFrameOnAction,
  isAutoCaptureActive: mocks.isAutoCaptureActive,
}));

import { navigateTool } from '@/entrypoints/background/tools/browser/common';

function makeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 1,
    index: 0,
    windowId: 10,
    title: 'Example',
    url: 'https://example.com/',
    status: 'complete',
    active: true,
    ...overrides,
  } as chrome.tabs.Tab;
}

function getTextPayload(result: Awaited<ReturnType<typeof navigateTool.execute>>): Record<string, unknown> {
  return JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));
}

describe('navigateTool', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());

    mocks.isAutoCaptureActive.mockReturnValue(false);
    mocks.tabsCreate.mockResolvedValue(makeTab({ id: 99, windowId: 20, url: 'https://example.com/' }));
    mocks.tabsGet.mockResolvedValue(makeTab());
    mocks.tabsGoBack.mockResolvedValue(undefined);
    mocks.tabsGoForward.mockResolvedValue(undefined);
    mocks.tabsQuery.mockResolvedValue([makeTab({ id: 1, windowId: 20 })]);
    mocks.tabsReload.mockResolvedValue(undefined);
    mocks.tabsUpdate.mockResolvedValue(makeTab());
    mocks.windowsCreate.mockResolvedValue({ id: 20, tabs: [makeTab({ id: 99, windowId: 20 })] });
    mocks.windowsGet.mockResolvedValue({ id: 20 });
    mocks.windowsGetLastFocused.mockResolvedValue({ id: 20 });
    mocks.windowsUpdate.mockResolvedValue({});

    vi.stubGlobal('chrome', {
      runtime: { lastError: null },
      tabs: {
        create: mocks.tabsCreate,
        get: mocks.tabsGet,
        goBack: mocks.tabsGoBack,
        goForward: mocks.tabsGoForward,
        query: mocks.tabsQuery,
        reload: mocks.tabsReload,
        update: mocks.tabsUpdate,
      },
      windows: {
        create: mocks.windowsCreate,
        get: mocks.windowsGet,
        getLastFocused: mocks.windowsGetLastFocused,
        update: mocks.windowsUpdate,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults URL navigation to reusing the current tab for backward compatibility', async () => {
    let currentUrl = 'https://github.com/unadlib';
    mocks.tabsGet.mockImplementation(async (tabId: number) =>
      makeTab({
        id: tabId,
        windowId: 20,
        url: currentUrl,
        status: 'complete',
        active: true,
      }),
    );
    mocks.tabsUpdate.mockImplementation(async (tabId: number, updateProperties: any) => {
      if (typeof updateProperties?.url === 'string') {
        currentUrl = updateProperties.url;
      }
      return makeTab({
        id: tabId,
        windowId: 20,
        url: currentUrl,
        status: 'loading',
        active: true,
      });
    });

    const result = await navigateTool.execute({
      url: 'https://www.baidu.com',
      background: false,
    });

    expect(mocks.tabsCreate).not.toHaveBeenCalled();
    expect(mocks.tabsUpdate).toHaveBeenCalledWith(1, { url: 'https://www.baidu.com' });

    const payload = getTextPayload(result);
    expect(payload.message).toBe('Navigated current tab');
    expect(payload.tabId).toBe(1);
    expect(payload.url).toBe('https://www.baidu.com');
  });

  it('navigates the explicit target tab and reports the updated URL', async () => {
    let currentUrl = 'https://github.com/unadlib';
    mocks.tabsGet.mockImplementation(async (tabId: number) =>
      makeTab({
        id: tabId,
        windowId: 31,
        url: currentUrl,
        status: 'complete',
        active: true,
      }),
    );
    mocks.tabsUpdate.mockImplementation(async (tabId: number, updateProperties: any) => {
      if (typeof updateProperties?.url === 'string') {
        currentUrl = updateProperties.url;
      }
      return makeTab({
        id: tabId,
        windowId: 31,
        url: currentUrl,
        status: 'loading',
        active: true,
      });
    });

    const result = await navigateTool.execute({
      url: 'https://www.baidu.com',
      tabId: 7,
      background: false,
    });

    expect(mocks.tabsUpdate).toHaveBeenCalledWith(7, { url: 'https://www.baidu.com' });

    const payload = getTextPayload(result);
    expect(payload.message).toBe('Navigated current tab');
    expect(payload.tabId).toBe(7);
    expect(payload.url).toBe('https://www.baidu.com');
  });

  it('forces a new tab when newTab=true even if an explicit tabId is present', async () => {
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      if (tabId === 7) {
        return makeTab({
          id: 7,
          windowId: 41,
          url: 'https://github.com/unadlib',
          status: 'complete',
          active: true,
        });
      }
      return makeTab({
        id: tabId,
        windowId: 41,
        url: 'https://www.baidu.com',
        status: 'complete',
        active: true,
      });
    });
    mocks.windowsGet.mockResolvedValueOnce({ id: 41 });
    mocks.tabsCreate.mockResolvedValueOnce(
      makeTab({
        id: 88,
        windowId: 41,
        url: 'https://www.baidu.com',
        status: 'loading',
        active: true,
      }),
    );

    const result = await navigateTool.execute({
      url: 'https://www.baidu.com',
      tabId: 7,
      newTab: true,
      background: false,
    });

    expect(mocks.tabsCreate).toHaveBeenCalledWith({
      url: 'https://www.baidu.com',
      windowId: 41,
      active: true,
    });
    expect(mocks.tabsUpdate).not.toHaveBeenCalledWith(7, { url: 'https://www.baidu.com' });

    const payload = getTextPayload(result);
    expect(payload.message).toBe('Opened URL in new tab');
    expect(payload.tabId).toBe(88);
  });

  it('rejects file URLs on the public navigate tool', async () => {
    const result = await navigateTool.execute({
      url: 'file:///tmp/secret.txt',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text)).toContain(
      'Only http:// and https:// URLs are allowed for chrome_navigate',
    );
    expect(mocks.tabsUpdate).not.toHaveBeenCalled();
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });
});
