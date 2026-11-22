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

import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { navigateTool } from '@/entrypoints/background/tools/browser/common';
import { readPageTool } from '@/entrypoints/background/tools/browser/read-page';

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

  it('keeps a queued current-tab navigation bound to its tab after it closes', async () => {
    mocks.tabsGet.mockRejectedValueOnce(new Error('No tab'));
    const result = await navigateTool.execute({ url: 'https://example.com/', tabId: 7, openMode: 'current_tab' });
    expect(result.isError).toBe(true);
    expect(mocks.tabsQuery).not.toHaveBeenCalled();
    expect(mocks.tabsUpdate).not.toHaveBeenCalled();
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
      // This mock never finishes loading; the commit path is what is under test.
      waitUntil: 'commit',
    });

    expect(result.isError).toBe(false);
    expect(mocks.tabsUpdate).toHaveBeenCalledWith(7, {
      url: 'https://www.baidu.com',
    });
    const payload = getTextPayload(result);
    expect(payload.message).toBe('Navigated current tab');
    expect(payload.url).toBe('https://www.baidu.com');
  });

  it('waits for the navigated page to finish loading by default', async () => {
    let currentUrl = 'https://github.com/unadlib';
    let loadingPolls = 0;
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      const navigated = currentUrl !== 'https://github.com/unadlib';
      if (navigated) loadingPolls += 1;
      return makeTab({
        id: tabId,
        windowId: 31,
        url: currentUrl,
        title: navigated && loadingPolls > 3 ? 'Loaded page' : 'Loading',
        status: navigated && loadingPolls <= 3 ? 'loading' : 'complete',
        active: true,
      });
    });
    mocks.tabsUpdate.mockImplementation(async (tabId: number, updateProperties: any) => {
      currentUrl = updateProperties.url;
      return makeTab({ id: tabId, windowId: 31, url: currentUrl, status: 'loading' });
    });

    const result = await navigateTool.execute({
      url: 'https://example.com/slow',
      tabId: 7,
      openMode: 'current_tab',
    });
    const payload = getTextPayload(result);

    expect(loadingPolls).toBeGreaterThan(3);
    expect(payload).toMatchObject({
      url: 'https://example.com/slow',
      status: 'complete',
      title: 'Loaded page',
    });
    expect(payload.warnings).toBeUndefined();
  });

  it('reports a page that is still loading when the load wait expires', async () => {
    vi.useFakeTimers();
    let currentUrl = 'https://github.com/unadlib';
    mocks.tabsGet.mockImplementation(async (tabId: number) =>
      makeTab({
        id: tabId,
        windowId: 31,
        url: currentUrl,
        status: currentUrl === 'https://github.com/unadlib' ? 'complete' : 'loading',
      }),
    );
    mocks.tabsUpdate.mockImplementation(async (tabId: number, updateProperties: any) => {
      currentUrl = updateProperties.url;
      return makeTab({ id: tabId, url: currentUrl, status: 'loading' });
    });

    const pending = navigateTool.execute({
      url: 'https://example.com/never',
      tabId: 7,
      openMode: 'current_tab',
    });
    await vi.advanceTimersByTimeAsync(21_000);
    const payload = getTextPayload(await pending);
    vi.useRealTimers();

    expect(payload.status).toBe('loading');
    expect((payload as { warnings?: string[] }).warnings?.[0]).toContain('still loading');
  });

  it('waits for a refresh to finish loading', async () => {
    let polls = 0;
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      polls += 1;
      return makeTab({
        id: tabId,
        windowId: 31,
        url: 'https://example.com/',
        // First read resolves the target; the reload then loads for two polls.
        status: polls === 1 || polls > 3 ? 'complete' : 'loading',
      });
    });

    const result = await navigateTool.execute({ refresh: true, tabId: 7 });
    const payload = getTextPayload(result);

    expect(mocks.tabsReload).toHaveBeenCalledWith(7);
    expect(polls).toBeGreaterThan(3);
    expect(payload).toMatchObject({ message: 'Successfully refreshed current tab', status: 'complete' });
  });

  it('appends a page snapshot when includeSnapshot is set', async () => {
    const readPage = vi.spyOn(readPageTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: '{"success":true,"pageContent":"- link [ref=ref_1]"}' }],
      isError: false,
    });
    mocks.tabsCreate.mockResolvedValueOnce(
      makeTab({ id: 88, windowId: 20, url: 'https://example.com/', status: 'complete' }),
    );
    mocks.tabsGet.mockResolvedValue(
      makeTab({ id: 88, windowId: 20, url: 'https://example.com/', status: 'complete' }),
    );

    const result = await navigateTool.execute({
      url: 'https://example.com/',
      includeSnapshot: true,
    });

    expect(readPage).toHaveBeenCalledWith({ tabId: 88, background: true, filter: 'interactive' });
    expect(result.content).toHaveLength(2);
    expect(String((result.content[1] as { text?: string }).text)).toContain('[ref=ref_1]');
    expect(getTextPayload(result).tabId).toBe(88);
  });

  it('keeps the navigation result when the snapshot fails', async () => {
    vi.spyOn(readPageTool, 'execute').mockResolvedValue({
      content: [{ type: 'text', text: 'Failed to generate accessibility tree' }],
      isError: true,
    });
    mocks.tabsCreate.mockResolvedValueOnce(
      makeTab({ id: 89, windowId: 20, url: 'https://example.com/', status: 'complete' }),
    );
    mocks.tabsGet.mockResolvedValue(
      makeTab({ id: 89, windowId: 20, url: 'https://example.com/', status: 'complete' }),
    );

    const result = await navigateTool.execute({
      url: 'https://example.com/',
      includeSnapshot: { scope: 'page' },
    });

    expect(result.isError).toBe(false);
    expect(String((result.content[1] as { text?: string }).text)).toContain('snapshotError');
  });

  it('rejects malformed includeSnapshot options', async () => {
    const result = await navigateTool.execute({
      url: 'https://example.com/',
      includeSnapshot: { scope: 'everything' } as any,
    });
    expect(result.isError).toBe(true);
    expect(mocks.tabsCreate).not.toHaveBeenCalled();
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

  it('includes loadState status and warnings for openMode=new_window', async () => {
    vi.useFakeTimers();
    mocks.windowsCreate.mockResolvedValueOnce({
      id: 30,
      tabs: [makeTab({ id: 101, windowId: 30, url: 'https://example.com/slow', status: 'loading' })],
    });
    mocks.tabsGet.mockResolvedValue(
      makeTab({ id: 101, windowId: 30, url: 'https://example.com/slow', status: 'loading' }),
    );

    const pending = navigateTool.execute({
      url: 'https://example.com/slow',
      openMode: 'new_window',
      background: true,
    });
    await vi.advanceTimersByTimeAsync(21_000);
    const payload = getTextPayload(await pending);
    vi.useRealTimers();

    expect(payload.status).toBe('loading');
    expect((payload as { warnings?: string[] }).warnings?.[0]).toContain('still loading');
  });

  it('waits for same-URL current_tab navigation to finish reloading', async () => {
    let polls = 0;
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      polls += 1;
      return makeTab({
        id: tabId,
        windowId: 31,
        url: 'https://example.com/same',
        // First read resolves target; next two polls show reload in progress.
        status: polls === 1 || polls > 3 ? 'complete' : 'loading',
      });
    });

    const result = await navigateTool.execute({
      url: 'https://example.com/same',
      tabId: 7,
      openMode: 'current_tab',
      background: true,
    });
    const payload = getTextPayload(result);

    expect(result.isError).toBe(false);
    expect(polls).toBeGreaterThan(3);
    expect(payload).toMatchObject({ url: 'https://example.com/same', status: 'complete' });
  });

  it('keeps waiting for a history destination after the one-second startup grace', async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      const origin = 'https://example.com/current';
      const destination = 'https://example.com/previous';
      mocks.tabsQuery.mockResolvedValue([makeTab({ url: origin })]);
      mocks.tabsGet.mockImplementation(async () => makeTab({
        url: Date.now() - start < 2000 ? origin : destination,
      }));
      const pending = navigateTool.execute({ url: 'back', waitUntil: 'commit' });
      await vi.advanceTimersByTimeAsync(2100);
      expect(getTextPayload(await pending).url).toBe(destination);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the full load budget when a history destination takes over eight seconds to commit', async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      const origin = 'https://example.com/current';
      const destination = 'https://example.com/slow';
      mocks.tabsQuery.mockResolvedValue([makeTab({ url: origin })]);
      mocks.tabsGet.mockImplementation(async () => {
        const elapsed = Date.now() - start;
        return makeTab({
          url: elapsed < 9600 ? origin : destination,
          status: elapsed < 10000 ? 'loading' : 'complete',
        });
      });
      const pending = navigateTool.execute({ url: 'back' });
      await vi.advanceTimersByTimeAsync(10100);
      expect(getTextPayload(await pending)).toMatchObject({ url: destination, status: 'complete' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an error when history never commits', async () => {
    vi.useFakeTimers();
    try {
      const pending = navigateTool.execute({ url: 'back', waitUntil: 'commit' });
      await vi.advanceTimersByTimeAsync(8500);
      expect((await pending).isError).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['tab lookup', 'window focus'])('does not activate a history target after cancellation during %s', async (stage) => {
    const controller = new AbortController();
    const tab = makeTab({ active: false });
    const cancel = async () => { controller.abort(); return tab; };
    if (stage === 'tab lookup') mocks.tabsGet.mockImplementationOnce(cancel);
    else mocks.windowsUpdate.mockImplementationOnce(cancel);
    const result = await navigateTool.execute({ url: 'back', tabId: tab.id }, { signal: controller.signal });
    expect(result.isError).toBe(true);
    expect(mocks.windowsUpdate).toHaveBeenCalledTimes(stage === 'tab lookup' ? 0 : 1);
    expect(mocks.tabsUpdate).not.toHaveBeenCalled();
    expect(mocks.tabsGoBack).not.toHaveBeenCalled();
  });

  it.each(['back', 'forward'] as const)('does not issue %s after cancellation during history preflight', async (url) => {
    Object.assign(chrome, { webNavigation: {
      getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0 }, { frameId: 9 }]),
    } });
    const controller = new AbortController();
    const history = vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async (_tab, _method, _params, signal) => {
      controller.abort();
      expect(signal?.aborted).toBe(true);
      return { currentIndex: 0, entries: [] };
    });
    try {
      const result = await navigateTool.execute({ url }, { signal: controller.signal });
      expect(history).toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(mocks.tabsGoBack).not.toHaveBeenCalled();
      expect(mocks.tabsGoForward).not.toHaveBeenCalled();
    } finally {
      history.mockRestore();
    }
  });

  it.each(['back', 'forward'] as const)('recognizes %s through a child frame only after the joint history entry changes', async (direction) => {
    vi.useFakeTimers();
    const event = { addListener: vi.fn(), removeListener: vi.fn() };
    const tab = makeTab();
    Object.assign(chrome, { webNavigation: {
      onHistoryStateUpdated: event,
      getAllFrames: vi.fn().mockResolvedValue([{ frameId: 0 }, { frameId: 9 }]),
    } });
    const startIndex = direction === 'back' ? 1 : 0;
    let currentIndex = startIndex;
    const history = vi.spyOn(cdpSessionManager, 'sendCommand').mockImplementation(async () => ({
      currentIndex, entries: [{ id: 16, url: tab.url }, { id: 24, url: tab.url }],
    }));
    const issueCommand = direction === 'back' ? mocks.tabsGoBack : mocks.tabsGoForward;
    const notify = () => event.addListener.mock.calls[0][0]({ tabId: tab.id, frameId: 9, url: 'https://frame.test/' });
    issueCommand.mockImplementation(async () => {
      notify(); // An unrelated iframe update must not end the wait.
      setTimeout(() => { currentIndex = 1 - startIndex; notify(); }, 300);
    });
    try {
      const pending = navigateTool.execute({ url: direction, waitUntil: 'commit' }).then((result) => {
        expect(currentIndex).not.toBe(startIndex);
        return result;
      });
      await vi.advanceTimersByTimeAsync(8500);
      expect((await pending).isError).toBe(false);
      expect(history).toHaveBeenCalledWith(tab.id, 'Page.getNavigationHistory', undefined, expect.any(AbortSignal));
      expect(event.removeListener).toHaveBeenCalledWith(event.addListener.mock.calls[0][0]);
    } finally {
      history.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['back', 'forward'] as const)('checks frame-local history for %s when another debugger owns the tab', async (direction) => {
    vi.useFakeTimers();
    const history = vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(new Error('Debugger already attached'));
    const event = { addListener: vi.fn(), removeListener: vi.fn() };
    let key = 'unrelated-push';
    const executeScript = vi.fn(async ({ args }) => [
      { frameId: 4, result: [args[0] === direction ? 'existing-entry' : key] },
      { frameId: 9, result: [args[0] === direction ? 'other-frame-entry' : 'existing-entry'] },
    ]);
    Object.assign(chrome, {
      scripting: { executeScript },
      webNavigation: { onHistoryStateUpdated: event, getAllFrames: async () => [{ frameId: 4 }, { frameId: 9 }] },
    });
    const notify = () => event.addListener.mock.calls[0][0]({ tabId: makeTab().id, frameId: 4, transitionQualifiers: [] });
    const traverse = direction === 'back' ? mocks.tabsGoBack : mocks.tabsGoForward;
    traverse.mockImplementation(async () => {
      notify();
      setTimeout(() => { key = 'existing-entry'; notify(); }, 300);
    });
    try {
      const pending = navigateTool.execute({ url: direction, waitUntil: 'commit' }).then((result) => {
        expect(key).toBe('existing-entry');
        return result;
      });
      await vi.advanceTimersByTimeAsync(500);
      expect((await pending).isError).toBe(false);
      expect(executeScript).toHaveBeenCalledTimes(3);
    } finally {
      history.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['back', 'forward'] as const)('continues top-level %s when a paused frame never answers', async (direction) => {
    const history = vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(new Error('Debugger in use'));
    const executeScript = vi.fn(() => new Promise(() => {}));
    Object.assign(chrome, {
      scripting: { executeScript },
      webNavigation: { getAllFrames: async () => [{ frameId: 9 }] },
    });
    const target = makeTab({ url: 'https://example.com/destination' });
    const traverse = direction === 'back' ? mocks.tabsGoBack : mocks.tabsGoForward;
    traverse.mockImplementation(async () => { mocks.tabsGet.mockResolvedValue(target); });
    try {
      const result = await navigateTool.execute({ url: direction });
      expect(executeScript).toHaveBeenCalled();
      expect(getTextPayload(result).url).toBe(target.url);
      expect(traverse).toHaveBeenCalledOnce();
    } finally {
      history.mockRestore();
    }
  });

  it('cancels a stalled frame-history read without traversing after the late reply', async () => {
    const controller = new AbortController();
    const history = vi.spyOn(cdpSessionManager, 'sendCommand').mockRejectedValue(new Error('Debugger in use'));
    let finishRead!: () => void;
    const executeScript = vi.fn(() => new Promise<void>((resolve) => { finishRead = resolve; }));
    Object.assign(chrome, {
      scripting: { executeScript },
      webNavigation: { getAllFrames: async () => [{ frameId: 4 }] },
    });
    try {
      const pending = navigateTool.execute({ url: 'back' }, { signal: controller.signal });
      await vi.waitFor(() => expect(executeScript).toHaveBeenCalledOnce());
      controller.abort();
      expect((await pending).isError).toBe(true);
      finishRead();
      await Promise.resolve();
      expect(mocks.tabsGoBack).not.toHaveBeenCalled();
    } finally {
      history.mockRestore();
    }
  });

  it('recognizes a same-URL history entry and removes the commit listener', async () => {
    const event = { addListener: vi.fn(), removeListener: vi.fn() };
    Object.assign(chrome, { webNavigation: { onHistoryStateUpdated: event } });
    const tab = makeTab();
    mocks.tabsQuery.mockResolvedValue([tab]);
    mocks.tabsGoBack.mockImplementation(async () => {
      event.addListener.mock.calls[0][0]({ tabId: tab.id, frameId: 0, url: tab.url });
    });
    const result = await navigateTool.execute({ url: 'back', waitUntil: 'commit' });
    expect(getTextPayload(result).url).toBe(tab.url);
    expect(event.removeListener).toHaveBeenCalledWith(event.addListener.mock.calls[0][0]);
  });

  it('waits for history goBack URL change even when waitUntil is commit', async () => {
    let polls = 0;
    mocks.tabsQuery.mockResolvedValueOnce([
      makeTab({ id: 7, windowId: 20, url: 'https://example.com/page-2' }),
    ]);
    mocks.tabsGet.mockImplementation(async (tabId: number) => {
      polls += 1;
      return makeTab({
        id: tabId,
        windowId: 20,
        url: polls <= 2 ? 'https://example.com/page-2' : 'https://example.com/page-1',
        status: polls <= 2 ? 'loading' : 'complete',
      });
    });

    const result = await navigateTool.execute({
      url: 'back',
      waitUntil: 'commit',
    });
    const payload = getTextPayload(result);

    expect(result.isError).toBe(false);
    expect(payload.url).toBe('https://example.com/page-1');
  });
});
