import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  sendCommand: vi.fn(),
  debuggerOnEventAddListener: vi.fn(),
  debuggerOnEventRemoveListener: vi.fn(),
  tabsGet: vi.fn(),
  tabsQuery: vi.fn(),
  downloadsDownload: vi.fn(),
  downloadsSearch: vi.fn(),
  runtimeOnMessageAddListener: vi.fn(),
  runtimeOnMessageRemoveListener: vi.fn(),
  runtimeSendMessage: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: mocks.attach,
    detach: mocks.detach,
    sendCommand: mocks.sendCommand,
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

async function loadPerformanceTools() {
  return await import('@/entrypoints/background/tools/browser/performance');
}

describe('performance trace tools', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());

    mocks.attach.mockResolvedValue(undefined);
    mocks.detach.mockResolvedValue(undefined);
    mocks.sendCommand.mockResolvedValue(undefined);
    mocks.tabsGet.mockResolvedValue(makeTab());
    mocks.tabsQuery.mockResolvedValue([makeTab()]);
    mocks.downloadsDownload.mockResolvedValue(91);
    mocks.downloadsSearch.mockResolvedValue([
      {
        id: 91,
        filename: '/Users/alice/Downloads/perf-secret.json',
      },
    ]);
    mocks.runtimeSendMessage.mockResolvedValue(undefined);

    vi.stubGlobal('chrome', {
      tabs: {
        get: mocks.tabsGet,
        query: mocks.tabsQuery,
      },
      downloads: {
        download: mocks.downloadsDownload,
        search: mocks.downloadsSearch,
      },
      debugger: {
        onEvent: {
          addListener: mocks.debuggerOnEventAddListener,
          removeListener: mocks.debuggerOnEventRemoveListener,
        },
      },
      runtime: {
        onMessage: {
          addListener: mocks.runtimeOnMessageAddListener,
          removeListener: mocks.runtimeOnMessageRemoveListener,
        },
        sendMessage: mocks.runtimeSendMessage,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('marks duplicate start attempts as MCP errors', async () => {
    const { performanceStartTraceTool } = await loadPerformanceTools();

    const first = await performanceStartTraceTool.execute({});
    expect(first.isError).toBe(false);

    const second = await performanceStartTraceTool.execute({});

    expect(second.isError).toBe(true);
    expect(String((second.content[0] as { text?: string })?.text || '')).toContain(
      'performance trace is already running',
    );
    expect(mocks.attach).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('rejects file URL tabs before starting a trace', async () => {
    const { performanceStartTraceTool } = await loadPerformanceTools();
    mocks.tabsGet.mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));

    const result = await performanceStartTraceTool.execute({ tabId: 7 });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by performance trace tools',
    );
    expect(mocks.attach).not.toHaveBeenCalled();
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });

  it('cleans up debugger state when trace start fails so a retry can succeed', async () => {
    const { performanceStartTraceTool } = await loadPerformanceTools();

    mocks.sendCommand.mockImplementationOnce(async (_tabId, method) => {
      if (method === 'Tracing.start') {
        throw new Error('Tracing.start failed');
      }
      return undefined;
    });

    const first = await performanceStartTraceTool.execute({});
    expect(first.isError).toBe(true);

    const second = await performanceStartTraceTool.execute({});
    expect(second.isError).toBe(false);

    expect(mocks.attach).toHaveBeenCalledTimes(2);
    expect(mocks.detach).toHaveBeenCalledTimes(1);
    expect(mocks.debuggerOnEventRemoveListener).toHaveBeenCalledTimes(1);
  });

  it('cleans up debugger state when trace stop fails so a new trace can start', async () => {
    const { performanceStartTraceTool, performanceStopTraceTool } = await loadPerformanceTools();

    const start = await performanceStartTraceTool.execute({});
    expect(start.isError).toBe(false);

    mocks.sendCommand.mockImplementation(async (_tabId, method) => {
      if (method === 'Tracing.end') {
        throw new Error('Tracing.end failed');
      }
      return undefined;
    });

    const stop = await performanceStopTraceTool.execute({});
    expect(stop.isError).toBe(true);

    const restart = await performanceStartTraceTool.execute({});
    expect(restart.isError).toBe(false);

    expect(mocks.detach).toHaveBeenCalledTimes(1);
    expect(mocks.debuggerOnEventRemoveListener).toHaveBeenCalledTimes(1);
  });

  it('stops and discards traces on non-public pages instead of saving them', async () => {
    const { performanceStartTraceTool, performanceStopTraceTool } = await loadPerformanceTools();

    const start = await performanceStartTraceTool.execute({});
    expect(start.isError).toBe(false);

    const traceListener = mocks.debuggerOnEventAddListener.mock.calls[0]?.[0];
    if (typeof traceListener === 'function') {
      traceListener({ tabId: 7 }, 'Tracing.tracingComplete', {});
    }
    mocks.tabsQuery.mockResolvedValue([makeTab({ url: 'file:///tmp/secret.txt' })]);

    const stop = await performanceStopTraceTool.execute({});
    const payload = JSON.parse(String((stop.content[0] as { text?: string })?.text || '{}'));

    expect(stop.isError).toBe(false);
    expect(payload.discarded).toBe(true);
    expect(String(payload.message || '')).toContain('Trace data was discarded');
    expect(mocks.detach).toHaveBeenCalledTimes(1);
    expect(mocks.debuggerOnEventRemoveListener).toHaveBeenCalledTimes(1);
  });

  it('rejects trace analysis on file URL tabs', async () => {
    const { performanceAnalyzeInsightTool } = await loadPerformanceTools();
    mocks.tabsGet.mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));

    const result = await performanceAnalyzeInsightTool.execute({ tabId: 7 });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by performance trace tools',
    );
    expect(mocks.sendCommand).not.toHaveBeenCalled();
  });

  it('redacts saved download paths in stop responses', async () => {
    const { performanceStartTraceTool, performanceStopTraceTool } = await loadPerformanceTools();

    mocks.sendCommand.mockImplementation(async (_tabId, method) => {
      if (method === 'Performance.getMetrics') {
        return { metrics: [{ name: 'FirstContentfulPaint', value: 123 }] };
      }
      return undefined;
    });

    const start = await performanceStartTraceTool.execute({});
    expect(start.isError).toBe(false);

    const stopPromise = performanceStopTraceTool.execute({ saveToDownloads: true });
    const traceListener = mocks.debuggerOnEventAddListener.mock.calls[0]?.[0];
    expect(typeof traceListener).toBe('function');
    traceListener?.({ tabId: 7 }, 'Tracing.tracingComplete', {});

    const stop = await stopPromise;
    const payload = JSON.parse(String((stop.content[0] as { text?: string })?.text || '{}'));

    expect(stop.isError).toBe(false);
    expect(payload.saved).toMatchObject({
      downloadId: 91,
      filename: expect.stringMatching(/^performance_trace_.*\.json$/),
      pathRedacted: true,
    });
    expect('fullPath' in payload.saved).toBe(false);
  });

  it('redacts saved trace paths in analyze responses while keeping native analysis enabled', async () => {
    const { performanceStartTraceTool, performanceStopTraceTool, performanceAnalyzeInsightTool } =
      await loadPerformanceTools();

    mocks.sendCommand.mockImplementation(async (_tabId, method) => {
      if (method === 'Performance.getMetrics') {
        return { metrics: [{ name: 'LargestContentfulPaint', value: 456 }] };
      }
      return undefined;
    });

    const listeners: Array<(message: any) => void> = [];
    mocks.runtimeOnMessageAddListener.mockImplementation((listener) => {
      listeners.push(listener);
    });
    mocks.runtimeOnMessageRemoveListener.mockImplementation((listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    });
    mocks.runtimeSendMessage.mockImplementation(async (message) => {
      const requestId = message?.message?.requestId;
      const action = message?.message?.payload?.action;
      if (action === 'analyzeTrace') {
        const listener = listeners.at(-1);
        listener?.({
          type: 'file_operation_response',
          responseToRequestId: requestId,
          payload: {
            success: true,
            summary: { insightName: 'test-summary' },
            insight: { score: 1 },
          },
        });
      } else if (action === 'cleanupFile') {
        const listener = listeners.at(-1);
        listener?.({
          type: 'file_operation_response',
          responseToRequestId: requestId,
          payload: { success: true },
        });
      }
      return undefined;
    });

    await performanceStartTraceTool.execute({});
    const stopPromise = performanceStopTraceTool.execute({ saveToDownloads: true });
    const traceListener = mocks.debuggerOnEventAddListener.mock.calls[0]?.[0];
    traceListener?.({ tabId: 7 }, 'Tracing.tracingComplete', {});
    await stopPromise;

    const analyze = await performanceAnalyzeInsightTool.execute({ tabId: 7 });
    const payload = JSON.parse(String((analyze.content[0] as { text?: string })?.text || '{}'));

    expect(analyze.isError).toBe(false);
    expect(payload.saved).toMatchObject({
      downloadId: 91,
      filename: expect.stringMatching(/^performance_trace_.*\.json$/),
      pathRedacted: true,
    });
    expect('fullPath' in payload.saved).toBe(false);
    expect(payload.summary).toEqual({ insightName: 'test-summary' });
  });
});
