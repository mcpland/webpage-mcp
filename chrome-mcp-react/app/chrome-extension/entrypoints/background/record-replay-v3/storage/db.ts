/**
 * @fileoverview V3 IndexedDB 数据库定义
 * @description 定义 rr_v3 数据库的 schema 和初始化逻辑
 */

/** 数据库名称 */
export const RR_V3_DB_NAME = 'rr_v3';

/** 数据库版本 */
export const RR_V3_DB_VERSION = 1;

/**
 * Store 名称常量
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
 * Store 配置
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
 * V3 Store Schema 定义
 * @description 包含 Phase 1-3 所需的所有索引，避免后续升级
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
 * 数据库升级处理器
 */
export function handleUpgrade(db: IDBDatabase, oldVersion: number, _newVersion: number): void {
  // Version 0 -> 1: 创建所有 stores
  if (oldVersion < 1) {
    for (const [storeName, config] of Object.entries(RR_V3_STORE_SCHEMAS)) {
      const store = db.createObjectStore(storeName, {
        keyPath: config.keyPath,
        autoIncrement: config.autoIncrement,
      });

      // 创建索引
      if (config.indexes) {
        for (const index of config.indexes) {
          store.createIndex(index.name, index.keyPath, index.options);
        }
      }
    }
  }
}

/** 全局数据库实例 */
let dbInstance: IDBDatabase | null = null;
let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * 打开 V3 数据库
 * @description 单例模式，确保只有一个数据库连接
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

      // 处理版本变更（其他 tab 升级了数据库）
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
 * 关闭数据库连接
 * @description 主要用于测试
 */
export function closeRrV3Db(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    dbPromise = null;
  }
}

/**
 * 删除数据库
 * @description 主要用于测试
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
 * 执行事务
 * @param storeNames Store 名称（单个或多个）
 * @param mode 事务模式
 * @param callback 事务回调
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
