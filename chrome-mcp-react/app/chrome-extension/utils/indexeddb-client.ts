// indexeddb-client.ts
// Generic IndexedDB client with robust transaction handling and small helpers.

export type UpgradeHandler = (
  db: IDBDatabase,
  oldVersion: number,
  tx: IDBTransaction | null,
) => void;

export class IndexedDbClient {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private name: string,
    private version: number,
    private onUpgrade: UpgradeHandler,
  ) {}

  async openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.name, this.version);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const oldVersion = (event as IDBVersionChangeEvent).oldVersion || 0;
        const tx = req.transaction as IDBTransaction | null;
        try {
          this.onUpgrade(db, oldVersion, tx);
        } catch (e) {
          console.error('IndexedDbClient upgrade failed:', e);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () =>
        reject(new Error(`IndexedDB open failed: ${req.error?.message || req.error}`));
    });
    return this.dbPromise;
  }

  async tx<T>(
    storeName: string,
    mode: IDBTransactionMode,
    op: (store: IDBObjectStore, txn: IDBTransaction) => T | Promise<T>,
  ): Promise<T> {
    const db = await this.openDb();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const st = transaction.objectStore(storeName);
      let opResult: T | undefined;
      let opError: any;
      transaction.oncomplete = () => resolve(opResult as T);
      transaction.onerror = () =>
        reject(
          new Error(
            `IDB transaction error on ${storeName}: ${transaction.error?.message || transaction.error}`,
          ),
        );
      transaction.onabort = () =>
        reject(
          new Error(
            `IDB transaction aborted on ${storeName}: ${transaction.error?.message || opError || 'unknown'}`,
          ),
        );
      Promise.resolve()
        .then(() => op(st, transaction))
        .then((res) => {
          opResult = res as T;
        })
        .catch((err) => {
          opError = err;
          try {
            transaction.abort();
          } catch {}
        });
    });
  }

  async getAll<T>(store: string): Promise<T[]> {
    return this.tx<T[]>(store, 'readonly', (st) =>
      this.promisifyRequest<any[]>(st.getAll(), store, 'getAll').then((res) => (res as T[]) || []),
    );
  }

  async get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
    return this.tx<T | undefined>(store, 'readonly', (st) =>
      this.promisifyRequest<T | undefined>(st.get(key), store, `get(${String(key)})`).then(
        (res) => res as any,
      ),
    );
  }

  async put<T>(store: string, value: T): Promise<void> {
    return this.tx<void>(store, 'readwrite', (st) =>
      this.promisifyRequest<any>(st.put(value as any), store, 'put').then(() => undefined),
    );
  }

  async delete(store: string, key: IDBValidKey): Promise<void> {
    return this.tx<void>(store, 'readwrite', (st) =>
      this.promisifyRequest<any>(st.delete(key), store, `delete(${String(key)})`).then(
        () => undefined,
      ),
    );
  }

  async clear(store: string): Promise<void> {
    return this.tx<void>(store, 'readwrite', (st) =>
      this.promisifyRequest<any>(st.clear(), store, 'clear').then(() => undefined),
    );
  }

  async putMany<T>(store: string, values: T[]): Promise<void> {
    return this.tx<void>(store, 'readwrite', async (st) => {
      for (const v of values) st.put(v as any);
      return;
    });
  }

  // Expose helper for advanced callers if needed
  promisifyRequest<R>(req: IDBRequest<R>, store: string, action: string): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result as R);
      req.onerror = () =>
        reject(
          new Error(
            `IDB ${action} error on ${store}: ${(req.error as any)?.message || (req.error as any)}`,
          ),
        );
    });
  }
}
