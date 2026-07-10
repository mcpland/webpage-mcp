/**
 * @fileoverview Persistent variable storage
 * @description Implement persistence of $ prefix variables, using LWW (Last-Write-Wins) strategy
 */

import type { PersistentVarRecord, PersistentVariableName } from '../domain/variables';
import type { JsonValue } from '../domain/json';
import type { PersistentVarsStore } from '../engine/storage/storage-port';
import { RR_V3_STORES, withTransaction } from './db';
import {
  PERSISTENT_VAR_RESOURCE_LIMITS,
  findPersistentVarKeyViolation,
  findPersistentVarValueViolation,
} from '../domain/persistent-var-limits';
import { jsonUtf8ByteLength } from '../domain/json-limits';

function validateKey(key: PersistentVariableName): void {
  const violation = findPersistentVarKeyViolation(key);
  if (violation) throw new Error(violation);
}

/**
 * Create a PersistentVarsStore implementation
 */
export function createPersistentVarsStore(): PersistentVarsStore {
  return {
    async get(key: PersistentVariableName): Promise<PersistentVarRecord | undefined> {
      validateKey(key);
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
      validateKey(key);
      const valueViolation = findPersistentVarValueViolation(value);
      if (valueViolation) throw new Error(valueViolation);
      return withTransaction(RR_V3_STORES.PERSISTENT_VARS, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.PERSISTENT_VARS];

        // Read existing records first (for version increment)
        const existing = await new Promise<PersistentVarRecord | undefined>((resolve, reject) => {
          const request = store.get(key);
          request.onsuccess = () => resolve(request.result as PersistentVarRecord | undefined);
          request.onerror = () => reject(request.error);
        });

        if (!existing) {
          const count = await new Promise<number>((resolve, reject) => {
            const request = store.count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          if (count >= PERSISTENT_VAR_RESOURCE_LIMITS.maxEntries) {
            throw new Error(
              `Persistent variable limit exceeded (maximum ${PERSISTENT_VAR_RESOURCE_LIMITS.maxEntries})`,
            );
          }
        }

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
      validateKey(key);
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
      if (prefix !== undefined) validateKey(prefix);
      return withTransaction(RR_V3_STORES.PERSISTENT_VARS, 'readonly', async (stores) => {
        const store = stores[RR_V3_STORES.PERSISTENT_VARS];

        return new Promise<PersistentVarRecord[]>((resolve, reject) => {
          const results: PersistentVarRecord[] = [];
          let aggregateBytes = 2;
          const request = store.openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              resolve(results);
              return;
            }
            const record = cursor.value as PersistentVarRecord;
            if (prefix && !record.key.startsWith(prefix)) {
              cursor.continue();
              return;
            }
            const recordBytes = jsonUtf8ByteLength(
              record,
              PERSISTENT_VAR_RESOURCE_LIMITS.maxListUtf8Bytes,
            );
            const addedBytes = recordBytes + (results.length > 0 ? 1 : 0);
            if (
              addedBytes >
              PERSISTENT_VAR_RESOURCE_LIMITS.maxListUtf8Bytes - aggregateBytes
            ) {
              resolve(results);
              return;
            }
            aggregateBytes += addedBytes;
            results.push(record);
            cursor.continue();
          };
          request.onerror = () => reject(request.error);
        });
      });
    },
  };
}
