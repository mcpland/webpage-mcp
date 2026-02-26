/**
 * @fileoverview RunRecordV3 persistence
 * @description Implement CRUD operations recorded by Run
 */

import type { RunId } from '../domain/ids';
import type { RunRecordV3 } from '../domain/events';
import { RUN_SCHEMA_VERSION } from '../domain/events';
import { RR_ERROR_CODES, createRRError } from '../domain/errors';
import type { RunsStore } from '../engine/storage/storage-port';
import { RR_V3_STORES, withTransaction } from './db';

/**
 * Verify Run record structure
 */
function validateRunRecord(record: RunRecordV3): void {
  // Verify schema version
  if (record.schemaVersion !== RUN_SCHEMA_VERSION) {
    throw createRRError(
      RR_ERROR_CODES.VALIDATION_ERROR,
      `Invalid schema version: expected ${RUN_SCHEMA_VERSION}, got ${record.schemaVersion}`,
    );
  }

  // Validate required fields
  if (!record.id) {
    throw createRRError(RR_ERROR_CODES.VALIDATION_ERROR, 'Run id is required');
  }
  if (!record.flowId) {
    throw createRRError(RR_ERROR_CODES.VALIDATION_ERROR, 'Run flowId is required');
  }
  if (!record.status) {
    throw createRRError(RR_ERROR_CODES.VALIDATION_ERROR, 'Run status is required');
  }
}

/**
 * Create RunsStore implementation
 */
export function createRunsStore(): RunsStore {
  return {
    async list(): Promise<RunRecordV3[]> {
      return withTransaction(RR_V3_STORES.RUNS, 'readonly', async (stores) => {
        const store = stores[RR_V3_STORES.RUNS];
        return new Promise<RunRecordV3[]>((resolve, reject) => {
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result as RunRecordV3[]);
          request.onerror = () => reject(request.error);
        });
      });
    },

    async get(id: RunId): Promise<RunRecordV3 | null> {
      return withTransaction(RR_V3_STORES.RUNS, 'readonly', async (stores) => {
        const store = stores[RR_V3_STORES.RUNS];
        return new Promise<RunRecordV3 | null>((resolve, reject) => {
          const request = store.get(id);
          request.onsuccess = () => resolve((request.result as RunRecordV3) ?? null);
          request.onerror = () => reject(request.error);
        });
      });
    },

    async save(record: RunRecordV3): Promise<void> {
      // Verification
      validateRunRecord(record);

      return withTransaction(RR_V3_STORES.RUNS, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.RUNS];
        return new Promise<void>((resolve, reject) => {
          const request = store.put(record);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },

    async patch(id: RunId, patch: Partial<RunRecordV3>): Promise<void> {
      return withTransaction(RR_V3_STORES.RUNS, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.RUNS];

        // Read existing records first
        const existing = await new Promise<RunRecordV3 | null>((resolve, reject) => {
          const request = store.get(id);
          request.onsuccess = () => resolve((request.result as RunRecordV3) ?? null);
          request.onerror = () => reject(request.error);
        });

        if (!existing) {
          throw createRRError(RR_ERROR_CODES.INTERNAL, `Run "${id}" not found`);
        }

        // Merge and update
        const updated: RunRecordV3 = {
          ...existing,
          ...patch,
          id: existing.id, // Make sure the id remains unchanged
          schemaVersion: existing.schemaVersion, // Make sure the version remains unchanged
          updatedAt: Date.now(),
        };

        return new Promise<void>((resolve, reject) => {
          const request = store.put(updated);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },
  };
}
