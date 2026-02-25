/**
 * @fileoverview RunQueue 持久化
 * @description 实现队列的 CRUD 操作和原子 claim
 */

import type { RunId } from '../domain/ids';
import {
  DEFAULT_QUEUE_CONFIG,
  type EnqueueInput,
  type QueueItemStatus,
  type RunQueue,
  type RunQueueItem,
} from '../engine/queue/queue';
import { RR_V3_STORES, withTransaction } from './db';

/** Default lease TTL in milliseconds (from shared config to avoid drift) */
const DEFAULT_LEASE_TTL_MS = DEFAULT_QUEUE_CONFIG.leaseTtlMs;

/**
 * IDB key range bounds for numeric fields.
 * Use MAX_VALUE to cover the full range of finite numbers (not just safe integers).
 */
const IDB_NUMBER_MIN = -Number.MAX_VALUE;
const IDB_NUMBER_MAX = Number.MAX_VALUE;

/**
 * 创建 RunQueue 持久化实现
 * @description 实现队列持久化，包括 Phase 3 原子 claim
 */
export function createQueueStore(): RunQueue {
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
        return new Promise<void>((resolve, reject) => {
          const request = store.add(item);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });

      return item;
    },

    async claimNext(ownerId: string, now: number): Promise<RunQueueItem | null> {
      // Validate inputs
      if (!ownerId) {
        throw new Error('ownerId is required');
      }
      if (!Number.isFinite(now)) {
        throw new Error(`Invalid now: ${String(now)}`);
      }

      return withTransaction(RR_V3_STORES.QUEUE, 'readwrite', async (stores) => {
        const store = stores[RR_V3_STORES.QUEUE];
        const index = store.index('status_priority_createdAt');

        /**
         * Atomic claim implementation using two-step cursor approach:
         *
         * Desired ordering: priority DESC, createdAt ASC (FIFO within same priority)
         *
         * IndexedDB compound indexes only support single sort direction for the entire tuple.
         * The index ['status', 'priority', 'createdAt'] is stored ASC.
         *
         * Strategy:
         * 1. Use 'prev' cursor to find the highest priority (overall DESC)
         * 2. Use 'next' cursor within that priority to find earliest createdAt (FIFO)
         *
         * Both operations are within the same readwrite transaction, ensuring atomicity
         * since IndexedDB serializes readwrite transactions on the same store.
         */

        // Step 1: Find the highest priority among queued items
        const queuedRange = IDBKeyRange.bound(
          ['queued', IDB_NUMBER_MIN, IDB_NUMBER_MIN],
          ['queued', IDB_NUMBER_MAX, IDB_NUMBER_MAX],
        );

        const highestPriority = await new Promise<number | null>((resolve, reject) => {
          const request = index.openCursor(queuedRange, 'prev');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              resolve(null);
              return;
            }
            const item = cursor.value as RunQueueItem;
            resolve(item.priority);
          };
        });

        // No queued items available
        if (highestPriority === null) {
          return null;
        }

        // Step 2: Find the earliest createdAt within the highest priority (FIFO)
        const fifoRange = IDBKeyRange.bound(
          ['queued', highestPriority, IDB_NUMBER_MIN],
          ['queued', highestPriority, IDB_NUMBER_MAX],
        );

        return new Promise<RunQueueItem | null>((resolve, reject) => {
          const request = index.openCursor(fifoRange, 'next');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              // No items found (should not happen given step 1 succeeded)
              resolve(null);
              return;
            }

            const existing = cursor.value as RunQueueItem;

            // Defensive check: ensure status is still queued
            if (existing.status !== 'queued') {
              resolve(null);
              return;
            }

            // Atomically update to running with lease
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

            const updateRequest = cursor.update(updated);
            updateRequest.onerror = () => reject(updateRequest.error);
            updateRequest.onsuccess = () => resolve(updated);
          };
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
         * 扫描并回收孤儿 running 项
         * @description
         * - 孤儿定义：无租约或 lease.ownerId !== currentOwnerId
         * - 回收策略：status -> queued，清除 lease，保留 attempt
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

              // 非孤儿：lease 存在且属于当前 ownerId
              const isOrphan = !item.lease || item.lease.ownerId !== ownerId;
              if (!isOrphan) {
                cursor.continue();
                return;
              }

              // 回收：移除 lease，状态改为 queued
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
         * 扫描并接管孤儿 paused 项
         * @description
         * - 孤儿定义：无租约或 lease.ownerId !== currentOwnerId
         * - 接管策略：保持 status=paused，更新 lease.ownerId 为新 ownerId，续约 TTL
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

              // 非孤儿：lease 存在且属于当前 ownerId
              const isOrphan = !item.lease || item.lease.ownerId !== ownerId;
              if (!isOrphan) {
                cursor.continue();
                return;
              }

              // 接管：更新 lease 为新 ownerId，续约 TTL
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

        // 顺序执行：先处理 running，再处理 paused
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
      // 从队列中删除
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
          // 使用索引查询
          const index = store.index('status');
          return new Promise<RunQueueItem[]>((resolve, reject) => {
            const request = index.getAll(IDBKeyRange.only(status));
            request.onsuccess = () => resolve(request.result as RunQueueItem[]);
            request.onerror = () => reject(request.error);
          });
        }

        // 获取所有
        return new Promise<RunQueueItem[]>((resolve, reject) => {
          const request = store.getAll();
          request.onsuccess = () => resolve(request.result as RunQueueItem[]);
          request.onerror = () => reject(request.error);
        });
      });
    },
  };
}
