/**
 * @fileoverview RunQueue scheduler (maxParallelRuns)
 * @description
 * Orchestrates atomic claims from RunQueue and launches execution with an injected executor.
 *
 * Responsibilities:
 * - Enforce maxParallelRuns (per scheduler instance)
 * - Backfill available slots when runs complete
 * - Periodically reclaim expired leases (best-effort)
 * - Start/stop lease heartbeats via LeaseManager
 * - Acquire/release keepalive only while scheduler work is in flight (P3-05)
 *
 * Non-responsibilities:
 * - Run execution details (Flow loading, tab allocation, etc.) are injected via RunExecutor
 */

import type { UnixMillis } from "../../domain/json";
import type { RunId } from "../../domain/ids";
import type { LeaseManager } from "./leasing";
import type {
  RunQueue,
  RunQueueClaimConstraints,
  RunQueueConfig,
  RunQueueItem,
  RunQueueProfile,
} from "./queue";
import type { KeepaliveController } from "../keepalive/offscreen-keepalive";

// ==================== Types ====================

/**
 * Run executor contract:
 * - Resolve when the run reaches a terminal state (succeeded/failed/canceled).
 * - Throw/reject only for unexpected infrastructure errors.
 */
export type RunExecutor = (item: RunQueueItem) => Promise<void>;

/**
 * Scheduler tuning parameters
 */
export interface RunSchedulerTuning {
  /**
   * Poll interval for queue consumption fallback.
   * Set to 0 to disable polling (kick-only).
   */
  pollIntervalMs?: number;

  /**
   * Minimum interval between lease reclaim scans.
   * Set to 0 to disable periodic reclaim (not recommended in production).
   */
  reclaimIntervalMs?: number;
}

/**
 * Scheduler dependencies (dependency injection)
 */
export interface RunSchedulerDeps {
  queue: Pick<RunQueue, "claimNext" | "markDone"> &
    Partial<Pick<RunQueue, "releaseClaim">>;
  leaseManager: Pick<
    LeaseManager,
    "startHeartbeat" | "stopHeartbeat" | "reclaimExpiredLeases"
  >;
  keepalive: Pick<KeepaliveController, "acquire">;
  config: RunQueueConfig;
  ownerId: string;
  execute: RunExecutor;
  now?: () => UnixMillis;
  tuning?: RunSchedulerTuning;
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

/**
 * Scheduler state for inspection
 */
export interface RunSchedulerState {
  started: boolean;
  ownerId: string;
  maxParallelRuns: number;
  maxParallelRunsPerFlow?: number;
  maxParallelRunsPerProfile?: Partial<Record<RunQueueProfile, number>>;
  activeRunIds: RunId[];
}

/**
 * Scheduler interface
 */
export interface RunScheduler {
  /** Start the scheduler */
  start(): void;
  /** Stop the scheduler */
  stop(): void;
  /**
   * Trigger a scheduling pass.
   * Safe to call frequently; re-entrancy is coalesced.
   */
  kick(): Promise<void>;
  /** Get current state */
  getState(): RunSchedulerState;
  /** Dispose the scheduler */
  dispose(): void;
}

// ==================== Constants ====================

const DEFAULT_POLL_INTERVAL_MS = 500;
const RUN_QUEUE_PROFILES: readonly RunQueueProfile[] = [
  "safe",
  "idempotent",
  "dangerous",
  "unknown",
];

// ==================== Helpers ====================

function clampNonNegativeInt(value: unknown, fallback: number): number {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : fallback;
  return Math.max(0, n);
}

function normalizeOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeProfileLimits(
  value: RunQueueConfig["maxParallelRunsPerProfile"],
): Partial<Record<RunQueueProfile, number>> | undefined {
  if (!value) {
    return undefined;
  }

  const limits: Partial<Record<RunQueueProfile, number>> = {};
  for (const profile of RUN_QUEUE_PROFILES) {
    const limit = normalizeOptionalPositiveInt(value[profile]);
    if (limit !== undefined) {
      limits[profile] = limit;
    }
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function getQueueProfile(item: RunQueueItem): RunQueueProfile {
  return RUN_QUEUE_PROFILES.includes(item.profile as RunQueueProfile)
    ? (item.profile as RunQueueProfile)
    : "unknown";
}

function buildClaimConstraints(
  activeRunItems: Map<RunId, RunQueueItem>,
  maxParallelRunsPerFlow: number | undefined,
  maxParallelRunsPerProfile:
    | Partial<Record<RunQueueProfile, number>>
    | undefined,
): RunQueueClaimConstraints | undefined {
  const blockedFlowIds = new Set<RunQueueItem["flowId"]>();
  const blockedProfiles = new Set<RunQueueProfile>();

  if (maxParallelRunsPerFlow !== undefined) {
    const flowCounts = new Map<RunQueueItem["flowId"], number>();
    for (const item of activeRunItems.values()) {
      const count = (flowCounts.get(item.flowId) ?? 0) + 1;
      flowCounts.set(item.flowId, count);
      if (count >= maxParallelRunsPerFlow) {
        blockedFlowIds.add(item.flowId);
      }
    }
  }

  if (maxParallelRunsPerProfile) {
    const profileCounts = new Map<RunQueueProfile, number>();
    for (const item of activeRunItems.values()) {
      const profile = getQueueProfile(item);
      const count = (profileCounts.get(profile) ?? 0) + 1;
      profileCounts.set(profile, count);
    }

    for (const profile of RUN_QUEUE_PROFILES) {
      const limit = maxParallelRunsPerProfile[profile];
      if (limit !== undefined && (profileCounts.get(profile) ?? 0) >= limit) {
        blockedProfiles.add(profile);
      }
    }
  }

  if (blockedFlowIds.size === 0 && blockedProfiles.size === 0) {
    return undefined;
  }

  return {
    ...(blockedFlowIds.size
      ? { blockedFlowIds: Array.from(blockedFlowIds) }
      : {}),
    ...(blockedProfiles.size
      ? { blockedProfiles: Array.from(blockedProfiles) }
      : {}),
  };
}

function defaultReclaimIntervalMs(leaseTtlMs: number): number {
  const ttl = clampNonNegativeInt(leaseTtlMs, 0);
  // Reclaim at most every ~TTL/2, but never less than 1s to avoid tight loops.
  return Math.max(1_000, Math.floor(ttl / 2));
}

// ==================== Factory ====================

/**
 * Create a RunScheduler
 *
 * Scheduling model:
 * - Concurrency is enforced by an in-memory set of active runIds.
 * - Ordering is delegated to RunQueue.claimNext() (priority DESC, createdAt ASC).
 *
 * MV3 Service Worker may be suspended/restarted, so we use a "kick + polling" strategy:
 * - kick: Immediate scheduling trigger on enqueue/completion (low latency)
 * - polling: Fallback to ensure queue is consumed even if caller forgets to kick
 */
export function createRunScheduler(deps: RunSchedulerDeps): RunScheduler {
  const logger = deps.logger ?? console;

  if (!deps.ownerId) {
    throw new Error("ownerId is required");
  }

  const now = deps.now ?? (() => Date.now());
  const maxParallelRuns = clampNonNegativeInt(deps.config.maxParallelRuns, 0);
  const maxParallelRunsPerFlow = normalizeOptionalPositiveInt(
    deps.config.maxParallelRunsPerFlow,
  );
  const maxParallelRunsPerProfile = normalizeProfileLimits(
    deps.config.maxParallelRunsPerProfile,
  );
  const pollIntervalMs = clampNonNegativeInt(
    deps.tuning?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
  );
  const reclaimIntervalMs = clampNonNegativeInt(
    deps.tuning?.reclaimIntervalMs ??
      defaultReclaimIntervalMs(deps.config.leaseTtlMs),
    defaultReclaimIntervalMs(deps.config.leaseTtlMs),
  );

  let started = false;
  let lifecycleGeneration = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let releaseKeepalive: (() => void) | null = null;

  const activeRunItems = new Map<RunId, RunQueueItem>();

  // Coalesced re-entrancy control for tick()
  let pendingKick = false;
  let pumpPromise: Promise<void> | null = null;

  let lastReclaimAt: UnixMillis | null = null;

  function acquireKeepaliveForWork(): void {
    if (releaseKeepalive) return;

    try {
      releaseKeepalive = deps.keepalive.acquire("scheduler");
    } catch (e) {
      logger.warn("[RunScheduler] keepalive.acquire failed:", e);
      releaseKeepalive = null;
    }
  }

  function hasKeepaliveWork(): boolean {
    return pendingKick || pumpPromise !== null || activeRunItems.size > 0;
  }

  function releaseKeepaliveIfIdle(): void {
    if (!releaseKeepalive || hasKeepaliveWork()) return;

    const release = releaseKeepalive;
    releaseKeepalive = null;
    try {
      release();
    } catch (e) {
      logger.warn("[RunScheduler] keepalive release failed:", e);
    }
  }

  /**
   * Single scheduling tick:
   * 1. Reclaim expired leases (if interval elapsed)
   * 2. Fill available slots up to maxParallelRuns
   */
  async function tick(generation: number): Promise<void> {
    const t = now();

    // Best-effort lease reclaim (disabled when reclaimIntervalMs === 0)
    if (reclaimIntervalMs > 0) {
      const shouldReclaim =
        lastReclaimAt === null || t - lastReclaimAt >= reclaimIntervalMs;
      if (shouldReclaim) {
        lastReclaimAt = t;
        try {
          await deps.leaseManager.reclaimExpiredLeases(t);
        } catch (e) {
          logger.warn("[RunScheduler] reclaimExpiredLeases failed:", e);
        }
      }
    }

    // Fill available slots up to maxParallelRuns
    //
    // Note: `stop()` can be called while an async claim is in-flight. Guard the loop
    // with `started` to prevent claiming additional items after stop is requested.
    while (
      started &&
      generation === lifecycleGeneration &&
      activeRunItems.size < maxParallelRuns
    ) {
      let claimed: RunQueueItem | null = null;
      try {
        claimed = await deps.queue.claimNext(
          deps.ownerId,
          t,
          buildClaimConstraints(
            activeRunItems,
            maxParallelRunsPerFlow,
            maxParallelRunsPerProfile,
          ),
        );
      } catch (e) {
        logger.error("[RunScheduler] claimNext failed:", e);
        return;
      }

      if (!claimed) return;

      // stop()/restart may have happened while claimNext() was awaiting storage.
      // Do not launch work under a stale scheduler lifecycle. Leave the
      // durable running lease intact so normal lease recovery can requeue it;
      // markDone() here would incorrectly discard an unexecuted run.
      if (!started || generation !== lifecycleGeneration) {
        logger.debug(
          `[RunScheduler] Releasing stale claim "${claimed.id}" after lifecycle change`,
        );
        if (deps.queue.releaseClaim && claimed.lease) {
          try {
            const released = await deps.queue.releaseClaim(
              claimed.id,
              deps.ownerId,
              claimed.attempt,
              now(),
            );
            if (!released) {
              logger.warn(
                `[RunScheduler] Stale claim "${claimed.id}" no longer matched its original lease`,
              );
            }
          } catch (e) {
            logger.error(
              `[RunScheduler] Failed to release stale claim "${claimed.id}":`,
              e,
            );
          }
        } else {
          logger.error(
            `[RunScheduler] Cannot release stale claim "${claimed.id}" because its lease release API is unavailable`,
          );
        }
        return;
      }

      // Speculative polling does not need to wake/create an offscreen
      // keepalive. Once a durable queued item is actually claimed, retain the
      // worker through execution and queue finalization.
      acquireKeepaliveForWork();

      // Guard against double-launch within the same scheduler instance
      if (activeRunItems.has(claimed.id)) {
        logger.error(
          `[RunScheduler] Invariant violation: run "${claimed.id}" was claimed twice in the same scheduler instance`,
        );
        // Best-effort cleanup: avoid a stuck running entry
        void deps.queue
          .markDone(claimed.id, now())
          .catch((err) =>
            logger.warn(
              "[RunScheduler] markDone after duplicate claim failed:",
              err,
            ),
          );
        continue;
      }

      activeRunItems.set(claimed.id, claimed);

      // Capture claimed item for the closure
      const claimedItem = claimed;

      const runPromise = Promise.resolve()
        .then(() => deps.execute(claimedItem))
        .catch((e) => {
          // If execution failed unexpectedly, log but still cleanup
          logger.error(
            `[RunScheduler] execute failed for run "${claimedItem.id}":`,
            e,
          );
        })
        .finally(async () => {
          try {
            await deps.queue.markDone(claimedItem.id, now());
          } catch (e) {
            logger.warn(
              `[RunScheduler] markDone failed for run "${claimedItem.id}":`,
              e,
            );
          }
          activeRunItems.delete(claimedItem.id);

          // Backfill immediately when a slot frees up
          if (started) {
            void kick();
          } else {
            releaseKeepaliveIfIdle();
          }
        });

      // Ensure no floating promise warnings
      void runPromise;
    }
  }

  /**
   * Pump loop: keeps running while pendingKick is set
   */
  async function pump(generation: number): Promise<void> {
    try {
      while (started && generation === lifecycleGeneration && pendingKick) {
        pendingKick = false;
        try {
          await tick(generation);
        } catch (e) {
          logger.error("[RunScheduler] tick failed:", e);
        }
      }
    } finally {
      pumpPromise = null;
      releaseKeepaliveIfIdle();

      // A stop/start transition can supersede an awaiting pump. Preserve a
      // kick queued for the new lifecycle instead of letting the stale pump
      // consume it.
      if (started && pendingKick) {
        void requestPump(false);
      }
    }
  }

  function start(): void {
    if (started) return;
    started = true;
    lifecycleGeneration += 1;

    try {
      deps.leaseManager.startHeartbeat(deps.ownerId);
    } catch (e) {
      logger.warn("[RunScheduler] startHeartbeat failed:", e);
    }

    if (pollIntervalMs > 0) {
      pollTimer = setInterval(() => {
        void requestPump(false);
      }, pollIntervalMs);
    }

    // Startup is a speculative recovery scan. It acquires a claim only if an
    // item is found; explicit enqueue kicks retain the pump immediately.
    void requestPump(false);
  }

  function stop(): void {
    if (!started) return;

    if (activeRunItems.size > 0) {
      logger.warn(
        `[RunScheduler] stop() called with ${activeRunItems.size} active runs; heartbeats will stop and leases may expire/reclaim concurrently`,
      );
    }

    started = false;
    lifecycleGeneration += 1;
    pendingKick = false;

    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    try {
      deps.leaseManager.stopHeartbeat(deps.ownerId);
    } catch (e) {
      logger.warn("[RunScheduler] stopHeartbeat failed:", e);
    }

    releaseKeepaliveIfIdle();
  }

  function requestPump(holdKeepalive: boolean): Promise<void> {
    if (!started) return Promise.resolve();

    pendingKick = true;
    if (holdKeepalive) {
      acquireKeepaliveForWork();
    }
    if (!pumpPromise) {
      pumpPromise = pump(lifecycleGeneration);
    }
    return pumpPromise;
  }

  function kick(): Promise<void> {
    return requestPump(true);
  }

  function getState(): RunSchedulerState {
    return {
      started,
      ownerId: deps.ownerId,
      maxParallelRuns,
      ...(maxParallelRunsPerFlow !== undefined
        ? { maxParallelRunsPerFlow }
        : {}),
      ...(maxParallelRunsPerProfile ? { maxParallelRunsPerProfile } : {}),
      activeRunIds: Array.from(activeRunItems.keys()),
    };
  }

  function dispose(): void {
    stop();
  }

  return { start, stop, kick, getState, dispose };
}
