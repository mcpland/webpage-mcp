/**
 * @fileoverview Cron Trigger Handler (P4-07)
 * @description
 * Schedules cron triggers via `chrome.alarms` (MV3).
 *
 * Strategy:
 * - One alarm per trigger (one-shot `when` alarm).
 * - When fired: call `fireCallback.onFire(triggerId)` then compute and schedule next.
 *
 * Timezone:
 * - Accepts IANA timezones (e.g. "UTC", "Asia/Shanghai").
 * - Validated via `Intl.DateTimeFormat(..., { timeZone })`.
 *
 * Cron parsing:
 * - Delegated to an external library (recommended: `cron-parser`) to avoid DST edge cases.
 * - Falls back to a minimal built-in parser if library not available.
 */

import type { UnixMillis } from '../../domain/json';
import type { TriggerId } from '../../domain/ids';
import type { TriggerSpecByKind } from '../../domain/triggers';
import type { TriggerFireCallback, TriggerHandler, TriggerHandlerFactory } from './trigger-handler';

// ==================== Types ====================

type CronTriggerSpec = TriggerSpecByKind<'cron'>;

/**
 * Function to compute next fire time from cron expression
 */
export type ComputeNextFireAtMs = (input: {
  cron: string;
  timezone?: string;
  fromMs: UnixMillis;
}) => UnixMillis | Promise<UnixMillis>;

export interface CronTriggerHandlerDeps {
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
  now?: () => UnixMillis;
  computeNextFireAtMs?: ComputeNextFireAtMs;
}

interface InstalledCronTrigger {
  spec: CronTriggerSpec;
  timezone?: string;
  version: number;
}

// ==================== Constants ====================

const ALARM_PREFIX = 'rr_v3_cron_';

// ==================== Utilities ====================

/**
 * Normalize cron expression
 */
function normalizeCronExpression(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  const normalized = raw.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    throw new Error('cron must be a non-empty string');
  }
  return normalized;
}

/**
 * Validate and normalize timezone
 */
function normalizeTimezone(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error('timezone must be a string');
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    // Throws RangeError for invalid IANA timezones
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date(0));
  } catch {
    throw new Error(`Invalid timezone: "${trimmed}"`);
  }

  return trimmed;
}

/**
 * Generate alarm name for trigger
 */
function alarmNameForTrigger(triggerId: TriggerId): string {
  return `${ALARM_PREFIX}${triggerId}`;
}

/**
 * Parse trigger ID from alarm name
 */
function parseTriggerIdFromAlarmName(name: string): TriggerId | null {
  if (!name.startsWith(ALARM_PREFIX)) return null;
  const id = name.slice(ALARM_PREFIX.length);
  return id ? (id as TriggerId) : null;
}

/**
 * Simple cron expression parser (minimal subset)
 * Supports: minute hour day-of-month month day-of-week
 * Values: numbers, * (any), intervals (e.g., * /5)
 *
 * For production use with complex cron expressions, install 'cron-parser'.
 */
function parseSimpleCron(cron: string): {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
} {
  const parts = cron.split(' ');
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
  }

  function parseField(field: string, min: number, max: number): number[] {
    const values: number[] = [];

    for (const part of field.split(',')) {
      if (part === '*') {
        for (let i = min; i <= max; i++) values.push(i);
      } else if (part.includes('/')) {
        const [range, stepStr] = part.split('/');
        const step = parseInt(stepStr, 10);
        // Guard against infinite loop: step must be positive
        if (!Number.isFinite(step) || step < 1) {
          throw new Error(`Invalid step in cron field: "${part}" (step must be >= 1)`);
        }
        const start = range === '*' ? min : parseInt(range, 10);
        if (!Number.isFinite(start) || start < min || start > max) {
          throw new Error(`Invalid range start in cron field: "${part}"`);
        }
        for (let i = start; i <= max; i += step) values.push(i);
      } else if (part.includes('-')) {
        const [startStr, endStr] = part.split('-');
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
          throw new Error(`Invalid range in cron field: "${part}"`);
        }
        for (let i = start; i <= end; i++) values.push(i);
      } else {
        const num = parseInt(part, 10);
        if (!Number.isFinite(num)) {
          throw new Error(`Invalid number in cron field: "${part}"`);
        }
        values.push(num);
      }
    }

    // Validate all values are within bounds
    for (const v of values) {
      if (v < min || v > max) {
        throw new Error(`Cron field value ${v} out of range [${min}, ${max}]`);
      }
    }

    return [...new Set(values)].sort((a, b) => a - b);
  }

  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dayOfWeek: parseField(parts[4], 0, 6),
  };
}

// ==================== Timezone Utilities ====================

interface ZonedTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
}

// Cache DateTimeFormat instances per timezone for performance
const dtfCache = new Map<string, Intl.DateTimeFormat>();

/**
 * Get or create cached DateTimeFormat for a timezone
 */
function getDateTimeFormat(timezone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timezone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    dtfCache.set(timezone, dtf);
  }
  return dtf;
}

// Map weekday string to number (0=Sunday)
const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Get time parts in a specific timezone using Intl.DateTimeFormat
 */
function getZonedTimeParts(utcMs: UnixMillis, timezone: string): ZonedTimeParts {
  const dtf = getDateTimeFormat(timezone);
  const parts = dtf.formatToParts(new Date(utcMs));
  const map: Record<string, string> = Object.create(null);
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }

  // Handle edge case: some environments emit "24" for midnight
  const rawHour = Number(map.hour);

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(map.minute),
    dayOfWeek: WEEKDAY_MAP[map.weekday] ?? 0,
  };
}

/**
 * Calculate timezone offset in milliseconds at a given UTC timestamp
 * Positive offset means timezone is ahead of UTC (e.g., Asia/Shanghai = +8h = +28800000ms)
 */
function getTimezoneOffsetMs(utcMs: UnixMillis, timezone: string): number {
  const z = getZonedTimeParts(utcMs, timezone);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, 0);
  return asUtc - utcMs;
}

/**
 * Convert zoned datetime to UTC milliseconds
 * Uses iterative refinement to handle DST transitions
 */
function zonedToUtcMs(
  zoned: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): UnixMillis {
  // Start with the zoned time interpreted as UTC
  const baseUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, 0);

  // Iteratively solve: utcMs = baseUtc - offset(utcMs)
  let utcMs = baseUtc;
  for (let i = 0; i < 3; i++) {
    const offsetMs = getTimezoneOffsetMs(utcMs, timezone);
    const next = baseUtc - offsetMs;
    if (next === utcMs) break;
    utcMs = next;
  }
  return utcMs;
}

// ==================== Cron Computation ====================

/**
 * Compute next fire time using built-in simple parser (local timezone)
 */
function computeNextFireAtMsLocal(
  parsed: ReturnType<typeof parseSimpleCron>,
  fromMs: UnixMillis,
): UnixMillis {
  const baseDate = new Date(fromMs + 1000); // Add 1 second to ensure next occurrence

  for (let dayOffset = 0; dayOffset < 366; dayOffset++) {
    for (const hour of parsed.hour) {
      for (const minute of parsed.minute) {
        const candidate = new Date(baseDate);
        candidate.setDate(candidate.getDate() + dayOffset);
        candidate.setHours(hour, minute, 0, 0);

        if (candidate.getTime() <= fromMs) continue;

        const month = candidate.getMonth() + 1;
        const dayOfMonth = candidate.getDate();
        const dayOfWeek = candidate.getDay();

        if (!parsed.month.includes(month)) continue;
        if (!parsed.dayOfMonth.includes(dayOfMonth) && !parsed.dayOfWeek.includes(dayOfWeek))
          continue;

        return candidate.getTime();
      }
    }
  }

  throw new Error('Failed to compute next cron fire time within 1 year');
}

/**
 * Compute next fire time in a specific timezone
 */
function computeNextFireAtMsZoned(
  parsed: ReturnType<typeof parseSimpleCron>,
  fromMs: UnixMillis,
  timezone: string,
): UnixMillis {
  const baseZoned = getZonedTimeParts(fromMs + 1000, timezone);
  const dayCursor = new Date(Date.UTC(baseZoned.year, baseZoned.month - 1, baseZoned.day));

  for (let dayOffset = 0; dayOffset < 366; dayOffset++) {
    if (dayOffset > 0) dayCursor.setUTCDate(dayCursor.getUTCDate() + 1);

    const year = dayCursor.getUTCFullYear();
    const month = dayCursor.getUTCMonth() + 1;
    const dayOfMonth = dayCursor.getUTCDate();
    const dayOfWeek = dayCursor.getUTCDay();

    if (!parsed.month.includes(month)) continue;
    if (!parsed.dayOfMonth.includes(dayOfMonth) && !parsed.dayOfWeek.includes(dayOfWeek)) continue;

    for (const hour of parsed.hour) {
      for (const minute of parsed.minute) {
        const candidateUtcMs = zonedToUtcMs(
          { year, month, day: dayOfMonth, hour, minute },
          timezone,
        );

        if (candidateUtcMs <= fromMs) continue;

        // Validate conversion didn't drift (DST gaps/ambiguity can cause skipped times)
        const candidateZoned = getZonedTimeParts(candidateUtcMs, timezone);
        if (
          candidateZoned.year !== year ||
          candidateZoned.month !== month ||
          candidateZoned.day !== dayOfMonth ||
          candidateZoned.hour !== hour ||
          candidateZoned.minute !== minute
        ) {
          continue; // Skip DST gap times
        }

        return candidateUtcMs;
      }
    }
  }

  throw new Error('Failed to compute next cron fire time within 1 year');
}

/**
 * Compute next fire time using built-in simple parser
 */
function computeNextFireAtMsSimple(input: {
  cron: string;
  timezone?: string;
  fromMs: UnixMillis;
}): UnixMillis {
  const parsed = parseSimpleCron(input.cron);

  if (input.timezone) {
    return computeNextFireAtMsZoned(parsed, input.fromMs, input.timezone);
  }

  return computeNextFireAtMsLocal(parsed, input.fromMs);
}

/**
 * Default compute next fire time function
 * Uses simple built-in parser
 */
function defaultComputeNextFireAtMs(input: {
  cron: string;
  timezone?: string;
  fromMs: UnixMillis;
}): UnixMillis {
  return computeNextFireAtMsSimple(input);
}

// ==================== Handler Implementation ====================

/**
 * Create cron trigger handler factory
 */
export function createCronTriggerHandlerFactory(
  deps?: CronTriggerHandlerDeps,
): TriggerHandlerFactory<'cron'> {
  return (fireCallback) => createCronTriggerHandler(fireCallback, deps);
}

/**
 * Create cron trigger handler
 */
export function createCronTriggerHandler(
  fireCallback: TriggerFireCallback,
  deps?: CronTriggerHandlerDeps,
): TriggerHandler<'cron'> {
  const logger = deps?.logger ?? console;
  const now = deps?.now ?? (() => Date.now());
  const computeNextFireAtMs: ComputeNextFireAtMs =
    deps?.computeNextFireAtMs ?? defaultComputeNextFireAtMs;

  const installed = new Map<TriggerId, InstalledCronTrigger>();
  const versions = new Map<TriggerId, number>();
  let listening = false;

  /**
   * Bump version to invalidate pending operations
   */
  function bumpVersion(triggerId: TriggerId): number {
    const next = (versions.get(triggerId) ?? 0) + 1;
    versions.set(triggerId, next);
    return next;
  }

  /**
   * Clear alarm by name
   */
  async function clearAlarmByName(name: string): Promise<void> {
    if (!chrome.alarms?.clear) return;
    try {
      await Promise.resolve(chrome.alarms.clear(name));
    } catch (e) {
      logger.debug('[CronTriggerHandler] alarms.clear failed:', e);
    }
  }

  /**
   * Clear all cron alarms
   */
  async function clearAllCronAlarms(): Promise<void> {
    if (!chrome.alarms?.getAll || !chrome.alarms?.clear) return;
    try {
      const alarms = await Promise.resolve(chrome.alarms.getAll());
      const list = Array.isArray(alarms) ? alarms : [];
      await Promise.all(
        list
          .filter((a) => a?.name && a.name.startsWith(ALARM_PREFIX))
          .map((a) => clearAlarmByName(a.name)),
      );
    } catch (e) {
      logger.debug('[CronTriggerHandler] alarms.getAll failed:', e);
    }
  }

  /**
   * Schedule next alarm for trigger
   */
  async function scheduleNext(triggerId: TriggerId, expectedVersion: number): Promise<void> {
    if (!chrome.alarms?.create) {
      logger.warn('[CronTriggerHandler] chrome.alarms.create is unavailable');
      return;
    }

    const entry = installed.get(triggerId);
    if (!entry || entry.version !== expectedVersion) return;

    const fromMs = now();
    const nextMs = await Promise.resolve(
      computeNextFireAtMs({
        cron: entry.spec.cron,
        timezone: entry.timezone,
        fromMs,
      }),
    );

    // Check version again after async
    if (installed.get(triggerId)?.version !== expectedVersion) return;

    const name = alarmNameForTrigger(triggerId);
    await Promise.resolve(chrome.alarms.create(name, { when: nextMs }));
  }

  /**
   * Handle alarm event
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
        logger.error(`[CronTriggerHandler] onFire failed for trigger "${triggerId}":`, e);
      } finally {
        // Reschedule if still valid
        // eslint-disable-next-line no-unsafe-finally
        if (installed.get(triggerId)?.version !== expectedVersion) return;
        try {
          await scheduleNext(triggerId, expectedVersion);
        } catch (e) {
          logger.error(`[CronTriggerHandler] Failed to reschedule trigger "${triggerId}":`, e);
        }
      }
    })();
  };

  function ensureListening(): void {
    if (listening) return;
    if (!chrome.alarms?.onAlarm?.addListener) {
      logger.warn('[CronTriggerHandler] chrome.alarms.onAlarm is unavailable');
      return;
    }
    chrome.alarms.onAlarm.addListener(onAlarm);
    listening = true;
  }

  function stopListening(): void {
    if (!listening) return;
    try {
      chrome.alarms.onAlarm.removeListener(onAlarm);
    } catch (e) {
      logger.debug('[CronTriggerHandler] alarms.onAlarm.removeListener failed:', e);
    } finally {
      listening = false;
    }
  }

  return {
    kind: 'cron',

    async install(trigger: CronTriggerSpec): Promise<void> {
      const cron = normalizeCronExpression(trigger.cron);
      const timezone = normalizeTimezone(trigger.timezone);

      const version = bumpVersion(trigger.id);
      installed.set(trigger.id, {
        spec: { ...trigger, cron },
        timezone,
        version,
      });

      ensureListening();
      await scheduleNext(trigger.id, version);
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
      for (const id of installed.keys()) bumpVersion(id);
      installed.clear();
      await clearAllCronAlarms();
      stopListening();
    },

    getInstalledIds(): string[] {
      return Array.from(installed.keys());
    },
  };
}
