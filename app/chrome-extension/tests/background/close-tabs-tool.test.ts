import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeTabHandler } from '@/entrypoints/background/record-replay/actions/handlers/tabs';
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

  it('requires an explicit pattern when migrating a recorded URL prefix', async () => {
    const ctx = { vars: {}, tabId: 7, log: vi.fn() };
    const action = { id: 'close', type: 'closeTab' as const };
    const partial = await closeTabHandler.run(ctx, { ...action, params: { url: '/reports' } });
    expect(partial.status).toBe('failed');
    expect(mocks.tabsRemove).not.toHaveBeenCalled();
    const urlPattern = 'https://example.com/reports/*';
    mocks.tabsQuery.mockResolvedValue([makeTab({ id: 9, url: 'https://example.com/reports/1' })]);
    const result = await closeTabHandler.run(ctx, { ...action, params: { urlPattern } });
    expect(result.status).toBe('success');
    expect(mocks.tabsQuery).toHaveBeenCalledWith({ url: urlPattern });
    expect(mocks.tabsRemove).toHaveBeenCalledWith([9]);
  });

  it('closes only exact canonical URLs across windows, including literal stars, search and fragment', async () => {
    const url = 'https://example.com/Draft*?q=one#part';
    mocks.tabsQuery.mockResolvedValue([
      makeTab({ id: 1, url }), makeTab({ id: 2, url, windowId: 3 }),
      ...['/Draft*/child', '/Draft*?q=two#part', '/Draft*?q=one#other', '/draft*?q=one#part']
        .map((suffix, index) => makeTab({ id: 10 + index, url: 'https://example.com' + suffix })),
      makeTab({ id: 20, url, pendingUrl: 'https://example.com/another-draft' }),
    ]);
    await closeTabsTool.execute({ url: 'https://EXAMPLE.com:443/Draft*?q=one#part' });
    expect(mocks.tabsRemove).toHaveBeenCalledWith([1, 2]);
  });

  it('only uses Chrome matching for an explicit pattern', async () => {
    await closeTabsTool.execute({ urlPattern: 'https://example.com/draft/*' });
    expect(mocks.tabsQuery).toHaveBeenCalledWith({ url: 'https://example.com/draft/*' });
    expect(mocks.tabsRemove).toHaveBeenCalledWith([7]);
  });

  it('fails closed for empty or conflicting URL selections', async () => {
    for (const args of [{ url: '' }, { urlPattern: '' }, { url: 'https://example.com/', urlPattern: '*://*/*' }]) {
      expect((await closeTabsTool.execute(args)).isError).toBe(true);
    }
    expect(mocks.tabsRemove).not.toHaveBeenCalled();
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
