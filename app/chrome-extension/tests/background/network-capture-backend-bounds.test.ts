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
    });

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
});
