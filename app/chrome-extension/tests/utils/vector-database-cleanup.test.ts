import { afterEach, describe, expect, it, vi } from "vitest";

const hnswMocks = vi.hoisted(() => {
  type LabelSnapshot = {
    currentCount?: unknown;
    deletedLabels: unknown;
    inspectionError?: Error;
    usedLabels: unknown;
  };

  const files = new Set<string>();
  const fileCounts = new Map<string, number>();
  const fileLabelSnapshots = new Map<string, LabelSnapshot>();
  const syncCalls: boolean[] = [];
  const writeCalls: string[] = [];
  const readCalls: string[] = [];
  const addPointCalls: Array<{ label: number; vector: unknown }> = [];
  const addedLabels: number[] = [];
  const deletedLabels: number[] = [];
  const searchCalls: Array<{
    filter?: (label: number) => boolean;
    topK: number;
  }> = [];
  const pendingWriteSyncs: Array<() => void> = [];
  const instances: Array<{ count: number; fileName?: string }> = [];
  let populateSnapshot: Map<string, number | LabelSnapshot> | null = null;
  let autoCompleteSyncFS = true;
  let syncShouldSucceed = true;
  let synced = true;
  let autoCompleteWriteSync = true;
  let completeWriteSyncSynchronously = false;
  let markDeleteFailuresRemaining = 0;
  let vectorFloatDeleteCalls = 0;
  let searchFailuresRemaining = 0;
  let writeFailuresRemaining = 0;
  let nextAddPointFailure: {
    error: Error;
    timing: "after-mutation" | "before-mutation";
  } | null = null;

  class VectorFloat {
    private readonly values: number[] = [];

    push_back(value: number) {
      this.values.push(value);
    }

    delete() {
      vectorFloatDeleteCalls += 1;
    }
  }

  class HierarchicalNSW {
    count = 0;
    readonly fileName?: string;
    private labels: number[] = [];
    private readonly deleted = new Set<number>();
    private inspectionSnapshot: LabelSnapshot | null = null;

    constructor(_space: string, _dimension: number, fileName?: string) {
      this.fileName = fileName;
      instances.push(this);
    }

    initIndex() {
      this.count = 0;
      this.labels = [];
      this.deleted.clear();
      this.inspectionSnapshot = null;
    }

    setEfSearch() {}

    getCurrentCount() {
      if (this.inspectionSnapshot?.inspectionError) {
        throw this.inspectionSnapshot.inspectionError;
      }
      if (this.inspectionSnapshot?.currentCount !== undefined) {
        return this.inspectionSnapshot.currentCount;
      }
      return this.count;
    }

    getUsedLabels() {
      if (this.inspectionSnapshot?.inspectionError) {
        throw this.inspectionSnapshot.inspectionError;
      }
      return this.inspectionSnapshot
        ? this.inspectionSnapshot.usedLabels
        : [...this.labels];
    }

    getDeletedLabels() {
      if (this.inspectionSnapshot?.inspectionError) {
        throw this.inspectionSnapshot.inspectionError;
      }
      return this.inspectionSnapshot
        ? this.inspectionSnapshot.deletedLabels
        : [...this.deleted];
    }

    addPoint(vector: unknown, label: number) {
      addPointCalls.push({ label, vector });
      if (nextAddPointFailure?.timing === "before-mutation") {
        const { error } = nextAddPointFailure;
        nextAddPointFailure = null;
        throw error;
      }
      addedLabels.push(label);
      this.labels.push(label);
      this.count += 1;
      if (nextAddPointFailure?.timing === "after-mutation") {
        const { error } = nextAddPointFailure;
        nextAddPointFailure = null;
        throw error;
      }
    }

    searchKnn(
      _query: unknown,
      topK: number,
      filter?: (label: number) => boolean,
    ) {
      searchCalls.push({ filter, topK });
      if (searchFailuresRemaining > 0) {
        searchFailuresRemaining -= 1;
        throw new Error("search failed");
      }
      const neighbors = this.labels
        .filter((label) => !this.deleted.has(label))
        .filter((label) => !filter || filter(label))
        .slice(0, topK);
      return {
        neighbors,
        distances: neighbors.map((_label, index) => 0.1 + index * 0.01),
      };
    }

    resizeIndex() {}

    getPoint() {
      return [];
    }

    markDelete(label: number) {
      if (markDeleteFailuresRemaining > 0) {
        markDeleteFailuresRemaining -= 1;
        throw new Error("mark delete failed");
      }
      deletedLabels.push(label);
      this.deleted.add(label);
    }

    async readIndex(fileName: string) {
      readCalls.push(fileName);
      if (!files.has(fileName)) throw new Error("missing index");
      this.count = fileCounts.get(fileName) ?? 0;
      this.inspectionSnapshot = fileLabelSnapshots.get(fileName) ?? null;
      const usedLabels = this.inspectionSnapshot?.usedLabels;
      this.labels = Array.isArray(usedLabels)
        ? usedLabels.filter(
            (label): label is number => typeof label === "number",
          )
        : Array.from({ length: this.count }, (_value, index) => index);
      const deletedLabels = this.inspectionSnapshot?.deletedLabels;
      this.deleted.clear();
      if (Array.isArray(deletedLabels)) {
        for (const label of deletedLabels) {
          if (typeof label === "number") this.deleted.add(label);
        }
      }
      const normalUsedLabels =
        Array.isArray(usedLabels) &&
        usedLabels.every(
          (label) =>
            Number.isSafeInteger(label) && label >= 0 && label <= 0xffffffff,
        ) &&
        new Set(usedLabels).size === usedLabels.length;
      const normalDeletedLabels =
        Array.isArray(deletedLabels) &&
        deletedLabels.every(
          (label) =>
            Number.isSafeInteger(label) &&
            label >= 0 &&
            label <= 0xffffffff &&
            this.labels.includes(label),
        ) &&
        new Set(deletedLabels).size === deletedLabels.length;
      if (
        !this.inspectionSnapshot?.inspectionError &&
        normalUsedLabels &&
        normalDeletedLabels &&
        this.inspectionSnapshot?.currentCount === usedLabels.length
      ) {
        this.inspectionSnapshot = null;
      }
    }

    writeIndex(fileName: string) {
      writeCalls.push(fileName);
      if (writeFailuresRemaining > 0) {
        writeFailuresRemaining -= 1;
        throw new Error("index write failed");
      }
      files.add(fileName);
      fileCounts.set(fileName, this.count);
      fileLabelSnapshots.set(fileName, {
        currentCount: this.count,
        deletedLabels: [...this.deleted],
        usedLabels: [...this.labels],
      });
      synced = false;
      const complete = () => {
        synced = syncShouldSucceed;
      };
      if (completeWriteSyncSynchronously) complete();
      else if (autoCompleteWriteSync) queueMicrotask(complete);
      else pendingWriteSyncs.push(complete);
    }
  }

  const manager = {
    checkFileExists: vi.fn((fileName: string) => files.has(fileName)),
    isSynced: vi.fn(() => synced),
    setDebugLogs: vi.fn(),
    syncFS: vi.fn((populate: boolean, callback: () => void) => {
      syncCalls.push(populate);
      synced = false;
      const complete = () => {
        synced = syncShouldSucceed;
        if (populate && synced) {
          files.clear();
          fileCounts.clear();
          fileLabelSnapshots.clear();
          if (populateSnapshot) {
            for (const [fileName, value] of populateSnapshot) {
              const snapshot: LabelSnapshot =
                typeof value === "number"
                  ? {
                      currentCount: value,
                      deletedLabels: [],
                      usedLabels: Array.from(
                        { length: value },
                        (_entry, index) => index,
                      ),
                    }
                  : value;
              const count =
                typeof snapshot.currentCount === "number"
                  ? snapshot.currentCount
                  : Array.isArray(snapshot.usedLabels)
                    ? snapshot.usedLabels.length
                    : 0;
              files.add(fileName);
              fileCounts.set(fileName, count);
              fileLabelSnapshots.set(fileName, snapshot);
            }
            populateSnapshot = null;
          }
        }
        callback();
      };
      if (autoCompleteSyncFS) queueMicrotask(complete);
    }),
  };

  return {
    addPointCalls,
    addedLabels,
    deletedLabels,
    fileCounts,
    fileLabelSnapshots,
    files,
    instances,
    manager,
    setSyncShouldSucceed(value: boolean) {
      syncShouldSucceed = value;
    },
    resetSyncState() {
      autoCompleteSyncFS = true;
      syncShouldSucceed = true;
      synced = true;
      autoCompleteWriteSync = true;
      completeWriteSyncSynchronously = false;
      markDeleteFailuresRemaining = 0;
      pendingWriteSyncs.length = 0;
      searchCalls.length = 0;
      searchFailuresRemaining = 0;
      populateSnapshot = null;
      writeFailuresRemaining = 0;
      nextAddPointFailure = null;
    },
    setAutoCompleteWriteSync(value: boolean) {
      autoCompleteWriteSync = value;
    },
    setAutoCompleteSyncFS(value: boolean) {
      autoCompleteSyncFS = value;
    },
    setCompleteWriteSyncSynchronously(value: boolean) {
      completeWriteSyncSynchronously = value;
    },
    setSynced(value: boolean) {
      synced = value;
    },
    setWriteFailures(value: number) {
      writeFailuresRemaining = value;
    },
    failNextAddPoint(
      timing: "after-mutation" | "before-mutation",
      message: string,
    ) {
      nextAddPointFailure = { error: new Error(message), timing };
    },
    setSearchFailures(value: number) {
      searchFailuresRemaining = value;
    },
    setMarkDeleteFailures(value: number) {
      markDeleteFailuresRemaining = value;
    },
    completeNextWriteSync() {
      pendingWriteSyncs.shift()?.();
    },
    pendingWriteSyncs,
    readCalls,
    searchCalls,
    setPopulateSnapshot(entries: Array<[string, number | LabelSnapshot]>) {
      populateSnapshot = new Map(entries);
    },
    syncCalls,
    writeCalls,
    VectorFloat,
    getVectorFloatDeleteCalls() {
      return vectorFloatDeleteCalls;
    },
    resetVectorFloatDeleteCalls() {
      vectorFloatDeleteCalls = 0;
    },
    HierarchicalNSW,
  };
});

vi.mock("hnswlib-wasm-static", () => ({
  IDBFS_STORE_NAME: "FILE_DATA",
  HierarchicalNSW: hnswMocks.HierarchicalNSW,
  loadHnswlib: vi.fn(async () => ({
    EmscriptenFileSystemManager: hnswMocks.manager,
    HierarchicalNSW: hnswMocks.HierarchicalNSW,
    VectorFloat: hnswMocks.VectorFloat,
  })),
}));

import {
  VectorDatabase,
  clearAllVectorData,
  clearIndexedDatabaseStore,
  deleteIndexedDatabase,
  getGlobalVectorDatabase,
  resetGlobalVectorDatabase,
} from "@/utils/vector-database";

type MutableDeleteRequest = {
  error?: DOMException | null;
  onblocked?: ((event: Event) => void) | null;
  onerror?: ((event: Event) => void) | null;
  onsuccess?: ((event: Event) => void) | null;
};

type MutableOpenRequest = MutableDeleteRequest & {
  onupgradeneeded?: ((event: Event) => void) | null;
  result?: IDBDatabase;
};

type MutableTransaction = {
  error?: DOMException | null;
  onabort?: ((event: Event) => void) | null;
  oncomplete?: ((event: Event) => void) | null;
  onerror?: ((event: Event) => void) | null;
  objectStore: ReturnType<typeof vi.fn>;
};

const originalStorageGet = chrome.storage.local.get;
const originalStorageSet = chrome.storage.local.set;
const originalStorageRemove = chrome.storage.local.remove;

function stubDeleteRequest(request: MutableDeleteRequest) {
  vi.stubGlobal("indexedDB", {
    deleteDatabase: vi.fn(() => request as unknown as IDBOpenDBRequest),
  });
}

function useStatefulChromeStorage(initial: Record<string, unknown> = {}) {
  const state: Record<string, unknown> = { ...initial };
  chrome.storage.local.get = vi.fn(async (keys: string | string[]) => {
    const requested = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      requested
        .filter((key) => Object.prototype.hasOwnProperty.call(state, key))
        .map((key) => [key, state[key]]),
    );
  }) as unknown as typeof chrome.storage.local.get;
  chrome.storage.local.set = vi.fn(async (values: Record<string, unknown>) => {
    Object.assign(state, values);
  }) as typeof chrome.storage.local.set;
  chrome.storage.local.remove = vi.fn(async (keys: string | string[]) => {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
  }) as typeof chrome.storage.local.remove;
  return state;
}

async function openVectorMappingDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("VectorDatabaseStorage", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("documentMappings")) {
        request.result.createObjectStore("documentMappings", { keyPath: "id" });
      }
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function putVectorMappingRecord(
  indexFileName: string,
  data: unknown,
): Promise<void> {
  const database = await openVectorMappingDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("documentMappings", "readwrite");
    transaction.objectStore("documentMappings").put({
      id: indexFileName,
      indexFileName,
      data,
      timestamp: Date.now(),
    });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  database.close();
}

async function getVectorMappingRecord(indexFileName: string): Promise<any> {
  const database = await openVectorMappingDatabase();
  const result = await new Promise<any>((resolve, reject) => {
    const transaction = database.transaction("documentMappings", "readonly");
    const request = transaction
      .objectStore("documentMappings")
      .get(indexFileName);
    request.onsuccess = () => resolve(request.result?.data);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return result;
}

async function abortNextVectorMappingWrite() {
  const database = await openVectorMappingDatabase();
  const prototype = Object.getPrototypeOf(database) as IDBDatabase;
  database.close();
  const originalTransaction = prototype.transaction;
  let armed = true;
  const transactionSpy = vi
    .spyOn(prototype, "transaction")
    .mockImplementation(function (
      this: IDBDatabase,
      storeNames: string | Iterable<string>,
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      const transaction = originalTransaction.call(
        this,
        storeNames,
        mode,
        options,
      );
      const names =
        typeof storeNames === "string" ? [storeNames] : Array.from(storeNames);
      if (armed && mode === "readwrite" && names.includes("documentMappings")) {
        armed = false;
        queueMicrotask(() => transaction.abort());
      }
      return transaction;
    });
  return transactionSpy;
}

function createMappingPayload({
  dimension,
  indexFileName,
  revision = 1,
  withDocument = true,
}: {
  dimension: number;
  indexFileName: string;
  revision?: number;
  withDocument?: boolean;
}) {
  const document = {
    id: "tab_7_chunk_0_1",
    tabId: 7,
    url: "https://example.test/private",
    title: "Private",
    chunk: {
      text: "private content",
      source: "content",
      index: 0,
      wordCount: 2,
    },
    embedding: new Float32Array(dimension).fill(0.25),
    timestamp: 1,
  };
  return {
    schemaVersion: 2,
    revision,
    updatedAt: revision,
    dimension,
    indexFileName,
    documents: withDocument ? [[0, document]] : [],
    tabDocuments: withDocument ? [[7, [0]]] : [],
    completedTabPages: withDocument
      ? [
          [
            7,
            {
              pageKey: `${document.url}\u0000${document.title}`,
              url: document.url,
              title: document.title,
              labels: [0],
              expectedCount: 1,
            },
          ],
        ]
      : [],
    nextLabel: withDocument ? 1 : 0,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  chrome.storage.local.get = originalStorageGet;
  chrome.storage.local.set = originalStorageSet;
  chrome.storage.local.remove = originalStorageRemove;
  vi.clearAllMocks();
  hnswMocks.addPointCalls.length = 0;
  hnswMocks.addedLabels.length = 0;
  hnswMocks.deletedLabels.length = 0;
  hnswMocks.fileCounts.clear();
  hnswMocks.fileLabelSnapshots.clear();
  hnswMocks.files.clear();
  hnswMocks.instances.length = 0;
  hnswMocks.readCalls.length = 0;
  hnswMocks.syncCalls.length = 0;
  hnswMocks.writeCalls.length = 0;
  hnswMocks.resetVectorFloatDeleteCalls();
  hnswMocks.resetSyncState();
});

describe("vector database cleanup", () => {
  it("clears and verifies an existing store without assuming its database version", async () => {
    const databaseName = `vector-cleanup-${crypto.randomUUID()}`;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 7);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("test-store");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("test-store", "readwrite");
      transaction.objectStore("test-store").put("value", "key");
      transaction.onerror = () => reject(transaction.error);
      transaction.oncomplete = () => resolve();
    });
    database.close();

    await clearIndexedDatabaseStore(databaseName, "test-store");

    const verifiedDatabase = await new Promise<IDBDatabase>(
      (resolve, reject) => {
        const request = indexedDB.open(databaseName);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      },
    );
    const count = await new Promise<number>((resolve, reject) => {
      const request = verifiedDatabase
        .transaction("test-store", "readonly")
        .objectStore("test-store")
        .count();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    verifiedDatabase.close();
    await deleteIndexedDatabase(databaseName);

    expect(count).toBe(0);
  });

  it("rejects an IndexedDB deletion error", async () => {
    const request: MutableDeleteRequest = {
      error: new DOMException("delete failed"),
    };
    stubDeleteRequest(request);

    const deletion = deleteIndexedDatabase("test-db");
    request.onerror?.(new Event("error"));

    await expect(deletion).rejects.toThrow(
      "Failed to delete IndexedDB database test-db",
    );
  });

  it("keeps a blocked IndexedDB deletion pending until the request completes", async () => {
    const request: MutableDeleteRequest = {};
    stubDeleteRequest(request);

    const deletion = deleteIndexedDatabase("test-db");
    let settled = false;
    void deletion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    request.onblocked?.(new Event("blocked"));
    await Promise.resolve();
    expect(settled).toBe(false);

    request.onsuccess?.(new Event("success"));
    await expect(deletion).resolves.toBeUndefined();
  });

  it("does not release a stalled IndexedDB deletion request", async () => {
    const request: MutableDeleteRequest = {};
    stubDeleteRequest(request);

    const deletion = deleteIndexedDatabase("test-db");
    let settled = false;
    void deletion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    request.onsuccess?.(new Event("success"));
    await deletion;
  });

  it("rejects an IndexedDB store open error", async () => {
    const request: MutableOpenRequest = {
      error: new DOMException("open failed"),
    };
    vi.stubGlobal("indexedDB", {
      open: vi.fn(() => request as unknown as IDBOpenDBRequest),
    });

    const cleanup = clearIndexedDatabaseStore("test-db", "test-store");
    request.onerror?.(new Event("error"));

    await expect(cleanup).rejects.toThrow(
      "Failed to open IndexedDB database test-db",
    );
  });

  it.each(["onerror", "onabort"] as const)(
    "rejects a clear transaction %s event",
    async (eventName) => {
      const transaction: MutableTransaction = {
        error: new DOMException("transaction failed"),
        objectStore: vi.fn(() => ({ clear: vi.fn() })),
      };
      const database = {
        close: vi.fn(),
        transaction: vi.fn(() => transaction),
      } as unknown as IDBDatabase;
      const request: MutableOpenRequest = { result: database };
      vi.stubGlobal("indexedDB", {
        open: vi.fn(() => request as unknown as IDBOpenDBRequest),
      });

      const cleanup = clearIndexedDatabaseStore("test-db", "test-store");
      request.onsuccess?.(new Event("success"));
      transaction[eventName]?.(new Event(eventName.slice(2)));

      await expect(cleanup).rejects.toThrow(
        /IndexedDB store test-db\/test-store/,
      );
      expect(database.close).toHaveBeenCalledOnce();
    },
  );

  it("rejects when verification finds records after the store was cleared", async () => {
    const countRequest = {
      error: null,
      result: 2,
      onerror: null,
      onsuccess: null,
    } as unknown as IDBRequest<number>;
    const clearTransaction: MutableTransaction = {
      objectStore: vi.fn(() => ({ clear: vi.fn() })),
    };
    const verifyTransaction: MutableTransaction = {
      objectStore: vi.fn(() => ({ count: vi.fn(() => countRequest) })),
    };
    const database = {
      close: vi.fn(),
      transaction: vi
        .fn()
        .mockReturnValueOnce(clearTransaction)
        .mockReturnValueOnce(verifyTransaction),
    } as unknown as IDBDatabase;
    const request: MutableOpenRequest = { result: database };
    vi.stubGlobal("indexedDB", {
      open: vi.fn(() => request as unknown as IDBOpenDBRequest),
    });

    const cleanup = clearIndexedDatabaseStore("test-db", "test-store");
    request.onsuccess?.(new Event("success"));
    clearTransaction.oncomplete?.(new Event("complete"));
    countRequest.onsuccess?.(new Event("success"));

    await expect(cleanup).rejects.toThrow("still contains 2 records");
    expect(database.close).toHaveBeenCalledOnce();
  });

  it("does not release a stalled IndexedDB store open request", async () => {
    const request: MutableOpenRequest = {};
    vi.stubGlobal("indexedDB", {
      open: vi.fn(() => request as unknown as IDBOpenDBRequest),
    });

    const cleanup = clearIndexedDatabaseStore("test-db", "test-store");
    let settled = false;
    void cleanup.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    request.onerror?.(new Event("error"));
    await expect(cleanup).rejects.toThrow(
      "Failed to open IndexedDB database test-db",
    );
  });

  it("coalesces concurrent comprehensive cleanup requests", async () => {
    const deleteDatabase = vi.fn(() => {
      const request: MutableDeleteRequest = {};
      queueMicrotask(() => request.onsuccess?.(new Event("success")));
      return request as unknown as IDBOpenDBRequest;
    });
    vi.stubGlobal("indexedDB", { deleteDatabase });
    vi.mocked(chrome.storage.local.remove).mockResolvedValue(undefined);
    chrome.storage.local.get = vi.fn(
      async () => ({}),
    ) as typeof chrome.storage.local.get;

    const first = clearAllVectorData();
    const second = clearAllVectorData();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(deleteDatabase).toHaveBeenCalledTimes(2);
    expect(chrome.storage.local.remove).toHaveBeenCalledOnce();
  });

  it("continues later persistent cleanup after a deletion error and can be retried", async () => {
    let failMappingsOnce = true;
    const deleteDatabase = vi.fn((databaseName: string) => {
      const request: MutableDeleteRequest = {};
      queueMicrotask(() => {
        if (databaseName === "VectorDatabaseStorage" && failMappingsOnce) {
          failMappingsOnce = false;
          request.onerror?.(new Event("error"));
        } else {
          request.onsuccess?.(new Event("success"));
        }
      });
      return request as unknown as IDBOpenDBRequest;
    });
    vi.stubGlobal("indexedDB", { deleteDatabase });
    vi.mocked(chrome.storage.local.remove).mockResolvedValue(undefined);
    chrome.storage.local.get = vi.fn(
      async () => ({}),
    ) as typeof chrome.storage.local.get;

    await expect(clearAllVectorData()).rejects.toThrow(
      "Vector data cleanup did not complete",
    );
    expect(deleteDatabase).toHaveBeenCalledWith("/hnswlib-index");
    expect(chrome.storage.local.remove).toHaveBeenCalledOnce();

    await expect(clearAllVectorData()).resolves.toBeUndefined();
    expect(deleteDatabase).toHaveBeenCalledTimes(4);
    expect(chrome.storage.local.remove).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid HNSW sizing and retention configuration before initialization", () => {
    for (const dimension of [0, -1, 1.5, 0x1_0000_0000]) {
      expect(() => new VectorDatabase({ dimension })).toThrow(
        "dimension must be a positive safe integer",
      );
    }
    for (const maxElements of [0, -1, 1.5, 0x1_0000_0000]) {
      expect(() => new VectorDatabase({ maxElements })).toThrow(
        "maxElements must be a positive safe integer",
      );
    }
    for (const maxRetentionDays of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new VectorDatabase({ maxRetentionDays })).toThrow(
        "maxRetentionDays must be a finite non-negative number",
      );
    }
    expect(() => new VectorDatabase({ maxRetentionDays: 0 })).not.toThrow();
    expect(hnswMocks.instances).toHaveLength(0);
  });

  it("bounds the initial wait when the HNSW filesystem never becomes idle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    hnswMocks.setSynced(false);
    const database = new VectorDatabase({
      dimension: 3,
      indexFileName: `idle-timeout-${crypto.randomUUID()}.dat`,
    });

    const initialization = database.initialize();
    const rejection = expect(initialization).rejects.toThrow(
      "Timed out after 30000ms waiting for HNSW filesystem to become idle",
    );
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects writes when the durable HNSW label space is exhausted", async () => {
    const indexFileName = `label-exhausted-${crypto.randomUUID()}.dat`;
    const mapping = createMappingPayload({
      dimension: 3,
      indexFileName,
      withDocument: false,
    });
    mapping.nextLabel = 0xffffffff;
    await putVectorMappingRecord(indexFileName, mapping);
    useStatefulChromeStorage();
    hnswMocks.setPopulateSnapshot([[indexFileName, 0]]);
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();

    await expect(
      database.addDocument(
        7,
        "https://example.test/exhausted",
        "Exhausted",
        { text: "blocked", source: "content", index: 0, wordCount: 1 },
        new Float32Array([1, 0, 0]),
      ),
    ).rejects.toThrow("HNSW label space is exhausted");
    expect(hnswMocks.addPointCalls).toHaveLength(0);
    expect(hnswMocks.getVectorFloatDeleteCalls()).toBe(1);
  });

  it("replaces an initialized index with a supported empty HNSW index", async () => {
    chrome.storage.local.get = vi.fn(
      async () => ({}),
    ) as typeof chrome.storage.local.get;
    vi.mocked(chrome.storage.local.remove).mockResolvedValue(undefined);
    const database = new VectorDatabase({
      dimension: 3,
      indexFileName: "content_index.dat",
    });
    await database.initialize();
    await database.addDocument(
      7,
      "https://example.test/",
      "Example",
      { text: "private page", source: "content", index: 0, wordCount: 2 },
      new Float32Array([1, 0, 0]),
    );

    expect(database.getStats().totalDocuments).toBe(1);
    await database.clear();

    expect(database.getStats()).toMatchObject({
      totalDocuments: 0,
      totalTabs: 0,
    });
    expect(hnswMocks.instances.at(-1)?.count).toBe(0);
    expect(hnswMocks.instances.at(-1)?.fileName).toBe("");
    expect(hnswMocks.files.has("content_index.dat")).toBe(true);
    expect(hnswMocks.syncCalls.filter((populate) => !populate)).toHaveLength(0);
    expect("deleteFile" in hnswMocks.manager).toBe(false);
    expect("deleteIndex" in hnswMocks.HierarchicalNSW.prototype).toBe(false);
  });

  it("bounds a syncFS call whose completion callback never arrives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    hnswMocks.setAutoCompleteSyncFS(false);
    const database = new VectorDatabase({
      dimension: 3,
      indexFileName: `sync-callback-timeout-${crypto.randomUUID()}.dat`,
    });

    const initialization = database.initialize();
    const rejection = expect(initialization).rejects.toThrow(
      "Timed out after 30000ms waiting for syncFS callback",
    );
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects when a syncFS callback reports an unsuccessful IDBFS sync", async () => {
    chrome.storage.local.get = vi.fn(
      async () => ({}),
    ) as typeof chrome.storage.local.get;
    vi.mocked(chrome.storage.local.remove).mockResolvedValue(undefined);
    hnswMocks.setSyncShouldSucceed(false);

    await expect(clearAllVectorData()).rejects.toThrow(
      "Vector data cleanup did not complete",
    );

    expect(hnswMocks.syncCalls.at(-1)).toBe(true);
    expect(hnswMocks.manager.isSynced).toHaveBeenCalled();
    hnswMocks.resetSyncState();
  });

  it("keeps the persistence queue closed until a late write sync actually completes", async () => {
    chrome.storage.local.get = vi.fn(
      async () => ({}),
    ) as typeof chrome.storage.local.get;
    vi.mocked(chrome.storage.local.remove).mockResolvedValue(undefined);
    const database = new VectorDatabase({ dimension: 3 });
    await database.initialize();
    hnswMocks.setAutoCompleteWriteSync(false);

    let firstSettled = false;
    const first = database.clear().then(() => {
      firstSettled = true;
    });
    const second = database.clear();
    await vi.waitFor(() => expect(hnswMocks.pendingWriteSyncs).toHaveLength(1));
    expect(hnswMocks.writeCalls).toHaveLength(1);
    expect(firstSettled).toBe(false);

    hnswMocks.completeNextWriteSync();
    await vi.waitFor(() => expect(hnswMocks.pendingWriteSyncs).toHaveLength(1));
    expect(hnswMocks.writeCalls).toHaveLength(2);

    hnswMocks.completeNextWriteSync();
    await Promise.all([first, second]);
  });

  it("accepts a write sync that completes before its first state observation", async () => {
    useStatefulChromeStorage();
    const database = new VectorDatabase({
      dimension: 3,
      indexFileName: `fast-write-sync-${crypto.randomUUID()}.dat`,
    });
    await database.initialize();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    hnswMocks.setCompleteWriteSyncSynchronously(true);

    await expect(database.clear()).resolves.toBeUndefined();

    expect(hnswMocks.writeCalls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a write sync when the filesystem manager never becomes idle", async () => {
    useStatefulChromeStorage();
    const database = new VectorDatabase({
      dimension: 3,
      indexFileName: `write-timeout-${crypto.randomUUID()}.dat`,
    });
    await database.initialize();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    hnswMocks.setAutoCompleteWriteSync(false);

    const clearing = database.clear();
    const capturedFailure = clearing.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);

    const failure = await capturedFailure;
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(String)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Timed out after 30000ms waiting for writeIndex filesystem synchronization",
        ),
      ]),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds both the original write and its rollback persistence", async () => {
    useStatefulChromeStorage();
    const database = new VectorDatabase({
      dimension: 3,
      indexFileName: `rollback-write-timeout-${crypto.randomUUID()}.dat`,
    });
    await database.initialize();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    hnswMocks.setAutoCompleteWriteSync(false);

    const addition = database.addDocument(
      7,
      "https://example.test/page",
      "Page",
      { text: "private", source: "content", index: 0, wordCount: 1 },
      new Float32Array([1, 0, 0]),
    );
    const capturedFailure = addition.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);

    const failure = await capturedFailure;
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toContain(
      "rollback did not complete",
    );
    expect((failure as AggregateError).errors.map(String)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Timed out after 30000ms waiting for writeIndex filesystem synchronization",
        ),
      ]),
    );
    expect(hnswMocks.writeCalls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("loads an HNSW index only after matching durable metadata is validated", async () => {
    const indexFileName = `matching-${crypto.randomUUID()}.dat`;
    const mapping = createMappingPayload({
      dimension: 3,
      indexFileName,
      revision: 4,
    });
    await putVectorMappingRecord(indexFileName, mapping);
    useStatefulChromeStorage();
    hnswMocks.setPopulateSnapshot([[indexFileName, 1]]);

    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();

    expect(hnswMocks.readCalls).toEqual([indexFileName]);
    expect(hnswMocks.writeCalls).not.toContain(indexFileName);
    expect(database.getStats()).toMatchObject({
      totalDocuments: 1,
      totalTabs: 1,
    });
  });

  it("restores only a durably committed page and returns defensive stable identities", async () => {
    const indexFileName = `completed-page-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const writer = new VectorDatabase({ dimension: 3, indexFileName });
    await writer.initialize();
    await writer.addDocument(
      9,
      "https://example.test/complete",
      "Complete",
      { text: "first", source: "content", index: 0, wordCount: 1 },
      new Float32Array([1, 0, 0]),
    );
    await writer.addDocument(
      9,
      "https://example.test/complete",
      "Complete",
      { text: "second", source: "content", index: 1, wordCount: 1 },
      new Float32Array([0, 1, 0]),
    );

    await expect(writer.inspectTabPageState()).resolves.toEqual({
      completedPages: [],
      repairTabIds: [9],
    });
    await writer.commitTabPage(9, "https://example.test/complete", "Complete");
    await expect(getVectorMappingRecord(indexFileName)).resolves.toMatchObject({
      schemaVersion: 2,
      completedTabPages: [
        [
          9,
          {
            pageKey: "https://example.test/complete\u0000Complete",
            labels: [0, 1],
            expectedCount: 2,
          },
        ],
      ],
    });

    hnswMocks.setPopulateSnapshot([[indexFileName, 2]]);
    const restarted = new VectorDatabase({ dimension: 3, indexFileName });
    await restarted.initialize();
    const inspection = await restarted.inspectTabPageState();
    expect(inspection).toEqual({
      completedPages: [
        {
          tabId: 9,
          pageKey: "https://example.test/complete\u0000Complete",
          url: "https://example.test/complete",
          title: "Complete",
          expectedCount: 2,
        },
      ],
      repairTabIds: [],
    });

    inspection.completedPages[0].pageKey = "mutated";
    inspection.repairTabIds.push(99);
    await expect(restarted.inspectTabPageState()).resolves.toEqual({
      completedPages: [
        expect.objectContaining({
          tabId: 9,
          pageKey: "https://example.test/complete\u0000Complete",
        }),
      ],
      repairTabIds: [],
    });
  });

  it("invalidates a completed page as part of persisting its next chunk", async () => {
    const indexFileName = `invalidate-page-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    await database.addDocument(
      7,
      "https://example.test/page",
      "Page",
      { text: "first", source: "content", index: 0, wordCount: 1 },
      new Float32Array([1, 0, 0]),
    );
    await database.commitTabPage(7, "https://example.test/page", "Page");

    await database.addDocument(
      7,
      "https://example.test/page",
      "Page",
      { text: "new chunk", source: "content", index: 1, wordCount: 2 },
      new Float32Array([0, 1, 0]),
    );

    await expect(database.inspectTabPageState()).resolves.toEqual({
      completedPages: [],
      repairTabIds: [7],
    });
    await expect(getVectorMappingRecord(indexFileName)).resolves.toMatchObject({
      tabDocuments: [[7, [0, 1]]],
      completedTabPages: [],
    });
  });

  it("classifies and durably removes an uncommitted page after a database restart", async () => {
    const indexFileName = `partial-restart-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const interruptedWorker = new VectorDatabase({
      dimension: 3,
      indexFileName,
    });
    await interruptedWorker.initialize();
    await interruptedWorker.addDocument(
      17,
      "https://example.test/interrupted",
      "Interrupted",
      { text: "partial", source: "content", index: 0, wordCount: 1 },
      new Float32Array([1, 0, 0]),
    );

    hnswMocks.setPopulateSnapshot([[indexFileName, 1]]);
    const restartedWorker = new VectorDatabase({
      dimension: 3,
      indexFileName,
    });
    await restartedWorker.initialize();
    await expect(restartedWorker.inspectTabPageState()).resolves.toEqual({
      completedPages: [],
      repairTabIds: [17],
    });

    await restartedWorker.ensureTabDocumentsRemoved(17);
    await expect(restartedWorker.inspectTabPageState()).resolves.toEqual({
      completedPages: [],
      repairTabIds: [],
    });
    await expect(getVectorMappingRecord(indexFileName)).resolves.toMatchObject({
      documents: [],
      tabDocuments: [],
      completedTabPages: [],
      nextLabel: 1,
    });
  });

  it("serializes inspection behind an in-flight chunk persistence", async () => {
    const indexFileName = `inspect-queue-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    hnswMocks.setAutoCompleteWriteSync(false);

    const add = database.addDocument(
      7,
      "https://example.test/page",
      "Page",
      { text: "private", source: "content", index: 0, wordCount: 1 },
      new Float32Array([1, 0, 0]),
    );
    await vi.waitFor(() => expect(hnswMocks.pendingWriteSyncs).toHaveLength(1));
    let inspectionSettled = false;
    const inspection = database.inspectTabPageState().finally(() => {
      inspectionSettled = true;
    });
    await Promise.resolve();
    expect(inspectionSettled).toBe(false);

    hnswMocks.completeNextWriteSync();
    await expect(add).resolves.toBe(0);
    await expect(inspection).resolves.toEqual({
      completedPages: [],
      repairTabIds: [7],
    });
  });

  it("never searches an uncommitted page while returning a completed page", async () => {
    const indexFileName = `search-completion-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    await database.addDocument(
      7,
      "https://example.test/incomplete",
      "Incomplete",
      { text: "incomplete", source: "content", index: 0, wordCount: 1 },
      new Float32Array([1, 0, 0]),
    );
    await database.addDocument(
      8,
      "https://example.test/complete",
      "Complete",
      { text: "complete", source: "content", index: 0, wordCount: 1 },
      new Float32Array([0, 1, 0]),
    );
    await database.commitTabPage(
      8,
      "https://example.test/complete",
      "Complete",
    );

    await expect(
      database.search(new Float32Array([1, 0, 0]), 10),
    ).resolves.toEqual([
      expect.objectContaining({
        document: expect.objectContaining({ tabId: 8, title: "Complete" }),
      }),
    ]);
    const filter = hnswMocks.searchCalls.at(-1)?.filter;
    expect(filter?.(0)).toBe(false);
    expect(filter?.(1)).toBe(true);
  });

  it("makes a page searchable only after its completion commit succeeds", async () => {
    const indexFileName = `search-after-commit-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    await database.addDocument(
      7,
      "https://example.test/page",
      "Page",
      { text: "private", source: "content", index: 0, wordCount: 1 },
      new Float32Array([1, 0, 0]),
    );

    await expect(database.search(new Float32Array([1, 0, 0]))).resolves.toEqual(
      [],
    );
    expect(hnswMocks.searchCalls).toHaveLength(0);

    await database.commitTabPage(7, "https://example.test/page", "Page");
    const deletesBeforeSearch = hnswMocks.getVectorFloatDeleteCalls();
    await expect(database.search(new Float32Array([1, 0, 0]))).resolves.toEqual(
      [
        expect.objectContaining({
          document: expect.objectContaining({ tabId: 7, title: "Page" }),
        }),
      ],
    );
    expect(hnswMocks.getVectorFloatDeleteCalls() - deletesBeforeSearch).toBe(1);
  });

  it("keeps owned document data isolated from add inputs and search results", async () => {
    const indexFileName = `document-copy-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    const chunk = {
      text: "original",
      source: "content",
      index: 0,
      wordCount: 1,
    };
    const embedding = new Float32Array([1, 0, 0]);

    await database.addDocument(
      7,
      "https://example.test/page",
      "Page",
      chunk,
      embedding,
    );
    chunk.text = "mutated input";
    embedding[0] = 99;
    await database.commitTabPage(7, "https://example.test/page", "Page");

    const first = await database.search(new Float32Array([1, 0, 0]));
    expect(first[0].document.chunk.text).toBe("original");
    expect(Array.from(first[0].document.embedding)).toEqual([1, 0, 0]);

    first[0].document.chunk.text = "mutated result";
    first[0].document.embedding[0] = 88;
    const second = await database.search(new Float32Array([1, 0, 0]));
    expect(second[0].document.chunk.text).toBe("original");
    expect(Array.from(second[0].document.embedding)).toEqual([1, 0, 0]);
    expect(second[0].document).not.toBe(first[0].document);
    expect(second[0].document.chunk).not.toBe(first[0].document.chunk);
    expect(second[0].document.embedding).not.toBe(first[0].document.embedding);
  });

  it("releases a failed VectorFloat query before using the search fallback", async () => {
    const indexFileName = `search-vector-release-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    await database.addDocument(
      7,
      "https://example.test/page",
      "Page",
      { text: "private", source: "content", index: 0, wordCount: 1 },
      new Float32Array([1, 0, 0]),
    );
    await database.commitTabPage(7, "https://example.test/page", "Page");
    hnswMocks.setSearchFailures(1);
    const deletesBeforeSearch = hnswMocks.getVectorFloatDeleteCalls();

    await expect(database.search(new Float32Array([1, 0, 0]))).resolves.toEqual(
      [
        expect.objectContaining({
          document: expect.objectContaining({ tabId: 7 }),
        }),
      ],
    );
    expect(hnswMocks.searchCalls).toHaveLength(2);
    expect(hnswMocks.getVectorFloatDeleteCalls() - deletesBeforeSearch).toBe(1);
  });

  it("queues search behind an in-flight completion persistence", async () => {
    const indexFileName = `search-commit-queue-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    await database.addDocument(
      7,
      "https://example.test/page",
      "Page",
      { text: "private", source: "content", index: 0, wordCount: 1 },
      new Float32Array([1, 0, 0]),
    );

    const statefulRemove = chrome.storage.local.remove;
    let releaseRemoval!: () => void;
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    chrome.storage.local.remove = vi.fn(async (keys: string | string[]) => {
      await removalGate;
      await statefulRemove(keys);
    }) as typeof chrome.storage.local.remove;

    const commit = database.commitTabPage(
      7,
      "https://example.test/page",
      "Page",
    );
    await vi.waitFor(() =>
      expect(chrome.storage.local.remove).toHaveBeenCalled(),
    );
    let searchSettled = false;
    const search = database.search(new Float32Array([1, 0, 0])).finally(() => {
      searchSettled = true;
    });
    await Promise.resolve();
    expect(searchSettled).toBe(false);
    expect(hnswMocks.searchCalls).toHaveLength(0);

    releaseRemoval();
    await expect(commit).resolves.toBeUndefined();
    await expect(search).resolves.toEqual([
      expect.objectContaining({
        document: expect.objectContaining({ tabId: 7 }),
      }),
    ]);
  });

  it("keeps a page unsearchable after its queued completion commit fails", async () => {
    const indexFileName = `search-failed-commit-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    await database.addDocument(
      7,
      "https://example.test/page",
      "Page",
      { text: "private", source: "content", index: 0, wordCount: 1 },
      new Float32Array([1, 0, 0]),
    );
    const transactionSpy = await abortNextVectorMappingWrite();
    const statefulSet = chrome.storage.local.set;
    let rejectFallbackOnce = true;
    chrome.storage.local.set = vi.fn(async (values) => {
      if (rejectFallbackOnce) {
        rejectFallbackOnce = false;
        throw new Error("completion fallback failed");
      }
      await statefulSet(values);
    }) as typeof chrome.storage.local.set;

    try {
      const commit = database.commitTabPage(
        7,
        "https://example.test/page",
        "Page",
      );
      const search = database.search(new Float32Array([1, 0, 0]));

      await expect(commit).rejects.toThrow("Failed to save vector mappings");
      await expect(search).resolves.toEqual([]);
      expect(hnswMocks.searchCalls).toHaveLength(0);
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it("treats a deleted last tab as an empty searchable state", async () => {
    const indexFileName = `search-empty-deleted-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    await database.addDocument(
      7,
      "https://example.test/page",
      "Page",
      { text: "private", source: "content", index: 0, wordCount: 1 },
      new Float32Array([1, 0, 0]),
    );
    await database.commitTabPage(7, "https://example.test/page", "Page");
    await database.removeTabDocuments(7);
    hnswMocks.searchCalls.length = 0;

    await expect(database.search(new Float32Array([1, 0, 0]))).resolves.toEqual(
      [],
    );
    expect(hnswMocks.searchCalls).toHaveLength(0);
    expect(database.getStats()).toMatchObject({
      totalDocuments: 0,
      totalTabs: 0,
    });
  });

  it("serializes clear behind an in-flight add mutation", async () => {
    const indexFileName = `clear-add-queue-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    hnswMocks.setAutoCompleteWriteSync(false);

    const add = database.addDocument(
      7,
      "https://example.test/page",
      "Page",
      { text: "private", source: "content", index: 0, wordCount: 1 },
      new Float32Array([1, 0, 0]),
    );
    await vi.waitFor(() => expect(hnswMocks.pendingWriteSyncs).toHaveLength(1));
    let clearSettled = false;
    const clear = database.clear().finally(() => {
      clearSettled = true;
    });
    await Promise.resolve();
    expect(clearSettled).toBe(false);
    expect(database.getStats().totalDocuments).toBe(1);

    hnswMocks.completeNextWriteSync();
    await expect(add).resolves.toBe(0);
    await vi.waitFor(() => expect(hnswMocks.pendingWriteSyncs).toHaveLength(1));
    hnswMocks.completeNextWriteSync();
    await expect(clear).resolves.toBeUndefined();

    expect(database.getStats()).toMatchObject({
      totalDocuments: 0,
      totalTabs: 0,
    });
    await expect(database.search(new Float32Array([1, 0, 0]))).resolves.toEqual(
      [],
    );
  });

  it("rejects mixed page commit and classifies incomplete mixed mappings for repair", async () => {
    const indexFileName = `mixed-page-${crypto.randomUUID()}.dat`;
    const mapping = createMappingPayload({ dimension: 3, indexFileName });
    const firstDocument = (mapping as any).documents[0][1];
    const secondDocument = {
      ...firstDocument,
      id: "tab_7_chunk_1_2",
      url: "https://example.test/other",
      title: "Other",
      chunk: { ...firstDocument.chunk, index: 1 },
    };
    (mapping as any).documents.push([1, secondDocument]);
    mapping.tabDocuments = [[7, [0, 1]]];
    mapping.completedTabPages = [];
    mapping.nextLabel = 2;
    await putVectorMappingRecord(indexFileName, mapping);
    useStatefulChromeStorage();
    hnswMocks.setPopulateSnapshot([[indexFileName, 2]]);

    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    await expect(database.inspectTabPageState()).resolves.toEqual({
      completedPages: [],
      repairTabIds: [7],
    });
    await expect(
      database.commitTabPage(7, "https://example.test/private", "Private"),
    ).rejects.toThrow("mixed or inconsistent");
    await database.ensureTabDocumentsRemoved(7);
    await expect(database.inspectTabPageState()).resolves.toEqual({
      completedPages: [],
      repairTabIds: [],
    });
  });

  it("drops an unverified completion marker after commit persistence fails", async () => {
    const indexFileName = `commit-failure-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    await database.addDocument(
      7,
      "https://example.test/page",
      "Page",
      { text: "private", source: "content", index: 0, wordCount: 1 },
      new Float32Array([1, 0, 0]),
    );
    const transactionSpy = await abortNextVectorMappingWrite();
    const statefulSet = chrome.storage.local.set;
    let rejectFallbackOnce = true;
    chrome.storage.local.set = vi.fn(async (values) => {
      if (rejectFallbackOnce) {
        rejectFallbackOnce = false;
        throw new Error("commit fallback failed");
      }
      await statefulSet(values);
    }) as typeof chrome.storage.local.set;

    try {
      await expect(
        database.commitTabPage(7, "https://example.test/page", "Page"),
      ).rejects.toThrow("Failed to save vector mappings");
      await expect(database.inspectTabPageState()).resolves.toEqual({
        completedPages: [],
        repairTabIds: [7],
      });
      await expect(
        getVectorMappingRecord(indexFileName),
      ).resolves.toMatchObject({
        tabDocuments: [[7, [0]]],
        completedTabPages: [],
      });
      await expect(
        database.ensureTabDocumentsRemoved(7),
      ).resolves.toBeUndefined();
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it("removes and verifies a stale fallback after the primary mapping commit", async () => {
    const indexFileName = `primary-${crypto.randomUUID()}.dat`;
    const storageKey = `hnswlib_document_mappings_${indexFileName}`;
    const storage = useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();

    storage[storageKey] = createMappingPayload({
      dimension: 3,
      indexFileName,
      revision: 99,
    });
    await database.addDocument(
      7,
      "https://example.test/current",
      "Current",
      { text: "current content", source: "content", index: 0, wordCount: 2 },
      new Float32Array([0.1, 0.2, 0.3]),
    );

    expect(storage).not.toHaveProperty(storageKey);
    expect(chrome.storage.local.remove).toHaveBeenCalledWith([storageKey]);
    await expect(getVectorMappingRecord(indexFileName)).resolves.toMatchObject({
      schemaVersion: 2,
      revision: 1,
      dimension: 3,
      documents: [[0, expect.objectContaining({ tabId: 7 })]],
    });
  });

  it("does not report a primary mapping save as successful when fallback cleanup fails", async () => {
    const indexFileName = `primary-cleanup-failure-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    chrome.storage.local.remove = vi.fn(async () => {
      throw new Error("fallback cleanup failed");
    }) as typeof chrome.storage.local.remove;

    await expect(
      database.addDocument(
        7,
        "https://example.test/current",
        "Current",
        { text: "current content", source: "content", index: 0, wordCount: 2 },
        new Float32Array([0.1, 0.2, 0.3]),
      ),
    ).rejects.toThrow("rollback did not complete");
    expect(database.getStats().totalDocuments).toBe(0);
    expect(hnswMocks.deletedLabels).toEqual([0]);
    expect(hnswMocks.getVectorFloatDeleteCalls()).toBe(1);
  });

  it("calls addPoint only once for a capacity error and durably retires its label", async () => {
    const indexFileName = `capacity-add-failure-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    hnswMocks.failNextAddPoint(
      "before-mutation",
      "HNSW index capacity exceeded",
    );

    await expect(
      database.addDocument(
        7,
        "https://example.test/full",
        "Full",
        { text: "full", source: "content", index: 0, wordCount: 1 },
        new Float32Array([1, 0, 0]),
      ),
    ).rejects.toThrow("capacity exceeded");

    expect(hnswMocks.addPointCalls).toHaveLength(1);
    expect(hnswMocks.addedLabels).toEqual([]);
    expect(hnswMocks.deletedLabels).toEqual([]);
    expect(hnswMocks.getVectorFloatDeleteCalls()).toBe(1);
    await expect(getVectorMappingRecord(indexFileName)).resolves.toMatchObject({
      nextLabel: 1,
      documents: [],
      tabDocuments: [],
    });

    await expect(
      database.addDocument(
        8,
        "https://example.test/retry",
        "Retry",
        { text: "retry", source: "content", index: 0, wordCount: 1 },
        new Float32Array([0, 1, 0]),
      ),
    ).resolves.toBe(1);
    expect(hnswMocks.addPointCalls).toHaveLength(2);
  });

  it("rolls back a possibly mutated addPoint failure without replaying it", async () => {
    const indexFileName = `ambiguous-add-failure-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    hnswMocks.failNextAddPoint(
      "after-mutation",
      "native add failed after mutation",
    );

    await expect(
      database.addDocument(
        7,
        "https://example.test/ambiguous",
        "Ambiguous",
        { text: "private", source: "content", index: 0, wordCount: 1 },
        new Float32Array([1, 0, 0]),
      ),
    ).rejects.toThrow("native add failed after mutation");

    expect(hnswMocks.addPointCalls).toHaveLength(1);
    expect(hnswMocks.addedLabels).toEqual([0]);
    expect(hnswMocks.deletedLabels).toEqual([0]);
    expect(hnswMocks.getVectorFloatDeleteCalls()).toBe(1);
    expect(hnswMocks.fileLabelSnapshots.get(indexFileName)).toMatchObject({
      currentCount: 1,
      deletedLabels: [0],
      usedLabels: [0],
    });
    await expect(getVectorMappingRecord(indexFileName)).resolves.toMatchObject({
      nextLabel: 1,
      documents: [],
      tabDocuments: [],
    });

    await expect(
      database.addDocument(
        8,
        "https://example.test/safe",
        "Safe",
        { text: "safe", source: "content", index: 0, wordCount: 1 },
        new Float32Array([0, 1, 0]),
      ),
    ).resolves.toBe(1);
    expect(hnswMocks.addPointCalls).toHaveLength(2);
  });

  it("serializes a concurrent add behind rollback after an aborted mapping transaction", async () => {
    const indexFileName = `add-rollback-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    const transactionSpy = await abortNextVectorMappingWrite();
    const statefulSet = chrome.storage.local.set;
    let rejectFallbackOnce = true;
    chrome.storage.local.set = vi.fn(async (values) => {
      if (rejectFallbackOnce) {
        rejectFallbackOnce = false;
        throw new Error("fallback write failed");
      }
      await statefulSet(values);
    }) as typeof chrome.storage.local.set;

    try {
      const failedAdd = database.addDocument(
        7,
        "https://example.test/failed",
        "Failed",
        { text: "failed chunk", source: "content", index: 0, wordCount: 2 },
        new Float32Array([1, 0, 0]),
      );
      const succeedingAdd = database.addDocument(
        8,
        "https://example.test/success",
        "Success",
        { text: "success chunk", source: "content", index: 0, wordCount: 2 },
        new Float32Array([0, 1, 0]),
      );

      await expect(failedAdd).rejects.toThrow("Failed to save vector mappings");
      await expect(succeedingAdd).resolves.toBe(1);

      expect(hnswMocks.addedLabels).toEqual([0, 1]);
      expect(hnswMocks.deletedLabels).toEqual([0]);
      expect(hnswMocks.getVectorFloatDeleteCalls()).toBe(2);
      expect(
        hnswMocks.writeCalls.filter((name) => name === indexFileName),
      ).toHaveLength(3);
      expect(database.getStats()).toMatchObject({
        totalDocuments: 1,
        totalTabs: 1,
      });
      await expect(
        getVectorMappingRecord(indexFileName),
      ).resolves.toMatchObject({
        revision: 3,
        nextLabel: 2,
        documents: [[1, expect.objectContaining({ tabId: 8 })]],
        tabDocuments: [[8, [1]]],
      });
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it("rolls back an added point after the initial index write fails without reusing its label", async () => {
    const indexFileName = `index-write-rollback-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    hnswMocks.setWriteFailures(1);

    await expect(
      database.addDocument(
        7,
        "https://example.test/failed",
        "Failed",
        { text: "failed chunk", source: "content", index: 0, wordCount: 2 },
        new Float32Array([1, 0, 0]),
      ),
    ).rejects.toThrow("index write failed");

    expect(hnswMocks.deletedLabels).toEqual([0]);
    expect(database.getStats().totalDocuments).toBe(0);
    await expect(getVectorMappingRecord(indexFileName)).resolves.toMatchObject({
      revision: 1,
      nextLabel: 1,
      documents: [],
      tabDocuments: [],
    });

    await expect(
      database.addDocument(
        8,
        "https://example.test/retry",
        "Retry",
        { text: "retry chunk", source: "content", index: 0, wordCount: 2 },
        new Float32Array([0, 1, 0]),
      ),
    ).resolves.toBe(1);
  });

  it("resets and rejects an add whose persisted HNSW gains an active orphan", async () => {
    const indexFileName = `add-invariant-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    hnswMocks.setAutoCompleteWriteSync(false);

    const add = database.addDocument(
      7,
      "https://example.test/page",
      "Page",
      { text: "private", source: "content", index: 0, wordCount: 1 },
      new Float32Array([1, 0, 0]),
    );
    await vi.waitFor(() => expect(hnswMocks.pendingWriteSyncs).toHaveLength(1));
    const index = hnswMocks.instances.at(-1) as unknown as {
      addPoint(vector: number[], label: number): void;
    };
    index.addPoint([0, 1, 0], 9);
    hnswMocks.completeNextWriteSync();

    await vi.waitFor(() => expect(hnswMocks.pendingWriteSyncs).toHaveLength(1));
    hnswMocks.completeNextWriteSync();
    await expect(add).rejects.toThrow("active-label invariant");

    expect(database.getStats()).toMatchObject({
      isInitialized: true,
      totalDocuments: 0,
      totalTabs: 0,
    });
    expect(hnswMocks.fileLabelSnapshots.get(indexFileName)).toMatchObject({
      currentCount: 0,
      deletedLabels: [],
      usedLabels: [],
    });
  });

  it("blocks ordinary access after rollback cannot delete an active point and lets clear recover", async () => {
    const indexFileName = `unsafe-rollback-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    const transactionSpy = await abortNextVectorMappingWrite();
    const statefulSet = chrome.storage.local.set;
    let rejectFallbackOnce = true;
    chrome.storage.local.set = vi.fn(async (values) => {
      if (rejectFallbackOnce) {
        rejectFallbackOnce = false;
        throw new Error("initial mapping fallback failed");
      }
      await statefulSet(values);
    }) as typeof chrome.storage.local.set;
    hnswMocks.setMarkDeleteFailures(1);

    try {
      await expect(
        database.addDocument(
          7,
          "https://example.test/page",
          "Page",
          { text: "private", source: "content", index: 0, wordCount: 1 },
          new Float32Array([1, 0, 0]),
        ),
      ).rejects.toThrow("rollback did not complete");
    } finally {
      transactionSpy.mockRestore();
    }

    expect(database.getStats().isInitialized).toBe(false);
    await expect(database.search(new Float32Array([1, 0, 0]))).rejects.toThrow(
      "access is blocked",
    );
    await expect(
      database.commitTabPage(7, "https://example.test/page", "Page"),
    ).rejects.toThrow("access is blocked");
    await expect(
      database.addDocument(
        8,
        "https://example.test/blocked",
        "Blocked",
        { text: "blocked", source: "content", index: 0, wordCount: 1 },
        new Float32Array([0, 1, 0]),
      ),
    ).rejects.toThrow("access is blocked");

    await expect(database.clear()).resolves.toBeUndefined();
    expect(database.getStats()).toMatchObject({
      isInitialized: true,
      totalDocuments: 0,
      totalTabs: 0,
    });
    await expect(
      database.addDocument(
        8,
        "https://example.test/recovered",
        "Recovered",
        { text: "recovered", source: "content", index: 0, wordCount: 1 },
        new Float32Array([0, 1, 0]),
      ),
    ).resolves.toBe(0);
  });

  it("aggregates index and mapping failures during rollback and permits a forced retry", async () => {
    const indexFileName = `rollback-failures-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    hnswMocks.setWriteFailures(2);
    const transactionSpy = await abortNextVectorMappingWrite();
    chrome.storage.local.set = vi.fn(async () => {
      throw new Error("rollback fallback failed");
    }) as typeof chrome.storage.local.set;

    try {
      let failure: unknown;
      try {
        await database.addDocument(
          7,
          "https://example.test/failed",
          "Failed",
          { text: "failed chunk", source: "content", index: 0, wordCount: 2 },
          new Float32Array([1, 0, 0]),
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).message).toContain(
        "rollback did not complete",
      );
      expect(
        (failure as AggregateError).errors.map((error) => String(error)),
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining("persist rolled-back vector index"),
          expect.stringContaining("persist rolled-back vector mappings"),
        ]),
      );
      expect(database.getStats().totalDocuments).toBe(0);
      expect(hnswMocks.deletedLabels).toEqual([0]);
    } finally {
      transactionSpy.mockRestore();
    }

    useStatefulChromeStorage();
    await expect(
      database.ensureTabDocumentsRemoved(7),
    ).resolves.toBeUndefined();
    await expect(getVectorMappingRecord(indexFileName)).resolves.toMatchObject({
      nextLabel: 1,
      documents: [],
      tabDocuments: [],
    });
  });

  it("marks every tab vector deleted and durably persists an empty mapping", async () => {
    const indexFileName = `remove-tab-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    await database.addDocument(
      7,
      "https://example.test/page",
      "Page",
      { text: "first", source: "content", index: 0, wordCount: 1 },
      new Float32Array([1, 0, 0]),
    );
    await database.addDocument(
      7,
      "https://example.test/page",
      "Page",
      { text: "second", source: "content", index: 1, wordCount: 1 },
      new Float32Array([0, 1, 0]),
    );
    hnswMocks.deletedLabels.length = 0;
    const writesBeforeRemoval = hnswMocks.writeCalls.length;

    await database.removeTabDocuments(7);

    expect(hnswMocks.deletedLabels).toEqual([0, 1]);
    expect(hnswMocks.writeCalls).toHaveLength(writesBeforeRemoval + 1);
    expect(database.getStats()).toMatchObject({
      totalDocuments: 0,
      totalTabs: 0,
    });
    await expect(getVectorMappingRecord(indexFileName)).resolves.toMatchObject({
      revision: 3,
      nextLabel: 2,
      documents: [],
      tabDocuments: [],
    });

    // A repeated ordinary removal is also a durable retry, not an in-memory
    // no-op, because a prior persistence attempt may have failed.
    await database.removeTabDocuments(7);
    expect(hnswMocks.writeCalls).toHaveLength(writesBeforeRemoval + 2);
    await expect(getVectorMappingRecord(indexFileName)).resolves.toMatchObject({
      revision: 4,
      nextLabel: 2,
      documents: [],
      tabDocuments: [],
    });
  });

  it("resets the complete index instead of acknowledging a same-worker active orphan", async () => {
    const indexFileName = `active-orphan-recovery-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    const index = hnswMocks.instances.at(-1) as unknown as {
      addPoint(vector: number[], label: number): void;
    };
    index.addPoint([1, 0, 0], 9);
    const writesBeforeRecovery = hnswMocks.writeCalls.length;

    await expect(
      database.ensureTabDocumentsRemoved(77),
    ).resolves.toBeUndefined();

    expect(hnswMocks.writeCalls.length).toBeGreaterThanOrEqual(
      writesBeforeRecovery + 2,
    );
    expect(database.getStats()).toMatchObject({
      isInitialized: true,
      totalDocuments: 0,
      totalTabs: 0,
    });
    expect(hnswMocks.fileLabelSnapshots.get(indexFileName)).toMatchObject({
      currentCount: 0,
      deletedLabels: [],
      usedLabels: [],
    });
    await expect(getVectorMappingRecord(indexFileName)).resolves.toMatchObject({
      completedTabPages: [],
      documents: [],
      nextLabel: 0,
      tabDocuments: [],
    });
  });

  it("does not acknowledge orphan recovery when the replacement mappings fail to persist", async () => {
    const indexFileName = `active-orphan-reset-failure-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    const index = hnswMocks.instances.at(-1) as unknown as {
      addPoint(vector: number[], label: number): void;
    };
    index.addPoint([1, 0, 0], 9);

    const statefulRemove = chrome.storage.local.remove;
    let removalCalls = 0;
    chrome.storage.local.remove = vi.fn(async (keys: string | string[]) => {
      removalCalls += 1;
      // The first call finalizes the deletion mapping, the second clears the
      // old backup, and the third finalizes the replacement mapping. Failing
      // that last boundary must keep the caller from acknowledging recovery.
      if (removalCalls === 3) {
        throw new Error("replacement mapping cleanup failed");
      }
      await statefulRemove(keys);
    }) as typeof chrome.storage.local.remove;

    await expect(database.ensureTabDocumentsRemoved(77)).rejects.toThrow(
      "replace unsafe vector state",
    );
    expect(database.getStats().isInitialized).toBe(false);
    await expect(database.search(new Float32Array([1, 0, 0]))).rejects.toThrow(
      "access is blocked",
    );

    chrome.storage.local.remove = statefulRemove;
    await expect(database.clear()).resolves.toBeUndefined();
    expect(database.getStats()).toMatchObject({
      isInitialized: true,
      totalDocuments: 0,
      totalTabs: 0,
    });
  });

  it("does not let the public mapping reload bypass the active-label invariant", async () => {
    const indexFileName = `mapping-reload-invariant-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    const index = hnswMocks.instances.at(-1) as unknown as {
      addPoint(vector: number[], label: number): void;
    };
    index.addPoint([1, 0, 0], 9);
    await putVectorMappingRecord(
      indexFileName,
      createMappingPayload({ dimension: 3, indexFileName }),
    );

    await expect(database.loadDocumentMappings()).resolves.toBeUndefined();

    expect(database.getStats()).toMatchObject({
      isInitialized: true,
      totalDocuments: 0,
      totalTabs: 0,
    });
    expect(hnswMocks.fileLabelSnapshots.get(indexFileName)).toMatchObject({
      currentCount: 0,
      deletedLabels: [],
      usedLabels: [],
    });
    await expect(getVectorMappingRecord(indexFileName)).resolves.toMatchObject({
      documents: [],
      nextLabel: 0,
      tabDocuments: [],
    });
  });

  it("retries a tab removal after its mapping transaction and fallback both fail", async () => {
    const indexFileName = `remove-retry-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();
    await database.addDocument(
      7,
      "https://example.test/page",
      "Page",
      { text: "private", source: "content", index: 0, wordCount: 1 },
      new Float32Array([1, 0, 0]),
    );
    hnswMocks.deletedLabels.length = 0;
    const transactionSpy = await abortNextVectorMappingWrite();
    const statefulSet = chrome.storage.local.set;
    let rejectFallbackOnce = true;
    chrome.storage.local.set = vi.fn(async (values) => {
      if (rejectFallbackOnce) {
        rejectFallbackOnce = false;
        throw new Error("remove fallback failed");
      }
      await statefulSet(values);
    }) as typeof chrome.storage.local.set;

    try {
      await expect(database.removeTabDocuments(7)).rejects.toThrow(
        "not durably removed",
      );
      expect(database.getStats().totalDocuments).toBe(0);
      expect(hnswMocks.deletedLabels).toEqual([0]);

      await expect(
        database.ensureTabDocumentsRemoved(7),
      ).resolves.toBeUndefined();
      expect(hnswMocks.deletedLabels).toEqual([0]);
      await expect(
        getVectorMappingRecord(indexFileName),
      ).resolves.toMatchObject({
        revision: 3,
        nextLabel: 1,
        documents: [],
        tabDocuments: [],
      });
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it.each([
    {
      name: "legacy metadata without a schema",
      mutate: (mapping: any) => {
        delete mapping.schemaVersion;
      },
    },
    {
      name: "legacy metadata without page completion semantics",
      mutate: (mapping: any) => {
        mapping.schemaVersion = 1;
        delete mapping.completedTabPages;
      },
    },
    {
      name: "metadata for another vector dimension",
      mutate: (mapping: any) => {
        mapping.dimension = 2;
      },
    },
    {
      name: "metadata with a mismatched filename",
      mutate: (mapping: any) => {
        mapping.indexFileName = "another-index.dat";
      },
    },
    {
      name: "metadata with inconsistent tab labels",
      mutate: (mapping: any) => {
        mapping.tabDocuments = [[7, [99]]];
      },
    },
    {
      name: "metadata with an empty tab mapping",
      mutate: (mapping: any) => {
        mapping.documents = [];
        mapping.tabDocuments = [[7, []]];
        mapping.nextLabel = 1;
      },
    },
    {
      name: "metadata with a non-finite timestamp",
      mutate: (mapping: any) => {
        mapping.documents[0][1].timestamp = Number.NaN;
      },
    },
    {
      name: "metadata without completed-page collection",
      mutate: (mapping: any) => {
        delete mapping.completedTabPages;
      },
    },
    {
      name: "completed metadata for a missing tab",
      mutate: (mapping: any) => {
        mapping.completedTabPages[0][0] = 99;
      },
    },
    {
      name: "completed metadata with an empty label set",
      mutate: (mapping: any) => {
        mapping.completedTabPages[0][1].labels = [];
        mapping.completedTabPages[0][1].expectedCount = 0;
      },
    },
    {
      name: "completed metadata with a mismatched expected count",
      mutate: (mapping: any) => {
        mapping.completedTabPages[0][1].expectedCount = 2;
      },
    },
    {
      name: "completed metadata with a forged page key",
      mutate: (mapping: any) => {
        mapping.completedTabPages[0][1].pageKey = "forged";
      },
    },
    {
      name: "completed metadata whose document identity differs",
      mutate: (mapping: any) => {
        mapping.documents[0][1].url = "https://example.test/different";
      },
    },
  ])(
    "refuses $name before readIndex and replaces it with safe empty metadata",
    async ({ mutate }) => {
      const indexFileName = `invalid-${crypto.randomUUID()}.dat`;
      const mapping = createMappingPayload({ dimension: 3, indexFileName });
      mutate(mapping);
      await putVectorMappingRecord(indexFileName, mapping);
      const storageKey = `hnswlib_document_mappings_${indexFileName}`;
      const storage = useStatefulChromeStorage({ [storageKey]: mapping });
      hnswMocks.setPopulateSnapshot([[indexFileName, 1]]);

      const database = new VectorDatabase({ dimension: 3, indexFileName });
      await database.initialize();

      expect(hnswMocks.readCalls).not.toContain(indexFileName);
      expect(hnswMocks.writeCalls).toContain(indexFileName);
      expect(hnswMocks.fileCounts.get(indexFileName)).toBe(0);
      expect(storage).not.toHaveProperty(storageKey);
      expect(database.getStats()).toMatchObject({
        totalDocuments: 0,
        totalTabs: 0,
      });
      await expect(
        getVectorMappingRecord(indexFileName),
      ).resolves.toMatchObject({
        schemaVersion: 2,
        revision: 1,
        dimension: 3,
        indexFileName,
        documents: [],
        tabDocuments: [],
        nextLabel: 0,
      });
    },
  );

  it.each([
    {
      name: "an extra live label",
      mapping: () => {
        const mapping = createMappingPayload({
          dimension: 3,
          indexFileName: "placeholder",
        });
        mapping.nextLabel = 2;
        return mapping;
      },
      snapshot: {
        currentCount: 2,
        deletedLabels: [],
        usedLabels: [0, 1],
      },
    },
    {
      name: "a different live label than the mapped document",
      mapping: () => {
        const mapping = createMappingPayload({
          dimension: 3,
          indexFileName: "placeholder",
        });
        mapping.nextLabel = 2;
        return mapping;
      },
      snapshot: {
        currentCount: 1,
        deletedLabels: [],
        usedLabels: [1],
      },
    },
    {
      name: "a mapped completion whose HNSW label is deleted",
      mapping: () => null,
      snapshot: {
        currentCount: 1,
        deletedLabels: [0],
        usedLabels: [0],
      },
    },
  ])(
    "resets persisted state with $name before hydrating page mappings",
    async ({ mapping: createCustomMapping, snapshot }) => {
      const indexFileName = `active-mismatch-${crypto.randomUUID()}.dat`;
      const mapping =
        createCustomMapping() ??
        createMappingPayload({ dimension: 3, indexFileName });
      mapping.indexFileName = indexFileName;
      await putVectorMappingRecord(indexFileName, mapping);
      useStatefulChromeStorage();
      hnswMocks.setPopulateSnapshot([[indexFileName, snapshot]]);

      const database = new VectorDatabase({ dimension: 3, indexFileName });
      await database.initialize();

      expect(database.getStats()).toMatchObject({
        totalDocuments: 0,
        totalTabs: 0,
      });
      await expect(database.inspectTabPageState()).resolves.toEqual({
        completedPages: [],
        repairTabIds: [],
      });
      expect(hnswMocks.fileLabelSnapshots.get(indexFileName)).toMatchObject({
        currentCount: 0,
        deletedLabels: [],
        usedLabels: [],
      });
    },
  );

  it("resets a deleted orphan whose next label could reactivate it", async () => {
    const indexFileName = `deleted-stale-label-${crypto.randomUUID()}.dat`;
    const mapping = createMappingPayload({
      dimension: 3,
      indexFileName,
      withDocument: false,
    });
    mapping.nextLabel = 7;
    await putVectorMappingRecord(indexFileName, mapping);
    useStatefulChromeStorage();
    hnswMocks.setPopulateSnapshot([
      [
        indexFileName,
        {
          currentCount: 1,
          deletedLabels: [7],
          usedLabels: [7],
        },
      ],
    ]);

    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();

    expect(hnswMocks.fileLabelSnapshots.get(indexFileName)).toMatchObject({
      currentCount: 0,
      deletedLabels: [],
      usedLabels: [],
    });
    await expect(getVectorMappingRecord(indexFileName)).resolves.toMatchObject({
      documents: [],
      nextLabel: 0,
    });
  });

  it.each([
    {
      name: "used labels are not an array",
      snapshot: {
        currentCount: 1,
        deletedLabels: [],
        usedLabels: "invalid",
      },
    },
    {
      name: "used labels contain a duplicate",
      snapshot: {
        currentCount: 2,
        deletedLabels: [],
        usedLabels: [0, 0],
      },
    },
    {
      name: "deleted labels contain a duplicate",
      snapshot: {
        currentCount: 1,
        deletedLabels: [0, 0],
        usedLabels: [0],
      },
    },
    {
      name: "a deleted label is not used",
      snapshot: {
        currentCount: 1,
        deletedLabels: [1],
        usedLabels: [0],
      },
    },
    {
      name: "the current count differs from used labels",
      snapshot: {
        currentCount: 2,
        deletedLabels: [],
        usedLabels: [0],
      },
    },
    {
      name: "a used label is outside uint32",
      snapshot: {
        currentCount: 1,
        deletedLabels: [],
        usedLabels: [0x1_0000_0000],
      },
    },
    {
      name: "the HNSW inspection API throws",
      snapshot: {
        currentCount: 1,
        deletedLabels: [],
        inspectionError: new Error("label API failed"),
        usedLabels: [0],
      },
    },
  ])("safely resets when $name", async ({ snapshot }) => {
    const indexFileName = `malformed-labels-${crypto.randomUUID()}.dat`;
    await putVectorMappingRecord(
      indexFileName,
      createMappingPayload({ dimension: 3, indexFileName }),
    );
    useStatefulChromeStorage();
    hnswMocks.setPopulateSnapshot([[indexFileName, snapshot]]);

    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();

    expect(database.getStats().totalDocuments).toBe(0);
    expect(hnswMocks.fileLabelSnapshots.get(indexFileName)).toMatchObject({
      currentCount: 0,
      deletedLabels: [],
      usedLabels: [],
    });
  });

  it("accepts deleted tombstones when active labels are empty and nextLabel is monotonic", async () => {
    const indexFileName = `valid-deleted-label-${crypto.randomUUID()}.dat`;
    const mapping = createMappingPayload({
      dimension: 3,
      indexFileName,
      withDocument: false,
    });
    mapping.nextLabel = 8;
    await putVectorMappingRecord(indexFileName, mapping);
    useStatefulChromeStorage();
    hnswMocks.setPopulateSnapshot([
      [
        indexFileName,
        {
          currentCount: 1,
          deletedLabels: [7],
          usedLabels: [7],
        },
      ],
    ]);

    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();

    expect(hnswMocks.readCalls).toContain(indexFileName);
    expect(hnswMocks.writeCalls).not.toContain(indexFileName);
    expect(database.getStats()).toMatchObject({
      totalDocuments: 0,
      totalTabs: 0,
    });
    await expect(database.search(new Float32Array([1, 0, 0]))).resolves.toEqual(
      [],
    );
    await expect(getVectorMappingRecord(indexFileName)).resolves.toMatchObject({
      documents: [],
      nextLabel: 8,
    });
  });

  it("refuses an index with vectors when all durable mappings are absent", async () => {
    const indexFileName = `missing-${crypto.randomUUID()}.dat`;
    useStatefulChromeStorage();
    hnswMocks.setPopulateSnapshot([[indexFileName, 2]]);

    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();

    expect(hnswMocks.readCalls).not.toContain(indexFileName);
    expect(hnswMocks.fileCounts.get(indexFileName)).toBe(0);
    await expect(getVectorMappingRecord(indexFileName)).resolves.toMatchObject({
      dimension: 3,
      documents: [],
    });
  });

  it("resets a non-empty index even when its matching metadata claims no documents", async () => {
    const indexFileName = `orphaned-${crypto.randomUUID()}.dat`;
    const emptyMapping = createMappingPayload({
      dimension: 3,
      indexFileName,
      withDocument: false,
    });
    // nextLabel remains monotonic after the last document mapping is removed.
    // This is valid metadata; the non-empty HNSW count is what requires reset.
    emptyMapping.nextLabel = 5;
    await putVectorMappingRecord(indexFileName, emptyMapping);
    useStatefulChromeStorage();
    hnswMocks.setPopulateSnapshot([[indexFileName, 2]]);

    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();

    expect(hnswMocks.readCalls).toContain(indexFileName);
    expect(hnswMocks.writeCalls).toContain(indexFileName);
    expect(hnswMocks.fileCounts.get(indexFileName)).toBe(0);
  });

  it("resets an index that is newer than the valid mapping nextLabel", async () => {
    const indexFileName = `stale-next-label-${crypto.randomUUID()}.dat`;
    await putVectorMappingRecord(
      indexFileName,
      createMappingPayload({ dimension: 3, indexFileName, revision: 1 }),
    );
    useStatefulChromeStorage();
    hnswMocks.setPopulateSnapshot([[indexFileName, 2]]);

    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();

    expect(hnswMocks.readCalls).toContain(indexFileName);
    expect(hnswMocks.writeCalls).toContain(indexFileName);
    expect(hnswMocks.fileCounts.get(indexFileName)).toBe(0);
    expect(database.getStats()).toMatchObject({
      totalDocuments: 0,
      totalTabs: 0,
    });
  });

  it("refuses a valid primary when the fallback payload is corrupt", async () => {
    const indexFileName = `corrupt-fallback-${crypto.randomUUID()}.dat`;
    await putVectorMappingRecord(
      indexFileName,
      createMappingPayload({ dimension: 3, indexFileName, revision: 1 }),
    );
    const corruptFallback = createMappingPayload({
      dimension: 3,
      indexFileName,
      revision: 2,
    });
    delete (corruptFallback as any).schemaVersion;
    const storageKey = `hnswlib_document_mappings_${indexFileName}`;
    useStatefulChromeStorage({ [storageKey]: corruptFallback });
    hnswMocks.setPopulateSnapshot([[indexFileName, 1]]);

    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();

    expect(hnswMocks.readCalls).not.toContain(indexFileName);
    expect(hnswMocks.fileCounts.get(indexFileName)).toBe(0);
    await expect(getVectorMappingRecord(indexFileName)).resolves.toMatchObject({
      documents: [],
      dimension: 3,
    });
  });

  it("selects and migrates a newer chrome.storage fallback over stale IndexedDB metadata", async () => {
    const indexFileName = `revision-${crypto.randomUUID()}.dat`;
    await putVectorMappingRecord(
      indexFileName,
      createMappingPayload({ dimension: 3, indexFileName, revision: 1 }),
    );
    const newer = createMappingPayload({
      dimension: 3,
      indexFileName,
      revision: 2,
    });
    const storageKey = `hnswlib_document_mappings_${indexFileName}`;
    useStatefulChromeStorage({ [storageKey]: newer });
    hnswMocks.setPopulateSnapshot([[indexFileName, 1]]);

    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await database.initialize();

    expect(hnswMocks.readCalls).toEqual([indexFileName]);
    await expect(getVectorMappingRecord(indexFileName)).resolves.toMatchObject({
      revision: 2,
      dimension: 3,
      indexFileName,
    });
  });

  it("fails closed when one mapping backend errors and the other is absent", async () => {
    const indexFileName = `read-error-${crypto.randomUUID()}.dat`;
    hnswMocks.setPopulateSnapshot([[indexFileName, 1]]);
    chrome.storage.local.get = vi.fn(async () => {
      throw new Error("storage unavailable");
    }) as typeof chrome.storage.local.get;

    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await expect(database.initialize()).rejects.toThrow(
      "Unable to determine whether persisted vector mappings exist",
    );

    expect(hnswMocks.readCalls).not.toContain(indexFileName);
    expect(hnswMocks.writeCalls).not.toContain(indexFileName);
  });

  it("fails closed when fallback I/O prevents comparing a valid primary revision", async () => {
    const indexFileName = `candidate-read-error-${crypto.randomUUID()}.dat`;
    await putVectorMappingRecord(
      indexFileName,
      createMappingPayload({ dimension: 3, indexFileName, revision: 3 }),
    );
    hnswMocks.setPopulateSnapshot([[indexFileName, 1]]);
    chrome.storage.local.get = vi.fn(async () => {
      throw new Error("storage unavailable");
    }) as typeof chrome.storage.local.get;

    const database = new VectorDatabase({ dimension: 3, indexFileName });
    await expect(database.initialize()).rejects.toThrow(
      "Unable to determine whether persisted vector mappings exist",
    );

    expect(hnswMocks.readCalls).not.toContain(indexFileName);
    expect(hnswMocks.writeCalls).not.toContain(indexFileName);
  });

  it("keeps the old global database when a dimension-switch clear fails", async () => {
    useStatefulChromeStorage();
    await resetGlobalVectorDatabase();
    const oldDatabase = await getGlobalVectorDatabase({ dimension: 3 });
    const clear = vi
      .spyOn(oldDatabase, "clear")
      .mockRejectedValueOnce(new Error("old dimension clear failed"));
    let clearRestored = false;

    try {
      await expect(getGlobalVectorDatabase({ dimension: 4 })).rejects.toThrow(
        "old dimension clear failed",
      );

      expect(clear).toHaveBeenCalledOnce();
      await expect(getGlobalVectorDatabase({ dimension: 3 })).resolves.toBe(
        oldDatabase,
      );

      clear.mockRestore();
      clearRestored = true;
      await expect(getGlobalVectorDatabase({ dimension: 4 })).resolves.not.toBe(
        oldDatabase,
      );
    } finally {
      if (!clearRestored) clear.mockRestore();
      await resetGlobalVectorDatabase();
    }
  });

  it("keeps the old global database when an atomic reset fails", async () => {
    useStatefulChromeStorage();
    await resetGlobalVectorDatabase();
    const oldDatabase = await getGlobalVectorDatabase({ dimension: 3 });
    const clear = vi
      .spyOn(oldDatabase, "clear")
      .mockRejectedValue(new Error("global reset clear failed"));

    try {
      await expect(resetGlobalVectorDatabase()).rejects.toThrow(
        "Vector data cleanup did not complete",
      );

      // The failed reset must preserve currentDimension as well as the object
      // reference. A different dimension must still attempt to clear the old
      // singleton rather than silently returning or replacing it.
      await expect(getGlobalVectorDatabase({ dimension: 4 })).rejects.toThrow(
        "global reset clear failed",
      );
      expect(clear).toHaveBeenCalledTimes(2);
      await expect(getGlobalVectorDatabase({ dimension: 3 })).resolves.toBe(
        oldDatabase,
      );
    } finally {
      clear.mockRestore();
      await resetGlobalVectorDatabase();
    }
  });

  it("clears FILE_DATA, reconciles the in-memory mount, and cannot resurrect an old file", async () => {
    chrome.storage.local.get = vi.fn(
      async () => ({}),
    ) as typeof chrome.storage.local.get;
    vi.mocked(chrome.storage.local.remove).mockResolvedValue(undefined);
    const database = await getGlobalVectorDatabase({ dimension: 3 });
    await database.initialize();
    await database.addDocument(
      8,
      "https://example.test/private",
      "Private",
      { text: "sensitive content", source: "content", index: 0, wordCount: 2 },
      new Float32Array([0, 1, 0]),
    );
    hnswMocks.files.add("tab_content_index.dat");
    const writesBeforeCleanup = hnswMocks.writeCalls.length;

    await clearAllVectorData();

    expect(hnswMocks.writeCalls).toHaveLength(writesBeforeCleanup);
    expect(hnswMocks.syncCalls).toContain(true);
    expect(hnswMocks.manager.isSynced()).toBe(true);
    expect(hnswMocks.files.size).toBe(0);
    expect(hnswMocks.manager.checkFileExists("tab_content_index.dat")).toBe(
      false,
    );
  });
});
