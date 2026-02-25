/**
 * @fileoverview 触发器管理器
 * @description
 * TriggerManager 负责管理所有触发器 Handler 的生命周期：
 * - 从 TriggerStore 加载触发器并安装
 * - 处理触发器触发事件，调用 enqueueRun
 * - 提供防风暴机制 (cooldown + maxQueued)
 *
 * 设计理由：
 * - Orchestrator 模式：TriggerManager 不直接实现各类触发器逻辑，而是委托给 per-kind Handler
 * - Handler 工厂模式：TriggerManager 在构造时创建 Handler 实例，注入 fireCallback
 * - 防风暴：cooldown (per-trigger) + maxQueued (global best-effort)
 */

import type { UnixMillis } from '../../domain/json';
import type { RunId, TriggerId } from '../../domain/ids';
import type { TriggerFireContext, TriggerKind, TriggerSpec } from '../../domain/triggers';
import type { StoragePort } from '../storage/storage-port';
import type { EventsBus } from '../transport/events-bus';
import type { RunScheduler } from '../queue/scheduler';
import { enqueueRun, type EnqueueRunResult } from '../queue/enqueue-run';
import type { TriggerFireCallback, TriggerHandler, TriggerHandlerFactory } from './trigger-handler';

// ==================== Types ====================

/**
 * Handler 工厂映射
 */
export type TriggerHandlerFactories = Partial<{
  [K in TriggerKind]: TriggerHandlerFactory<K>;
}>;

/**
 * 防风暴配置
 */
export interface TriggerManagerStormControl {
  /**
   * 同一触发器两次触发之间的最小间隔 (ms)
   * - 0 或 undefined 表示禁用冷却
   */
  cooldownMs?: number;

  /**
   * 全局最大排队 Run 数量
   * - 达到上限时拒绝新的触发
   * - undefined 表示禁用上限检查
   * - 注意：这是 best-effort 检查，非原子性
   */
  maxQueued?: number;
}

/**
 * TriggerManager 依赖
 */
export interface TriggerManagerDeps {
  /** 存储层 */
  storage: Pick<StoragePort, 'triggers' | 'flows' | 'runs' | 'queue'>;
  /** 事件总线 */
  events: Pick<EventsBus, 'append'>;
  /** 调度器 (可选) */
  scheduler?: Pick<RunScheduler, 'kick'>;
  /** Handler 工厂映射 */
  handlerFactories: TriggerHandlerFactories;
  /** 防风暴配置 */
  storm?: TriggerManagerStormControl;
  /** RunId 生成器 (用于测试注入) */
  generateRunId?: () => RunId;
  /** 时间源 (用于测试注入) */
  now?: () => UnixMillis;
  /** 日志器 */
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

/**
 * TriggerManager 状态
 */
export interface TriggerManagerState {
  /** 是否已启动 */
  started: boolean;
  /** 已安装的触发器 ID 列表 */
  installedTriggerIds: TriggerId[];
}

/**
 * TriggerManager 接口
 */
export interface TriggerManager {
  /** 启动管理器，加载并安装所有启用的触发器 */
  start(): Promise<void>;
  /** 停止管理器，卸载所有触发器 */
  stop(): Promise<void>;
  /** 刷新触发器，重新从存储加载并安装 */
  refresh(): Promise<void>;
  /**
   * 手动触发一个触发器
   * @description 仅供 RPC/UI 调用，用于 manual 触发器
   */
  fire(
    triggerId: TriggerId,
    context?: { sourceTabId?: number; sourceUrl?: string },
  ): Promise<EnqueueRunResult>;
  /** 销毁管理器 */
  dispose(): Promise<void>;
  /** 获取当前状态 */
  getState(): TriggerManagerState;
}

// ==================== Utilities ====================

/**
 * 校验非负整数
 */
function normalizeNonNegativeInt(value: unknown, fallback: number, fieldName: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  return Math.max(0, Math.floor(value));
}

/**
 * 校验正整数
 */
function normalizePositiveInt(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  const intValue = Math.floor(value);
  if (intValue < 1) {
    throw new Error(`${fieldName} must be >= 1`);
  }
  return intValue;
}

// ==================== Implementation ====================

/**
 * 创建 TriggerManager
 */
export function createTriggerManager(deps: TriggerManagerDeps): TriggerManager {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());

  // 防风暴参数
  const cooldownMs = normalizeNonNegativeInt(deps.storm?.cooldownMs, 0, 'storm.cooldownMs');
  const maxQueued =
    deps.storm?.maxQueued === undefined || deps.storm?.maxQueued === null
      ? undefined
      : normalizePositiveInt(deps.storm.maxQueued, 'storm.maxQueued');

  // 状态
  const installed = new Map<TriggerId, TriggerSpec>();
  const lastFireAt = new Map<TriggerId, UnixMillis>();
  let started = false;
  let inFlightEnqueues = 0;

  // 防止 refresh 重入
  let refreshPromise: Promise<void> | null = null;
  let pendingRefresh = false;

  // Handler 实例
  const handlers = new Map<TriggerKind, TriggerHandler<TriggerKind>>();

  // 触发回调
  const fireCallback: TriggerFireCallback = {
    onFire: async (triggerId, context) => {
      // 捕获所有异常，避免抛入 chrome API 监听器
      try {
        await handleFire(triggerId as TriggerId, context);
      } catch (e) {
        logger.error('[TriggerManager] onFire failed:', e);
      }
    },
  };

  // Initialize Handler 实例
  for (const [kind, factory] of Object.entries(deps.handlerFactories) as Array<
    [TriggerKind, TriggerHandlerFactory<TriggerKind> | undefined]
  >) {
    if (!factory) continue; // Skip undefined factory values

    const handler = factory(fireCallback) as TriggerHandler<TriggerKind>;
    if (handler.kind !== kind) {
      throw new Error(
        `[TriggerManager] Handler kind mismatch: factory key is "${kind}", but handler.kind is "${handler.kind}"`,
      );
    }
    handlers.set(kind, handler);
  }

  /**
   * 处理触发器触发（内部方法）
   * @param throwOnDrop 如果为 true，则在 cooldown/maxQueued 等情况下抛出错误
   * @returns EnqueueRunResult 或 null（静默丢弃）
   */
  async function handleFire(
    triggerId: TriggerId,
    context: { sourceTabId?: number; sourceUrl?: string },
    options?: { throwOnDrop?: boolean },
  ): Promise<EnqueueRunResult | null> {
    if (!started) {
      if (options?.throwOnDrop) {
        throw new Error('TriggerManager is not started');
      }
      return null;
    }

    const trigger = installed.get(triggerId);
    if (!trigger) {
      if (options?.throwOnDrop) {
        throw new Error(`Trigger "${triggerId}" is not installed`);
      }
      return null;
    }

    const t = now();

    // Per-trigger cooldown 检查
    const prevLastFireAt = lastFireAt.get(triggerId);
    if (cooldownMs > 0 && prevLastFireAt !== undefined && t - prevLastFireAt < cooldownMs) {
      logger.debug(`[TriggerManager] Dropping trigger "${triggerId}" (cooldown ${cooldownMs}ms)`);
      if (options?.throwOnDrop) {
        throw new Error(`Trigger "${triggerId}" dropped (cooldown ${cooldownMs}ms)`);
      }
      return null;
    }

    // Global maxQueued 检查 (best-effort)
    // 注意：在 cooldown 设置前检查，避免因 maxQueued drop 而误设 cooldown
    if (maxQueued !== undefined) {
      const queued = await deps.storage.queue.list('queued');
      if (queued.length + inFlightEnqueues >= maxQueued) {
        logger.warn(
          `[TriggerManager] Dropping trigger "${triggerId}" (queued=${queued.length}, inFlight=${inFlightEnqueues}, maxQueued=${maxQueued})`,
        );
        if (options?.throwOnDrop) {
          throw new Error(`Trigger "${triggerId}" dropped (maxQueued=${maxQueued})`);
        }
        return null;
      }
    }

    // 设置 lastFireAt 以抑制并发触发（在 maxQueued 检查通过后）
    if (cooldownMs > 0) {
      lastFireAt.set(triggerId, t);
    }

    // 构建触发上下文
    const triggerContext: TriggerFireContext = {
      triggerId: trigger.id,
      kind: trigger.kind,
      firedAt: t,
      sourceTabId: context.sourceTabId,
      sourceUrl: context.sourceUrl,
    };

    inFlightEnqueues += 1;
    try {
      const result = await enqueueRun(
        {
          storage: deps.storage,
          events: deps.events,
          scheduler: deps.scheduler,
          generateRunId: deps.generateRunId,
          now,
        },
        {
          flowId: trigger.flowId,
          args: trigger.args,
          trigger: triggerContext,
        },
      );
      return result;
    } catch (e) {
      // 入队失败时回滚 cooldown 标记
      if (cooldownMs > 0) {
        if (prevLastFireAt === undefined) {
          lastFireAt.delete(triggerId);
        } else {
          lastFireAt.set(triggerId, prevLastFireAt);
        }
      }
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`[TriggerManager] enqueueRun failed for trigger "${triggerId}":`, e);
      if (options?.throwOnDrop) {
        throw new Error(`enqueueRun failed for trigger "${triggerId}": ${msg}`);
      }
      return null;
    } finally {
      inFlightEnqueues -= 1;
    }
  }

  /**
   * 手动触发一个触发器（对外暴露）
   * @description 用于 RPC/UI 调用，会抛出错误而不是静默丢弃
   */
  async function fire(
    triggerId: TriggerId,
    context: { sourceTabId?: number; sourceUrl?: string } = {},
  ): Promise<EnqueueRunResult> {
    const result = await handleFire(triggerId, context, { throwOnDrop: true });
    if (!result) {
      throw new Error(`Trigger "${triggerId}" did not enqueue a run`);
    }
    return result;
  }

  /**
   * 执行刷新
   */
  async function doRefresh(): Promise<void> {
    const triggers = await deps.storage.triggers.list();
    if (!started) return;

    // 先卸载所有，再重新安装 (简单策略，保证一致性)
    // Best-effort: 单个 handler 卸载失败不影响其他
    for (const handler of handlers.values()) {
      try {
        await handler.uninstallAll();
      } catch (e) {
        logger.warn(`[TriggerManager] Error during uninstallAll for kind "${handler.kind}":`, e);
      }
    }
    installed.clear();

    // 安装启用的触发器
    for (const trigger of triggers) {
      if (!started) return;
      if (!trigger.enabled) continue;

      const handler = handlers.get(trigger.kind);
      if (!handler) {
        logger.warn(`[TriggerManager] No handler registered for kind "${trigger.kind}"`);
        continue;
      }

      try {
        await handler.install(trigger as Parameters<typeof handler.install>[0]);
        installed.set(trigger.id, trigger);
      } catch (e) {
        logger.error(`[TriggerManager] Failed to install trigger "${trigger.id}":`, e);
      }
    }
  }

  /**
   * 刷新触发器 (合并并发调用)
   */
  async function refresh(): Promise<void> {
    if (!started) {
      throw new Error('TriggerManager is not started');
    }

    pendingRefresh = true;
    if (!refreshPromise) {
      refreshPromise = (async () => {
        while (started && pendingRefresh) {
          pendingRefresh = false;
          await doRefresh();
        }
      })().finally(() => {
        refreshPromise = null;
      });
    }

    return refreshPromise;
  }

  /**
   * 启动管理器
   */
  async function start(): Promise<void> {
    if (started) return;
    started = true;
    await refresh();
  }

  /**
   * 停止管理器
   */
  async function stop(): Promise<void> {
    if (!started) return;

    started = false;
    pendingRefresh = false;

    // 等待进行中的 refresh 完成
    if (refreshPromise) {
      try {
        await refreshPromise;
      } catch {
        // 忽略 refresh 错误
      }
    }

    // 卸载所有触发器
    for (const handler of handlers.values()) {
      try {
        await handler.uninstallAll();
      } catch (e) {
        logger.warn('[TriggerManager] Error uninstalling handler:', e);
      }
    }
    installed.clear();
    lastFireAt.clear();
  }

  /**
   * 销毁管理器
   */
  async function dispose(): Promise<void> {
    await stop();
  }

  /**
   * 获取状态
   */
  function getState(): TriggerManagerState {
    return {
      started,
      installedTriggerIds: Array.from(installed.keys()),
    };
  }

  return { start, stop, refresh, fire, dispose, getState };
}
