/**
 * @fileoverview V3 IndexedDB Database definition
 * @description Define the schema and initialization logic of the rr_v3 database
 */

/** Database name */
export const RR_V3_DB_NAME = 'rr_v3';

/** Database version */
export const RR_V3_DB_VERSION = 1;

/**
 * Store Name constant
 */
export const RR_V3_STORES = {
  FLOWS: 'flows',
  RUNS: 'runs',
  EVENTS: 'events',
  QUEUE: 'queue',
  PERSISTENT_VARS: 'persistent_vars',
  TRIGGERS: 'triggers',
} as const;

/**
 * Store Configuration
 */
export interface StoreConfig {
  keyPath: string | string[];
  autoIncrement?: boolean;
  indexes?: Array<{
    name: string;
    keyPath: string | string[];
    options?: IDBIndexParameters;
  }>;
}

/**
 * V3 Store Schema definition
 * @description Contains all indexes required for Phase 1-3 to avoid subsequent upgrades
 */
export const RR_V3_STORE_SCHEMAS: Record<string, StoreConfig> = {
  [RR_V3_STORES.FLOWS]: {
    keyPath: 'id',
    indexes: [
      { name: 'name', keyPath: 'name' },
      { name: 'updatedAt', keyPath: 'updatedAt' },
    ],
  },
  [RR_V3_STORES.RUNS]: {
    keyPath: 'id',
    indexes: [
      { name: 'status', keyPath: 'status' },
      { name: 'flowId', keyPath: 'flowId' },
      { name: 'createdAt', keyPath: 'createdAt' },
      { name: 'updatedAt', keyPath: 'updatedAt' },
      // Compound index for listing runs by flow and status
      { name: 'flowId_status', keyPath: ['flowId', 'status'] },
    ],
  },
  [RR_V3_STORES.EVENTS]: {
    keyPath: ['runId', 'seq'],
    indexes: [
      { name: 'runId', keyPath: 'runId' },
      { name: 'type', keyPath: 'type' },
      // Compound index for filtering events by run and type
      { name: 'runId_type', keyPath: ['runId', 'type'] },
    ],
  },
  [RR_V3_STORES.QUEUE]: {
    keyPath: 'id',
    indexes: [
      { name: 'status', keyPath: 'status' },
      { name: 'priority', keyPath: 'priority' },
      { name: 'createdAt', keyPath: 'createdAt' },
      { name: 'flowId', keyPath: 'flowId' },
      // Phase 3: Used by claimNext(); cursor direction + key ranges implement priority DESC + createdAt ASC.
      { name: 'status_priority_createdAt', keyPath: ['status', 'priority', 'createdAt'] },
      // Phase 3: Lease expiration tracking
      { name: 'lease_expiresAt', keyPath: 'lease.expiresAt' },
    ],
  },
  [RR_V3_STORES.PERSISTENT_VARS]: {
    keyPath: 'key',
    indexes: [{ name: 'updatedAt', keyPath: 'updatedAt' }],
  },
  [RR_V3_STORES.TRIGGERS]: {
    keyPath: 'id',
    indexes: [
      { name: 'kind', keyPath: 'kind' },
      { name: 'flowId', keyPath: 'flowId' },
      { name: 'enabled', keyPath: 'enabled' },
      // Compound index for listing enabled triggers by kind
      { name: 'kind_enabled', keyPath: ['kind', 'enabled'] },
    ],
  },
};

/**
 * Database upgrade processor
 */
export function handleUpgrade(db: IDBDatabase, oldVersion: number, _newVersion: number): void {
  // Version 0 -> 1: Create all stores
  if (oldVersion < 1) {
    for (const [storeName, config] of Object.entries(RR_V3_STORE_SCHEMAS)) {
      const store = db.createObjectStore(storeName, {
        keyPath: config.keyPath,
        autoIncrement: config.autoIncrement,
      });

      // Create index
      if (config.indexes) {
        for (const index of config.indexes) {
          store.createIndex(index.name, index.keyPath, index.options);
        }
      }
    }
  }
}

/** Global database instance */
let dbInstance: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Open the V3 database
 * @description Singleton mode to ensure there is only one database connection
 */
export async function openRrV3Db(): Promise<IDBDatabase> {
  if (dbInstance) {
    return dbInstance;
  }

  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(RR_V3_DB_NAME, RR_V3_DB_VERSION);

    request.onerror = () => {
      dbPromise = null;
      reject(new Error(`Failed to open database: ${request.error?.message}`));
    };

    request.onsuccess = () => {
      dbInstance = request.result;

      // Handle version changes (other tabs upgraded the database)
      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
        dbPromise = null;
      };

      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = event.oldVersion;
      const newVersion = event.newVersion ?? RR_V3_DB_VERSION;
      handleUpgrade(db, oldVersion, newVersion);
    };
  });

  return dbPromise;
}

/**
 * Close database connection
 * @description Mainly used for testing
 */
export function closeRrV3Db(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    dbPromise = null;
  }
}

/**
 * Delete database
 * @description Mainly used for testing
 */
export async function deleteRrV3Db(): Promise<void> {
  closeRrV3Db();

  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(RR_V3_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Execute transaction
 * @param storeNames Store Name (single or multiple)
 * @param mode transaction mode
 * @param callback transaction callback
 */
export async function withTransaction<T>(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  callback: (stores: Record<string, IDBObjectStore>) => Promise<T> | T,
): Promise<T> {
  const db = await openRrV3Db();
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  const tx = db.transaction(names, mode);

  const stores: Record<string, IDBObjectStore> = {};
  for (const name of names) {
    stores[name] = tx.objectStore(name);
  }

  return new Promise<T>((resolve, reject) => {
    let result: T;

    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));

    Promise.resolve(callback(stores))
      .then((r) => {
        result = r;
      })
      .catch((err) => {
        tx.abort();
        reject(err);
      });
  });
}
