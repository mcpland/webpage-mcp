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
        query: vi.fn(),
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

  it('can select a public tab without activating or focusing it', async () => {
    const tabsGet = chrome.tabs.get as ReturnType<typeof vi.fn>;
    const tabsUpdate = chrome.tabs.update as ReturnType<typeof vi.fn>;
    const windowsUpdate = chrome.windows.update as ReturnType<typeof vi.fn>;
    tabsGet.mockResolvedValue(makeTab({ url: 'https://example.com/', title: 'Example' }));

    const result = await switchTabTool.execute({ tabId: 7, windowId: 2, background: true });

    expect(result.isError).toBe(false);
    expect(tabsGet).toHaveBeenCalledWith(7);
    expect(tabsUpdate).not.toHaveBeenCalled();
    expect(windowsUpdate).not.toHaveBeenCalled();
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'without activating it',
    );
  });

  describe('finding the tab by url or title', () => {
    const payloadOf = (result: { content: Array<{ type: string; text?: string }> }) =>
      JSON.parse(String(result.content[0]?.text || '{}'));

    beforeEach(() => {
      (chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeTab({ id: 1, windowId: 1, url: 'file:///tmp/github.html', title: 'GitHub notes' }),
        makeTab({ id: 2, windowId: 1, url: 'https://github.com/org/repo/pulls', title: 'Pull requests', lastAccessed: 100 } as any),
        makeTab({ id: 3, windowId: 3, url: 'https://github.com/org/repo/issues', title: 'Issues', lastAccessed: 300 } as any),
        makeTab({ id: 4, windowId: 1, url: 'https://mail.example.com/inbox', title: 'Inbox (3)', lastAccessed: 200 } as any),
      ]);
    });

    it('switches to the most recently used match and focuses its window', async () => {
      const result = await switchTabTool.execute({ url: 'GITHUB.com/org' });
      const payload = payloadOf(result);

      expect(result.isError).toBe(false);
      expect(payload).toMatchObject({ tabId: 3, windowId: 3, title: 'Issues', matchCount: 2 });
      expect(payload.otherMatches).toEqual([
        { tabId: 2, title: 'Pull requests', url: 'https://github.com/org/repo/pulls' },
      ]);
      expect(chrome.windows.update).toHaveBeenCalledWith(3, { focused: true });
      expect(chrome.tabs.update).toHaveBeenCalledWith(3, { active: true });
    });

    it('prefers an exact url match over more recent partial matches', async () => {
      const result = await switchTabTool.execute({ url: 'https://github.com/org/repo/pulls/' });

      expect(payloadOf(result).tabId).toBe(2);
    });

    it('matches titles and requires both when url and title are given', async () => {
      expect(payloadOf(await switchTabTool.execute({ title: 'inbox' })).tabId).toBe(4);
      const both = await switchTabTool.execute({ url: 'github.com', title: 'pull' });
      expect(payloadOf(both)).toMatchObject({ tabId: 2 });
      expect(payloadOf(both).otherMatches).toBeUndefined();
    });

    it('never selects non-HTTP tabs and explains when nothing matches', async () => {
      const result = await switchTabTool.execute({ title: 'GitHub notes' });

      expect(result.isError).toBe(true);
      expect(String((result.content[0] as { text?: string }).text)).toContain(
        'No open HTTP(S) tab has a title containing "GitHub notes"',
      );
      expect(chrome.tabs.update).not.toHaveBeenCalled();
    });

    it('limits the search to windowId when given', async () => {
      await switchTabTool.execute({ url: 'github.com', windowId: 1 });

      expect(chrome.tabs.query).toHaveBeenCalledWith({ windowId: 1 });
    });

    it('requires a tabId or a selector', async () => {
      const result = await switchTabTool.execute({});

      expect(result.isError).toBe(true);
      expect(chrome.tabs.query).not.toHaveBeenCalled();
    });
  });
});
