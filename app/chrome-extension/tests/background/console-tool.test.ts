import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { consoleTool } from '@/entrypoints/background/tools/browser/console';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

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

describe('consoleTool', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn(),
        query: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      windows: {
        update: vi.fn(),
      },
      debugger: {
        onEvent: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects file URLs before navigating', async () => {
    const tabsCreate = chrome.tabs.create as ReturnType<typeof vi.fn>;

    const result = await consoleTool.execute({
      url: 'file:///tmp/secret.txt',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_console',
    );
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it('rejects file URL tabs before attaching the debugger', async () => {
    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    tabsGet.mockResolvedValue(makeTab({ url: 'file:///tmp/secret.txt' }));
    const attach = vi.spyOn(cdpSessionManager, 'attach').mockResolvedValue(undefined);

    const result = await consoleTool.execute({
      tabId: 7,
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_console',
    );
    expect(tabsGet).toHaveBeenCalledWith(7);
    expect(attach).not.toHaveBeenCalled();
  });
});
