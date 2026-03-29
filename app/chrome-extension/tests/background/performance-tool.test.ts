import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  detach: vi.fn(),
  sendCommand: vi.fn(),
  debuggerOnEventAddListener: vi.fn(),
  debuggerOnEventRemoveListener: vi.fn(),
  tabsGet: vi.fn(),
  tabsQuery: vi.fn(),
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

    vi.stubGlobal('chrome', {
      tabs: {
        get: mocks.tabsGet,
        query: mocks.tabsQuery,
      },
      debugger: {
        onEvent: {
          addListener: mocks.debuggerOnEventAddListener,
          removeListener: mocks.debuggerOnEventRemoveListener,
        },
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
});
