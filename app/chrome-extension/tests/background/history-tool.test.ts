import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { historyTool } from '@/entrypoints/background/tools/browser/history';

describe('historyTool', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {
      history: {
        search: vi.fn(),
      },
      tabs: {
        query: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('filters non-public history entries from results', async () => {
    const search = chrome.history.search as ReturnType<typeof vi.fn>;
    search.mockResolvedValue([
      {
        id: '1',
        url: 'https://example.com',
        title: 'Example',
      },
      {
        id: '2',
        url: 'file:///tmp/secret.txt',
        title: 'secret.txt',
      },
    ]);

    const result = await historyTool.execute({});
    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));

    expect(payload.totalCount).toBe(1);
    expect(payload.items).toEqual([
      {
        id: '1',
        url: 'https://example.com',
        title: 'Example',
      },
    ]);
  });
});
