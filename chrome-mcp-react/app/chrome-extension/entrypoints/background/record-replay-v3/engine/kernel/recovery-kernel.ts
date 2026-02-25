/**
 * @fileoverview 支持崩溃恢复的 ExecutionKernel 实现 (P3-06)
 * @description
 * 提供 ExecutionKernel 的恢复增强实现，支持 `recover()` 方法。
 * 通过委托给 RecoveryCoordinator 实现崩溃恢复。
 *
 * 其他执行方法（startRun, pauseRun 等）暂未实现，将在后续阶段完成。
 */

import type { UnixMillis } from '../../domain/json';
import type { RunId } from '../../domain/ids';
import type { DebuggerCommand, DebuggerState } from '../../domain/debug';

import type { StoragePort } from '../storage/storage-port';
import type { EventsBus } from '../transport/events-bus';
import { recoverFromCrash } from '../recovery/recovery-coordinator';

import type { ExecutionKernel, RunStartRequest, RunStatusInfo } from './kernel';

// ==================== Types ====================

/**
 * 支持恢复的 Kernel 依赖
 */
export interface RecoveryEnabledKernelDeps {
  /** 存储层 */
  storage: StoragePort;
  /** 事件总线 */
  events: EventsBus;
  /** 当前 Service Worker 的 ownerId */
  ownerId: string;
  /** 时间源 */
  now?: () => UnixMillis;
  /** 日志器 */
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

// ==================== Factory ====================

/**
 * 创建支持恢复的 ExecutionKernel
 * @description
 * 此实现仅支持 `recover()` 和 `getRunStatus()` 方法。
 * 其他执行方法暂未实现，将在后续阶段完成。
 */
export function createRecoveryEnabledKernel(deps: RecoveryEnabledKernelDeps): ExecutionKernel {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());

  if (!deps.ownerId) {
    throw new Error('ownerId is required');
  }

  const notImplemented = (name: string): never => {
    throw new Error(`ExecutionKernel.${name} not implemented`);
  };

  return {
    onEvent: (listener) => deps.events.subscribe(listener),

    startRun: async (_req: RunStartRequest) => notImplemented('startRun'),
    pauseRun: async (_runId: RunId) => notImplemented('pauseRun'),
    resumeRun: async (_runId: RunId) => notImplemented('resumeRun'),
    cancelRun: async (_runId: RunId) => notImplemented('cancelRun'),

    debug: async (
      _runId: RunId,
      _cmd: DebuggerCommand,
    ): Promise<{ ok: true; state?: DebuggerState } | { ok: false; error: string }> => {
      return { ok: false, error: 'ExecutionKernel.debug not configured' };
    },

    getRunStatus: async (runId: RunId): Promise<RunStatusInfo | null> => {
      const run = await deps.storage.runs.get(runId);
      if (!run) return null;
      return {
        status: run.status,
        currentNodeId: run.currentNodeId,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        tabId: run.tabId,
      };
    },

    recover: async (): Promise<void> => {
      logger.info('[RecoveryKernel] Starting crash recovery...');
      const result = await recoverFromCrash({
        storage: deps.storage,
        events: deps.events,
        ownerId: deps.ownerId,
        now,
        logger,
      });
      logger.info('[RecoveryKernel] Recovery complete:', result);
    },
  };
}
