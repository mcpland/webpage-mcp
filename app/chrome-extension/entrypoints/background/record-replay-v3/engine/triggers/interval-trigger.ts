/**
 * @fileoverview Interval Trigger Handler (M3.1)
 * @description
 * Use periodInMinutes of chrome.alarms to implement fixed interval triggering.
 *
 * Strategy:
 * - Each trigger corresponds to a repeated alarm
 * - Use delayInMinutes to make the first trigger occur after the configured interval
 */

import type { TriggerId } from '../../domain/ids';
import type { TriggerSpecByKind } from '../../domain/triggers';
import type { TriggerFireCallback, TriggerHandler, TriggerHandlerFactory } from './trigger-handler';

// ==================== Types ====================

type IntervalTriggerSpec = TriggerSpecByKind<'interval'>;

export interface IntervalTriggerHandlerDeps {
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

interface InstalledIntervalTrigger {
  spec: IntervalTriggerSpec;
  periodMinutes: number;
  version: number;
}

// ==================== Constants ====================

const ALARM_PREFIX = 'rr_v3_interval_';

// ==================== Utilities ====================

/**
 * Verify and normalize periodMinutes
 */
function normalizePeriodMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('periodMinutes must be a finite number');
  }
  if (value < 1) {
    throw new Error('periodMinutes must be >= 1');
  }
  return value;
}

/**
 * Generate alarm name
 */
function alarmNameForTrigger(triggerId: TriggerId): string {
  return `${ALARM_PREFIX}${triggerId}`;
}

/**
 * Resolve triggerId from alarm name
 */
function parseTriggerIdFromAlarmName(name: string): TriggerId | null {
  if (!name.startsWith(ALARM_PREFIX)) return null;
  const id = name.slice(ALARM_PREFIX.length);
  return id ? (id as TriggerId) : null;
}

// ==================== Handler Implementation ====================

/**
 * Create interval trigger processor factory
 */
export function createIntervalTriggerHandlerFactory(
  deps?: IntervalTriggerHandlerDeps,
): TriggerHandlerFactory<'interval'> {
  return (fireCallback) => createIntervalTriggerHandler(fireCallback, deps);
}

/**
 * Create interval trigger handler
 */
export function createIntervalTriggerHandler(
  fireCallback: TriggerFireCallback,
  deps?: IntervalTriggerHandlerDeps,
): TriggerHandler<'interval'> {
  const logger = deps?.logger ?? console;

  const installed = new Map<TriggerId, InstalledIntervalTrigger>();
  const versions = new Map<TriggerId, number>();
  let listening = false;

  /**
   * Increment the version number to invalidate pending operations
   */
  function bumpVersion(triggerId: TriggerId): number {
    const next = (versions.get(triggerId) ?? 0) + 1;
    versions.set(triggerId, next);
    return next;
  }

  /**
   * Clear specified alarm
   */
  async function clearAlarmByName(name: string): Promise<void> {
    if (!chrome.alarms?.clear) return;
    try {
      await Promise.resolve(chrome.alarms.clear(name));
    } catch (e) {
      logger.debug('[IntervalTriggerHandler] alarms.clear failed:', e);
    }
  }

  /**
   * Clear all interval alarms
   */
  async function clearAllIntervalAlarms(): Promise<void> {
    if (!chrome.alarms?.getAll || !chrome.alarms?.clear) return;
    try {
      const alarms = await Promise.resolve(chrome.alarms.getAll());
      const list = Array.isArray(alarms) ? alarms : [];
      await Promise.all(
        list.filter((a) => a?.name?.startsWith(ALARM_PREFIX)).map((a) => clearAlarmByName(a.name)),
      );
    } catch (e) {
      logger.debug('[IntervalTriggerHandler] alarms.getAll failed:', e);
    }
  }

  /**
   * Scheduling alarm
   */
  async function schedule(triggerId: TriggerId, expectedVersion: number): Promise<void> {
    if (!chrome.alarms?.create) {
      logger.warn('[IntervalTriggerHandler] chrome.alarms.create is unavailable');
      return;
    }

    const entry = installed.get(triggerId);
    if (!entry || entry.version !== expectedVersion) return;

    const name = alarmNameForTrigger(triggerId);
    const periodInMinutes = entry.periodMinutes;

    try {
      // Create recurring alarms using delayInMinutes and periodInMinutes
      // The first trigger is after periodInMinutes, and then every periodInMinutes.
      await Promise.resolve(
        chrome.alarms.create(name, {
          delayInMinutes: periodInMinutes,
          periodInMinutes,
        }),
      );
    } catch (e) {
      logger.error(`[IntervalTriggerHandler] alarms.create failed for trigger "${triggerId}":`, e);
    }
  }

  /**
   * Alarm event handling
   */
  const onAlarm = (alarm: chrome.alarms.Alarm): void => {
    const triggerId = parseTriggerIdFromAlarmName(alarm?.name ?? '');
    if (!triggerId) return;

    const entry = installed.get(triggerId);
    if (!entry) return;

    // trigger callback
    Promise.resolve(
      fireCallback.onFire(triggerId, {
        sourceTabId: undefined,
        sourceUrl: undefined,
      }),
    ).catch((e) => {
      logger.error(`[IntervalTriggerHandler] onFire failed for trigger "${triggerId}":`, e);
    });
  };

  /**
   * Make sure you are listening for alarm events
   */
  function ensureListening(): void {
    if (listening) return;
    if (!chrome.alarms?.onAlarm?.addListener) {
      logger.warn('[IntervalTriggerHandler] chrome.alarms.onAlarm is unavailable');
      return;
    }
    chrome.alarms.onAlarm.addListener(onAlarm);
    listening = true;
  }

  /**
   * Stop listening for alarm events
   */
  function stopListening(): void {
    if (!listening) return;
    try {
      chrome.alarms.onAlarm.removeListener(onAlarm);
    } catch (e) {
      logger.debug('[IntervalTriggerHandler] removeListener failed:', e);
    } finally {
      listening = false;
    }
  }

  return {
    kind: 'interval',

    async install(trigger: IntervalTriggerSpec): Promise<void> {
      const periodMinutes = normalizePeriodMinutes(trigger.periodMinutes);

      const version = bumpVersion(trigger.id);
      installed.set(trigger.id, {
        spec: { ...trigger, periodMinutes },
        periodMinutes,
        version,
      });

      ensureListening();
      await schedule(trigger.id, version);
    },

    async uninstall(triggerId: string): Promise<void> {
      const id = triggerId as TriggerId;
      bumpVersion(id);
      installed.delete(id);
      await clearAlarmByName(alarmNameForTrigger(id));

      if (installed.size === 0) {
        stopListening();
      }
    },

    async uninstallAll(): Promise<void> {
      for (const id of installed.keys()) {
        bumpVersion(id);
      }
      installed.clear();
      await clearAllIntervalAlarms();
      stopListening();
    },

    getInstalledIds(): string[] {
      return Array.from(installed.keys());
    },
  };
}
