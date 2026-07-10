import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  sendCommand: vi.fn(),
  debuggerOnEventAddListener: vi.fn(),
  debuggerOnEventRemoveListener: vi.fn(),
  debuggerOnDetachAddListener: vi.fn(),
  tabsGet: vi.fn(),
  tabsQuery: vi.fn(),
  tabsOnRemovedAddListener: vi.fn(),
  alarmsCreate: vi.fn(),
  alarmsClear: vi.fn(),
  alarmsOnAlarmAddListener: vi.fn(),
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
    mocks.alarmsCreate.mockResolvedValue(undefined);
    mocks.alarmsClear.mockResolvedValue(true);

    vi.stubGlobal('chrome', {
      tabs: {
        get: mocks.tabsGet,
        query: mocks.tabsQuery,
        onRemoved: {
          addListener: mocks.tabsOnRemovedAddListener,
        },
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
        onDetach: {
          addListener: mocks.debuggerOnDetachAddListener,
        },
      },
      alarms: {
        create: mocks.alarmsCreate,
        clear: mocks.alarmsClear,
        onAlarm: {
          addListener: mocks.alarmsOnAlarmAddListener,
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

  it('enforces the hard duration limit even when auto-stop is disabled', async () => {
    const { performanceStartTraceTool, performanceStopTraceTool } = await loadPerformanceTools();

    const start = await performanceStartTraceTool.execute({ autoStop: false });
    const startPayload = JSON.parse(String((start.content[0] as { text?: string })?.text || '{}'));
    expect(startPayload.durationMs).toBe(60_000);

    const alarmListener = mocks.alarmsOnAlarmAddListener.mock.calls[0]?.[0];
    expect(typeof alarmListener).toBe('function');
    alarmListener?.({ name: 'performance-trace-stop:7' });

    await vi.waitFor(() => {
      expect(mocks.sendCommand).toHaveBeenCalledWith(7, 'Tracing.end');
    });
    const traceListener = mocks.debuggerOnEventAddListener.mock.calls[0]?.[0];
    traceListener?.({ tabId: 7 }, 'Tracing.tracingComplete', {});

    const stop = await performanceStopTraceTool.execute({});
    const payload = JSON.parse(String((stop.content[0] as { text?: string })?.text || '{}'));

    expect(stop.isError).toBe(false);
    expect(payload).toMatchObject({
      truncated: true,
      truncationReason: 'max_duration',
      stopReason: 'max_duration',
      tracingCompleted: true,
    });
  });

  it('auto-stops at the requested bounded duration without marking a normal trace truncated', async () => {
    const { performanceStartTraceTool, performanceStopTraceTool } = await loadPerformanceTools();

    const start = await performanceStartTraceTool.execute({
      autoStop: true,
      durationMs: 2_500,
    });
    const startPayload = JSON.parse(String((start.content[0] as { text?: string })?.text || '{}'));
    expect(startPayload.durationMs).toBe(2_500);

    const alarmListener = mocks.alarmsOnAlarmAddListener.mock.calls[0]?.[0];
    alarmListener?.({ name: 'performance-trace-stop:7' });
    await vi.waitFor(() => {
      expect(mocks.sendCommand).toHaveBeenCalledWith(7, 'Tracing.end');
    });
    const traceListener = mocks.debuggerOnEventAddListener.mock.calls[0]?.[0];
    traceListener?.({ tabId: 7 }, 'Tracing.tracingComplete', {});

    const stop = await performanceStopTraceTool.execute({});
    const payload = JSON.parse(String((stop.content[0] as { text?: string })?.text || '{}'));
    expect(payload).toMatchObject({
      truncated: false,
      truncationReason: null,
      stopReason: 'auto_stop',
    });
  });

  it('stops and marks a trace truncated when the serialized byte cap is reached', async () => {
    const { performanceStartTraceTool, performanceStopTraceTool } = await loadPerformanceTools();

    const start = await performanceStartTraceTool.execute({});
    const startPayload = JSON.parse(String((start.content[0] as { text?: string })?.text || '{}'));
    const traceListener = mocks.debuggerOnEventAddListener.mock.calls[0]?.[0];
    traceListener?.({ tabId: 7 }, 'Tracing.dataCollected', {
      value: [
        {
          name: 'oversized',
          payload: 'x'.repeat(startPayload.limits.maxSerializedBytes),
        },
      ],
    });

    await vi.waitFor(() => {
      expect(mocks.sendCommand).toHaveBeenCalledWith(7, 'Tracing.end');
    });
    traceListener?.({ tabId: 7 }, 'Tracing.tracingComplete', {});

    const stop = await performanceStopTraceTool.execute({});
    const payload = JSON.parse(String((stop.content[0] as { text?: string })?.text || '{}'));
    expect(payload).toMatchObject({
      eventCount: 0,
      observedEventCount: 1,
      droppedEventCount: 1,
      truncated: true,
      truncationReason: 'max_serialized_bytes',
    });
    expect(payload.serializedBytes).toBeLessThanOrEqual(payload.limits.maxSerializedBytes);
  });

  it('stops and marks a trace truncated when the cumulative event cap is reached', async () => {
    const { performanceStartTraceTool, performanceStopTraceTool } = await loadPerformanceTools();

    const start = await performanceStartTraceTool.execute({});
    const startPayload = JSON.parse(String((start.content[0] as { text?: string })?.text || '{}'));
    const traceListener = mocks.debuggerOnEventAddListener.mock.calls[0]?.[0];
    const event = { name: 'bounded-event' };
    const firstBatchSize = Math.floor(startPayload.limits.maxEventCount / 2);
    traceListener?.({ tabId: 7 }, 'Tracing.dataCollected', {
      value: Array.from({ length: firstBatchSize }, () => event),
    });
    expect(mocks.sendCommand).not.toHaveBeenCalledWith(7, 'Tracing.end');
    traceListener?.({ tabId: 7 }, 'Tracing.dataCollected', {
      value: Array.from(
        { length: startPayload.limits.maxEventCount - firstBatchSize },
        () => event,
      ),
    });

    await vi.waitFor(() => {
      expect(mocks.sendCommand).toHaveBeenCalledWith(7, 'Tracing.end');
    });
    traceListener?.({ tabId: 7 }, 'Tracing.tracingComplete', {});

    const stop = await performanceStopTraceTool.execute({});
    const payload = JSON.parse(String((stop.content[0] as { text?: string })?.text || '{}'));
    expect(payload).toMatchObject({
      eventCount: startPayload.limits.maxEventCount,
      observedEventCount: startPayload.limits.maxEventCount,
      truncated: true,
      truncationReason: 'max_event_count',
    });
  });

  it('cleans up an active trace when its tab closes', async () => {
    const { performanceStartTraceTool } = await loadPerformanceTools();

    expect((await performanceStartTraceTool.execute({})).isError).toBe(false);
    const tabRemovedListener = mocks.tabsOnRemovedAddListener.mock.calls[0]?.[0];
    expect(typeof tabRemovedListener).toBe('function');
    tabRemovedListener?.(7, { isWindowClosing: false });

    await vi.waitFor(() => {
      expect(mocks.detach).toHaveBeenCalledWith(7, 'performance');
      expect(mocks.debuggerOnEventRemoveListener).toHaveBeenCalledTimes(1);
    });

    expect((await performanceStartTraceTool.execute({})).isError).toBe(false);
    expect(mocks.attach).toHaveBeenCalledTimes(2);
  });

  it('cleans up an active trace when Chrome detaches the debugger unexpectedly', async () => {
    const { performanceStartTraceTool } = await loadPerformanceTools();

    expect((await performanceStartTraceTool.execute({})).isError).toBe(false);
    const detachListener = mocks.debuggerOnDetachAddListener.mock.calls[0]?.[0];
    expect(typeof detachListener).toBe('function');
    detachListener?.({ tabId: 7 }, 'target_closed');

    await vi.waitFor(() => {
      expect(mocks.detach).toHaveBeenCalledWith(7, 'performance');
      expect(mocks.debuggerOnEventRemoveListener).toHaveBeenCalledTimes(1);
    });

    expect((await performanceStartTraceTool.execute({})).isError).toBe(false);
    expect(mocks.attach).toHaveBeenCalledTimes(2);
  });

  it('keeps only five result summaries using strict LRU ordering', async () => {
    const { performanceAnalyzeInsightTool, performanceStartTraceTool, performanceStopTraceTool } =
      await loadPerformanceTools();
    mocks.downloadsSearch.mockResolvedValue([]);
    mocks.tabsGet.mockImplementation(async (tabId: number) =>
      makeTab({ id: tabId, url: `https://example.com/${tabId}` }),
    );

    const record = async (tabId: number) => {
      const listenerIndex = mocks.debuggerOnEventAddListener.mock.calls.length;
      expect((await performanceStartTraceTool.execute({ tabId })).isError).toBe(false);
      const traceListener = mocks.debuggerOnEventAddListener.mock.calls[listenerIndex]?.[0];
      const stopPromise = performanceStopTraceTool.execute({ tabId });
      traceListener?.({ tabId }, 'Tracing.tracingComplete', {});
      expect((await stopPromise).isError).toBe(false);
    };

    for (let tabId = 1; tabId <= 5; tabId += 1) {
      await record(tabId);
    }

    // Access tab 1 so tab 2 becomes the least-recently-used result.
    const touched = await performanceAnalyzeInsightTool.execute({ tabId: 1 });
    expect(String((touched.content[0] as { text?: string })?.text || '')).toContain(
      'Lightweight analysis',
    );
    await record(6);

    const evicted = await performanceAnalyzeInsightTool.execute({ tabId: 2 });
    expect(String((evicted.content[0] as { text?: string })?.text || '')).toContain(
      'No recorded traces found',
    );
    const retained = await performanceAnalyzeInsightTool.execute({ tabId: 1 });
    expect(String((retained.content[0] as { text?: string })?.text || '')).toContain(
      'Lightweight analysis',
    );
  });

  it('actively expires result summaries after the absolute TTL', async () => {
    const { performanceAnalyzeInsightTool, performanceStartTraceTool, performanceStopTraceTool } =
      await loadPerformanceTools();
    mocks.downloadsSearch.mockResolvedValue([]);

    await performanceStartTraceTool.execute({});
    const traceListener = mocks.debuggerOnEventAddListener.mock.calls[0]?.[0];
    const stopPromise = performanceStopTraceTool.execute({});
    traceListener?.({ tabId: 7 }, 'Tracing.tracingComplete', {});
    await stopPromise;

    const resultAlarm = [...mocks.alarmsCreate.mock.calls]
      .reverse()
      .find(([name]) => String(name).startsWith('performance-trace-result-expiry:'));
    expect(resultAlarm).toBeDefined();
    const expiresAt = Number(resultAlarm?.[1]?.when);
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(expiresAt);
    const alarmListener = mocks.alarmsOnAlarmAddListener.mock.calls[0]?.[0];
    alarmListener?.({ name: resultAlarm?.[0] });
    dateNow.mockRestore();

    const analyze = await performanceAnalyzeInsightTool.execute({ tabId: 7 });
    expect(String((analyze.content[0] as { text?: string })?.text || '')).toContain(
      'No recorded traces found',
    );
  });
});
