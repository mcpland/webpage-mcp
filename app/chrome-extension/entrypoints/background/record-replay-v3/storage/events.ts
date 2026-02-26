/**
 * @fileoverview RunEvent persistence
 * @description Implement atomic seq allocation and storage of events
 */

import type { RunId } from '../domain/ids';
import type { RunEvent, RunEventInput, RunRecordV3 } from '../domain/events';
import { RR_ERROR_CODES, createRRError } from '../domain/errors';
import type { EventsStore } from '../engine/storage/storage-port';
import { RR_V3_STORES, withTransaction } from './db';

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

/**
 * Create EventsStore implementation
 * @description
 * - append() Atomic allocation of seq within a single transaction
 * - seq Used by RunRecordV3.nextSeq as a single source of truth
 */
export function createEventsStore(): EventsStore {
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
          const event: RunEvent = {
            ...input,
            seq,
            ts: input.ts ?? Date.now(),
          } as RunEvent;

          // Step 3: Write event to events store
          await idbRequest(eventsStore.add(event), `append.addEvent(${input.runId}, seq=${seq})`);

          // Step 4: Increment nextSeq in runs store (same transaction)
          const updatedRun: RunRecordV3 = {
            ...run,
            nextSeq: seq + 1,
            updatedAt: Date.now(),
          };

          await idbRequest(
            runsStore.put(updatedRun),
            `append.updateNextSeq(${input.runId}, nextSeq=${seq + 1})`,
          );

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
