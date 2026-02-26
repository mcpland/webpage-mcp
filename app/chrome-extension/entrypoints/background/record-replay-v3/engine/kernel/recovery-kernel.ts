/**
 * @fileoverview ExecutionKernel implementation supporting crash recovery (P3-06)
 * @description
 * Provides an enhanced recovery implementation of ExecutionKernel, supporting the `recover()` method.
 * Crash recovery is implemented by delegating to RecoveryCoordinator.
 *
 * Other execution methods (startRun, pauseRun, etc.) have not been implemented yet and will be completed in subsequent stages.
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
 * Kernel dependencies that support recovery
 */
export interface RecoveryEnabledKernelDeps {
  /** storage layer */
  storage: StoragePort;
  /** event bus */
  events: EventsBus;
  /** The ownerId of the current Service Worker */
  ownerId: string;
  /** time source */
  now?: () => UnixMillis;
  /** Logger */
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

// ==================== Factory ====================

/**
 * Create an ExecutionKernel that supports recovery
 * @description
 * This implementation only supports the `recover()` and `getRunStatus()` methods.
 * Other execution methods have not yet been implemented and will be completed in subsequent stages.
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
