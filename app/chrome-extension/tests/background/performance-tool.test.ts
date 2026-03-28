import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  attach: vi.fn(),
  sendCommand: vi.fn(),
  debuggerOnEventAddListener: vi.fn(),
  tabsGet: vi.fn(),
  tabsQuery: vi.fn(),
}));

vi.mock('@/utils/cdp-session-manager', () => ({
  cdpSessionManager: {
    attach: mocks.attach,
    sendCommand: mocks.sendCommand,
  },
}));

import { performanceStartTraceTool } from '@/entrypoints/background/tools/browser/performance';

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

describe('performanceStartTraceTool', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());

    mocks.attach.mockResolvedValue(undefined);
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
          removeListener: vi.fn(),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('marks duplicate start attempts as MCP errors', async () => {
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
});
