/**
 * @fileoverview RunEvent persistence
 * @description Implement atomic seq allocation and storage of events
 */

import type { RunId } from '../domain/ids';
import type { RunEvent, RunEventInput, RunRecordV3 } from '../domain/events';
import {
  EVENT_RESOURCE_LIMITS,
  findEventResourceLimitViolation,
  normalizeEventListOptions,
  type EventListOptions,
} from '../domain/event-limits';
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

type EventCursorSource = IDBObjectStore | IDBIndex;

function runEventRange(runId: RunId): IDBKeyRange {
  return IDBKeyRange.bound([runId, 0], [runId, Number.MAX_SAFE_INTEGER]);
}

function flowEventRange(flowId: string): IDBKeyRange {
  return IDBKeyRange.bound([flowId, 0], [flowId, Number.MAX_SAFE_INTEGER]);
}

async function deleteFirstEvents(
  source: EventCursorSource,
  range: IDBKeyRange | undefined,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  return new Promise<void>((resolve, reject) => {
    let remaining = count;
    const request = source.openCursor(range);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || remaining <= 0) {
        resolve();
        return;
      }
      const deleteRequest = cursor.delete();
      deleteRequest.onerror = () => reject(deleteRequest.error);
      deleteRequest.onsuccess = () => {
        remaining -= 1;
        if (remaining <= 0) {
          resolve();
          return;
        }
        cursor.continue();
      };
    };
  });
}

async function pruneOldestEvents(
  source: EventCursorSource,
  range: IDBKeyRange | undefined,
  maxCount: number,
): Promise<void> {
  const count = await idbRequest(source.count(range), 'events.retention.count');
  const overflow = Math.min(
    Math.max(0, count - maxCount),
    EVENT_RESOURCE_LIMITS.maxPruneDeletesPerAppend,
  );
  await deleteFirstEvents(source, range, overflow);
}

async function pruneEventRetention(
  eventsStore: IDBObjectStore,
  policy: EventRetentionPolicy,
  run: RunRecordV3,
): Promise<void> {
  await pruneOldestEvents(eventsStore, runEventRange(run.id), policy.maxEventsPerRun);
  await pruneOldestEvents(
    eventsStore.index('flowId_ts'),
    flowEventRange(run.flowId),
    policy.maxEventsPerFlow,
  );
  await pruneOldestEvents(eventsStore.index('ts'), undefined, policy.maxTotalEvents);
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
      const inputViolation = findEventResourceLimitViolation(input);
      if (inputViolation) {
        throw createRRError(RR_ERROR_CODES.VALIDATION_ERROR, inputViolation);
      }
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
            flowId: run.flowId,
            seq,
            ts: timestamp,
          } as RunEvent;

          const eventViolation = findEventResourceLimitViolation(event);
          if (eventViolation) {
            throw createRRError(RR_ERROR_CODES.VALIDATION_ERROR, eventViolation);
          }

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

          await pruneEventRetention(eventsStore, retentionPolicy, updatedRun);

          return event;
        },
      );
    },

    /**
     * list events
     * @description Utilize composite primary keys [runId, seq] Implement efficient range queries
     */
    async list(runId: RunId, opts?: EventListOptions): Promise<RunEvent[]> {
      let normalized: ReturnType<typeof normalizeEventListOptions>;
      try {
        normalized = normalizeEventListOptions(opts);
      } catch (error) {
        throw createRRError(
          RR_ERROR_CODES.VALIDATION_ERROR,
          error instanceof Error ? error.message : String(error),
        );
      }
      return withTransaction(RR_V3_STORES.EVENTS, 'readonly', async (stores) => {
        const store = stores[RR_V3_STORES.EVENTS];
        const { fromSeq, limit } = normalized;

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
            if (results.length >= limit) {
              resolve(results);
              return;
            }

            cursor.continue();
          };

          request.onerror = () => reject(request.error);
        });
      });
    },

    async deleteByRun(runId: RunId): Promise<number> {
      return withTransaction(RR_V3_STORES.EVENTS, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.EVENTS];
        const range = runEventRange(runId);
        const count = await idbRequest(store.count(range), `events.countByRun(${runId})`);
        if (count > 0) {
          await idbRequest(store.delete(range), `events.deleteByRun(${runId})`);
        }
        return count;
      });
    },
  };
}
