/**
 * @fileoverview RunQueue persistence
 * @description Implement queue CRUD operations and atomic claims
 */

import type { RunId } from '../domain/ids';
import {
  DEFAULT_QUEUE_CONFIG,
  RunQueueBackpressureError,
  type EnqueueInput,
  type QueueItemStatus,
  type RunQueue,
  type RunQueueClaimConstraints,
  type RunQueueConfig,
  type RunQueueItem,
  type RunQueueProfile,
} from '../engine/queue/queue';
import { RR_V3_STORES, withTransaction } from './db';

/** Default lease TTL in milliseconds (from shared config to avoid drift) */
const DEFAULT_LEASE_TTL_MS = DEFAULT_QUEUE_CONFIG.leaseTtlMs;

interface ResolvedQueueAdmissionConfig {
  maxQueuedRuns: number;
  maxQueuedRunsPerFlow: number;
}

const RUN_QUEUE_PROFILES: readonly RunQueueProfile[] = [
  'safe',
  'idempotent',
  'dangerous',
  'unknown',
];

function resolveQueueAdmissionConfig(config: Partial<RunQueueConfig> = {}): ResolvedQueueAdmissionConfig {
  const maxQueuedRuns =
    typeof config.maxQueuedRuns === 'number' && Number.isFinite(config.maxQueuedRuns)
      ? Math.max(0, Math.floor(config.maxQueuedRuns))
      : DEFAULT_QUEUE_CONFIG.maxQueuedRuns ?? 200;
  const maxQueuedRunsPerFlow =
    typeof config.maxQueuedRunsPerFlow === 'number' && Number.isFinite(config.maxQueuedRunsPerFlow)
      ? Math.max(0, Math.floor(config.maxQueuedRunsPerFlow))
      : DEFAULT_QUEUE_CONFIG.maxQueuedRunsPerFlow ?? 25;

  return { maxQueuedRuns, maxQueuedRunsPerFlow };
}

async function countIndex(index: IDBIndex, query?: IDBValidKey | IDBKeyRange): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = index.count(query);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function countQueuedForFlow(statusIndex: IDBIndex, flowId: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let count = 0;
    const request = statusIndex.openCursor(IDBKeyRange.only('queued'));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(count);
        return;
      }
      const item = cursor.value as RunQueueItem;
      if (item.flowId === flowId) {
        count += 1;
      }
      cursor.continue();
    };
  });
}

function normalizeProfile(value: unknown): RunQueueProfile {
  return RUN_QUEUE_PROFILES.includes(value as RunQueueProfile)
    ? (value as RunQueueProfile)
    : 'unknown';
}

function toBlockedSet<T extends string>(values?: readonly T[]): Set<T> {
  return new Set((values ?? []).filter(Boolean));
}

function isClaimableWithConstraints(
  item: RunQueueItem,
  constraints: RunQueueClaimConstraints | undefined,
): boolean {
  if (item.status !== 'queued') {
    return false;
  }

  const blockedFlowIds = toBlockedSet(constraints?.blockedFlowIds);
  if (blockedFlowIds.has(item.flowId)) {
    return false;
  }

  const blockedProfiles = toBlockedSet(constraints?.blockedProfiles);
  if (blockedProfiles.has(normalizeProfile(item.profile))) {
    return false;
  }

  return true;
}

async function findClaimCandidate(
  store: IDBObjectStore,
  constraints: RunQueueClaimConstraints | undefined,
): Promise<RunQueueItem | null> {
  const statusIndex = store.index('status');
  const queuedItems = await new Promise<RunQueueItem[]>((resolve, reject) => {
    const items: RunQueueItem[] = [];
    const request = statusIndex.openCursor(IDBKeyRange.only('queued'));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(items);
        return;
      }
      items.push(cursor.value as RunQueueItem);
      cursor.continue();
    };
  });

  queuedItems.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.createdAt - b.createdAt;
  });

  return queuedItems.find((item) => isClaimableWithConstraints(item, constraints)) ?? null;
}

async function enforceQueuedBackpressure(
  store: IDBObjectStore,
  config: ResolvedQueueAdmissionConfig,
  input: EnqueueInput,
): Promise<void> {
  const statusIndex = store.index('status');
  const queuedCount = await countIndex(statusIndex, IDBKeyRange.only('queued'));
  if (queuedCount >= config.maxQueuedRuns) {
    throw new RunQueueBackpressureError({
      scope: 'global',
      limit: config.maxQueuedRuns,
      queuedCount,
    });
  }

  const queuedForFlow = await countQueuedForFlow(statusIndex, String(input.flowId));
  if (queuedForFlow >= config.maxQueuedRunsPerFlow) {
    throw new RunQueueBackpressureError({
      scope: 'flow',
      limit: config.maxQueuedRunsPerFlow,
      queuedCount: queuedForFlow,
      flowId: input.flowId,
    });
  }
}

/**
 * Create a RunQueue persistence implementation
 * @description Implement queue persistence, including Phase 3 atomic claims
 */
export function createQueueStore(config: Partial<RunQueueConfig> = {}): RunQueue {
  const admissionConfig = resolveQueueAdmissionConfig(config);

  return {
    async enqueue(input: EnqueueInput): Promise<RunQueueItem> {
      const now = Date.now();
      const item: RunQueueItem = {
        ...input,
        priority: input.priority ?? 0,
        maxAttempts: input.maxAttempts ?? 1,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        attempt: 0,
      };

      await withTransaction(RR_V3_STORES.QUEUE, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.QUEUE];
        await enforceQueuedBackpressure(store, admissionConfig, input);
        return new Promise<void>((resolve, reject) => {
          const request = store.add(item);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });

      return item;
    },

    async claimNext(
      ownerId: string,
      now: number,
      constraints?: RunQueueClaimConstraints,
    ): Promise<RunQueueItem | null> {
      // Validate inputs
      if (!ownerId) {
        throw new Error('ownerId is required');
      }
      if (!Number.isFinite(now)) {
        throw new Error(`Invalid now: ${String(now)}`);
      }

      return withTransaction(RR_V3_STORES.QUEUE, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.QUEUE];
        const existing = await findClaimCandidate(store, constraints);
        if (!existing) {
          return null;
        }

        // The transaction is readwrite and IndexedDB serializes queue writes, so the
        // selected queued candidate can be promoted atomically inside this transaction.
        const updated: RunQueueItem = {
          ...existing,
          status: 'running',
          updatedAt: now,
          attempt: existing.attempt + 1,
          lease: {
            ownerId,
            expiresAt: now + DEFAULT_LEASE_TTL_MS,
          },
        };

        return new Promise<RunQueueItem>((resolve, reject) => {
          const request = store.put(updated);
          request.onsuccess = () => resolve(updated);
          request.onerror = () => reject(request.error);
        });
      });
    },

    async heartbeat(ownerId: string, now: number): Promise<void> {
      // Validate inputs
      if (!ownerId) {
        throw new Error('ownerId is required');
      }
      if (!Number.isFinite(now)) {
        throw new Error(`Invalid now: ${String(now)}`);
      }

      await withTransaction(RR_V3_STORES.QUEUE, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.QUEUE];
        const statusIndex = store.index('status');

        /**
         * Renew leases for all items owned by ownerId in the given status.
         * Uses cursor iteration to update each item atomically.
         */
        const renewForStatus = async (status: QueueItemStatus): Promise<void> => {
          await new Promise<void>((resolve, reject) => {
            const request = statusIndex.openCursor(IDBKeyRange.only(status));
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) {
                resolve();
                return;
              }

              const item = cursor.value as RunQueueItem;
              const lease = item.lease;

              // Skip items not owned by this ownerId
              if (!lease || lease.ownerId !== ownerId) {
                cursor.continue();
                return;
              }

              // Renew the lease
              const updated: RunQueueItem = {
                ...item,
                updatedAt: now,
                lease: {
                  ...lease,
                  expiresAt: now + DEFAULT_LEASE_TTL_MS,
                },
              };

              const updateRequest = cursor.update(updated);
              updateRequest.onerror = () => reject(updateRequest.error);
              updateRequest.onsuccess = () => cursor.continue();
            };
          });
        };

        // Renew both running and paused items for the owner.
        // Paused items also need renewal to prevent TTL expiration during debug/manual pause.
        await renewForStatus('running');
        await renewForStatus('paused');
      });
    },

    async reclaimExpiredLeases(now: number): Promise<RunId[]> {
      if (!Number.isFinite(now)) {
        throw new Error(`Invalid now: ${String(now)}`);
      }

      return withTransaction(RR_V3_STORES.QUEUE, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.QUEUE];
        const leaseIndex = store.index('lease_expiresAt');

        // Scan all items where lease.expiresAt < now (strictly less than)
        const expiredRange = IDBKeyRange.upperBound(now, true);

        return new Promise<RunId[]>((resolve, reject) => {
          const reclaimed: RunId[] = [];
          const request = leaseIndex.openCursor(expiredRange);

          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              resolve(reclaimed);
              return;
            }

            const item = cursor.value as RunQueueItem;
            const expiresAtKey = cursor.key;

            // Defensive: index key should be a finite number (Unix millis)
            if (typeof expiresAtKey !== 'number' || !Number.isFinite(expiresAtKey)) {
              cursor.continue();
              return;
            }

            // The key range already guarantees expiresAtKey < now, but keep a guard
            // to be resilient to non-standard IndexedDB implementations.
            if (expiresAtKey >= now) {
              cursor.continue();
              return;
            }

            const isReclaimable = item.status === 'running' || item.status === 'paused';

            // Reclaim policy:
            // - running/paused + expired lease => move back to queued, drop lease
            // - any other status + expired lease => drop lease defensively (shouldn't happen)
            // Note: attempt is NOT reset on reclaim - preserves retry history.
            const { lease: _droppedLease, ...itemWithoutLease } = item;
            const updated: RunQueueItem = isReclaimable
              ? { ...itemWithoutLease, status: 'queued', updatedAt: now }
              : { ...itemWithoutLease, updatedAt: now };

            const updateRequest = cursor.update(updated);
            updateRequest.onerror = () => reject(updateRequest.error);
            updateRequest.onsuccess = () => {
              if (isReclaimable) {
                reclaimed.push(item.id);
              }
              cursor.continue();
            };
          };
        });
      });
    },

    async recoverOrphanLeases(
      ownerId: string,
      now: number,
    ): Promise<{
      requeuedRunning: Array<{ runId: RunId; prevOwnerId?: string }>;
      adoptedPaused: Array<{ runId: RunId; prevOwnerId?: string }>;
    }> {
      // Validate inputs
      if (!ownerId) {
        throw new Error('ownerId is required');
      }
      if (!Number.isFinite(now)) {
        throw new Error(`Invalid now: ${String(now)}`);
      }

      return withTransaction(RR_V3_STORES.QUEUE, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.QUEUE];
        const statusIndex = store.index('status');

        const requeuedRunning: Array<{ runId: RunId; prevOwnerId?: string }> = [];
        const adoptedPaused: Array<{ runId: RunId; prevOwnerId?: string }> = [];

        /**
         * Scan and recycle orphan running items
         * @description
         * - Orphan definition: no lease or lease.ownerId !== currentOwnerId
         * - Recycling strategy: status -> queued，Clear lease, keep attempt
         */
        const recoverRunningItems = (): Promise<void> =>
          new Promise<void>((resolve, reject) => {
            const request = statusIndex.openCursor(IDBKeyRange.only('running'));
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) {
                resolve();
                return;
              }

              const item = cursor.value as RunQueueItem;
              const prevOwnerId = item.lease?.ownerId;

              // Non-orphan: the lease exists and belongs to the current ownerId
              const isOrphan = !item.lease || item.lease.ownerId !== ownerId;
              if (!isOrphan) {
                cursor.continue();
                return;
              }

              // Recycling: Remove lease and change status to queued
              const { lease: _droppedLease, ...itemWithoutLease } = item;
              const updated: RunQueueItem = {
                ...itemWithoutLease,
                status: 'queued',
                updatedAt: now,
              };

              const updateRequest = cursor.update(updated);
              updateRequest.onerror = () => reject(updateRequest.error);
              updateRequest.onsuccess = () => {
                requeuedRunning.push({
                  runId: item.id,
                  ...(prevOwnerId ? { prevOwnerId } : {}),
                });
                cursor.continue();
              };
            };
          });

        /**
         * Scan and take over orphan paused items
         * @description
         * - Orphan definition: no lease or lease.ownerId !== currentOwnerId
         * - Takeover strategy: keep status=paused, update lease.ownerId to the new ownerId, renew TTL
         */
        const recoverPausedItems = (): Promise<void> =>
          new Promise<void>((resolve, reject) => {
            const request = statusIndex.openCursor(IDBKeyRange.only('paused'));
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) {
                resolve();
                return;
              }

              const item = cursor.value as RunQueueItem;
              const prevOwnerId = item.lease?.ownerId;

              // Non-orphan: the lease exists and belongs to the current ownerId
              const isOrphan = !item.lease || item.lease.ownerId !== ownerId;
              if (!isOrphan) {
                cursor.continue();
                return;
              }

              // Takeover: update lease to new ownerId, renew TTL
              const updated: RunQueueItem = {
                ...item,
                updatedAt: now,
                lease: {
                  ownerId,
                  expiresAt: now + DEFAULT_LEASE_TTL_MS,
                },
              };

              const updateRequest = cursor.update(updated);
              updateRequest.onerror = () => reject(updateRequest.error);
              updateRequest.onsuccess = () => {
                adoptedPaused.push({
                  runId: item.id,
                  ...(prevOwnerId ? { prevOwnerId } : {}),
                });
                cursor.continue();
              };
            };
          });

        // Sequential execution: process running first, then paused
        await recoverRunningItems();
        await recoverPausedItems();

        return { requeuedRunning, adoptedPaused };
      });
    },

    async markRunning(runId: RunId, ownerId: string, now: number): Promise<void> {
      await withTransaction(RR_V3_STORES.QUEUE, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.QUEUE];

        const existing = await new Promise<RunQueueItem | null>((resolve, reject) => {
          const request = store.get(runId);
          request.onsuccess = () => resolve((request.result as RunQueueItem) ?? null);
          request.onerror = () => reject(request.error);
        });

        if (!existing) {
          throw new Error(`Queue item "${runId}" not found`);
        }

        // Attempt semantics:
        // - queued -> running: attempt + 1 (a new scheduling attempt)
        // - paused/running -> running: attempt unchanged (resume/idempotent)
        const nextAttempt = existing.status === 'queued' ? existing.attempt + 1 : existing.attempt;

        const updated: RunQueueItem = {
          ...existing,
          status: 'running',
          updatedAt: now,
          attempt: nextAttempt,
          lease: {
            ownerId,
            expiresAt: now + DEFAULT_LEASE_TTL_MS,
          },
        };

        return new Promise<void>((resolve, reject) => {
          const request = store.put(updated);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },

    async markPaused(runId: RunId, ownerId: string, now: number): Promise<void> {
      await withTransaction(RR_V3_STORES.QUEUE, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.QUEUE];

        const existing = await new Promise<RunQueueItem | null>((resolve, reject) => {
          const request = store.get(runId);
          request.onsuccess = () => resolve((request.result as RunQueueItem) ?? null);
          request.onerror = () => reject(request.error);
        });

        if (!existing) {
          throw new Error(`Queue item "${runId}" not found`);
        }

        const updated: RunQueueItem = {
          ...existing,
          status: 'paused',
          updatedAt: now,
          lease: {
            ownerId,
            expiresAt: now + DEFAULT_LEASE_TTL_MS,
          },
        };

        return new Promise<void>((resolve, reject) => {
          const request = store.put(updated);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },

    async markDone(runId: RunId, now: number): Promise<void> {
      await withTransaction(RR_V3_STORES.QUEUE, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.QUEUE];
        return new Promise<void>((resolve, reject) => {
          const request = store.delete(runId);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },

    async cancel(runId: RunId, _now: number, _reason?: string): Promise<void> {
      // Remove from queue
      await this.markDone(runId, _now);
    },

    async get(runId: RunId): Promise<RunQueueItem | null> {
      return withTransaction(RR_V3_STORES.QUEUE, 'readonly', async (stores) => {
        const store = stores[RR_V3_STORES.QUEUE];
        return new Promise<RunQueueItem | null>((resolve, reject) => {
          const request = store.get(runId);
          request.onsuccess = () => resolve((request.result as RunQueueItem) ?? null);
          request.onerror = () => reject(request.error);
        });
      });
    },

    async list(status?: QueueItemStatus): Promise<RunQueueItem[]> {
      return withTransaction(RR_V3_STORES.QUEUE, 'readonly', async (stores) => {
        const store = stores[RR_V3_STORES.QUEUE];

        if (status) {
          // Use index query
          const index = store.index('status');
          return new Promise<RunQueueItem[]>((resolve, reject) => {
            const request = index.getAll(IDBKeyRange.only(status));
            request.onsuccess = () => resolve(request.result as RunQueueItem[]);
            request.onerror = () => reject(request.error);
          });
        }

        // Get all
        return new Promise<RunQueueItem[]>((resolve, reject) => {
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result as RunQueueItem[]);
          request.onerror = () => reject(request.error);
        });
      });
    },
  };
}
