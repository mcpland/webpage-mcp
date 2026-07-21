import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addDocument: vi.fn(),
  addTabPage: vi.fn(),
  chunkText: vi.fn(),
  clearAllVectorData: vi.fn(),
  clearVectorDatabase: vi.fn(),
  compactVectorIndex: vi.fn(),
  commitTabPage: vi.fn(),
  getEmbedding: vi.fn(),
  getGlobalVectorDatabase: vi.fn(),
  ensureTabDocumentsRemoved: vi.fn(),
  engineConfigs: [] as unknown[],
  completedPagesByTab: new Map<
    number,
    {
      tabId: number;
      pageKey: string;
      url: string;
      title: string;
      expectedCount: number;
    }
  >(),
  inspectTabPageCompletion: vi.fn(),
  inspectTabPageState: vi.fn(),
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
    "multilingual-e5-base": {
      modelIdentifier: "test-base-model",
      dimension: 6,
    },
  },
  SemanticSimilarityEngine: class {},
  SemanticSimilarityEngineProxy: class {
    isInitialized = true;
    initialize = mocks.initializeEngine;
    getEmbedding = mocks.getEmbedding;

    constructor(config: unknown) {
      mocks.engineConfigs.push(config);
    }
  },
}));

vi.mock("@/utils/vector-database", () => ({
  VectorDatabase: class {},
  VectorCompactionRequiredError: class VectorCompactionRequiredError extends Error {
    constructor(
      readonly physicalCount: number,
      readonly maxElements: number,
    ) {
      super("vector compaction required");
      this.name = "VectorCompactionRequiredError";
    }
  },
  clearAllVectorData: mocks.clearAllVectorData,
  getGlobalVectorDatabase: mocks.getGlobalVectorDatabase,
  resetGlobalVectorDatabase: mocks.resetGlobalVectorDatabase,
}));

interface TestPage {
  title: string;
  url: string;
}

const TAB_INVALIDATION_KEY = "semanticPendingTabInvalidations";
const MAINTENANCE_KEY = "semanticCleanupRequired";

function requiredMaintenanceMarker(
  attemptId = "interrupted-attempt",
  kind: "data-cleanup" | "index-recovery" | "index-rebuild" = "data-cleanup",
) {
  return {
    schemaVersion: 1,
    state: "required",
    attemptId,
    kind,
    startedAt: 100,
  };
}

function installLocalStorage(initial: Record<string, unknown> = {}) {
  const state: Record<string, unknown> = { ...initial };
  chrome.storage.local.get = vi.fn(async (keys?: unknown) => {
    if (keys == null) return { ...state };
    const names = Array.isArray(keys)
      ? keys
      : typeof keys === "string"
        ? [keys]
        : Object.keys((keys as Record<string, unknown>) ?? {});
    return Object.fromEntries(
      names
        .filter((name): name is string => typeof name === "string")
        .filter((name) => Object.prototype.hasOwnProperty.call(state, name))
        .map((name) => [name, state[name]]),
    );
  }) as typeof chrome.storage.local.get;
  chrome.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(state, items);
  });
  chrome.storage.local.remove = vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
  });
  return state;
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
    addTabPage: mocks.addTabPage,
    clear: mocks.clearVectorDatabase,
    compactForPendingAdd: mocks.compactVectorIndex,
    commitTabPage: mocks.commitTabPage,
    ensureTabDocumentsRemoved: mocks.ensureTabDocumentsRemoved,
    getStats: vi.fn(() => ({
      totalDocuments: mocks.completedPagesByTab.size,
      totalTabs: mocks.completedPagesByTab.size,
      completedPages: mocks.completedPagesByTab.size,
      indexSize: 0,
      isInitialized: true,
    })),
    initialize: mocks.initializeVectorDatabase,
    inspectTabPageCompletion: mocks.inspectTabPageCompletion,
    inspectTabPageState: mocks.inspectTabPageState,
    removeTabDocuments: mocks.removeTabDocuments,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    pagesByTab.clear();
    mocks.completedPagesByTab.clear();
    mocks.engineConfigs.length = 0;

    mocks.addDocument.mockResolvedValue(1);
    mocks.addTabPage.mockImplementation(
      async (
        tabId: number,
        url: string,
        title: string,
        inputs: Array<{ chunk: unknown; embedding: Float32Array }>,
      ) => {
        const labels: number[] = [];
        for (const { chunk, embedding } of inputs) {
          labels.push(
            await mocks.addDocument(tabId, url, title, chunk, embedding),
          );
        }
        await mocks.commitTabPage(tabId, url, title);
        return labels;
      },
    );
    mocks.chunkText.mockReturnValue([
      { text: "page content", source: "content", index: 0, wordCount: 2 },
    ]);
    mocks.clearAllVectorData.mockImplementation(async () => {
      mocks.completedPagesByTab.clear();
    });
    mocks.clearVectorDatabase.mockImplementation(async () => {
      mocks.completedPagesByTab.clear();
    });
    mocks.compactVectorIndex.mockResolvedValue({
      compacted: false,
      evictedTabIds: [],
      retainedCompletedPages: [],
    });
    mocks.commitTabPage.mockImplementation(
      async (tabId: number, url: string, title: string) => {
        mocks.completedPagesByTab.set(tabId, {
          tabId,
          pageKey: `${url}\u0000${title}`,
          url,
          title,
          expectedCount: 1,
        });
      },
    );
    mocks.getEmbedding.mockResolvedValue(new Float32Array([1, 0, 0]));
    mocks.getGlobalVectorDatabase.mockResolvedValue(vectorDatabase);
    mocks.ensureTabDocumentsRemoved.mockImplementation(
      async (tabId: number) => {
        mocks.completedPagesByTab.delete(tabId);
      },
    );
    mocks.initializeEngine.mockResolvedValue(undefined);
    mocks.initializeVectorDatabase.mockResolvedValue(undefined);
    mocks.inspectTabPageState.mockResolvedValue({
      completedPages: [],
      repairTabIds: [],
    });
    mocks.inspectTabPageCompletion.mockImplementation(async (tabId: number) => {
      const page = mocks.completedPagesByTab.get(tabId);
      return page
        ? { state: "complete" as const, page: { ...page } }
        : { state: "absent" as const };
    });
    mocks.removeTabDocuments.mockResolvedValue(undefined);
    mocks.resetGlobalVectorDatabase.mockImplementation(async () => {
      mocks.completedPagesByTab.clear();
    });

    installLocalStorage();
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

  it("persists a cold tab invalidation without loading the model or vector database", async () => {
    const state = installLocalStorage();
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();

    indexer.handleTabInvalidationEvent(71);

    await vi.waitFor(() =>
      expect(state[TAB_INVALIDATION_KEY]).toEqual({
        schemaVersion: 1,
        revision: 1,
        mode: "tabs",
        entries: [[71, 1]],
      }),
    );
    expect(mocks.initializeEngine).not.toHaveBeenCalled();
    expect(mocks.getGlobalVectorDatabase).not.toHaveBeenCalled();
    expect(mocks.initializeVectorDatabase).not.toHaveBeenCalled();
    expect(mocks.ensureTabDocumentsRemoved).not.toHaveBeenCalled();
    expect(indexer.getStats().available).toBe(false);
  });

  it("persists a cold invalidation without applying HNSW while maintenance is required", async () => {
    const state = installLocalStorage({
      [MAINTENANCE_KEY]: requiredMaintenanceMarker(),
    });
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();

    indexer.handleTabInvalidationEvent(91);

    await vi.waitFor(() =>
      expect(state[TAB_INVALIDATION_KEY]).toMatchObject({
        entries: [[91, 1]],
      }),
    );
    expect(state[MAINTENANCE_KEY]).toEqual(requiredMaintenanceMarker());
    expect(mocks.initializeEngine).not.toHaveBeenCalled();
    expect(mocks.getGlobalVectorDatabase).not.toHaveBeenCalled();
    expect(mocks.ensureTabDocumentsRemoved).not.toHaveBeenCalled();
    expect(indexer.getStats().available).toBe(false);
  });

  it("retries a transient cold journal write without poisoning later work", async () => {
    const state = installLocalStorage();
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(
      new Error("transient storage failure"),
    );
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();

    indexer.handleTabInvalidationEvent(81);

    await vi.waitFor(() =>
      expect(state[TAB_INVALIDATION_KEY]).toMatchObject({
        entries: [[81, 1]],
      }),
    );
    expect(chrome.storage.local.set).toHaveBeenCalledTimes(2);
    expect(mocks.getGlobalVectorDatabase).not.toHaveBeenCalled();

    await indexer.initialize();
    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledWith(81);
    expect(state).not.toHaveProperty(TAB_INVALIDATION_KEY);
  });

  it("recovers a cold fail-closed writer when a later event persists every pending tab", async () => {
    const state = installLocalStorage();
    vi.mocked(chrome.storage.local.set)
      .mockRejectedValueOnce(new Error("first storage failure"))
      .mockRejectedValueOnce(new Error("retry storage failure"));
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();

    indexer.handleTabInvalidationEvent(82);
    const blockedMaintenance = indexer.runExclusiveIndexMaintenance(
      async () => undefined,
    );
    await expect(blockedMaintenance).rejects.toThrow(
      "tab invalidation is still unsafe",
    );
    expect(state).not.toHaveProperty(TAB_INVALIDATION_KEY);

    indexer.handleTabInvalidationEvent(83);
    await vi.waitFor(() =>
      expect(state[TAB_INVALIDATION_KEY]).toMatchObject({
        entries: [
          [82, 2],
          [83, 1],
        ],
      }),
    );

    await indexer.initialize();
    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledWith(82);
    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledWith(83);
    expect(state).not.toHaveProperty(TAB_INVALIDATION_KEY);
    expect(indexer.getStats().available).toBe(true);
  });

  it("drains and acknowledges a persisted invalidation before restart hydration", async () => {
    const state = installLocalStorage({
      [TAB_INVALIDATION_KEY]: {
        schemaVersion: 1,
        revision: 3,
        mode: "tabs",
        entries: [[72, 3]],
      },
    });
    mocks.inspectTabPageState.mockResolvedValue({
      completedPages: [],
      repairTabIds: [],
    });

    const indexer = await createIndexer();

    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledWith(72);
    expect(state).not.toHaveProperty(TAB_INVALIDATION_KEY);
    expect(
      mocks.ensureTabDocumentsRemoved.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.inspectTabPageState.mock.invocationCallOrder[0]);
    expect(indexer.getStats()).toMatchObject({
      available: true,
      indexedPages: 0,
      isInitialized: true,
    });
  });

  it("keeps a newer same-tab generation when an older deletion finishes", async () => {
    const state = installLocalStorage();
    const indexer = await createIndexer();
    const firstRemoval = deferred();
    const secondRemoval = deferred();
    mocks.ensureTabDocumentsRemoved
      .mockReturnValueOnce(firstRemoval.promise)
      .mockReturnValueOnce(secondRemoval.promise);

    indexer.handleTabInvalidationEvent(73);
    await vi.waitFor(() =>
      expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledTimes(1),
    );
    indexer.handleTabInvalidationEvent(73);
    await vi.waitFor(() =>
      expect(state[TAB_INVALIDATION_KEY]).toMatchObject({
        revision: 2,
        entries: [[73, 2]],
      }),
    );

    firstRemoval.resolve();
    await vi.waitFor(() =>
      expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledTimes(2),
    );
    expect(state[TAB_INVALIDATION_KEY]).toMatchObject({
      entries: [[73, 2]],
    });

    secondRemoval.resolve();
    await vi.waitFor(() =>
      expect(state).not.toHaveProperty(TAB_INVALIDATION_KEY),
    );
    await vi.waitFor(() => expect(indexer.getStats().available).toBe(true));
  });

  it("retains the durable marker and fails closed when tab deletion fails", async () => {
    const state = installLocalStorage({
      [TAB_INVALIDATION_KEY]: {
        schemaVersion: 1,
        revision: 1,
        mode: "tabs",
        entries: [[74, 1]],
      },
    });
    mocks.ensureTabDocumentsRemoved.mockRejectedValueOnce(
      new Error("tab deletion failed"),
    );
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();

    await expect(indexer.initialize()).rejects.toThrow("tab deletion failed");

    expect(state).toHaveProperty(TAB_INVALIDATION_KEY);
    expect(mocks.inspectTabPageState).not.toHaveBeenCalled();
    expect(indexer.getStats().available).toBe(false);
    await expect(indexer.searchContent("unsafe")).rejects.toThrow(
      "tab invalidation is still unsafe",
    );
    expect(mocks.getEmbedding).not.toHaveBeenCalled();
  });

  it("retains the marker and fails closed when its acknowledgement fails", async () => {
    const state = installLocalStorage({
      [TAB_INVALIDATION_KEY]: {
        schemaVersion: 1,
        revision: 1,
        mode: "tabs",
        entries: [[75, 1]],
      },
    });
    vi.mocked(chrome.storage.local.remove).mockRejectedValueOnce(
      new Error("journal remove failed"),
    );
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();

    await expect(indexer.initialize()).rejects.toThrow("journal remove failed");

    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledWith(75);
    expect(state).toHaveProperty(TAB_INVALIDATION_KEY);
    expect(mocks.inspectTabPageState).not.toHaveBeenCalled();
    expect(indexer.getStats().available).toBe(false);
  });

  it("rejects malformed journals before search, extraction, or hydration", async () => {
    installLocalStorage({
      [TAB_INVALIDATION_KEY]: {
        schemaVersion: 99,
        revision: 1,
        mode: "tabs",
        entries: [[76, 1]],
      },
    });
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();

    await expect(indexer.initialize()).rejects.toThrow(
      "invalidation journal metadata is invalid",
    );
    await expect(indexer.indexTabContent(76)).rejects.toThrow(
      "tab invalidation is still unsafe",
    );
    expect(mocks.ensureTabDocumentsRemoved).not.toHaveBeenCalled();
    expect(mocks.inspectTabPageState).not.toHaveBeenCalled();
    expect(mocks.getEmbedding).not.toHaveBeenCalled();
    expect(chrome.tabs.get).not.toHaveBeenCalled();
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("hydrates a completed page after restart and skips same-page extraction", async () => {
    const completedPage = {
      tabId: 12,
      pageKey: "https://example.test/restored\u0000Restored",
      url: "https://example.test/restored",
      title: "Restored",
      expectedCount: 2,
    };
    mocks.inspectTabPageState.mockResolvedValue({
      completedPages: [completedPage],
      repairTabIds: [],
    });
    mocks.completedPagesByTab.set(completedPage.tabId, completedPage);
    pagesByTab.set(12, {
      url: "https://example.test/restored",
      title: "Restored",
    });

    const indexer = await createIndexer();
    expect(indexer.getStats()).toMatchObject({
      indexedPages: 1,
      isInitialized: true,
    });

    await indexer.indexTabContent(12);

    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(mocks.addDocument).not.toHaveBeenCalled();
    expect(mocks.commitTabPage).not.toHaveBeenCalled();
  });

  it("revalidates a cached duplicate and reindexes when durable completion is absent", async () => {
    pagesByTab.set(14, {
      url: "https://example.test/stale-cache",
      title: "Stale cache",
    });
    const indexer = await createIndexer();
    await indexer.indexTabContent(14);
    expect(indexer.getStats().indexedPages).toBe(1);

    // Simulate an independent whole-page eviction. The ContentIndexer cache is
    // intentionally left stale; VectorDatabase remains the source of truth.
    mocks.completedPagesByTab.delete(14);
    expect(indexer.getStats()).toMatchObject({
      indexedPages: 0,
      totalDocuments: 0,
      totalTabs: 0,
    });

    await indexer.indexTabContent(14);

    expect(mocks.inspectTabPageCompletion).toHaveBeenCalledTimes(2);
    expect(mocks.addDocument).toHaveBeenCalledTimes(2);
    expect(mocks.commitTabPage).toHaveBeenCalledTimes(2);
    expect(indexer.getStats().indexedPages).toBe(1);
  });

  it("repairs a stale duplicate before reindexing when durable page state is incomplete", async () => {
    pagesByTab.set(15, {
      url: "https://example.test/repair-cache",
      title: "Repair cache",
    });
    const indexer = await createIndexer();
    await indexer.indexTabContent(15);
    mocks.inspectTabPageCompletion.mockResolvedValueOnce({
      state: "repair-required",
      reason: "incomplete",
    });

    await indexer.indexTabContent(15);

    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledWith(15);
    expect(
      mocks.ensureTabDocumentsRemoved.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.addDocument.mock.invocationCallOrder[1]);
    expect(mocks.addDocument).toHaveBeenCalledTimes(2);
    expect(mocks.commitTabPage).toHaveBeenCalledTimes(2);
  });

  it("hydrates a missing cache entry from exact durable completion before duplicate skip", async () => {
    const page = {
      tabId: 16,
      pageKey: "https://example.test/durable-only\u0000Durable only",
      url: "https://example.test/durable-only",
      title: "Durable only",
      expectedCount: 2,
    };
    mocks.completedPagesByTab.set(page.tabId, page);
    pagesByTab.set(page.tabId, { url: page.url, title: page.title });
    const indexer = await createIndexer();

    await indexer.indexTabContent(page.tabId);

    expect(mocks.inspectTabPageCompletion).toHaveBeenCalledWith(page.tabId);
    expect(mocks.addDocument).not.toHaveBeenCalled();
    expect(mocks.commitTabPage).not.toHaveBeenCalled();
    expect(indexer.getStats().indexedPages).toBe(1);
  });

  it("keeps failed repair pending, redacts stats, and retries before duplicate inspection", async () => {
    pagesByTab.set(17, {
      url: "https://example.test/repair-retry",
      title: "Repair retry",
    });
    const indexer = await createIndexer();
    await indexer.indexTabContent(17);
    mocks.inspectTabPageCompletion.mockResolvedValueOnce({
      state: "repair-required",
      reason: "expired",
    });
    mocks.ensureTabDocumentsRemoved.mockRejectedValueOnce(
      new Error("expired repair failed"),
    );

    await expect(indexer.indexTabContent(17)).rejects.toThrow(
      "expired repair failed",
    );
    expect(indexer.getStats()).toMatchObject({ available: false });

    await expect(indexer.indexTabContent(17)).resolves.toBeUndefined();
    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledTimes(2);
    expect(mocks.addDocument).toHaveBeenCalledTimes(2);
    expect(indexer.getStats()).toMatchObject({
      available: true,
      indexedPages: 1,
    });
  });

  it("releases every shared lease before durable compaction, refreshes cache, and retries once", async () => {
    const retainedPage = {
      tabId: 41,
      pageKey: "https://example.test/retained\u0000Retained",
      url: "https://example.test/retained",
      title: "Retained",
      expectedCount: 1,
    };
    const evictedPage = {
      tabId: 40,
      pageKey: "https://example.test/evicted\u0000Evicted",
      url: "https://example.test/evicted",
      title: "Evicted",
      expectedCount: 1,
    };
    mocks.completedPagesByTab.set(40, evictedPage);
    mocks.completedPagesByTab.set(41, retainedPage);
    mocks.inspectTabPageState.mockResolvedValue({
      completedPages: [evictedPage, retainedPage],
      repairTabIds: [],
    });
    pagesByTab.set(18, {
      url: "https://example.test/capacity-retry",
      title: "Capacity retry",
    });
    const { VectorCompactionRequiredError } =
      await import("@/utils/vector-database");
    mocks.addDocument
      .mockRejectedValueOnce(new VectorCompactionRequiredError(2, 2))
      .mockResolvedValueOnce(3);
    const state = installLocalStorage();
    mocks.compactVectorIndex.mockImplementationOnce(async () => {
      expect(state[MAINTENANCE_KEY]).toMatchObject({
        state: "required",
        kind: "index-rebuild",
        attemptId: expect.any(String),
      });
      mocks.completedPagesByTab.delete(40);
      return {
        compacted: true,
        evictedTabIds: [40],
        retainedCompletedPages: [retainedPage],
      };
    });
    const indexer = await createIndexer();
    const blocker = deferred();
    const blockerEntered = vi.fn();
    const activeLease = indexer.runWithIndexActivity(async () => {
      blockerEntered();
      await blocker.promise;
    });
    await vi.waitFor(() => expect(blockerEntered).toHaveBeenCalledOnce());

    const indexing = indexer.indexTabContent(18);
    await vi.waitFor(() => expect(mocks.addDocument).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(state[MAINTENANCE_KEY]).toMatchObject({
        state: "required",
        kind: "index-rebuild",
      }),
    );
    expect(mocks.compactVectorIndex).not.toHaveBeenCalled();

    blocker.resolve();
    await activeLease;
    await indexing;

    expect(mocks.compactVectorIndex).toHaveBeenCalledOnce();
    expect(mocks.addDocument).toHaveBeenCalledTimes(2);
    expect(state[MAINTENANCE_KEY]).toMatchObject({ state: "clear" });
    const cache = (
      indexer as unknown as { indexedPageByTab: Map<number, string> }
    ).indexedPageByTab;
    expect([...cache.keys()].sort((left, right) => left - right)).toEqual([
      18, 41,
    ]);
  });

  it("clears the rebuild marker before surfacing a safely rolled-back compaction failure", async () => {
    pagesByTab.set(19, {
      url: "https://example.test/safe-rollback",
      title: "Safe rollback",
    });
    const { VectorCompactionRequiredError } =
      await import("@/utils/vector-database");
    mocks.addDocument.mockRejectedValueOnce(
      new VectorCompactionRequiredError(2, 2),
    );
    mocks.compactVectorIndex.mockResolvedValueOnce({
      compacted: false,
      evictedTabIds: [],
      retainedCompletedPages: [],
      failure: new Error("candidate mappings failed but rollback succeeded"),
    });
    const state = installLocalStorage();
    const indexer = await createIndexer();

    await expect(indexer.indexTabContent(19)).rejects.toThrow(
      "rollback succeeded",
    );

    expect(mocks.addDocument).toHaveBeenCalledOnce();
    expect(state[MAINTENANCE_KEY]).toMatchObject({ state: "clear" });
  });

  it("keeps the rebuild marker required when compaction persistence is unsafe", async () => {
    pagesByTab.set(20, {
      url: "https://example.test/unsafe-compaction",
      title: "Unsafe compaction",
    });
    const { VectorCompactionRequiredError } =
      await import("@/utils/vector-database");
    mocks.addDocument.mockRejectedValueOnce(
      new VectorCompactionRequiredError(2, 2),
    );
    mocks.compactVectorIndex.mockRejectedValueOnce(
      new Error("candidate index persistence outcome unknown"),
    );
    const state = installLocalStorage();
    const indexer = await createIndexer();

    await expect(indexer.indexTabContent(20)).rejects.toThrow(
      "outcome unknown",
    );

    expect(state[MAINTENANCE_KEY]).toMatchObject({
      state: "required",
      kind: "index-rebuild",
    });
  });

  it("does not guess how to resume an interrupted compaction marker", async () => {
    const state = installLocalStorage({
      [MAINTENANCE_KEY]: requiredMaintenanceMarker(
        "interrupted-compaction",
        "index-rebuild",
      ),
    });
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();

    await expect(
      indexer.runExclusiveIndexRebuild((activity) =>
        activity.compactVectorIndex(),
      ),
    ).rejects.toThrow("cannot be resumed safely");

    expect(mocks.compactVectorIndex).not.toHaveBeenCalled();
    expect(state[MAINTENANCE_KEY]).toMatchObject({
      state: "required",
      kind: "index-rebuild",
    });
  });

  it("does not resurrect a page invalidated during the hydration window", async () => {
    installLocalStorage();
    const completedPage = {
      tabId: 77,
      pageKey: "https://example.test/window\u0000Window",
      url: "https://example.test/window",
      title: "Window",
      expectedCount: 1,
    };
    const hydrationInspection = deferred<{
      completedPages: (typeof completedPage)[];
      repairTabIds: number[];
    }>();
    mocks.inspectTabPageState
      .mockResolvedValueOnce({
        completedPages: [completedPage],
        repairTabIds: [],
      })
      .mockReturnValueOnce(hydrationInspection.promise);
    const eventRemoval = deferred();
    mocks.ensureTabDocumentsRemoved.mockReturnValueOnce(eventRemoval.promise);
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();

    const initialization = indexer.initialize();
    await vi.waitFor(() =>
      expect(mocks.inspectTabPageState).toHaveBeenCalledTimes(2),
    );
    indexer.handleTabInvalidationEvent(77);
    hydrationInspection.resolve({
      completedPages: [completedPage],
      repairTabIds: [],
    });
    await expect(initialization).rejects.toThrow(
      "tab invalidation was requested",
    );

    const retry = indexer.initialize();
    await vi.waitFor(() =>
      expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledWith(77),
    );
    eventRemoval.resolve();
    await retry;
    await vi.waitFor(() => expect(indexer.getStats().available).toBe(true));
    expect(indexer.getStats().indexedPages).toBe(0);
  });

  it("durably removes a restored page before indexing and committing its replacement", async () => {
    const completedPage = {
      tabId: 13,
      pageKey: "https://example.test/old\u0000Old",
      url: "https://example.test/old",
      title: "Old",
      expectedCount: 1,
    };
    mocks.inspectTabPageState.mockResolvedValue({
      completedPages: [completedPage],
      repairTabIds: [],
    });
    mocks.completedPagesByTab.set(completedPage.tabId, completedPage);
    pagesByTab.set(13, {
      url: "https://example.test/new",
      title: "New",
    });
    const indexer = await createIndexer();

    await indexer.indexTabContent(13);

    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledWith(13);
    expect(mocks.addDocument).toHaveBeenCalledWith(
      13,
      "https://example.test/new",
      "New",
      expect.any(Object),
      expect.any(Float32Array),
    );
    expect(mocks.commitTabPage).toHaveBeenCalledWith(
      13,
      "https://example.test/new",
      "New",
    );
    expect(
      mocks.ensureTabDocumentsRemoved.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.addDocument.mock.invocationCallOrder[0]);
    expect(mocks.addDocument.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.commitTabPage.mock.invocationCallOrder[0],
    );
    expect(indexer.getStats().indexedPages).toBe(1);
  });

  it("repairs incomplete persisted tabs before publishing restart state", async () => {
    mocks.inspectTabPageState
      .mockResolvedValueOnce({ completedPages: [], repairTabIds: [21] })
      .mockResolvedValueOnce({ completedPages: [], repairTabIds: [] });

    const indexer = await createIndexer();

    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledOnce();
    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledWith(21);
    expect(mocks.inspectTabPageState).toHaveBeenCalledTimes(2);
    expect(indexer.getStats()).toMatchObject({
      indexedPages: 0,
      isInitialized: true,
    });
  });

  it("keeps hydration empty when repair fails and retries the pending tab on initialization", async () => {
    const completedPage = {
      tabId: 22,
      pageKey: "https://example.test/good\u0000Good",
      url: "https://example.test/good",
      title: "Good",
      expectedCount: 1,
    };
    mocks.inspectTabPageState
      .mockResolvedValueOnce({
        completedPages: [completedPage],
        repairTabIds: [23],
      })
      .mockResolvedValueOnce({
        completedPages: [completedPage],
        // The first failed attempt may have persisted the deletion but failed
        // its readback. The in-memory pending set must still force the retry.
        repairTabIds: [],
      })
      .mockResolvedValueOnce({
        completedPages: [completedPage],
        repairTabIds: [],
      });
    mocks.completedPagesByTab.set(completedPage.tabId, completedPage);
    mocks.ensureTabDocumentsRemoved
      .mockRejectedValueOnce(new Error("repair failed"))
      .mockResolvedValueOnce(undefined);
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();

    await expect(indexer.initialize()).rejects.toThrow("repair failed");
    expect(indexer.getStats()).toMatchObject({
      available: false,
      indexedPages: 1,
      isInitialized: false,
    });

    await expect(indexer.initialize()).resolves.toBeUndefined();
    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledTimes(2);
    expect(indexer.getStats()).toMatchObject({
      indexedPages: 1,
      isInitialized: true,
    });
  });

  it("redacts stats when the vector database reports an unsafe initialized state", async () => {
    const indexer = await createIndexer();
    vectorDatabase.getStats.mockReturnValueOnce({
      totalDocuments: 4,
      totalTabs: 2,
      completedPages: 2,
      indexSize: 100,
      isInitialized: false,
    });

    expect(indexer.getStats()).toMatchObject({
      available: false,
      isInitialized: false,
      totalDocuments: 4,
    });
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
    expect(mocks.addTabPage).toHaveBeenCalledOnce();
    expect(mocks.addTabPage).toHaveBeenCalledWith(
      4,
      "https://example.test/embedding-retry",
      "Embedding retry",
      [
        expect.objectContaining({
          chunk: expect.objectContaining({ index: 0 }),
          embedding: expect.any(Float32Array),
        }),
        expect.objectContaining({
          chunk: expect.objectContaining({ index: 1 }),
          embedding: expect.any(Float32Array),
        }),
      ],
    );
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

  it("removes every chunk when the durable page completion commit fails", async () => {
    pagesByTab.set(51, {
      url: "https://example.test/commit-retry",
      title: "Commit retry",
    });
    mocks.chunkText.mockReturnValue([
      { text: "first", source: "content", index: 0, wordCount: 1 },
      { text: "second", source: "content", index: 1, wordCount: 1 },
    ]);
    mocks.commitTabPage.mockRejectedValueOnce(
      new Error("completion persistence failed"),
    );
    const indexer = await createIndexer();

    await expect(indexer.indexTabContent(51)).rejects.toThrow(
      "completion persistence failed",
    );

    expect(mocks.addDocument).toHaveBeenCalledTimes(2);
    expect(mocks.commitTabPage).toHaveBeenCalledOnce();
    expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledWith(51);
    expect(indexer.getStats().indexedPages).toBe(0);

    await expect(indexer.indexTabContent(51)).resolves.toBeUndefined();
    expect(mocks.addDocument).toHaveBeenCalledTimes(4);
    expect(mocks.commitTabPage).toHaveBeenCalledTimes(2);
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
    const state = installLocalStorage();
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
    await vi.waitFor(() =>
      expect(state[MAINTENANCE_KEY]).toMatchObject({
        state: "required",
        kind: "data-cleanup",
      }),
    );
    initialization.resolve();
    await initialize;
    await cleanup;

    expect(cleanupStarted).toBe(true);
    expect(mocks.clearAllVectorData).toHaveBeenCalledOnce();
  });

  it("rechecks the maintenance gate after an asynchronous marker read", async () => {
    const state = installLocalStorage();
    const markerRead = deferred<Record<string, unknown>>();
    const storageGet = vi.mocked(chrome.storage.local.get);
    const defaultGet = storageGet.getMockImplementation()! as (
      keys?: unknown,
    ) => Promise<Record<string, unknown>>;
    storageGet
      .mockImplementationOnce(() => markerRead.promise)
      .mockImplementation(defaultGet);
    const cleanupHold = deferred();
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();

    const initialize = indexer.initialize();
    await vi.waitFor(() => expect(storageGet).toHaveBeenCalledOnce());
    const cleanup = indexer.runExclusiveDataCleanup(
      async () => cleanupHold.promise,
    );
    await vi.waitFor(() =>
      expect(state[MAINTENANCE_KEY]).toMatchObject({
        state: "required",
        kind: "data-cleanup",
      }),
    );

    markerRead.resolve({});
    await expect(initialize).rejects.toThrow(
      "last cleanup or reinitialization did not complete",
    );
    expect(mocks.initializeEngine).not.toHaveBeenCalled();

    cleanupHold.resolve();
    await cleanup;
  });

  it("waits for every shared activity before applying a live tab invalidation", async () => {
    const state = installLocalStorage();
    const indexer = await createIndexer();
    const firstHold = deferred();
    const secondHold = deferred();
    const entered = vi.fn();
    const firstActivity = indexer.runWithIndexActivity(async () => {
      entered("first");
      await firstHold.promise;
    });
    const secondActivity = indexer.runWithIndexActivity(async () => {
      entered("second");
      await secondHold.promise;
    });
    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(2));

    indexer.handleTabInvalidationEvent(80);
    await vi.waitFor(() => expect(state).toHaveProperty(TAB_INVALIDATION_KEY));
    expect(mocks.ensureTabDocumentsRemoved).not.toHaveBeenCalled();

    firstHold.resolve();
    await firstActivity;
    expect(mocks.ensureTabDocumentsRemoved).not.toHaveBeenCalled();

    secondHold.resolve();
    await secondActivity;
    await vi.waitFor(() =>
      expect(mocks.ensureTabDocumentsRemoved).toHaveBeenCalledWith(80),
    );
    await vi.waitFor(() =>
      expect(state).not.toHaveProperty(TAB_INVALIDATION_KEY),
    );
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
    const state = installLocalStorage();
    const { initContentIndexerLifecycleListeners } =
      await import("@/utils/content-indexer");
    initContentIndexerLifecycleListeners();
    initContentIndexerLifecycleListeners();
    const indexer = await createIndexer({ autoIndex: true });

    await indexer.reinitialize();

    expect(mocks.resetGlobalVectorDatabase).toHaveBeenCalledOnce();
    expect(mocks.clearAllVectorData).not.toHaveBeenCalled();
    expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalledOnce();
    expect(chrome.tabs.onRemoved.addListener).toHaveBeenCalledOnce();
    expect(chrome.webNavigation.onCommitted.addListener).toHaveBeenCalledOnce();

    const navigationListener = vi.mocked(
      chrome.webNavigation.onCommitted.addListener,
    ).mock.calls[0][0];
    const removedListener = vi.mocked(chrome.tabs.onRemoved.addListener).mock
      .calls[0][0];
    navigationListener({
      tabId: 78,
      frameId: 2,
    } as Parameters<typeof navigationListener>[0]);
    await Promise.resolve();
    expect(state).not.toHaveProperty(TAB_INVALIDATION_KEY);

    navigationListener({
      tabId: 78,
      frameId: 0,
    } as Parameters<typeof navigationListener>[0]);
    removedListener(79, { windowId: 1, isWindowClosing: false });
    await vi.waitFor(() =>
      expect(state[TAB_INVALIDATION_KEY]).toMatchObject({
        entries: [
          [78, 1],
          [79, expect.any(Number)],
        ],
      }),
    );
    expect(mocks.getGlobalVectorDatabase).toHaveBeenCalledTimes(2);
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

  it("blocks every shared operation in a fresh worker when durable maintenance is required", async () => {
    installLocalStorage({
      [MAINTENANCE_KEY]: requiredMaintenanceMarker(),
    });
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();

    await expect(indexer.initialize()).rejects.toThrow(
      "last cleanup or reinitialization did not complete",
    );
    await expect(indexer.indexTabContent(92)).rejects.toThrow(
      "last cleanup or reinitialization did not complete",
    );
    await expect(indexer.searchContent("blocked")).rejects.toThrow(
      "last cleanup or reinitialization did not complete",
    );
    await expect(indexer.removeTabIndex(92)).rejects.toThrow(
      "last cleanup or reinitialization did not complete",
    );
    await expect(
      indexer.runExclusiveIndexMaintenance(async () => undefined),
    ).rejects.toThrow("last cleanup or reinitialization did not complete");
    await expect(indexer.getVerifiedStats()).resolves.toMatchObject({
      available: false,
    });

    expect(mocks.initializeEngine).not.toHaveBeenCalled();
    expect(mocks.getGlobalVectorDatabase).not.toHaveBeenCalled();
    expect(mocks.initializeVectorDatabase).not.toHaveBeenCalled();
    expect(mocks.getEmbedding).not.toHaveBeenCalled();
    expect(chrome.tabs.get).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "malformed",
      install: () =>
        installLocalStorage({
          [MAINTENANCE_KEY]: {
            schemaVersion: 99,
            state: "clear",
            attemptId: "future",
            completedAt: 100,
          },
        }),
    },
    {
      label: "unreadable",
      install: () => {
        installLocalStorage();
        chrome.storage.local.get = vi
          .fn()
          .mockRejectedValue(new Error("maintenance marker read failed"));
      },
    },
  ])(
    "fails closed before loading the engine when the durable marker is $label",
    async ({ install }) => {
      install();
      const { ContentIndexer } = await import("@/utils/content-indexer");
      const indexer = new ContentIndexer();

      await expect(indexer.initialize()).rejects.toThrow(
        "last cleanup or reinitialization did not complete",
      );
      await expect(indexer.getVerifiedStats()).resolves.toMatchObject({
        available: false,
      });
      expect(mocks.initializeEngine).not.toHaveBeenCalled();
      expect(mocks.getGlobalVectorDatabase).not.toHaveBeenCalled();
    },
  );

  it("allows privacy cleanup to replace an interrupted marker and clears it only after success", async () => {
    const state = installLocalStorage({
      [MAINTENANCE_KEY]: requiredMaintenanceMarker(),
    });
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();
    const observedMarker = vi.fn();

    await indexer.runExclusiveDataCleanup(async (activity) => {
      observedMarker(state[MAINTENANCE_KEY]);
      await activity.clearAllIndexes();
    });

    expect(observedMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "required",
        kind: "data-cleanup",
        attemptId: expect.not.stringMatching(/^interrupted-attempt$/),
      }),
    );
    expect(state[MAINTENANCE_KEY]).toMatchObject({
      schemaVersion: 1,
      state: "clear",
      attemptId: expect.any(String),
      completedAt: expect.any(Number),
    });
    await expect(indexer.initialize()).resolves.toBeUndefined();
  });

  it("does not run a destructive callback when the required marker cannot be armed", async () => {
    const state = installLocalStorage();
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(
      new Error("marker arm failed"),
    );
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();
    const destructive = vi.fn(async () => undefined);

    await expect(indexer.runExclusiveDataCleanup(destructive)).rejects.toThrow(
      "marker arm failed",
    );

    expect(destructive).not.toHaveBeenCalled();
    expect(mocks.clearAllVectorData).not.toHaveBeenCalled();
    expect(state).not.toHaveProperty(MAINTENANCE_KEY);
    await expect(indexer.getVerifiedStats()).resolves.toMatchObject({
      available: false,
    });
  });

  it("keeps the marker and stats blocked when the final clear write fails", async () => {
    const state = installLocalStorage();
    const storageSet = vi.mocked(chrome.storage.local.set);
    const defaultSet = storageSet.getMockImplementation()!;
    storageSet
      .mockImplementationOnce(defaultSet)
      .mockRejectedValueOnce(new Error("marker clear failed"));
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();
    const destructive = vi.fn(async () => undefined);

    await expect(indexer.runExclusiveDataCleanup(destructive)).rejects.toThrow(
      "marker clear failed",
    );

    expect(destructive).toHaveBeenCalledOnce();
    expect(state[MAINTENANCE_KEY]).toMatchObject({
      state: "required",
      kind: "data-cleanup",
    });
    expect(indexer.getStats().available).toBe(false);
    await expect(indexer.getVerifiedStats()).resolves.toMatchObject({
      available: false,
    });
  });

  it("keeps the marker required for the whole in-flight cleanup and clears it after late success", async () => {
    const state = installLocalStorage();
    const hold = deferred();
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();

    const cleanup = indexer.runExclusiveDataCleanup(async () => hold.promise);
    await vi.waitFor(() =>
      expect(state[MAINTENANCE_KEY]).toMatchObject({
        state: "required",
        kind: "data-cleanup",
      }),
    );
    expect(indexer.getStats().available).toBe(false);

    hold.resolve();
    await cleanup;
    expect(state[MAINTENANCE_KEY]).toMatchObject({ state: "clear" });
  });

  it("leaves a failed reinitialization required across instances and lets a new recovery retry clear it", async () => {
    const state = installLocalStorage();
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const first = new ContentIndexer();
    await first.initialize();
    mocks.resetGlobalVectorDatabase.mockRejectedValueOnce(
      new Error("restart reset failed"),
    );

    await expect(first.reinitialize()).rejects.toThrow("restart reset failed");
    expect(state[MAINTENANCE_KEY]).toMatchObject({
      state: "required",
      kind: "index-recovery",
    });

    const restarted = new ContentIndexer();
    const engineCalls = mocks.initializeEngine.mock.calls.length;
    await expect(restarted.initialize()).rejects.toThrow(
      "last cleanup or reinitialization did not complete",
    );
    expect(mocks.initializeEngine).toHaveBeenCalledTimes(engineCalls);

    await expect(restarted.reinitialize()).resolves.toBeUndefined();
    expect(state[MAINTENANCE_KEY]).toMatchObject({ state: "clear" });
    expect(restarted.getStats()).toMatchObject({
      available: true,
      isInitialized: true,
    });
  });

  it("does not let an index rebuild supersede a privacy-cleanup requirement", async () => {
    const original = requiredMaintenanceMarker("privacy-attempt");
    const state = installLocalStorage({ [MAINTENANCE_KEY]: original });
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();
    const rebuild = vi.fn(async () => undefined);

    await expect(indexer.runExclusiveIndexRebuild(rebuild)).rejects.toThrow(
      "last cleanup or reinitialization did not complete",
    );

    expect(rebuild).not.toHaveBeenCalled();
    expect(state[MAINTENANCE_KEY]).toEqual(original);
  });

  it("retries an index rebuild after a transient pre-arm marker read failure", async () => {
    const state = installLocalStorage();
    const storageGet = vi.mocked(chrome.storage.local.get);
    const defaultGet = storageGet.getMockImplementation()!;
    storageGet
      .mockRejectedValueOnce(new Error("transient marker read failure"))
      .mockImplementation(defaultGet);
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();
    const rebuild = vi.fn(async () => undefined);

    await expect(indexer.runExclusiveIndexRebuild(rebuild)).rejects.toThrow(
      "last cleanup or reinitialization did not complete",
    );
    expect(rebuild).not.toHaveBeenCalled();
    expect(state).not.toHaveProperty(MAINTENANCE_KEY);

    await expect(
      indexer.runExclusiveIndexRebuild(rebuild),
    ).resolves.toBeUndefined();
    expect(rebuild).toHaveBeenCalledOnce();
    expect(state[MAINTENANCE_KEY]).toMatchObject({ state: "clear" });
  });

  it("persists a failed index rebuild across workers and lets only a rebuild retry clear it", async () => {
    const state = installLocalStorage();
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const first = new ContentIndexer();

    await expect(
      first.runExclusiveIndexRebuild(async () => {
        throw new Error("rebuild interrupted");
      }),
    ).rejects.toThrow("rebuild interrupted");
    expect(state[MAINTENANCE_KEY]).toMatchObject({
      state: "required",
      kind: "index-rebuild",
    });

    const restarted = new ContentIndexer();
    await expect(restarted.initialize()).rejects.toThrow(
      "last cleanup or reinitialization did not complete",
    );
    const retry = vi.fn(async () => undefined);
    await expect(
      restarted.runExclusiveIndexRebuild(retry),
    ).resolves.toBeUndefined();
    expect(retry).toHaveBeenCalledOnce();
    expect(state[MAINTENANCE_KEY]).toMatchObject({ state: "clear" });
  });

  it("arms a model transition before its callback and passes an exact model without rereading selection storage", async () => {
    const state = installLocalStorage({
      selectedModel: "multilingual-e5-small",
      selectedVersion: "quantized",
    });
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();
    const observedAttempt = vi.fn();

    await indexer.runExclusiveModelTransition(async (transition) => {
      observedAttempt(transition.attemptId, transition.recoveryRequired);
      expect(state[MAINTENANCE_KEY]).toMatchObject({
        state: "required",
        kind: "index-recovery",
        attemptId: transition.attemptId,
      });
      await transition.initializeForModel({
        modelPreset: "multilingual-e5-base",
        modelVersion: "quantized",
        modelDimension: 6,
      });
    });

    expect(observedAttempt).toHaveBeenCalledWith(expect.any(String), false);
    expect(mocks.engineConfigs).toContainEqual({
      modelPreset: "multilingual-e5-base",
      modelVersion: "quantized",
      dimension: 6,
    });
    expect(mocks.getGlobalVectorDatabase).toHaveBeenLastCalledWith({
      dimension: 6,
      efSearch: 50,
    });
    expect(
      vi
        .mocked(chrome.storage.local.get)
        .mock.calls.some(
          ([keys]) =>
            Array.isArray(keys) &&
            (keys.includes("selectedModel") ||
              keys.includes("selectedVersion")),
        ),
    ).toBe(false);
    expect(state[MAINTENANCE_KEY]).toMatchObject({ state: "clear" });
  });

  it("captures an interrupted marker at the queue head and forces model recovery", async () => {
    const state = installLocalStorage({
      [MAINTENANCE_KEY]: requiredMaintenanceMarker(
        "interrupted-model",
        "index-recovery",
      ),
    });
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();
    const observedRecovery = vi.fn();

    await indexer.runExclusiveModelTransition(async (transition) => {
      observedRecovery(transition.recoveryRequired);
      await transition.reinitializeForModel({
        modelPreset: "multilingual-e5-small",
        modelVersion: "quantized",
        modelDimension: 3,
      });
    });

    expect(observedRecovery).toHaveBeenCalledWith(true);
    expect(mocks.resetGlobalVectorDatabase).toHaveBeenCalledOnce();
    expect(state[MAINTENANCE_KEY]).toMatchObject({ state: "clear" });
  });

  it("waits for shared work before starting model-side effects while the marker is already required", async () => {
    const state = installLocalStorage();
    const sharedHold = deferred();
    const sharedStarted = deferred();
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();
    const shared = indexer.runWithIndexActivity(async () => {
      sharedStarted.resolve();
      await sharedHold.promise;
    });
    await sharedStarted.promise;
    const transitionCallback = vi.fn(async () => undefined);

    const transition = indexer.runExclusiveModelTransition(transitionCallback);
    await vi.waitFor(() =>
      expect(state[MAINTENANCE_KEY]).toMatchObject({
        state: "required",
        kind: "index-recovery",
      }),
    );
    expect(transitionCallback).not.toHaveBeenCalled();

    sharedHold.resolve();
    await shared;
    await transition;
    expect(transitionCallback).toHaveBeenCalledOnce();
  });

  it("propagates selected-model storage failures instead of silently initializing the default dimension", async () => {
    installLocalStorage();
    const storageGet = vi.mocked(chrome.storage.local.get);
    const defaultGet = storageGet.getMockImplementation()! as (
      keys?: unknown,
    ) => Promise<Record<string, unknown>>;
    storageGet.mockImplementation(async (keys?: unknown) => {
      if (
        Array.isArray(keys) &&
        (keys.includes("selectedModel") || keys.includes("selectedVersion"))
      ) {
        throw new Error("selected model storage unavailable");
      }
      return defaultGet(keys);
    });
    const { ContentIndexer } = await import("@/utils/content-indexer");
    const indexer = new ContentIndexer();

    await expect(indexer.initialize()).rejects.toThrow(
      "selected model storage unavailable",
    );
    expect(mocks.initializeEngine).not.toHaveBeenCalled();
    expect(mocks.getGlobalVectorDatabase).not.toHaveBeenCalled();
  });
});
