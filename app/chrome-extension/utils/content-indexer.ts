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
import { STORAGE_KEYS } from "@/common/constants";
import { TOOL_MESSAGE_TYPES } from "@/common/message-types";

const TAB_INVALIDATION_SCHEMA_VERSION = 1;
const MAX_PENDING_TAB_INVALIDATIONS = 100_000;

interface TabInvalidationJournal {
  schemaVersion: typeof TAB_INVALIDATION_SCHEMA_VERSION;
  revision: number;
  mode: "tabs" | "full-reset";
  entries: Array<[tabId: number, generation: number]>;
}

interface PersistedTabInvalidation {
  tabId: number;
  generation: number;
}

let tabInvalidationStorageQueue: Promise<void> = Promise.resolve();

function enqueueTabInvalidationStorageOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = tabInvalidationStorageQueue.then(operation);
  tabInvalidationStorageQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseTabInvalidationJournal(value: unknown): TabInvalidationJournal {
  if (!isRecord(value)) {
    throw new Error("Semantic tab invalidation journal is not an object");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "entries" ||
    keys[1] !== "mode" ||
    keys[2] !== "revision" ||
    keys[3] !== "schemaVersion" ||
    value.schemaVersion !== TAB_INVALIDATION_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    (value.mode !== "tabs" && value.mode !== "full-reset") ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_PENDING_TAB_INVALIDATIONS
  ) {
    throw new Error("Semantic tab invalidation journal metadata is invalid");
  }

  if (value.mode === "full-reset" && value.entries.length !== 0) {
    throw new Error("Full-reset invalidation journal must not contain tabs");
  }

  const revision = value.revision as number;
  const entries: Array<[number, number]> = [];
  let previousTabId = -1;
  const generations = new Set<number>();
  for (const entry of value.entries) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      !isNonNegativeSafeInteger(entry[0]) ||
      !Number.isSafeInteger(entry[1]) ||
      entry[1] < 1 ||
      entry[1] > revision ||
      entry[0] <= previousTabId ||
      generations.has(entry[1])
    ) {
      throw new Error("Semantic tab invalidation journal entry is invalid");
    }
    previousTabId = entry[0];
    generations.add(entry[1]);
    entries.push([entry[0], entry[1]]);
  }

  return {
    schemaVersion: TAB_INVALIDATION_SCHEMA_VERSION,
    revision,
    mode: value.mode,
    entries,
  };
}

function sameTabInvalidationJournal(
  left: TabInvalidationJournal,
  right: TabInvalidationJournal,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.revision === right.revision &&
    left.mode === right.mode &&
    left.entries.length === right.entries.length &&
    left.entries.every(
      (entry, index) =>
        entry[0] === right.entries[index]?.[0] &&
        entry[1] === right.entries[index]?.[1],
    )
  );
}

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
  kind: "index" | "data-cleanup" | "index-recovery" | "tab-invalidation";
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
  private autoIndexListenerInitialized = false;
  private readonly options: Required<IndexingOptions>;
  private activeIndexActivities = 0;
  private maintenanceRequested = false;
  private maintenanceRunning = false;
  private readonly activityWaiters = new Set<() => void>();
  private readonly maintenanceQueue: MaintenanceJob[] = [];
  private failedDataCleanup: Error | null = null;
  private failedTabInvalidation: Error | null = null;
  private dataCleanupPromise: Promise<void> | null = null;
  private dataCleanupEpoch = 0;
  private persistentStatsKnownEmpty = false;
  private tabInvalidationJournalKnown = false;
  private tabInvalidationEpoch = 0;
  private readonly pendingTabInvalidations = new Map<number, number>();
  private readonly undurableTabInvalidations = new Map<number, number>();
  private tabInvalidationDrainPromise: Promise<void> | null = null;

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
    const requestedTabInvalidationEpoch = this.tabInvalidationEpoch;
    await this.acquireIndexActivity(
      requestedCleanupEpoch,
      requestedTabInvalidationEpoch,
    );
    try {
      return await operation(
        this.createActivityFacade(requestedTabInvalidationEpoch),
      );
    } finally {
      this.releaseIndexActivity();
    }
  }

  /** Run an exclusive clear/rebuild operation after all shared activity drains. */
  public runExclusiveIndexMaintenance<T>(
    operation: (activity: ContentIndexerMaintenance) => Promise<T>,
  ): Promise<T> {
    if (this.failedDataCleanup || this.failedTabInvalidation)
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
    requestedTabInvalidationEpoch: number,
  ): Promise<void> {
    while (true) {
      if (requestedCleanupEpoch !== this.dataCleanupEpoch) {
        throw new Error(
          "Semantic index activity was cancelled because data cleanup was requested",
        );
      }
      if (requestedTabInvalidationEpoch !== this.tabInvalidationEpoch) {
        throw new Error(
          "Semantic index activity was cancelled because a tab invalidation was requested",
        );
      }
      if (this.failedDataCleanup || this.failedTabInvalidation) {
        throw this.cleanupBlockedError();
      }
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
    if (
      job.kind === "index" &&
      (this.failedDataCleanup || this.failedTabInvalidation)
    ) {
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
          if (job.kind === "data-cleanup" || job.kind === "index-recovery") {
            this.failedDataCleanup = null;
          }
          succeeded = true;
          result = value;
        },
        (error) => {
          if (job.kind === "data-cleanup" || job.kind === "index-recovery") {
            this.failedDataCleanup =
              error instanceof Error ? error : new Error(String(error));
          } else if (job.kind === "tab-invalidation") {
            // Set this before releasing the maintenance gate so a waiter can
            // never slip through after an invalidation failed.
            this.failedTabInvalidation =
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
      "Semantic index access is blocked because the last cleanup or reinitialization did not complete, or a tab invalidation is still unsafe. Retry Clear All Data or model reinitialization.",
      {
        cause:
          this.failedDataCleanup ?? this.failedTabInvalidation ?? undefined,
      },
    );
  }

  private assertTabInvalidationEpoch(expectedEpoch?: number): void {
    if (
      expectedEpoch !== undefined &&
      expectedEpoch !== this.tabInvalidationEpoch
    ) {
      throw new Error(
        "Semantic index activity was cancelled because a tab invalidation was requested",
      );
    }
  }

  /**
   * Record a close/navigation synchronously from the MV3 event listener. This
   * method only mutates memory, starts chrome.storage work, and closes the
   * maintenance gate; it never initializes the model or vector database.
   */
  public handleTabInvalidationEvent(tabId: number): void {
    if (!isNonNegativeSafeInteger(tabId)) return;

    const localEpoch = ++this.tabInvalidationEpoch;
    this.indexedPageByTab.delete(tabId);
    this.tabsRequiringDurableRemoval.add(tabId);
    this.pendingTabInvalidations.set(tabId, localEpoch);
    this.undurableTabInvalidations.set(tabId, localEpoch);
    this.tabInvalidationJournalKnown = false;

    const persisted = this.persistTabInvalidation(tabId, localEpoch);
    const maintenance = this.enqueueMaintenance(
      "tab-invalidation",
      async () => {
        try {
          await persisted;
        } catch {
          // The shared retry below includes this event and every older write.
        }
        // Retry transient or older storage failures while this exclusive job
        // still owns the gate. A persistent failure remains fail-closed.
        await this.retryUndurableTabInvalidationWrites();
        // A cold event must stay cheap. Initialization will drain the durable
        // journal before it exposes the index.
        if (this.failedDataCleanup) return;
        if (!this.isInitialized) {
          await this.verifyColdTabInvalidationsAreDurable();
          return;
        }
        await this.drainPendingTabInvalidationsInternal();
      },
    );
    void maintenance.catch((error) => {
      console.error(
        `ContentIndexer: Failed to persist or apply tab ${tabId} invalidation:`,
        error,
      );
    });
  }

  private async readTabInvalidationJournal(): Promise<TabInvalidationJournal | null> {
    const storageKey = STORAGE_KEYS.SEMANTIC_PENDING_TAB_INVALIDATIONS;
    const result = await chrome.storage.local.get([storageKey]);
    if (!Object.prototype.hasOwnProperty.call(result, storageKey)) return null;
    return parseTabInvalidationJournal(result[storageKey]);
  }

  private async writeAndVerifyTabInvalidationJournal(
    journal: TabInvalidationJournal,
  ): Promise<void> {
    const storageKey = STORAGE_KEYS.SEMANTIC_PENDING_TAB_INVALIDATIONS;
    await chrome.storage.local.set({ [storageKey]: journal });
    const stored = await chrome.storage.local.get([storageKey]);
    if (!Object.prototype.hasOwnProperty.call(stored, storageKey)) {
      throw new Error("Semantic tab invalidation journal was not retained");
    }
    const verified = parseTabInvalidationJournal(stored[storageKey]);
    if (!sameTabInvalidationJournal(verified, journal)) {
      throw new Error("Semantic tab invalidation journal readback mismatched");
    }
  }

  private async retryUndurableTabInvalidationWrites(): Promise<void> {
    for (const [tabId, epoch] of [...this.undurableTabInvalidations]) {
      if (this.undurableTabInvalidations.get(tabId) === epoch) {
        await this.persistTabInvalidation(tabId, epoch);
      }
    }
  }

  private async verifyColdTabInvalidationsAreDurable(): Promise<void> {
    const journal = await enqueueTabInvalidationStorageOperation(() =>
      this.readTabInvalidationJournal(),
    );
    if (!journal || this.undurableTabInvalidations.size > 0) {
      throw new Error("Semantic tab invalidations are not durably persisted");
    }
    if (journal.mode === "tabs") {
      const persistedTabs = new Set(journal.entries.map(([tabId]) => tabId));
      for (const tabId of this.pendingTabInvalidations.keys()) {
        if (!persistedTabs.has(tabId)) {
          throw new Error(
            `Semantic tab invalidation for tab ${tabId} is not durable`,
          );
        }
      }
    }
    this.tabInvalidationJournalKnown = true;
    // The journal is still pending, but it is safe for a later initialize to
    // acquire a lease and drain it. Clear only the storage-write failure.
    this.failedTabInvalidation = null;
  }

  private persistTabInvalidation(
    tabId: number,
    localEpoch: number,
  ): Promise<PersistedTabInvalidation> {
    return enqueueTabInvalidationStorageOperation(async () => {
      const current = await this.readTabInvalidationJournal();
      if (current?.mode === "full-reset") {
        if (this.undurableTabInvalidations.get(tabId) === localEpoch) {
          this.undurableTabInvalidations.delete(tabId);
        }
        this.tabInvalidationJournalKnown = true;
        return { tabId, generation: current.revision };
      }

      const entries = new Map<number, number>(current?.entries ?? []);
      const isNewTab = !entries.has(tabId);
      const currentRevision = current?.revision ?? 0;
      let next: TabInvalidationJournal;
      let generation: number;
      if (
        currentRevision >= Number.MAX_SAFE_INTEGER ||
        (isNewTab && entries.size >= MAX_PENDING_TAB_INVALIDATIONS)
      ) {
        // A bounded full-reset marker is safer than dropping the new tab ID.
        // The next initialized operation will clear all derived vectors.
        generation = Math.max(1, currentRevision);
        next = {
          schemaVersion: TAB_INVALIDATION_SCHEMA_VERSION,
          revision: generation,
          mode: "full-reset",
          entries: [],
        };
      } else {
        generation = currentRevision + 1;
        entries.set(tabId, generation);
        next = {
          schemaVersion: TAB_INVALIDATION_SCHEMA_VERSION,
          revision: generation,
          mode: "tabs",
          entries: [...entries.entries()].sort(
            (left, right) => left[0] - right[0],
          ),
        };
      }

      await this.writeAndVerifyTabInvalidationJournal(next);
      if (this.undurableTabInvalidations.get(tabId) === localEpoch) {
        this.undurableTabInvalidations.delete(tabId);
      }
      this.tabInvalidationJournalKnown = true;
      return { tabId, generation };
    });
  }

  private acknowledgeTabInvalidation(
    invalidation: PersistedTabInvalidation,
  ): Promise<boolean> {
    return enqueueTabInvalidationStorageOperation(async () => {
      const current = await this.readTabInvalidationJournal();
      if (!current) return true;
      if (current.mode === "full-reset") return false;

      const persistedGeneration = current.entries.find(
        ([tabId]) => tabId === invalidation.tabId,
      )?.[1];
      if (persistedGeneration === undefined) return true;
      if (persistedGeneration !== invalidation.generation) return false;

      const remaining = current.entries.filter(
        ([tabId]) => tabId !== invalidation.tabId,
      );
      const storageKey = STORAGE_KEYS.SEMANTIC_PENDING_TAB_INVALIDATIONS;
      if (remaining.length === 0) {
        await chrome.storage.local.remove([storageKey]);
        const stored = await chrome.storage.local.get([storageKey]);
        if (Object.prototype.hasOwnProperty.call(stored, storageKey)) {
          throw new Error("Semantic tab invalidation journal was not removed");
        }
        return true;
      }

      if (current.revision >= Number.MAX_SAFE_INTEGER) {
        await this.writeAndVerifyTabInvalidationJournal({
          schemaVersion: TAB_INVALIDATION_SCHEMA_VERSION,
          revision: current.revision,
          mode: "full-reset",
          entries: [],
        });
        return false;
      }

      await this.writeAndVerifyTabInvalidationJournal({
        schemaVersion: TAB_INVALIDATION_SCHEMA_VERSION,
        revision: current.revision + 1,
        mode: "tabs",
        entries: remaining,
      });
      return true;
    });
  }

  private async clearTabInvalidationJournalAfterVectorClear(): Promise<void> {
    // Capture after the vector clear. Event handlers run synchronously, so an
    // event after this boundary queues its write after our removal and remains.
    const coveredEpoch = this.tabInvalidationEpoch;
    try {
      await enqueueTabInvalidationStorageOperation(async () => {
        const storageKey = STORAGE_KEYS.SEMANTIC_PENDING_TAB_INVALIDATIONS;
        await chrome.storage.local.remove([storageKey]);
        const stored = await chrome.storage.local.get([storageKey]);
        if (Object.prototype.hasOwnProperty.call(stored, storageKey)) {
          throw new Error("Semantic tab invalidation journal was not cleared");
        }
      });
    } catch (error) {
      this.tabInvalidationJournalKnown = false;
      this.failedTabInvalidation =
        error instanceof Error ? error : new Error(String(error));
      throw error;
    }

    for (const [tabId, epoch] of this.pendingTabInvalidations) {
      if (epoch <= coveredEpoch) this.pendingTabInvalidations.delete(tabId);
    }
    for (const [tabId, epoch] of this.undurableTabInvalidations) {
      if (epoch <= coveredEpoch) this.undurableTabInvalidations.delete(tabId);
    }
    this.tabsRequiringDurableRemoval.clear();
    for (const tabId of this.pendingTabInvalidations.keys()) {
      this.tabsRequiringDurableRemoval.add(tabId);
    }
    this.tabInvalidationJournalKnown = true;
    if (
      this.pendingTabInvalidations.size === 0 &&
      this.undurableTabInvalidations.size === 0
    ) {
      this.failedTabInvalidation = null;
    }
  }

  private drainPendingTabInvalidationsInternal(
    expectedTabInvalidationEpoch?: number,
  ): Promise<void> {
    if (this.tabInvalidationDrainPromise) {
      return this.tabInvalidationDrainPromise;
    }
    const operation = this.performPendingTabInvalidationDrain(
      expectedTabInvalidationEpoch,
    );
    const tracked = operation.finally(() => {
      if (this.tabInvalidationDrainPromise === tracked) {
        this.tabInvalidationDrainPromise = null;
      }
    });
    this.tabInvalidationDrainPromise = tracked;
    return tracked;
  }

  private async performPendingTabInvalidationDrain(
    expectedTabInvalidationEpoch?: number,
  ): Promise<void> {
    try {
      // Retry writes that failed in this worker before trusting the durable
      // snapshot. A malformed existing payload is never overwritten.
      await this.retryUndurableTabInvalidationWrites();

      for (let pass = 0; pass < 8; pass += 1) {
        const journalReadEpoch = this.tabInvalidationEpoch;
        const journal = await enqueueTabInvalidationStorageOperation(() =>
          this.readTabInvalidationJournal(),
        );
        this.assertTabInvalidationEpoch(expectedTabInvalidationEpoch);
        this.tabInvalidationJournalKnown = true;

        if (!journal) {
          if (this.undurableTabInvalidations.size > 0) {
            continue;
          }
          for (const [tabId, epoch] of this.pendingTabInvalidations) {
            if (epoch <= journalReadEpoch) {
              this.pendingTabInvalidations.delete(tabId);
              this.tabsRequiringDurableRemoval.delete(tabId);
            }
          }
          if (this.pendingTabInvalidations.size === 0) {
            this.failedTabInvalidation = null;
            return;
          }
          continue;
        }

        if (journal.mode === "full-reset") {
          this.assertTabInvalidationEpoch(expectedTabInvalidationEpoch);
          const { clearAllVectorData } = await import("./vector-database");
          await clearAllVectorData();
          this.indexedPageByTab.clear();
          await this.clearTabInvalidationJournalAfterVectorClear();
          this.persistentStatsKnownEmpty = true;
          return;
        }

        for (const [tabId, generation] of journal.entries) {
          let localEpoch = this.pendingTabInvalidations.get(tabId);
          if (localEpoch === undefined) {
            // Restored durable entries are not new live events. Reuse the
            // current epoch so startup repair does not cancel itself.
            localEpoch = this.tabInvalidationEpoch;
            this.pendingTabInvalidations.set(tabId, localEpoch);
          }
          this.indexedPageByTab.delete(tabId);
          this.tabsRequiringDurableRemoval.add(tabId);

          this.assertTabInvalidationEpoch(expectedTabInvalidationEpoch);
          await this.runTabIndexOperation(tabId, async () => {
            await this.vectorDatabase.ensureTabDocumentsRemoved(tabId);
          });
          const acknowledged = await this.acknowledgeTabInvalidation({
            tabId,
            generation,
          });
          if (
            acknowledged &&
            this.pendingTabInvalidations.get(tabId) === localEpoch &&
            !this.undurableTabInvalidations.has(tabId)
          ) {
            this.pendingTabInvalidations.delete(tabId);
            this.tabsRequiringDurableRemoval.delete(tabId);
          }
        }

        const finalReadEpoch = this.tabInvalidationEpoch;
        const remaining = await enqueueTabInvalidationStorageOperation(() =>
          this.readTabInvalidationJournal(),
        );
        if (!remaining) {
          for (const [tabId, epoch] of this.pendingTabInvalidations) {
            if (epoch <= finalReadEpoch) {
              this.pendingTabInvalidations.delete(tabId);
              this.tabsRequiringDurableRemoval.delete(tabId);
            }
          }
          if (
            this.pendingTabInvalidations.size === 0 &&
            this.undurableTabInvalidations.size === 0
          ) {
            this.tabInvalidationJournalKnown = true;
            this.failedTabInvalidation = null;
            return;
          }
        }
      }

      throw new Error(
        "Semantic tab invalidation journal kept changing during drain",
      );
    } catch (error) {
      this.tabInvalidationJournalKnown = false;
      this.failedTabInvalidation =
        error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  private createActivityFacade(
    expectedTabInvalidationEpoch?: number,
  ): ContentIndexerMaintenance {
    return {
      initialize: () => this.initializeInternal(expectedTabInvalidationEpoch),
      indexTabContent: (tabId) =>
        this.indexTabContentInternal(tabId, expectedTabInvalidationEpoch),
      searchContent: (query, topK) =>
        this.searchContentInternal(query, topK, expectedTabInvalidationEpoch),
      removeTabIndex: (tabId) =>
        this.removeTabIndexInternal(tabId, expectedTabInvalidationEpoch),
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

  private async initializeInternal(
    expectedTabInvalidationEpoch?: number,
  ): Promise<void> {
    this.assertTabInvalidationEpoch(expectedTabInvalidationEpoch);
    if (this.isInitialized) return;
    if (this.isInitializing && this.initPromise) return this.initPromise;

    this.isInitializing = true;
    this.initPromise = this._doInitialize(expectedTabInvalidationEpoch).finally(
      () => {
        this.isInitializing = false;
      },
    );

    return this.initPromise;
  }

  private async _doInitialize(
    expectedTabInvalidationEpoch?: number,
  ): Promise<void> {
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

      // A cold worker must apply durable close/navigation tombstones before
      // inspecting or publishing any persisted page identity.
      this.assertTabInvalidationEpoch(expectedTabInvalidationEpoch);
      await this.drainPendingTabInvalidationsInternal(
        expectedTabInvalidationEpoch,
      );
      this.assertTabInvalidationEpoch(expectedTabInvalidationEpoch);

      // A worker restart may find chunk mappings persisted before the page's
      // final completion commit. Repair every such tab before exposing search,
      // stats, or a duplicate-page cache, then hydrate all completed pages as
      // one snapshot so initialization cannot publish a partial view.
      this.indexedPageByTab.clear();
      const initialInspection = await this.vectorDatabase.inspectTabPageState();
      this.assertTabInvalidationEpoch(expectedTabInvalidationEpoch);
      const tabsToRepair = new Set([
        ...this.tabsRequiringDurableRemoval,
        ...initialInspection.repairTabIds,
      ]);
      for (const tabId of [...tabsToRepair].sort(
        (left, right) => left - right,
      )) {
        this.tabsRequiringDurableRemoval.add(tabId);
        await this.vectorDatabase.ensureTabDocumentsRemoved(tabId);
        this.tabsRequiringDurableRemoval.delete(tabId);
      }

      const repairedInspection =
        await this.vectorDatabase.inspectTabPageState();
      this.assertTabInvalidationEpoch(expectedTabInvalidationEpoch);
      if (repairedInspection.repairTabIds.length > 0) {
        throw new Error(
          `Semantic page repair did not complete for tabs ${repairedInspection.repairTabIds.join(", ")}`,
        );
      }
      const hydratedPages = new Map<number, string>();
      for (const page of repairedInspection.completedPages) {
        if (
          !this.pendingTabInvalidations.has(page.tabId) &&
          !this.tabsRequiringDurableRemoval.has(page.tabId)
        ) {
          hydratedPages.set(page.tabId, page.pageKey);
        }
      }
      this.indexedPageByTab = hydratedPages;

      this.setupAutoIndexListener();

      this.isInitialized = true;
    } catch (error) {
      console.error("ContentIndexer: Initialization failed:", error);
      this.indexedPageByTab.clear();
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

  private async indexTabContentInternal(
    tabId: number,
    expectedTabInvalidationEpoch?: number,
  ): Promise<void> {
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
      await this.initializeInternal(expectedTabInvalidationEpoch);
    }

    this.assertTabInvalidationEpoch(expectedTabInvalidationEpoch);
    await this.drainPendingTabInvalidationsInternal(
      expectedTabInvalidationEpoch,
    );
    this.assertTabInvalidationEpoch(expectedTabInvalidationEpoch);

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
          await this.vectorDatabase.commitTabPage(
            tabId,
            tab.url!,
            tab.title || "",
          );
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
    expectedTabInvalidationEpoch?: number,
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
      await this.initializeInternal(expectedTabInvalidationEpoch);
    }

    this.assertTabInvalidationEpoch(expectedTabInvalidationEpoch);
    await this.drainPendingTabInvalidationsInternal(
      expectedTabInvalidationEpoch,
    );
    this.assertTabInvalidationEpoch(expectedTabInvalidationEpoch);

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

  private async removeTabIndexInternal(
    tabId: number,
    expectedTabInvalidationEpoch?: number,
  ): Promise<void> {
    this.assertTabInvalidationEpoch(expectedTabInvalidationEpoch);
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
      await this.clearTabInvalidationJournalAfterVectorClear();
      this.indexedPageByTab.clear();

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
        !this.failedDataCleanup &&
        !this.failedTabInvalidation &&
        this.tabInvalidationJournalKnown &&
        this.pendingTabInvalidations.size === 0 &&
        this.undurableTabInvalidations.size === 0,
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
    await this.clearTabInvalidationJournalAfterVectorClear();
    this.indexedPageByTab.clear();
    this.persistentStatsKnownEmpty = true;
    console.log("ContentIndexer: All indexes cleared");
  }
  private setupAutoIndexListener(): void {
    if (this.autoIndexListenerInitialized) {
      return;
    }
    this.autoIndexListenerInitialized = true;

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

let contentIndexerLifecycleListenersInitialized = false;

const handleIndexedTabRemoved: Parameters<
  typeof chrome.tabs.onRemoved.addListener
>[0] = (tabId) => {
  getGlobalContentIndexer().handleTabInvalidationEvent(tabId);
};

const handleIndexedTabNavigation: Parameters<
  typeof chrome.webNavigation.onCommitted.addListener
>[0] = (details) => {
  if (details.frameId !== 0 || !isNonNegativeSafeInteger(details.tabId)) return;
  getGlobalContentIndexer().handleTabInvalidationEvent(details.tabId);
};

/** Register MV3 lifecycle listeners during the background script's first turn. */
export function initContentIndexerLifecycleListeners(): void {
  if (contentIndexerLifecycleListenersInitialized) return;
  contentIndexerLifecycleListenersInitialized = true;
  chrome.tabs.onRemoved.addListener(handleIndexedTabRemoved);
  chrome.webNavigation?.onCommitted.addListener(handleIndexedTabNavigation);
}
