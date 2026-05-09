import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveRunTargetTab } from '@/entrypoints/background/record-replay-v3/run-target';

function tab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 1,
    index: 0,
    windowId: 1,
    active: true,
    status: 'complete',
    url: 'https://example.com/',
    title: 'Example',
    ...overrides,
  } as chrome.tabs.Tab;
}

describe('resolveRunTargetTab background mode', () => {
  const tabsGet = vi.fn();
  const tabsQuery = vi.fn();
  const tabsCreate = vi.fn();
  const tabsUpdate = vi.fn();
  const tabsReload = vi.fn();

  beforeEach(() => {
    tabsGet.mockReset();
    tabsQuery.mockReset();
    tabsCreate.mockReset();
    tabsUpdate.mockReset();
    tabsReload.mockReset();

    vi.stubGlobal('chrome', {
      tabs: {
        get: tabsGet,
        query: tabsQuery,
        create: tabsCreate,
        update: tabsUpdate,
        reload: tabsReload,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates new run tabs inactive when backgroundTabs is true', async () => {
    tabsQuery
      .mockResolvedValueOnce([tab()])
      .mockResolvedValueOnce([tab()]);
    tabsCreate.mockResolvedValue(tab({ id: 22, active: false, url: 'https://example.com/new' }));
    tabsGet.mockResolvedValue(tab({ id: 22, active: false, url: 'https://example.com/new' }));

    const tabId = await resolveRunTargetTab({
      tabTarget: 'new',
      startUrl: 'https://example.com/new',
      execution: { backgroundTabs: true },
    });

    expect(tabId).toBe(22);
    expect(tabsCreate).toHaveBeenCalledWith({
      active: false,
      url: 'https://example.com/new',
    });
  });

  it('navigates an existing current tab without activating it in background mode', async () => {
    tabsQuery
      .mockResolvedValueOnce([tab({ id: 9, active: true })])
      .mockResolvedValueOnce([tab({ id: 9, active: true })]);
    tabsUpdate.mockResolvedValue(tab({ id: 9, url: 'https://example.com/next' }));
    tabsGet.mockResolvedValue(tab({ id: 9, url: 'https://example.com/next' }));

    const tabId = await resolveRunTargetTab({
      tabTarget: 'current',
      startUrl: 'https://example.com/next',
      execution: { backgroundTabs: true },
    });

    expect(tabId).toBe(9);
    expect(tabsUpdate).toHaveBeenCalledWith(9, { url: 'https://example.com/next' });
  });

  it('rejects non-http startUrl values when public-page restrictions are enabled', async () => {
    await expect(
      resolveRunTargetTab({
        tabTarget: 'new',
        startUrl: 'file:///tmp/secret.txt',
        execution: { disallowLocalFilePages: true },
      }),
    ).rejects.toThrow(
      'Public flow runs only support HTTP(S) tabs. Switch to an HTTP(S) page or provide an HTTP(S) startUrl.',
    );

    expect(tabsCreate).not.toHaveBeenCalled();
    expect(tabsUpdate).not.toHaveBeenCalled();
  });
});
