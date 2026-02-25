/**
 * @fileoverview Interval Trigger Handler Tests
 * @description 测试 interval 触发器的安装、卸载和触发行为
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TriggerId, FlowId } from '@/entrypoints/background/record-replay-v3/domain/ids';
import type { TriggerSpecByKind } from '@/entrypoints/background/record-replay-v3/domain/triggers';
import type { TriggerFireCallback } from '@/entrypoints/background/record-replay-v3/engine/triggers/trigger-handler';
import { createIntervalTriggerHandler } from '@/entrypoints/background/record-replay-v3/engine/triggers/interval-trigger';

// ==================== Test Utilities ====================

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockFireCallback(): TriggerFireCallback & { calls: Array<{ triggerId: string }> } {
  const calls: Array<{ triggerId: string }> = [];
  return {
    calls,
    onFire: vi.fn(async (triggerId) => {
      calls.push({ triggerId });
    }),
  };
}

function createIntervalTriggerSpec(
  overrides: Partial<TriggerSpecByKind<'interval'>> = {},
): TriggerSpecByKind<'interval'> {
  return {
    id: 'interval-trigger-1' as TriggerId,
    kind: 'interval',
    flowId: 'flow-1' as FlowId,
    enabled: true,
    periodMinutes: 5,
    ...overrides,
  };
}

// ==================== Mock chrome.alarms ====================

let alarmListeners: Array<(alarm: chrome.alarms.Alarm) => void> = [];
let createdAlarms: Map<string, { periodInMinutes?: number; delayInMinutes?: number }> = new Map();

function setupMockChromeAlarms() {
  alarmListeners = [];
  createdAlarms = new Map();

  const alarms = {
    create: vi.fn((name: string, info: { periodInMinutes?: number; delayInMinutes?: number }) => {
      createdAlarms.set(name, info);
      return Promise.resolve();
    }),
    clear: vi.fn((name: string) => {
      createdAlarms.delete(name);
      return Promise.resolve(true);
    }),
    getAll: vi.fn(() => {
      return Promise.resolve(
        Array.from(createdAlarms.entries()).map(([name]) => ({ name, scheduledTime: 0 })),
      );
    }),
    onAlarm: {
      addListener: vi.fn((listener: (alarm: chrome.alarms.Alarm) => void) => {
        alarmListeners.push(listener);
      }),
      removeListener: vi.fn((listener: (alarm: chrome.alarms.Alarm) => void) => {
        alarmListeners = alarmListeners.filter((l) => l !== listener);
      }),
    },
  };

  (globalThis as unknown as { chrome: { alarms: typeof alarms } }).chrome = { alarms };

  return alarms;
}

function simulateAlarmFire(name: string) {
  for (const listener of alarmListeners) {
    listener({ name, scheduledTime: Date.now() });
  }
}

// ==================== Tests ====================

describe('IntervalTriggerHandler', () => {
  let mockAlarms: ReturnType<typeof setupMockChromeAlarms>;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let fireCallback: ReturnType<typeof createMockFireCallback>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAlarms = setupMockChromeAlarms();
    mockLogger = createMockLogger();
    fireCallback = createMockFireCallback();
  });

  describe('install', () => {
    it('creates repeating alarm with correct periodInMinutes', async () => {
      const handler = createIntervalTriggerHandler(fireCallback, { logger: mockLogger });
      const trigger = createIntervalTriggerSpec({ periodMinutes: 10 });

      await handler.install(trigger);

      expect(mockAlarms.create).toHaveBeenCalledWith(
        'rr_v3_interval_interval-trigger-1',
        expect.objectContaining({
          periodInMinutes: 10,
          delayInMinutes: 10,
        }),
      );
    });

    it('adds alarm listener on first install', async () => {
      const handler = createIntervalTriggerHandler(fireCallback, { logger: mockLogger });

      expect(mockAlarms.onAlarm.addListener).not.toHaveBeenCalled();

      await handler.install(createIntervalTriggerSpec());

      expect(mockAlarms.onAlarm.addListener).toHaveBeenCalledTimes(1);
    });

    it('registers trigger ID', async () => {
      const handler = createIntervalTriggerHandler(fireCallback, { logger: mockLogger });
      const trigger = createIntervalTriggerSpec();

      await handler.install(trigger);

      expect(handler.getInstalledIds()).toContain(trigger.id);
    });

    it('throws error for invalid periodMinutes', async () => {
      const handler = createIntervalTriggerHandler(fireCallback, { logger: mockLogger });

      await expect(
        handler.install(createIntervalTriggerSpec({ periodMinutes: 0 })),
      ).rejects.toThrow('periodMinutes must be >= 1');

      await expect(
        handler.install(createIntervalTriggerSpec({ periodMinutes: -5 })),
      ).rejects.toThrow('periodMinutes must be >= 1');

      await expect(
        handler.install(createIntervalTriggerSpec({ periodMinutes: NaN as number })),
      ).rejects.toThrow('periodMinutes must be a finite number');
    });
  });

  describe('uninstall', () => {
    it('clears alarm and removes trigger from installed list', async () => {
      const handler = createIntervalTriggerHandler(fireCallback, { logger: mockLogger });
      const trigger = createIntervalTriggerSpec();

      await handler.install(trigger);
      expect(handler.getInstalledIds()).toContain(trigger.id);

      await handler.uninstall(trigger.id);

      expect(mockAlarms.clear).toHaveBeenCalledWith('rr_v3_interval_interval-trigger-1');
      expect(handler.getInstalledIds()).not.toContain(trigger.id);
    });

    it('removes alarm listener when last trigger is uninstalled', async () => {
      const handler = createIntervalTriggerHandler(fireCallback, { logger: mockLogger });
      const trigger = createIntervalTriggerSpec();

      await handler.install(trigger);
      await handler.uninstall(trigger.id);

      expect(mockAlarms.onAlarm.removeListener).toHaveBeenCalled();
    });
  });

  describe('uninstallAll', () => {
    it('clears all interval alarms', async () => {
      const handler = createIntervalTriggerHandler(fireCallback, { logger: mockLogger });

      await handler.install(createIntervalTriggerSpec({ id: 'trigger-1' as TriggerId }));
      await handler.install(createIntervalTriggerSpec({ id: 'trigger-2' as TriggerId }));

      await handler.uninstallAll();

      expect(handler.getInstalledIds()).toHaveLength(0);
      expect(mockAlarms.onAlarm.removeListener).toHaveBeenCalled();
    });
  });

  describe('alarm handling', () => {
    it('fires callback when alarm triggers', async () => {
      const handler = createIntervalTriggerHandler(fireCallback, { logger: mockLogger });
      const trigger = createIntervalTriggerSpec();

      await handler.install(trigger);

      // Simulate alarm fire
      simulateAlarmFire('rr_v3_interval_interval-trigger-1');

      // Wait for async callback
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fireCallback.onFire).toHaveBeenCalledWith(
        trigger.id,
        expect.objectContaining({
          sourceTabId: undefined,
          sourceUrl: undefined,
        }),
      );
    });

    it('ignores alarms from other handlers', async () => {
      const handler = createIntervalTriggerHandler(fireCallback, { logger: mockLogger });
      await handler.install(createIntervalTriggerSpec());

      // Simulate alarm from different handler
      simulateAlarmFire('rr_v3_cron_some-other-trigger');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fireCallback.onFire).not.toHaveBeenCalled();
    });

    it('ignores alarms for uninstalled triggers', async () => {
      const handler = createIntervalTriggerHandler(fireCallback, { logger: mockLogger });
      const trigger = createIntervalTriggerSpec();

      await handler.install(trigger);
      await handler.uninstall(trigger.id);

      simulateAlarmFire('rr_v3_interval_interval-trigger-1');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fireCallback.onFire).not.toHaveBeenCalled();
    });
  });
});
