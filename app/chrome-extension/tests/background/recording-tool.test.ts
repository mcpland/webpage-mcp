import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recorderStart: vi.fn(),
  recorderStop: vi.fn(),
  buildRecordingStateSnapshot: vi.fn(),
  tabsGet: vi.fn(),
  tabsQuery: vi.fn(),
}));

vi.mock('@/entrypoints/background/recording', () => ({
  RecorderManager: {
    start: mocks.recorderStart,
    stop: mocks.recorderStop,
  },
  buildRecordingStateSnapshot: mocks.buildRecordingStateSnapshot,
}));

vi.mock('@/entrypoints/background/record-replay-v3/compat', () => ({
  saveFlowToV3: vi.fn(),
}));

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    status: 'idle',
    sessionId: null,
    originTabId: 7,
    originUrl: 'https://example.com/',
    originTitle: 'Example',
    startedAt: null,
    durationMs: 0,
    stepCount: 0,
    activeTabCount: 0,
    flowId: null,
    flowName: null,
    ...overrides,
  };
}

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

async function loadRecordingTools() {
  return await import('@/entrypoints/background/tools/recording');
}

describe('recording tools', () => {
  beforeEach(() => {
    mocks.recorderStart.mockReset().mockResolvedValue({ success: true });
    mocks.recorderStop.mockReset().mockResolvedValue({ success: true, flow: null });
    mocks.buildRecordingStateSnapshot.mockReset().mockReturnValue(makeState());
    mocks.tabsGet.mockReset().mockResolvedValue(makeTab());
    mocks.tabsQuery.mockReset().mockResolvedValue([makeTab()]);

    vi.stubGlobal('chrome', {
      tabs: {
        get: mocks.tabsGet,
        query: mocks.tabsQuery,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('rejects file URL tabs before starting a recording', async () => {
    const { recordingStartTool } = await loadRecordingTools();
    mocks.tabsGet.mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));

    const result = await recordingStartTool.execute({ tabId: 7 });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by recording_start',
    );
    expect(mocks.recorderStart).not.toHaveBeenCalled();
  });

  it('redacts non-public origins from recording status', async () => {
    const { recordingStatusTool } = await loadRecordingTools();
    mocks.buildRecordingStateSnapshot.mockReturnValue(
      makeState({
        originUrl: 'file:///tmp/secret.txt',
        originTitle: 'Secret',
      }),
    );

    const result = await recordingStatusTool.execute();
    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));

    expect(result.isError).toBe(false);
    expect(payload.state.originUrl).toBeNull();
    expect(payload.state.originTitle).toBeNull();
  });

  it('redacts non-public origins from recording stop responses', async () => {
    const { recordingStopTool } = await loadRecordingTools();
    mocks.buildRecordingStateSnapshot.mockReturnValue(
      makeState({
        status: 'stopping',
        originUrl: 'file:///tmp/secret.txt',
        originTitle: 'Secret',
      }),
    );

    const result = await recordingStopTool.execute({});
    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));

    expect(result.isError).toBe(false);
    expect(payload.state.originUrl).toBeNull();
    expect(payload.state.originTitle).toBeNull();
  });
});
