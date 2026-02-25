/**
 * @fileoverview Cron Trigger Handler 测试 (P4-07)
 * @description
 * Tests for:
 * - Alarm scheduling on install
 * - Firing and rescheduling on alarm
 * - Timezone validation
 * - Listener lifecycle
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TriggerSpecByKind } from '@/entrypoints/background/record-replay-v3/domain/triggers';
import type { TriggerFireCallback } from '@/entrypoints/background/record-replay-v3/engine/triggers/trigger-handler';
import { createCronTriggerHandlerFactory } from '@/entrypoints/background/record-replay-v3/engine/triggers/cron-trigger';

// ==================== Test Utilities ====================

function createSilentLogger(): Pick<Console, 'debug' | 'info' | 'warn' | 'error'> {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

interface AlarmsMock {
  create: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  getAll: ReturnType<typeof vi.fn>;
  onAlarm: {
    addListener: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };
  emit: (name: string) => void;
  createdAlarms: Map<string, { when?: number }>;
}

function createAlarmsMock(): AlarmsMock {
  const listeners = new Set<(alarm: { name: string }) => void>();
  const createdAlarms = new Map<string, { when?: number }>();

  const onAlarm = {
    addListener: vi.fn((cb: (alarm: { name: string }) => void) => listeners.add(cb)),
    removeListener: vi.fn((cb: (alarm: { name: string }) => void) => listeners.delete(cb)),
  };

  const create = vi.fn((name: string, info: { when?: number }) => {
    createdAlarms.set(name, info);
    return undefined;
  });

  const clear = vi.fn((name: string) => {
    createdAlarms.delete(name);
    return true;
  });

  const getAll = vi.fn(async () =>
    Array.from(createdAlarms.entries()).map(([name, info]) => ({
      name,
      scheduledTime: info.when ?? 0,
    })),
  );

  return {
    create,
    clear,
    getAll,
    onAlarm,
    emit: (name) => {
      for (const cb of listeners) cb({ name });
    },
    createdAlarms,
  };
}

// ==================== Cron Trigger Tests ====================

describe('V3 CronTriggerHandler', () => {
  let alarms: AlarmsMock;

  beforeEach(() => {
    alarms = createAlarmsMock();
    (globalThis.chrome as unknown as { alarms: unknown }).alarms = {
      create: alarms.create,
      clear: alarms.clear,
      getAll: alarms.getAll,
      onAlarm: alarms.onAlarm,
    };
  });

  describe('Installation and scheduling', () => {
    it('schedules alarm on install', async () => {
      const nowMs = 1_700_000_000_000;
      const now = vi.fn(() => nowMs);
      const computeNext = vi.fn(async ({ fromMs }: { fromMs: number }) => fromMs + 60_000);

      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCronTriggerHandlerFactory({
        logger: createSilentLogger(),
        now,
        computeNextFireAtMs: computeNext,
      })(fireCallback);

      const trigger: TriggerSpecByKind<'cron'> = {
        id: 't1' as never,
        kind: 'cron',
        enabled: true,
        flowId: 'flow-1' as never,
        cron: '0 9 * * *',
        timezone: 'UTC',
      };

      await handler.install(trigger);

      expect(alarms.onAlarm.addListener).toHaveBeenCalledTimes(1);
      expect(alarms.create).toHaveBeenCalledWith('rr_v3_cron_t1', { when: nowMs + 60_000 });
      expect(computeNext).toHaveBeenCalledWith({
        cron: '0 9 * * *',
        timezone: 'UTC',
        fromMs: nowMs,
      });
    });

    it('passes timezone to computeNextFireAtMs', async () => {
      const computeNext = vi.fn(async ({ fromMs }: { fromMs: number }) => fromMs + 60_000);

      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCronTriggerHandlerFactory({
        logger: createSilentLogger(),
        now: () => 0,
        computeNextFireAtMs: computeNext,
      })(fireCallback);

      await handler.install({
        id: 't1' as never,
        kind: 'cron',
        enabled: true,
        flowId: 'flow-1' as never,
        cron: '0 9 * * *',
        timezone: 'Asia/Shanghai',
      });

      expect(computeNext).toHaveBeenCalledWith(
        expect.objectContaining({
          timezone: 'Asia/Shanghai',
        }),
      );
    });
  });

  describe('Alarm firing', () => {
    it('fires callback on alarm and reschedules', async () => {
      const nowMs = 1_700_000_000_000;
      const now = vi.fn(() => nowMs);
      const computeNext = vi.fn(async ({ fromMs }: { fromMs: number }) => fromMs + 60_000);

      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCronTriggerHandlerFactory({
        logger: createSilentLogger(),
        now,
        computeNextFireAtMs: computeNext,
      })(fireCallback);

      await handler.install({
        id: 't1' as never,
        kind: 'cron',
        enabled: true,
        flowId: 'flow-1' as never,
        cron: '0 9 * * *',
      });

      alarms.emit('rr_v3_cron_t1');
      await new Promise((r) => setTimeout(r, 0));

      expect(fireCallback.onFire).toHaveBeenCalledWith('t1', {
        sourceTabId: undefined,
        sourceUrl: undefined,
      });

      // Should reschedule
      expect(alarms.create).toHaveBeenCalledTimes(2);
    });

    it('ignores unrelated alarms', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCronTriggerHandlerFactory({
        logger: createSilentLogger(),
        now: () => 0,
        computeNextFireAtMs: () => 60_000,
      })(fireCallback);

      await handler.install({
        id: 't1' as never,
        kind: 'cron',
        enabled: true,
        flowId: 'flow-1' as never,
        cron: '*/5 * * * *',
      });

      alarms.emit('other_alarm');
      await new Promise((r) => setTimeout(r, 0));

      expect(fireCallback.onFire).not.toHaveBeenCalled();
    });

    it('ignores alarm for uninstalled trigger', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCronTriggerHandlerFactory({
        logger: createSilentLogger(),
        now: () => 0,
        computeNextFireAtMs: () => 60_000,
      })(fireCallback);

      await handler.install({
        id: 't1' as never,
        kind: 'cron',
        enabled: true,
        flowId: 'flow-1' as never,
        cron: '*/5 * * * *',
      });

      await handler.uninstall('t1');

      alarms.emit('rr_v3_cron_t1');
      await new Promise((r) => setTimeout(r, 0));

      expect(fireCallback.onFire).not.toHaveBeenCalled();
    });
  });

  describe('Uninstallation', () => {
    it('clears alarm on uninstall', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCronTriggerHandlerFactory({
        logger: createSilentLogger(),
        now: () => 0,
        computeNextFireAtMs: () => 60_000,
      })(fireCallback);

      await handler.install({
        id: 't1' as never,
        kind: 'cron',
        enabled: true,
        flowId: 'flow-1' as never,
        cron: '*/5 * * * *',
      });

      await handler.uninstall('t1');

      expect(alarms.clear).toHaveBeenCalledWith('rr_v3_cron_t1');
    });

    it('stops listening when all triggers uninstalled', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCronTriggerHandlerFactory({
        logger: createSilentLogger(),
        now: () => 0,
        computeNextFireAtMs: () => 60_000,
      })(fireCallback);

      await handler.install({
        id: 't1' as never,
        kind: 'cron',
        enabled: true,
        flowId: 'flow-1' as never,
        cron: '*/5 * * * *',
      });

      await handler.uninstall('t1');

      expect(alarms.onAlarm.removeListener).toHaveBeenCalledTimes(1);
    });

    it('uninstallAll clears all cron alarms', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCronTriggerHandlerFactory({
        logger: createSilentLogger(),
        now: () => 0,
        computeNextFireAtMs: () => 60_000,
      })(fireCallback);

      await handler.install({
        id: 't1' as never,
        kind: 'cron',
        enabled: true,
        flowId: 'flow-1' as never,
        cron: '*/5 * * * *',
      });

      await handler.install({
        id: 't2' as never,
        kind: 'cron',
        enabled: true,
        flowId: 'flow-2' as never,
        cron: '0 * * * *',
      });

      await handler.uninstallAll();

      expect(alarms.clear).toHaveBeenCalledWith('rr_v3_cron_t1');
      expect(alarms.clear).toHaveBeenCalledWith('rr_v3_cron_t2');
      expect(alarms.onAlarm.removeListener).toHaveBeenCalledTimes(1);
    });
  });

  describe('Timezone computation', () => {
    it('computes different next fire times for different timezones', async () => {
      // Use default computeNextFireAtMs (built-in parser with timezone support)
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCronTriggerHandlerFactory({
        logger: createSilentLogger(),
        // Don't override computeNextFireAtMs to test actual implementation
      })(fireCallback);

      // Install with UTC timezone
      await handler.install({
        id: 'utc' as never,
        kind: 'cron',
        enabled: true,
        flowId: 'flow-1' as never,
        cron: '0 9 * * *', // 9:00 AM every day
        timezone: 'UTC',
      });

      const utcAlarm = alarms.createdAlarms.get('rr_v3_cron_utc');
      expect(utcAlarm?.when).toBeDefined();
      const utcFireTime = utcAlarm!.when!;

      // Uninstall and reinstall with different timezone
      await handler.uninstall('utc');

      await handler.install({
        id: 'shanghai' as never,
        kind: 'cron',
        enabled: true,
        flowId: 'flow-1' as never,
        cron: '0 9 * * *', // 9:00 AM every day (in Asia/Shanghai)
        timezone: 'Asia/Shanghai',
      });

      const shanghaiAlarm = alarms.createdAlarms.get('rr_v3_cron_shanghai');
      expect(shanghaiAlarm?.when).toBeDefined();
      const shanghaiFireTime = shanghaiAlarm!.when!;

      // Asia/Shanghai is UTC+8, so 9:00 AM Shanghai = 1:00 AM UTC
      // The fire times should differ by 8 hours (28800000 ms)
      const diff = Math.abs(utcFireTime - shanghaiFireTime);

      // Allow for some variance due to DST and date boundaries
      // The key assertion is that they're NOT equal
      expect(utcFireTime).not.toBe(shanghaiFireTime);
      // Should be close to 8 hours difference (within 1 day variance for date boundary cases)
      expect(diff).toBeLessThanOrEqual(24 * 60 * 60 * 1000); // max 1 day difference
    });

    it('computes correctly at fixed point in time', async () => {
      // Fix time to a known point: 2024-01-15 00:00:00 UTC (a Monday)
      const fixedNow = Date.UTC(2024, 0, 15, 0, 0, 0);
      const now = vi.fn(() => fixedNow);

      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCronTriggerHandlerFactory({
        logger: createSilentLogger(),
        now,
        // Use default computeNextFireAtMs
      })(fireCallback);

      // Cron: 0 9 * * * = 9:00 AM every day in UTC
      await handler.install({
        id: 't1' as never,
        kind: 'cron',
        enabled: true,
        flowId: 'flow-1' as never,
        cron: '0 9 * * *',
        timezone: 'UTC',
      });

      const alarm = alarms.createdAlarms.get('rr_v3_cron_t1');
      expect(alarm?.when).toBeDefined();

      // Expected: 2024-01-15 09:00:00 UTC
      const expected = Date.UTC(2024, 0, 15, 9, 0, 0);
      expect(alarm!.when).toBe(expected);
    });
  });

  describe('Validation', () => {
    it('rejects invalid timezone', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCronTriggerHandlerFactory({
        logger: createSilentLogger(),
        now: () => 0,
        computeNextFireAtMs: () => 60_000,
      })(fireCallback);

      await expect(
        handler.install({
          id: 't1' as never,
          kind: 'cron',
          enabled: true,
          flowId: 'flow-1' as never,
          cron: '0 9 * * *',
          timezone: 'Invalid/Zone',
        }),
      ).rejects.toThrow('Invalid timezone');
    });

    it('rejects empty cron expression', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCronTriggerHandlerFactory({
        logger: createSilentLogger(),
        now: () => 0,
        computeNextFireAtMs: () => 60_000,
      })(fireCallback);

      await expect(
        handler.install({
          id: 't1' as never,
          kind: 'cron',
          enabled: true,
          flowId: 'flow-1' as never,
          cron: '   ',
        }),
      ).rejects.toThrow('cron must be a non-empty string');
    });

    it('rejects invalid cron step (*/0 infinite loop prevention)', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCronTriggerHandlerFactory({
        logger: createSilentLogger(),
        // Use default computeNextFireAtMs to test built-in parser
      })(fireCallback);

      await expect(
        handler.install({
          id: 't1' as never,
          kind: 'cron',
          enabled: true,
          flowId: 'flow-1' as never,
          cron: '*/0 * * * *', // Invalid: step of 0
        }),
      ).rejects.toThrow('step must be >= 1');
    });

    it('rejects negative step values', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCronTriggerHandlerFactory({
        logger: createSilentLogger(),
      })(fireCallback);

      await expect(
        handler.install({
          id: 't1' as never,
          kind: 'cron',
          enabled: true,
          flowId: 'flow-1' as never,
          cron: '*/-5 * * * *', // Invalid: negative step
        }),
      ).rejects.toThrow('step must be >= 1');
    });

    it('rejects cron with wrong number of fields', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCronTriggerHandlerFactory({
        logger: createSilentLogger(),
      })(fireCallback);

      await expect(
        handler.install({
          id: 't1' as never,
          kind: 'cron',
          enabled: true,
          flowId: 'flow-1' as never,
          cron: '0 9 * *', // Only 4 fields
        }),
      ).rejects.toThrow('expected 5 fields');
    });
  });

  describe('getInstalledIds', () => {
    it('returns installed trigger IDs', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCronTriggerHandlerFactory({
        logger: createSilentLogger(),
        now: () => 0,
        computeNextFireAtMs: () => 60_000,
      })(fireCallback);

      await handler.install({
        id: 't1' as never,
        kind: 'cron',
        enabled: true,
        flowId: 'flow-1' as never,
        cron: '*/5 * * * *',
      });

      await handler.install({
        id: 't2' as never,
        kind: 'cron',
        enabled: true,
        flowId: 'flow-2' as never,
        cron: '0 * * * *',
      });

      expect(handler.getInstalledIds().sort()).toEqual(['t1', 't2']);

      await handler.uninstall('t1');
      expect(handler.getInstalledIds()).toEqual(['t2']);
    });
  });
});
