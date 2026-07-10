/**
 * Vector database manager
 * Uses hnswlib-wasm for high-performance vector similarity search
 * Implements singleton pattern to avoid duplicate WASM module initialization
 */

import { IDBFS_STORE_NAME, loadHnswlib } from "hnswlib-wasm-static";
import type { TextChunk } from "./text-chunker";

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

let globalHnswlib: any = null;
let globalHnswlibInitPromise: Promise<any> | null = null;
let globalHnswlibInitialized = false;

let hnswFileSystemQueue: Promise<void> = Promise.resolve();

const DB_NAME = "VectorDatabaseStorage";
const DB_VERSION = 1;
const STORE_NAME = "documentMappings";
const HNSW_DB_NAME = "/hnswlib-index";
const HNSW_INDEX_FILES = [
  "tab_content_index.dat",
  "content_index.dat",
  "vector_index.dat",
];
const VECTOR_STORAGE_BACKUP_KEYS = HNSW_INDEX_FILES.map(
  (fileName) => `hnswlib_document_mappings_${fileName}`,
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanupError(step: string, error: unknown): Error {
  return new Error(`${step}: ${errorMessage(error)}`, { cause: error });
}

function enqueueHnswFileSystemOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = hnswFileSystemQueue.then(operation, operation);
  hnswFileSystemQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Run an IDBFS sync without converting a callback-reported failure into success.
 * `populate=true` reconciles the in-memory mount from IndexedDB; this is
 * required after clearing FILE_DATA so stale in-memory files cannot be
 * written back later.
 */
async function syncGlobalHnswFileSystemNow(populate: boolean): Promise<void> {
  if (!globalHnswlib) return;

  const manager = globalHnswlib.EmscriptenFileSystemManager;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(cleanupError("Failed to sync HNSW filesystem", error));
      else resolve();
    };

    try {
      manager.syncFS(populate, () => {
        if (manager.isSynced() !== true) {
          finish(new Error("HNSW filesystem reported an unsuccessful sync"));
          return;
        }
        finish();
      });
    } catch (error) {
      finish(error);
    }
  });
}

async function syncGlobalHnswFileSystem(populate: boolean): Promise<void> {
  await enqueueHnswFileSystemOperation(() =>
    syncGlobalHnswFileSystemNow(populate),
  );
}

/**
 * writeIndex() starts its own IDBFS write and returns immediately in 0.8.5.
 * Poll the manager state instead of starting a second concurrent syncFS call,
 * which can overwrite the library's static callback.
 */
async function waitForGlobalHnswFileSystemSync(
  pollIntervalMs = 25,
): Promise<void> {
  if (!globalHnswlib) throw new Error("HNSW module is not initialized");

  const manager = globalHnswlib.EmscriptenFileSystemManager;
  await new Promise<void>((resolve, reject) => {
    let observedUnsynced = false;
    const check = () => {
      try {
        if (manager.isSynced() !== true) {
          observedUnsynced = true;
        } else if (observedUnsynced) {
          resolve();
          return;
        }
      } catch (error) {
        reject(
          cleanupError("Failed to inspect HNSW filesystem sync state", error),
        );
        return;
      }

      setTimeout(check, pollIntervalMs);
    };
    check();
  });
}

async function waitForGlobalHnswFileSystemIdle(
  pollIntervalMs = 25,
): Promise<void> {
  if (!globalHnswlib) throw new Error("HNSW module is not initialized");

  const manager = globalHnswlib.EmscriptenFileSystemManager;
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      try {
        if (manager.isSynced() === true) {
          resolve();
          return;
        }
      } catch (error) {
        reject(
          cleanupError("Failed to inspect HNSW filesystem sync state", error),
        );
        return;
      }
      setTimeout(check, pollIntervalMs);
    };
    check();
  });
}

async function persistHnswIndex(index: any, fileName: string): Promise<void> {
  await enqueueHnswFileSystemOperation(async () => {
    // The runtime declaration says Promise<boolean>, but 0.8.5 returns void
    // after starting its own asynchronous syncFS(false).
    index.writeIndex(fileName);
    await waitForGlobalHnswFileSystemSync();
  });
}

/**
 * Delete an IndexedDB database without treating a blocked event as completion.
 */
export async function deleteIndexedDatabase(
  databaseName: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let request: IDBOpenDBRequest;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    try {
      request = indexedDB.deleteDatabase(databaseName);
    } catch (error) {
      finish(
        cleanupError(`Failed to request deletion of ${databaseName}`, error),
      );
      return;
    }

    request.onsuccess = () => finish();
    request.onerror = () =>
      finish(
        cleanupError(
          `Failed to delete IndexedDB database ${databaseName}`,
          request.error ?? "unknown IndexedDB error",
        ),
      );
    request.onblocked = () => {
      console.warn(
        `Deletion of IndexedDB database ${databaseName} is blocked; waiting for it`,
      );
    };
  });
}

export async function clearIndexedDatabaseStore(
  databaseName: string,
  storeName: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let database: IDBDatabase | null = null;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      database?.close();
      if (error) reject(error);
      else resolve();
    };

    let openRequest: IDBOpenDBRequest;
    try {
      openRequest = indexedDB.open(databaseName);
    } catch (error) {
      finish(
        cleanupError(
          `Failed to open IndexedDB database ${databaseName}`,
          error,
        ),
      );
      return;
    }

    openRequest.onblocked = () => {
      console.warn(
        `Opening IndexedDB database ${databaseName} is blocked; waiting for it`,
      );
    };
    openRequest.onerror = () =>
      finish(
        cleanupError(
          `Failed to open IndexedDB database ${databaseName}`,
          openRequest.error ?? "unknown IndexedDB error",
        ),
      );
    openRequest.onupgradeneeded = () => {
      const upgradeDatabase = openRequest.result;
      if (!upgradeDatabase.objectStoreNames.contains(storeName)) {
        upgradeDatabase.createObjectStore(storeName);
      }
    };
    openRequest.onsuccess = () => {
      const openedDatabase = openRequest.result;
      if (settled) {
        openedDatabase.close();
        return;
      }
      database = openedDatabase;
      openedDatabase.onversionchange = () => openedDatabase.close();

      let clearTransaction: IDBTransaction;
      try {
        clearTransaction = openedDatabase.transaction(storeName, "readwrite");
        clearTransaction.objectStore(storeName).clear();
      } catch (error) {
        finish(
          cleanupError(
            `Failed to clear IndexedDB store ${databaseName}/${storeName}`,
            error,
          ),
        );
        return;
      }

      clearTransaction.onerror = () =>
        finish(
          cleanupError(
            `Failed to clear IndexedDB store ${databaseName}/${storeName}`,
            clearTransaction.error ?? "unknown IndexedDB transaction error",
          ),
        );
      clearTransaction.onabort = () =>
        finish(
          cleanupError(
            `Clearing IndexedDB store ${databaseName}/${storeName} was aborted`,
            clearTransaction.error ?? "unknown IndexedDB transaction error",
          ),
        );
      clearTransaction.oncomplete = () => {
        let verifyTransaction: IDBTransaction;
        let countRequest: IDBRequest<number>;
        try {
          verifyTransaction = openedDatabase.transaction(storeName, "readonly");
          countRequest = verifyTransaction.objectStore(storeName).count();
        } catch (error) {
          finish(
            cleanupError(
              `Failed to verify IndexedDB store ${databaseName}/${storeName}`,
              error,
            ),
          );
          return;
        }

        countRequest.onerror = () =>
          finish(
            cleanupError(
              `Failed to verify IndexedDB store ${databaseName}/${storeName}`,
              countRequest.error ?? "unknown IndexedDB request error",
            ),
          );
        countRequest.onsuccess = () => {
          if (countRequest.result !== 0) {
            finish(
              new Error(
                `IndexedDB store ${databaseName}/${storeName} still contains ${countRequest.result} records`,
              ),
            );
          }
        };
        verifyTransaction.onerror = () =>
          finish(
            cleanupError(
              `Failed to verify IndexedDB store ${databaseName}/${storeName}`,
              verifyTransaction.error ?? "unknown IndexedDB transaction error",
            ),
          );
        verifyTransaction.onabort = () =>
          finish(
            cleanupError(
              `Verification of IndexedDB store ${databaseName}/${storeName} was aborted`,
              verifyTransaction.error ?? "unknown IndexedDB transaction error",
            ),
          );
        verifyTransaction.oncomplete = () => {
          if (countRequest.result === 0) finish();
        };
      };
    };
  });
}

/**
 * IndexedDB helper functions
 */
class IndexedDBHelper {
  private static dbPromise: Promise<IDBDatabase> | null = null;

  static async getDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          request.result.onversionchange = () => {
            request.result.close();
            this.dbPromise = null;
          };
          resolve(request.result);
        };

        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;

          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
            store.createIndex("indexFileName", "indexFileName", {
              unique: false,
            });
          }
        };
      }).catch((error) => {
        this.dbPromise = null;
        throw error;
      });
    }
    return this.dbPromise;
  }

  static async closeConnection(): Promise<void> {
    const pendingDatabase = this.dbPromise;
    this.dbPromise = null;
    if (!pendingDatabase) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };

      pendingDatabase.then(
        (database) => {
          try {
            database.close();
            finish();
          } catch (error) {
            finish(error);
          }
        },
        (error) => finish(error),
      );
    });
  }

  static async saveData(indexFileName: string, data: any): Promise<void> {
    const db = await this.getDB();
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    await new Promise<void>((resolve, reject) => {
      const request = store.put({
        id: indexFileName,
        indexFileName,
        data,
        timestamp: Date.now(),
      });

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  static async loadData(indexFileName: string): Promise<any | null> {
    const db = await this.getDB();
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);

    return new Promise<any | null>((resolve, reject) => {
      const request = store.get(indexFileName);

      request.onsuccess = () => {
        const result = request.result;
        resolve(result ? result.data : null);
      };
      request.onerror = () => reject(request.error);
    });
  }

  static async deleteData(indexFileName: string): Promise<void> {
    const db = await this.getDB();
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);

    await new Promise<void>((resolve, reject) => {
      const request = store.delete(indexFileName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all IndexedDB data (for complete cleanup during model switching)
   */
  static async clearAllData(): Promise<void> {
    try {
      const db = await this.getDB();
      const transaction = db.transaction([STORE_NAME], "readwrite");
      const store = transaction.objectStore(STORE_NAME);

      await new Promise<void>((resolve, reject) => {
        const request = store.clear();
        request.onsuccess = () => {
          console.log("IndexedDBHelper: All data cleared from IndexedDB");
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error("IndexedDBHelper: Failed to clear all data:", error);
      throw error;
    }
  }

  /**
   * Get all stored keys (for debugging)
   */
  static async getAllKeys(): Promise<string[]> {
    try {
      const db = await this.getDB();
      const transaction = db.transaction([STORE_NAME], "readonly");
      const store = transaction.objectStore(STORE_NAME);

      return new Promise<string[]>((resolve, reject) => {
        const request = store.getAllKeys();
        request.onsuccess = () => resolve(request.result as string[]);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error("IndexedDBHelper: Failed to get all keys:", error);
      return [];
    }
  }
}

/**
 * Global hnswlib-wasm initialization function
 * Ensures initialization only once across the entire application
 */
async function initializeGlobalHnswlib(): Promise<any> {
  if (globalHnswlibInitialized && globalHnswlib) {
    return globalHnswlib;
  }

  if (globalHnswlibInitPromise) {
    return globalHnswlibInitPromise;
  }

  globalHnswlibInitPromise = (async () => {
    try {
      console.log(
        "VectorDatabase: Initializing global hnswlib-wasm instance...",
      );
      globalHnswlib = await loadHnswlib();
      // loadHnswlib resolves when the filesystem is initialized, while its
      // initial syncFS(true) may still be in flight. Drain it before issuing
      // another read/write sync through our serialized queue.
      await enqueueHnswFileSystemOperation(() =>
        waitForGlobalHnswFileSystemIdle(),
      );
      globalHnswlibInitialized = true;
      console.log(
        "VectorDatabase: Global hnswlib-wasm instance initialized successfully",
      );
      return globalHnswlib;
    } catch (error) {
      console.error(
        "VectorDatabase: Failed to initialize global hnswlib-wasm:",
        error,
      );
      globalHnswlibInitPromise = null;
      throw error;
    }
  })();

  return globalHnswlibInitPromise;
}

export class VectorDatabase {
  private index: any = null;
  private isInitialized = false;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;

  private documents = new Map<number, VectorDocument>();
  private tabDocuments = new Map<number, Set<number>>();
  private nextLabel = 0;

  private readonly config: VectorDatabaseConfig;

  constructor(config?: Partial<VectorDatabaseConfig>) {
    this.config = {
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

    console.log("VectorDatabase: Initialized with config:", {
      dimension: this.config.dimension,
      efSearch: this.config.efSearch,
      M: this.config.M,
      efConstruction: this.config.efConstruction,
      enableAutoCleanup: this.config.enableAutoCleanup,
      maxRetentionDays: this.config.maxRetentionDays,
    });
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

      if (indexExists) {
        console.log("VectorDatabase: Loading existing index...");
        try {
          await this.index.readIndex(
            this.config.indexFileName,
            this.config.maxElements,
          );
          this.index.setEfSearch(this.config.efSearch);

          await this.loadDocumentMappings();

          if (this.documents.size > 0) {
            const maxLabel = Math.max(...Array.from(this.documents.keys()));
            this.nextLabel = maxLabel + 1;
            console.log(
              `VectorDatabase: Loaded existing index with ${this.documents.size} documents, next label: ${this.nextLabel}`,
            );
          } else {
            const indexCount = this.index.getCurrentCount();
            if (indexCount > 0) {
              console.warn(
                `VectorDatabase: Index has ${indexCount} vectors but no document mappings found. This may cause label mismatch.`,
              );
              this.nextLabel = indexCount;
            } else {
              this.nextLabel = 0;
            }
            console.log(
              `VectorDatabase: No document mappings found, starting with next label: ${this.nextLabel}`,
            );
          }
        } catch (loadError) {
          console.warn(
            "VectorDatabase: Failed to load existing index, creating new one:",
            loadError,
          );

          this.index.initIndex(
            this.config.maxElements,
            this.config.M,
            this.config.efConstruction,
            200,
          );
          this.index.setEfSearch(this.config.efSearch);
          this.nextLabel = 0;
        }
      } else {
        console.log("VectorDatabase: Creating new index...");
        this.index.initIndex(
          this.config.maxElements,
          this.config.M,
          this.config.efConstruction,
          200,
        );
        this.index.setEfSearch(this.config.efSearch);
        this.nextLabel = 0;
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
    if (!this.isInitialized) {
      await this.initialize();
    }

    const documentId = this.generateDocumentId(tabId, chunk.index);
    const document: VectorDocument = {
      id: documentId,
      tabId,
      url,
      title,
      chunk,
      embedding,
      timestamp: Date.now(),
    };

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

      // Ensure we have a clean Float32Array
      let cleanEmbedding: Float32Array;
      if (embedding instanceof Float32Array) {
        cleanEmbedding = embedding;
      } else {
        cleanEmbedding = new Float32Array(embedding);
      }

      // Use current nextLabel as label
      const label = this.nextLabel++;

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

      // Method 1: Try using VectorFloat constructor (if available)
      let vectorToAdd;
      try {
        // Check if VectorFloat constructor exists
        if (globalHnswlib && globalHnswlib.VectorFloat) {
          console.log("VectorDatabase: Using VectorFloat constructor");
          vectorToAdd = new globalHnswlib.VectorFloat();
          // Add elements to VectorFloat one by one
          for (let i = 0; i < cleanEmbedding.length; i++) {
            vectorToAdd.push_back(cleanEmbedding[i]);
          }
        } else {
          // Method 2: Use plain JS array (fallback)
          console.log("VectorDatabase: Using plain JS array as fallback");
          vectorToAdd = Array.from(cleanEmbedding);
        }

        // Call addPoint with constructed vector
        this.index.addPoint(vectorToAdd, label, false);

        // Clean up VectorFloat object (if manually created)
        if (vectorToAdd && typeof vectorToAdd.delete === "function") {
          vectorToAdd.delete();
        }
      } catch (vectorError) {
        console.error(
          "VectorDatabase: VectorFloat approach failed, trying alternatives:",
          vectorError,
        );

        // Method 3: Try passing Float32Array directly
        try {
          console.log("VectorDatabase: Trying Float32Array directly");
          this.index.addPoint(cleanEmbedding, label, false);
        } catch (float32Error) {
          console.error(
            "VectorDatabase: Float32Array approach failed:",
            float32Error,
          );

          // Method 4: Last resort - use spread operator
          console.log("VectorDatabase: Trying spread operator as last resort");
          this.index.addPoint([...cleanEmbedding], label, false);
        }
      }
      console.log(
        `VectorDatabase: ✅ Successfully added document with label ${label}`,
      );

      // Store document mapping
      this.documents.set(label, document);

      // Update tab document mapping
      if (!this.tabDocuments.has(tabId)) {
        this.tabDocuments.set(tabId, new Set());
      }
      this.tabDocuments.get(tabId)!.add(label);

      // Save index and mappings
      await this.saveIndex();
      await this.saveDocumentMappings();

      // Check if auto cleanup is needed
      if (this.config.enableAutoCleanup) {
        await this.checkAndPerformAutoCleanup();
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
      throw error;
    }
  }

  /**
   * Search similar documents
   */
  public async search(
    queryEmbedding: Float32Array,
    topK: number = 10,
  ): Promise<SearchResult[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
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

      // Check if index is empty
      const currentCount = this.index.getCurrentCount();
      if (currentCount === 0) {
        console.log("VectorDatabase: Index is empty, returning no results");
        return [];
      }

      console.log(`VectorDatabase: Index contains ${currentCount} vectors`);

      // Check if document mapping and index are synchronized
      const mappingCount = this.documents.size;
      if (mappingCount === 0 && currentCount > 0) {
        console.warn(
          `VectorDatabase: Index has ${currentCount} vectors but document mapping is empty. Attempting to reload mappings...`,
        );
        await this.loadDocumentMappings();

        if (this.documents.size === 0) {
          console.error(
            "VectorDatabase: Failed to load document mappings. Index and mappings are out of sync.",
          );
          return [];
        }
        console.log(
          `VectorDatabase: Successfully reloaded ${this.documents.size} document mappings`,
        );
      }

      // Process query vector according to hnswlib-wasm-static emscripten binding requirements
      let queryVector;
      let searchResult;

      try {
        // Method 1: Try using VectorFloat constructor (if available)
        if (globalHnswlib && globalHnswlib.VectorFloat) {
          console.log("VectorDatabase: Using VectorFloat for search query");
          queryVector = new globalHnswlib.VectorFloat();
          // Add elements to VectorFloat one by one
          for (let i = 0; i < queryEmbedding.length; i++) {
            queryVector.push_back(queryEmbedding[i]);
          }
          searchResult = this.index.searchKnn(queryVector, topK, undefined);

          // Clean up VectorFloat object
          if (queryVector && typeof queryVector.delete === "function") {
            queryVector.delete();
          }
        } else {
          // Method 2: Use plain JS array (fallback)
          console.log("VectorDatabase: Using plain JS array for search query");
          const queryArray = Array.from(queryEmbedding);
          searchResult = this.index.searchKnn(queryArray, topK, undefined);
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
          searchResult = this.index.searchKnn(queryEmbedding, topK, undefined);
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
            undefined,
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
        if (document) {
          console.log(
            `VectorDatabase: Found document for label ${label}: ${document.id}`,
          );
          results.push({
            document,
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

  /**
   * Remove all documents for a tab
   */
  public async removeTabDocuments(tabId: number): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const documentLabels = this.tabDocuments.get(tabId);
    if (!documentLabels) {
      return;
    }

    try {
      // Remove documents from mapping (hnswlib-wasm doesn't support direct deletion, only mark as deleted)
      for (const label of documentLabels) {
        this.documents.delete(label);
      }

      // Clean up tab mapping
      this.tabDocuments.delete(tabId);

      // Save changes
      await this.saveDocumentMappings();

      console.log(
        `VectorDatabase: Removed ${documentLabels.size} documents for tab ${tabId}`,
      );
    } catch (error) {
      console.error("VectorDatabase: Failed to remove tab documents:", error);
      throw error;
    }
  }

  /**
   * Get database statistics
   */
  public getStats(): {
    totalDocuments: number;
    totalTabs: number;
    indexSize: number;
    isInitialized: boolean;
  } {
    return {
      totalDocuments: this.documents.size,
      totalTabs: this.tabDocuments.size,
      indexSize: this.calculateStorageSize(),
      isInitialized: this.isInitialized,
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
    console.log("VectorDatabase: Starting complete database clear...");
    const persistIndex = options.persistIndex !== false;
    if (this.isInitializing && this.initPromise) {
      await this.initPromise;
    }

    this.documents.clear();
    this.tabDocuments.clear();
    this.nextLabel = 0;

    const failures: Error[] = [];

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
        }

        if (this.index.getCurrentCount() !== 0) {
          throw new Error(
            "HNSW index still contains vectors after replacement",
          );
        }
      } catch (error) {
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

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Vector database clear did not complete",
      );
    }

    console.log(
      "VectorDatabase: Complete database clear finished successfully",
    );
  }

  /**
   * Check and perform auto cleanup
   */
  private async checkAndPerformAutoCleanup(): Promise<void> {
    try {
      const currentCount = this.documents.size;
      const maxElements = this.config.maxElements;

      console.log(
        `VectorDatabase: Auto cleanup check - current: ${currentCount}, max: ${maxElements}`,
      );

      // Check if maximum element count is exceeded
      if (currentCount >= maxElements) {
        console.log(
          "VectorDatabase: Document count reached limit, performing cleanup...",
        );
        await this.performLRUCleanup(Math.floor(maxElements * 0.2)); // Clean up 20% of data
      }

      // Check if there's expired data
      if (this.config.maxRetentionDays && this.config.maxRetentionDays > 0) {
        await this.performTimeBasedCleanup();
      }
    } catch (error) {
      console.error("VectorDatabase: Auto cleanup failed:", error);
    }
  }

  /**
   * Perform LRU-based cleanup (delete oldest documents)
   */
  private async performLRUCleanup(cleanupCount: number): Promise<void> {
    try {
      console.log(
        `VectorDatabase: Starting LRU cleanup, removing ${cleanupCount} oldest documents`,
      );

      // Get all documents and sort by timestamp
      const allDocuments = Array.from(this.documents.entries());
      allDocuments.sort((a, b) => a[1].timestamp - b[1].timestamp);

      // Select documents to delete
      const documentsToDelete = allDocuments.slice(0, cleanupCount);

      for (const [label, _document] of documentsToDelete) {
        await this.removeDocumentByLabel(label);
      }

      // Save updated index and mappings
      await this.saveIndex();
      await this.saveDocumentMappings();

      console.log(
        `VectorDatabase: LRU cleanup completed, removed ${documentsToDelete.length} documents`,
      );
    } catch (error) {
      console.error("VectorDatabase: LRU cleanup failed:", error);
    }
  }

  /**
   * Perform time-based cleanup (delete expired documents)
   */
  private async performTimeBasedCleanup(): Promise<void> {
    try {
      const maxRetentionMs =
        this.config.maxRetentionDays! * 24 * 60 * 60 * 1000;
      const cutoffTime = Date.now() - maxRetentionMs;

      console.log(
        `VectorDatabase: Starting time-based cleanup, removing documents older than ${this.config.maxRetentionDays} days`,
      );

      const documentsToDelete: number[] = [];

      for (const [label, document] of this.documents.entries()) {
        if (document.timestamp < cutoffTime) {
          documentsToDelete.push(label);
        }
      }

      for (const label of documentsToDelete) {
        await this.removeDocumentByLabel(label);
      }

      // Save updated index and mappings
      if (documentsToDelete.length > 0) {
        await this.saveIndex();
        await this.saveDocumentMappings();
      }

      console.log(
        `VectorDatabase: Time-based cleanup completed, removed ${documentsToDelete.length} expired documents`,
      );
    } catch (error) {
      console.error("VectorDatabase: Time-based cleanup failed:", error);
    }
  }

  /**
   * Remove single document by label
   */
  private async removeDocumentByLabel(label: number): Promise<void> {
    try {
      const document = this.documents.get(label);
      if (!document) {
        console.warn(`VectorDatabase: Document with label ${label} not found`);
        return;
      }

      // Remove vector from HNSW index
      if (this.index) {
        try {
          this.index.markDelete(label);
        } catch (indexError) {
          console.warn(
            `VectorDatabase: Failed to mark delete in index for label ${label}:`,
            indexError,
          );
        }
      }

      // Remove from memory mapping
      this.documents.delete(label);

      // Remove from tab mapping
      const tabId = document.tabId;
      if (this.tabDocuments.has(tabId)) {
        this.tabDocuments.get(tabId)!.delete(label);
        // If tab has no other documents, delete entire tab mapping
        if (this.tabDocuments.get(tabId)!.size === 0) {
          this.tabDocuments.delete(tabId);
        }
      }

      console.log(
        `VectorDatabase: Removed document with label ${label} from tab ${tabId}`,
      );
    } catch (error) {
      console.error(
        `VectorDatabase: Failed to remove document with label ${label}:`,
        error,
      );
    }
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

  private async saveDocumentMappings(): Promise<void> {
    try {
      // Save document mappings to IndexedDB
      const mappingData = {
        documents: Array.from(this.documents.entries()),
        tabDocuments: Array.from(this.tabDocuments.entries()).map(
          ([tabId, labels]) => [tabId, Array.from(labels)],
        ),
        nextLabel: this.nextLabel,
      };

      try {
        // Use IndexedDB to save data, supports larger storage capacity
        await IndexedDBHelper.saveData(this.config.indexFileName, mappingData);
        console.log("VectorDatabase: Document mappings saved to IndexedDB");
      } catch (idbError) {
        console.warn(
          "VectorDatabase: Failed to save to IndexedDB, falling back to chrome.storage:",
          idbError,
        );

        // Fall back to chrome.storage.local
        try {
          const storageKey = `hnswlib_document_mappings_${this.config.indexFileName}`;
          await chrome.storage.local.set({ [storageKey]: mappingData });
          console.log(
            "VectorDatabase: Document mappings saved to chrome.storage.local (fallback)",
          );
        } catch (storageError) {
          console.error(
            "VectorDatabase: Failed to save to both IndexedDB and chrome.storage:",
            storageError,
          );
        }
      }
    } catch (error) {
      console.error("VectorDatabase: Failed to save document mappings:", error);
    }
  }

  public async loadDocumentMappings(): Promise<void> {
    try {
      // Load document mappings from IndexedDB
      if (!globalHnswlib) {
        return;
      }

      let mappingData = null;

      try {
        // First try to read from IndexedDB
        mappingData = await IndexedDBHelper.loadData(this.config.indexFileName);
        if (mappingData) {
          console.log(
            `VectorDatabase: Loaded document mappings from IndexedDB`,
          );
        }
      } catch (idbError) {
        console.warn(
          "VectorDatabase: Failed to read from IndexedDB, trying chrome.storage:",
          idbError,
        );
      }

      // If IndexedDB has no data, try reading from chrome.storage.local (backward compatibility)
      if (!mappingData) {
        try {
          const storageKey = `hnswlib_document_mappings_${this.config.indexFileName}`;
          const result = await chrome.storage.local.get([storageKey]);
          mappingData = result[storageKey];
          if (mappingData) {
            console.log(
              `VectorDatabase: Loaded document mappings from chrome.storage.local (fallback)`,
            );

            // Migrate to IndexedDB
            try {
              await IndexedDBHelper.saveData(
                this.config.indexFileName,
                mappingData,
              );
              console.log(
                "VectorDatabase: Migrated data from chrome.storage to IndexedDB",
              );
            } catch (migrationError) {
              console.warn(
                "VectorDatabase: Failed to migrate data to IndexedDB:",
                migrationError,
              );
            }
          }
        } catch (storageError) {
          console.warn(
            "VectorDatabase: Failed to read from chrome.storage.local:",
            storageError,
          );
        }
      }

      if (mappingData) {
        // Restore document mappings
        this.documents.clear();
        for (const [label, doc] of mappingData.documents) {
          this.documents.set(label, doc);
        }

        // Restore tab mappings
        this.tabDocuments.clear();
        for (const [tabId, labels] of mappingData.tabDocuments) {
          this.tabDocuments.set(tabId, new Set(labels));
        }

        // Restore nextLabel - use saved value or calculate max label + 1
        if (mappingData.nextLabel !== undefined) {
          this.nextLabel = mappingData.nextLabel;
        } else if (this.documents.size > 0) {
          // If no saved nextLabel, calculate max label + 1
          const maxLabel = Math.max(...Array.from(this.documents.keys()));
          this.nextLabel = maxLabel + 1;
        } else {
          this.nextLabel = 0;
        }

        console.log(
          `VectorDatabase: Loaded ${this.documents.size} document mappings, next label: ${this.nextLabel}`,
        );
      } else {
        console.log("VectorDatabase: No existing document mappings found");
      }
    } catch (error) {
      console.error("VectorDatabase: Failed to load document mappings:", error);
    }
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

    // Clean up old instance - this will clean up index files and document mappings
    try {
      await globalVectorDatabase.clear();
      console.log(
        "VectorDatabase: Successfully cleared old instance for dimension change",
      );
    } catch (error) {
      console.warn("VectorDatabase: Error during cleanup:", error);
    }

    globalVectorDatabase = null;
    currentDimension = null;
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
