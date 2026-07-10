/**
 * @fileoverview RunRecordV3 persistence
 * @description Implement CRUD operations recorded by Run
 */

import type { RunId } from '../domain/ids';
import type { RunRecordV3 } from '../domain/events';
import { RUN_SCHEMA_VERSION, isTerminalStatus } from '../domain/events';
import {
  RUN_RESOURCE_LIMITS,
  findRunResourceLimitViolation,
  normalizeRunListOptions,
  resolveRunRetentionPolicy,
  runMatchesListOptions,
  type RunListOptions,
  type RunRetentionPolicy,
} from '../domain/run-limits';
import { RR_ERROR_CODES, createRRError } from '../domain/errors';
import type { RunsStore } from '../engine/storage/storage-port';
import { RR_V3_STORES, withTransaction } from './db';

/**
 * Verify Run record structure
 */
export function validateRunRecord(record: RunRecordV3): void {
  const resourceViolation = findRunResourceLimitViolation(record);
  if (resourceViolation) {
    throw createRRError(RR_ERROR_CODES.VALIDATION_ERROR, resourceViolation);
  }

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
  if (
    !Number.isSafeInteger(record.maxAttempts) ||
    record.maxAttempts < 1 ||
    record.maxAttempts > RUN_RESOURCE_LIMITS.maxAttempts
  ) {
    throw createRRError(
      RR_ERROR_CODES.VALIDATION_ERROR,
      `Run maxAttempts must be an integer between 1 and ${RUN_RESOURCE_LIMITS.maxAttempts}`,
    );
  }
  if (!Number.isSafeInteger(record.attempt) || record.attempt < 0) {
    throw createRRError(
      RR_ERROR_CODES.VALIDATION_ERROR,
      'Run attempt must be a non-negative safe integer',
    );
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runEventRange(runId: RunId): IDBKeyRange {
  return IDBKeyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER]);
}

async function deleteArtifactsByRun(store: IDBObjectStore, runId: RunId): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = store.index('runId').openCursor(IDBKeyRange.only(runId));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const deleteRequest = cursor.delete();
      deleteRequest.onerror = () => reject(deleteRequest.error);
      deleteRequest.onsuccess = () => cursor.continue();
    };
  });
}

async function deleteRunCascade(
  stores: Record<string, IDBObjectStore>,
  runId: RunId,
): Promise<void> {
  const runsStore = stores[RR_V3_STORES.RUNS];
  const eventsStore = stores[RR_V3_STORES.EVENTS];
  const queueStore = stores[RR_V3_STORES.QUEUE];
  const artifactsStore = stores[RR_V3_STORES.ARTIFACTS];
  await Promise.all([
    requestToPromise(runsStore.delete(runId)),
    requestToPromise(eventsStore.delete(runEventRange(runId))),
    requestToPromise(queueStore.delete(runId)),
    deleteArtifactsByRun(artifactsStore, runId),
  ]);
}

interface TerminalRunQuery {
  flowId?: string;
  olderThan?: number;
  limit: number;
}

async function findOldestTerminalRuns(
  store: IDBObjectStore,
  query: TerminalRunQuery,
): Promise<RunId[]> {
  if (query.limit <= 0) return [];
  return new Promise<RunId[]>((resolve, reject) => {
    const results: RunId[] = [];
    const request = store.index('createdAt').openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || results.length >= query.limit) {
        resolve(results);
        return;
      }
      const run = cursor.value as RunRecordV3;
      const retentionTimestamp = run.finishedAt ?? run.updatedAt;
      if (
        isTerminalStatus(run.status) &&
        (!query.flowId || run.flowId === query.flowId) &&
        (query.olderThan === undefined || retentionTimestamp <= query.olderThan)
      ) {
        results.push(run.id);
      }
      cursor.continue();
    };
  });
}

async function pruneRunIds(
  stores: Record<string, IDBObjectStore>,
  runIds: RunId[],
): Promise<void> {
  for (const runId of runIds) {
    await deleteRunCascade(stores, runId);
  }
}

async function ensureRunCapacity(
  stores: Record<string, IDBObjectStore>,
  record: RunRecordV3,
  policy: RunRetentionPolicy,
  now: number,
): Promise<void> {
  const runsStore = stores[RR_V3_STORES.RUNS];
  let pruneBudget = policy.maxPruneRunsPerWrite;

  const expired = await findOldestTerminalRuns(runsStore, {
    olderThan: now - policy.terminalTtlMs,
    limit: pruneBudget,
  });
  await pruneRunIds(stores, expired);
  pruneBudget -= expired.length;

  const flowIndex = runsStore.index('flowId');
  let flowCount = await requestToPromise(flowIndex.count(IDBKeyRange.only(record.flowId)));
  if (flowCount >= policy.maxRunsPerFlow && pruneBudget > 0) {
    const needed = Math.min(flowCount - policy.maxRunsPerFlow + 1, pruneBudget);
    const candidates = await findOldestTerminalRuns(runsStore, {
      flowId: record.flowId,
      limit: needed,
    });
    await pruneRunIds(stores, candidates);
    pruneBudget -= candidates.length;
    flowCount = await requestToPromise(flowIndex.count(IDBKeyRange.only(record.flowId)));
  }
  if (flowCount >= policy.maxRunsPerFlow) {
    throw createRRError(
      RR_ERROR_CODES.VALIDATION_ERROR,
      `Cannot store more than ${policy.maxRunsPerFlow} runs for flow "${record.flowId}"`,
    );
  }

  let totalCount = await requestToPromise(runsStore.count());
  if (totalCount >= policy.maxStoredRuns && pruneBudget > 0) {
    const needed = Math.min(totalCount - policy.maxStoredRuns + 1, pruneBudget);
    const candidates = await findOldestTerminalRuns(runsStore, { limit: needed });
    await pruneRunIds(stores, candidates);
    totalCount = await requestToPromise(runsStore.count());
  }
  if (totalCount >= policy.maxStoredRuns) {
    throw createRRError(
      RR_ERROR_CODES.VALIDATION_ERROR,
      `Cannot store more than ${policy.maxStoredRuns} runs`,
    );
  }
}

/**
 * Create RunsStore implementation
 */
export function createRunsStore(
  retentionOverrides: Partial<RunRetentionPolicy> = {},
  now: () => number = () => Date.now(),
): RunsStore {
  const retentionPolicy = resolveRunRetentionPolicy(retentionOverrides);
  return {
    async list(options?: RunListOptions): Promise<RunRecordV3[]> {
      let normalized: ReturnType<typeof normalizeRunListOptions>;
      try {
        normalized = normalizeRunListOptions(options);
      } catch (error) {
        throw createRRError(
          RR_ERROR_CODES.VALIDATION_ERROR,
          error instanceof Error ? error.message : String(error),
        );
      }
      return withTransaction(RR_V3_STORES.RUNS, 'readonly', async (stores) => {
        const store = stores[RR_V3_STORES.RUNS];
        return new Promise<RunRecordV3[]>((resolve, reject) => {
          const results: RunRecordV3[] = [];
          let skipped = 0;
          const request = store.index('createdAt').openCursor(null, 'prev');
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || results.length >= normalized.limit) {
              resolve(results);
              return;
            }
            const run = cursor.value as RunRecordV3;
            if (!runMatchesListOptions(run, normalized)) {
              cursor.continue();
              return;
            }
            if (skipped < normalized.offset) {
              skipped += 1;
              cursor.continue();
              return;
            }
            results.push(run);
            cursor.continue();
          };
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

      return withTransaction(
        [RR_V3_STORES.RUNS, RR_V3_STORES.EVENTS, RR_V3_STORES.QUEUE, RR_V3_STORES.ARTIFACTS],
        'readwrite',
        async (stores) => {
          const store = stores[RR_V3_STORES.RUNS];
          const existing = await requestToPromise<RunRecordV3 | undefined>(store.get(record.id));
          if (!existing) {
            await ensureRunCapacity(stores, record, retentionPolicy, now());
          }
          await requestToPromise(store.put(record));
        },
      );
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

        validateRunRecord(updated);

        return new Promise<void>((resolve, reject) => {
          const request = store.put(updated);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },

    async delete(id: RunId): Promise<void> {
      return withTransaction(
        [RR_V3_STORES.RUNS, RR_V3_STORES.EVENTS, RR_V3_STORES.QUEUE, RR_V3_STORES.ARTIFACTS],
        'readwrite',
        async (stores) => deleteRunCascade(stores, id),
      );
    },
  };
}
