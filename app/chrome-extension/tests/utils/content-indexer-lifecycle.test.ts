import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  addDocument: vi.fn(),
  chunkText: vi.fn(),
  clearAllVectorData: vi.fn(),
  clearVectorDatabase: vi.fn(),
  getEmbedding: vi.fn(),
  getGlobalVectorDatabase: vi.fn(),
  initializeEngine: vi.fn(),
  initializeVectorDatabase: vi.fn(),
  removeTabDocuments: vi.fn(),
}));

vi.mock('@/utils/text-chunker', () => ({
  TextChunker: class {
    chunkText = mocks.chunkText;
  },
}));

vi.mock('@/utils/semantic-similarity-engine', () => ({
  PREDEFINED_MODELS: {
    'multilingual-e5-small': {
      modelIdentifier: 'test-model',
      dimension: 3,
    },
  },
  SemanticSimilarityEngine: class {},
  SemanticSimilarityEngineProxy: class {
    isInitialized = true;
    initialize = mocks.initializeEngine;
    getEmbedding = mocks.getEmbedding;
  },
}));

vi.mock('@/utils/vector-database', () => ({
  VectorDatabase: class {},
  clearAllVectorData: mocks.clearAllVectorData,
  getGlobalVectorDatabase: mocks.getGlobalVectorDatabase,
}));

interface TestPage {
  title: string;
  url: string;
}

describe('ContentIndexer tab/page lifecycle', () => {
  const pagesByTab = new Map<number, TestPage>();
  const vectorDatabase = {
    addDocument: mocks.addDocument,
    clear: mocks.clearVectorDatabase,
    getStats: vi.fn(() => ({ totalDocuments: 0, totalTabs: 0, indexSize: 0 })),
    initialize: mocks.initializeVectorDatabase,
    removeTabDocuments: mocks.removeTabDocuments,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    pagesByTab.clear();

    mocks.addDocument.mockResolvedValue(1);
    mocks.chunkText.mockReturnValue([
      { text: 'page content', source: 'content', index: 0, wordCount: 2 },
    ]);
    mocks.clearAllVectorData.mockResolvedValue(undefined);
    mocks.clearVectorDatabase.mockResolvedValue(undefined);
    mocks.getEmbedding.mockResolvedValue(new Float32Array([1, 0, 0]));
    mocks.getGlobalVectorDatabase.mockResolvedValue(vectorDatabase);
    mocks.initializeEngine.mockResolvedValue(undefined);
    mocks.initializeVectorDatabase.mockResolvedValue(undefined);
    mocks.removeTabDocuments.mockResolvedValue(undefined);

    chrome.storage.local.get = vi.fn().mockResolvedValue({});
    chrome.storage.local.remove = vi.fn().mockResolvedValue(undefined);
    chrome.tabs.get = vi.fn(async (tabId: number) => {
      const page = pagesByTab.get(tabId);
      if (!page) throw new Error(`No tab with id ${tabId}`);
      return { id: tabId, ...page } as chrome.tabs.Tab;
    });
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({
      success: true,
      textContent: 'page content',
      title: 'Extracted title',
    });
    chrome.scripting = {
      ...chrome.scripting,
      executeScript: vi.fn().mockResolvedValue([]),
    } as typeof chrome.scripting;
  });

  async function createIndexer() {
    const { ContentIndexer } = await import('@/utils/content-indexer');
    const indexer = new ContentIndexer({ autoIndex: false });
    await indexer.initialize();
    return indexer;
  }

  it('indexes identical URL/title pages independently in different tabs', async () => {
    pagesByTab.set(1, { url: 'https://example.test/page', title: 'Same page' });
    pagesByTab.set(2, { url: 'https://example.test/page', title: 'Same page' });
    const indexer = await createIndexer();

    await indexer.indexTabContent(1);
    await indexer.indexTabContent(2);

    expect(mocks.addDocument.mock.calls.map(([tabId]) => tabId)).toEqual([1, 2]);
    expect(indexer.getStats().indexedPages).toBe(2);
  });

  it('allows the same page to be indexed after its old tab closes and it reopens', async () => {
    const page = { url: 'https://example.test/reopen', title: 'Reopen me' };
    pagesByTab.set(10, page);
    const indexer = await createIndexer();

    await indexer.indexTabContent(10);
    await indexer.removeTabIndex(10);
    pagesByTab.delete(10);
    pagesByTab.set(11, page);
    await indexer.indexTabContent(11);

    expect(mocks.removeTabDocuments).toHaveBeenCalledWith(10);
    expect(mocks.addDocument.mock.calls.map(([tabId]) => tabId)).toEqual([10, 11]);
    expect(indexer.getStats().indexedPages).toBe(1);
  });

  it('reindexes A after an A to B to A navigation sequence in one tab', async () => {
    const indexer = await createIndexer();

    pagesByTab.set(20, { url: 'https://example.test/a', title: 'Page A' });
    await indexer.indexTabContent(20);
    await indexer.removeTabIndex(20);

    pagesByTab.set(20, { url: 'https://example.test/b', title: 'Page B' });
    await indexer.indexTabContent(20);
    await indexer.removeTabIndex(20);

    pagesByTab.set(20, { url: 'https://example.test/a', title: 'Page A' });
    await indexer.indexTabContent(20);

    expect(mocks.addDocument).toHaveBeenCalledTimes(3);
    expect(mocks.removeTabDocuments).toHaveBeenCalledTimes(2);
    expect(indexer.getStats().indexedPages).toBe(1);
  });

  it('registers tab and navigation listeners only once across reinitialization', async () => {
    const indexer = await createIndexer();

    await indexer.reinitialize();

    expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalledOnce();
    expect(chrome.tabs.onRemoved.addListener).toHaveBeenCalledOnce();
    expect(chrome.webNavigation.onCommitted.addListener).toHaveBeenCalledOnce();
  });
});
