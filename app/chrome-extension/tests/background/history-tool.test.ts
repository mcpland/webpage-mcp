import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HISTORY_MAX_OUTPUT_UTF8_BYTES,
  HISTORY_MAX_QUERY_UTF8_BYTES,
  HISTORY_MAX_RESULTS,
  HISTORY_MAX_TIME_INPUT_UTF8_BYTES,
  historyTool,
} from '@/entrypoints/background/tools/browser/history';
import { measureUtf8Bytes } from '@/entrypoints/background/tools/browser/bounded-tool-output';

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

  it('does not reintroduce non-public history entries when excluding current tabs', async () => {
    const search = chrome.history.search as ReturnType<typeof vi.fn>;
    const tabsQuery = chrome.tabs.query as ReturnType<typeof vi.fn>;

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
      {
        id: '3',
        url: 'https://docs.example.com',
        title: 'Docs',
      },
    ]);
    tabsQuery.mockResolvedValue([
      {
        id: 10,
        url: 'https://example.com',
      },
    ]);

    const result = await historyTool.execute({ excludeCurrentTabs: true });
    const payload = JSON.parse(String((result.content[0] as { text?: string })?.text || '{}'));

    expect(payload.totalCount).toBe(1);
    expect(payload.items).toEqual([
      {
        id: '3',
        url: 'https://docs.example.com',
        title: 'Docs',
      },
    ]);
  });

  it('clamps result count and bounds browser-controlled output bytes', async () => {
    const search = chrome.history.search as ReturnType<typeof vi.fn>;
    const huge = 'x'.repeat(20_000);
    search.mockResolvedValue(
      Array.from({ length: HISTORY_MAX_RESULTS + 100 }, (_, index) => ({
        id: `${index}-${huge}`,
        url: `https://example.com/${index}/${huge}`,
        title: huge,
      })),
    );

    const result = await historyTool.execute({ maxResults: Number.MAX_SAFE_INTEGER });
    const text = String((result.content[0] as { text?: string })?.text || '');
    const payload = JSON.parse(text);

    expect(result.isError).toBe(false);
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: HISTORY_MAX_RESULTS }),
    );
    expect(payload.items.length).toBeLessThanOrEqual(HISTORY_MAX_RESULTS);
    expect(payload.truncated).toBe(true);
    expect(measureUtf8Bytes(text)).toBeLessThanOrEqual(HISTORY_MAX_OUTPUT_UTF8_BYTES);
  });

  it('rejects oversized query and time strings before calling Chrome', async () => {
    const search = chrome.history.search as ReturnType<typeof vi.fn>;

    const queryResult = await historyTool.execute({
      text: 'q'.repeat(HISTORY_MAX_QUERY_UTF8_BYTES + 1),
    });
    const timeResult = await historyTool.execute({
      startTime: '2'.repeat(HISTORY_MAX_TIME_INPUT_UTF8_BYTES + 1),
    });

    expect(queryResult.isError).toBe(true);
    expect(timeResult.isError).toBe(true);
    expect(search).not.toHaveBeenCalled();
  });
});
