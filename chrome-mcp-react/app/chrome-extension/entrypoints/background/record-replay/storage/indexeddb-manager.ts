// indexeddb-manager.ts
// IndexedDB storage manager for Record & Replay data.
// Stores: flows, runs, published, schedules, triggers.

import type { Flow, RunRecord } from '../types';
import type { FlowSchedule } from '../flow-store';
import type { PublishedFlowInfo } from '../flow-store';
import type { FlowTrigger } from '../trigger-store';
import { IndexedDbClient } from '@/utils/indexeddb-client';

type StoreName = 'flows' | 'runs' | 'published' | 'schedules' | 'triggers';

const DB_NAME = 'rr_storage';
// Version history:
// v1: Initial schema with flows, runs, published, schedules, triggers stores
// v2: (Previous iteration - no schema change, version was bumped during development)
// v3: Current - ensure all stores exist, support upgrade from any previous version
const DB_VERSION = 3;

const REQUIRED_STORES = ['flows', 'runs', 'published', 'schedules', 'triggers'] as const;

const idb = new IndexedDbClient(DB_NAME, DB_VERSION, (db, oldVersion) => {
  // Idempotent upgrade: ensure all required stores exist regardless of oldVersion
  // This handles both fresh installs (oldVersion=0) and upgrades from any version
  for (const storeName of REQUIRED_STORES) {
    if (!db.objectStoreNames.contains(storeName)) {
      db.createObjectStore(storeName, { keyPath: 'id' });
    }
  }
});

const tx = <T>(
  store: StoreName,
  mode: IDBTransactionMode,
  op: (s: IDBObjectStore, t: IDBTransaction) => T | Promise<T>,
) => idb.tx<T>(store, mode, op);

async function getAll<T>(store: StoreName): Promise<T[]> {
  return idb.getAll<T>(store);
}

async function getOne<T>(store: StoreName, key: string): Promise<T | undefined> {
  return idb.get<T>(store, key);
}

async function putOne<T>(store: StoreName, value: T): Promise<void> {
  return idb.put(store, value);
}

async function deleteOne(store: StoreName, key: string): Promise<void> {
  return idb.delete(store, key);
}

async function clearStore(store: StoreName): Promise<void> {
  return idb.clear(store);
}

async function putMany<T>(storeName: StoreName, values: T[]): Promise<void> {
  return idb.putMany(storeName, values);
}

export const IndexedDbStorage = {
  flows: {
    async list(): Promise<Flow[]> {
      return getAll<Flow>('flows');
    },
    async get(id: string): Promise<Flow | undefined> {
      return getOne<Flow>('flows', id);
    },
    async save(flow: Flow): Promise<void> {
      return putOne<Flow>('flows', flow);
    },
    async delete(id: string): Promise<void> {
      return deleteOne('flows', id);
    },
  },
  runs: {
    async list(): Promise<RunRecord[]> {
      return getAll<RunRecord>('runs');
    },
    async save(record: RunRecord): Promise<void> {
      return putOne<RunRecord>('runs', record);
    },
    async replaceAll(records: RunRecord[]): Promise<void> {
      return tx<void>('runs', 'readwrite', async (st) => {
        st.clear();
        for (const r of records) st.put(r);
        return;
      });
    },
  },
  published: {
    async list(): Promise<PublishedFlowInfo[]> {
      return getAll<PublishedFlowInfo>('published');
    },
    async save(info: PublishedFlowInfo): Promise<void> {
      return putOne<PublishedFlowInfo>('published', info);
    },
    async delete(id: string): Promise<void> {
      return deleteOne('published', id);
    },
  },
  schedules: {
    async list(): Promise<FlowSchedule[]> {
      return getAll<FlowSchedule>('schedules');
    },
    async save(s: FlowSchedule): Promise<void> {
      return putOne<FlowSchedule>('schedules', s);
    },
    async delete(id: string): Promise<void> {
      return deleteOne('schedules', id);
    },
  },
  triggers: {
    async list(): Promise<FlowTrigger[]> {
      return getAll<FlowTrigger>('triggers');
    },
    async save(t: FlowTrigger): Promise<void> {
      return putOne<FlowTrigger>('triggers', t);
    },
    async delete(id: string): Promise<void> {
      return deleteOne('triggers', id);
    },
  },
};

// One-time migration from chrome.storage.local to IndexedDB
let migrationPromise: Promise<void> | null = null;
let migrationFailed = false;

export async function ensureMigratedFromLocal(): Promise<void> {
  // If previous migration failed, allow retry
  if (migrationFailed) {
    migrationPromise = null;
    migrationFailed = false;
  }
  if (migrationPromise) return migrationPromise;

  migrationPromise = (async () => {
    try {
      const flag = await chrome.storage.local.get(['rr_idb_migrated']);
      if (flag && flag['rr_idb_migrated']) return;

      // Read existing data from chrome.storage.local
      const res = await chrome.storage.local.get([
        'rr_flows',
        'rr_runs',
        'rr_published_flows',
        'rr_schedules',
        'rr_triggers',
      ]);
      const flows = (res['rr_flows'] as Flow[]) || [];
      const runs = (res['rr_runs'] as RunRecord[]) || [];
      const published = (res['rr_published_flows'] as PublishedFlowInfo[]) || [];
      const schedules = (res['rr_schedules'] as FlowSchedule[]) || [];
      const triggers = (res['rr_triggers'] as FlowTrigger[]) || [];

      // Write into IDB
      if (flows.length) await putMany('flows', flows);
      if (runs.length) await putMany('runs', runs);
      if (published.length) await putMany('published', published);
      if (schedules.length) await putMany('schedules', schedules);
      if (triggers.length) await putMany('triggers', triggers);

      await chrome.storage.local.set({ rr_idb_migrated: true });
    } catch (e) {
      migrationFailed = true;
      console.error('IndexedDbStorage migration failed:', e);
      // Re-throw to let callers know migration failed
      throw e;
    }
  })();
  return migrationPromise;
}
