/**
 * @fileoverview RunQueue persistence
 * @description Implement queue CRUD operations and atomic claims
 */

import type { RunId } from "../domain/ids";
import {
  QUEUE_RESOURCE_LIMITS,
  findQueueItemResourceLimitViolation,
} from "../domain/queue-limits";
import {
  findJsonResourceLimitViolation,
  jsonUtf8ByteLength,
} from "../domain/json-limits";
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
} from "../engine/queue/queue";
import { RR_V3_STORES, withTransaction } from "./db";

interface ResolvedQueueAdmissionConfig {
  maxQueuedRuns: number;
  maxQueuedRunsPerFlow: number;
}

const RUN_QUEUE_PROFILES: readonly RunQueueProfile[] = [
  "safe",
  "idempotent",
  "dangerous",
  "unknown",
];

function resolveQueueAdmissionConfig(
  config: Partial<RunQueueConfig> = {},
): ResolvedQueueAdmissionConfig {
  const defaultMaxQueuedRuns = Math.min(
    DEFAULT_QUEUE_CONFIG.maxQueuedRuns ?? QUEUE_RESOURCE_LIMITS.maxQueuedItems,
    QUEUE_RESOURCE_LIMITS.maxQueuedItems,
  );
  const maxQueuedRuns =
    typeof config.maxQueuedRuns === "number" &&
    Number.isFinite(config.maxQueuedRuns)
      ? Math.min(
          QUEUE_RESOURCE_LIMITS.maxQueuedItems,
          Math.max(0, Math.floor(config.maxQueuedRuns)),
        )
      : defaultMaxQueuedRuns;
  const configuredMaxQueuedRunsPerFlow =
    typeof config.maxQueuedRunsPerFlow === "number" &&
    Number.isFinite(config.maxQueuedRunsPerFlow)
      ? Math.min(
          QUEUE_RESOURCE_LIMITS.maxQueuedItemsPerFlow,
          Math.max(0, Math.floor(config.maxQueuedRunsPerFlow)),
        )
      : Math.min(
          DEFAULT_QUEUE_CONFIG.maxQueuedRunsPerFlow ??
            QUEUE_RESOURCE_LIMITS.maxQueuedItemsPerFlow,
          QUEUE_RESOURCE_LIMITS.maxQueuedItemsPerFlow,
        );
  const maxQueuedRunsPerFlow = Math.min(
    maxQueuedRuns,
    configuredMaxQueuedRunsPerFlow,
  );

  return { maxQueuedRuns, maxQueuedRunsPerFlow };
}

function resolveLeaseTtlMs(config: Partial<RunQueueConfig> = {}): number {
  return typeof config.leaseTtlMs === "number" &&
    Number.isFinite(config.leaseTtlMs)
    ? Math.min(
        QUEUE_RESOURCE_LIMITS.maxLeaseTtlMs,
        Math.max(1, Math.floor(config.leaseTtlMs)),
      )
    : Math.min(
        DEFAULT_QUEUE_CONFIG.leaseTtlMs,
        QUEUE_RESOURCE_LIMITS.maxLeaseTtlMs,
      );
}

function validateBoundedText(
  value: unknown,
  field: string,
  maxUtf8Bytes: number,
): void {
  if (typeof value !== "string" || !value) {
    throw new Error(`${field} is required`);
  }
  const violation = findJsonResourceLimitViolation(
    value,
    {
      maxUtf8Bytes: maxUtf8Bytes + 2,
      maxStringUtf8Bytes: maxUtf8Bytes,
      maxDepth: 1,
      maxValues: 1,
    },
    field,
  );
  if (violation) throw new Error(violation);
}

function validateNow(now: number): void {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - QUEUE_RESOURCE_LIMITS.maxLeaseTtlMs
  ) {
    throw new Error(`Invalid now: ${String(now)}`);
  }
}

function assertQueueItemWithinLimits(item: RunQueueItem): void {
  const violation = findQueueItemResourceLimitViolation(item);
  if (violation) throw new Error(violation);
}

function rejectQueueItemLimitViolation(
  item: RunQueueItem,
  reject: (reason?: unknown) => void,
): boolean {
  const violation = findQueueItemResourceLimitViolation(item);
  if (!violation) return false;
  reject(new Error(violation));
  return true;
}

function validateEnqueueItem(item: RunQueueItem): void {
  validateBoundedText(item.id, "runId", QUEUE_RESOURCE_LIMITS.maxIdUtf8Bytes);
  validateBoundedText(
    item.flowId,
    "flowId",
    QUEUE_RESOURCE_LIMITS.maxIdUtf8Bytes,
  );
  if (
    !Number.isFinite(item.priority) ||
    Math.abs(item.priority) > QUEUE_RESOURCE_LIMITS.maxPriorityMagnitude
  ) {
    throw new Error(
      `priority must be a finite number between -${QUEUE_RESOURCE_LIMITS.maxPriorityMagnitude} and ${QUEUE_RESOURCE_LIMITS.maxPriorityMagnitude}`,
    );
  }
  if (
    !Number.isSafeInteger(item.maxAttempts) ||
    item.maxAttempts < 1 ||
    item.maxAttempts > QUEUE_RESOURCE_LIMITS.maxAttempts
  ) {
    throw new Error(
      `maxAttempts must be an integer between 1 and ${QUEUE_RESOURCE_LIMITS.maxAttempts}`,
    );
  }
  if (
    item.tabId !== undefined &&
    (!Number.isSafeInteger(item.tabId) || item.tabId < 0)
  ) {
    throw new Error("tabId must be a non-negative safe integer");
  }
  assertQueueItemWithinLimits(item);
}

async function countIndex(
  index: IDBIndex,
  query?: IDBValidKey | IDBKeyRange,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = index.count(query);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function countQueuedForFlow(
  statusIndex: IDBIndex,
  flowId: string,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let count = 0;
    const request = statusIndex.openCursor(IDBKeyRange.only("queued"));
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
    : "unknown";
}

function toBlockedSet<T extends string>(values?: readonly T[]): Set<T> {
  const blocked = new Set<T>();
  const count = Math.min(
    values?.length ?? 0,
    QUEUE_RESOURCE_LIMITS.maxClaimConstraints,
  );
  for (let index = 0; index < count; index += 1) {
    const value = values?.[index];
    if (value) blocked.add(value);
  }
  return blocked;
}

interface ResolvedClaimConstraints {
  blockedFlowIds: Set<string>;
  blockedProfiles: Set<RunQueueProfile>;
}

function resolveClaimConstraints(
  constraints: RunQueueClaimConstraints | undefined,
): ResolvedClaimConstraints {
  return {
    blockedFlowIds: toBlockedSet(constraints?.blockedFlowIds),
    blockedProfiles: toBlockedSet(constraints?.blockedProfiles),
  };
}

function isClaimableWithConstraints(
  item: RunQueueItem,
  constraints: ResolvedClaimConstraints,
): boolean {
  if (item.status !== "queued") {
    return false;
  }

  if (constraints.blockedFlowIds.has(item.flowId)) {
    return false;
  }

  if (constraints.blockedProfiles.has(normalizeProfile(item.profile))) {
    return false;
  }

  return true;
}

async function findClaimCandidate(
  store: IDBObjectStore,
  constraints: RunQueueClaimConstraints | undefined,
): Promise<RunQueueItem | null> {
  const statusIndex = store.index("status");
  const resolvedConstraints = resolveClaimConstraints(constraints);
  return new Promise<RunQueueItem | null>((resolve, reject) => {
    let candidate: RunQueueItem | null = null;
    let inspected = 0;
    const request = statusIndex.openCursor(IDBKeyRange.only("queued"));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || inspected >= QUEUE_RESOURCE_LIMITS.maxStoredItems) {
        resolve(candidate);
        return;
      }
      inspected += 1;
      const item = cursor.value as RunQueueItem;
      if (isClaimableWithConstraints(item, resolvedConstraints)) {
        const itemPriority = Number.isFinite(item.priority) ? item.priority : 0;
        const candidatePriority =
          candidate && Number.isFinite(candidate.priority)
            ? candidate.priority
            : 0;
        const itemCreatedAt = Number.isFinite(item.createdAt)
          ? item.createdAt
          : Number.MAX_SAFE_INTEGER;
        const candidateCreatedAt =
          candidate && Number.isFinite(candidate.createdAt)
            ? candidate.createdAt
            : Number.MAX_SAFE_INTEGER;
        if (
          !candidate ||
          itemPriority > candidatePriority ||
          (itemPriority === candidatePriority &&
            itemCreatedAt < candidateCreatedAt)
        ) {
          candidate = item;
        }
      }
      cursor.continue();
    };
  });
}

async function enforceQueuedBackpressure(
  store: IDBObjectStore,
  config: ResolvedQueueAdmissionConfig,
  input: EnqueueInput,
): Promise<void> {
  const totalCount = await new Promise<number>((resolve, reject) => {
    const request = store.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (totalCount >= QUEUE_RESOURCE_LIMITS.maxStoredItems) {
    throw new RunQueueBackpressureError({
      scope: "global",
      limit: QUEUE_RESOURCE_LIMITS.maxStoredItems,
      queuedCount: totalCount,
    });
  }

  const statusIndex = store.index("status");
  const queuedCount = await countIndex(statusIndex, IDBKeyRange.only("queued"));
  if (queuedCount >= config.maxQueuedRuns) {
    throw new RunQueueBackpressureError({
      scope: "global",
      limit: config.maxQueuedRuns,
      queuedCount,
    });
  }

  const queuedForFlow = await countQueuedForFlow(
    statusIndex,
    String(input.flowId),
  );
  if (queuedForFlow >= config.maxQueuedRunsPerFlow) {
    throw new RunQueueBackpressureError({
      scope: "flow",
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
export function createQueueStore(
  config: Partial<RunQueueConfig> = {},
): RunQueue {
  const admissionConfig = resolveQueueAdmissionConfig(config);
  const leaseTtlMs = resolveLeaseTtlMs(config);

  return {
    async enqueue(input: EnqueueInput): Promise<RunQueueItem> {
      const now = Date.now();
      const item: RunQueueItem = {
        ...input,
        priority: input.priority ?? 0,
        maxAttempts: input.maxAttempts ?? 1,
        status: "queued",
        createdAt: now,
        updatedAt: now,
        attempt: 0,
      };
      validateEnqueueItem(item);

      await withTransaction(RR_V3_STORES.QUEUE, "readwrite", async (stores) => {
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
      validateBoundedText(
        ownerId,
        "ownerId",
        QUEUE_RESOURCE_LIMITS.maxOwnerIdUtf8Bytes,
      );
      validateNow(now);

      return withTransaction(
        RR_V3_STORES.QUEUE,
        "readwrite",
        async (stores) => {
          const store = stores[RR_V3_STORES.QUEUE];
          const existing = await findClaimCandidate(store, constraints);
          if (!existing) {
            return null;
          }

          // The transaction is readwrite and IndexedDB serializes queue writes, so the
          // selected queued candidate can be promoted atomically inside this transaction.
          const updated: RunQueueItem = {
            ...existing,
            status: "running",
            updatedAt: now,
            attempt: existing.attempt + 1,
            lease: {
              ownerId,
              expiresAt: now + leaseTtlMs,
            },
          };
          assertQueueItemWithinLimits(updated);

          return new Promise<RunQueueItem>((resolve, reject) => {
            const request = store.put(updated);
            request.onsuccess = () => resolve(updated);
            request.onerror = () => reject(request.error);
          });
        },
      );
    },

    async releaseClaim(
      runId: RunId,
      ownerId: string,
      expectedAttempt: number,
      now: number,
    ): Promise<boolean> {
      validateBoundedText(runId, "runId", QUEUE_RESOURCE_LIMITS.maxIdUtf8Bytes);
      validateBoundedText(
        ownerId,
        "ownerId",
        QUEUE_RESOURCE_LIMITS.maxOwnerIdUtf8Bytes,
      );
      if (!Number.isSafeInteger(expectedAttempt) || expectedAttempt < 1) {
        throw new Error("expectedAttempt must be a positive safe integer");
      }
      validateNow(now);

      return withTransaction(
        RR_V3_STORES.QUEUE,
        "readwrite",
        async (stores) => {
          const store = stores[RR_V3_STORES.QUEUE];
          const existing = await new Promise<RunQueueItem | null>(
            (resolve, reject) => {
              const request = store.get(runId);
              request.onsuccess = () =>
                resolve((request.result as RunQueueItem) ?? null);
              request.onerror = () => reject(request.error);
            },
          );
          if (
            !existing ||
            existing.status !== "running" ||
            existing.attempt !== expectedAttempt ||
            existing.lease?.ownerId !== ownerId
          ) {
            return false;
          }

          const { lease: _releasedLease, ...itemWithoutLease } = existing;
          const updated: RunQueueItem = {
            ...itemWithoutLease,
            status: "queued",
            updatedAt: now,
            attempt: Math.max(0, existing.attempt - 1),
          };
          assertQueueItemWithinLimits(updated);

          await new Promise<void>((resolve, reject) => {
            const request = store.put(updated);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          });
          return true;
        },
      );
    },

    async heartbeat(ownerId: string, now: number): Promise<void> {
      // Validate inputs
      validateBoundedText(
        ownerId,
        "ownerId",
        QUEUE_RESOURCE_LIMITS.maxOwnerIdUtf8Bytes,
      );
      validateNow(now);

      await withTransaction(RR_V3_STORES.QUEUE, "readwrite", async (stores) => {
        const store = stores[RR_V3_STORES.QUEUE];
        const statusIndex = store.index("status");
        let inspectedItems = 0;

        /**
         * Renew leases for all items owned by ownerId in the given status.
         * Uses cursor iteration to update each item atomically.
         */
        const renewForStatus = async (
          status: QueueItemStatus,
        ): Promise<void> => {
          await new Promise<void>((resolve, reject) => {
            const request = statusIndex.openCursor(IDBKeyRange.only(status));
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const cursor = request.result;
              if (
                !cursor ||
                inspectedItems >= QUEUE_RESOURCE_LIMITS.maxStoredItems
              ) {
                resolve();
                return;
              }
              inspectedItems += 1;

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
                  expiresAt: now + leaseTtlMs,
                },
              };
              if (rejectQueueItemLimitViolation(updated, reject)) return;

              const updateRequest = cursor.update(updated);
              updateRequest.onerror = () => reject(updateRequest.error);
              updateRequest.onsuccess = () => cursor.continue();
            };
          });
        };

        // Renew both running and paused items for the owner.
        // Paused items also need renewal to prevent TTL expiration during debug/manual pause.
        await renewForStatus("running");
        await renewForStatus("paused");
      });
    },

    async reclaimExpiredLeases(now: number): Promise<RunId[]> {
      validateNow(now);

      return withTransaction(
        RR_V3_STORES.QUEUE,
        "readwrite",
        async (stores) => {
          const store = stores[RR_V3_STORES.QUEUE];
          const leaseIndex = store.index("lease_expiresAt");

          // Scan all items where lease.expiresAt < now (strictly less than)
          const expiredRange = IDBKeyRange.upperBound(now, true);

          return new Promise<RunId[]>((resolve, reject) => {
            const reclaimed: RunId[] = [];
            let inspectedItems = 0;
            const request = leaseIndex.openCursor(expiredRange);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const cursor = request.result;
              if (
                !cursor ||
                inspectedItems >= QUEUE_RESOURCE_LIMITS.maxStoredItems
              ) {
                resolve(reclaimed);
                return;
              }
              inspectedItems += 1;

              const item = cursor.value as RunQueueItem;
              const expiresAtKey = cursor.key;

              // Defensive: index key should be a finite number (Unix millis)
              if (
                typeof expiresAtKey !== "number" ||
                !Number.isFinite(expiresAtKey)
              ) {
                cursor.continue();
                return;
              }

              // The key range already guarantees expiresAtKey < now, but keep a guard
              // to be resilient to non-standard IndexedDB implementations.
              if (expiresAtKey >= now) {
                cursor.continue();
                return;
              }

              const isReclaimable =
                item.status === "running" || item.status === "paused";

              // Reclaim policy:
              // - running/paused + expired lease => move back to queued, drop lease
              // - any other status + expired lease => drop lease defensively (shouldn't happen)
              // Note: attempt is NOT reset on reclaim - preserves retry history.
              const { lease: _droppedLease, ...itemWithoutLease } = item;
              const updated: RunQueueItem = isReclaimable
                ? { ...itemWithoutLease, status: "queued", updatedAt: now }
                : { ...itemWithoutLease, updatedAt: now };
              if (rejectQueueItemLimitViolation(updated, reject)) return;

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
        },
      );
    },

    async recoverOrphanLeases(
      ownerId: string,
      now: number,
    ): Promise<{
      requeuedRunning: Array<{ runId: RunId; prevOwnerId?: string }>;
      adoptedPaused: Array<{ runId: RunId; prevOwnerId?: string }>;
    }> {
      // Validate inputs
      validateBoundedText(
        ownerId,
        "ownerId",
        QUEUE_RESOURCE_LIMITS.maxOwnerIdUtf8Bytes,
      );
      validateNow(now);

      return withTransaction(
        RR_V3_STORES.QUEUE,
        "readwrite",
        async (stores) => {
          const store = stores[RR_V3_STORES.QUEUE];
          const statusIndex = store.index("status");

          const requeuedRunning: Array<{ runId: RunId; prevOwnerId?: string }> =
            [];
          const adoptedPaused: Array<{ runId: RunId; prevOwnerId?: string }> =
            [];
          let inspectedItems = 0;

          /**
           * Scan and recycle orphan running items
           * @description
           * - Orphan definition: no lease or lease.ownerId !== currentOwnerId
           * - Recycling strategy: status -> queued，Clear lease, keep attempt
           */
          const recoverRunningItems = (): Promise<void> =>
            new Promise<void>((resolve, reject) => {
              const request = statusIndex.openCursor(
                IDBKeyRange.only("running"),
              );
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const cursor = request.result;
                if (
                  !cursor ||
                  inspectedItems >= QUEUE_RESOURCE_LIMITS.maxStoredItems
                ) {
                  resolve();
                  return;
                }
                inspectedItems += 1;

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
                  status: "queued",
                  updatedAt: now,
                };
                if (rejectQueueItemLimitViolation(updated, reject)) return;

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
              const request = statusIndex.openCursor(
                IDBKeyRange.only("paused"),
              );
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const cursor = request.result;
                if (
                  !cursor ||
                  inspectedItems >= QUEUE_RESOURCE_LIMITS.maxStoredItems
                ) {
                  resolve();
                  return;
                }
                inspectedItems += 1;

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
                    expiresAt: now + leaseTtlMs,
                  },
                };
                if (rejectQueueItemLimitViolation(updated, reject)) return;

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
        },
      );
    },

    async markRunning(
      runId: RunId,
      ownerId: string,
      now: number,
    ): Promise<void> {
      validateBoundedText(runId, "runId", QUEUE_RESOURCE_LIMITS.maxIdUtf8Bytes);
      validateBoundedText(
        ownerId,
        "ownerId",
        QUEUE_RESOURCE_LIMITS.maxOwnerIdUtf8Bytes,
      );
      validateNow(now);
      await withTransaction(RR_V3_STORES.QUEUE, "readwrite", async (stores) => {
        const store = stores[RR_V3_STORES.QUEUE];

        const existing = await new Promise<RunQueueItem | null>(
          (resolve, reject) => {
            const request = store.get(runId);
            request.onsuccess = () =>
              resolve((request.result as RunQueueItem) ?? null);
            request.onerror = () => reject(request.error);
          },
        );

        if (!existing) {
          throw new Error(`Queue item "${runId}" not found`);
        }

        // Attempt semantics:
        // - queued -> running: attempt + 1 (a new scheduling attempt)
        // - paused/running -> running: attempt unchanged (resume/idempotent)
        const nextAttempt =
          existing.status === "queued"
            ? existing.attempt + 1
            : existing.attempt;

        const updated: RunQueueItem = {
          ...existing,
          status: "running",
          updatedAt: now,
          attempt: nextAttempt,
          lease: {
            ownerId,
            expiresAt: now + leaseTtlMs,
          },
        };
        assertQueueItemWithinLimits(updated);

        return new Promise<void>((resolve, reject) => {
          const request = store.put(updated);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },

    async markPaused(
      runId: RunId,
      ownerId: string,
      now: number,
    ): Promise<void> {
      validateBoundedText(runId, "runId", QUEUE_RESOURCE_LIMITS.maxIdUtf8Bytes);
      validateBoundedText(
        ownerId,
        "ownerId",
        QUEUE_RESOURCE_LIMITS.maxOwnerIdUtf8Bytes,
      );
      validateNow(now);
      await withTransaction(RR_V3_STORES.QUEUE, "readwrite", async (stores) => {
        const store = stores[RR_V3_STORES.QUEUE];

        const existing = await new Promise<RunQueueItem | null>(
          (resolve, reject) => {
            const request = store.get(runId);
            request.onsuccess = () =>
              resolve((request.result as RunQueueItem) ?? null);
            request.onerror = () => reject(request.error);
          },
        );

        if (!existing) {
          throw new Error(`Queue item "${runId}" not found`);
        }

        const updated: RunQueueItem = {
          ...existing,
          status: "paused",
          updatedAt: now,
          lease: {
            ownerId,
            expiresAt: now + leaseTtlMs,
          },
        };
        assertQueueItemWithinLimits(updated);

        return new Promise<void>((resolve, reject) => {
          const request = store.put(updated);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      });
    },

    async markDone(runId: RunId, now: number): Promise<void> {
      validateBoundedText(runId, "runId", QUEUE_RESOURCE_LIMITS.maxIdUtf8Bytes);
      validateNow(now);
      await withTransaction(RR_V3_STORES.QUEUE, "readwrite", async (stores) => {
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
      validateBoundedText(runId, "runId", QUEUE_RESOURCE_LIMITS.maxIdUtf8Bytes);
      return withTransaction(RR_V3_STORES.QUEUE, "readonly", async (stores) => {
        const store = stores[RR_V3_STORES.QUEUE];
        return new Promise<RunQueueItem | null>((resolve, reject) => {
          const request = store.get(runId);
          request.onsuccess = () =>
            resolve((request.result as RunQueueItem) ?? null);
          request.onerror = () => reject(request.error);
        });
      });
    },

    async list(status?: QueueItemStatus): Promise<RunQueueItem[]> {
      if (
        status !== undefined &&
        status !== "queued" &&
        status !== "running" &&
        status !== "paused"
      ) {
        throw new Error("status must be one of: queued, running, paused");
      }
      return withTransaction(RR_V3_STORES.QUEUE, "readonly", async (stores) => {
        const store = stores[RR_V3_STORES.QUEUE];
        return new Promise<RunQueueItem[]>((resolve, reject) => {
          const items: RunQueueItem[] = [];
          let aggregateBytes = 2;
          const request = status
            ? store.index("status").openCursor(IDBKeyRange.only(status))
            : store.openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (
              !cursor ||
              items.length >= QUEUE_RESOURCE_LIMITS.maxStoredItems
            ) {
              resolve(items);
              return;
            }
            const item = cursor.value as RunQueueItem;
            const itemBytes = jsonUtf8ByteLength(
              item,
              QUEUE_RESOURCE_LIMITS.maxListUtf8Bytes,
            );
            const addedBytes = itemBytes + (items.length > 0 ? 1 : 0);
            if (
              addedBytes >
              QUEUE_RESOURCE_LIMITS.maxListUtf8Bytes - aggregateBytes
            ) {
              resolve(items);
              return;
            }
            aggregateBytes += addedBytes;
            items.push(item);
            cursor.continue();
          };
          request.onerror = () => reject(request.error);
        });
      });
    },
  };
}
