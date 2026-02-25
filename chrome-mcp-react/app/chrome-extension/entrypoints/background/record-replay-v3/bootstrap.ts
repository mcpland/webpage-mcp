/**
 * @fileoverview Record-Replay V3 composition root (bootstrap)
 * @description
 * Wires storage, events, scheduler, triggers and RPC for the MV3 background service worker.
 *
 * 设计说明：
 * - 必须先执行 recoverFromCrash() 再启动 scheduler.start()
 * - 使用全局单例 keepalive-manager 避免多个控制器冲突
 * - RunExecutor 使用 RunRunner 执行实际的 Flow
 */

import type { UnixMillis } from './domain/json';
import type { RunId } from './domain/ids';
import { RR_ERROR_CODES, createRRError, type RRError } from './domain/errors';

import type { StoragePort } from './engine/storage/storage-port';
import { StorageBackedEventsBus, type EventsBus } from './engine/transport/events-bus';

import { DEFAULT_QUEUE_CONFIG, type RunQueueItem } from './engine/queue/queue';
import { createLeaseManager, generateOwnerId, type LeaseManager } from './engine/queue/leasing';
import { createRunScheduler, type RunExecutor, type RunScheduler } from './engine/queue/scheduler';
import { recoverFromCrash } from './engine/recovery/recovery-coordinator';

import { RpcServer } from './engine/transport/rpc-server';

import { createTriggerManager, type TriggerManager } from './engine/triggers/trigger-manager';
import { createUrlTriggerHandlerFactory } from './engine/triggers/url-trigger';
import { createCommandTriggerHandlerFactory } from './engine/triggers/command-trigger';
import { createContextMenuTriggerHandlerFactory } from './engine/triggers/context-menu-trigger';
import { createDomTriggerHandlerFactory } from './engine/triggers/dom-trigger';
import { createCronTriggerHandlerFactory } from './engine/triggers/cron-trigger';
import { createIntervalTriggerHandlerFactory } from './engine/triggers/interval-trigger';
import { createOnceTriggerHandlerFactory } from './engine/triggers/once-trigger';
import { createManualTriggerHandlerFactory } from './engine/triggers/manual-trigger';

import { createChromeArtifactService } from './engine/kernel/artifacts';
import { createRunRunnerFactory, type RunRunnerFactory } from './engine/kernel/runner';
import {
  createDebugController,
  createRunnerRegistry,
  type DebugController,
  type RunnerRegistry,
} from './engine/kernel/debug-controller';

import { PluginRegistry } from './engine/plugins/registry';
import {
  registerV2ReplayNodesAsV3Nodes,
  DEFAULT_V2_EXCLUDE_LIST,
} from './engine/plugins/register-v2-replay-nodes';

import { acquireKeepalive } from '../keepalive-manager';
import { createStoragePort } from './index';

// ==================== Types ====================

type Logger = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

/**
 * V3 运行时句柄
 */
export interface V3Runtime {
  ownerId: string;
  storage: StoragePort;
  events: EventsBus;
  leaseManager: LeaseManager;
  scheduler: RunScheduler;
  runners: RunnerRegistry;
  debugController: DebugController;
  triggers: TriggerManager;
  rpcServer: RpcServer;
  stop(): Promise<void>;
}

// ==================== Singleton State ====================

let runtime: V3Runtime | null = null;
let bootstrapPromise: Promise<V3Runtime> | null = null;

// ==================== Utilities ====================

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err)
    return String((err as { message: unknown }).message);
  return String(err);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function createEphemeralTab(logger: Logger): Promise<number> {
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  if (tab.id === undefined) {
    throw new Error('chrome.tabs.create returned a tab without id');
  }
  logger.debug(`[RR-V3] Allocated ephemeral tab ${tab.id}`);
  return tab.id;
}

async function safeRemoveTab(tabId: number, logger: Logger): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {
    logger.debug(`[RR-V3] Failed to close tab ${tabId}:`, e);
  }
}

/**
 * 解析运行 Run 所需的 Tab ID
 * 优先级: run.tabId > queue.tabId > trigger.sourceTabId > 创建新 Tab
 */
async function resolveRunTab(input: {
  runTabId?: number;
  queueTabId?: number;
  triggerTabId?: number;
  logger: Logger;
}): Promise<{ tabId: number; shouldClose: boolean }> {
  const candidates = [input.runTabId, input.queueTabId, input.triggerTabId].filter(
    (x): x is number => isFiniteNumber(x),
  );

  for (const tabId of candidates) {
    if (await tabExists(tabId)) {
      return { tabId, shouldClose: false };
    }
  }

  const tabId = await createEphemeralTab(input.logger);
  return { tabId, shouldClose: true };
}

/**
 * 将 Run 标记为失败
 * 注意：会重新读取最新的 RunRecord 以获取正确的 startedAt
 */
async function failRun(
  deps: { storage: StoragePort; events: EventsBus; now: () => UnixMillis; logger: Logger },
  runId: RunId,
  error: RRError,
): Promise<void> {
  const finishedAt = deps.now();

  // 重新获取最新的 run 记录以获取正确的 startedAt
  let startedAt = finishedAt;
  try {
    const latestRun = await deps.storage.runs.get(runId);
    if (latestRun?.startedAt !== undefined) {
      startedAt = latestRun.startedAt;
    }
  } catch {
    // ignore - use finishedAt as startedAt
  }

  const tookMs = Math.max(0, finishedAt - startedAt);

  try {
    await deps.storage.runs.patch(runId, {
      status: 'failed',
      finishedAt,
      tookMs,
      error,
    });
  } catch (e) {
    deps.logger.error(`[RR-V3] Failed to patch run "${runId}" as failed:`, e);
    return;
  }

  try {
    await deps.events.append({ runId, type: 'run.failed', error });
  } catch (e) {
    deps.logger.warn(`[RR-V3] Failed to append run.failed for "${runId}":`, e);
  }
}

// ==================== Run Executor ====================

/**
 * 创建默认的 RunExecutor
 * 使用 RunRunner 执行 Flow
 */
function createDefaultRunExecutor(deps: {
  storage: StoragePort;
  events: EventsBus;
  runnerFactory: RunRunnerFactory;
  runners: RunnerRegistry;
  now: () => UnixMillis;
  logger: Logger;
}): RunExecutor {
  return async (item: RunQueueItem): Promise<void> => {
    const runId = item.id;

    // 1. 获取 RunRecord
    const run = await deps.storage.runs.get(runId);
    if (!run) {
      deps.logger.warn(`[RR-V3] RunRecord not found for queue item "${runId}", skipping execution`);
      return;
    }

    // 2. 获取 Flow
    const flow = await deps.storage.flows.get(item.flowId);
    if (!flow) {
      await failRun(
        deps,
        runId,
        createRRError(RR_ERROR_CODES.VALIDATION_ERROR, `Flow "${item.flowId}" not found`),
      );
      return;
    }

    // 3. 解析 Tab ID
    const { tabId, shouldClose } = await resolveRunTab({
      runTabId: run.tabId,
      queueTabId: item.tabId,
      triggerTabId: item.trigger?.sourceTabId,
      logger: deps.logger,
    });

    // 4. 同步 attempt 到 RunRecord
    try {
      await deps.storage.runs.patch(runId, {
        attempt: item.attempt,
        maxAttempts: item.maxAttempts,
        tabId,
      });
    } catch (e) {
      deps.logger.debug(`[RR-V3] Failed to patch run "${runId}" attempt/tabId:`, e);
    }

    // 5. 执行 Run
    let runner;
    try {
      runner = deps.runnerFactory.create(runId, {
        flow,
        tabId,
        args: item.args,
        startNodeId: run.startNodeId,
        debug: item.debug,
      });

      // 注册到 RunnerRegistry，供 DebugController 和 RPC 使用
      deps.runners.register(runId, runner);

      await runner.start();
    } catch (e) {
      await failRun(
        deps,
        runId,
        createRRError(RR_ERROR_CODES.INTERNAL, `Executor crashed: ${errorMessage(e)}`),
      );
    } finally {
      // 6. 注销 Runner
      if (runner) {
        deps.runners.unregister(runId);
      }

      // 7. 清理临时 Tab
      if (shouldClose) {
        await safeRemoveTab(tabId, deps.logger);
      }
    }
  };
}

// ==================== Bootstrap ====================

/**
 * 启动 RR-V3 运行时
 * @returns 运行时句柄
 */
export async function bootstrapV3(): Promise<V3Runtime> {
  if (runtime) return runtime;
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const logger: Logger = console;
    const now = (): UnixMillis => Date.now();

    logger.info('[RR-V3] Bootstrapping...');

    // 1) Storage
    const storage = createStoragePort();

    // 2) EventsBus
    const events: EventsBus = new StorageBackedEventsBus(storage.events);

    // 3) Lease owner identity (per SW instance)
    const ownerId = generateOwnerId();
    logger.debug(`[RR-V3] Owner ID: ${ownerId}`);

    // 4) LeaseManager
    const leaseManager = createLeaseManager(storage.queue, DEFAULT_QUEUE_CONFIG);

    // 5) RunnerRegistry + DebugController
    const runners = createRunnerRegistry();
    const debugController = createDebugController({ storage, events, runners });

    // 6) Keepalive (reuse global singleton to avoid multiple controllers fighting)
    const keepalive = {
      acquire: (tag: string) => acquireKeepalive(`rr_v3:${tag}`),
    };

    // 7) PluginRegistry - register V2 action handlers as V3 nodes
    const plugins = new PluginRegistry();
    const registeredNodes = registerV2ReplayNodesAsV3Nodes(plugins, {
      // Exclude control directives that V3 runner doesn't support
      exclude: [...DEFAULT_V2_EXCLUDE_LIST],
    });
    logger.debug(`[RR-V3] Registered ${registeredNodes.length} V2 action handlers as V3 nodes`);

    // 8) RunExecutor via RunRunnerFactory
    const runnerFactory = createRunRunnerFactory({
      storage,
      events,
      plugins,
      artifactService: createChromeArtifactService(),
      now,
    });

    const execute = createDefaultRunExecutor({
      storage,
      events,
      runnerFactory,
      runners,
      now,
      logger,
    });

    // 7) Scheduler
    const scheduler = createRunScheduler({
      queue: storage.queue,
      leaseManager,
      keepalive,
      config: DEFAULT_QUEUE_CONFIG,
      ownerId,
      execute,
      now,
      logger,
    });

    // 8) TriggerManager
    const triggers = createTriggerManager({
      storage,
      events,
      scheduler,
      handlerFactories: {
        url: createUrlTriggerHandlerFactory({ logger }),
        command: createCommandTriggerHandlerFactory({ logger }),
        contextMenu: createContextMenuTriggerHandlerFactory({ logger }),
        dom: createDomTriggerHandlerFactory({ logger }),
        cron: createCronTriggerHandlerFactory({ logger, now }),
        interval: createIntervalTriggerHandlerFactory({ logger }),
        once: createOnceTriggerHandlerFactory({ logger }),
        manual: createManualTriggerHandlerFactory({ logger }),
      },
      now,
      logger,
    });

    // 10) RpcServer (created but started after recovery)
    const rpcServer = new RpcServer({
      storage,
      events,
      scheduler,
      debugController,
      runners,
      triggerManager: triggers,
      now,
    });

    // Cleanup helper for error recovery
    const cleanup = async (): Promise<void> => {
      try {
        rpcServer.stop();
      } catch {
        /* ignore */
      }
      try {
        await triggers.stop();
      } catch {
        /* ignore */
      }
      try {
        scheduler.stop();
      } catch {
        /* ignore */
      }
      try {
        leaseManager.dispose();
      } catch {
        /* ignore */
      }
      try {
        debugController.stop();
      } catch {
        /* ignore */
      }
    };

    try {
      // 10) Recovery - MUST run before scheduler.start()
      logger.info('[RR-V3] Running crash recovery...');
      await recoverFromCrash({ storage, events, ownerId, now, logger });

      // 11) Start components
      scheduler.start();
      await triggers.start();
      rpcServer.start();

      logger.info('[RR-V3] Bootstrap complete');
    } catch (e) {
      await cleanup();
      throw e;
    }

    // Build runtime handle
    runtime = {
      ownerId,
      storage,
      events,
      leaseManager,
      scheduler,
      runners,
      debugController,
      triggers,
      rpcServer,
      stop: async () => {
        logger.info('[RR-V3] Stopping...');
        // Stop order: RPC first (block new requests) -> triggers -> scheduler -> lease -> debug
        rpcServer.stop();
        await triggers.stop().catch(() => {});
        scheduler.stop();
        leaseManager.dispose();
        debugController.stop();
        runtime = null;
        logger.info('[RR-V3] Stopped');
      },
    };

    return runtime;
  })().finally(() => {
    bootstrapPromise = null;
  });

  return bootstrapPromise;
}

/**
 * 获取当前运行时（如果已启动）
 */
export function getV3Runtime(): V3Runtime | null {
  return runtime;
}

/**
 * 检查 V3 是否已启动
 */
export function isV3Running(): boolean {
  return runtime !== null;
}
