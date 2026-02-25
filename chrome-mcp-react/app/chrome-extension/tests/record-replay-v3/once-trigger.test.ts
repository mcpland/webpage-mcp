/**
 * @fileoverview Once Trigger Handler Tests
 * @description 测试 once 触发器的安装、卸载、触发和自动禁用行为
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TriggerId, FlowId } from '@/entrypoints/background/record-replay-v3/domain/ids';
import type { TriggerSpecByKind } from '@/entrypoints/background/record-replay-v3/domain/triggers';
import type { TriggerFireCallback } from '@/entrypoints/background/record-replay-v3/engine/triggers/trigger-handler';
import { createOnceTriggerHandler } from '@/entrypoints/background/record-replay-v3/engine/triggers/once-trigger';

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

function createOnceTriggerSpec(
  overrides: Partial<TriggerSpecByKind<'once'>> = {},
): TriggerSpecByKind<'once'> {
  return {
    id: 'once-trigger-1' as TriggerId,
    kind: 'once',
    flowId: 'flow-1' as FlowId,
    enabled: true,
    whenMs: Date.now() + 60000, // 1 minute from now
    ...overrides,
  };
}

// ==================== Mock chrome.alarms ====================

let alarmListeners: Array<(alarm: chrome.alarms.Alarm) => void> = [];
let createdAlarms: Map<string, { when?: number }> = new Map();

function setupMockChromeAlarms() {
  alarmListeners = [];
  createdAlarms = new Map();

  const alarms = {
    create: vi.fn((name: string, info: { when?: number }) => {
      createdAlarms.set(name, info);
      return Promise.resolve();
    }),
    clear: vi.fn((name: string) => {
      createdAlarms.delete(name);
      return Promise.resolve(true);
    }),
    getAll: vi.fn(() => {
      return Promise.resolve(
        Array.from(createdAlarms.entries()).map(([name, info]) => ({
          name,
          scheduledTime: info.when ?? 0,
        })),
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

describe('OnceTriggerHandler', () => {
  let mockAlarms: ReturnType<typeof setupMockChromeAlarms>;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let fireCallback: ReturnType<typeof createMockFireCallback>;
  let disabledTriggers: Set<TriggerId>;
  let mockDisableTrigger: (triggerId: TriggerId) => Promise<void>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAlarms = setupMockChromeAlarms();
    mockLogger = createMockLogger();
    fireCallback = createMockFireCallback();
    disabledTriggers = new Set();
    mockDisableTrigger = vi.fn(async (triggerId: TriggerId) => {
      disabledTriggers.add(triggerId);
    });
  });

  describe('install', () => {
    it('creates one-shot alarm with correct when timestamp', async () => {
      const handler = createOnceTriggerHandler(fireCallback, {
        logger: mockLogger,
        disableTrigger: mockDisableTrigger,
      });
      const futureTime = Date.now() + 300000; // 5 minutes
      const trigger = createOnceTriggerSpec({ whenMs: futureTime });

      await handler.install(trigger);

      expect(mockAlarms.create).toHaveBeenCalledWith(
        'rr_v3_once_once-trigger-1',
        expect.objectContaining({ when: futureTime }),
      );
    });

    it('adds alarm listener on first install', async () => {
      const handler = createOnceTriggerHandler(fireCallback, {
        logger: mockLogger,
        disableTrigger: mockDisableTrigger,
      });

      expect(mockAlarms.onAlarm.addListener).not.toHaveBeenCalled();

      await handler.install(createOnceTriggerSpec());

      expect(mockAlarms.onAlarm.addListener).toHaveBeenCalledTimes(1);
    });

    it('registers trigger ID', async () => {
      const handler = createOnceTriggerHandler(fireCallback, {
        logger: mockLogger,
        disableTrigger: mockDisableTrigger,
      });
      const trigger = createOnceTriggerSpec();

      await handler.install(trigger);

      expect(handler.getInstalledIds()).toContain(trigger.id);
    });

    it('throws error for invalid whenMs', async () => {
      const handler = createOnceTriggerHandler(fireCallback, {
        logger: mockLogger,
        disableTrigger: mockDisableTrigger,
      });

      await expect(
        handler.install(createOnceTriggerSpec({ whenMs: NaN as number })),
      ).rejects.toThrow('whenMs must be a finite number');

      await expect(
        handler.install(createOnceTriggerSpec({ whenMs: Infinity as number })),
      ).rejects.toThrow('whenMs must be a finite number');
    });

    it('floors whenMs to integer', async () => {
      const handler = createOnceTriggerHandler(fireCallback, {
        logger: mockLogger,
        disableTrigger: mockDisableTrigger,
      });
      const trigger = createOnceTriggerSpec({ whenMs: 1234567890123.999 });

      await handler.install(trigger);

      expect(mockAlarms.create).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ when: 1234567890123 }),
      );
    });
  });

  describe('uninstall', () => {
    it('clears alarm and removes trigger from installed list', async () => {
      const handler = createOnceTriggerHandler(fireCallback, {
        logger: mockLogger,
        disableTrigger: mockDisableTrigger,
      });
      const trigger = createOnceTriggerSpec();

      await handler.install(trigger);
      expect(handler.getInstalledIds()).toContain(trigger.id);

      await handler.uninstall(trigger.id);

      expect(mockAlarms.clear).toHaveBeenCalledWith('rr_v3_once_once-trigger-1');
      expect(handler.getInstalledIds()).not.toContain(trigger.id);
    });

    it('removes alarm listener when last trigger is uninstalled', async () => {
      const handler = createOnceTriggerHandler(fireCallback, {
        logger: mockLogger,
        disableTrigger: mockDisableTrigger,
      });
      const trigger = createOnceTriggerSpec();

      await handler.install(trigger);
      await handler.uninstall(trigger.id);

      expect(mockAlarms.onAlarm.removeListener).toHaveBeenCalled();
    });
  });

  describe('uninstallAll', () => {
    it('clears all once alarms', async () => {
      const handler = createOnceTriggerHandler(fireCallback, {
        logger: mockLogger,
        disableTrigger: mockDisableTrigger,
      });

      await handler.install(createOnceTriggerSpec({ id: 'trigger-1' as TriggerId }));
      await handler.install(createOnceTriggerSpec({ id: 'trigger-2' as TriggerId }));

      await handler.uninstallAll();

      expect(handler.getInstalledIds()).toHaveLength(0);
      expect(mockAlarms.onAlarm.removeListener).toHaveBeenCalled();
    });
  });

  describe('alarm handling', () => {
    it('fires callback when alarm triggers', async () => {
      const handler = createOnceTriggerHandler(fireCallback, {
        logger: mockLogger,
        disableTrigger: mockDisableTrigger,
      });
      const trigger = createOnceTriggerSpec();

      await handler.install(trigger);

      // Simulate alarm fire
      simulateAlarmFire('rr_v3_once_once-trigger-1');

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

    it('disables trigger after firing', async () => {
      const handler = createOnceTriggerHandler(fireCallback, {
        logger: mockLogger,
        disableTrigger: mockDisableTrigger,
      });
      const trigger = createOnceTriggerSpec();

      await handler.install(trigger);
      simulateAlarmFire('rr_v3_once_once-trigger-1');

      // Wait for async callback
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockDisableTrigger).toHaveBeenCalledWith(trigger.id);
      expect(disabledTriggers.has(trigger.id)).toBe(true);
    });

    it('uninstalls trigger after firing', async () => {
      const handler = createOnceTriggerHandler(fireCallback, {
        logger: mockLogger,
        disableTrigger: mockDisableTrigger,
      });
      const trigger = createOnceTriggerSpec();

      await handler.install(trigger);
      expect(handler.getInstalledIds()).toContain(trigger.id);

      simulateAlarmFire('rr_v3_once_once-trigger-1');

      // Wait for async cleanup
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(handler.getInstalledIds()).not.toContain(trigger.id);
    });

    it('ignores alarms from other handlers', async () => {
      const handler = createOnceTriggerHandler(fireCallback, {
        logger: mockLogger,
        disableTrigger: mockDisableTrigger,
      });
      await handler.install(createOnceTriggerSpec());

      // Simulate alarm from different handler
      simulateAlarmFire('rr_v3_interval_some-other-trigger');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fireCallback.onFire).not.toHaveBeenCalled();
    });

    it('ignores alarms for uninstalled triggers', async () => {
      const handler = createOnceTriggerHandler(fireCallback, {
        logger: mockLogger,
        disableTrigger: mockDisableTrigger,
      });
      const trigger = createOnceTriggerSpec();

      await handler.install(trigger);
      await handler.uninstall(trigger.id);

      simulateAlarmFire('rr_v3_once_once-trigger-1');

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fireCallback.onFire).not.toHaveBeenCalled();
    });
  });
});
