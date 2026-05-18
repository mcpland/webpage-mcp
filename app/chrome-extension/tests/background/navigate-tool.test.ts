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

function getTextPayload(
  result: Awaited<ReturnType<typeof navigateTool.execute>>,
): Record<string, unknown> {
  return JSON.parse(
    String((result.content[0] as { text?: string })?.text || '{}'),
  );
}

describe('navigateTool', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());

    mocks.isAutoCaptureActive.mockReturnValue(false);
    mocks.tabsCreate.mockResolvedValue(
      makeTab({ id: 99, windowId: 20, url: 'https://example.com/' }),
    );
    mocks.tabsGet.mockResolvedValue(makeTab());
    mocks.tabsGoBack.mockResolvedValue(undefined);
    mocks.tabsGoForward.mockResolvedValue(undefined);
    mocks.tabsQuery.mockResolvedValue([makeTab({ id: 1, windowId: 20 })]);
    mocks.tabsReload.mockResolvedValue(undefined);
    mocks.tabsUpdate.mockResolvedValue(makeTab());
    mocks.windowsCreate.mockResolvedValue({
      id: 20,
      tabs: [makeTab({ id: 99, windowId: 20 })],
    });
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

  it('defaults URL navigation to opening a fresh new tab so existing tabs are not clobbered', async () => {
    const targetUrl = 'https://www.baidu.com';
    mocks.tabsCreate.mockResolvedValueOnce(
      makeTab({
        id: 88,
        windowId: 20,
        url: targetUrl,
        status: 'loading',
        active: true,
      }),
    );
    mocks.tabsGet.mockImplementation(async (tabId: number) =>
      makeTab({
        id: tabId,
        windowId: 20,
        url: targetUrl,
        status: 'complete',
        active: true,
      }),
    );

    const result = await navigateTool.execute({
      url: targetUrl,
      background: false,
    });

    expect(mocks.tabsUpdate).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ url: targetUrl }),
    );
    expect(mocks.tabsCreate).toHaveBeenCalledWith({
      url: targetUrl,
      windowId: 20,
      active: true,
    });

    const payload = getTextPayload(result);
    expect(payload.message).toBe('Opened URL in new tab');
    expect(payload.tabId).toBe(88);
    expect(payload.url).toBe(targetUrl);
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
    mocks.tabsUpdate.mockImplementation(
      async (tabId: number, updateProperties: any) => {
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
      },
    );

    const result = await navigateTool.execute({
      url: 'https://www.baidu.com',
      tabId: 7,
      openMode: 'current_tab',
      background: false,
    });

    expect(mocks.tabsUpdate).toHaveBeenCalledWith(7, {
      url: 'https://www.baidu.com',
    });

    const payload = getTextPayload(result);
    expect(payload.message).toBe('Navigated current tab');
    expect(payload.tabId).toBe(7);
    expect(payload.url).toBe('https://www.baidu.com');
  });

  it('waits for the committed URL instead of returning a pending navigation', async () => {
    const targetUrl = 'https://www.google.com';
    let getCount = 0;
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      getCount += 1;
      if (getCount <= 3) {
        return makeTab({
          id: tabId,
          windowId: 31,
          url: 'https://github.com/unadlib',
          status: 'loading',
          active: false,
          pendingUrl: 'https://www.google.com/',
        } as Partial<chrome.tabs.Tab>);
      }
      return makeTab({
        id: tabId,
        windowId: 31,
        url: 'https://www.google.com/',
        status: 'complete',
        active: false,
      });
    });

    const result = await navigateTool.execute({
      url: targetUrl,
      tabId: 7,
      openMode: 'current_tab',
      background: true,
    });

    expect(result.isError).toBe(false);
    expect(mocks.tabsUpdate).toHaveBeenCalledWith(7, { url: targetUrl });
    const payload = getTextPayload(result);
    expect(payload.message).toBe('Navigated current tab');
    expect(payload.tabId).toBe(7);
    expect(payload.url).toBe('https://www.google.com/');
  });

  it('returns promptly when navigation completes at a redirected URL', async () => {
    const targetUrl = 'http://example.com/login';
    const redirectedUrl = 'https://example.com/login';
    let getCount = 0;
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      getCount += 1;
      if (getCount <= 2) {
        return makeTab({
          id: tabId,
          windowId: 31,
          url: 'https://github.com/unadlib',
          status: 'complete',
          active: false,
        });
      }
      return makeTab({
        id: tabId,
        windowId: 31,
        url: redirectedUrl,
        status: 'complete',
        active: false,
      });
    });

    const result = await Promise.race([
      navigateTool.execute({
        url: targetUrl,
        tabId: 7,
        openMode: 'current_tab',
        background: true,
      }),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), 250);
      }),
    ]);

    expect(result).not.toBe('timeout');
    if (result === 'timeout') {
      return;
    }
    expect(result.isError).toBe(false);
    expect(mocks.tabsUpdate).toHaveBeenCalledWith(7, { url: targetUrl });
    const payload = getTextPayload(result);
    expect(payload.message).toBe('Navigated current tab');
    expect(payload.tabId).toBe(7);
    expect(payload.url).toBe(redirectedUrl);
  });

  it('does not auto-promote width/height to new_window when openMode=current_tab', async () => {
    let currentUrl = 'https://example.com/';
    mocks.tabsGet.mockImplementation(async (tabId: number) =>
      makeTab({
        id: tabId,
        windowId: 20,
        url: currentUrl,
        status: 'complete',
        active: true,
      }),
    );
    mocks.tabsUpdate.mockImplementation(
      async (tabId: number, updateProperties: any) => {
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
      },
    );

    const result = await navigateTool.execute({
      url: 'https://www.baidu.com',
      openMode: 'current_tab',
      width: 1280,
      height: 800,
      background: true,
    });

    expect(result.isError).toBe(false);
    expect(mocks.windowsCreate).not.toHaveBeenCalled();
    expect(mocks.tabsUpdate).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ url: 'https://www.baidu.com' }),
    );
    const payload = getTextPayload(result);
    expect(payload.message).toBe('Navigated current tab');
  });

  it('still opens a new window when openMode=new_window is explicit, sized per width/height', async () => {
    mocks.windowsCreate.mockResolvedValueOnce({
      id: 30,
      tabs: [makeTab({ id: 101, windowId: 30, url: 'https://www.baidu.com' })],
    });
    mocks.tabsGet.mockImplementation(async (tabId: number) =>
      makeTab({
        id: tabId,
        windowId: 30,
        url: 'https://www.baidu.com',
        status: 'complete',
        active: false,
      }),
    );

    const result = await navigateTool.execute({
      url: 'https://www.baidu.com',
      openMode: 'new_window',
      width: 1280,
      height: 800,
      background: true,
    });

    expect(result.isError).toBe(false);
    expect(mocks.windowsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://www.baidu.com',
        width: 1280,
        height: 800,
        focused: false,
      }),
    );
    const payload = getTextPayload(result);
    expect(payload.message).toBe('Opened URL in new window');
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
    expect(mocks.tabsUpdate).not.toHaveBeenCalledWith(7, {
      url: 'https://www.baidu.com',
    });

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
      'Only http://, https://, and chrome://newtab/ URLs are allowed for chrome_navigate',
    );
    expect(mocks.tabsUpdate).not.toHaveBeenCalled();
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
  });

  it('allows navigating the current tab to chrome://newtab/', async () => {
    let currentUrl = 'https://example.com/';
    mocks.tabsGet.mockImplementation(async (tabId: number) =>
      makeTab({
        id: tabId,
        windowId: 20,
        url: currentUrl,
        status: currentUrl === 'chrome://newtab/' ? 'complete' : 'loading',
        active: true,
      }),
    );
    mocks.tabsUpdate.mockImplementationOnce(
      async (tabId: number, updateProperties: any) => {
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
      },
    );

    const result = await navigateTool.execute({
      url: 'chrome://newtab/',
      tabId: 7,
      openMode: 'current_tab',
    });

    expect(result.isError).toBe(false);
    expect(mocks.tabsUpdate).toHaveBeenCalledWith(7, {
      url: 'chrome://newtab/',
    });
    const payload = getTextPayload(result);
    expect(payload.message).toBe('Navigated current tab');
    expect(payload.url).toBe('chrome://newtab/');
  });

  it('rejects refreshing a non-public target tab before reload', async () => {
    mocks.tabsQuery.mockResolvedValueOnce([
      makeTab({ id: 7, windowId: 20, url: 'file:///tmp/secret.txt' }),
    ]);

    const result = await navigateTool.execute({
      refresh: true,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text)).toContain(
      'Only http:// and https:// pages are supported by chrome_navigate refresh',
    );
    expect(mocks.tabsReload).not.toHaveBeenCalled();
  });

  it('allows navigating the current tab even when the current page is chrome://newtab', async () => {
    let currentUrl = 'chrome://newtab/';
    mocks.tabsGet.mockImplementation(async (tabId: number) =>
      makeTab({
        id: tabId,
        windowId: 20,
        url: currentUrl,
        status: currentUrl === 'chrome://newtab/' ? 'complete' : 'loading',
        active: true,
      }),
    );
    mocks.tabsUpdate.mockImplementationOnce(
      async (tabId: number, updateProperties: any) => {
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
      },
    );

    const result = await navigateTool.execute({
      url: 'https://www.baidu.com',
      tabId: 7,
      openMode: 'current_tab',
    });

    expect(result.isError).toBe(false);
    expect(mocks.tabsUpdate).toHaveBeenCalledWith(7, {
      url: 'https://www.baidu.com',
    });
    const payload = getTextPayload(result);
    expect(payload.message).toBe('Navigated current tab');
    expect(payload.url).toBe('https://www.baidu.com');
  });

  it('opens a new tab when default current tab is not an HTTP page', async () => {
    const targetUrl = 'https://www.google.com/';
    mocks.tabsQuery.mockResolvedValueOnce([
      makeTab({
        id: 7,
        windowId: 20,
        url: 'chrome-extension://extension-id/welcome.html',
      }),
    ]);
    mocks.tabsCreate.mockResolvedValueOnce(
      makeTab({
        id: 88,
        windowId: 20,
        url: targetUrl,
        status: 'loading',
        active: true,
      }),
    );
    mocks.tabsGet.mockImplementation(async (tabId: number) =>
      makeTab({
        id: tabId,
        windowId: 20,
        url: targetUrl,
        status: 'complete',
        active: true,
      }),
    );

    const result = await navigateTool.execute({
      url: targetUrl,
      openMode: 'current_tab',
      background: false,
    });

    expect(result.isError).toBe(false);
    expect(mocks.tabsUpdate).not.toHaveBeenCalledWith(7, { url: targetUrl });
    expect(mocks.tabsCreate).toHaveBeenCalledWith({
      url: targetUrl,
      windowId: 20,
      active: true,
    });

    const payload = getTextPayload(result);
    expect(payload.message).toBe(
      'Opened URL in new tab because target tab is not an HTTP(S) page',
    );
    expect(payload.tabId).toBe(88);
    expect(payload.url).toBe(targetUrl);
  });

  it('opens a background tab instead of mutating an explicit restricted tab', async () => {
    const targetUrl = 'https://www.google.com/';
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      if (tabId === 7) {
        return makeTab({
          id: 7,
          windowId: 20,
          url: 'chrome://extensions/',
          status: 'complete',
          active: true,
        });
      }
      return makeTab({
        id: tabId,
        windowId: 20,
        url: targetUrl,
        status: 'complete',
        active: false,
      });
    });
    mocks.windowsGet.mockResolvedValueOnce({ id: 20 });
    mocks.tabsCreate.mockResolvedValueOnce(
      makeTab({
        id: 88,
        windowId: 20,
        url: targetUrl,
        status: 'loading',
        active: false,
      }),
    );

    const result = await navigateTool.execute({
      url: targetUrl,
      tabId: 7,
      openMode: 'current_tab',
      background: true,
    });

    expect(result.isError).toBe(false);
    expect(mocks.tabsUpdate).not.toHaveBeenCalledWith(7, { url: targetUrl });
    expect(mocks.tabsCreate).toHaveBeenCalledWith({
      url: targetUrl,
      windowId: 20,
      active: false,
    });
    expect(mocks.windowsUpdate).not.toHaveBeenCalled();

    const payload = getTextPayload(result);
    expect(payload.message).toBe(
      'Opened URL in new tab because target tab is not an HTTP(S) page',
    );
    expect(payload.tabId).toBe(88);
    expect(payload.url).toBe(targetUrl);
  });

  it('opens a foreground tab and focuses the window when not in background mode for a restricted explicit tab', async () => {
    const targetUrl = 'https://www.google.com/';
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      if (tabId === 7) {
        return makeTab({
          id: 7,
          windowId: 20,
          url: 'chrome://extensions/',
          status: 'complete',
          active: true,
        });
      }
      return makeTab({
        id: tabId,
        windowId: 20,
        url: targetUrl,
        status: 'complete',
        active: true,
      });
    });
    mocks.windowsGet.mockResolvedValueOnce({ id: 20 });
    mocks.tabsCreate.mockResolvedValueOnce(
      makeTab({
        id: 88,
        windowId: 20,
        url: targetUrl,
        status: 'loading',
        active: true,
      }),
    );

    const result = await navigateTool.execute({
      url: targetUrl,
      tabId: 7,
      openMode: 'current_tab',
      background: false,
    });

    expect(result.isError).toBe(false);
    expect(mocks.tabsUpdate).not.toHaveBeenCalledWith(7, { url: targetUrl });
    expect(mocks.tabsCreate).toHaveBeenCalledWith({
      url: targetUrl,
      windowId: 20,
      active: true,
    });
    expect(mocks.windowsUpdate).toHaveBeenCalledWith(20, { focused: true });

    const payload = getTextPayload(result);
    expect(payload.message).toBe(
      'Opened URL in new tab because target tab is not an HTTP(S) page',
    );
    expect(payload.tabId).toBe(88);
    expect(payload.url).toBe(targetUrl);
  });

  it('treats a bare tabId without openMode as a new-tab request (decoupled)', async () => {
    const targetUrl = 'https://www.bing.com/';
    mocks.tabsGet.mockImplementation(async (tabId: number) =>
      makeTab({
        id: tabId,
        windowId: 20,
        url:
          tabId === 7
            ? 'https://github.com/unadlib'
            : targetUrl,
        status: 'complete',
        active: true,
      }),
    );
    mocks.windowsGet.mockResolvedValueOnce({ id: 20 });
    mocks.tabsCreate.mockResolvedValueOnce(
      makeTab({
        id: 89,
        windowId: 20,
        url: targetUrl,
        status: 'loading',
        active: true,
      }),
    );

    const result = await navigateTool.execute({
      url: targetUrl,
      tabId: 7,
      background: false,
    });

    expect(result.isError).toBe(false);
    // tabId no longer silently forces in-place navigation; tab 7 must be untouched.
    expect(mocks.tabsUpdate).not.toHaveBeenCalledWith(7, { url: targetUrl });
    expect(mocks.tabsCreate).toHaveBeenCalledWith({
      url: targetUrl,
      windowId: 20,
      active: true,
    });

    const payload = getTextPayload(result);
    expect(payload.message).toBe('Opened URL in new tab');
    expect(payload.tabId).toBe(89);
    expect(payload.url).toBe(targetUrl);
  });

  it('falls back to a new tab when current_tab targets a tab without a URL (loading/restricted)', async () => {
    const targetUrl = 'https://www.duckduckgo.com/';
    // Active tab has an empty url — classic restricted/transient state where
    // hasDisallowedPublicUrlScheme used to return false and we would have
    // clobbered it. After the fix the fallback is driven by `isHttpLike`.
    mocks.tabsQuery.mockResolvedValueOnce([
      makeTab({
        id: 7,
        windowId: 20,
        url: '',
        title: '',
        status: 'loading',
        active: true,
      } as Partial<chrome.tabs.Tab>),
    ]);
    mocks.windowsGet.mockResolvedValueOnce({ id: 20 });
    mocks.tabsCreate.mockResolvedValueOnce(
      makeTab({
        id: 90,
        windowId: 20,
        url: targetUrl,
        status: 'loading',
        active: true,
      }),
    );
    mocks.tabsGet.mockImplementation(async (tabId: number) =>
      makeTab({
        id: tabId,
        windowId: 20,
        url: targetUrl,
        status: 'complete',
        active: true,
      }),
    );

    const result = await navigateTool.execute({
      url: targetUrl,
      openMode: 'current_tab',
      background: false,
    });

    expect(result.isError).toBe(false);
    expect(mocks.tabsUpdate).not.toHaveBeenCalledWith(7, { url: targetUrl });
    expect(mocks.tabsCreate).toHaveBeenCalledWith({
      url: targetUrl,
      windowId: 20,
      active: true,
    });

    const payload = getTextPayload(result);
    expect(payload.message).toBe(
      'Opened URL in new tab because target tab is not an HTTP(S) page',
    );
    expect(payload.tabId).toBe(90);
    expect(payload.url).toBe(targetUrl);
  });

  it('fails history navigation if the updated tab lands on a non-public page', async () => {
    mocks.tabsQuery.mockResolvedValueOnce([
      makeTab({ id: 7, windowId: 20, url: 'https://example.com/' }),
    ]);
    mocks.tabsGet.mockResolvedValueOnce(
      makeTab({ id: 7, windowId: 20, url: 'file:///tmp/secret.txt' }),
    );

    const result = await navigateTool.execute({
      url: 'back',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text)).toContain(
      'Only http:// and https:// pages are supported by chrome_navigate browser history navigation',
    );
    expect(mocks.tabsGoBack).toHaveBeenCalledWith(7);
  });
});
