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
 * - Acquire/release keepalive to prevent MV3 SW termination (P3-05)
 *
 * Non-responsibilities:
 * - Run execution details (Flow loading, tab allocation, etc.) are injected via RunExecutor
 */

import type { UnixMillis } from '../../domain/json';
import type { RunId } from '../../domain/ids';
import type { LeaseManager } from './leasing';
import type { RunQueue, RunQueueConfig, RunQueueItem } from './queue';
import type { KeepaliveController } from '../keepalive/offscreen-keepalive';

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
  queue: Pick<RunQueue, 'claimNext' | 'markDone'>;
  leaseManager: Pick<LeaseManager, 'startHeartbeat' | 'stopHeartbeat' | 'reclaimExpiredLeases'>;
  keepalive: Pick<KeepaliveController, 'acquire'>;
  config: RunQueueConfig;
  ownerId: string;
  execute: RunExecutor;
  now?: () => UnixMillis;
  tuning?: RunSchedulerTuning;
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

/**
 * Scheduler state for inspection
 */
export interface RunSchedulerState {
  started: boolean;
  ownerId: string;
  maxParallelRuns: number;
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

// ==================== Helpers ====================

function clampNonNegativeInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(0, n);
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
    throw new Error('ownerId is required');
  }

  const now = deps.now ?? (() => Date.now());
  const maxParallelRuns = clampNonNegativeInt(deps.config.maxParallelRuns, 0);
  const pollIntervalMs = clampNonNegativeInt(
    deps.tuning?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
  );
  const reclaimIntervalMs = clampNonNegativeInt(
    deps.tuning?.reclaimIntervalMs ?? defaultReclaimIntervalMs(deps.config.leaseTtlMs),
    defaultReclaimIntervalMs(deps.config.leaseTtlMs),
  );

  let started = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let releaseKeepalive: (() => void) | null = null;

  const activeRunIds = new Set<RunId>();

  // Coalesced re-entrancy control for tick()
  let pendingKick = false;
  let pumpPromise: Promise<void> | null = null;

  let lastReclaimAt: UnixMillis | null = null;

  /**
   * Single scheduling tick:
   * 1. Reclaim expired leases (if interval elapsed)
   * 2. Fill available slots up to maxParallelRuns
   */
  async function tick(): Promise<void> {
    const t = now();

    // Best-effort lease reclaim (disabled when reclaimIntervalMs === 0)
    if (reclaimIntervalMs > 0) {
      const shouldReclaim = lastReclaimAt === null || t - lastReclaimAt >= reclaimIntervalMs;
      if (shouldReclaim) {
        lastReclaimAt = t;
        try {
          await deps.leaseManager.reclaimExpiredLeases(t);
        } catch (e) {
          logger.warn('[RunScheduler] reclaimExpiredLeases failed:', e);
        }
      }
    }

    // Fill available slots up to maxParallelRuns
    //
    // Note: `stop()` can be called while an async claim is in-flight. Guard the loop
    // with `started` to prevent claiming additional items after stop is requested.
    while (started && activeRunIds.size < maxParallelRuns) {
      let claimed: RunQueueItem | null = null;
      try {
        claimed = await deps.queue.claimNext(deps.ownerId, t);
      } catch (e) {
        logger.error('[RunScheduler] claimNext failed:', e);
        return;
      }

      if (!claimed) return;

      // Guard against double-launch within the same scheduler instance
      if (activeRunIds.has(claimed.id)) {
        logger.error(
          `[RunScheduler] Invariant violation: run "${claimed.id}" was claimed twice in the same scheduler instance`,
        );
        // Best-effort cleanup: avoid a stuck running entry
        void deps.queue
          .markDone(claimed.id, now())
          .catch((err) =>
            logger.warn('[RunScheduler] markDone after duplicate claim failed:', err),
          );
        continue;
      }

      activeRunIds.add(claimed.id);

      // Capture claimed item for the closure
      const claimedItem = claimed;

      const runPromise = Promise.resolve()
        .then(() => deps.execute(claimedItem))
        .catch((e) => {
          // If execution failed unexpectedly, log but still cleanup
          logger.error(`[RunScheduler] execute failed for run "${claimedItem.id}":`, e);
        })
        .finally(async () => {
          activeRunIds.delete(claimedItem.id);
          try {
            await deps.queue.markDone(claimedItem.id, now());
          } catch (e) {
            logger.warn(`[RunScheduler] markDone failed for run "${claimedItem.id}":`, e);
          }

          // Backfill immediately when a slot frees up
          if (started) {
            void kick();
          }
        });

      // Ensure no floating promise warnings
      void runPromise;
    }
  }

  /**
   * Pump loop: keeps running while pendingKick is set
   */
  async function pump(): Promise<void> {
    try {
      while (started && pendingKick) {
        pendingKick = false;
        try {
          await tick();
        } catch (e) {
          logger.error('[RunScheduler] tick failed:', e);
        }
      }
    } finally {
      pumpPromise = null;
    }
  }

  function start(): void {
    if (started) return;
    started = true;

    // Acquire keepalive to prevent MV3 SW termination
    try {
      releaseKeepalive = deps.keepalive.acquire('scheduler');
    } catch (e) {
      logger.warn('[RunScheduler] keepalive.acquire failed:', e);
      releaseKeepalive = null;
    }

    try {
      deps.leaseManager.startHeartbeat(deps.ownerId);
    } catch (e) {
      logger.warn('[RunScheduler] startHeartbeat failed:', e);
    }

    if (pollIntervalMs > 0) {
      pollTimer = setInterval(() => {
        void kick();
      }, pollIntervalMs);
    }

    void kick();
  }

  function stop(): void {
    if (!started) return;

    if (activeRunIds.size > 0) {
      logger.warn(
        `[RunScheduler] stop() called with ${activeRunIds.size} active runs; heartbeats will stop and leases may expire/reclaim concurrently`,
      );
    }

    started = false;

    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    try {
      deps.leaseManager.stopHeartbeat(deps.ownerId);
    } catch (e) {
      logger.warn('[RunScheduler] stopHeartbeat failed:', e);
    }

    // Release keepalive
    if (releaseKeepalive) {
      try {
        releaseKeepalive();
      } catch (e) {
        logger.warn('[RunScheduler] keepalive release failed:', e);
      }
      releaseKeepalive = null;
    }
  }

  function kick(): Promise<void> {
    if (!started) return Promise.resolve();

    pendingKick = true;
    if (!pumpPromise) {
      pumpPromise = pump();
    }
    return pumpPromise;
  }

  function getState(): RunSchedulerState {
    return {
      started,
      ownerId: deps.ownerId,
      maxParallelRuns,
      activeRunIds: Array.from(activeRunIds),
    };
  }

  function dispose(): void {
    stop();
    activeRunIds.clear();
  }

  return { start, stop, kick, getState, dispose };
}
