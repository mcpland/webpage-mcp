/**
 * @fileoverview RunEvent persistence
 * @description Implement atomic seq allocation and storage of events
 */

import type { RunId } from '../domain/ids';
import type { RunEvent, RunEventInput, RunRecordV3 } from '../domain/events';
import { RR_ERROR_CODES, createRRError } from '../domain/errors';
import type { EventsStore } from '../engine/storage/storage-port';
import { RR_V3_STORES, withTransaction } from './db';

export interface EventRetentionPolicy {
  maxEventsPerRun: number;
  maxEventsPerFlow: number;
  maxTotalEvents: number;
}

export const DEFAULT_EVENT_RETENTION: EventRetentionPolicy = {
  maxEventsPerRun: 1_000,
  maxEventsPerFlow: 5_000,
  maxTotalEvents: 50_000,
};

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function resolveEventRetentionPolicy(
  overrides: Partial<EventRetentionPolicy>,
): EventRetentionPolicy {
  const maxTotalEvents = positiveInteger(
    overrides.maxTotalEvents,
    DEFAULT_EVENT_RETENTION.maxTotalEvents,
  );
  const maxEventsPerFlow = Math.min(
    maxTotalEvents,
    positiveInteger(overrides.maxEventsPerFlow, DEFAULT_EVENT_RETENTION.maxEventsPerFlow),
  );
  const maxEventsPerRun = Math.min(
    maxEventsPerFlow,
    positiveInteger(overrides.maxEventsPerRun, DEFAULT_EVENT_RETENTION.maxEventsPerRun),
  );
  return { maxEventsPerRun, maxEventsPerFlow, maxTotalEvents };
}

/**
 * IDB request helper - promisify IDBRequest with RRError wrapping
 */
function idbRequest<T>(request: IDBRequest<T>, context: string): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      const error = request.error;
      reject(
        createRRError(
          RR_ERROR_CODES.INTERNAL,
          `IDB error in ${context}: ${error?.message ?? 'unknown'}`,
        ),
      );
    };
  });
}

function eventKey(event: RunEvent): [RunId, number] {
  return [event.runId, event.seq];
}

function eventKeyString(event: RunEvent): string {
  return `${event.runId}\u0000${event.seq}`;
}

function oldestEventFirst(a: RunEvent, b: RunEvent): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  const runCompare = String(a.runId).localeCompare(String(b.runId));
  if (runCompare !== 0) return runCompare;
  return a.seq - b.seq;
}

async function getEventsForRun(store: IDBObjectStore, runId: RunId): Promise<RunEvent[]> {
  return new Promise<RunEvent[]>((resolve, reject) => {
    const results: RunEvent[] = [];
    const range = IDBKeyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER]);
    const request = store.openCursor(range);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(results);
        return;
      }
      results.push(cursor.value as RunEvent);
      cursor.continue();
    };
  });
}

async function getAllEvents(store: IDBObjectStore): Promise<RunEvent[]> {
  return idbRequest(store.getAll() as IDBRequest<RunEvent[]>, 'events.getAll');
}

async function getRunIdsForFlow(runsStore: IDBObjectStore, flowId: string): Promise<Set<RunId>> {
  const index = runsStore.index('flowId');
  const runs = await idbRequest<RunRecordV3[]>(
    index.getAll(flowId) as IDBRequest<RunRecordV3[]>,
    `events.getRunsForFlow(${flowId})`,
  );
  return new Set(runs.map((run) => run.id));
}

async function deleteOldestEvents(
  eventsStore: IDBObjectStore,
  events: RunEvent[],
  maxCount: number,
  deletedKeys: Set<string>,
): Promise<void> {
  if (events.length <= maxCount) {
    return;
  }

  const deleteCount = events.length - maxCount;
  const oldest = [...events].sort(oldestEventFirst).slice(0, deleteCount);
  for (const event of oldest) {
    const key = eventKeyString(event);
    if (deletedKeys.has(key)) {
      continue;
    }
    deletedKeys.add(key);
    await idbRequest(eventsStore.delete(eventKey(event)), `events.delete(${key})`);
  }
}

async function pruneEventRetention(
  runsStore: IDBObjectStore,
  eventsStore: IDBObjectStore,
  policy: EventRetentionPolicy,
  run: RunRecordV3,
): Promise<void> {
  const deletedKeys = new Set<string>();

  const runEvents = await getEventsForRun(eventsStore, run.id);
  await deleteOldestEvents(eventsStore, runEvents, policy.maxEventsPerRun, deletedKeys);

  const allAfterRunPrune = await getAllEvents(eventsStore);
  const flowRunIds = await getRunIdsForFlow(runsStore, run.flowId);
  const flowEvents = allAfterRunPrune.filter((event) => flowRunIds.has(event.runId));
  await deleteOldestEvents(eventsStore, flowEvents, policy.maxEventsPerFlow, deletedKeys);

  const allAfterFlowPrune = await getAllEvents(eventsStore);
  await deleteOldestEvents(eventsStore, allAfterFlowPrune, policy.maxTotalEvents, deletedKeys);
}

/**
 * Create EventsStore implementation
 * @description
 * - append() Atomic allocation of seq within a single transaction
 * - seq Used by RunRecordV3.nextSeq as a single source of truth
 */
export function createEventsStore(
  retentionOverrides: Partial<EventRetentionPolicy> = {},
): EventsStore {
  const retentionPolicy = resolveEventRetentionPolicy(retentionOverrides);

  return {
    /**
     * Append events and atomically assign seq
     * @description In a single transaction: read RunRecordV3.nextSeq -> Write event -> increment nextSeq
     */
    async append(input: RunEventInput): Promise<RunEvent> {
      return withTransaction(
        [RR_V3_STORES.RUNS, RR_V3_STORES.EVENTS],
        'readwrite',
        async (stores) => {
          const runsStore = stores[RR_V3_STORES.RUNS];
          const eventsStore = stores[RR_V3_STORES.EVENTS];

          // Step 1: Read nextSeq from RunRecordV3 (single source of truth)
          const run = await idbRequest<RunRecordV3 | undefined>(
            runsStore.get(input.runId),
            `append.getRun(${input.runId})`,
          );

          if (!run) {
            throw createRRError(
              RR_ERROR_CODES.INTERNAL,
              `Run "${input.runId}" not found when appending event`,
            );
          }

          const seq = run.nextSeq;

          // Validate seq integrity
          if (!Number.isSafeInteger(seq) || seq < 0) {
            throw createRRError(
              RR_ERROR_CODES.INVARIANT_VIOLATION,
              `Invalid nextSeq for run "${input.runId}": ${String(seq)}`,
            );
          }

          // Step 2: Create complete event with allocated seq
          const timestamp = Math.max(input.ts ?? Date.now(), run.updatedAt);
          const event: RunEvent = {
            ...input,
            seq,
            ts: timestamp,
          } as RunEvent;

          // Step 3: Write event to events store
          await idbRequest(eventsStore.add(event), `append.addEvent(${input.runId}, seq=${seq})`);

          // Step 4: Increment nextSeq in runs store (same transaction)
          const updatedRun: RunRecordV3 = {
            ...run,
            nextSeq: seq + 1,
            updatedAt: Math.max(Date.now(), timestamp),
          };

          await idbRequest(
            runsStore.put(updatedRun),
            `append.updateNextSeq(${input.runId}, nextSeq=${seq + 1})`,
          );

          await pruneEventRetention(runsStore, eventsStore, retentionPolicy, updatedRun);

          return event;
        },
      );
    },

    /**
     * list events
     * @description Utilize composite primary keys [runId, seq] Implement efficient range queries
     */
    async list(runId: RunId, opts?: { fromSeq?: number; limit?: number }): Promise<RunEvent[]> {
      return withTransaction(RR_V3_STORES.EVENTS, 'readonly', async (stores) => {
        const store = stores[RR_V3_STORES.EVENTS];
        const fromSeq = opts?.fromSeq ?? 0;
        const limit = opts?.limit;

        // Early return for zero limit
        if (limit === 0) {
          return [];
        }

        return new Promise<RunEvent[]>((resolve, reject) => {
          const results: RunEvent[] = [];

          // Use compound primary key [runId, seq] for efficient range query
          // This yields events in seq-ascending order naturally
          const range = IDBKeyRange.bound([runId, fromSeq], [runId, Number.MAX_SAFE_INTEGER]);

          const request = store.openCursor(range);

          request.onsuccess = () => {
            const cursor = request.result;

            if (!cursor) {
              resolve(results);
              return;
            }

            const event = cursor.value as RunEvent;
            results.push(event);

            // Check limit
            if (limit !== undefined && results.length >= limit) {
              resolve(results);
              return;
            }

            cursor.continue();
          };

          request.onerror = () => reject(request.error);
        });
      });
    },
  };
}
