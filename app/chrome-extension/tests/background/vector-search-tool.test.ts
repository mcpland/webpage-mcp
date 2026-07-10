import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  VECTOR_REBUILD_MAX_CONCURRENCY,
  VECTOR_REBUILD_MAX_TAB_SCAN,
  VECTOR_REBUILD_MAX_TABS,
  VECTOR_SEARCH_MAX_CONCURRENCY,
  VECTOR_SEARCH_MAX_OUTPUT_UTF8_BYTES,
  VECTOR_SEARCH_MAX_QUERY_UTF8_BYTES,
  VectorSearchTabsContentTool,
} from '@/entrypoints/background/tools/browser/vector-search';
import {
  measureJsonBytes,
  measureUtf8Bytes,
} from '@/entrypoints/background/tools/browser/bounded-tool-output';
import type { ContentIndexer } from '@/utils/content-indexer';
import type { SearchResult } from '@/utils/vector-database';

function createIndexer() {
  return {
    initialize: vi.fn(async () => undefined),
    isSemanticEngineReady: vi.fn(() => true),
    isSemanticEngineInitializing: vi.fn(() => false),
    searchContent: vi.fn(async () => [] as SearchResult[]),
    getStats: vi.fn(() => ({
      totalDocuments: 10,
      totalTabs: 3,
      indexedPages: 3,
      semanticEngineReady: true,
      semanticEngineInitializing: false,
    })),
    clearAllIndexes: vi.fn(async () => undefined),
    indexTabContent: vi.fn(async (_tabId: number) => undefined),
    removeTabIndex: vi.fn(async (_tabId: number) => undefined),
  };
}

function makeSearchResult(index: number, value: string): SearchResult {
  return {
    document: {
      id: String(index),
      tabId: index + 1,
      url: `https://example.com/${index}/${value}`,
      title: value,
      chunk: {
        text: value,
        source: value,
        index,
        wordCount: 1,
      },
      embedding: new Float32Array(),
      timestamp: index,
    },
    similarity: 1 - index / 1_000,
    distance: index / 1_000,
  };
}

beforeEach(() => {
  vi.mocked(chrome.tabs.query).mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VectorSearchTabsContentTool resource bounds', () => {
  it('rejects oversized queries and bounds result fields and total output', async () => {
    const indexer = createIndexer();
    const tool = new VectorSearchTabsContentTool(
      indexer as unknown as ContentIndexer,
    );

    const oversized = await tool.execute({
      query: 'q'.repeat(VECTOR_SEARCH_MAX_QUERY_UTF8_BYTES + 1),
    });
    expect(oversized.isError).toBe(true);
    expect(indexer.searchContent).not.toHaveBeenCalled();

    const huge = 'x'.repeat(50_000);
    indexer.searchContent.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) =>
        makeSearchResult(index, huge),
      ),
    );
    const result = await tool.execute({ query: 'bounded query' });
    const text = String((result.content[0] as { text?: string })?.text || '');
    const payload = JSON.parse(text);

    expect(result.isError).toBe(false);
    expect(indexer.searchContent).toHaveBeenCalledWith('bounded query', 50);
    expect(payload.matchedTabs.length).toBeLessThanOrEqual(10);
    expect(payload.truncated).toBe(true);
    expect(measureUtf8Bytes(text)).toBeLessThanOrEqual(
      VECTOR_SEARCH_MAX_OUTPUT_UTF8_BYTES,
    );
    for (const matched of payload.matchedTabs) {
      expect(measureJsonBytes(matched.url)).toBeLessThanOrEqual(8 * 1024);
      expect(measureJsonBytes(matched.title)).toBeLessThanOrEqual(4 * 1024);
      expect(measureJsonBytes(matched.matchedSnippets[0])).toBeLessThanOrEqual(
        8 * 1024,
      );
    }
  });

  it('explicitly indexes only bounded, unique HTTP tabs before searching', async () => {
    const indexer = createIndexer();
    let activeIndexes = 0;
    let peakIndexes = 0;
    indexer.indexTabContent.mockImplementation(async (tabId) => {
      activeIndexes += 1;
      peakIndexes = Math.max(peakIndexes, activeIndexes);
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (tabId % 17 === 0) throw new Error('simulated tab failure');
      } finally {
        activeIndexes -= 1;
      }
    });
    indexer.searchContent.mockImplementation(async () => {
      expect(activeIndexes).toBe(0);
      expect(indexer.indexTabContent).toHaveBeenCalledTimes(
        VECTOR_REBUILD_MAX_TABS,
      );
      return [];
    });

    const tabs = [
      { id: 1, index: 0, windowId: 1, url: 'chrome://settings' },
      { id: 2, index: 1, windowId: 1, url: 'https://example.test/two' },
      { id: 2, index: 2, windowId: 1, url: 'https://duplicate.test' },
      { id: 3, index: 3, windowId: 1, url: 'http://example.test/three' },
      { id: 4, index: 4, windowId: 1, url: 'relative/path' },
      { id: 5, index: 5, windowId: 1, url: 'javascript:alert(1)' },
      ...Array.from({ length: VECTOR_REBUILD_MAX_TABS + 20 }, (_, index) => ({
        id: index + 10,
        index: index + 6,
        windowId: 1,
        url: `https://example.test/${index}`,
      })),
    ] as chrome.tabs.Tab[];
    vi.mocked(chrome.tabs.query).mockResolvedValue(tabs);
    const tool = new VectorSearchTabsContentTool(
      indexer as unknown as ContentIndexer,
    );

    const result = await tool.execute({ query: 'explicit search' });

    expect(result.isError).toBe(false);
    const indexedTabIds = indexer.indexTabContent.mock.calls.map(([tabId]) =>
      Number(tabId),
    );
    expect(indexedTabIds).toHaveLength(VECTOR_REBUILD_MAX_TABS);
    expect(new Set(indexedTabIds).size).toBe(VECTOR_REBUILD_MAX_TABS);
    expect(indexedTabIds).toContain(2);
    expect(indexedTabIds).toContain(3);
    expect(indexedTabIds).not.toContain(1);
    expect(indexedTabIds).not.toContain(4);
    expect(indexedTabIds).not.toContain(5);
    expect(peakIndexes).toBeGreaterThan(1);
    expect(peakIndexes).toBeLessThanOrEqual(VECTOR_REBUILD_MAX_CONCURRENCY);
    expect(indexer.searchContent).toHaveBeenCalledAfter(
      indexer.indexTabContent,
    );
  });

  it('does not scan past the explicit-search tab budget', async () => {
    const indexer = createIndexer();
    vi.mocked(chrome.tabs.query).mockResolvedValue(
      Array.from({ length: VECTOR_REBUILD_MAX_TAB_SCAN + 100 }, (_, index) => ({
        id: index + 1,
        index,
        windowId: 1,
        url:
          index < VECTOR_REBUILD_MAX_TAB_SCAN
            ? `chrome://settings/${index}`
            : `https://example.test/${index}`,
      })) as chrome.tabs.Tab[],
    );
    const tool = new VectorSearchTabsContentTool(
      indexer as unknown as ContentIndexer,
    );

    const result = await tool.execute({ query: 'bounded scan' });

    expect(result.isError).toBe(false);
    expect(indexer.indexTabContent).not.toHaveBeenCalled();
    expect(indexer.searchContent).toHaveBeenCalledOnce();
  });

  it('fails closed when the explicit tab inventory cannot be read', async () => {
    const indexer = createIndexer();
    vi.mocked(chrome.tabs.query).mockRejectedValue(
      new Error('tab inventory unavailable'),
    );
    const tool = new VectorSearchTabsContentTool(
      indexer as unknown as ContentIndexer,
    );

    const result = await tool.execute({ query: 'inventory failure' });

    expect(result.isError).toBe(true);
    expect(indexer.indexTabContent).not.toHaveBeenCalled();
    expect(indexer.searchContent).not.toHaveBeenCalled();
  });

  it('limits search concurrency and runs one bounded rebuild exclusively', async () => {
    const indexer = createIndexer();
    const pendingSearches: Array<(results: SearchResult[]) => void> = [];
    indexer.searchContent.mockImplementation(
      () =>
        new Promise<SearchResult[]>((resolve) => {
          pendingSearches.push(resolve);
        }),
    );
    let activeIndexes = 0;
    let peakIndexes = 0;
    indexer.indexTabContent.mockImplementation(async () => {
      activeIndexes += 1;
      peakIndexes = Math.max(peakIndexes, activeIndexes);
      await new Promise((resolve) => setTimeout(resolve, 0));
      activeIndexes -= 1;
    });
    vi.mocked(chrome.tabs.query).mockResolvedValue(
      Array.from({ length: VECTOR_REBUILD_MAX_TABS + 100 }, (_, index) => ({
        id: index + 1,
        index,
        windowId: 1,
        url: `https://example.com/${index}`,
      })) as chrome.tabs.Tab[],
    );
    const tool = new VectorSearchTabsContentTool(
      indexer as unknown as ContentIndexer,
    );

    const first = tool.execute({ query: 'first' });
    const second = tool.execute({ query: 'second' });
    await vi.waitFor(() =>
      expect(indexer.searchContent).toHaveBeenCalledTimes(
        VECTOR_SEARCH_MAX_CONCURRENCY,
      ),
    );
    const rejected = await tool.execute({ query: 'third' });
    expect(rejected.isError).toBe(true);

    const rebuild = tool.rebuildIndex();
    const duplicateRebuild = tool.rebuildIndex();
    expect(duplicateRebuild).toBe(rebuild);
    expect(indexer.clearAllIndexes).not.toHaveBeenCalled();
    const duringRebuild = await tool.execute({ query: 'during rebuild' });
    expect(duringRebuild.isError).toBe(true);

    for (const resolve of pendingSearches) resolve([]);
    await Promise.all([first, second, rebuild]);

    expect(indexer.clearAllIndexes).toHaveBeenCalledTimes(1);
    expect(indexer.indexTabContent).toHaveBeenCalledTimes(
      VECTOR_REBUILD_MAX_TABS * 2,
    );
    expect(peakIndexes).toBeGreaterThan(1);
    expect(peakIndexes).toBeLessThanOrEqual(VECTOR_REBUILD_MAX_CONCURRENCY);
  });

  it('does not scan beyond the rebuild tab budget', async () => {
    const indexer = createIndexer();
    vi.mocked(chrome.tabs.query).mockResolvedValue(
      Array.from({ length: VECTOR_REBUILD_MAX_TAB_SCAN + 100 }, (_, index) => ({
        id: index + 1,
        index,
        windowId: 1,
        url:
          index < VECTOR_REBUILD_MAX_TAB_SCAN
            ? `chrome://settings/${index}`
            : `https://example.com/${index}`,
      })) as chrome.tabs.Tab[],
    );
    const tool = new VectorSearchTabsContentTool(
      indexer as unknown as ContentIndexer,
    );

    await tool.rebuildIndex();

    expect(indexer.indexTabContent).not.toHaveBeenCalled();
    expect(indexer.clearAllIndexes).toHaveBeenCalledTimes(1);
  });
});
