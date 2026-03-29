import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  webRequestStartExecute: vi.fn(),
  webRequestStopExecute: vi.fn(),
  debuggerStartExecute: vi.fn(),
  debuggerStopExecute: vi.fn(),
  webRequestCaptureData: new Map<number, unknown>(),
  debuggerCaptureData: new Map<number, unknown>(),
}));

vi.mock('@/entrypoints/background/tools/browser/network-capture-web-request', () => ({
  networkCaptureStartTool: {
    execute: mocks.webRequestStartExecute,
    captureData: mocks.webRequestCaptureData,
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
});
