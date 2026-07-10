/**
 * Content index manager
 * Responsible for explicitly extracting, chunking and indexing tab content
 */

import { TextChunker } from "./text-chunker";
import {
  VectorDatabase,
  getGlobalVectorDatabase,
  resetGlobalVectorDatabase,
  type SearchResult,
} from "./vector-database";
import {
  SemanticSimilarityEngine,
  SemanticSimilarityEngineProxy,
  PREDEFINED_MODELS,
} from "./semantic-similarity-engine";
import { getStoredSemanticModelSelection } from "./semantic-similarity-boundaries";
import { TOOL_MESSAGE_TYPES } from "@/common/message-types";

export interface IndexingOptions {
  autoIndex?: boolean;
  maxChunksPerPage?: number;
  skipDuplicates?: boolean;
}

export interface ContentIndexerStats {
  available: boolean;
  totalDocuments: number;
  totalTabs: number;
  indexSize: number;
  indexedPages: number;
  isInitialized: boolean;
  semanticEngineReady: boolean;
  semanticEngineInitializing: boolean;
}

export interface ContentIndexerActivity {
  initialize(): Promise<void>;
  indexTabContent(tabId: number): Promise<void>;
  searchContent(query: string, topK?: number): Promise<SearchResult[]>;
  removeTabIndex(tabId: number): Promise<void>;
  clearAllIndexes(): Promise<void>;
  getStats(): ContentIndexerStats;
  isSemanticEngineReady(): boolean;
  isSemanticEngineInitializing(): boolean;
}

export type ContentIndexerMaintenance = ContentIndexerActivity;

interface MaintenanceJob<T = unknown> {
  kind: "index" | "data-cleanup" | "index-recovery";
  operation: (activity: ContentIndexerMaintenance) => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export class ContentIndexer {
  private textChunker: TextChunker;
  private vectorDatabase!: VectorDatabase;
  private semanticEngine!:
    | SemanticSimilarityEngine
    | SemanticSimilarityEngineProxy;
  private isInitialized = false;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;
  /** Last successfully indexed page identity for each live tab. */
  private indexedPageByTab = new Map<number, string>();
  /** Tabs whose last partial write could not be durably removed. */
  private tabsRequiringDurableRemoval = new Set<number>();
  /** Serialize index/remove work per tab so navigation cannot race an in-flight index. */
  private tabIndexOperations = new Map<number, Promise<void>>();
  private tabEventListenersInitialized = false;
  private readonly options: Required<IndexingOptions>;
  private activeIndexActivities = 0;
  private maintenanceRequested = false;
  private maintenanceRunning = false;
  private readonly activityWaiters = new Set<() => void>();
  private readonly maintenanceQueue: MaintenanceJob[] = [];
  private failedDataCleanup: Error | null = null;
  private dataCleanupPromise: Promise<void> | null = null;
  private dataCleanupEpoch = 0;
  private persistentStatsKnownEmpty = false;

  constructor(options?: IndexingOptions) {
    this.options = {
      // Page text is private browsing data. Background indexing is opt-in so
      // constructing or initializing an indexer never starts collecting it.
      autoIndex: false,
      maxChunksPerPage: 50,
      skipDuplicates: true,
      ...options,
    };

    this.textChunker = new TextChunker();
  }

  /**
   * Hold a shared activity lease across a logical indexing/search operation.
   * Once maintenance is requested, no new lease can start until all queued
   * maintenance completes. Existing leases drain before maintenance begins.
   */
  public async runWithIndexActivity<T>(
    operation: (activity: ContentIndexerActivity) => Promise<T>,
  ): Promise<T> {
    const requestedCleanupEpoch = this.dataCleanupEpoch;
    await this.acquireIndexActivity(requestedCleanupEpoch);
    try {
      return await operation(this.createActivityFacade());
    } finally {
      this.releaseIndexActivity();
    }
  }

  /** Run an exclusive clear/rebuild operation after all shared activity drains. */
  public runExclusiveIndexMaintenance<T>(
    operation: (activity: ContentIndexerMaintenance) => Promise<T>,
  ): Promise<T> {
    if (this.failedDataCleanup)
      return Promise.reject(this.cleanupBlockedError());
    return this.enqueueMaintenance("index", operation);
  }

  /**
   * Run a fail-closed index rebuild. Unlike normal maintenance, a retry is
   * allowed after an earlier cleanup/rebuild failure so it can recover the
   * gate. Privacy cleanup remains an equivalent recovery path.
   */
  private runExclusiveIndexRecovery<T>(
    operation: (activity: ContentIndexerMaintenance) => Promise<T>,
  ): Promise<T> {
    return this.enqueueMaintenance("index-recovery", operation);
  }

  /**
   * Run privacy cleanup exclusively. Concurrent requests share the same work,
   * and a failed cleanup blocks all normal index activity until a retry succeeds.
   */
  public runExclusiveDataCleanup(
    operation: (activity: ContentIndexerMaintenance) => Promise<void>,
  ): Promise<void> {
    if (this.dataCleanupPromise) return this.dataCleanupPromise;

    this.dataCleanupEpoch += 1;
    // Cancel activities that were already waiting behind older maintenance;
    // otherwise they could wake after cleanup and silently recreate data.
    this.notifyActivityWaiters();
    const queued = this.enqueueMaintenance("data-cleanup", operation);
    const tracked = queued.finally(() => {
      if (this.dataCleanupPromise === tracked) this.dataCleanupPromise = null;
    });
    this.dataCleanupPromise = tracked;
    return tracked;
  }

  private async acquireIndexActivity(
    requestedCleanupEpoch: number,
  ): Promise<void> {
    while (true) {
      if (requestedCleanupEpoch !== this.dataCleanupEpoch) {
        throw new Error(
          "Semantic index activity was cancelled because data cleanup was requested",
        );
      }
      if (this.failedDataCleanup) throw this.cleanupBlockedError();
      if (!this.maintenanceRequested && !this.maintenanceRunning) {
        this.activeIndexActivities += 1;
        return;
      }
      await new Promise<void>((resolve) => this.activityWaiters.add(resolve));
    }
  }

  private releaseIndexActivity(): void {
    this.activeIndexActivities = Math.max(0, this.activeIndexActivities - 1);
    if (this.activeIndexActivities === 0) this.pumpMaintenanceQueue();
  }

  private enqueueMaintenance<T>(
    kind: MaintenanceJob<T>["kind"],
    operation: (activity: ContentIndexerMaintenance) => Promise<T>,
  ): Promise<T> {
    // Set synchronously so an activity scheduled later in this same event-loop
    // turn cannot slip in ahead of cleanup/rebuild.
    this.maintenanceRequested = true;
    const promise = new Promise<T>((resolve, reject) => {
      this.maintenanceQueue.push({
        kind,
        operation,
        resolve,
        reject,
      } as MaintenanceJob);
    });
    this.pumpMaintenanceQueue();
    return promise;
  }

  private pumpMaintenanceQueue(): void {
    if (this.maintenanceRunning || this.activeIndexActivities > 0) return;

    const job = this.maintenanceQueue.shift();
    if (!job) {
      this.maintenanceRequested = false;
      this.notifyActivityWaiters();
      return;
    }

    // A rebuild/reinitialize may have been queued while privacy cleanup was
    // still running. Re-check at execution time so a failed cleanup cannot be
    // followed by mutations that recreate data. Only privacy cleanup or an
    // explicit index-recovery retry may run while fail-closed.
    if (job.kind === "index" && this.failedDataCleanup) {
      job.reject(this.cleanupBlockedError());
      queueMicrotask(() => this.pumpMaintenanceQueue());
      return;
    }

    this.maintenanceRunning = true;
    let succeeded = false;
    let result: unknown;
    let failure: unknown;
    Promise.resolve()
      .then(() => job.operation(this.createActivityFacade()))
      .then(
        (value) => {
          if (job.kind !== "index") this.failedDataCleanup = null;
          succeeded = true;
          result = value;
        },
        (error) => {
          if (job.kind !== "index") {
            this.failedDataCleanup =
              error instanceof Error ? error : new Error(String(error));
          }
          failure = error;
        },
      )
      .finally(() => {
        this.maintenanceRunning = false;
        this.pumpMaintenanceQueue();
        if (succeeded) job.resolve(result);
        else job.reject(failure);
      });
  }

  private notifyActivityWaiters(): void {
    for (const resolve of this.activityWaiters) resolve();
    this.activityWaiters.clear();
  }

  private cleanupBlockedError(): Error {
    return new Error(
      "Semantic index access is blocked because the last cleanup or reinitialization did not complete. Retry Clear All Data or model reinitialization.",
      { cause: this.failedDataCleanup ?? undefined },
    );
  }

  private createActivityFacade(): ContentIndexerMaintenance {
    return {
      initialize: () => this.initializeInternal(),
      indexTabContent: (tabId) => this.indexTabContentInternal(tabId),
      searchContent: (query, topK) => this.searchContentInternal(query, topK),
      removeTabIndex: (tabId) => this.removeTabIndexInternal(tabId),
      clearAllIndexes: () => this.clearAllIndexesInternal(),
      getStats: () => this.getStats(),
      isSemanticEngineReady: () => this.isSemanticEngineReady(),
      isSemanticEngineInitializing: () => this.isSemanticEngineInitializing(),
    };
  }

  /**
   * Get current selected model configuration
   */
  private async getCurrentModelConfig() {
    try {
      const result = await chrome.storage.local.get([
        "selectedModel",
        "selectedVersion",
      ]);
      const selection = getStoredSemanticModelSelection(
        result.selectedModel,
        result.selectedVersion,
        PREDEFINED_MODELS,
        "multilingual-e5-small",
      );

      return {
        modelPreset: selection.modelPreset,
        dimension: selection.modelDimension,
        modelVersion: selection.modelVersion,
      };
    } catch (error) {
      console.error(
        "ContentIndexer: Failed to get current model config, using default:",
        error,
      );
      return {
        modelPreset: "multilingual-e5-small" as const,
        dimension: 384,
        modelVersion: "quantized" as const,
      };
    }
  }

  /**
   * Initialize content indexer
   */
  public initialize(): Promise<void> {
    return this.runWithIndexActivity((activity) => activity.initialize());
  }

  private async initializeInternal(): Promise<void> {
    if (this.isInitialized) return;
    if (this.isInitializing && this.initPromise) return this.initPromise;

    this.isInitializing = true;
    this.initPromise = this._doInitialize().finally(() => {
      this.isInitializing = false;
    });

    return this.initPromise;
  }

  private async _doInitialize(): Promise<void> {
    try {
      this.persistentStatsKnownEmpty = false;
      // Get current selected model configuration
      const engineConfig = await this.getCurrentModelConfig();

      // Use proxy class to reuse engine instance in offscreen
      this.semanticEngine = new SemanticSimilarityEngineProxy(engineConfig);
      await this.semanticEngine.initialize();

      this.vectorDatabase = await getGlobalVectorDatabase({
        dimension: engineConfig.dimension,
        efSearch: 50,
      });
      await this.vectorDatabase.initialize();

      this.setupTabEventListeners();

      this.isInitialized = true;
    } catch (error) {
      console.error("ContentIndexer: Initialization failed:", error);
      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * Index content of specified tab
   */
  public indexTabContent(tabId: number): Promise<void> {
    return this.runWithIndexActivity((activity) =>
      activity.indexTabContent(tabId),
    );
  }

  private async indexTabContentInternal(tabId: number): Promise<void> {
    // Check if semantic engine is ready before attempting to index
    if (!this.isSemanticEngineReady() && !this.isSemanticEngineInitializing()) {
      console.log(
        `ContentIndexer: Skipping tab ${tabId} - semantic engine not ready and not initializing`,
      );
      return;
    }

    if (!this.isInitialized) {
      // Only initialize if semantic engine is already ready
      if (!this.isSemanticEngineReady()) {
        console.log(
          `ContentIndexer: Skipping tab ${tabId} - ContentIndexer not initialized and semantic engine not ready`,
        );
        return;
      }
      await this.initializeInternal();
    }

    return this.runTabIndexOperation(tabId, async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.url || !this.shouldIndexUrl(tab.url)) {
          console.log(
            `ContentIndexer: Skipping tab ${tabId} - URL not indexable`,
          );
          return;
        }

        const pageKey = `${tab.url}\u0000${tab.title || ""}`;
        let indexedPageKey = this.indexedPageByTab.get(tabId);
        if (
          this.options.skipDuplicates &&
          indexedPageKey === pageKey &&
          !this.tabsRequiringDurableRemoval.has(tabId)
        ) {
          console.log(
            `ContentIndexer: Skipping tab ${tabId} - already indexed`,
          );
          return;
        }

        // Retry a failed partial-page removal before any later early return.
        // Otherwise a now-empty page (or a same-page duplicate) could leave
        // stale private chunks behind for the lifetime of this worker.
        if (this.tabsRequiringDurableRemoval.has(tabId)) {
          await this.vectorDatabase.ensureTabDocumentsRemoved(tabId);
          this.tabsRequiringDurableRemoval.delete(tabId);
          this.indexedPageByTab.delete(tabId);
          indexedPageKey = undefined;
        }

        console.log(
          `ContentIndexer: Starting to index tab ${tabId}: ${tab.title}`,
        );

        const content = await this.extractTabContent(tabId);
        if (!content) {
          console.log(`ContentIndexer: No content extracted from tab ${tabId}`);
          return;
        }

        const chunks = this.textChunker.chunkText(
          content.textContent,
          content.title,
        );
        console.log(
          `ContentIndexer: Generated ${chunks.length} chunks for tab ${tabId}`,
        );

        const chunksToIndex = chunks.slice(0, this.options.maxChunksPerPage);
        if (chunks.length > this.options.maxChunksPerPage) {
          console.log(
            `ContentIndexer: Limited chunks from ${chunks.length} to ${this.options.maxChunksPerPage}`,
          );
        }

        if (chunksToIndex.length === 0) {
          console.log(
            `ContentIndexer: No indexable chunks generated for tab ${tabId}`,
          );
          return;
        }

        // Do not discard the last known-good page until the replacement has
        // produced non-empty chunks. Once writing starts, clear the old page
        // durably so this tab contains either the complete new page or nothing.
        if (indexedPageKey) {
          this.tabsRequiringDurableRemoval.add(tabId);
          await this.vectorDatabase.ensureTabDocumentsRemoved(tabId);
          this.tabsRequiringDurableRemoval.delete(tabId);
          this.indexedPageByTab.delete(tabId);
        }

        try {
          for (const chunk of chunksToIndex) {
            const embedding = await this.semanticEngine.getEmbedding(
              chunk.text,
            );
            const label = await this.vectorDatabase.addDocument(
              tabId,
              tab.url!,
              tab.title || "",
              chunk,
              embedding,
            );
            console.log(
              `ContentIndexer: Indexed chunk ${chunk.index} with label ${label}`,
            );
          }
        } catch (error) {
          this.indexedPageByTab.delete(tabId);
          this.tabsRequiringDurableRemoval.add(tabId);
          try {
            await this.vectorDatabase.ensureTabDocumentsRemoved(tabId);
            this.tabsRequiringDurableRemoval.delete(tabId);
          } catch (cleanupFailure) {
            throw new AggregateError(
              [error, cleanupFailure],
              `ContentIndexer: Failed to index tab ${tabId} and remove partial chunks`,
            );
          }
          throw error;
        }

        this.indexedPageByTab.set(tabId, pageKey);

        console.log(
          `ContentIndexer: Successfully indexed ${chunksToIndex.length} chunks for tab ${tabId}`,
        );
      } catch (error) {
        console.error(`ContentIndexer: Failed to index tab ${tabId}:`, error);
        throw error;
      }
    });
  }

  /**
   * Search content
   */
  public searchContent(
    query: string,
    topK: number = 10,
  ): Promise<SearchResult[]> {
    return this.runWithIndexActivity((activity) =>
      activity.searchContent(query, topK),
    );
  }

  private async searchContentInternal(
    query: string,
    topK: number = 10,
  ): Promise<SearchResult[]> {
    // Check if semantic engine is ready before attempting to search
    if (!this.isSemanticEngineReady() && !this.isSemanticEngineInitializing()) {
      throw new Error(
        "Semantic engine is not ready yet. Please initialize the semantic engine first.",
      );
    }

    if (!this.isInitialized) {
      // Only initialize if semantic engine is already ready
      if (!this.isSemanticEngineReady()) {
        throw new Error(
          "ContentIndexer not initialized and semantic engine not ready. Please initialize the semantic engine first.",
        );
      }
      await this.initializeInternal();
    }

    try {
      const queryEmbedding = await this.semanticEngine.getEmbedding(query);
      const results = await this.vectorDatabase.search(queryEmbedding, topK);

      console.log(`ContentIndexer: Found ${results.length} search results`);
      return results;
    } catch (error) {
      console.error("ContentIndexer: Search failed:", error);

      if (error instanceof Error && error.message.includes("not initialized")) {
        console.log(
          "ContentIndexer: Attempting to reinitialize semantic engine and retry search...",
        );
        try {
          await this.semanticEngine.initialize();
          const queryEmbedding = await this.semanticEngine.getEmbedding(query);
          const results = await this.vectorDatabase.search(
            queryEmbedding,
            topK,
          );

          console.log(
            `ContentIndexer: Retry successful, found ${results.length} results`,
          );
          return results;
        } catch (retryError) {
          console.error(
            "ContentIndexer: Retry after reinitialization also failed:",
            retryError,
          );
          throw retryError;
        }
      }

      throw error;
    }
  }

  /**
   * Remove tab index
   */
  public removeTabIndex(tabId: number): Promise<void> {
    return this.runWithIndexActivity((activity) =>
      activity.removeTabIndex(tabId),
    );
  }

  private async removeTabIndexInternal(tabId: number): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    return this.runTabIndexOperation(tabId, async () => {
      try {
        this.tabsRequiringDurableRemoval.add(tabId);
        await this.vectorDatabase.ensureTabDocumentsRemoved(tabId);
        this.tabsRequiringDurableRemoval.delete(tabId);
        this.indexedPageByTab.delete(tabId);

        console.log(`ContentIndexer: Removed index for tab ${tabId}`);
      } catch (error) {
        console.error(
          `ContentIndexer: Failed to remove index for tab ${tabId}:`,
          error,
        );
        throw error;
      }
    });
  }

  private async runTabIndexOperation(
    tabId: number,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.tabIndexOperations.get(tabId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.tabIndexOperations.set(tabId, current);

    try {
      await current;
    } finally {
      if (this.tabIndexOperations.get(tabId) === current) {
        this.tabIndexOperations.delete(tabId);
      }
    }
  }

  /**
   * Check if semantic engine is ready (checks both local and global state)
   */
  public isSemanticEngineReady(): boolean {
    return this.semanticEngine && this.semanticEngine.isInitialized;
  }

  /**
   * Check if global semantic engine is ready (in background/offscreen)
   */
  public async isGlobalSemanticEngineReady(): Promise<boolean> {
    try {
      // Since ContentIndexer runs in background script, directly call the function instead of sending message
      const { handleGetModelStatus } =
        await import("@/entrypoints/background/semantic-similarity");
      const response = await handleGetModelStatus();
      return (
        response &&
        response.success &&
        response.status &&
        response.status.initializationStatus === "ready"
      );
    } catch (error) {
      console.error(
        "ContentIndexer: Failed to check global semantic engine status:",
        error,
      );
      return false;
    }
  }

  /**
   * Check if semantic engine is initializing
   */
  public isSemanticEngineInitializing(): boolean {
    return (
      this.isInitializing ||
      (this.semanticEngine && (this.semanticEngine as any).isInitializing)
    );
  }

  /**
   * Reinitialize content indexer (for model switching)
   */
  public reinitialize(): Promise<void> {
    return this.runExclusiveIndexRecovery(async (activity) => {
      console.log("ContentIndexer: Reinitializing for model switch...");

      this.isInitialized = false;
      this.isInitializing = false;
      this.initPromise = null;

      // Keep the old singleton reachable unless every persistent cleanup step
      // succeeds. resetGlobalVectorDatabase clears first and only then drops
      // the global reference, so initialization cannot split across old/new
      // dimensions after a partial reset.
      await resetGlobalVectorDatabase();
      this.indexedPageByTab.clear();
      this.tabsRequiringDurableRemoval.clear();

      await activity.initialize();

      console.log("ContentIndexer: Reinitialization completed successfully");
    });
  }

  /**
   * Manually trigger semantic engine initialization (async, don't wait for completion)
   * Note: This should only be called after the semantic engine is already initialized
   */
  public startSemanticEngineInitialization(): void {
    if (!this.isInitialized && !this.isInitializing) {
      console.log("ContentIndexer: Checking if semantic engine is ready...");

      // Check if global semantic engine is ready before initializing ContentIndexer
      this.isGlobalSemanticEngineReady()
        .then((isReady) => {
          if (isReady) {
            console.log(
              "ContentIndexer: Starting initialization (semantic engine ready)...",
            );
            this.initialize().catch((error) => {
              console.error(
                "ContentIndexer: Background initialization failed:",
                error,
              );
            });
          } else {
            console.log(
              "ContentIndexer: Semantic engine not ready, skipping initialization",
            );
          }
        })
        .catch((error) => {
          console.error(
            "ContentIndexer: Failed to check semantic engine status:",
            error,
          );
        });
    }
  }

  /**
   * Get indexing statistics
   */
  public getStats(): ContentIndexerStats {
    const vectorStats = this.vectorDatabase
      ? this.vectorDatabase.getStats()
      : {
          totalDocuments: 0,
          totalTabs: 0,
          indexSize: 0,
        };

    return {
      ...vectorStats,
      available:
        (this.isInitialized || this.persistentStatsKnownEmpty) &&
        !this.maintenanceRequested &&
        !this.maintenanceRunning &&
        !this.failedDataCleanup,
      indexedPages: this.indexedPageByTab.size,
      isInitialized: this.isInitialized,
      semanticEngineReady: this.isSemanticEngineReady(),
      semanticEngineInitializing: this.isSemanticEngineInitializing(),
    };
  }

  /**
   * Clear all indexes
   */
  public clearAllIndexes(): Promise<void> {
    return this.runExclusiveIndexMaintenance((activity) =>
      activity.clearAllIndexes(),
    );
  }

  private async clearAllIndexesInternal(): Promise<void> {
    // This must clear persistent data even in a fresh MV3 worker where no
    // in-memory VectorDatabase has been initialized yet.
    const { clearAllVectorData } = await import("./vector-database");
    await clearAllVectorData();
    this.indexedPageByTab.clear();
    this.tabsRequiringDurableRemoval.clear();
    this.persistentStatsKnownEmpty = true;
    console.log("ContentIndexer: All indexes cleared");
  }
  private setupTabEventListeners(): void {
    if (this.tabEventListenersInitialized) {
      return;
    }
    this.tabEventListenersInitialized = true;

    if (this.options.autoIndex) {
      chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
        if (changeInfo.status !== "complete" || !tab.url) return;

        setTimeout(() => {
          if (
            !this.isSemanticEngineReady() &&
            !this.isSemanticEngineInitializing()
          ) {
            console.log(
              `ContentIndexer: Skipping auto-index for tab ${tabId} - semantic engine not ready`,
            );
            return;
          }

          this.indexTabContent(tabId).catch((error) => {
            console.error(
              `ContentIndexer: Auto-indexing failed for tab ${tabId}:`,
              error,
            );
          });
        }, 2000);
      });
    }

    chrome.tabs.onRemoved.addListener((tabId) => {
      void this.removeTabIndex(tabId).catch((error) => {
        console.error(
          `ContentIndexer: Failed to remove closed tab ${tabId}:`,
          error,
        );
      });
    });

    if (chrome.webNavigation) {
      chrome.webNavigation.onCommitted.addListener((details) => {
        if (details.frameId === 0) {
          void this.removeTabIndex(details.tabId).catch((error) => {
            console.error(
              `ContentIndexer: Failed to remove navigated tab ${details.tabId}:`,
              error,
            );
          });
        }
      });
    }
  }

  private shouldIndexUrl(url: string): boolean {
    try {
      const protocol = new URL(url).protocol.toLowerCase();
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }

  private async extractTabContent(
    tabId: number,
  ): Promise<{ textContent: string; title: string } | null> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["inject-scripts/web-fetcher-helper.js"],
      });

      const response = await chrome.tabs.sendMessage(tabId, {
        action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_TEXT_CONTENT,
      });

      if (response.success && response.textContent) {
        return {
          textContent: response.textContent,
          title: response.title || "",
        };
      } else {
        console.error(
          `ContentIndexer: Failed to extract content from tab ${tabId}:`,
          response.error,
        );
        return null;
      }
    } catch (error) {
      console.error(
        `ContentIndexer: Error extracting content from tab ${tabId}:`,
        error,
      );
      return null;
    }
  }
}

let globalContentIndexer: ContentIndexer | null = null;

/**
 * Get global ContentIndexer instance
 */
export function getGlobalContentIndexer(): ContentIndexer {
  if (!globalContentIndexer) {
    globalContentIndexer = new ContentIndexer();
  }
  return globalContentIndexer;
}
