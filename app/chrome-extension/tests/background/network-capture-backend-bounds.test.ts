import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NETWORK_CAPTURE_LIMITS, utf8ByteLength } from '@/entrypoints/background/tools/browser/network-capture-limits';

const cdp = vi.hoisted(() => ({
  attach: vi.fn().mockResolvedValue(undefined),
  detach: vi.fn().mockResolvedValue(undefined),
  sendCommand: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: cdp,
}));

function tab(id = 7): chrome.tabs.Tab {
  return {
    id,
    index: 0,
    windowId: 1,
    active: true,
    url: 'https://example.com/',
    title: 'Example',
  } as chrome.tabs.Tab;
}

function installWebRequestEvents(): void {
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  chrome.webRequest = {
    onBeforeRequest: event(),
    onSendHeaders: event(),
    onHeadersReceived: event(),
    onCompleted: event(),
    onErrorOccurred: event(),
  } as unknown as typeof chrome.webRequest;
}

describe('network capture backend boundaries', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    installWebRequestEvents();
    vi.mocked(chrome.tabs.get).mockResolvedValue(tab());
    cdp.attach.mockResolvedValue(undefined);
    cdp.detach.mockResolvedValue(undefined);
    cdp.sendCommand.mockResolvedValue({});
  });

  it('bounds webRequest fields and preserves passively completed results for retrieval', async () => {
    const { networkCaptureStartTool, networkCaptureStopTool } = await import(
      '@/entrypoints/background/tools/browser/network-capture-web-request'
    );
    await (networkCaptureStartTool as any).startCaptureForTab(7, {
      maxCaptureTime: 30_000,
      inactivityTimeout: 10_000,
      includeStatic: true,
      rootTabId: 7,
      lineageDepth: 0,
      deadlineAt: Date.now() + 30_000,
    });

    const beforeRequest = vi.mocked(chrome.webRequest.onBeforeRequest.addListener).mock.calls[0][0];
    beforeRequest({
      requestId: 'request-1',
      tabId: 7,
      url: `https://example.com/?q=${'x'.repeat(100_000)}`,
      method: 'POST',
      type: 'xmlhttprequest',
      timeStamp: Number.POSITIVE_INFINITY,
      requestBody: {
        formData: { huge: Array.from({ length: 100 }, () => 'x'.repeat(100_000)) },
      },
    } as unknown as chrome.webRequest.WebRequestBodyDetails);

    const capture = networkCaptureStartTool.captureData.get(7)!;
    const request = Object.values(capture.requests)[0];
    expect(utf8ByteLength(request.url)).toBeLessThanOrEqual(NETWORK_CAPTURE_LIMITS.maxUrlBytes);
    expect(utf8ByteLength(request.requestBody)).toBeLessThanOrEqual(
      NETWORK_CAPTURE_LIMITS.maxRequestBodyBytes,
    );
    expect(request.requestTime).toEqual(expect.any(Number));
    expect(capture.storedBytes).toBeLessThanOrEqual(NETWORK_CAPTURE_LIMITS.maxCaptureBytes);

    const autoResult = await networkCaptureStartTool.stopCapture(7, true, 'inactivity_timeout');
    expect(autoResult.success).toBe(true);
    expect(networkCaptureStartTool.captureData.has(7)).toBe(false);
    expect(networkCaptureStartTool.hasAvailableCapture()).toBe(true);

    const retrieved = await networkCaptureStopTool.execute({ tabId: 7 });
    const payload = JSON.parse(String((retrieved.content[0] as { text?: string }).text));
    expect(retrieved.isError).toBe(false);
    expect(payload.stoppedBy).toBe('inactivity_timeout');
    expect(networkCaptureStartTool.hasAvailableCapture()).toBe(false);
  });

  it('does not recursively capture tabs past the lineage depth', async () => {
    const { networkCaptureStartTool } = await import(
      '@/entrypoints/background/tools/browser/network-capture-web-request'
    );
    networkCaptureStartTool.captureData.set(7, {
      tabId: 7,
      tabUrl: 'https://example.com/',
      tabTitle: 'Example',
      startTime: Date.now(),
      requests: {},
      maxCaptureTime: 30_000,
      inactivityTimeout: 10_000,
      includeStatic: true,
      storedBytes: 0,
      rootTabId: 7,
      lineageDepth: NETWORK_CAPTURE_LIMITS.maxLineageDepth,
      deadlineAt: Date.now() + 30_000,
    });
    const startSpy = vi.spyOn(networkCaptureStartTool as any, 'startCaptureForTab');

    await (networkCaptureStartTool as any).handleTabCreated({ id: 8, openerTabId: 7 });

    expect(startSpy).not.toHaveBeenCalled();
    (networkCaptureStartTool as any).cleanupCapture(7);
  });

  it('configures bounded CDP buffers and skips a known oversized response body', async () => {
    const { networkDebuggerStartTool, networkDebuggerStopTool } = await import(
      '@/entrypoints/background/tools/browser/network-capture-debugger'
    );
    await (networkDebuggerStartTool as any).startCaptureForTab(7, {
      maxCaptureTime: 30_000,
      inactivityTimeout: 10_000,
      includeStatic: true,
      rootTabId: 7,
      lineageDepth: 0,
      deadlineAt: Date.now() + 30_000,
    });
    expect(cdp.sendCommand).toHaveBeenCalledWith(7, 'Network.enable', {
      maxTotalBufferSize: NETWORK_CAPTURE_LIMITS.maxCaptureBytes,
      maxResourceBufferSize: NETWORK_CAPTURE_LIMITS.maxResponseBodyBytes,
      maxPostDataSize: NETWORK_CAPTURE_LIMITS.maxRequestBodyBytes,
    }, undefined);

    (networkDebuggerStartTool as any).handleRequestWillBeSent(7, {
      requestId: 'request-1',
      request: {
        url: 'https://example.com/api/data',
        method: 'GET',
        headers: {},
      },
      timestamp: 1,
      type: 'Fetch',
    });
    (networkDebuggerStartTool as any).handleResponseReceived(7, {
      requestId: 'request-1',
      response: {
        status: 200,
        statusText: 'OK',
        headers: {
          'content-length': String(NETWORK_CAPTURE_LIMITS.maxResponseBodyBytes + 1),
        },
        mimeType: 'application/json',
      },
      timestamp: 2,
      type: 'Fetch',
    });
    cdp.sendCommand.mockClear();
    await (networkDebuggerStartTool as any).handleLoadingFinished(7, {
      requestId: 'request-1',
      encodedDataLength: NETWORK_CAPTURE_LIMITS.maxResponseBodyBytes + 1,
    });

    expect(cdp.sendCommand).not.toHaveBeenCalledWith(
      7,
      'Network.getResponseBody',
      expect.anything(),
    );
    const request = (networkDebuggerStartTool as any).captureData.get(7).requests['request-1'];
    expect(request.responseBodyOmitted).toBe('known_size_limit');
    await networkDebuggerStartTool.stopCapture(7, true, 'max_capture_time');
    expect(networkDebuggerStartTool.hasAvailableCapture()).toBe(true);
    const retrieved = await networkDebuggerStopTool.execute({ tabId: 7 });
    const payload = JSON.parse(String((retrieved.content[0] as { text?: string }).text));
    expect(payload.stoppedBy).toBe('max_capture_time');
    expect(networkDebuggerStartTool.hasAvailableCapture()).toBe(false);
  });

  it('coalesces concurrent auto-stop and explicit stop without leaving stale cached results', async () => {
    const { networkDebuggerStartTool } = await import(
      '@/entrypoints/background/tools/browser/network-capture-debugger'
    );
    await (networkDebuggerStartTool as any).startCaptureForTab(7, {
      maxCaptureTime: 30_000,
      inactivityTimeout: 10_000,
      includeStatic: true,
      rootTabId: 7,
      lineageDepth: 0,
      deadlineAt: Date.now() + 30_000,
    });

    let releaseDisable!: () => void;
    cdp.sendCommand.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDisable = () => resolve({});
        }),
    );

    const autoStop = networkDebuggerStartTool.stopCapture(7, true, 'inactivity_timeout');
    const explicitStop = networkDebuggerStartTool.stopCapture(7, false, 'user_request');
    releaseDisable();

    const [autoResult, explicitResult] = await Promise.all([autoStop, explicitStop]);
    expect(autoResult.success).toBe(true);
    expect(explicitResult.success).toBe(true);
    expect(networkDebuggerStartTool.hasAvailableCapture()).toBe(false);
  });

  it.each(['debugger', 'webRequest'])('cancels an in-flight child start in %s mode', async (mode) => {
    const backend = mode === 'debugger'
      ? (await import('@/entrypoints/background/tools/browser/network-capture-debugger')).networkDebuggerStartTool
      : (await import('@/entrypoints/background/tools/browser/network-capture-web-request')).networkCaptureStartTool;
    await (backend as any).startCaptureForTab(7, {
      maxCaptureTime: 30_000, inactivityTimeout: 10_000, includeStatic: true,
    });
    let started!: () => void;
    const starting = new Promise<void>((resolve) => { started = resolve; });
    let finishRead!: () => void;
    if (mode === 'debugger') {
      cdp.sendCommand.mockImplementation(async (id, method, _params, signal) => {
        if (id !== 8 || method !== 'Network.enable') return {};
        started();
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      });
    } else {
      vi.mocked(chrome.tabs.get).mockImplementation(async (id) => {
        if (id === 8) {
          started();
          await new Promise<void>((resolve) => { finishRead = resolve; });
        }
        return tab(id);
      });
    }
    const child = (backend as any).handleTabCreated({ id: 8, openerTabId: 7 });
    await starting;
    await backend.stopCapture(7);
    const stopped = backend.stopLineageCaptures(7);
    finishRead?.();
    await Promise.all([child, stopped]);
    expect(backend.hasAvailableCapture()).toBe(false);
    if (mode === 'debugger') {
      expect(cdp.sendCommand).toHaveBeenCalledWith(8, 'Network.disable', undefined, expect.any(AbortSignal));
      expect(cdp.detach).toHaveBeenCalledWith(8, 'network-capture');
    }
  });

  it('releases the child debugger lease when a dialog stalls enable and disable', async () => {
    const { networkDebuggerStartTool: backend } = await import(
      '@/entrypoints/background/tools/browser/network-capture-debugger'
    );
    await (backend as any).startCaptureForTab(7, {
      maxCaptureTime: 30_000, inactivityTimeout: 10_000, includeStatic: true,
    });
    let enabling!: () => void;
    const started = new Promise<void>((resolve) => { enabling = resolve; });
    cdp.sendCommand.mockImplementation(async (id, method, _params, signal) => {
      if (id !== 8) return {};
      if (method === 'Network.enable') enabling();
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));
    });
    const child = (backend as any).handleTabCreated({ id: 8, openerTabId: 7 });
    await started;
    const result = await backend.stopCapture(7);
    await child;
    expect(result.success).toBe(true);
    expect(cdp.detach).toHaveBeenCalledWith(8, 'network-capture');
    expect(backend.hasAvailableCapture()).toBe(false);
  });

  it.each([
    ['debugger', false], ['debugger', true], ['webRequest', false], ['webRequest', true],
  ] as const)('manual stop in %s mode (all=%s) drains pending starts before another capture', async (mode, all) => {
    const { networkCaptureTool } = await import('@/entrypoints/background/tools/browser/network-capture');
    const { networkDebuggerStartTool } = await import('@/entrypoints/background/tools/browser/network-capture-debugger');
    const { networkCaptureStartTool } = await import('@/entrypoints/background/tools/browser/network-capture-web-request');
    const owner = mode === 'debugger' ? networkDebuggerStartTool : networkCaptureStartTool;
    await (owner as any).startCaptureForTab(7, {
      maxCaptureTime: 30_000, inactivityTimeout: 10_000, includeStatic: true,
    });
    const child = (owner as any).handleTabCreated({ id: 8, openerTabId: 7 });
    try {
      const stopped = await networkCaptureTool.execute({ action: 'stop', tabId: 7, all });
      expect(stopped.isError).toBe(false);
      expect(owner.hasAvailableCapture()).toBe(false);
      const next = await networkCaptureTool.execute({ action: 'start', tabId: 7, needResponseBody: false });
      expect(next.isError).toBe(false);
    } finally {
      await child;
      await networkCaptureTool.execute({ action: 'stop', all: true });
    }
  });

  it.each(['webRequest', 'debugger'])('preserves pending grandchildren of a still-active opener in %s', async (mode) => {
    const backend = mode === 'debugger'
      ? (await import('@/entrypoints/background/tools/browser/network-capture-debugger')).networkDebuggerStartTool
      : (await import('@/entrypoints/background/tools/browser/network-capture-web-request')).networkCaptureStartTool;
    vi.mocked(chrome.tabs.get).mockImplementation(async (id) => tab(id));
    await (backend as any).startCaptureForTab(7, {
      maxCaptureTime: 30_000, inactivityTimeout: 10_000, includeStatic: true,
    });
    await (backend as any).handleTabCreated({ id: 8, openerTabId: 7 });
    const pending = (backend as any).handleTabCreated({ id: 9, openerTabId: 8 });
    try {
      await backend.stopCapture(7);
      await pending;
      expect(backend.getAvailableTabIds().sort()).toEqual([8, 9]);
      const sibling = (backend as any).handleTabCreated({ id: 10, openerTabId: 8 });
      await backend.stopLineageCaptures(7);
      await sibling;
      expect(backend.hasAvailableCapture()).toBe(false);
    } finally {
      await backend.stopLineageCaptures(7);
    }
  });

  it('stops inherited child captures when stopLineageCaptures is called', async () => {
    const { networkCaptureStartTool } = await import(
      '@/entrypoints/background/tools/browser/network-capture-web-request'
    );
    vi.mocked(chrome.tabs.get).mockImplementation(async (id: number) => tab(id));
    await (networkCaptureStartTool as any).startCaptureForTab(7, {
      maxCaptureTime: 30_000,
      inactivityTimeout: 10_000,
      includeStatic: true,
      rootTabId: 7,
      lineageDepth: 0,
      deadlineAt: Date.now() + 30_000,
    });
    await (networkCaptureStartTool as any).startCaptureForTab(8, {
      maxCaptureTime: 30_000,
      inactivityTimeout: 10_000,
      includeStatic: true,
      rootTabId: 7,
      lineageDepth: 1,
      deadlineAt: Date.now() + 30_000,
    });

    await networkCaptureStartTool.stopCapture(7);
    await networkCaptureStartTool.stopLineageCaptures(7);

    expect(networkCaptureStartTool.hasAvailableCapture()).toBe(false);
  });
});
