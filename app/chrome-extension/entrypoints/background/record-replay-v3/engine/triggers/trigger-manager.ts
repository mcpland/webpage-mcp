/**
 * @fileoverview trigger manager
 * @description
 * TriggerManager Responsible for managing the life cycle of all trigger Handlers:
 * - Load triggers from TriggerStore and install
 * - Handle the trigger firing event and call enqueueRun
 * - Provide storm prevention mechanism (cooldown + maxQueued)
 *
 * Design reasons:
 * - Orchestrator Mode: TriggerManager does not directly implement various trigger logic, but delegates it to per-kind Handler
 * - Handler Factory mode: TriggerManager creates a Handler instance during construction and injects fireCallback
 * - Storm protection: cooldown (per-trigger) + maxQueued (global best-effort)
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
 * Handler Factory mapping
 */
export type TriggerHandlerFactories = Partial<{
  [K in TriggerKind]: TriggerHandlerFactory<K>;
}>;

/**
 * Stormproof configuration
 */
export interface TriggerManagerStormControl {
  /**
   * Minimum interval between two firings of the same trigger (ms)
   * - 0 or undefined to disable cooling
   */
  cooldownMs?: number;

  /**
   * Global maximum number of queued Runs
   * - Refuse new triggers when the limit is reached
   * - undefined Indicates that cap checking is disabled
   * - NOTE: This is a best-effort check, not atomic
   */
  maxQueued?: number;
}

/**
 * TriggerManager Depend on
 */
export interface TriggerManagerDeps {
  /** storage layer */
  storage: Pick<StoragePort, 'triggers' | 'flows' | 'runs' | 'queue'>;
  /** event bus */
  events: Pick<EventsBus, 'append'>;
  /** Scheduler (optional) */
  scheduler?: Pick<RunScheduler, 'kick'>;
  /** Handler Factory mapping */
  handlerFactories: TriggerHandlerFactories;
  /** Stormproof configuration */
  storm?: TriggerManagerStormControl;
  /** RunId Generator (for test injection) */
  generateRunId?: () => RunId;
  /** Time source (for test injection) */
  now?: () => UnixMillis;
  /** Logger */
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

/**
 * TriggerManager Status
 */
export interface TriggerManagerState {
  /** Has it been started? */
  started: boolean;
  /** List of installed trigger IDs */
  installedTriggerIds: TriggerId[];
}

/**
 * TriggerManager interface
 */
export interface TriggerManager {
  /** Start the manager, load and install all enabled triggers */
  start(): Promise<void>;
  /** Stop the manager and uninstall all triggers */
  stop(): Promise<void>;
  /** Refresh trigger, reload from storage and install */
  refresh(): Promise<void>;
  /**
   * Manually fire a trigger
   * @description RPC/UI calls only, used with manual triggers
   */
  fire(
    triggerId: TriggerId,
    context?: { sourceTabId?: number; sourceUrl?: string },
  ): Promise<EnqueueRunResult>;
  /** destroy manager */
  dispose(): Promise<void>;
  /** Get current status */
  getState(): TriggerManagerState;
}

// ==================== Utilities ====================

/**
 * Check non-negative integers
 */
function normalizeNonNegativeInt(value: unknown, fallback: number, fieldName: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  return Math.max(0, Math.floor(value));
}

/**
 * Check positive integer
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
 * Create TriggerManager
 */
export function createTriggerManager(deps: TriggerManagerDeps): TriggerManager {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());

  // Storm protection parameters
  const cooldownMs = normalizeNonNegativeInt(deps.storm?.cooldownMs, 0, 'storm.cooldownMs');
  const maxQueued =
    deps.storm?.maxQueued === undefined || deps.storm?.maxQueued === null
      ? undefined
      : normalizePositiveInt(deps.storm.maxQueued, 'storm.maxQueued');

  // Status
  const installed = new Map<TriggerId, TriggerSpec>();
  const lastFireAt = new Map<TriggerId, UnixMillis>();
  let started = false;
  let inFlightEnqueues = 0;

  // Prevent refresh reentry
  let refreshPromise: Promise<void> | null = null;
  let pendingRefresh = false;

  // Handler Example
  const handlers = new Map<TriggerKind, TriggerHandler<TriggerKind>>();

  // trigger callback
  const fireCallback: TriggerFireCallback = {
    onFire: async (triggerId, context) => {
      // Catch all exceptions to avoid being thrown into chrome API listeners
      try {
        await handleFire(triggerId as TriggerId, context);
      } catch (e) {
        logger.error('[TriggerManager] onFire failed:', e);
      }
    },
  };

  // Initialize Handler Example
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
   * Handle trigger firing (internal method)
   * @param throwOnDrop If true, throw an error in case of cooldown/maxQueued etc.
   * @returns EnqueueRunResult or null (silent discard)
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

    // Per-trigger cooldown Check
    const prevLastFireAt = lastFireAt.get(triggerId);
    if (cooldownMs > 0 && prevLastFireAt !== undefined && t - prevLastFireAt < cooldownMs) {
      logger.debug(`[TriggerManager] Dropping trigger "${triggerId}" (cooldown ${cooldownMs}ms)`);
      if (options?.throwOnDrop) {
        throw new Error(`Trigger "${triggerId}" dropped (cooldown ${cooldownMs}ms)`);
      }
      return null;
    }

    // Global maxQueued Check (best-effort)
    // Note: Check before setting cooldown to avoid mistakenly setting cooldown due to maxQueued drop
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

    // Set lastFireAt to suppress concurrent firing (after maxQueued check passes)
    if (cooldownMs > 0) {
      lastFireAt.set(triggerId, t);
    }

    // Build trigger context
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
      // Rollback cooldown mark when enqueue fails
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
   * Manually fire a trigger (exposed to the outside world)
   * @description For RPC/UI calls, an error will be thrown instead of silently discarding
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
   * Perform refresh
   */
  async function doRefresh(): Promise<void> {
    const triggers = await deps.storage.triggers.list();
    if (!started) return;

    // Uninstall everything first, then reinstall (simple strategy to ensure consistency)
    // Best-effort: Failure to uninstall a single handler will not affect other
    for (const handler of handlers.values()) {
      try {
        await handler.uninstallAll();
      } catch (e) {
        logger.warn(`[TriggerManager] Error during uninstallAll for kind "${handler.kind}":`, e);
      }
    }
    installed.clear();

    // Install enabled triggers
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
   * Refresh trigger (combined concurrent calls)
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
   * boot manager
   */
  async function start(): Promise<void> {
    if (started) return;
    started = true;
    await refresh();
  }

  /**
   * Stop manager
   */
  async function stop(): Promise<void> {
    if (!started) return;

    started = false;
    pendingRefresh = false;

    // Wait for ongoing refresh to complete
    if (refreshPromise) {
      try {
        await refreshPromise;
      } catch {
        // Ignore refresh errors
      }
    }

    // Uninstall all triggers
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
   * destroy manager
   */
  async function dispose(): Promise<void> {
    await stop();
  }

  /**
   * Get status
   */
  function getState(): TriggerManagerState {
    return {
      started,
      installedTriggerIds: Array.from(installed.keys()),
    };
  }

  return { start, stop, refresh, fire, dispose, getState };
}
