/**
 * @fileoverview Once Trigger Handler (M3.1)
 * @description
 * 使用 chrome.alarms 的 when 参数实现一次性定时触发。
 *
 * 行为：
 * - 每个触发器对应一个一次性 alarm
 * - 触发后自动将触发器禁用 (enabled=false) 并卸载
 */

import type { UnixMillis } from '../../domain/json';
import type { TriggerId } from '../../domain/ids';
import type { TriggerSpecByKind } from '../../domain/triggers';
import { createTriggersStore } from '../../storage/triggers';
import type { TriggerFireCallback, TriggerHandler, TriggerHandlerFactory } from './trigger-handler';

// ==================== Types ====================

type OnceTriggerSpec = TriggerSpecByKind<'once'>;

export interface OnceTriggerHandlerDeps {
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
  /**
   * 可选：自定义禁用触发器的方法
   * 如果未提供，将直接更新 TriggerStore
   */
  disableTrigger?: (triggerId: TriggerId) => Promise<void>;
}

interface InstalledOnceTrigger {
  spec: OnceTriggerSpec;
  whenMs: UnixMillis;
  version: number;
}

// ==================== Constants ====================

const ALARM_PREFIX = 'rr_v3_once_';

// ==================== Utilities ====================

/**
 * 校验并规范化 whenMs
 */
function normalizeWhenMs(value: unknown): UnixMillis {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('whenMs must be a finite number');
  }
  return Math.floor(value) as UnixMillis;
}

/**
 * 生成 alarm 名称
 */
function alarmNameForTrigger(triggerId: TriggerId): string {
  return `${ALARM_PREFIX}${triggerId}`;
}

/**
 * 从 alarm 名称解析 triggerId
 */
function parseTriggerIdFromAlarmName(name: string): TriggerId | null {
  if (!name.startsWith(ALARM_PREFIX)) return null;
  const id = name.slice(ALARM_PREFIX.length);
  return id ? (id as TriggerId) : null;
}

// ==================== Handler Implementation ====================

/**
 * 创建 once 触发器处理器工厂
 */
export function createOnceTriggerHandlerFactory(
  deps?: OnceTriggerHandlerDeps,
): TriggerHandlerFactory<'once'> {
  return (fireCallback) => createOnceTriggerHandler(fireCallback, deps);
}

/**
 * 创建 once 触发器处理器
 */
export function createOnceTriggerHandler(
  fireCallback: TriggerFireCallback,
  deps?: OnceTriggerHandlerDeps,
): TriggerHandler<'once'> {
  const logger = deps?.logger ?? console;

  // 延迟创建 store，避免在测试环境中出问题
  let triggersStore: ReturnType<typeof createTriggersStore> | null = null;
  const getTriggersStore = () => {
    if (!triggersStore) {
      triggersStore = createTriggersStore();
    }
    return triggersStore;
  };

  const disableTrigger =
    deps?.disableTrigger ??
    (async (triggerId: TriggerId) => {
      const store = getTriggersStore();
      const existing = await store.get(triggerId);
      if (!existing) return;
      if (!existing.enabled) return;
      await store.save({ ...existing, enabled: false });
    });

  const installed = new Map<TriggerId, InstalledOnceTrigger>();
  const versions = new Map<TriggerId, number>();
  let listening = false;

  /**
   * 递增版本号以使挂起的操作失效
   */
  function bumpVersion(triggerId: TriggerId): number {
    const next = (versions.get(triggerId) ?? 0) + 1;
    versions.set(triggerId, next);
    return next;
  }

  /**
   * 清除指定 alarm
   */
  async function clearAlarmByName(name: string): Promise<void> {
    if (!chrome.alarms?.clear) return;
    try {
      await Promise.resolve(chrome.alarms.clear(name));
    } catch (e) {
      logger.debug('[OnceTriggerHandler] alarms.clear failed:', e);
    }
  }

  /**
   * 清除所有 once alarms
   */
  async function clearAllOnceAlarms(): Promise<void> {
    if (!chrome.alarms?.getAll || !chrome.alarms?.clear) return;
    try {
      const alarms = await Promise.resolve(chrome.alarms.getAll());
      const list = Array.isArray(alarms) ? alarms : [];
      await Promise.all(
        list.filter((a) => a?.name?.startsWith(ALARM_PREFIX)).map((a) => clearAlarmByName(a.name)),
      );
    } catch (e) {
      logger.debug('[OnceTriggerHandler] alarms.getAll failed:', e);
    }
  }

  /**
   * 调度 alarm
   */
  async function schedule(triggerId: TriggerId, expectedVersion: number): Promise<void> {
    if (!chrome.alarms?.create) {
      logger.warn('[OnceTriggerHandler] chrome.alarms.create is unavailable');
      return;
    }

    const entry = installed.get(triggerId);
    if (!entry || entry.version !== expectedVersion) return;

    const name = alarmNameForTrigger(triggerId);

    try {
      await Promise.resolve(chrome.alarms.create(name, { when: entry.whenMs }));
    } catch (e) {
      logger.error(`[OnceTriggerHandler] alarms.create failed for trigger "${triggerId}":`, e);
    }
  }

  /**
   * 内部卸载逻辑（不触发外部 uninstall）
   */
  async function uninstallInternal(triggerId: TriggerId): Promise<void> {
    bumpVersion(triggerId);
    installed.delete(triggerId);
    await clearAlarmByName(alarmNameForTrigger(triggerId));

    if (installed.size === 0) {
      stopListening();
    }
  }

  /**
   * Alarm 事件处理
   */
  const onAlarm = (alarm: chrome.alarms.Alarm): void => {
    const triggerId = parseTriggerIdFromAlarmName(alarm?.name ?? '');
    if (!triggerId) return;

    const entry = installed.get(triggerId);
    if (!entry) return;

    const expectedVersion = entry.version;

    void (async () => {
      try {
        await fireCallback.onFire(triggerId, {
          sourceTabId: undefined,
          sourceUrl: undefined,
        });
      } catch (e) {
        logger.error(`[OnceTriggerHandler] onFire failed for trigger "${triggerId}":`, e);
      } finally {
        // 检查版本是否仍然有效
        if (installed.get(triggerId)?.version === expectedVersion) {
          // 禁用触发器
          try {
            await disableTrigger(triggerId);
          } catch (e) {
            logger.error(
              `[OnceTriggerHandler] Failed to disable trigger "${triggerId}" after fire:`,
              e,
            );
          }

          // 卸载触发器
          try {
            await uninstallInternal(triggerId);
          } catch (e) {
            logger.error(
              `[OnceTriggerHandler] Failed to uninstall trigger "${triggerId}" after fire:`,
              e,
            );
          }
        }
      }
    })();
  };

  /**
   * 确保正在监听 alarm 事件
   */
  function ensureListening(): void {
    if (listening) return;
    if (!chrome.alarms?.onAlarm?.addListener) {
      logger.warn('[OnceTriggerHandler] chrome.alarms.onAlarm is unavailable');
      return;
    }
    chrome.alarms.onAlarm.addListener(onAlarm);
    listening = true;
  }

  /**
   * 停止监听 alarm 事件
   */
  function stopListening(): void {
    if (!listening) return;
    try {
      chrome.alarms.onAlarm.removeListener(onAlarm);
    } catch (e) {
      logger.debug('[OnceTriggerHandler] removeListener failed:', e);
    } finally {
      listening = false;
    }
  }

  return {
    kind: 'once',

    async install(trigger: OnceTriggerSpec): Promise<void> {
      const whenMs = normalizeWhenMs(trigger.whenMs);

      const version = bumpVersion(trigger.id);
      installed.set(trigger.id, {
        spec: { ...trigger, whenMs },
        whenMs,
        version,
      });

      ensureListening();
      await schedule(trigger.id, version);
    },

    async uninstall(triggerId: string): Promise<void> {
      await uninstallInternal(triggerId as TriggerId);
    },

    async uninstallAll(): Promise<void> {
      for (const id of installed.keys()) {
        bumpVersion(id);
      }
      installed.clear();
      await clearAllOnceAlarms();
      stopListening();
    },

    getInstalledIds(): string[] {
      return Array.from(installed.keys());
    },
  };
}
