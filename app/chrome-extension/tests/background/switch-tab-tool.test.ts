import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { switchTabTool } from '@/entrypoints/background/tools/browser/common';

function makeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 7,
    index: 0,
    windowId: 2,
    title: 'Secret',
    url: 'file:///tmp/secret.txt',
    status: 'complete',
    active: false,
    ...overrides,
  } as chrome.tabs.Tab;
}

describe('switchTabTool', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn(),
        update: vi.fn(),
      },
      windows: {
        update: vi.fn(),
      },
      runtime: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects non-public target tabs before switching', async () => {
    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    const tabsUpdate = chrome.tabs.update as ReturnType<typeof vi.fn>;
    tabsGet.mockResolvedValue(makeTab());

    const result = await switchTabTool.execute({ tabId: 7 });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_switch_tab',
    );
    expect(tabsGet).toHaveBeenCalledWith(7);
    expect(tabsUpdate).not.toHaveBeenCalled();
  });
});
