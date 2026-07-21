import { IDBFS_STORE_NAME, loadHnswlib } from "hnswlib-wasm-static";

export { IDBFS_STORE_NAME };

export let globalHnswlib: any = null;
let globalHnswlibInitPromise: Promise<any> | null = null;
let globalHnswlibInitialized = false;

let hnswFileSystemQueue: Promise<void> = Promise.resolve();

export const DB_NAME = "VectorDatabaseStorage";
const DB_VERSION = 1;
const STORE_NAME = "documentMappings";
export const HNSW_DB_NAME = "/hnswlib-index";
const HNSW_FILESYSTEM_WAIT_TIMEOUT_MS = 30_000;
const HNSW_FILESYSTEM_POLL_INTERVAL_MS = 25;
export const HNSW_INDEX_FILES = [
  "tab_content_index.dat",
  "content_index.dat",
  "vector_index.dat",
];
export const VECTOR_STORAGE_BACKUP_KEYS = HNSW_INDEX_FILES.map(
  (fileName) => `hnswlib_document_mappings_${fileName}`,
);

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cleanupError(step: string, error: unknown): Error {
  return new Error(`${step}: ${errorMessage(error)}`, { cause: error });
}

class HnswFileSystemTimeoutError extends Error {
  constructor(operation: string) {
    super(
      `Timed out after ${HNSW_FILESYSTEM_WAIT_TIMEOUT_MS}ms waiting for ${operation}`,
    );
    this.name = "HnswFileSystemTimeoutError";
  }
}

export class HnswIndexPersistenceUncertainError extends Error {
  constructor(error: unknown) {
    super(`HNSW index persistence outcome is unknown: ${errorMessage(error)}`, {
      cause: error,
    });
    this.name = "HnswIndexPersistenceUncertainError";
  }
}

export function enqueueHnswFileSystemOperation<T>(
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
export async function syncGlobalHnswFileSystemNow(
  populate: boolean,
): Promise<void> {
  if (!globalHnswlib) return;

  const manager = globalHnswlib.EmscriptenFileSystemManager;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(cleanupError("Failed to sync HNSW filesystem", error));
      else resolve();
    };

    const deadline = setTimeout(
      () => finish(new HnswFileSystemTimeoutError("syncFS callback")),
      HNSW_FILESYSTEM_WAIT_TIMEOUT_MS,
    );

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

export async function syncGlobalHnswFileSystem(
  populate: boolean,
): Promise<void> {
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
  pollIntervalMs = HNSW_FILESYSTEM_POLL_INTERVAL_MS,
): Promise<void> {
  if (!globalHnswlib) throw new Error("HNSW module is not initialized");

  const manager = globalHnswlib.EmscriptenFileSystemManager;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let poll: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (poll !== undefined) clearTimeout(poll);
      if (error) {
        reject(cleanupError("Failed to wait for HNSW filesystem sync", error));
      } else {
        resolve();
      }
    };

    const deadline = setTimeout(() => {
      finish(
        new HnswFileSystemTimeoutError("writeIndex filesystem synchronization"),
      );
    }, HNSW_FILESYSTEM_WAIT_TIMEOUT_MS);

    const check = () => {
      try {
        // writeIndex starts its sync before returning. A true state here can
        // therefore mean either that the operation completed synchronously or
        // that a very fast false -> true transition happened before our first
        // observation; requiring an observed false transition would hang.
        if (manager.isSynced() === true) {
          finish();
          return;
        }
      } catch (error) {
        finish(
          cleanupError("Failed to inspect HNSW filesystem sync state", error),
        );
        return;
      }

      poll = setTimeout(check, pollIntervalMs);
    };
    check();
  });
}

export async function waitForGlobalHnswFileSystemIdle(
  pollIntervalMs = HNSW_FILESYSTEM_POLL_INTERVAL_MS,
): Promise<void> {
  if (!globalHnswlib) throw new Error("HNSW module is not initialized");

  const manager = globalHnswlib.EmscriptenFileSystemManager;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let poll: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (poll !== undefined) clearTimeout(poll);
      if (error) {
        reject(cleanupError("Failed to wait for idle HNSW filesystem", error));
      } else {
        resolve();
      }
    };

    const deadline = setTimeout(() => {
      finish(new HnswFileSystemTimeoutError("HNSW filesystem to become idle"));
    }, HNSW_FILESYSTEM_WAIT_TIMEOUT_MS);

    const check = () => {
      try {
        if (manager.isSynced() === true) {
          finish();
          return;
        }
      } catch (error) {
        finish(
          cleanupError("Failed to inspect HNSW filesystem sync state", error),
        );
        return;
      }
      poll = setTimeout(check, pollIntervalMs);
    };
    check();
  });
}

export async function persistHnswIndex(
  index: any,
  fileName: string,
): Promise<void> {
  await enqueueHnswFileSystemOperation(async () => {
    // The runtime declaration says Promise<boolean>, but 0.8.5 returns void
    // after starting its own asynchronous syncFS(false).
    index.writeIndex(fileName);
    try {
      await waitForGlobalHnswFileSystemSync();
    } catch (error) {
      // Once writeIndex returned, a wait failure cannot distinguish an old file
      // from a fully or partially persisted replacement. Callers must never
      // issue a second non-idempotent index write in the same worker.
      throw new HnswIndexPersistenceUncertainError(error);
    }
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
export class IndexedDBHelper {
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
      store.put({
        id: indexFileName,
        indexFileName,
        data,
        timestamp: Date.now(),
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Vector mapping save failed"));
      transaction.onabort = () =>
        reject(
          transaction.error ?? new Error("Vector mapping save was aborted"),
        );
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
      store.delete(indexFileName);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(
          transaction.error ?? new Error("Vector mapping deletion failed"),
        );
      transaction.onabort = () =>
        reject(
          transaction.error ?? new Error("Vector mapping deletion was aborted"),
        );
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
export async function initializeGlobalHnswlib(): Promise<any> {
  if (globalHnswlibInitialized && globalHnswlib) {
    // A prior write may still be settling even though the WASM module itself is
    // initialized. Every new database instance joins the serialized filesystem
    // boundary before reading or replacing an index.
    await enqueueHnswFileSystemOperation(() =>
      waitForGlobalHnswFileSystemIdle(),
    );
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
