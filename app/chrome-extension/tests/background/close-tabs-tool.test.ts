import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeTabsTool } from '@/entrypoints/background/tools/browser/common';

const mocks = vi.hoisted(() => ({
  tabsGet: vi.fn(),
  tabsQuery: vi.fn(),
  tabsRemove: vi.fn(),
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

describe('closeTabsTool', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());

    mocks.tabsGet.mockResolvedValue(makeTab());
    mocks.tabsQuery.mockResolvedValue([makeTab()]);
    mocks.tabsRemove.mockResolvedValue(undefined);

    vi.stubGlobal('chrome', {
      tabs: {
        get: mocks.tabsGet,
        query: mocks.tabsQuery,
        remove: mocks.tabsRemove,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects explicit non-public tab ids before closing them', async () => {
    mocks.tabsGet.mockResolvedValueOnce(makeTab({ id: 7, url: 'file:///tmp/secret.txt' }));

    const result = await closeTabsTool.execute({
      tabIds: [7],
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_close_tabs',
    );
    expect(mocks.tabsRemove).not.toHaveBeenCalled();
  });

  it('rejects non-public URL filters before querying tabs', async () => {
    const result = await closeTabsTool.execute({
      url: 'file:///tmp/secret.txt',
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_close_tabs',
    );
    expect(mocks.tabsQuery).not.toHaveBeenCalled();
    expect(mocks.tabsRemove).not.toHaveBeenCalled();
  });

  it('rejects closing the default active tab when it is non-public', async () => {
    mocks.tabsQuery.mockResolvedValueOnce([makeTab({ id: 7, url: 'file:///tmp/secret.txt' })]);

    const result = await closeTabsTool.execute({});

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text || '')).toContain(
      'Only http:// and https:// pages are supported by chrome_close_tabs',
    );
    expect(mocks.tabsRemove).not.toHaveBeenCalled();
  });
});
