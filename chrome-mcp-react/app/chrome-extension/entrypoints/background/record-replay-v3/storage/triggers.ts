/**
 * @fileoverview 触发器存储
 * @description 实现触发器的 CRUD 操作（Phase 4 完整实现）
 */

import type { TriggerId } from '../domain/ids';
import type { TriggerSpec } from '../domain/triggers';
import type { TriggersStore } from '../engine/storage/storage-port';
import { RR_V3_STORES, withTransaction } from './db';

/**
 * 创建 TriggersStore 实现
 */
export function createTriggersStore(): TriggersStore {
  return {
    async list(): Promise<TriggerSpec[]> {
      return withTransaction(RR_V3_STORES.TRIGGERS, 'readonly', async (stores) => {
        const store = stores[RR_V3_STORES.TRIGGERS];
        return new Promise<TriggerSpec[]>((resolve, reject) => {
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result as TriggerSpec[]);
          request.onerror = () => reject(request.error);
        });
      });
    },

    async get(id: TriggerId): Promise<TriggerSpec | null> {
      return withTransaction(RR_V3_STORES.TRIGGERS, 'readonly', async (stores) => {
        const store = stores[RR_V3_STORES.TRIGGERS];
        return new Promise<TriggerSpec | null>((resolve, reject) => {
          const request = store.get(id);
          request.onsuccess = () => resolve((request.result as TriggerSpec) ?? null);
          request.onerror = () => reject(request.error);
        });
      });
    },

    async save(spec: TriggerSpec): Promise<void> {
      return withTransaction(RR_V3_STORES.TRIGGERS, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.TRIGGERS];
        return new Promise<void>((resolve, reject) => {
          const request = store.put(spec);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },

    async delete(id: TriggerId): Promise<void> {
      return withTransaction(RR_V3_STORES.TRIGGERS, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.TRIGGERS];
        return new Promise<void>((resolve, reject) => {
          const request = store.delete(id);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },
  };
}
