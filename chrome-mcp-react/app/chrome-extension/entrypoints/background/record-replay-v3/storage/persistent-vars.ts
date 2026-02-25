/**
 * @fileoverview 持久化变量存储
 * @description 实现 $ 前缀变量的持久化，使用 LWW（Last-Write-Wins）策略
 */

import type { PersistentVarRecord, PersistentVariableName } from '../domain/variables';
import type { JsonValue } from '../domain/json';
import type { PersistentVarsStore } from '../engine/storage/storage-port';
import { RR_V3_STORES, withTransaction } from './db';

/**
 * 创建 PersistentVarsStore 实现
 */
export function createPersistentVarsStore(): PersistentVarsStore {
  return {
    async get(key: PersistentVariableName): Promise<PersistentVarRecord | undefined> {
      return withTransaction(RR_V3_STORES.PERSISTENT_VARS, 'readonly', async (stores) => {
        const store = stores[RR_V3_STORES.PERSISTENT_VARS];
        return new Promise<PersistentVarRecord | undefined>((resolve, reject) => {
          const request = store.get(key);
          request.onsuccess = () => resolve(request.result as PersistentVarRecord | undefined);
          request.onerror = () => reject(request.error);
        });
      });
    },

    async set(key: PersistentVariableName, value: JsonValue): Promise<PersistentVarRecord> {
      return withTransaction(RR_V3_STORES.PERSISTENT_VARS, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.PERSISTENT_VARS];

        // 先读取现有记录（用于 version 递增）
        const existing = await new Promise<PersistentVarRecord | undefined>((resolve, reject) => {
          const request = store.get(key);
          request.onsuccess = () => resolve(request.result as PersistentVarRecord | undefined);
          request.onerror = () => reject(request.error);
        });

        const now = Date.now();
        const record: PersistentVarRecord = {
          key,
          value,
          updatedAt: now,
          version: (existing?.version ?? 0) + 1,
        };

        await new Promise<void>((resolve, reject) => {
          const request = store.put(record);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });

        return record;
      });
    },

    async delete(key: PersistentVariableName): Promise<void> {
      return withTransaction(RR_V3_STORES.PERSISTENT_VARS, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.PERSISTENT_VARS];
        return new Promise<void>((resolve, reject) => {
          const request = store.delete(key);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },

    async list(prefix?: PersistentVariableName): Promise<PersistentVarRecord[]> {
      return withTransaction(RR_V3_STORES.PERSISTENT_VARS, 'readonly', async (stores) => {
        const store = stores[RR_V3_STORES.PERSISTENT_VARS];

        return new Promise<PersistentVarRecord[]>((resolve, reject) => {
          const request = store.getAll();
          request.onsuccess = () => {
            let results = request.result as PersistentVarRecord[];

            // 如果指定了前缀，过滤结果
            if (prefix) {
              results = results.filter((r) => r.key.startsWith(prefix));
            }

            resolve(results);
          };
          request.onerror = () => reject(request.error);
        });
      });
    },
  };
}
