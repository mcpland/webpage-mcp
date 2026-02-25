/**
 * @fileoverview 崩溃恢复协调器 (P3-06)
 * @description
 * MV3 Service Worker 可能随时被终止。此协调器在 SW 启动时协调队列状态和 Run 记录，
 * 使中断的 Run 能够被恢复执行。
 *
 * 恢复策略：
 * - 孤儿 running 项：回收为 queued，等待重新调度（从头重跑）
 * - 孤儿 paused 项：接管 lease，保持 paused 状态
 * - 已终态 Run 的队列残留：清理
 *
 * 调用时机：
 * - 必须在 scheduler.start() 之前调用
 * - 通常在 SW 启动时调用一次
 */

import type { UnixMillis } from '../../domain/json';
import type { RunId } from '../../domain/ids';
import { isTerminalStatus, type RunStatus } from '../../domain/events';
import type { StoragePort } from '../storage/storage-port';
import type { EventsBus } from '../transport/events-bus';

// ==================== Types ====================

/**
 * 恢复结果
 */
export interface RecoveryResult {
  /** 被回收为 queued 的 running Run ID */
  requeuedRunning: RunId[];
  /** 被接管的 paused Run ID */
  adoptedPaused: RunId[];
  /** 被清理的已终态 Run ID */
  cleanedTerminal: RunId[];
}

/**
 * 恢复协调器依赖
 */
export interface RecoveryCoordinatorDeps {
  /** 存储层 */
  storage: StoragePort;
  /** 事件总线 */
  events: EventsBus;
  /** 当前 Service Worker 的 ownerId */
  ownerId: string;
  /** 时间源 */
  now: () => UnixMillis;
  /** 日志器 */
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

// ==================== Main Function ====================

/**
 * 执行崩溃恢复
 * @description
 * 在 SW 启动时调用，协调队列状态和 Run 记录。
 *
 * 执行顺序：
 * 1. 预清理：检查队列中的所有项，清理已终态或无对应 RunRecord 的残留
 * 2. 恢复孤儿租约：回收 running，接管 paused
 * 3. 同步 RunRecord 状态：确保 RunRecord 与队列状态一致
 * 4. 发送恢复事件：为 requeued running 项发送 run.recovered 事件
 */
export async function recoverFromCrash(deps: RecoveryCoordinatorDeps): Promise<RecoveryResult> {
  const logger = deps.logger ?? console;

  if (!deps.ownerId) {
    throw new Error('ownerId is required');
  }

  const now = deps.now();

  // 设计理由：恢复过程必须"先清理后接管/回收"，否则可能把已经终态的 Run 重新排队执行
  const cleanedTerminalSet = new Set<RunId>();

  // ==================== Step 1: 预清理 ====================
  // 检查队列中的所有项，清理已终态或无对应 RunRecord 的残留
  try {
    const items = await deps.storage.queue.list();
    for (const item of items) {
      const runId = item.id;
      const run = await deps.storage.runs.get(runId);

      // 防御性清理：无 RunRecord 的队列项无法执行
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

      // 清理已终态的 Run（SW 可能在 runner 完成后、scheduler markDone 前崩溃）
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

  // ==================== Step 2: 恢复孤儿租约 ====================
  // Best-effort：即使失败也不应该阻止启动
  let requeuedRunning: Array<{ runId: RunId; prevOwnerId?: string }> = [];
  let adoptedPaused: Array<{ runId: RunId; prevOwnerId?: string }> = [];
  try {
    const result = await deps.storage.queue.recoverOrphanLeases(deps.ownerId, now);
    requeuedRunning = result.requeuedRunning;
    adoptedPaused = result.adoptedPaused;
  } catch (e) {
    logger.error('[Recovery] recoverOrphanLeases failed:', e);
    // 继续执行，不阻止启动
  }

  // ==================== Step 3: 同步 RunRecord 状态 ====================
  const requeuedRunningIds: RunId[] = [];
  for (const entry of requeuedRunning) {
    const runId = entry.runId;
    requeuedRunningIds.push(runId);

    // 跳过在 Step 1 中已清理的项
    if (cleanedTerminalSet.has(runId)) {
      continue;
    }

    try {
      const run = await deps.storage.runs.get(runId);
      if (!run) {
        // RunRecord 不存在，清理队列项（防御性）
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

      // 跳过已终态的 Run（可能在恢复过程中被其他逻辑更新）
      // 同时清理队列项，防止残留
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

      // 更新 RunRecord 状态为 queued
      await deps.storage.runs.patch(runId, { status: 'queued', updatedAt: now });

      // 发送恢复事件（best-effort，失败不影响恢复流程）
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
        // 继续执行，不影响恢复流程
      }
    } catch (e) {
      logger.warn('[Recovery] Reconcile requeued running failed:', runId, e);
    }
  }

  // ==================== Step 4: 同步 adopted paused 的 RunRecord ====================
  const adoptedPausedIds: RunId[] = [];
  for (const entry of adoptedPaused) {
    const runId = entry.runId;
    adoptedPausedIds.push(runId);

    // 跳过在 Step 1 中已清理的项
    if (cleanedTerminalSet.has(runId)) {
      continue;
    }

    try {
      const run = await deps.storage.runs.get(runId);
      if (!run) {
        // RunRecord 不存在，清理队列项（防御性）
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

      // 跳过已终态的 Run，同时清理队列项
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

      // 如果 RunRecord 状态不是 paused，同步更新
      if (run.status !== 'paused') {
        await deps.storage.runs.patch(runId, { status: 'paused' as RunStatus, updatedAt: now });
      }

      logger.info(`[Recovery] Adopted orphan paused run: ${runId}`);
    } catch (e) {
      logger.warn('[Recovery] Reconcile adopted paused failed:', runId, e);
    }
  }

  const result: RecoveryResult = {
    requeuedRunning: requeuedRunningIds,
    adoptedPaused: adoptedPausedIds,
    cleanedTerminal: Array.from(cleanedTerminalSet),
  };

  logger.info('[Recovery] Complete:', {
    requeuedRunning: result.requeuedRunning.length,
    adoptedPaused: result.adoptedPaused.length,
    cleanedTerminal: result.cleanedTerminal.length,
  });

  return result;
}
