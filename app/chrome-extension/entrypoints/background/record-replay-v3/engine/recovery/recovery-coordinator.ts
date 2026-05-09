/**
 * @fileoverview Crash Recovery Coordinator (P3-06)
 * @description
 * MV3 Service Worker May be terminated at any time. This coordinator coordinates queue status and Run records when SW starts,
 * Enables interrupted Run execution to be resumed.
 *
 * Recovery strategy:
 * - Orphan running items: recycled as queued, waiting for rescheduling (rerunning from the beginning)
 * - Orphan paused item: take over the lease and keep the paused state
 * - Queue residue of finalized Run: cleanup
 *
 * Calling time:
 * - Must be called before scheduler.start()
 * - Usually called once when SW starts
 */

import type { UnixMillis } from '../../domain/json';
import type { RunId } from '../../domain/ids';
import { isTerminalStatus, type RunStatus } from '../../domain/events';
import type { RunRecordV3 } from '../../domain/events';
import { RR_ERROR_CODES, createRRError } from '../../domain/errors';
import type { StoragePort } from '../storage/storage-port';
import type { EventsBus } from '../transport/events-bus';

// ==================== Types ====================

/**
 * Recovery results
 */
export interface RecoveryResult {
  /** The running Run ID that was recycled as queued */
  requeuedRunning: RunId[];
  /** The paused Run ID that was taken over */
  adoptedPaused: RunId[];
  /** Cleaned finalized Run ID */
  cleanedTerminal: RunId[];
  /** Active runs that could not be recovered and were marked terminal */
  abortedByRestart: RunId[];
}

/**
 * Restoring coordinator dependencies
 */
export interface RecoveryCoordinatorDeps {
  /** storage layer */
  storage: StoragePort;
  /** event bus */
  events: EventsBus;
  /** The ownerId of the current Service Worker */
  ownerId: string;
  /** time source */
  now: () => UnixMillis;
  /** Logger */
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

// ==================== Main Function ====================

/**
 * Perform crash recovery
 * @description
 * Called when SW starts to coordinate queue status and Run records.
 *
 * Execution order:
 * 1. Pre-cleaning: Check all items in the queue and clean up the remaining ones that have finalized or have no corresponding RunRecord
 * 2. Restoring orphan leases: recycling running, taking over paused
 * 3. Synchronize RunRecord state: Ensure RunRecord is consistent with queue state
 * 4. Send recovery events: send run.recovered event for requeued running items
 */
export async function recoverFromCrash(deps: RecoveryCoordinatorDeps): Promise<RecoveryResult> {
  const logger = deps.logger ?? console;

  if (!deps.ownerId) {
    throw new Error('ownerId is required');
  }

  const now = deps.now();

  // Design reason: The recovery process must "clean up first and then take over/recycle", otherwise the finalized Run may be requeued for execution.
  const cleanedTerminalSet = new Set<RunId>();
  const abortedByRestartSet = new Set<RunId>();

  const abortByRestart = async (
    run: RunRecordV3,
    reason: 'attempts_exhausted' | 'missing_queue_item',
  ): Promise<void> => {
    const tookMs =
      typeof run.startedAt === 'number' ? Math.max(0, now - run.startedAt) : undefined;
    const error = createRRError(
      RR_ERROR_CODES.ABORTED_BY_RESTART,
      `Run could not be recovered after service worker restart: ${reason}`,
      {
        retryable: false,
        data: {
          reason: 'aborted_by_restart',
          recoveryReason: reason,
        },
      },
    );
    try {
      await deps.storage.queue.markDone(run.id, now);
    } catch (e) {
      logger.warn('[Recovery] markDone for aborted run failed:', run.id, e);
    }
    await deps.storage.runs.patch(run.id, {
      status: 'failed',
      finishedAt: now,
      ...(tookMs !== undefined ? { tookMs } : {}),
      error,
      updatedAt: now,
    });
    try {
      await deps.events.append({
        runId: run.id,
        type: 'run.failed',
        error,
        ...(run.currentNodeId ? { nodeId: run.currentNodeId } : {}),
        ts: now,
      });
    } catch (eventErr) {
      logger.warn('[Recovery] Failed to emit aborted_by_restart event:', run.id, eventErr);
    }
    abortedByRestartSet.add(run.id);
    logger.info(`[Recovery] Aborted unrecoverable run after restart: ${run.id} (${reason})`);
  };

  // ==================== Step 1: Pre-cleaning ====================
  // Check all items in the queue and clean up the remaining ones that have finalized or have no corresponding RunRecord
  try {
    const items = await deps.storage.queue.list();
    for (const item of items) {
      const runId = item.id;
      const run = await deps.storage.runs.get(runId);

      // Defensive Cleanup: Queue items without RunRecord cannot be executed
      if (!run) {
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
          logger.debug(`[Recovery] Cleaned orphan queue item without RunRecord: ${runId}`);
        } catch (e) {
          logger.warn('[Recovery] markDone for missing RunRecord failed:', runId, e);
        }
        continue;
      }

      // Clean up the finalized Run (SW may crash after the runner is completed and before the scheduler markDone)
      if (isTerminalStatus(run.status)) {
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
          logger.debug(`[Recovery] Cleaned terminal queue item: ${runId} (status=${run.status})`);
        } catch (e) {
          logger.warn('[Recovery] markDone for terminal run failed:', runId, e);
        }
      }
    }
  } catch (e) {
    logger.warn('[Recovery] Pre-clean failed:', e);
  }

  // ==================== Step 2: Restore orphan lease ====================
  // Best-effort：Even failure should not prevent startup
  let requeuedRunning: Array<{ runId: RunId; prevOwnerId?: string }> = [];
  let adoptedPaused: Array<{ runId: RunId; prevOwnerId?: string }> = [];
  try {
    const result = await deps.storage.queue.recoverOrphanLeases(deps.ownerId, now);
    requeuedRunning = result.requeuedRunning;
    adoptedPaused = result.adoptedPaused;
  } catch (e) {
    logger.error('[Recovery] recoverOrphanLeases failed:', e);
    // Continue execution without blocking startup
  }

  // ==================== Step 3: Synchronize RunRecord status ====================
  const requeuedRunningIds: RunId[] = [];
  for (const entry of requeuedRunning) {
    const runId = entry.runId;

    // Skip items cleaned in Step 1
    if (cleanedTerminalSet.has(runId)) {
      continue;
    }

    try {
      const run = await deps.storage.runs.get(runId);
      if (!run) {
        // RunRecord Does not exist, clear queue item (defensive)
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
        } catch (markDoneErr) {
          logger.warn(
            '[Recovery] markDone for missing RunRecord in Step3 failed:',
            runId,
            markDoneErr,
          );
        }
        continue;
      }

      // Skip finalized Runs (may be updated by other logic during recovery)
      // At the same time, clean up the queue items to prevent residual
      if (isTerminalStatus(run.status)) {
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
          logger.debug(
            `[Recovery] Cleaned terminal queue item in Step3: ${runId} (status=${run.status})`,
          );
        } catch (markDoneErr) {
          logger.warn('[Recovery] markDone for terminal run in Step3 failed:', runId, markDoneErr);
        }
        continue;
      }

      const queueItem = await deps.storage.queue.get(runId);
      const runAttempt = Math.max(0, run.attempt ?? 0);
      const runMaxAttempts = Math.max(1, run.maxAttempts ?? 1);
      const queueAttempt = Math.max(0, queueItem?.attempt ?? runAttempt);
      const queueMaxAttempts = Math.max(1, queueItem?.maxAttempts ?? runMaxAttempts);
      if (runAttempt >= runMaxAttempts || queueAttempt >= queueMaxAttempts) {
        await abortByRestart(run, 'attempts_exhausted');
        continue;
      }

      // Update the RunRecord status to queued
      await deps.storage.runs.patch(runId, { status: 'queued', updatedAt: now });
      requeuedRunningIds.push(runId);

      // Send recovery events (best-effort, failure does not affect the recovery process)
      try {
        const fromStatus: 'running' | 'paused' = run.status === 'paused' ? 'paused' : 'running';
        await deps.events.append({
          runId,
          type: 'run.recovered',
          reason: 'sw_restart',
          fromStatus,
          toStatus: 'queued',
          prevOwnerId: entry.prevOwnerId,
          ts: now,
        });
        logger.info(`[Recovery] Requeued orphan running run: ${runId} (from=${fromStatus})`);
      } catch (eventErr) {
        logger.warn('[Recovery] Failed to emit run.recovered event:', runId, eventErr);
        // Continue execution without affecting the recovery process
      }
    } catch (e) {
      logger.warn('[Recovery] Reconcile requeued running failed:', runId, e);
    }
  }

  // ==================== Step 4: Synchronous adopted paused RunRecord ====================
  const adoptedPausedIds: RunId[] = [];
  for (const entry of adoptedPaused) {
    const runId = entry.runId;
    adoptedPausedIds.push(runId);

    // Skip items cleaned in Step 1
    if (cleanedTerminalSet.has(runId)) {
      continue;
    }

    try {
      const run = await deps.storage.runs.get(runId);
      if (!run) {
        // RunRecord Does not exist, clear queue item (defensive)
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
        } catch (markDoneErr) {
          logger.warn(
            '[Recovery] markDone for missing RunRecord in Step4 failed:',
            runId,
            markDoneErr,
          );
        }
        continue;
      }

      // Skip the finalized Run and clear the queue items
      if (isTerminalStatus(run.status)) {
        try {
          await deps.storage.queue.markDone(runId, now);
          cleanedTerminalSet.add(runId);
          logger.debug(
            `[Recovery] Cleaned terminal queue item in Step4: ${runId} (status=${run.status})`,
          );
        } catch (markDoneErr) {
          logger.warn('[Recovery] markDone for terminal run in Step4 failed:', runId, markDoneErr);
        }
        continue;
      }

      // If the RunRecord status is not paused, update synchronously
      if (run.status !== 'paused') {
        await deps.storage.runs.patch(runId, { status: 'paused' as RunStatus, updatedAt: now });
      }

      logger.info(`[Recovery] Adopted orphan paused run: ${runId}`);
    } catch (e) {
      logger.warn('[Recovery] Reconcile adopted paused failed:', runId, e);
    }
  }

  // ==================== Step 5: Terminalize active RunRecords missing queue ownership ====================
  try {
    const runs = await deps.storage.runs.list();
    for (const run of runs) {
      if (isTerminalStatus(run.status)) {
        continue;
      }
      if (abortedByRestartSet.has(run.id)) {
        continue;
      }
      const item = await deps.storage.queue.get(run.id);
      if (!item) {
        await abortByRestart(run, 'missing_queue_item');
      }
    }
  } catch (e) {
    logger.warn('[Recovery] Active RunRecord queue reconciliation failed:', e);
  }

  const result: RecoveryResult = {
    requeuedRunning: requeuedRunningIds,
    adoptedPaused: adoptedPausedIds,
    cleanedTerminal: Array.from(cleanedTerminalSet),
    abortedByRestart: Array.from(abortedByRestartSet),
  };

  logger.info('[Recovery] Complete:', {
    requeuedRunning: result.requeuedRunning.length,
    adoptedPaused: result.adoptedPaused.length,
    cleanedTerminal: result.cleanedTerminal.length,
    abortedByRestart: result.abortedByRestart.length,
  });

  return result;
}
