import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handleCallTool: vi.fn(),
}));

vi.mock('@/entrypoints/background/tools', () => ({
  handleCallTool: mocks.handleCallTool,
}));

import { ensureTab } from '@/entrypoints/background/record-replay/rr-utils';

describe('ensureTab background execution contract', () => {
  const tabsQuery = vi.fn();
  const tabsCreate = vi.fn();
  const tabsUpdate = vi.fn();

  beforeEach(() => {
    mocks.handleCallTool.mockReset();
    tabsQuery.mockReset();
    tabsCreate.mockReset();
    tabsUpdate.mockReset();

    vi.stubGlobal('chrome', {
      tabs: {
        query: tabsQuery,
        create: tabsCreate,
        update: tabsUpdate,
        get: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens tabTarget=new as an inactive tab during background replay', async () => {
    tabsQuery.mockResolvedValue([
      {
        id: 10,
        active: true,
        currentWindow: true,
        url: 'https://fixtures.local/source.html',
      },
    ]);
    tabsCreate.mockResolvedValue({ id: 99, url: 'https://fixtures.local/source.html' });

    const result = await ensureTab({ tabTarget: 'new', background: true });

    expect(result.tabId).toBe(99);
    expect(tabsCreate).toHaveBeenCalledWith({
      url: 'https://fixtures.local/source.html',
      active: false,
    });
  });

  it('selects an existing web tab without activating it when current background tab is internal', async () => {
    tabsQuery
      .mockResolvedValueOnce([
        {
          id: 10,
          active: true,
          currentWindow: true,
          url: 'chrome://newtab/',
        },
        {
          id: 11,
          active: false,
          currentWindow: true,
          url: 'https://fixtures.local/form.html',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 10,
          active: true,
          currentWindow: true,
          url: 'chrome://newtab/',
        },
      ]);

    const result = await ensureTab({ tabTarget: 'current', background: true });

    expect(result.tabId).toBe(11);
    expect(tabsUpdate).not.toHaveBeenCalled();
  });
});
