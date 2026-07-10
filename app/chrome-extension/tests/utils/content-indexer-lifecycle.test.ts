import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addDocument: vi.fn(),
  chunkText: vi.fn(),
  clearAllVectorData: vi.fn(),
  clearVectorDatabase: vi.fn(),
  getEmbedding: vi.fn(),
  getGlobalVectorDatabase: vi.fn(),
  ensureTabDocumentsRemoved: vi.fn(),
  initializeEngine: vi.fn(),
  initializeVectorDatabase: vi.fn(),
  removeTabDocuments: vi.fn(),
  resetGlobalVectorDatabase: vi.fn(),
}));

vi.mock("@/utils/text-chunker", () => ({
  TextChunker: class {
    chunkText = mocks.chunkText;
  },
}));

vi.mock("@/utils/semantic-similarity-engine", () => ({
  PREDEFINED_MODELS: {
    "multilingual-e5-small": {
      modelIdentifier: "test-model",
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

vi.mock("@/utils/vector-database", () => ({
  VectorDatabase: class {},
  clearAllVectorData: mocks.clearAllVectorData,
  getGlobalVectorDatabase: mocks.getGlobalVectorDatabase,
  resetGlobalVectorDatabase: mocks.resetGlobalVectorDatabase,
}));

interface TestPage {
  title: string;
  url: string;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("ContentIndexer tab/page lifecycle", () => {
  const pagesByTab = new Map<number, TestPage>();
  const vectorDatabase = {
    addDocument: mocks.addDocument,
    clear: mocks.clearVectorDatabase,
    ensureTabDocumentsRemoved: mocks.ensureTabDocumentsRemoved,
    getStats: vi.fn(() => ({ totalDocuments: 0, totalTabs: 0, indexSize: 0 })),
    initialize: mocks.initializeVectorDatabase,
    removeTabDocuments: mocks.removeTabDocuments,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    pagesByTab.clear();

    mocks.addDocument.mockResolvedValue(1);
    mocks.chunkText.mockReturnValue([
      { text: "page content", source: "content", index: 0, wordCount: 2 },
    ]);
    mocks.clearAllVectorData.mockResolvedValue(undefined);
    mocks.clearVectorDatabase.mockResolvedValue(undefined);
    mocks.getEmbedding.mockResolvedValue(new Float32Array([1, 0, 0]));
    mocks.getGlobalVectorDatabase.mockResolvedValue(vectorDatabase);
    mocks.ensureTabDocumentsRemoved.mockResolvedValue(undefined);
    mocks.initializeEngine.mockResolvedValue(undefined);
    mocks.initializeVectorDatabase.mockResolvedValue(undefined);
    mocks.removeTabDocuments.mockResolvedValue(undefined);
    mocks.resetGlobalVectorDatabase.mockResolvedValue(undefined);

    chrome.storage.local.get = vi.fn().mockResolvedValue({});
    chrome.storage.local.remove = vi.fn().mockResolvedValue(undefined);
    chrome.tabs.get = vi.fn(async (tabId: number) => {
      const page = pagesByTab.get(tabId);
      if (!page) throw new Error(`No tab with id ${tabId}`);
      return { id: tabId, ...page } as chrome.tabs.Tab;
    });
    chrome.tabs.sendMessage = vi.fn().mockResolvedValue({
      success: true,
      textContent: "page content",
      title: "Extracted title",
    });
    chrome.scripting = {
      ...chrome.scripting,
      executeScript: vi.fn().mockResolvedValue([]),
    } as typeof chrome.scripting;
  });

  async function createIndexer(options?: { autoIndex?: boolean }) {
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer(options);
    await indexer.initialize();
    return indexer;
  }

  it("does not register a completed-load indexing listener by default", async () => {
    await createIndexer();

    expect(chrome.tabs.onUpdated.addListener).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("rechecks the live tab URL and never extracts non-HTTP content", async () => {
    pagesByTab.set(30, {
      url: "data:text/html,private",
      title: "Non-public page",
    });
    const indexer = await createIndexer();

    await indexer.indexTabContent(30);

    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(mocks.addDocument).not.toHaveBeenCalled();
  });

  it("indexes identical URL/title pages independently in different tabs", async () => {
    pagesByTab.set(1, { url: "https://example.test/page", title: "Same page" });
    pagesByTab.set(2, { url: "https://example.test/page", title: "Same page" });
    const indexer = await createIndexer();

    await indexer.indexTabContent(1);
    await indexer.indexTabContent(2);

    expect(mocks.addDocument.mock.calls.map(([tabId]) => tabId)).toEqual([
      1, 2,
    ]);
    expect(indexer.getStats().indexedPages).toBe(2);
  });

  it("does not mark a page indexed when it produces no chunks", async () => {
    pagesByTab.set(3, { url: "https://example.test/empty", title: "Empty" });
    mocks.chunkText.mockReturnValueOnce([]);
    const indexer = await createIndexer();

    await indexer.indexTabContent(3);

    expect(mocks.addDocument).not.toHaveBeenCalled();
    expect(mocks.ensureTabDocumentsRemoved).not.toHaveBeenCalled();
    expect(indexer.getStats().indexedPages).toBe(0);
  });

  it("removes partial chunks, propagates an embedding failure, and can retry", async () => {
    pagesByTab.set(4, {
      url: "https://example.test/embedding-retry",
      title: "Embedding retry",
    });
    mocks.chunkText.mockReturnValue([
      { text: "first", source: "content", index: 0, wordCount: 1 },
      { text: "second", source: "content", index: 1, wordCount: 1 },
    ]);
    mocks.getEmbedding.mockRejectedValueOnce(new Error("embedding failed"));
    const indexer = await createIndexer();

    await expect(indexer.indexTabContent(4)).rejects.toThrow(
      "embedding failed",
    );

    expect(mocks.addDocument).not.toHaveBeenCalled();
    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledOnce();
    expect(indexer.getStats().indexedPages).toBe(0);

    await expect(indexer.indexTabContent(4)).resolves.toBeUndefined();
    expect(mocks.addDocument).toHaveBeenCalledTimes(2);
    expect(indexer.getStats().indexedPages).toBe(1);
  });

  it("removes an earlier successful chunk when a later add fails and can retry", async () => {
    pagesByTab.set(5, {
      url: "https://example.test/add-retry",
      title: "Add retry",
    });
    mocks.chunkText.mockReturnValue([
      { text: "first", source: "content", index: 0, wordCount: 1 },
      { text: "second", source: "content", index: 1, wordCount: 1 },
    ]);
    mocks.addDocument
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error("second add failed"));
    const indexer = await createIndexer();

    await expect(indexer.indexTabContent(5)).rejects.toThrow(
      "second add failed",
    );

    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledOnce();
    expect(indexer.getStats().indexedPages).toBe(0);

    await expect(indexer.indexTabContent(5)).resolves.toBeUndefined();
    expect(mocks.addDocument).toHaveBeenCalledTimes(4);
    expect(indexer.getStats().indexedPages).toBe(1);
  });

  it("aggregates a chunk failure with failure to remove the partial page", async () => {
    pagesByTab.set(6, {
      url: "https://example.test/cleanup-failure",
      title: "Cleanup failure",
    });
    mocks.chunkText.mockReturnValue([
      { text: "first", source: "content", index: 0, wordCount: 1 },
      { text: "second", source: "content", index: 1, wordCount: 1 },
    ]);
    mocks.addDocument
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error("second add failed"));
    mocks.ensureTabDocumentsRemoved.mockRejectedValueOnce(
      new Error("partial cleanup failed"),
    );
    const indexer = await createIndexer();

    await expect(indexer.indexTabContent(6)).rejects.toThrow(
      "remove partial chunks",
    );
    expect(indexer.getStats().indexedPages).toBe(0);

    mocks.chunkText.mockReturnValueOnce([]);
    await expect(indexer.indexTabContent(6)).resolves.toBeUndefined();
    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledTimes(2);
    expect(mocks.addDocument).toHaveBeenCalledTimes(2);
    expect(indexer.getStats().indexedPages).toBe(0);

    await expect(indexer.indexTabContent(6)).resolves.toBeUndefined();
    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledTimes(2);
    expect(mocks.addDocument).toHaveBeenCalledTimes(4);
    expect(indexer.getStats().indexedPages).toBe(1);
  });

  it("keeps the old page until a replacement has non-empty chunks", async () => {
    pagesByTab.set(7, { url: "https://example.test/old", title: "Old" });
    const indexer = await createIndexer();
    await indexer.indexTabContent(7);
    pagesByTab.set(7, { url: "https://example.test/new", title: "New" });
    mocks.chunkText.mockReturnValueOnce([]);

    await indexer.indexTabContent(7);

    expect(mocks.ensureTabDocumentsRemoved).not.toHaveBeenCalled();
    expect(indexer.getStats().indexedPages).toBe(1);

    await indexer.indexTabContent(7);
    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledWith(7);
    expect(mocks.addDocument).toHaveBeenCalledTimes(2);
    expect(indexer.getStats().indexedPages).toBe(1);
  });

  it("allows the same page to be indexed after its old tab closes and it reopens", async () => {
    const page = { url: "https://example.test/reopen", title: "Reopen me" };
    pagesByTab.set(10, page);
    const indexer = await createIndexer();

    await indexer.indexTabContent(10);
    await indexer.removeTabIndex(10);
    pagesByTab.delete(10);
    pagesByTab.set(11, page);
    await indexer.indexTabContent(11);

    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledWith(10);
    expect(mocks.addDocument.mock.calls.map(([tabId]) => tabId)).toEqual([
      10, 11,
    ]);
    expect(indexer.getStats().indexedPages).toBe(1);
  });

  it("reindexes A after an A to B to A navigation sequence in one tab", async () => {
    const indexer = await createIndexer();

    pagesByTab.set(20, { url: "https://example.test/a", title: "Page A" });
    await indexer.indexTabContent(20);
    await indexer.removeTabIndex(20);

    pagesByTab.set(20, { url: "https://example.test/b", title: "Page B" });
    await indexer.indexTabContent(20);
    await indexer.removeTabIndex(20);

    pagesByTab.set(20, { url: "https://example.test/a", title: "Page A" });
    await indexer.indexTabContent(20);

    expect(mocks.addDocument).toHaveBeenCalledTimes(3);
    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledTimes(2);
    expect(indexer.getStats().indexedPages).toBe(1);
  });

  it("allows an explicitly cleared page to be indexed again", async () => {
    pagesByTab.set(30, {
      url: "https://example.test/clear",
      title: "Clear me",
    });
    const indexer = await createIndexer();

    await indexer.indexTabContent(30);
    await indexer.clearAllIndexes();
    await indexer.indexTabContent(30);

    expect(mocks.clearAllVectorData).toHaveBeenCalledOnce();
    expect(mocks.addDocument).toHaveBeenCalledTimes(2);
    expect(indexer.getStats().indexedPages).toBe(1);
  });

  it("propagates persistent index cleanup failures and keeps the page cache retryable", async () => {
    pagesByTab.set(31, {
      url: "https://example.test/retry",
      title: "Retry me",
    });
    const indexer = await createIndexer();
    await indexer.indexTabContent(31);
    mocks.clearAllVectorData.mockRejectedValueOnce(
      new Error("persistent clear failed"),
    );

    await expect(indexer.clearAllIndexes()).rejects.toThrow(
      "persistent clear failed",
    );

    expect(indexer.getStats().indexedPages).toBe(1);
    await expect(indexer.clearAllIndexes()).resolves.toBeUndefined();
    expect(indexer.getStats().indexedPages).toBe(0);
  });

  it("clears persistent vector data from a fresh, uninitialized worker", async () => {
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();

    expect(indexer.getStats().available).toBe(false);
    await indexer.clearAllIndexes();

    expect(mocks.clearAllVectorData).toHaveBeenCalledOnce();
    expect(mocks.getGlobalVectorDatabase).not.toHaveBeenCalled();
    expect(indexer.getStats()).toMatchObject({
      available: true,
      indexedPages: 0,
      totalDocuments: 0,
    });
  });

  it("waits for in-flight initialization before starting exclusive cleanup", async () => {
    const initialization = deferred();
    mocks.initializeVectorDatabase.mockReturnValueOnce(initialization.promise);
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();

    const initialize = indexer.initialize();
    await vi.waitFor(() =>
      expect(mocks.initializeVectorDatabase).toHaveBeenCalledOnce(),
    );
    let cleanupStarted = false;
    const cleanup = indexer.runExclusiveDataCleanup(async (activity) => {
      cleanupStarted = true;
      await activity.clearAllIndexes();
    });

    await Promise.resolve();
    expect(cleanupStarted).toBe(false);
    initialization.resolve();
    await initialize;
    await cleanup;

    expect(cleanupStarted).toBe(true);
    expect(mocks.clearAllVectorData).toHaveBeenCalledOnce();
  });

  it("drains an in-flight addDocument before cleanup and blocks new indexing until cleanup ends", async () => {
    pagesByTab.set(40, {
      url: "https://example.test/in-flight",
      title: "In flight",
    });
    pagesByTab.set(41, { url: "https://example.test/queued", title: "Queued" });
    const firstAdd = deferred<number>();
    mocks.addDocument
      .mockReturnValueOnce(firstAdd.promise)
      .mockResolvedValue(2);
    const indexer = await createIndexer();

    const inFlightIndex = indexer.indexTabContent(40);
    await vi.waitFor(() => expect(mocks.addDocument).toHaveBeenCalledOnce());
    const cleanupHold = deferred();
    const cleanup = indexer.runExclusiveDataCleanup(async (activity) => {
      await activity.clearAllIndexes();
      await cleanupHold.promise;
    });
    const queuedIndex = indexer.indexTabContent(41);

    expect(mocks.clearAllVectorData).not.toHaveBeenCalled();
    expect(chrome.tabs.get).toHaveBeenCalledTimes(1);
    firstAdd.resolve(1);
    await inFlightIndex;
    await vi.waitFor(() =>
      expect(mocks.clearAllVectorData).toHaveBeenCalledOnce(),
    );
    expect(chrome.tabs.get).toHaveBeenCalledTimes(1);

    cleanupHold.resolve();
    await cleanup;
    await queuedIndex;
    expect(chrome.tabs.get).toHaveBeenCalledTimes(2);
    expect(mocks.addDocument).toHaveBeenCalledTimes(2);
  });

  it("rejects queued maintenance after cleanup failure and unblocks only after a successful retry", async () => {
    const cleanupFailure = deferred();
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();
    const cleanup = indexer.runExclusiveDataCleanup(
      async () => cleanupFailure.promise,
    );
    const rebuildMutation = vi.fn(async () => undefined);
    const queuedRebuild = indexer.runExclusiveIndexMaintenance(rebuildMutation);
    const cleanupRejection = expect(cleanup).rejects.toThrow("cleanup failed");

    cleanupFailure.reject(new Error("cleanup failed"));
    await cleanupRejection;
    await expect(queuedRebuild).rejects.toThrow(
      "last cleanup or reinitialization did not complete",
    );
    expect(rebuildMutation).not.toHaveBeenCalled();
    await expect(indexer.initialize()).rejects.toThrow(
      "last cleanup or reinitialization did not complete",
    );

    await indexer.runExclusiveDataCleanup(async (activity) =>
      activity.clearAllIndexes(),
    );
    await expect(indexer.initialize()).resolves.toBeUndefined();
  });

  it("coalesces concurrent privacy cleanup requests", async () => {
    const hold = deferred();
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();
    const firstOperation = vi.fn(async () => hold.promise);
    const secondOperation = vi.fn(async () => undefined);

    const first = indexer.runExclusiveDataCleanup(firstOperation);
    const second = indexer.runExclusiveDataCleanup(secondOperation);

    expect(second).toBe(first);
    await vi.waitFor(() => expect(firstOperation).toHaveBeenCalledOnce());
    expect(secondOperation).not.toHaveBeenCalled();
    hold.resolve();
    await first;
  });

  it("cancels an older activity waiting behind maintenance before privacy cleanup", async () => {
    const maintenanceHold = deferred();
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();
    const maintenance = indexer.runExclusiveIndexMaintenance(
      async () => maintenanceHold.promise,
    );
    const activityMutation = vi.fn(async () => undefined);
    const waitingActivity = indexer.runWithIndexActivity(activityMutation);

    const cleanup = indexer.runExclusiveDataCleanup(async (activity) => {
      await activity.clearAllIndexes();
    });

    await expect(waitingActivity).rejects.toThrow(
      "cancelled because data cleanup was requested",
    );
    expect(activityMutation).not.toHaveBeenCalled();
    maintenanceHold.resolve();
    await maintenance;
    await cleanup;
    expect(mocks.clearAllVectorData).toHaveBeenCalledOnce();
  });

  it("registers tab and navigation listeners only once across reinitialization", async () => {
    const indexer = await createIndexer({ autoIndex: true });

    await indexer.reinitialize();

    expect(mocks.resetGlobalVectorDatabase).toHaveBeenCalledOnce();
    expect(mocks.clearAllVectorData).not.toHaveBeenCalled();
    expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalledOnce();
    expect(chrome.tabs.onRemoved.addListener).toHaveBeenCalledOnce();
    expect(chrome.webNavigation.onCommitted.addListener).toHaveBeenCalledOnce();
  });

  it("stops reinitialization after a failed vector reset and remains retryable", async () => {
    pagesByTab.set(50, {
      url: "https://example.test/reinitialize",
      title: "Reinitialize",
    });
    const indexer = await createIndexer();
    await indexer.indexTabContent(50);
    const engineInitializations = mocks.initializeEngine.mock.calls.length;
    const vectorInitializations =
      mocks.initializeVectorDatabase.mock.calls.length;
    const databaseLookups = mocks.getGlobalVectorDatabase.mock.calls.length;
    const embeddingRequests = mocks.getEmbedding.mock.calls.length;
    mocks.resetGlobalVectorDatabase.mockRejectedValueOnce(
      new Error("vector reset failed"),
    );

    await expect(indexer.reinitialize()).rejects.toThrow("vector reset failed");

    expect(indexer.getStats().isInitialized).toBe(false);
    expect(indexer.getStats().indexedPages).toBe(1);
    await expect(indexer.initialize()).rejects.toThrow(
      "last cleanup or reinitialization did not complete",
    );
    await expect(indexer.searchContent("blocked search")).rejects.toThrow(
      "last cleanup or reinitialization did not complete",
    );
    expect(mocks.initializeEngine).toHaveBeenCalledTimes(engineInitializations);
    expect(mocks.initializeVectorDatabase).toHaveBeenCalledTimes(
      vectorInitializations,
    );
    expect(mocks.getGlobalVectorDatabase).toHaveBeenCalledTimes(
      databaseLookups,
    );
    expect(mocks.getEmbedding).toHaveBeenCalledTimes(embeddingRequests);

    await expect(indexer.reinitialize()).resolves.toBeUndefined();

    expect(mocks.resetGlobalVectorDatabase).toHaveBeenCalledTimes(2);
    expect(mocks.initializeEngine).toHaveBeenCalledTimes(
      engineInitializations + 1,
    );
    expect(mocks.initializeVectorDatabase).toHaveBeenCalledTimes(
      vectorInitializations + 1,
    );
    expect(mocks.getGlobalVectorDatabase).toHaveBeenCalledTimes(
      databaseLookups + 1,
    );
    expect(indexer.getStats()).toMatchObject({
      indexedPages: 0,
      isInitialized: true,
    });
  });
});
