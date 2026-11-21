import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  webRequestStartExecute: vi.fn(),
  webRequestStopExecute: vi.fn(),
  debuggerStartExecute: vi.fn(),
  debuggerStopExecute: vi.fn(),
  webRequestCaptureData: new Map<number, unknown>(),
  // Captures that stopped on their own and wait to be collected by a stop call.
  webRequestCompleted: new Set<number>(),
  debuggerCaptureData: new Map<number, unknown>(),
}));

vi.mock('@/entrypoints/background/tools/browser/network-capture-web-request', () => ({
  networkCaptureStartTool: {
    execute: mocks.webRequestStartExecute,
    captureData: mocks.webRequestCaptureData,
    hasAvailableCapture: () =>
      mocks.webRequestCaptureData.size > 0 || mocks.webRequestCompleted.size > 0,
  },
  networkCaptureStopTool: {
    execute: mocks.webRequestStopExecute,
  },
}));

vi.mock('@/entrypoints/background/tools/browser/network-capture-debugger', () => ({
  networkDebuggerStartTool: {
    execute: mocks.debuggerStartExecute,
    captureData: mocks.debuggerCaptureData,
  },
  networkDebuggerStopTool: {
    execute: mocks.debuggerStopExecute,
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

async function loadNetworkCaptureTool() {
  return await import('@/entrypoints/background/tools/browser/network-capture');
}

describe('networkCaptureTool', () => {
  beforeEach(() => {
    mocks.webRequestStartExecute.mockReset();
    mocks.webRequestStopExecute.mockReset();
    mocks.debuggerStartExecute.mockReset();
    mocks.debuggerStopExecute.mockReset();
    mocks.webRequestCaptureData.clear();
    mocks.webRequestCompleted.clear();
    mocks.debuggerCaptureData.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('rejects file URLs before starting capture', async () => {
    const { networkCaptureTool } = await loadNetworkCaptureTool();

    const result = await networkCaptureTool.execute({
      action: 'start',
      url: 'file:///tmp/secret.txt',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_network_capture',
    );
    expect(mocks.webRequestStartExecute).not.toHaveBeenCalled();
    expect(mocks.debuggerStartExecute).not.toHaveBeenCalled();
  });

  it('rejects existing file URL tabs before starting capture', async () => {
    const { networkCaptureTool } = await loadNetworkCaptureTool();
    const tryGetTab = vi
      .spyOn(networkCaptureTool as any, 'tryGetTab')
      .mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const getActiveTabInWindow = vi
      .spyOn(networkCaptureTool as any, 'getActiveTabInWindow')
      .mockResolvedValue(makeTab());

    const result = await networkCaptureTool.execute({
      action: 'start',
      tabId: 7,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_network_capture',
    );
    expect(tryGetTab).toHaveBeenCalledWith(7);
    expect(getActiveTabInWindow).not.toHaveBeenCalled();
    expect(mocks.webRequestStartExecute).not.toHaveBeenCalled();
  });

  it('starts on a url even when the current tab is not an http page', async () => {
    const { networkCaptureTool } = await loadNetworkCaptureTool();
    vi.spyOn(networkCaptureTool as any, 'getActiveTabInWindow').mockResolvedValue(
      makeTab({ url: 'chrome://newtab/' }),
    );
    vi.spyOn(networkCaptureTool as any, 'tryGetTab').mockResolvedValue(
      makeTab({ url: 'chrome://newtab/' }),
    );
    mocks.webRequestStartExecute.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ success: true, tabId: 7 }) }],
      isError: false,
    });

    const withoutTab = await networkCaptureTool.execute({
      action: 'start',
      url: 'https://example.com/',
    });
    const withTab = await networkCaptureTool.execute({
      action: 'start',
      tabId: 7,
      url: 'https://example.com/',
    });

    expect(withoutTab.isError).toBe(false);
    expect(withTab.isError).toBe(false);
    expect(mocks.webRequestStartExecute).toHaveBeenCalledTimes(2);
  });

  it('redacts stop results for non-public page captures', async () => {
    const { networkCaptureTool } = await loadNetworkCaptureTool();
    mocks.webRequestCaptureData.set(7, {});
    mocks.webRequestStopExecute.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'Capture complete.',
            tabId: 7,
            tabUrl: 'file:///tmp/secret.txt',
            tabTitle: 'Secret',
            requestCount: 2,
            requests: [{ url: 'file:///tmp/secret.txt' }],
            commonRequestHeaders: { cookie: 'secret' },
            commonResponseHeaders: { server: 'file' },
          }),
        },
      ],
      isError: false,
    });

    const result = await networkCaptureTool.execute({ action: 'stop' });
    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));

    expect(result.isError).toBe(false);
    expect(payload.backend).toBe('webRequest');
    expect(payload.redacted).toBe(true);
    expect(payload.tabUrl).toBeNull();
    expect(payload.tabTitle).toBeNull();
    expect(payload.requests).toEqual([]);
    expect(payload.commonRequestHeaders).toEqual({});
    expect(payload.commonResponseHeaders).toEqual({});
  });

  function jsonResult(payload: Record<string, unknown>) {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false };
  }

  async function prepareOneShot() {
    const { networkCaptureTool } = await loadNetworkCaptureTool();
    vi.spyOn(networkCaptureTool as any, 'tryGetTab').mockResolvedValue(makeTab());
    mocks.webRequestStartExecute.mockImplementation(async () => {
      mocks.webRequestCaptureData.set(7, {});
      return jsonResult({ success: true, tabId: 7 });
    });
    mocks.webRequestStopExecute.mockImplementation(async () => {
      mocks.webRequestCaptureData.delete(7);
      mocks.webRequestCompleted.delete(7);
      return jsonResult({
        success: true,
        tabId: 7,
        tabUrl: 'https://example.com/',
        requestCount: 1,
        requests: [{ url: 'https://example.com/api' }],
      });
    });
    return networkCaptureTool;
  }

  it('starts, waits for durationMs, and stops in one call', async () => {
    vi.useFakeTimers();
    try {
      const networkCaptureTool = await prepareOneShot();

      const pending = networkCaptureTool.execute({ action: 'start', tabId: 7, durationMs: 3000 });
      await vi.advanceTimersByTimeAsync(2900);
      expect(mocks.webRequestStopExecute).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      const result = await pending;
      const payload = JSON.parse(String((result.content[0] as { text?: string }).text));

      expect(result.isError).toBe(false);
      expect(payload).toMatchObject({ oneShot: true, durationMs: 3000, requestCount: 1 });
      expect(payload.requests).toEqual([{ url: 'https://example.com/api' }]);
      // The capture's own limit outlasts durationMs so the explicit stop ends it.
      expect(mocks.webRequestStartExecute).toHaveBeenCalledWith(
        expect.objectContaining({ maxCaptureTime: 8000 }),
      );
      expect(mocks.webRequestStopExecute).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: 7 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns early when the capture ends on its own', async () => {
    vi.useFakeTimers();
    try {
      const networkCaptureTool = await prepareOneShot();

      const pending = networkCaptureTool.execute({ action: 'start', tabId: 7, durationMs: 60_000 });
      await vi.advanceTimersByTimeAsync(1000);
      // inactivityTimeout fired: recording ends, the result is kept for the stop call.
      mocks.webRequestCaptureData.delete(7);
      mocks.webRequestCompleted.add(7);
      await vi.advanceTimersByTimeAsync(400);
      const result = await pending;
      const payload = JSON.parse(String((result.content[0] as { text?: string }).text));

      expect(payload).toMatchObject({ oneShot: true, requestCount: 1 });
      expect(payload.waitedMs).toBeLessThan(2000);
      expect(mocks.webRequestCompleted.has(7)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still stops the capture when the call is aborted mid-wait', async () => {
    const networkCaptureTool = await prepareOneShot();
    const controller = new AbortController();

    const pending = networkCaptureTool.execute(
      { action: 'start', tabId: 7, durationMs: 60_000 },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(mocks.webRequestCaptureData.has(7)).toBe(true));
    controller.abort();
    await pending;

    expect(mocks.webRequestStopExecute).toHaveBeenCalledOnce();
    expect(mocks.webRequestCaptureData.has(7)).toBe(false);
  });

  it('validates durationMs and keeps it to action="start"', async () => {
    const networkCaptureTool = await prepareOneShot();

    const tooLong = await networkCaptureTool.execute({
      action: 'start',
      tabId: 7,
      durationMs: 3_600_000,
    });
    const onStop = await networkCaptureTool.execute({ action: 'stop', durationMs: 1000 });

    expect(tooLong.isError).toBe(true);
    expect(onStop.isError).toBe(true);
    expect(mocks.webRequestStartExecute).not.toHaveBeenCalled();
  });

  it('normalizes non-positive lifecycle values before delegating capture', async () => {
    const { networkCaptureTool } = await loadNetworkCaptureTool();
    mocks.webRequestStartExecute.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
      isError: false,
    });

    await networkCaptureTool.execute({
      action: 'start',
      maxCaptureTime: 0,
      inactivityTimeout: -1,
    });

    expect(mocks.webRequestStartExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        maxCaptureTime: 3 * 60 * 1_000,
        inactivityTimeout: 60 * 1_000,
      }),
    );
  });
});
