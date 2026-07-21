/**
 * Vector database manager
 * Uses hnswlib-wasm for high-performance vector similarity search
 * Implements singleton pattern to avoid duplicate WASM module initialization
 */

import type { TextChunk } from "./text-chunker";
import {
  MAX_HNSW_LABEL,
  VECTOR_MAPPING_SCHEMA_VERSION,
  isNonNegativeSafeInteger,
  parsePersistedVectorMappings,
  type PersistedTabPageCompletion,
  type PersistedVectorMappings,
  type PersistedVectorMappingsLookup,
} from "./vector-mapping-codec";
import {
  DB_NAME,
  HNSW_DB_NAME,
  HNSW_INDEX_FILES,
  IDBFS_STORE_NAME,
  VECTOR_STORAGE_BACKUP_KEYS,
  HnswIndexPersistenceUncertainError,
  IndexedDBHelper,
  cleanupError,
  clearIndexedDatabaseStore,
  deleteIndexedDatabase,
  enqueueHnswFileSystemOperation,
  errorMessage,
  globalHnswlib,
  initializeGlobalHnswlib,
  persistHnswIndex,
  syncGlobalHnswFileSystem,
  syncGlobalHnswFileSystemNow,
  waitForGlobalHnswFileSystemIdle,
} from "./vector-storage";

export interface VectorDocument {
  id: string;
  tabId: number;
  url: string;
  title: string;
  chunk: TextChunk;
  embedding: Float32Array;
  timestamp: number;
}

export interface SearchResult {
  document: VectorDocument;
  similarity: number;
  distance: number;
}

export interface VectorPageDocumentInput {
  chunk: TextChunk;
  embedding: Float32Array;
}

export interface VectorDatabaseConfig {
  dimension: number;
  maxElements: number;
  efConstruction: number;
  M: number;
  efSearch: number;
  indexFileName: string;
  enableAutoCleanup?: boolean;
  maxRetentionDays?: number;
}

export interface VectorDatabaseClearOptions {
  /** Persist an empty HNSW file. Privacy cleanup clears FILE_DATA instead. */
  persistIndex?: boolean;
}

export interface CompletedTabPageIdentity {
  tabId: number;
  pageKey: string;
  url: string;
  title: string;
  expectedCount: number;
}

export interface TabPageStateInspection {
  completedPages: CompletedTabPageIdentity[];
  repairTabIds: number[];
}

export type TabPageCompletionInspection =
  | { state: "absent" }
  | {
      state: "repair-required";
      reason: "incomplete" | "expired";
    }
  | {
      state: "complete";
      page: CompletedTabPageIdentity;
    };

type InternalTabPageCompletionInspection =
  | { state: "absent" }
  | {
      state: "repair-required";
      reason: "incomplete" | "expired";
    }
  | {
      state: "complete";
      completion: PersistedTabPageCompletion;
      labels: number[];
    };

export interface VectorDatabaseStats {
  /** Documents belonging to exact, non-expired completed pages. */
  totalDocuments: number;
  /** Tabs with an exact, non-expired completed page. */
  totalTabs: number;
  /** Exact, non-expired page count. Currently one completed page per tab. */
  completedPages: number;
  /** Physical resident storage estimate, including hidden repair candidates. */
  indexSize: number;
  isInitialized: boolean;
}

export class VectorCompactionRequiredError extends Error {
  constructor(
    readonly physicalCount: number,
    readonly maxElements: number,
  ) {
    super(
      `Vector index physical capacity is exhausted (${physicalCount}/${maxElements}); durable compaction is required before adding another vector`,
    );
    this.name = "VectorCompactionRequiredError";
  }
}

export interface VectorCompactionResult {
  compacted: boolean;
  evictedTabIds: number[];
  retainedCompletedPages: CompletedTabPageIdentity[];
  /** A safe, fully rolled-back failure that callers must throw after marker clear. */
  failure?: Error;
}

interface VectorStateSnapshot {
  documents: Map<number, VectorDocument>;
  tabDocuments: Map<number, Set<number>>;
  completedTabPages: Map<number, PersistedTabPageCompletion>;
  nextLabel: number;
}

interface VectorCompactionPage {
  tabId: number;
  pageKey: string;
  labels: number[];
  newestTimestamp: number;
  expired: boolean;
}

interface VectorCompactionPlan {
  candidate: VectorStateSnapshot;
  evictedTabIds: number[];
  retainedCompletedPages: CompletedTabPageIdentity[];
}

class VectorCompactionInsufficientCapacityError extends Error {
  constructor(protectedCount: number, targetCount: number) {
    super(
      `Vector compaction cannot reach its ${targetCount}-vector target without evicting ${protectedCount} protected incomplete vectors`,
    );
    this.name = "VectorCompactionInsufficientCapacityError";
  }
}

function cloneVectorDocument(document: VectorDocument): VectorDocument {
  return {
    ...document,
    chunk: { ...document.chunk },
    embedding: new Float32Array(document.embedding),
  };
}

function assertPositiveHnswInteger(name: string, value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > MAX_HNSW_LABEL
  ) {
    throw new TypeError(
      `${name} must be a positive safe integer no greater than ${MAX_HNSW_LABEL}`,
    );
  }
  return value as number;
}

function assertValidRetentionDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      "maxRetentionDays must be a finite non-negative number",
    );
  }
  return value;
}

export class VectorDatabase {
  private index: any = null;
  private isInitialized = false;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;

  private documents = new Map<number, VectorDocument>();
  private tabDocuments = new Map<number, Set<number>>();
  private completedTabPages = new Map<number, PersistedTabPageCompletion>();
  private nextLabel = 0;
  private mappingRevision = 0;
  private mappingSaveQueue: Promise<void> = Promise.resolve();
  private mutationQueue: Promise<void> = Promise.resolve();
  private unsafeMutationState: Error | null = null;
  private unsafeIndexPersistenceOutcome = false;

  private readonly config: VectorDatabaseConfig;

  constructor(config?: Partial<VectorDatabaseConfig>) {
    const resolvedConfig: VectorDatabaseConfig = {
      dimension: 384,
      maxElements: 100000,
      efConstruction: 200,
      M: 48,
      efSearch: 50,
      indexFileName: "tab_content_index.dat",
      enableAutoCleanup: true,
      maxRetentionDays: 30,
      ...config,
    };
    resolvedConfig.dimension = assertPositiveHnswInteger(
      "dimension",
      resolvedConfig.dimension,
    );
    resolvedConfig.maxElements = assertPositiveHnswInteger(
      "maxElements",
      resolvedConfig.maxElements,
    );
    resolvedConfig.maxRetentionDays = assertValidRetentionDays(
      resolvedConfig.maxRetentionDays,
    );
    this.config = resolvedConfig;

    console.log("VectorDatabase: Initialized with config:", {
      dimension: this.config.dimension,
      efSearch: this.config.efSearch,
      M: this.config.M,
      efConstruction: this.config.efConstruction,
      enableAutoCleanup: this.config.enableAutoCleanup,
      maxRetentionDays: this.config.maxRetentionDays,
    });
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertSafeMutationState(): void {
    if (this.unsafeMutationState) {
      throw new Error(
        "Vector database access is blocked because a prior mutation could not restore its active-label invariant",
        { cause: this.unsafeMutationState },
      );
    }
  }

  private initializeEmptyIndex(): void {
    this.index.initIndex(
      this.config.maxElements,
      this.config.M,
      this.config.efConstruction,
      200,
    );
    this.index.setEfSearch(this.config.efSearch);
    this.documents.clear();
    this.tabDocuments.clear();
    this.completedTabPages.clear();
    this.nextLabel = 0;
  }

  private applyDocumentMappings(mappingData: PersistedVectorMappings): void {
    this.documents.clear();
    for (const [label, document] of mappingData.documents) {
      this.documents.set(label, document);
    }

    this.tabDocuments.clear();
    for (const [tabId, labels] of mappingData.tabDocuments) {
      this.tabDocuments.set(tabId, new Set(labels));
    }

    this.completedTabPages.clear();
    for (const [tabId, completion] of mappingData.completedTabPages) {
      this.completedTabPages.set(tabId, {
        ...completion,
        labels: [...completion.labels],
      });
    }

    this.nextLabel = mappingData.nextLabel;
    this.mappingRevision = Math.max(this.mappingRevision, mappingData.revision);
  }

  private inspectHnswActiveLabels(): {
    activeLabels: Set<number>;
    deletedLabels: Set<number>;
    usedLabels: Set<number>;
  } {
    let rawUsedLabels: unknown;
    let rawDeletedLabels: unknown;
    let rawCurrentCount: unknown;
    try {
      rawUsedLabels = this.index.getUsedLabels();
      rawDeletedLabels = this.index.getDeletedLabels();
      rawCurrentCount = this.index.getCurrentCount();
    } catch (error) {
      throw cleanupError("inspect HNSW label state", error);
    }

    if (!Array.isArray(rawUsedLabels)) {
      throw new Error("HNSW used labels are not an array");
    }
    if (!Array.isArray(rawDeletedLabels)) {
      throw new Error("HNSW deleted labels are not an array");
    }
    if (!isNonNegativeSafeInteger(rawCurrentCount)) {
      throw new Error("HNSW current count is not a non-negative safe integer");
    }

    const parseLabels = (values: unknown[], collection: string) => {
      const labels = new Set<number>();
      for (const value of values) {
        if (!isNonNegativeSafeInteger(value) || value > MAX_HNSW_LABEL) {
          throw new Error(`${collection} contains an invalid HNSW label`);
        }
        if (labels.has(value)) {
          throw new Error(`${collection} contains a duplicate HNSW label`);
        }
        labels.add(value);
      }
      return labels;
    };

    const usedLabels = parseLabels(rawUsedLabels, "HNSW used labels");
    const deletedLabels = parseLabels(rawDeletedLabels, "HNSW deleted labels");
    if (rawCurrentCount !== usedLabels.size) {
      throw new Error(
        `HNSW current count ${rawCurrentCount} does not match ${usedLabels.size} used labels`,
      );
    }
    for (const label of deletedLabels) {
      if (!usedLabels.has(label)) {
        throw new Error(`HNSW deleted label ${label} is not a used label`);
      }
    }

    const activeLabels = new Set(
      [...usedLabels].filter((label) => !deletedLabels.has(label)),
    );
    return { activeLabels, deletedLabels, usedLabels };
  }

  private assertActiveLabelInvariant(
    documentLabels: Iterable<number>,
    nextLabel: number,
  ): void {
    if (!isNonNegativeSafeInteger(nextLabel) || nextLabel > MAX_HNSW_LABEL) {
      throw new Error("Next HNSW label is invalid");
    }

    const { activeLabels, usedLabels } = this.inspectHnswActiveLabels();
    const mappedLabels = new Set<number>();
    for (const label of documentLabels) {
      if (
        !isNonNegativeSafeInteger(label) ||
        label > MAX_HNSW_LABEL ||
        mappedLabels.has(label)
      ) {
        throw new Error(
          "Document mappings contain invalid or duplicate labels",
        );
      }
      mappedLabels.add(label);
    }

    if (
      activeLabels.size !== mappedLabels.size ||
      [...activeLabels].some((label) => !mappedLabels.has(label)) ||
      [...mappedLabels].some((label) => !activeLabels.has(label))
    ) {
      throw new Error(
        "Active HNSW labels do not exactly match document mappings",
      );
    }

    if (usedLabels.size > 0) {
      let maxUsedLabel = -1;
      for (const label of usedLabels)
        maxUsedLabel = Math.max(maxUsedLabel, label);
      if (nextLabel <= maxUsedLabel) {
        throw new Error(
          `Next HNSW label ${nextLabel} does not exceed used label ${maxUsedLabel}`,
        );
      }
    }
  }

  private activeLabelInvariantFailure(
    documentLabels: Iterable<number>,
    nextLabel: number,
  ): string | null {
    try {
      this.assertActiveLabelInvariant(documentLabels, nextLabel);
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  }

  private async lookupDocumentMappings(): Promise<PersistedVectorMappingsLookup> {
    const storageKey = `hnswlib_document_mappings_${this.config.indexFileName}`;
    const readErrors: Error[] = [];
    const invalidReasons: string[] = [];
    const candidates: Array<{
      source: "indexeddb" | "chrome-storage";
      value: PersistedVectorMappings;
    }> = [];

    try {
      const indexedDbValue = await IndexedDBHelper.loadData(
        this.config.indexFileName,
      );
      if (indexedDbValue !== null) {
        const parsed = parsePersistedVectorMappings(
          indexedDbValue,
          this.config,
        );
        if (parsed.status === "found") {
          candidates.push({ source: "indexeddb", value: parsed.value });
        } else if (parsed.status === "invalid") {
          invalidReasons.push(`IndexedDB: ${parsed.reason}`);
        }
      }
    } catch (error) {
      readErrors.push(
        cleanupError("read vector mappings from IndexedDB", error),
      );
    }

    try {
      const storageResult = await chrome.storage.local.get([storageKey]);
      if (Object.prototype.hasOwnProperty.call(storageResult, storageKey)) {
        const parsed = parsePersistedVectorMappings(
          storageResult[storageKey],
          this.config,
        );
        if (parsed.status === "found") {
          candidates.push({ source: "chrome-storage", value: parsed.value });
        } else if (parsed.status === "invalid") {
          invalidReasons.push(`chrome.storage: ${parsed.reason}`);
        }
      }
    } catch (error) {
      readErrors.push(
        cleanupError("read vector mappings from chrome.storage", error),
      );
    }

    // A failed read leaves the other backend's revision unknowable. Likewise,
    // an invalid payload may be newer than an otherwise valid candidate. Never
    // load HNSW until both durable sources have been classified successfully.
    if (readErrors.length > 0) {
      throw new AggregateError(
        readErrors,
        "Unable to determine whether persisted vector mappings exist",
      );
    }
    if (invalidReasons.length > 0) {
      return { status: "invalid", reason: invalidReasons.join("; ") };
    }

    if (candidates.length > 0) {
      candidates.sort((left, right) => {
        const revisionDifference = right.value.revision - left.value.revision;
        if (revisionDifference !== 0) return revisionDifference;
        return left.source === "indexeddb" ? -1 : 1;
      });
      const selected = candidates[0];

      // A newer fallback must win over a stale primary. Best-effort migration
      // repairs IndexedDB while the verified chrome.storage copy remains safe.
      if (selected.source === "chrome-storage") {
        const indexedDbCandidate = candidates.find(
          (candidate) => candidate.source === "indexeddb",
        );
        if (
          !indexedDbCandidate ||
          indexedDbCandidate.value.revision < selected.value.revision
        ) {
          try {
            await IndexedDBHelper.saveData(
              this.config.indexFileName,
              selected.value,
            );
          } catch (error) {
            console.warn(
              "VectorDatabase: Failed to migrate newer chrome.storage mappings to IndexedDB:",
              error,
            );
          }
        }
      }

      return { status: "found", value: selected.value };
    }

    return { status: "absent" };
  }

  private async removeDocumentMappingBackup(): Promise<void> {
    const storageKey = `hnswlib_document_mappings_${this.config.indexFileName}`;
    await chrome.storage.local.remove([storageKey]);
    const remaining = await chrome.storage.local.get([storageKey]);
    if (Object.prototype.hasOwnProperty.call(remaining, storageKey)) {
      throw new Error(`Vector storage backup still exists: ${storageKey}`);
    }
  }

  private async replaceUnsafePersistedIndexWithEmpty(
    reason: string,
  ): Promise<void> {
    console.warn(
      `VectorDatabase: Refusing to load persisted index; replacing it with an empty current-dimension index (${reason})`,
    );
    try {
      this.initializeEmptyIndex();
      this.mappingRevision = 0;

      await IndexedDBHelper.deleteData(this.config.indexFileName);
      await this.removeDocumentMappingBackup();
      await persistHnswIndex(this.index, this.config.indexFileName);
      const persistedMappingRevision = await this.saveDocumentMappings();

      this.assertActiveLabelInvariant(this.documents.keys(), this.nextLabel);
      if (
        this.documents.size !== 0 ||
        this.tabDocuments.size !== 0 ||
        this.completedTabPages.size !== 0 ||
        this.nextLabel !== 0
      ) {
        throw new Error(
          "Vector index reset did not produce a verified empty state",
        );
      }
      await this.verifyPersistedEmptyMappings(persistedMappingRevision);
      this.unsafeMutationState = null;
      this.unsafeIndexPersistenceOutcome = false;
    } catch (error) {
      if (error instanceof HnswIndexPersistenceUncertainError) {
        this.unsafeIndexPersistenceOutcome = true;
      }
      const failure = cleanupError("replace unsafe vector state", error);
      this.unsafeMutationState = failure;
      throw failure;
    }
  }

  private async verifyPersistedEmptyMappings(
    expectedRevision: number,
  ): Promise<void> {
    const lookup = await this.lookupDocumentMappings();
    if (
      lookup.status !== "found" ||
      lookup.value.revision !== expectedRevision ||
      lookup.value.documents.length !== 0 ||
      lookup.value.tabDocuments.length !== 0 ||
      lookup.value.completedTabPages.length !== 0 ||
      lookup.value.nextLabel !== 0
    ) {
      throw new Error("Persisted vector reset state did not verify as empty");
    }
  }

  /**
   * Initialize vector database
   */
  public async initialize(): Promise<void> {
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
      console.log("VectorDatabase: Initializing...");

      const hnswlib = await initializeGlobalHnswlib();

      hnswlib.EmscriptenFileSystemManager.setDebugLogs(true);

      this.index = new hnswlib.HierarchicalNSW(
        "cosine",
        this.config.dimension,
        "",
      );

      await this.syncFileSystem("read");

      const indexExists = hnswlib.EmscriptenFileSystemManager.checkFileExists(
        this.config.indexFileName,
      );
      const mappingLookup = await this.lookupDocumentMappings();

      if (indexExists && mappingLookup.status === "found") {
        console.log("VectorDatabase: Loading existing index...");
        let loadFailure: unknown = null;
        try {
          await this.index.readIndex(
            this.config.indexFileName,
            this.config.maxElements,
          );
          this.index.setEfSearch(this.config.efSearch);
        } catch (error) {
          loadFailure = error;
        }

        if (loadFailure) {
          console.warn(
            "VectorDatabase: Failed to load existing index, replacing it:",
            loadFailure,
          );
          await this.replaceUnsafePersistedIndexWithEmpty(
            `index read failed: ${errorMessage(loadFailure)}`,
          );
        } else {
          const invariantFailure = this.activeLabelInvariantFailure(
            mappingLookup.value.documents.map(([label]) => label),
            mappingLookup.value.nextLabel,
          );
          if (invariantFailure) {
            await this.replaceUnsafePersistedIndexWithEmpty(
              `HNSW active-label invariant failed: ${invariantFailure}`,
            );
          } else {
            this.applyDocumentMappings(mappingLookup.value);
            console.log(
              `VectorDatabase: Loaded existing index with ${this.documents.size} documents, next label: ${this.nextLabel}`,
            );
          }
        }
      } else if (indexExists || mappingLookup.status !== "absent") {
        const reason = indexExists
          ? mappingLookup.status === "invalid"
            ? mappingLookup.reason
            : "index file exists without durable metadata"
          : mappingLookup.status === "invalid"
            ? `orphaned invalid mappings: ${mappingLookup.reason}`
            : "document mappings exist without an index file";
        await this.replaceUnsafePersistedIndexWithEmpty(reason);
      } else {
        console.log("VectorDatabase: Creating new index...");
        this.initializeEmptyIndex();
      }

      this.isInitialized = true;
      console.log("VectorDatabase: Initialization completed successfully");
    } catch (error) {
      console.error("VectorDatabase: Initialization failed:", error);
      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * Add document to vector database
   */
  public async addDocument(
    tabId: number,
    url: string,
    title: string,
    chunk: TextChunk,
    embedding: Float32Array,
  ): Promise<number> {
    // Snapshot caller-owned mutable inputs before initialization or the
    // mutation queue can yield. Neither the caller nor search consumers may
    // retain a reference to the database's durable document state.
    const chunkSnapshot = { ...chunk };
    const embeddingSnapshot = new Float32Array(embedding);
    if (!this.isInitialized) {
      await this.initialize();
    }

    return this.enqueueMutation(() =>
      this.addDocumentInternal(
        tabId,
        url,
        title,
        chunkSnapshot,
        embeddingSnapshot,
      ),
    );
  }

  /**
   * Add and publish one complete page with a single index/mapping commit.
   * Caller-owned chunks and embeddings are snapshotted before initialization
   * or mutation-queue waits.
   */
  public async addTabPage(
    tabId: number,
    url: string,
    title: string,
    inputs: readonly VectorPageDocumentInput[],
  ): Promise<number[]> {
    const snapshots = Array.from(inputs, ({ chunk, embedding }) => ({
      chunk: { ...chunk },
      embedding: new Float32Array(embedding),
    }));
    if (!this.isInitialized) await this.initialize();
    return this.enqueueMutation(() =>
      this.addTabPageInternal(tabId, url, title, snapshots),
    );
  }

  private async addTabPageInternal(
    tabId: number,
    url: string,
    title: string,
    inputs: readonly VectorPageDocumentInput[],
  ): Promise<number[]> {
    this.assertSafeMutationState();
    if (
      !isNonNegativeSafeInteger(tabId) ||
      typeof url !== "string" ||
      typeof title !== "string" ||
      inputs.length === 0 ||
      inputs.length > this.config.maxElements
    ) {
      throw new Error("A non-empty, valid vector page is required");
    }
    if (this.tabDocuments.has(tabId) || this.completedTabPages.has(tabId)) {
      throw new Error(
        `Cannot batch-add vector page for non-empty tab ${tabId}`,
      );
    }

    for (const { chunk, embedding } of inputs) {
      if (
        typeof chunk.text !== "string" ||
        typeof chunk.source !== "string" ||
        !isNonNegativeSafeInteger(chunk.index) ||
        !isNonNegativeSafeInteger(chunk.wordCount) ||
        embedding.length !== this.config.dimension
      ) {
        throw new Error("Vector page contains invalid document data");
      }
      for (const value of embedding) {
        if (!Number.isFinite(value)) {
          throw new Error("Vector page contains an invalid embedding");
        }
      }
    }

    const physicalCount = this.inspectHnswActiveLabels().usedLabels.size;
    if (physicalCount + inputs.length > this.config.maxElements) {
      throw new VectorCompactionRequiredError(
        physicalCount,
        this.config.maxElements,
      );
    }

    const labels: number[] = [];
    try {
      for (const { chunk, embedding } of inputs) {
        labels.push(
          await this.addDocumentInternal(tabId, url, title, chunk, embedding, {
            capacityPreflighted: true,
            persistChanges: false,
            verifyInvariant: false,
          }),
        );
      }

      const invariantFailure = this.activeLabelInvariantFailure(
        this.documents.keys(),
        this.nextLabel,
      );
      if (invariantFailure) {
        const invariantError = new Error(
          `Vector page add violated the active-label invariant: ${invariantFailure}`,
        );
        await this.replaceUnsafePersistedIndexWithEmpty(invariantError.message);
        throw invariantError;
      }

      const completion: PersistedTabPageCompletion = {
        pageKey: `${url}\u0000${title}`,
        url,
        title,
        labels: [...labels],
        expectedCount: labels.length,
      };
      const candidateCompletions = new Map(this.completedTabPages);
      candidateCompletions.set(tabId, completion);

      await this.saveIndex();
      const revision = await this.saveDocumentMappings(candidateCompletions);
      await this.verifyTabPageCompletionInPersistedMappings(
        tabId,
        completion,
        revision,
      );
      this.completedTabPages.set(tabId, completion);
      return [...labels];
    } catch (error) {
      this.completedTabPages.delete(tabId);
      if (error instanceof HnswIndexPersistenceUncertainError) {
        const failure = cleanupError(
          "persist batched vector page index with unknown outcome",
          error,
        );
        this.unsafeMutationState = failure;
        this.unsafeIndexPersistenceOutcome = true;
        throw failure;
      }
      if (this.unsafeMutationState || this.unsafeIndexPersistenceOutcome) {
        throw error;
      }
      const ownedLabels = labels.filter((label) => this.documents.has(label));
      if (ownedLabels.length > 0) {
        await this.rollbackAddedDocuments(ownedLabels, tabId, error);
      }
      throw error;
    }
  }

  private async addDocumentInternal(
    tabId: number,
    url: string,
    title: string,
    chunk: TextChunk,
    embedding: Float32Array,
    options: {
      capacityPreflighted?: boolean;
      persistChanges?: boolean;
      verifyInvariant?: boolean;
    } = {},
  ): Promise<number> {
    this.assertSafeMutationState();
    const documentId = this.generateDocumentId(tabId, chunk.index);
    let label: number | null = null;
    let pointAdded = false;
    let addPointFailedAmbiguously = false;
    try {
      // Validate vector data
      if (!embedding || embedding.length !== this.config.dimension) {
        const errorMsg = `Invalid embedding dimension: expected ${this.config.dimension}, got ${embedding?.length || 0}`;
        console.error("VectorDatabase: Dimension mismatch detected!", {
          expectedDimension: this.config.dimension,
          actualDimension: embedding?.length || 0,
          documentId,
          tabId,
          url,
          title: title.substring(0, 50) + "...",
        });

        // This might be caused by model switching, suggest reinitialization
        console.warn(
          "VectorDatabase: This might be caused by model switching. Consider reinitializing the vector database with the correct dimension.",
        );

        throw new Error(errorMsg);
      }

      // Check if vector data contains invalid values
      for (let i = 0; i < embedding.length; i++) {
        if (!isFinite(embedding[i])) {
          throw new Error(
            `Invalid embedding value at index ${i}: ${embedding[i]}`,
          );
        }
      }

      // HNSW capacity is physical: tombstoned labels still occupy slots until
      // a durable rebuild. Refuse the mutation before reserving a label,
      // crossing addPoint, or writing either persistence backend.
      if (!options.capacityPreflighted) {
        const physicalCount = this.inspectHnswActiveLabels().usedLabels.size;
        if (physicalCount + 1 > this.config.maxElements) {
          throw new VectorCompactionRequiredError(
            physicalCount,
            this.config.maxElements,
          );
        }
      }

      const cleanEmbedding = new Float32Array(embedding);

      // Select and fully construct one binding-compatible representation
      // before crossing addPoint's mutation boundary. An addPoint exception
      // is ambiguous because the native index may already have changed, so it
      // must never be retried with another representation.
      let vectorToAdd: any;
      let ownedVectorToAdd: any = null;
      try {
        if (globalHnswlib?.VectorFloat) {
          console.log("VectorDatabase: Using VectorFloat constructor");
          ownedVectorToAdd = new globalHnswlib.VectorFloat();
          for (let i = 0; i < cleanEmbedding.length; i++) {
            ownedVectorToAdd.push_back(cleanEmbedding[i]);
          }
          vectorToAdd = ownedVectorToAdd;
        } else {
          console.log("VectorDatabase: Using plain JS array for addPoint");
          vectorToAdd = Array.from(cleanEmbedding);
        }

        // Labels are never reused, including after an ambiguous native
        // failure.
        label = this.reserveNextLabel();

        console.log(
          `VectorDatabase: Adding document with label ${label}, embedding dimension: ${embedding.length}`,
        );

        // Add vector to index
        // According to hnswlib-wasm-static emscripten binding requirements, need to create VectorFloat type
        console.log(
          `VectorDatabase: 🔧 DEBUGGING - About to call addPoint with:`,
          {
            embeddingType: typeof cleanEmbedding,
            isFloat32Array: cleanEmbedding instanceof Float32Array,
            length: cleanEmbedding.length,
            firstFewValues: Array.from(cleanEmbedding.slice(0, 3)),
            label: label,
            replaceDeleted: false,
          },
        );

        try {
          this.index.addPoint(vectorToAdd, label, false);
          pointAdded = true;
        } catch (error) {
          addPointFailedAmbiguously = true;
          throw error;
        }
      } finally {
        if (ownedVectorToAdd && typeof ownedVectorToAdd.delete === "function") {
          ownedVectorToAdd.delete();
        }
      }
      console.log(
        `VectorDatabase: ✅ Successfully added document with label ${label}`,
      );

      const document: VectorDocument = {
        id: documentId,
        tabId,
        url,
        title,
        chunk: { ...chunk },
        embedding: cleanEmbedding,
        timestamp: Date.now(),
      };
      this.documents.set(label, document);

      // Update tab document mapping
      if (!this.tabDocuments.has(tabId)) {
        this.tabDocuments.set(tabId, new Set());
      }
      this.tabDocuments.get(tabId)!.add(label);

      // A persisted chunk is not a restorable page. The completion marker is
      // invalid from the first new chunk until commitTabPage() durably records
      // the exact final label set.
      this.completedTabPages.delete(tabId);

      if (options.persistChanges !== false) {
        await this.saveIndex();
        await this.saveDocumentMappings();
      }

      const invariantFailure =
        options.verifyInvariant === false
          ? null
          : this.activeLabelInvariantFailure(
              this.documents.keys(),
              this.nextLabel,
            );
      if (invariantFailure) {
        // Recovery now owns the whole derived index. Do not run the ordinary
        // single-label rollback against the replacement index in the catch
        // path below.
        pointAdded = false;
        const invariantError = new Error(
          `Vector add violated the active-label invariant: ${invariantFailure}`,
        );
        try {
          await this.replaceUnsafePersistedIndexWithEmpty(
            invariantError.message,
          );
        } catch (resetError) {
          throw new AggregateError(
            [invariantError, resetError],
            `Vector add for label ${label} left an unsafe state that could not be reset`,
          );
        }
        throw invariantError;
      }

      console.log(
        `VectorDatabase: Successfully added document ${documentId} with label ${label}`,
      );
      return label;
    } catch (error) {
      console.error("VectorDatabase: Failed to add document:", error);
      console.error("VectorDatabase: Embedding info:", {
        type: typeof embedding,
        constructor: embedding?.constructor?.name,
        length: embedding?.length,
        isFloat32Array: embedding instanceof Float32Array,
        firstFewValues: embedding ? Array.from(embedding.slice(0, 5)) : null,
      });
      if (error instanceof HnswIndexPersistenceUncertainError) {
        const failure = cleanupError(
          "persist added vector index with unknown outcome",
          error,
        );
        this.unsafeMutationState = failure;
        this.unsafeIndexPersistenceOutcome = true;
        throw failure;
      }
      if (pointAdded && label !== null) {
        await this.rollbackAddedDocument(label, tabId, error);
      } else if (addPointFailedAmbiguously && label !== null) {
        await this.recoverAmbiguousAddPointFailure(label, tabId, error);
      }
      throw error;
    }
  }

  private reserveNextLabel(): number {
    if (
      !isNonNegativeSafeInteger(this.nextLabel) ||
      this.nextLabel >= MAX_HNSW_LABEL
    ) {
      throw new Error("HNSW label space is exhausted or invalid");
    }
    const label = this.nextLabel;
    this.nextLabel += 1;
    return label;
  }

  private async recoverAmbiguousAddPointFailure(
    label: number,
    tabId: number,
    originalError: unknown,
  ): Promise<void> {
    let labels: ReturnType<VectorDatabase["inspectHnswActiveLabels"]>;
    try {
      labels = this.inspectHnswActiveLabels();
    } catch (inspectionError) {
      await this.resetAfterAmbiguousAddPointFailure(
        label,
        originalError,
        inspectionError,
      );
      return;
    }

    if (labels.activeLabels.has(label)) {
      await this.rollbackAddedDocument(label, tabId, originalError);
      return;
    }

    const invariantFailure = this.activeLabelInvariantFailure(
      this.documents.keys(),
      this.nextLabel,
    );
    if (invariantFailure) {
      await this.resetAfterAmbiguousAddPointFailure(
        label,
        originalError,
        new Error(invariantFailure),
      );
      return;
    }

    // The label is either absent or already tombstoned. Persist both stores so
    // a worker restart cannot reuse this ambiguous label or resurrect a native
    // mutation that became visible only after addPoint threw.
    const persistenceFailures: Error[] = [];
    try {
      await this.saveIndex();
    } catch (error) {
      if (error instanceof HnswIndexPersistenceUncertainError) {
        this.unsafeIndexPersistenceOutcome = true;
      }
      persistenceFailures.push(
        cleanupError("persist ambiguous vector index recovery", error),
      );
    }
    try {
      await this.saveDocumentMappings();
    } catch (error) {
      persistenceFailures.push(
        cleanupError("persist ambiguous vector mapping recovery", error),
      );
    }
    if (persistenceFailures.length > 0) {
      const failure = new AggregateError(
        [
          cleanupError("original vector add failure", originalError),
          ...persistenceFailures,
        ],
        `Vector add for label ${label} failed and its ambiguous state could not be persisted`,
      );
      this.unsafeMutationState = failure;
      throw failure;
    }
  }

  private async resetAfterAmbiguousAddPointFailure(
    label: number,
    originalError: unknown,
    stateError: unknown,
  ): Promise<void> {
    try {
      await this.replaceUnsafePersistedIndexWithEmpty(
        `addPoint for label ${label} threw and its resulting state could not be verified: ${errorMessage(stateError)}`,
      );
    } catch (resetError) {
      const failure = new AggregateError(
        [
          cleanupError("original vector add failure", originalError),
          cleanupError("inspect ambiguous addPoint state", stateError),
          resetError,
        ],
        `Vector add for label ${label} failed and its ambiguous state could not be reset`,
      );
      this.unsafeMutationState = failure;
      throw failure;
    }
  }

  private async rollbackAddedDocument(
    label: number,
    tabId: number,
    originalError: unknown,
  ): Promise<void> {
    this.removeLabelFromMappings(label, tabId);
    const rollbackFailures: Error[] = [];

    try {
      this.index.markDelete(label);
    } catch (error) {
      rollbackFailures.push(
        cleanupError(`mark vector ${label} deleted`, error),
      );
    }

    try {
      await this.saveIndex();
    } catch (error) {
      if (error instanceof HnswIndexPersistenceUncertainError) {
        this.unsafeIndexPersistenceOutcome = true;
      }
      rollbackFailures.push(
        cleanupError("persist rolled-back vector index", error),
      );
    }

    try {
      await this.saveDocumentMappings();
    } catch (error) {
      rollbackFailures.push(
        cleanupError("persist rolled-back vector mappings", error),
      );
    }

    if (rollbackFailures.length > 0) {
      const failure = new AggregateError(
        [
          cleanupError("original vector add failure", originalError),
          ...rollbackFailures,
        ],
        `Vector add for label ${label} failed and rollback did not complete`,
      );
      this.unsafeMutationState = failure;
      throw failure;
    }

    const invariantFailure = this.activeLabelInvariantFailure(
      this.documents.keys(),
      this.nextLabel,
    );
    if (invariantFailure) {
      try {
        await this.replaceUnsafePersistedIndexWithEmpty(
          `vector add rollback left an unsafe active-label state: ${invariantFailure}`,
        );
      } catch (resetError) {
        const failure = new AggregateError(
          [
            cleanupError("original vector add failure", originalError),
            resetError,
          ],
          `Vector add for label ${label} failed and its unsafe rollback state could not be reset`,
        );
        this.unsafeMutationState = failure;
        throw failure;
      }
    }
  }

  private async rollbackAddedDocuments(
    labels: readonly number[],
    tabId: number,
    originalError: unknown,
  ): Promise<void> {
    const rollbackFailures: Error[] = [];
    for (const label of [...labels].reverse()) {
      if (!this.documents.has(label)) continue;
      this.removeLabelFromMappings(label, tabId);
      try {
        this.index.markDelete(label);
      } catch (error) {
        rollbackFailures.push(
          cleanupError(`mark batched vector ${label} deleted`, error),
        );
      }
    }

    try {
      await this.saveIndex();
    } catch (error) {
      if (error instanceof HnswIndexPersistenceUncertainError) {
        this.unsafeIndexPersistenceOutcome = true;
      }
      rollbackFailures.push(
        cleanupError("persist rolled-back vector page index", error),
      );
    }
    try {
      await this.saveDocumentMappings();
    } catch (error) {
      rollbackFailures.push(
        cleanupError("persist rolled-back vector page mappings", error),
      );
    }

    if (rollbackFailures.length > 0) {
      const failure = new AggregateError(
        [
          cleanupError("original vector page add failure", originalError),
          ...rollbackFailures,
        ],
        `Vector page for tab ${tabId} failed and rollback did not complete`,
      );
      this.unsafeMutationState = failure;
      throw failure;
    }

    const invariantFailure = this.activeLabelInvariantFailure(
      this.documents.keys(),
      this.nextLabel,
    );
    if (invariantFailure) {
      try {
        await this.replaceUnsafePersistedIndexWithEmpty(
          `vector page rollback left an unsafe active-label state: ${invariantFailure}`,
        );
      } catch (resetError) {
        const failure = new AggregateError(
          [
            cleanupError("original vector page add failure", originalError),
            resetError,
          ],
          `Vector page for tab ${tabId} failed and its unsafe rollback state could not be reset`,
        );
        this.unsafeMutationState = failure;
        throw failure;
      }
    }
  }

  private removeLabelFromMappings(label: number, tabId: number): void {
    this.completedTabPages.delete(tabId);
    this.documents.delete(label);
    const labels = this.tabDocuments.get(tabId);
    if (!labels) return;
    labels.delete(label);
    if (labels.size === 0) this.tabDocuments.delete(tabId);
  }

  /**
   * Search similar documents
   */
  public async search(
    queryEmbedding: Float32Array,
    topK: number = 10,
  ): Promise<SearchResult[]> {
    const querySnapshot = new Float32Array(queryEmbedding);
    if (!this.isInitialized) {
      await this.initialize();
    }

    return this.enqueueMutation(() => this.searchInternal(querySnapshot, topK));
  }

  private async searchInternal(
    queryEmbedding: Float32Array,
    topK: number,
  ): Promise<SearchResult[]> {
    try {
      this.assertSafeMutationState();
      // Validate query vector
      if (!queryEmbedding || queryEmbedding.length !== this.config.dimension) {
        throw new Error(
          `Invalid query embedding dimension: expected ${this.config.dimension}, got ${queryEmbedding?.length || 0}`,
        );
      }

      // Check if query vector contains invalid values
      for (let i = 0; i < queryEmbedding.length; i++) {
        if (!isFinite(queryEmbedding[i])) {
          throw new Error(
            `Invalid query embedding value at index ${i}: ${queryEmbedding[i]}`,
          );
        }
      }

      console.log(
        `VectorDatabase: Searching with query embedding dimension: ${queryEmbedding.length}, topK: ${topK}`,
      );

      // Only a page whose exact label set and identity have crossed the durable
      // completion boundary is searchable. This also makes an HNSW index that
      // contains only deleted/tombstoned points a valid empty search state,
      // without trying to resurrect document mappings from persistence.
      const searchableLabels = this.collectSearchableLabels(Date.now());
      if (searchableLabels.size === 0) {
        console.log(
          "VectorDatabase: No durably completed pages are searchable",
        );
        return [];
      }

      // Check if index is empty
      const currentCount = this.index.getCurrentCount();
      if (currentCount === 0) {
        console.log("VectorDatabase: Index is empty, returning no results");
        return [];
      }

      console.log(`VectorDatabase: Index contains ${currentCount} vectors`);

      // Process query vector according to hnswlib-wasm-static emscripten binding requirements
      let queryVector;
      let searchResult;
      const completedPageFilter = (label: number) =>
        searchableLabels.has(label);

      try {
        // Method 1: Try using VectorFloat constructor (if available)
        if (globalHnswlib && globalHnswlib.VectorFloat) {
          console.log("VectorDatabase: Using VectorFloat for search query");
          queryVector = new globalHnswlib.VectorFloat();
          try {
            // Add elements to VectorFloat one by one
            for (let i = 0; i < queryEmbedding.length; i++) {
              queryVector.push_back(queryEmbedding[i]);
            }
            searchResult = this.index.searchKnn(
              queryVector,
              topK,
              completedPageFilter,
            );
          } finally {
            // Embind allocations must be released before a failed VectorFloat
            // search falls back to a JS typed/plain array.
            if (typeof queryVector.delete === "function") queryVector.delete();
            queryVector = null;
          }
        } else {
          // Method 2: Use plain JS array (fallback)
          console.log("VectorDatabase: Using plain JS array for search query");
          const queryArray = Array.from(queryEmbedding);
          searchResult = this.index.searchKnn(
            queryArray,
            topK,
            completedPageFilter,
          );
        }
      } catch (vectorError) {
        console.error(
          "VectorDatabase: VectorFloat search failed, trying alternatives:",
          vectorError,
        );

        // Method 3: Try passing Float32Array directly
        try {
          console.log(
            "VectorDatabase: Trying Float32Array directly for search",
          );
          searchResult = this.index.searchKnn(
            queryEmbedding,
            topK,
            completedPageFilter,
          );
        } catch (float32Error) {
          console.error(
            "VectorDatabase: Float32Array search failed:",
            float32Error,
          );

          // Method 4: Last resort - use spread operator
          console.log(
            "VectorDatabase: Trying spread operator for search as last resort",
          );
          searchResult = this.index.searchKnn(
            [...queryEmbedding],
            topK,
            completedPageFilter,
          );
        }
      }

      const results: SearchResult[] = [];

      console.log(
        `VectorDatabase: Processing ${searchResult.neighbors.length} search neighbors`,
      );
      console.log(
        `VectorDatabase: Available documents in mapping: ${this.documents.size}`,
      );
      console.log(
        `VectorDatabase: Index current count: ${this.index.getCurrentCount()}`,
      );

      for (let i = 0; i < searchResult.neighbors.length; i++) {
        const label = searchResult.neighbors[i];
        const distance = searchResult.distances[i];
        const similarity = 1 - distance; // Convert cosine distance to similarity

        console.log(
          `VectorDatabase: Processing neighbor ${i}: label=${label}, distance=${distance}, similarity=${similarity}`,
        );

        // Find corresponding document by label
        const document = this.findDocumentByLabel(label);
        const completion = document
          ? this.completedTabPages.get(document.tabId)
          : undefined;
        if (
          document &&
          searchableLabels.has(label) &&
          completion?.labels.includes(label) &&
          document.url === completion.url &&
          document.title === completion.title
        ) {
          console.log(
            `VectorDatabase: Found document for label ${label}: ${document.id}`,
          );
          results.push({
            document: cloneVectorDocument(document),
            similarity,
            distance,
          });
        } else {
          console.warn(`VectorDatabase: No document found for label ${label}`);

          // Detailed debug information
          if (i < 5) {
            // Only show detailed info for first 5 neighbors to avoid log spam
            console.warn(
              `VectorDatabase: Available labels (first 20): ${Array.from(this.documents.keys()).slice(0, 20).join(", ")}`,
            );
            console.warn(
              `VectorDatabase: Total available labels: ${this.documents.size}`,
            );
            console.warn(
              `VectorDatabase: Label type: ${typeof label}, Available label types: ${Array.from(
                this.documents.keys(),
              )
                .slice(0, 3)
                .map((k) => typeof k)
                .join(", ")}`,
            );
          }
        }
      }

      console.log(
        `VectorDatabase: Found ${results.length} search results out of ${searchResult.neighbors.length} neighbors`,
      );

      // If no results found but index has data, indicates label mismatch
      if (results.length === 0 && searchResult.neighbors.length > 0) {
        console.error(
          "VectorDatabase: Label mismatch detected! Index has vectors but no matching documents found.",
        );
        console.error(
          "VectorDatabase: This usually indicates the index and document mappings are out of sync.",
        );
        console.error(
          "VectorDatabase: Consider rebuilding the index to fix this issue.",
        );

        // Provide some diagnostic information
        const sampleLabels = searchResult.neighbors.slice(0, 5);
        const availableLabels = Array.from(this.documents.keys()).slice(0, 5);
        console.error("VectorDatabase: Sample search labels:", sampleLabels);
        console.error(
          "VectorDatabase: Sample available labels:",
          availableLabels,
        );
      }

      return results.sort((a, b) => b.similarity - a.similarity);
    } catch (error) {
      console.error("VectorDatabase: Search failed:", error);
      console.error("VectorDatabase: Query embedding info:", {
        type: typeof queryEmbedding,
        constructor: queryEmbedding?.constructor?.name,
        length: queryEmbedding?.length,
        isFloat32Array: queryEmbedding instanceof Float32Array,
        firstFewValues: queryEmbedding
          ? Array.from(queryEmbedding.slice(0, 5))
          : null,
      });
      throw error;
    }
  }

  private collectSearchableLabels(now: number): Set<number> {
    const labels = new Set<number>();
    const tabIds = new Set([
      ...this.tabDocuments.keys(),
      ...this.completedTabPages.keys(),
    ]);
    for (const tabId of tabIds) {
      const page = this.classifyTabPage(tabId, now);
      if (page.state !== "complete") continue;
      for (const label of page.labels) labels.add(label);
    }
    return labels;
  }

  /**
   * Remove all documents for a tab
   */
  public async removeTabDocuments(tabId: number): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return this.enqueueMutation(() =>
      this.removeTabDocumentsInternal(tabId, true),
    );
  }

  /**
   * Force a durable tab deletion even when an earlier attempt already removed
   * the in-memory labels. This is the completion boundary for persisted
   * invalidation/tombstone callers.
   */
  public async ensureTabDocumentsRemoved(tabId: number): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    return this.enqueueMutation(() =>
      this.removeTabDocumentsInternal(tabId, true),
    );
  }

  private async removeTabDocumentsInternal(
    tabId: number,
    forcePersistence: boolean,
  ): Promise<void> {
    if (this.unsafeIndexPersistenceOutcome) this.assertSafeMutationState();
    const documentLabels = Array.from(this.tabDocuments.get(tabId) ?? []);
    if (documentLabels.length === 0 && !forcePersistence) return;

    // Even a failed/partial deletion must no longer be restorable as a
    // complete page. Persisting this invalidation makes a later startup retry
    // the durable removal instead of hydrating stale content.
    this.completedTabPages.delete(tabId);

    const failures: Error[] = [];
    for (const label of documentLabels) {
      try {
        this.index.markDelete(label);
        this.removeLabelFromMappings(label, tabId);
      } catch (error) {
        failures.push(cleanupError(`mark vector ${label} deleted`, error));
      }
    }

    try {
      await this.saveIndex();
    } catch (error) {
      if (error instanceof HnswIndexPersistenceUncertainError) {
        const failure = cleanupError(
          "persist tab-deleted vector index with unknown outcome",
          error,
        );
        this.unsafeMutationState = failure;
        this.unsafeIndexPersistenceOutcome = true;
        throw failure;
      }
      failures.push(cleanupError("persist tab-deleted vector index", error));
    }

    let persistedMappingRevision: number | null = null;
    try {
      persistedMappingRevision = await this.saveDocumentMappings();
    } catch (error) {
      failures.push(cleanupError("persist tab-deleted vector mappings", error));
    }

    if (
      persistedMappingRevision !== null &&
      (forcePersistence || !this.tabDocuments.has(tabId))
    ) {
      try {
        await this.verifyTabAbsentFromPersistedMappings(
          tabId,
          persistedMappingRevision,
        );
      } catch (error) {
        failures.push(cleanupError("verify durable tab deletion", error));
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Vector documents for tab ${tabId} were not durably removed`,
      );
    }

    const invariantFailure = this.activeLabelInvariantFailure(
      this.documents.keys(),
      this.nextLabel,
    );
    if (invariantFailure) {
      // A force retry can encounter an HNSW point that was never represented
      // by the current mappings (for example after an interrupted cross-store
      // write). Never acknowledge the tombstone while such active vectors
      // remain. Replacing the whole derived index is the safe recovery.
      await this.replaceUnsafePersistedIndexWithEmpty(
        `tab ${tabId} deletion left an unsafe active-label state: ${invariantFailure}`,
      );
      console.warn(
        `VectorDatabase: Reset the complete vector index while removing tab ${tabId}`,
      );
      return;
    }

    // A forced deletion is an explicit recovery path for an earlier rollback
    // failure. Reaching this boundary means index, mappings, readback, and the
    // active-label invariant all agree again.
    this.unsafeMutationState = null;
    this.unsafeIndexPersistenceOutcome = false;

    console.log(
      `VectorDatabase: Removed ${documentLabels.length} documents for tab ${tabId}`,
    );
  }

  private async verifyTabAbsentFromPersistedMappings(
    tabId: number,
    expectedRevision: number,
  ): Promise<void> {
    const lookup = await this.lookupDocumentMappings();
    if (lookup.status !== "found") {
      throw new Error(
        lookup.status === "invalid"
          ? `Persisted vector mappings are invalid: ${lookup.reason}`
          : "Persisted vector mappings are missing",
      );
    }
    if (lookup.value.revision !== expectedRevision) {
      throw new Error(
        `Persisted vector mapping revision ${lookup.value.revision} does not match ${expectedRevision}`,
      );
    }
    if (
      lookup.value.documents.some(([, document]) => document.tabId === tabId) ||
      lookup.value.tabDocuments.some(
        ([persistedTabId]) => persistedTabId === tabId,
      ) ||
      lookup.value.completedTabPages.some(
        ([persistedTabId]) => persistedTabId === tabId,
      )
    ) {
      throw new Error(`Persisted vector mappings still contain tab ${tabId}`);
    }
  }

  /**
   * Persist the completion boundary for one fully indexed page. Only pages
   * with this exact durable marker may be restored after a worker restart.
   */
  public async commitTabPage(
    tabId: number,
    url: string,
    title: string,
  ): Promise<void> {
    if (!this.isInitialized) await this.initialize();
    return this.enqueueMutation(() =>
      this.commitTabPageInternal(tabId, url, title),
    );
  }

  private async commitTabPageInternal(
    tabId: number,
    url: string,
    title: string,
  ): Promise<void> {
    this.assertSafeMutationState();
    const labels = Array.from(this.tabDocuments.get(tabId) ?? []).sort(
      (left, right) => left - right,
    );
    if (labels.length === 0) {
      throw new Error(`Cannot commit an empty vector page for tab ${tabId}`);
    }
    for (const label of labels) {
      const document = this.documents.get(label);
      if (
        !document ||
        document.tabId !== tabId ||
        document.url !== url ||
        document.title !== title
      ) {
        throw new Error(
          `Cannot commit mixed or inconsistent vector page for tab ${tabId}`,
        );
      }
    }

    const completion: PersistedTabPageCompletion = {
      pageKey: `${url}\u0000${title}`,
      url,
      title,
      labels,
      expectedCount: labels.length,
    };
    // Keep the candidate private until both persistence and exact readback
    // succeed. Synchronous stats must never observe a completion that only
    // exists in an in-flight storage write.
    const candidateCompletions = new Map(this.completedTabPages);
    candidateCompletions.set(tabId, completion);
    try {
      const revision = await this.saveDocumentMappings(candidateCompletions);
      await this.verifyTabPageCompletionInPersistedMappings(
        tabId,
        completion,
        revision,
      );
      this.completedTabPages.set(tabId, completion);
    } catch (error) {
      // Never expose or leave an unverified marker behind. Persisting the
      // invalidation means a worker crash before the caller's full tab cleanup
      // still restarts into repair, never a falsely completed page.
      this.completedTabPages.delete(tabId);
      try {
        await this.saveDocumentMappings();
      } catch (invalidationError) {
        throw new AggregateError(
          [
            cleanupError("commit page completion", error),
            cleanupError(
              "persist failed page-completion invalidation",
              invalidationError,
            ),
          ],
          `Vector page completion for tab ${tabId} failed and its invalidation did not persist`,
        );
      }
      throw error;
    }
  }

  private async verifyTabPageCompletionInPersistedMappings(
    tabId: number,
    expected: PersistedTabPageCompletion,
    expectedRevision: number,
  ): Promise<void> {
    const lookup = await this.lookupDocumentMappings();
    if (lookup.status !== "found") {
      throw new Error(
        lookup.status === "invalid"
          ? `Persisted vector mappings are invalid: ${lookup.reason}`
          : "Persisted vector mappings are missing",
      );
    }
    if (lookup.value.revision !== expectedRevision) {
      throw new Error(
        `Persisted vector mapping revision ${lookup.value.revision} does not match ${expectedRevision}`,
      );
    }
    const persisted = lookup.value.completedTabPages.find(
      ([persistedTabId]) => persistedTabId === tabId,
    )?.[1];
    if (
      !persisted ||
      persisted.pageKey !== expected.pageKey ||
      persisted.url !== expected.url ||
      persisted.title !== expected.title ||
      persisted.expectedCount !== expected.expectedCount ||
      persisted.labels.length !== expected.labels.length ||
      persisted.labels.some((label, index) => label !== expected.labels[index])
    ) {
      throw new Error(
        `Persisted vector mappings did not retain completion for tab ${tabId}`,
      );
    }
  }

  /**
   * Return a defensive, stable snapshot suitable for restart hydration. Tabs
   * without an exact completion marker are repair candidates, never pages.
   */
  public async inspectTabPageState(): Promise<TabPageStateInspection> {
    if (!this.isInitialized) await this.initialize();
    return this.enqueueMutation(() =>
      Promise.resolve(this.inspectTabPageStateInternal()),
    );
  }

  /**
   * Inspect one tab against the only publishable page boundary: an exact,
   * durably verified completion whose entire label set is still within the
   * configured retention window.
   */
  public async inspectTabPageCompletion(
    tabId: number,
  ): Promise<TabPageCompletionInspection> {
    if (!this.isInitialized) await this.initialize();
    return this.enqueueMutation(() => {
      this.assertSafeMutationState();
      return Promise.resolve(
        this.toPublicTabPageCompletion(
          tabId,
          this.classifyTabPage(tabId, Date.now()),
        ),
      );
    });
  }

  private inspectTabPageStateInternal(): TabPageStateInspection {
    this.assertSafeMutationState();
    const completedPages: CompletedTabPageIdentity[] = [];
    const repairTabs = new Set<number>();
    const now = Date.now();
    const allTabIds = new Set([
      ...this.tabDocuments.keys(),
      ...this.completedTabPages.keys(),
    ]);

    for (const tabId of [...allTabIds].sort((left, right) => left - right)) {
      const page = this.classifyTabPage(tabId, now);
      if (page.state === "repair-required") {
        repairTabs.add(tabId);
        continue;
      }
      if (page.state === "complete") {
        completedPages.push(this.completedPageIdentity(tabId, page.completion));
      }
    }

    return {
      completedPages,
      repairTabIds: [...repairTabs].sort((left, right) => left - right),
    };
  }

  private classifyTabPage(
    tabId: number,
    now: number,
  ): InternalTabPageCompletionInspection {
    const hasTabState =
      this.tabDocuments.has(tabId) || this.completedTabPages.has(tabId);
    if (!hasTabState) return { state: "absent" };

    const completedPage = this.getExactCompletedPage(tabId);
    if (!completedPage) {
      return { state: "repair-required", reason: "incomplete" };
    }

    const cutoff = this.retentionCutoff(now);
    if (
      cutoff !== null &&
      completedPage.labels.some(
        (label) => this.documents.get(label)!.timestamp < cutoff,
      )
    ) {
      // Page identity is atomic. Never expose only the newer chunks of a page
      // whose label set crossed the retention boundary.
      return { state: "repair-required", reason: "expired" };
    }

    return {
      state: "complete",
      completion: completedPage.completion,
      labels: completedPage.labels,
    };
  }

  private retentionCutoff(now: number): number | null {
    const days = this.config.maxRetentionDays;
    if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
      return null;
    }
    const retentionMs = days * 24 * 60 * 60 * 1000;
    if (!Number.isFinite(retentionMs)) return null;
    return now - retentionMs;
  }

  private completedPageIdentity(
    tabId: number,
    completion: PersistedTabPageCompletion,
  ): CompletedTabPageIdentity {
    return {
      tabId,
      pageKey: completion.pageKey,
      url: completion.url,
      title: completion.title,
      expectedCount: completion.expectedCount,
    };
  }

  private toPublicTabPageCompletion(
    tabId: number,
    state: InternalTabPageCompletionInspection,
  ): TabPageCompletionInspection {
    if (state.state !== "complete") return { ...state };
    return {
      state: "complete",
      page: this.completedPageIdentity(tabId, state.completion),
    };
  }

  private getExactCompletedPage(tabId: number): {
    completion: PersistedTabPageCompletion;
    labels: number[];
  } | null {
    const labels = Array.from(this.tabDocuments.get(tabId) ?? []).sort(
      (left, right) => left - right,
    );
    const completion = this.completedTabPages.get(tabId);
    if (labels.length === 0 || !completion) return null;

    const labelsMatch =
      completion.expectedCount === labels.length &&
      completion.labels.length === labels.length &&
      completion.labels.every((label, index) => label === labels[index]);
    const identityMatches = labels.every((label) => {
      const document = this.documents.get(label);
      return (
        document?.tabId === tabId &&
        document.url === completion.url &&
        document.title === completion.title
      );
    });
    if (
      !labelsMatch ||
      !identityMatches ||
      completion.pageKey !== `${completion.url}\u0000${completion.title}`
    ) {
      return null;
    }

    return { completion, labels };
  }

  /**
   * Get database statistics
   */
  public getStats(): VectorDatabaseStats {
    const searchableLabels = this.collectSearchableLabels(Date.now());
    const completedTabs = new Set<number>();
    for (const label of searchableLabels) {
      const document = this.documents.get(label);
      if (document) completedTabs.add(document.tabId);
    }
    return {
      totalDocuments: searchableLabels.size,
      totalTabs: completedTabs.size,
      completedPages: completedTabs.size,
      indexSize: this.calculateStorageSize(),
      isInitialized: this.isInitialized && this.unsafeMutationState === null,
    };
  }

  /**
   * Calculate actual storage size (bytes)
   */
  private calculateStorageSize(): number {
    let totalSize = 0;

    try {
      // 1. Calculate document map size
      const documentsSize = this.calculateDocumentMappingsSize();
      totalSize += documentsSize;

      // 2. Calculate vector data size
      const vectorsSize = this.calculateVectorsSize();
      totalSize += vectorsSize;

      // 3. Estimate index structure size
      const indexStructureSize = this.calculateIndexStructureSize();
      totalSize += indexStructureSize;

      console.log(
        `VectorDatabase: Storage size breakdown - Documents: ${documentsSize}, Vectors: ${vectorsSize}, Index: ${indexStructureSize}, Total: ${totalSize} bytes`,
      );
    } catch (error) {
      console.warn("VectorDatabase: Failed to calculate storage size:", error);
      // Return an estimate based on document count
      totalSize = this.documents.size * 1024; // Estimate 1KB per document
    }

    return totalSize;
  }

  /**
   * Calculate document mappings size
   */
  private calculateDocumentMappingsSize(): number {
    let size = 0;

    // Calculate documents Map size
    for (const [label, document] of this.documents.entries()) {
      // label (number): 8 bytes
      size += 8;

      // document object
      size += this.calculateObjectSize(document);
    }

    // Calculate tabDocuments Map size
    for (const [tabId, labels] of this.tabDocuments.entries()) {
      // tabId (number): 8 bytes
      size += 8;

      // Set of labels: 8 bytes per label + Set overhead
      size += labels.size * 8 + 32; // 32 bytes Set overhead
    }

    return size;
  }

  /**
   * Calculate vectors data size
   */
  private calculateVectorsSize(): number {
    const documentCount = this.documents.size;
    const dimension = this.config.dimension;

    // Each vector: dimension * 4 bytes (Float32)
    const vectorSize = dimension * 4;

    return documentCount * vectorSize;
  }

  /**
   * Estimate index structure size
   */
  private calculateIndexStructureSize(): number {
    const documentCount = this.documents.size;

    if (documentCount === 0) return 0;

    // HNSW index size estimation
    // Based on papers and actual testing, HNSW index size is about 20-40% of vector data
    const vectorsSize = this.calculateVectorsSize();
    const indexOverhead = Math.floor(vectorsSize * 0.3); // 30% overhead

    // Additional graph structure overhead
    const graphOverhead = documentCount * 64; // About 64 bytes graph structure overhead per node

    return indexOverhead + graphOverhead;
  }

  /**
   * Calculate object size (rough estimation)
   */
  private calculateObjectSize(obj: any): number {
    let size = 0;

    try {
      const jsonString = JSON.stringify(obj);
      // UTF-8 encoding, most characters 1 byte, Chinese etc 3 bytes, average 2 bytes
      size = jsonString.length * 2;
    } catch (error) {
      // If JSON serialization fails, use default estimation
      size = 512; // Default 512 bytes
    }

    return size;
  }

  /**
   * Clear entire database
   */
  public async clear(options: VectorDatabaseClearOptions = {}): Promise<void> {
    if (this.isInitializing && this.initPromise) {
      await this.initPromise;
    }

    const persistIndex = options.persistIndex !== false;
    return this.enqueueMutation(() => this.clearInternal(persistIndex));
  }

  private async clearInternal(persistIndex: boolean): Promise<void> {
    if (persistIndex && this.unsafeIndexPersistenceOutcome) {
      this.assertSafeMutationState();
    }
    if (!persistIndex && this.unsafeIndexPersistenceOutcome) {
      // Privacy/model recovery is the only operation allowed after an
      // uncertain write, but it still must not race that write's late IDBFS
      // completion. If the manager never becomes idle, fail closed instead of
      // starting a second filesystem operation.
      await enqueueHnswFileSystemOperation(() =>
        waitForGlobalHnswFileSystemIdle(),
      );
    }
    console.log("VectorDatabase: Starting complete database clear...");

    this.documents.clear();
    this.tabDocuments.clear();
    this.completedTabPages.clear();
    this.nextLabel = 0;

    const failures: Error[] = [];
    let emptyIndexPersisted = false;

    if (this.isInitialized) {
      try {
        if (!globalHnswlib) throw new Error("HNSW module is not initialized");

        // hnswlib-wasm-static exposes no deleteFile/deleteIndex APIs. Calling
        // initIndex on the existing handle releases its old native index and
        // avoids leaking an Embind/C++ handle during replacement.
        this.index.initIndex(
          this.config.maxElements,
          this.config.M,
          this.config.efConstruction,
          200,
        );
        this.index.setEfSearch(this.config.efSearch);
        if (this.index.getCurrentCount() !== 0) {
          throw new Error("New HNSW index is unexpectedly non-empty");
        }

        if (persistIndex) {
          // writeIndex starts syncFS(false) internally and returns undefined in
          // the shipped runtime. Do not start a second overlapping sync.
          await persistHnswIndex(this.index, this.config.indexFileName);
          emptyIndexPersisted = true;
        }

        if (this.index.getCurrentCount() !== 0) {
          throw new Error(
            "HNSW index still contains vectors after replacement",
          );
        }
      } catch (error) {
        if (error instanceof HnswIndexPersistenceUncertainError) {
          this.unsafeIndexPersistenceOutcome = true;
        }
        failures.push(cleanupError("replace active HNSW index", error));
      }
    }

    try {
      await IndexedDBHelper.deleteData(this.config.indexFileName);
    } catch (error) {
      failures.push(cleanupError("delete vector document mappings", error));
    }

    const storageKey = `hnswlib_document_mappings_${this.config.indexFileName}`;
    try {
      await chrome.storage.local.remove([storageKey]);
      if (typeof chrome.storage.local.get === "function") {
        const remaining = await chrome.storage.local.get([storageKey]);
        if (Object.prototype.hasOwnProperty.call(remaining, storageKey)) {
          throw new Error(`Vector storage backup still exists: ${storageKey}`);
        }
      }
    } catch (error) {
      failures.push(cleanupError("remove vector storage backup", error));
    }

    if (persistIndex && emptyIndexPersisted && failures.length === 0) {
      try {
        await this.saveDocumentMappings();
      } catch (error) {
        failures.push(cleanupError("persist empty vector metadata", error));
      }
    } else if (!persistIndex) {
      this.mappingRevision = 0;
    }

    if (failures.length > 0) {
      const failure = new AggregateError(
        failures,
        "Vector database clear did not complete",
      );
      this.unsafeMutationState = failure;
      throw failure;
    }

    try {
      if (this.isInitialized) {
        this.assertActiveLabelInvariant(this.documents.keys(), this.nextLabel);
      }
      this.unsafeMutationState = null;
      this.unsafeIndexPersistenceOutcome = false;
    } catch (error) {
      const failure = cleanupError(
        "verify active-label invariant after vector clear",
        error,
      );
      this.unsafeMutationState = failure;
      throw failure;
    }

    console.log(
      "VectorDatabase: Complete database clear finished successfully",
    );
  }

  /**
   * Rebuild the current native handle around whole durable pages. The caller
   * must hold ContentIndexer's durable index-rebuild marker for this complete
   * operation, including any rollback.
   */
  public async compactForPendingAdd(): Promise<VectorCompactionResult> {
    if (!this.isInitialized) await this.initialize();
    return this.enqueueMutation(() => this.compactForPendingAddInternal());
  }

  private async compactForPendingAddInternal(): Promise<VectorCompactionResult> {
    this.assertSafeMutationState();
    const now = Date.now();
    const original = this.captureVectorState();
    const originalPages = this.completedPageIdentitiesForCurrentState(now);
    let plan: VectorCompactionPlan | null;
    try {
      plan = this.planVectorCompaction(original, now);
    } catch (error) {
      return {
        compacted: false,
        evictedTabIds: [],
        retainedCompletedPages: originalPages,
        failure: cleanupError("plan vector compaction", error),
      };
    }

    if (!plan) {
      return {
        compacted: false,
        evictedTabIds: [],
        retainedCompletedPages: originalPages,
      };
    }

    try {
      this.rebuildNativeIndex(plan.candidate);
    } catch (candidateBuildError) {
      try {
        this.rebuildNativeIndex(original);
      } catch (restoreError) {
        const failure = new AggregateError(
          [
            cleanupError("build compacted vector index", candidateBuildError),
            cleanupError(
              "restore original in-memory vector index",
              restoreError,
            ),
          ],
          "Vector compaction candidate failed and the original in-memory index could not be restored",
        );
        this.unsafeMutationState = failure;
        throw failure;
      }
      return {
        compacted: false,
        evictedTabIds: [],
        retainedCompletedPages: originalPages,
        failure: cleanupError(
          "build compacted vector index",
          candidateBuildError,
        ),
      };
    }

    try {
      await this.saveIndex();
    } catch (candidateIndexError) {
      if (candidateIndexError instanceof HnswIndexPersistenceUncertainError) {
        const failure = cleanupError(
          "persist compacted vector index with unknown outcome",
          candidateIndexError,
        );
        this.unsafeMutationState = failure;
        this.unsafeIndexPersistenceOutcome = true;
        throw failure;
      }
      try {
        this.rebuildNativeIndex(original);
      } catch (restoreError) {
        const failure = new AggregateError(
          [
            cleanupError("persist compacted vector index", candidateIndexError),
            cleanupError(
              "restore original in-memory vector index",
              restoreError,
            ),
          ],
          "Vector compaction index write failed and the original in-memory index could not be restored",
        );
        this.unsafeMutationState = failure;
        throw failure;
      }
      return {
        compacted: false,
        evictedTabIds: [],
        retainedCompletedPages: originalPages,
        failure: cleanupError(
          "persist compacted vector index",
          candidateIndexError,
        ),
      };
    }

    this.applyVectorState(plan.candidate);
    try {
      const revision = await this.saveDocumentMappings();
      await this.verifyPersistedVectorState(plan.candidate, revision);
      this.assertActiveLabelInvariant(
        plan.candidate.documents.keys(),
        plan.candidate.nextLabel,
      );
      this.unsafeMutationState = null;
      this.unsafeIndexPersistenceOutcome = false;
      return {
        compacted: true,
        evictedTabIds: [...plan.evictedTabIds],
        retainedCompletedPages: plan.retainedCompletedPages.map((page) => ({
          ...page,
        })),
      };
    } catch (candidateMappingError) {
      return this.rollbackPersistedCompaction(
        original,
        originalPages,
        candidateMappingError,
      );
    }
  }

  private planVectorCompaction(
    original: VectorStateSnapshot,
    now: number,
  ): VectorCompactionPlan | null {
    this.assertActiveLabelInvariant(
      original.documents.keys(),
      original.nextLabel,
    );
    const { usedLabels } = this.inspectHnswActiveLabels();
    const underPressure = usedLabels.size + 1 > this.config.maxElements;
    const cutoff = this.retentionCutoff(now);
    const pages: VectorCompactionPage[] = [];
    const completeLabels = new Set<number>();

    const tabIds = new Set([
      ...original.tabDocuments.keys(),
      ...original.completedTabPages.keys(),
    ]);
    for (const tabId of tabIds) {
      const exact = this.getExactCompletedPage(tabId);
      if (!exact) continue;
      const newestTimestamp = Math.max(
        ...exact.labels.map(
          (label) => original.documents.get(label)!.timestamp,
        ),
      );
      const expired =
        cutoff !== null &&
        exact.labels.some(
          (label) => original.documents.get(label)!.timestamp < cutoff,
        );
      pages.push({
        tabId,
        pageKey: exact.completion.pageKey,
        labels: [...exact.labels],
        newestTimestamp,
        expired,
      });
      for (const label of exact.labels) completeLabels.add(label);
    }

    const expiredPages = pages.filter((page) => page.expired);
    if (!underPressure && expiredPages.length === 0) return null;

    const oldestFirst = (
      left: VectorCompactionPage,
      right: VectorCompactionPage,
    ) =>
      left.newestTimestamp - right.newestTimestamp ||
      left.tabId - right.tabId ||
      left.pageKey.localeCompare(right.pageKey);
    expiredPages.sort(oldestFirst);
    const livePages = pages.filter((page) => !page.expired).sort(oldestFirst);
    const evictedPages: VectorCompactionPage[] = [...expiredPages];
    const evictedLabels = new Set(evictedPages.flatMap((page) => page.labels));
    let retainedCount = original.documents.size - evictedLabels.size;

    if (underPressure) {
      const headroom = Math.max(1, Math.ceil(this.config.maxElements * 0.2));
      const targetCount = Math.max(0, this.config.maxElements - headroom);
      for (const page of livePages) {
        if (retainedCount <= targetCount) break;
        evictedPages.push(page);
        for (const label of page.labels) evictedLabels.add(label);
        retainedCount -= page.labels.length;
      }
      if (retainedCount > targetCount) {
        const protectedCount = [...original.documents.keys()].filter(
          (label) => !completeLabels.has(label),
        ).length;
        throw new VectorCompactionInsufficientCapacityError(
          protectedCount,
          targetCount,
        );
      }
    }

    const evictedTabs = new Set(evictedPages.map((page) => page.tabId));
    const candidateDocuments = new Map<number, VectorDocument>();
    for (const [label, document] of original.documents) {
      if (!evictedLabels.has(label)) {
        // VectorDocument and its embedding are immutable after add/load. Share
        // them across planning snapshots so a 100k-vector compaction does not
        // duplicate hundreds of megabytes of Float32Array data.
        candidateDocuments.set(label, document);
      }
    }
    const candidateTabDocuments = new Map<number, Set<number>>();
    for (const [tabId, labels] of original.tabDocuments) {
      const retainedLabels = [...labels].filter((label) =>
        candidateDocuments.has(label),
      );
      if (retainedLabels.length > 0) {
        candidateTabDocuments.set(tabId, new Set(retainedLabels));
      }
    }
    const candidateCompletions = new Map<number, PersistedTabPageCompletion>();
    for (const page of livePages) {
      if (evictedTabs.has(page.tabId)) continue;
      const completion = original.completedTabPages.get(page.tabId)!;
      candidateCompletions.set(page.tabId, {
        ...completion,
        labels: [...completion.labels],
      });
    }
    const candidate: VectorStateSnapshot = {
      documents: candidateDocuments,
      tabDocuments: candidateTabDocuments,
      completedTabPages: candidateCompletions,
      nextLabel: original.nextLabel,
    };
    const retainedCompletedPages = [...candidateCompletions.entries()]
      .sort(([left], [right]) => left - right)
      .map(([tabId, completion]) =>
        this.completedPageIdentity(tabId, completion),
      );

    return {
      candidate,
      evictedTabIds: [...evictedTabs].sort((left, right) => left - right),
      retainedCompletedPages,
    };
  }

  private captureVectorState(): VectorStateSnapshot {
    return {
      documents: new Map(this.documents),
      tabDocuments: new Map(
        [...this.tabDocuments.entries()].map(([tabId, labels]) => [
          tabId,
          new Set(labels),
        ]),
      ),
      completedTabPages: new Map(
        [...this.completedTabPages.entries()].map(([tabId, completion]) => [
          tabId,
          { ...completion, labels: [...completion.labels] },
        ]),
      ),
      nextLabel: this.nextLabel,
    };
  }

  private applyVectorState(state: VectorStateSnapshot): void {
    this.documents = new Map(state.documents);
    this.tabDocuments = new Map(
      [...state.tabDocuments.entries()].map(([tabId, labels]) => [
        tabId,
        new Set(labels),
      ]),
    );
    this.completedTabPages = new Map(
      [...state.completedTabPages.entries()].map(([tabId, completion]) => [
        tabId,
        { ...completion, labels: [...completion.labels] },
      ]),
    );
    this.nextLabel = state.nextLabel;
  }

  private rebuildNativeIndex(state: VectorStateSnapshot): void {
    this.index.initIndex(
      this.config.maxElements,
      this.config.M,
      this.config.efConstruction,
      200,
    );
    this.index.setEfSearch(this.config.efSearch);
    for (const [label, document] of [...state.documents.entries()].sort(
      ([left], [right]) => left - right,
    )) {
      this.addPointToRebuiltIndex(document.embedding, label);
    }
    this.assertActiveLabelInvariant(state.documents.keys(), state.nextLabel);
  }

  private addPointToRebuiltIndex(embedding: Float32Array, label: number): void {
    let ownedVector: any = null;
    try {
      let vector: any;
      if (globalHnswlib?.VectorFloat) {
        ownedVector = new globalHnswlib.VectorFloat();
        for (const value of embedding) ownedVector.push_back(value);
        vector = ownedVector;
      } else {
        vector = Array.from(embedding);
      }
      this.index.addPoint(vector, label, false);
    } finally {
      if (ownedVector && typeof ownedVector.delete === "function") {
        ownedVector.delete();
      }
    }
  }

  private completedPageIdentitiesForCurrentState(
    now: number,
  ): CompletedTabPageIdentity[] {
    const pages: CompletedTabPageIdentity[] = [];
    for (const tabId of [...this.completedTabPages.keys()].sort(
      (left, right) => left - right,
    )) {
      const state = this.classifyTabPage(tabId, now);
      if (state.state === "complete") {
        pages.push(this.completedPageIdentity(tabId, state.completion));
      }
    }
    return pages;
  }

  private async rollbackPersistedCompaction(
    original: VectorStateSnapshot,
    originalPages: CompletedTabPageIdentity[],
    candidateMappingError: unknown,
  ): Promise<VectorCompactionResult> {
    const rollbackFailures: Error[] = [];
    try {
      this.rebuildNativeIndex(original);
      await this.saveIndex();
    } catch (error) {
      if (error instanceof HnswIndexPersistenceUncertainError) {
        this.unsafeIndexPersistenceOutcome = true;
      }
      rollbackFailures.push(
        cleanupError("restore original persisted vector index", error),
      );
    }

    if (rollbackFailures.length === 0) {
      this.applyVectorState(original);
      try {
        const revision = await this.saveDocumentMappings();
        await this.verifyPersistedVectorState(original, revision);
        this.assertActiveLabelInvariant(
          original.documents.keys(),
          original.nextLabel,
        );
      } catch (error) {
        rollbackFailures.push(
          cleanupError("restore original persisted vector mappings", error),
        );
      }
    }

    if (rollbackFailures.length > 0) {
      const failure = new AggregateError(
        [
          cleanupError(
            "persist compacted vector mappings",
            candidateMappingError,
          ),
          ...rollbackFailures,
        ],
        "Vector compaction failed and its persisted rollback did not complete",
      );
      this.unsafeMutationState = failure;
      throw failure;
    }

    this.unsafeMutationState = null;
    this.unsafeIndexPersistenceOutcome = false;
    return {
      compacted: false,
      evictedTabIds: [],
      retainedCompletedPages: originalPages.map((page) => ({ ...page })),
      failure: cleanupError(
        "persist compacted vector mappings",
        candidateMappingError,
      ),
    };
  }

  private async verifyPersistedVectorState(
    expected: VectorStateSnapshot,
    expectedRevision: number,
  ): Promise<void> {
    const lookup = await this.lookupDocumentMappings();
    if (lookup.status !== "found") {
      throw new Error(
        lookup.status === "invalid"
          ? `Persisted vector mappings are invalid: ${lookup.reason}`
          : "Persisted vector mappings are missing",
      );
    }
    const actual = lookup.value;
    if (
      actual.revision !== expectedRevision ||
      actual.nextLabel !== expected.nextLabel ||
      actual.documents.length !== expected.documents.size ||
      actual.tabDocuments.length !== expected.tabDocuments.size ||
      actual.completedTabPages.length !== expected.completedTabPages.size
    ) {
      throw new Error("Persisted vector compaction metadata does not match");
    }

    const actualDocuments = new Map(actual.documents);
    const actualTabDocuments = new Map(actual.tabDocuments);
    const actualCompletions = new Map(actual.completedTabPages);
    for (const [label, expectedDocument] of expected.documents) {
      const actualDocument = actualDocuments.get(label);
      if (
        !actualDocument ||
        !this.vectorDocumentsEqual(actualDocument, expectedDocument)
      ) {
        throw new Error(`Persisted vector document ${label} does not match`);
      }
    }
    for (const [tabId, expectedLabels] of expected.tabDocuments) {
      const actualLabels = actualTabDocuments.get(tabId);
      const sortedExpected = [...expectedLabels].sort(
        (left, right) => left - right,
      );
      if (
        !actualLabels ||
        actualLabels.length !== sortedExpected.length ||
        actualLabels.some((label, index) => label !== sortedExpected[index])
      ) {
        throw new Error(`Persisted vector tab ${tabId} does not match`);
      }
    }
    for (const [tabId, expectedCompletion] of expected.completedTabPages) {
      const actualCompletion = actualCompletions.get(tabId);
      if (
        !actualCompletion ||
        actualCompletion.pageKey !== expectedCompletion.pageKey ||
        actualCompletion.url !== expectedCompletion.url ||
        actualCompletion.title !== expectedCompletion.title ||
        actualCompletion.expectedCount !== expectedCompletion.expectedCount ||
        actualCompletion.labels.length !== expectedCompletion.labels.length ||
        actualCompletion.labels.some(
          (label, index) => label !== expectedCompletion.labels[index],
        )
      ) {
        throw new Error(`Persisted vector completion ${tabId} does not match`);
      }
    }
  }

  private vectorDocumentsEqual(
    left: VectorDocument,
    right: VectorDocument,
  ): boolean {
    return (
      left.id === right.id &&
      left.tabId === right.tabId &&
      left.url === right.url &&
      left.title === right.title &&
      left.timestamp === right.timestamp &&
      left.chunk.text === right.chunk.text &&
      left.chunk.source === right.chunk.source &&
      left.chunk.index === right.chunk.index &&
      left.chunk.wordCount === right.chunk.wordCount &&
      left.embedding.length === right.embedding.length &&
      left.embedding.every((value, index) => value === right.embedding[index])
    );
  }

  // Private helper methods

  private generateDocumentId(tabId: number, chunkIndex: number): string {
    return `tab_${tabId}_chunk_${chunkIndex}_${Date.now()}`;
  }

  private findDocumentByLabel(label: number): VectorDocument | null {
    return this.documents.get(label) || null;
  }

  private async syncFileSystem(direction: "read" | "write"): Promise<void> {
    await syncGlobalHnswFileSystem(direction === "read");
    console.log(`VectorDatabase: Filesystem sync (${direction}) completed`);
  }

  private async saveIndex(): Promise<void> {
    await persistHnswIndex(this.index, this.config.indexFileName);
  }

  private saveDocumentMappings(
    completedTabPages: ReadonlyMap<number, PersistedTabPageCompletion> = this
      .completedTabPages,
  ): Promise<number> {
    const snapshot: Pick<
      PersistedVectorMappings,
      "documents" | "tabDocuments" | "completedTabPages" | "nextLabel"
    > = {
      documents: Array.from(
        this.documents.entries(),
        ([label, document]): [number, VectorDocument] => [
          label,
          {
            ...document,
            chunk: { ...document.chunk },
            embedding: new Float32Array(document.embedding),
          },
        ],
      ).sort(([left], [right]) => left - right),
      tabDocuments: Array.from(this.tabDocuments.entries())
        .map(([tabId, labels]): [number, number[]] => [
          tabId,
          Array.from(labels).sort((left, right) => left - right),
        ])
        .sort(([left], [right]) => left - right),
      completedTabPages: Array.from(completedTabPages.entries())
        .map(([tabId, completion]): [number, PersistedTabPageCompletion] => [
          tabId,
          { ...completion, labels: [...completion.labels] },
        ])
        .sort(([left], [right]) => left - right),
      nextLabel: this.nextLabel,
    };

    const operation = this.mappingSaveQueue
      .catch(() => undefined)
      .then(() => this.persistDocumentMappingsSnapshot(snapshot));
    this.mappingSaveQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async persistDocumentMappingsSnapshot(
    snapshot: Pick<
      PersistedVectorMappings,
      "documents" | "tabDocuments" | "completedTabPages" | "nextLabel"
    >,
  ): Promise<number> {
    const revision = this.mappingRevision + 1;
    if (!Number.isSafeInteger(revision)) {
      throw new Error("Vector mapping revision is exhausted");
    }
    // Reserve the revision before awaiting so concurrent saves remain ordered.
    this.mappingRevision = revision;
    const mappingData: PersistedVectorMappings = {
      schemaVersion: VECTOR_MAPPING_SCHEMA_VERSION,
      revision,
      updatedAt: Date.now(),
      dimension: this.config.dimension,
      indexFileName: this.config.indexFileName,
      ...snapshot,
    };
    const validated = parsePersistedVectorMappings(mappingData, this.config);
    if (validated.status !== "found") {
      throw new Error(
        validated.status === "invalid"
          ? `Refusing to persist invalid vector mappings: ${validated.reason}`
          : "Refusing to persist missing vector mappings",
      );
    }

    let indexedDbError: unknown;
    let indexedDbSaved = false;
    try {
      await IndexedDBHelper.saveData(
        this.config.indexFileName,
        validated.value,
      );
      indexedDbSaved = true;
      console.log("VectorDatabase: Document mappings saved to IndexedDB");
    } catch (error) {
      indexedDbError = error;
      console.warn(
        "VectorDatabase: Failed to save to IndexedDB, falling back to chrome.storage:",
        error,
      );
    }

    if (indexedDbSaved) {
      // A fallback can outlive an earlier primary write failure. Remove it
      // after the primary commit so an invalid or stale copy cannot make the
      // next startup ambiguous.
      await this.removeDocumentMappingBackup();
      return revision;
    }

    const storageKey = `hnswlib_document_mappings_${this.config.indexFileName}`;
    try {
      await chrome.storage.local.set({ [storageKey]: validated.value });
      const stored = await chrome.storage.local.get([storageKey]);
      const verified = parsePersistedVectorMappings(
        stored[storageKey],
        this.config,
      );
      if (
        verified.status !== "found" ||
        verified.value.revision !== validated.value.revision
      ) {
        throw new Error(
          "chrome.storage did not retain the vector mapping payload",
        );
      }
      console.log(
        "VectorDatabase: Document mappings saved to chrome.storage.local (fallback)",
      );
      return revision;
    } catch (storageError) {
      throw new AggregateError(
        [indexedDbError, storageError],
        "Failed to save vector mappings to IndexedDB and chrome.storage",
      );
    }
  }

  public async loadDocumentMappings(): Promise<void> {
    if (!globalHnswlib || !this.index) {
      throw new Error("HNSW module is not initialized");
    }

    return this.enqueueMutation(() => this.loadDocumentMappingsInternal());
  }

  private async loadDocumentMappingsInternal(): Promise<void> {
    this.assertSafeMutationState();

    const lookup = await this.lookupDocumentMappings();
    if (lookup.status !== "found") {
      throw new Error(
        lookup.status === "invalid"
          ? `Persisted vector mappings are invalid: ${lookup.reason}`
          : "Persisted vector mappings are missing",
      );
    }

    const invariantFailure = this.activeLabelInvariantFailure(
      lookup.value.documents.map(([label]) => label),
      lookup.value.nextLabel,
    );
    if (invariantFailure) {
      await this.replaceUnsafePersistedIndexWithEmpty(
        `mapping reload failed the HNSW active-label invariant: ${invariantFailure}`,
      );
      return;
    }

    this.applyDocumentMappings(lookup.value);
    console.log(
      `VectorDatabase: Loaded ${this.documents.size} document mappings, next label: ${this.nextLabel}`,
    );
  }
}

// Global VectorDatabase singleton
let globalVectorDatabase: VectorDatabase | null = null;
let currentDimension: number | null = null;

/**
 * Get global VectorDatabase singleton instance
 * If dimension changes, will recreate instance to ensure compatibility
 */
export async function getGlobalVectorDatabase(
  config?: Partial<VectorDatabaseConfig>,
): Promise<VectorDatabase> {
  const newDimension = config?.dimension || 384;

  // If dimension changes, need to recreate vector database
  if (
    globalVectorDatabase &&
    currentDimension !== null &&
    currentDimension !== newDimension
  ) {
    console.log(
      `VectorDatabase: Dimension changed from ${currentDimension} to ${newDimension}, recreating instance`,
    );

    // Do not construct or publish a replacement until the old instance has
    // been cleared successfully. On failure the old singleton and its
    // dimension remain authoritative so callers can retry safely.
    await globalVectorDatabase.clear();
    console.log(
      "VectorDatabase: Successfully cleared old instance for dimension change",
    );

    const replacement = new VectorDatabase(config);
    globalVectorDatabase = replacement;
    currentDimension = newDimension;
    console.log(
      `VectorDatabase: Created global singleton instance with dimension ${currentDimension}`,
    );
    return replacement;
  }

  if (!globalVectorDatabase) {
    globalVectorDatabase = new VectorDatabase(config);
    currentDimension = newDimension;
    console.log(
      `VectorDatabase: Created global singleton instance with dimension ${currentDimension}`,
    );
  }

  return globalVectorDatabase;
}

/**
 * Synchronous version of getting global VectorDatabase instance (for backward compatibility)
 * Note: If dimension change is needed, recommend using async version
 */
export function getGlobalVectorDatabaseSync(
  config?: Partial<VectorDatabaseConfig>,
): VectorDatabase {
  const newDimension = config?.dimension || 384;

  // If dimension changes, log warning but don't clean up (avoid race conditions)
  if (
    globalVectorDatabase &&
    currentDimension !== null &&
    currentDimension !== newDimension
  ) {
    console.warn(
      `VectorDatabase: Dimension mismatch detected (${currentDimension} vs ${newDimension}). Consider using async version for proper cleanup.`,
    );
  }

  if (!globalVectorDatabase) {
    globalVectorDatabase = new VectorDatabase(config);
    currentDimension = newDimension;
    console.log(
      `VectorDatabase: Created global singleton instance with dimension ${currentDimension}`,
    );
  }

  return globalVectorDatabase;
}

/**
 * Reset global VectorDatabase instance (mainly for testing or model switching)
 */
export async function resetGlobalVectorDatabase(): Promise<void> {
  console.log("VectorDatabase: Starting global instance reset...");
  await clearAllVectorData();
  globalVectorDatabase = null;
  currentDimension = null;
  console.log("VectorDatabase: Global singleton instance reset completed");
}

/**
 * Specifically for data cleanup during model switching
 * Clear all IndexedDB data, including HNSW index files and document mappings
 */
let clearAllVectorDataPromise: Promise<void> | null = null;

export function clearAllVectorData(): Promise<void> {
  if (clearAllVectorDataPromise) return clearAllVectorDataPromise;

  const operation = performClearAllVectorData();
  const trackedOperation = operation.finally(() => {
    if (clearAllVectorDataPromise === trackedOperation) {
      clearAllVectorDataPromise = null;
    }
  });
  clearAllVectorDataPromise = trackedOperation;
  return trackedOperation;
}

async function performClearAllVectorData(): Promise<void> {
  console.log("VectorDatabase: Starting comprehensive vector data cleanup...");

  const failures: Error[] = [];
  const runCleanupStep = async (
    step: string,
    operation: () => Promise<void>,
  ) => {
    try {
      await operation();
    } catch (error) {
      const failure = cleanupError(step, error);
      failures.push(failure);
      console.warn(`VectorDatabase: ${step} failed:`, error);
    }
  };

  await runCleanupStep("clear active vector instance", async () => {
    // Do not write an empty file just before removing FILE_DATA. Privacy
    // cleanup uses one explicit syncFS(true) with a real completion callback.
    if (globalVectorDatabase)
      await globalVectorDatabase.clear({ persistIndex: false });
  });

  await runCleanupStep("delete vector document mappings", async () => {
    await IndexedDBHelper.closeConnection();
    await deleteIndexedDatabase(DB_NAME);
  });

  await runCleanupStep("clear persistent HNSW index data", async () => {
    if (!globalHnswlib) {
      await deleteIndexedDatabase(HNSW_DB_NAME);
      return;
    }

    await enqueueHnswFileSystemOperation(async () => {
      const manager = globalHnswlib.EmscriptenFileSystemManager;
      // A timed-out write may still complete after its caller has failed.
      // Recovery may proceed only after that native operation is observably
      // idle; otherwise clearing FILE_DATA can be undone by the late write.
      await waitForGlobalHnswFileSystemIdle();
      await clearIndexedDatabaseStore(HNSW_DB_NAME, IDBFS_STORE_NAME);

      // Re-populate the in-memory IDBFS mount from the now-empty persistent
      // store. This store clear, reconciliation, and verification must remain
      // one queue job so a late write cannot race between them.
      await syncGlobalHnswFileSystemNow(true);

      const fileFailures: Error[] = [];
      for (const fileName of HNSW_INDEX_FILES) {
        try {
          if (manager.checkFileExists(fileName)) {
            fileFailures.push(
              new Error(`HNSW file ${fileName} still exists after cleanup`),
            );
          }
        } catch (error) {
          fileFailures.push(
            cleanupError(`verify HNSW file ${fileName}`, error),
          );
        }
      }

      if (fileFailures.length > 0) {
        throw new AggregateError(
          fileFailures,
          "Persistent HNSW cleanup did not complete",
        );
      }
    });
  });

  await runCleanupStep("remove vector storage backups", async () => {
    await chrome.storage.local.remove(VECTOR_STORAGE_BACKUP_KEYS);

    if (typeof chrome.storage.local.get === "function") {
      const remaining = await chrome.storage.local.get(
        VECTOR_STORAGE_BACKUP_KEYS,
      );
      const remainingKeys = VECTOR_STORAGE_BACKUP_KEYS.filter((key) =>
        Object.prototype.hasOwnProperty.call(remaining, key),
      );
      if (remainingKeys.length > 0) {
        throw new Error(
          `Vector storage backups still exist: ${remainingKeys.join(", ")}`,
        );
      }
    }
  });

  if (failures.length > 0) {
    throw new AggregateError(failures, "Vector data cleanup did not complete");
  }

  // Keep the successfully cleared singleton reachable. ContentIndexer holds the
  // same instance, so dropping only this module's reference would split future
  // writes across two vector databases. A later dimension change still replaces
  // it through getGlobalVectorDatabase().
  console.log(
    "VectorDatabase: Comprehensive vector data cleanup completed successfully",
  );
}
