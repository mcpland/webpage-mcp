import { afterEach, describe, expect, it, vi } from "vitest";

const hnswMocks = vi.hoisted(() => {
  const files = new Set<string>();
  const syncCalls: boolean[] = [];
  const writeCalls: string[] = [];
  const pendingWriteSyncs: Array<() => void> = [];
  const instances: Array<{ count: number; fileName?: string }> = [];
  let syncShouldSucceed = true;
  let synced = true;
  let autoCompleteWriteSync = true;

  class HierarchicalNSW {
    count = 0;
    readonly fileName?: string;

    constructor(_space: string, _dimension: number, fileName?: string) {
      this.fileName = fileName;
      instances.push(this);
    }

    initIndex() {
      this.count = 0;
    }

    setEfSearch() {}

    getCurrentCount() {
      return this.count;
    }

    addPoint() {
      this.count += 1;
    }

    searchKnn() {
      return { neighbors: [], distances: [] };
    }

    resizeIndex() {}

    getPoint() {
      return [];
    }

    markDelete() {}

    async readIndex(fileName: string) {
      if (!files.has(fileName)) throw new Error("missing index");
    }

    writeIndex(fileName: string) {
      writeCalls.push(fileName);
      files.add(fileName);
      synced = false;
      const complete = () => {
        synced = syncShouldSucceed;
      };
      if (autoCompleteWriteSync) queueMicrotask(complete);
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
      queueMicrotask(() => {
        synced = syncShouldSucceed;
        if (populate && synced) files.clear();
        callback();
      });
    }),
  };

  return {
    files,
    instances,
    manager,
    setSyncShouldSucceed(value: boolean) {
      syncShouldSucceed = value;
    },
    resetSyncState() {
      syncShouldSucceed = true;
      synced = true;
      autoCompleteWriteSync = true;
      pendingWriteSyncs.length = 0;
    },
    setAutoCompleteWriteSync(value: boolean) {
      autoCompleteWriteSync = value;
    },
    completeNextWriteSync() {
      pendingWriteSyncs.shift()?.();
    },
    pendingWriteSyncs,
    syncCalls,
    writeCalls,
    HierarchicalNSW,
  };
});

vi.mock("hnswlib-wasm-static", () => ({
  IDBFS_STORE_NAME: "FILE_DATA",
  HierarchicalNSW: hnswMocks.HierarchicalNSW,
  loadHnswlib: vi.fn(async () => ({
    EmscriptenFileSystemManager: hnswMocks.manager,
    HierarchicalNSW: hnswMocks.HierarchicalNSW,
  })),
}));

import {
  VectorDatabase,
  clearAllVectorData,
  clearIndexedDatabaseStore,
  deleteIndexedDatabase,
  getGlobalVectorDatabase,
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

function stubDeleteRequest(request: MutableDeleteRequest) {
  vi.stubGlobal("indexedDB", {
    deleteDatabase: vi.fn(() => request as unknown as IDBOpenDBRequest),
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  chrome.storage.local.get = originalStorageGet;
  vi.clearAllMocks();
  hnswMocks.files.clear();
  hnswMocks.instances.length = 0;
  hnswMocks.syncCalls.length = 0;
  hnswMocks.writeCalls.length = 0;
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
