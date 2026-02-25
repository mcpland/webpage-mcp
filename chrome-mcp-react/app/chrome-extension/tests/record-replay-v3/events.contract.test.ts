/**
 * @fileoverview Record-Replay V3 Events Contracts
 * @description
 * Verifies the persistence + transport contracts for:
 * - EventsStore (IndexedDB-backed): atomic seq allocation via RunRecordV3.nextSeq
 * - StorageBackedEventsBus: persistence-before-broadcast semantics
 *
 * Note: These tests assume `RunRecordV3.nextSeq` is initialized to 1 (1-based seq).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type {
  RunEvent,
  RunEventInput,
  RunRecordV3,
} from '@/entrypoints/background/record-replay-v3';

import {
  RUN_SCHEMA_VERSION,
  RR_ERROR_CODES,
  StorageBackedEventsBus,
  createEventsStore,
  createRunsStore,
  closeRrV3Db,
  deleteRrV3Db,
  RR_V3_STORES,
  withTransaction,
} from '@/entrypoints/background/record-replay-v3';

/**
 * Create a valid RunRecordV3 for testing
 */
function createRunRecord(runId: string, overrides: Partial<RunRecordV3> = {}): RunRecordV3 {
  const now = Date.now();
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    id: runId,
    flowId: 'flow-1',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    attempt: 0,
    maxAttempts: 1,
    nextSeq: 1,
    ...overrides,
  };
}

/**
 * Create a valid RunEventInput for testing
 */
function createEventInput(runId: string, overrides: Partial<RunEventInput> = {}): RunEventInput {
  return {
    runId,
    type: 'run.resumed',
    ...overrides,
  } as RunEventInput;
}

/**
 * Directly insert an event into the events store (bypasses append logic)
 * Used for testing list() with out-of-order data
 */
async function putEventRaw(event: RunEvent): Promise<void> {
  await withTransaction(RR_V3_STORES.EVENTS, 'readwrite', async (stores) => {
    const store = stores[RR_V3_STORES.EVENTS];
    await new Promise<void>((resolve, reject) => {
      const request = store.add(event);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

describe('V3 Events contracts', () => {
  beforeEach(async () => {
    await deleteRrV3Db();
    closeRrV3Db();
  });

  describe('EventsStore', () => {
    it('seq is monotonic and contiguous for a run', async () => {
      const runs = createRunsStore();
      const events = createEventsStore();

      await runs.save(createRunRecord('run-1', { nextSeq: 1 }));

      const e1 = await events.append(createEventInput('run-1'));
      const e2 = await events.append(createEventInput('run-1'));
      const e3 = await events.append(createEventInput('run-1'));

      expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);
    });

    it('append is atomic: event.seq matches pre-append nextSeq and nextSeq increments on success', async () => {
      const runs = createRunsStore();
      const events = createEventsStore();

      await runs.save(createRunRecord('run-1', { nextSeq: 10 }));

      const appended = await events.append(createEventInput('run-1'));
      expect(appended.seq).toBe(10);

      const runAfter = await runs.get('run-1');
      expect(runAfter).not.toBeNull();
      expect(runAfter!.nextSeq).toBe(appended.seq + 1);

      const list = await events.list('run-1');
      expect(list.map((e) => e.seq)).toContain(10);
    });

    it('throws RRError when appending to a missing run', async () => {
      const events = createEventsStore();

      await expect(events.append(createEventInput('missing-run'))).rejects.toMatchObject({
        code: RR_ERROR_CODES.INTERNAL,
      });
    });

    it('list returns events ordered by seq ascending (even if inserted out-of-order)', async () => {
      const events = createEventsStore();
      const runId = 'run-1';
      const now = Date.now();

      // Insert events out of order to verify sorting
      await putEventRaw({ runId, type: 'run.resumed', seq: 5, ts: now } as RunEvent);
      await putEventRaw({ runId, type: 'run.resumed', seq: 2, ts: now } as RunEvent);
      await putEventRaw({ runId, type: 'run.resumed', seq: 9, ts: now } as RunEvent);

      const list = await events.list(runId);
      expect(list.map((e) => e.seq)).toEqual([2, 5, 9]);
    });

    it('list supports fromSeq (inclusive)', async () => {
      const runs = createRunsStore();
      const events = createEventsStore();

      await runs.save(createRunRecord('run-1', { nextSeq: 1 }));
      for (let i = 0; i < 5; i++) {
        await events.append(createEventInput('run-1'));
      }

      const list = await events.list('run-1', { fromSeq: 3 });
      expect(list.map((e) => e.seq)).toEqual([3, 4, 5]);
    });

    it('list supports limit', async () => {
      const runs = createRunsStore();
      const events = createEventsStore();

      await runs.save(createRunRecord('run-1', { nextSeq: 1 }));
      for (let i = 0; i < 5; i++) {
        await events.append(createEventInput('run-1'));
      }

      const list = await events.list('run-1', { limit: 2 });
      expect(list.map((e) => e.seq)).toEqual([1, 2]);

      const listFrom = await events.list('run-1', { fromSeq: 2, limit: 2 });
      expect(listFrom.map((e) => e.seq)).toEqual([2, 3]);

      const empty = await events.list('run-1', { limit: 0 });
      expect(empty).toEqual([]);
    });

    it('seq allocation remains correct under concurrent appends', async () => {
      const runs = createRunsStore();
      const events = createEventsStore();

      await runs.save(createRunRecord('run-1', { nextSeq: 1 }));

      // Fire multiple appends concurrently
      const appended = await Promise.all(
        Array.from({ length: 20 }, () => events.append(createEventInput('run-1'))),
      );

      const seqs = appended.map((e) => e.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

      const runAfter = await runs.get('run-1');
      expect(runAfter!.nextSeq).toBe(21);
    });

    it('list does not mix events from different runs', async () => {
      const runs = createRunsStore();
      const events = createEventsStore();

      await runs.save(createRunRecord('run-1', { nextSeq: 1 }));
      await runs.save(createRunRecord('run-2', { nextSeq: 1 }));

      await events.append(createEventInput('run-1'));
      await events.append(createEventInput('run-2'));
      await events.append(createEventInput('run-1'));

      const run1Events = await events.list('run-1');
      const run2Events = await events.list('run-2');

      expect(run1Events.every((e) => e.runId === 'run-1')).toBe(true);
      expect(run2Events.every((e) => e.runId === 'run-2')).toBe(true);
      expect(run1Events.map((e) => e.seq)).toEqual([1, 2]);
      expect(run2Events.map((e) => e.seq)).toEqual([1]);
    });

    it('throws INVARIANT_VIOLATION when nextSeq is invalid', async () => {
      const runs = createRunsStore();
      const events = createEventsStore();

      // Test with negative nextSeq
      await runs.save(createRunRecord('run-neg', { nextSeq: -1 }));
      await expect(events.append(createEventInput('run-neg'))).rejects.toMatchObject({
        code: RR_ERROR_CODES.INVARIANT_VIOLATION,
      });

      // Test with non-integer nextSeq (NaN)
      await runs.save(createRunRecord('run-nan', { nextSeq: NaN }));
      await expect(events.append(createEventInput('run-nan'))).rejects.toMatchObject({
        code: RR_ERROR_CODES.INVARIANT_VIOLATION,
      });
    });
  });

  describe('StorageBackedEventsBus', () => {
    it('broadcasts after commit: when listener runs, data is already durable', async () => {
      const runs = createRunsStore();
      const events = createEventsStore();
      await runs.save(createRunRecord('run-1', { nextSeq: 1 }));

      const bus = new StorageBackedEventsBus(events);

      const received: RunEvent[] = [];
      let seenRunNextSeq: number | null = null;
      let seenListSeqs: number[] | null = null;

      const listenerDone = new Promise<void>((resolve, reject) => {
        bus.subscribe((event) => {
          received.push(event);
          void Promise.all([runs.get(event.runId), events.list(event.runId)])
            .then(([run, list]) => {
              seenRunNextSeq = run?.nextSeq ?? null;
              seenListSeqs = list.map((e) => e.seq);
              resolve();
            })
            .catch(reject);
        });
      });

      const appended = await bus.append(createEventInput('run-1'));

      // Contract: by the time append resolves, the event is already broadcast
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ runId: 'run-1', seq: appended.seq });

      await listenerDone;
      expect(seenRunNextSeq).toBe(appended.seq + 1);
      expect(seenListSeqs).toContain(appended.seq);
    });

    it('applies runId filter for subscriptions', async () => {
      const runs = createRunsStore();
      const events = createEventsStore();
      await runs.save(createRunRecord('run-1', { nextSeq: 1 }));
      await runs.save(createRunRecord('run-2', { nextSeq: 1 }));

      const bus = new StorageBackedEventsBus(events);

      const all: RunEvent[] = [];
      const onlyRun1: RunEvent[] = [];
      const onlyRun2: RunEvent[] = [];

      bus.subscribe((e) => all.push(e));
      bus.subscribe((e) => onlyRun1.push(e), { runId: 'run-1' });
      bus.subscribe((e) => onlyRun2.push(e), { runId: 'run-2' });

      await bus.append(createEventInput('run-1'));
      await bus.append(createEventInput('run-2'));

      expect(all.map((e) => e.runId)).toEqual(['run-1', 'run-2']);
      expect(onlyRun1.map((e) => e.runId)).toEqual(['run-1']);
      expect(onlyRun2.map((e) => e.runId)).toEqual(['run-2']);
    });

    it('unsubscribe stops further broadcasts', async () => {
      const runs = createRunsStore();
      const events = createEventsStore();
      await runs.save(createRunRecord('run-1', { nextSeq: 1 }));

      const bus = new StorageBackedEventsBus(events);
      const received: RunEvent[] = [];
      const unsub = bus.subscribe((e) => received.push(e));

      await bus.append(createEventInput('run-1'));
      expect(received).toHaveLength(1);

      unsub();
      await bus.append(createEventInput('run-1'));

      // Should not receive second event after unsubscribe
      expect(received).toHaveLength(1);
    });
  });

  describe('Crash recovery', () => {
    it('continues seq after a simulated restart', async () => {
      const runs1 = createRunsStore();
      const events1 = createEventsStore();

      await runs1.save(createRunRecord('run-1', { nextSeq: 1 }));

      await events1.append(createEventInput('run-1'));
      await events1.append(createEventInput('run-1'));
      await events1.append(createEventInput('run-1'));

      // Simulate a service worker restart (drop cached IDB connection)
      closeRrV3Db();

      const runs2 = createRunsStore();
      const events2 = createEventsStore();

      const e4 = await events2.append(createEventInput('run-1'));
      expect(e4.seq).toBe(4);

      const list = await events2.list('run-1');
      expect(list.map((e) => e.seq)).toEqual([1, 2, 3, 4]);

      const run = await runs2.get('run-1');
      expect(run!.nextSeq).toBe(5);
    });
  });
});
