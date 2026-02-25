/**
 * @fileoverview TriggerManager 测试 (P4-02)
 * @description
 * Tests for:
 * - TriggerManager lifecycle (start/stop/refresh)
 * - Handler installation/uninstallation
 * - Trigger firing and enqueueRun
 * - Storm protection (cooldown, maxQueued)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowV3 } from '@/entrypoints/background/record-replay-v3/domain/flow';
import type { RunRecordV3 } from '@/entrypoints/background/record-replay-v3/domain/events';
import type {
  TriggerKind,
  TriggerSpec,
} from '@/entrypoints/background/record-replay-v3/domain/triggers';
import type { RunQueueItem } from '@/entrypoints/background/record-replay-v3/engine/queue/queue';
import type { StoragePort } from '@/entrypoints/background/record-replay-v3/engine/storage/storage-port';
import type { EventsBus } from '@/entrypoints/background/record-replay-v3/engine/transport/events-bus';
import type { RunScheduler } from '@/entrypoints/background/record-replay-v3/engine/queue/scheduler';
import type {
  TriggerFireCallback,
  TriggerHandler,
  TriggerHandlerFactory,
} from '@/entrypoints/background/record-replay-v3/engine/triggers/trigger-handler';
import { createTriggerManager } from '@/entrypoints/background/record-replay-v3/engine/triggers/trigger-manager';

// ==================== Test Utilities ====================

function createTestFlow(id: string): FlowV3 {
  return {
    schemaVersion: 3,
    id,
    name: 'Test Flow',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    entryNodeId: 'node-1',
    nodes: [{ id: 'node-1', kind: 'noop', config: {} }],
    edges: [],
  };
}

function createSilentLogger(): Pick<Console, 'debug' | 'info' | 'warn' | 'error'> {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

interface TestHandler {
  factory: TriggerHandlerFactory<TriggerKind>;
  handler: TriggerHandler<TriggerKind>;
  installed: Map<string, TriggerSpec>;
  fire: (triggerId: string, ctx: { sourceTabId?: number; sourceUrl?: string }) => Promise<void>;
}

function createTestHandler(kind: TriggerKind): TestHandler {
  const installed = new Map<string, TriggerSpec>();
  let callback: TriggerFireCallback | null = null;

  const handler: TriggerHandler<TriggerKind> = {
    kind,
    install: vi.fn(async (trigger: TriggerSpec) => {
      installed.set(trigger.id, trigger);
    }),
    uninstall: vi.fn(async (triggerId: string) => {
      installed.delete(triggerId);
    }),
    uninstallAll: vi.fn(async () => {
      installed.clear();
    }),
    getInstalledIds: vi.fn(() => Array.from(installed.keys())),
  };

  const factory: TriggerHandlerFactory<TriggerKind> = (fireCallback) => {
    callback = fireCallback;
    return handler;
  };

  const fire = async (triggerId: string, ctx: { sourceTabId?: number; sourceUrl?: string }) => {
    if (!callback) {
      throw new Error('fireCallback not initialized');
    }
    await callback.onFire(triggerId, ctx);
  };

  return { factory, handler, installed, fire };
}

// ==================== TriggerManager Tests ====================

describe('V3 TriggerManager', () => {
  let time: number;
  let runIdCounter: number;

  let triggersList: TriggerSpec[];
  let flowsMap: Map<string, FlowV3>;
  let runsMap: Map<string, RunRecordV3>;
  let queueMap: Map<string, RunQueueItem>;

  let storage: Pick<StoragePort, 'triggers' | 'flows' | 'runs' | 'queue'>;
  let events: Pick<EventsBus, 'append'>;
  let scheduler: Pick<RunScheduler, 'kick'>;

  beforeEach(() => {
    time = 1_700_000_000_000;
    runIdCounter = 0;

    triggersList = [];
    flowsMap = new Map();
    runsMap = new Map();
    queueMap = new Map();

    storage = {
      triggers: {
        list: vi.fn(async () => triggersList),
        get: vi.fn(async (id: string) => triggersList.find((t) => t.id === id) ?? null),
        save: vi.fn(async (spec: TriggerSpec) => {
          const idx = triggersList.findIndex((t) => t.id === spec.id);
          if (idx >= 0) triggersList[idx] = spec;
          else triggersList.push(spec);
        }),
        delete: vi.fn(async (id: string) => {
          triggersList = triggersList.filter((t) => t.id !== id);
        }),
      },
      flows: {
        list: vi.fn(async () => Array.from(flowsMap.values())),
        get: vi.fn(async (id: string) => flowsMap.get(id) ?? null),
        save: vi.fn(async (flow: FlowV3) => {
          flowsMap.set(flow.id, flow);
        }),
        delete: vi.fn(async (id: string) => {
          flowsMap.delete(id);
        }),
      },
      runs: {
        list: vi.fn(async () => Array.from(runsMap.values())),
        get: vi.fn(async (id: string) => runsMap.get(id) ?? null),
        save: vi.fn(async (record: RunRecordV3) => {
          runsMap.set(record.id, record);
        }),
        patch: vi.fn(async (id: string, patch: Partial<RunRecordV3>) => {
          const existing = runsMap.get(id);
          if (existing) runsMap.set(id, { ...existing, ...patch });
        }),
      },
      queue: {
        enqueue: vi.fn(async (input) => {
          const now = time;
          const item: RunQueueItem = {
            ...input,
            priority: input.priority ?? 0,
            maxAttempts: input.maxAttempts ?? 1,
            status: 'queued',
            createdAt: now,
            updatedAt: now,
            attempt: 0,
          };
          queueMap.set(item.id, item);
          return item;
        }),
        list: vi.fn(async (status?: string) => {
          const items = Array.from(queueMap.values());
          if (status) return items.filter((i) => i.status === status);
          return items;
        }),
      } as unknown as StoragePort['queue'],
    } as Pick<StoragePort, 'triggers' | 'flows' | 'runs' | 'queue'>;

    events = {
      append: vi.fn(async (event) => ({ ...event, ts: time, seq: 1 }) as unknown),
    };

    scheduler = {
      kick: vi.fn(async () => {}),
    };
  });

  describe('Lifecycle', () => {
    it('installs enabled triggers on start', async () => {
      const { factory, handler, installed } = createTestHandler('command');

      triggersList = [
        {
          id: 't1',
          kind: 'command',
          enabled: true,
          flowId: 'flow-1',
          commandKey: 'cmd',
        } as TriggerSpec,
        {
          id: 't2',
          kind: 'command',
          enabled: false,
          flowId: 'flow-1',
          commandKey: 'cmd',
        } as TriggerSpec,
      ];

      const manager = createTriggerManager({
        storage,
        events,
        scheduler,
        handlerFactories: { command: factory },
        now: () => time,
        generateRunId: () => `run-${++runIdCounter}`,
        logger: createSilentLogger(),
      });

      await manager.start();

      expect(handler.uninstallAll).toHaveBeenCalledTimes(1);
      expect(handler.install).toHaveBeenCalledTimes(1);
      expect(Array.from(installed.keys())).toEqual(['t1']);
    });

    it('stop uninstalls all triggers', async () => {
      const { factory, handler, installed } = createTestHandler('command');

      triggersList = [
        {
          id: 't1',
          kind: 'command',
          enabled: true,
          flowId: 'flow-1',
          commandKey: 'cmd',
        } as TriggerSpec,
      ];

      const manager = createTriggerManager({
        storage,
        events,
        scheduler,
        handlerFactories: { command: factory },
        now: () => time,
        generateRunId: () => `run-${++runIdCounter}`,
        logger: createSilentLogger(),
      });

      await manager.start();
      expect(installed.size).toBe(1);

      await manager.stop();
      expect(handler.uninstallAll).toHaveBeenCalledTimes(2); // once in start, once in stop
      expect(installed.size).toBe(0);
    });

    it('refresh resets installations when triggers change', async () => {
      const { factory, handler, installed } = createTestHandler('command');

      triggersList = [
        {
          id: 't1',
          kind: 'command',
          enabled: true,
          flowId: 'flow-1',
          commandKey: 'cmd',
        } as TriggerSpec,
      ];

      const manager = createTriggerManager({
        storage,
        events,
        scheduler,
        handlerFactories: { command: factory },
        now: () => time,
        generateRunId: () => `run-${++runIdCounter}`,
        logger: createSilentLogger(),
      });

      await manager.start();
      expect(Array.from(installed.keys())).toEqual(['t1']);

      // Disable trigger
      triggersList = [
        {
          id: 't1',
          kind: 'command',
          enabled: false,
          flowId: 'flow-1',
          commandKey: 'cmd',
        } as TriggerSpec,
      ];
      await manager.refresh();

      expect(handler.uninstallAll).toHaveBeenCalledTimes(2);
      expect(installed.size).toBe(0);
    });

    it('getState returns correct state', async () => {
      const { factory } = createTestHandler('command');

      triggersList = [
        {
          id: 't1',
          kind: 'command',
          enabled: true,
          flowId: 'flow-1',
          commandKey: 'cmd',
        } as TriggerSpec,
      ];

      const manager = createTriggerManager({
        storage,
        events,
        scheduler,
        handlerFactories: { command: factory },
        now: () => time,
        generateRunId: () => `run-${++runIdCounter}`,
        logger: createSilentLogger(),
      });

      expect(manager.getState()).toEqual({
        started: false,
        installedTriggerIds: [],
      });

      await manager.start();

      expect(manager.getState()).toEqual({
        started: true,
        installedTriggerIds: ['t1'],
      });
    });
  });

  describe('Trigger firing', () => {
    it('enqueues a run on fire and records trigger context', async () => {
      const { factory, fire } = createTestHandler('command');

      flowsMap.set('flow-1', createTestFlow('flow-1'));
      triggersList = [
        {
          id: 't1',
          kind: 'command',
          enabled: true,
          flowId: 'flow-1',
          commandKey: 'cmd',
          args: { foo: 'bar' },
        } as TriggerSpec,
      ];

      const manager = createTriggerManager({
        storage,
        events,
        scheduler,
        handlerFactories: { command: factory },
        now: () => time,
        generateRunId: () => `run-${++runIdCounter}`,
        logger: createSilentLogger(),
      });
      await manager.start();

      await fire('t1', { sourceTabId: 123, sourceUrl: 'https://example.com' });

      expect(storage.runs.save).toHaveBeenCalledTimes(1);
      const savedRun = (storage.runs.save as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as RunRecordV3;
      expect(savedRun).toMatchObject({
        id: 'run-1',
        flowId: 'flow-1',
        status: 'queued',
        args: { foo: 'bar' },
        trigger: {
          triggerId: 't1',
          kind: 'command',
          firedAt: time,
          sourceTabId: 123,
          sourceUrl: 'https://example.com',
        },
      });

      expect(scheduler.kick).toHaveBeenCalled();
    });

    it('ignores fire for non-installed trigger', async () => {
      const { factory, fire } = createTestHandler('command');

      flowsMap.set('flow-1', createTestFlow('flow-1'));
      triggersList = [];

      const manager = createTriggerManager({
        storage,
        events,
        scheduler,
        handlerFactories: { command: factory },
        now: () => time,
        generateRunId: () => `run-${++runIdCounter}`,
        logger: createSilentLogger(),
      });
      await manager.start();

      await fire('unknown-trigger', {});

      expect(storage.runs.save).not.toHaveBeenCalled();
    });

    it('ignores fire when manager is stopped', async () => {
      const { factory, fire } = createTestHandler('command');

      flowsMap.set('flow-1', createTestFlow('flow-1'));
      triggersList = [
        {
          id: 't1',
          kind: 'command',
          enabled: true,
          flowId: 'flow-1',
          commandKey: 'cmd',
        } as TriggerSpec,
      ];

      const manager = createTriggerManager({
        storage,
        events,
        scheduler,
        handlerFactories: { command: factory },
        now: () => time,
        generateRunId: () => `run-${++runIdCounter}`,
        logger: createSilentLogger(),
      });
      await manager.start();
      await manager.stop();

      await fire('t1', {});

      expect(storage.runs.save).not.toHaveBeenCalled();
    });
  });

  describe('Storm protection - cooldown', () => {
    it('applies per-trigger cooldown', async () => {
      const { factory, fire } = createTestHandler('command');

      flowsMap.set('flow-1', createTestFlow('flow-1'));
      triggersList = [
        {
          id: 't1',
          kind: 'command',
          enabled: true,
          flowId: 'flow-1',
          commandKey: 'cmd',
        } as TriggerSpec,
      ];

      const manager = createTriggerManager({
        storage,
        events,
        scheduler,
        handlerFactories: { command: factory },
        storm: { cooldownMs: 500 },
        now: () => time,
        generateRunId: () => `run-${++runIdCounter}`,
        logger: createSilentLogger(),
      });
      await manager.start();

      // First fire - should succeed
      await fire('t1', {});
      expect(storage.runs.save).toHaveBeenCalledTimes(1);

      // Second fire within cooldown - should be dropped
      time += 200;
      await fire('t1', {});
      expect(storage.runs.save).toHaveBeenCalledTimes(1);

      // Third fire after cooldown - should succeed
      time += 600; // total 800ms > 500ms cooldown
      await fire('t1', {});
      expect(storage.runs.save).toHaveBeenCalledTimes(2);
    });

    it('cooldown is per-trigger', async () => {
      const { factory, fire } = createTestHandler('command');

      flowsMap.set('flow-1', createTestFlow('flow-1'));
      triggersList = [
        {
          id: 't1',
          kind: 'command',
          enabled: true,
          flowId: 'flow-1',
          commandKey: 'cmd1',
        } as TriggerSpec,
        {
          id: 't2',
          kind: 'command',
          enabled: true,
          flowId: 'flow-1',
          commandKey: 'cmd2',
        } as TriggerSpec,
      ];

      const manager = createTriggerManager({
        storage,
        events,
        scheduler,
        handlerFactories: { command: factory },
        storm: { cooldownMs: 500 },
        now: () => time,
        generateRunId: () => `run-${++runIdCounter}`,
        logger: createSilentLogger(),
      });
      await manager.start();

      // Fire t1
      await fire('t1', {});
      expect(storage.runs.save).toHaveBeenCalledTimes(1);

      // Fire t2 immediately - should succeed (different trigger)
      await fire('t2', {});
      expect(storage.runs.save).toHaveBeenCalledTimes(2);

      // Fire t1 again within cooldown - should be dropped
      time += 100;
      await fire('t1', {});
      expect(storage.runs.save).toHaveBeenCalledTimes(2);
    });
  });

  describe('Storm protection - maxQueued', () => {
    it('applies global maxQueued cap', async () => {
      const { factory, fire } = createTestHandler('command');

      flowsMap.set('flow-1', createTestFlow('flow-1'));
      triggersList = [
        {
          id: 't1',
          kind: 'command',
          enabled: true,
          flowId: 'flow-1',
          commandKey: 'cmd',
        } as TriggerSpec,
      ];

      const manager = createTriggerManager({
        storage,
        events,
        scheduler,
        handlerFactories: { command: factory },
        storm: { maxQueued: 1 },
        now: () => time,
        generateRunId: () => `run-${++runIdCounter}`,
        logger: createSilentLogger(),
      });
      await manager.start();

      // First fire - should succeed
      await fire('t1', {});
      expect(storage.runs.save).toHaveBeenCalledTimes(1);

      // Second fire - should be dropped (maxQueued reached)
      time += 1;
      await fire('t1', {});
      expect(storage.runs.save).toHaveBeenCalledTimes(1);
    });

    it('maxQueued cap allows more fires when queue drains', async () => {
      const { factory, fire } = createTestHandler('command');

      flowsMap.set('flow-1', createTestFlow('flow-1'));
      triggersList = [
        {
          id: 't1',
          kind: 'command',
          enabled: true,
          flowId: 'flow-1',
          commandKey: 'cmd',
        } as TriggerSpec,
      ];

      const manager = createTriggerManager({
        storage,
        events,
        scheduler,
        handlerFactories: { command: factory },
        storm: { maxQueued: 1 },
        now: () => time,
        generateRunId: () => `run-${++runIdCounter}`,
        logger: createSilentLogger(),
      });
      await manager.start();

      // First fire - should succeed
      await fire('t1', {});
      expect(storage.runs.save).toHaveBeenCalledTimes(1);

      // Simulate queue drain
      queueMap.clear();
      time += 1;

      // Fire again - should succeed
      await fire('t1', {});
      expect(storage.runs.save).toHaveBeenCalledTimes(2);
    });
  });

  describe('Multiple handler types', () => {
    it('handles multiple trigger kinds', async () => {
      const commandHandler = createTestHandler('command');
      const urlHandler = createTestHandler('url');

      flowsMap.set('flow-1', createTestFlow('flow-1'));
      triggersList = [
        {
          id: 't1',
          kind: 'command',
          enabled: true,
          flowId: 'flow-1',
          commandKey: 'cmd',
        } as TriggerSpec,
        {
          id: 't2',
          kind: 'url',
          enabled: true,
          flowId: 'flow-1',
          match: [{ kind: 'domain', value: 'example.com' }],
        } as TriggerSpec,
      ];

      const manager = createTriggerManager({
        storage,
        events,
        scheduler,
        handlerFactories: {
          command: commandHandler.factory,
          url: urlHandler.factory,
        },
        now: () => time,
        generateRunId: () => `run-${++runIdCounter}`,
        logger: createSilentLogger(),
      });
      await manager.start();

      expect(commandHandler.installed.size).toBe(1);
      expect(urlHandler.installed.size).toBe(1);

      // Fire both
      await commandHandler.fire('t1', {});
      await urlHandler.fire('t2', { sourceUrl: 'https://example.com' });

      expect(storage.runs.save).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error handling', () => {
    it('continues after handler install failure', async () => {
      const { factory, installed } = createTestHandler('command');

      triggersList = [
        {
          id: 't1',
          kind: 'command',
          enabled: true,
          flowId: 'flow-1',
          commandKey: 'cmd1',
        } as TriggerSpec,
        {
          id: 't2',
          kind: 'command',
          enabled: true,
          flowId: 'flow-1',
          commandKey: 'cmd2',
        } as TriggerSpec,
      ];

      // Make first install fail
      let callCount = 0;
      const originalFactory: TriggerHandlerFactory<TriggerKind> = (fireCallback) => {
        const handler = factory(fireCallback);
        const originalInstall = handler.install;
        handler.install = vi.fn(async (trigger: TriggerSpec) => {
          callCount++;
          if (callCount === 1) {
            throw new Error('Install failed');
          }
          return originalInstall(trigger);
        });
        return handler;
      };

      const manager = createTriggerManager({
        storage,
        events,
        scheduler,
        handlerFactories: { command: originalFactory },
        now: () => time,
        generateRunId: () => `run-${++runIdCounter}`,
        logger: createSilentLogger(),
      });

      await manager.start();

      // Only t2 should be installed
      expect(installed.size).toBe(1);
      expect(installed.has('t2')).toBe(true);
    });

    it('refresh throws when not started', async () => {
      const { factory } = createTestHandler('command');

      const manager = createTriggerManager({
        storage,
        events,
        scheduler,
        handlerFactories: { command: factory },
        now: () => time,
        generateRunId: () => `run-${++runIdCounter}`,
        logger: createSilentLogger(),
      });

      await expect(manager.refresh()).rejects.toThrow('TriggerManager is not started');
    });

    it('continues after uninstallAll failure during refresh', async () => {
      const { factory, installed } = createTestHandler('command');

      triggersList = [
        {
          id: 't1',
          kind: 'command',
          enabled: true,
          flowId: 'flow-1',
          commandKey: 'cmd',
        } as TriggerSpec,
      ];

      let uninstallCallCount = 0;
      const originalFactory: TriggerHandlerFactory<TriggerKind> = (fireCallback) => {
        const handler = factory(fireCallback);
        handler.uninstallAll = vi.fn(async () => {
          uninstallCallCount++;
          if (uninstallCallCount === 2) {
            throw new Error('UninstallAll failed');
          }
          installed.clear();
        });
        return handler;
      };

      const manager = createTriggerManager({
        storage,
        events,
        scheduler,
        handlerFactories: { command: originalFactory },
        now: () => time,
        generateRunId: () => `run-${++runIdCounter}`,
        logger: createSilentLogger(),
      });

      await manager.start();

      // Add new trigger
      triggersList.push({
        id: 't2',
        kind: 'command',
        enabled: true,
        flowId: 'flow-1',
        commandKey: 'cmd2',
      } as TriggerSpec);

      // Refresh should continue despite uninstallAll failure
      await manager.refresh();
      expect(installed.size).toBe(2);
    });

    it('cooldown rollback on enqueueRun failure', async () => {
      const { factory, fire } = createTestHandler('command');

      flowsMap.set('flow-1', createTestFlow('flow-1'));
      triggersList = [
        {
          id: 't1',
          kind: 'command',
          enabled: true,
          flowId: 'flow-1',
          commandKey: 'cmd',
        } as TriggerSpec,
      ];

      // Make enqueue fail
      let enqueueCallCount = 0;
      (storage.queue.enqueue as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        enqueueCallCount++;
        if (enqueueCallCount === 1) {
          throw new Error('Enqueue failed');
        }
        const now = time;
        const item: RunQueueItem = {
          id: `run-${runIdCounter}`,
          flowId: 'flow-1',
          priority: 0,
          maxAttempts: 1,
          status: 'queued',
          createdAt: now,
          updatedAt: now,
          attempt: 0,
        };
        queueMap.set(item.id, item);
        return item;
      });

      const manager = createTriggerManager({
        storage,
        events,
        scheduler,
        handlerFactories: { command: factory },
        storm: { cooldownMs: 500 },
        now: () => time,
        generateRunId: () => `run-${++runIdCounter}`,
        logger: createSilentLogger(),
      });
      await manager.start();

      // First fire fails, cooldown should be rolled back
      await fire('t1', {});
      expect(storage.runs.save).toHaveBeenCalledTimes(1);

      // Immediate retry should succeed (cooldown was rolled back)
      await fire('t1', {});
      expect(storage.runs.save).toHaveBeenCalledTimes(2);
    });
  });

  describe('maxQueued does not affect cooldown', () => {
    it('does not set cooldown when dropped due to maxQueued', async () => {
      const { factory, fire } = createTestHandler('command');

      flowsMap.set('flow-1', createTestFlow('flow-1'));
      triggersList = [
        {
          id: 't1',
          kind: 'command',
          enabled: true,
          flowId: 'flow-1',
          commandKey: 'cmd',
        } as TriggerSpec,
      ];

      const manager = createTriggerManager({
        storage,
        events,
        scheduler,
        handlerFactories: { command: factory },
        storm: { cooldownMs: 500, maxQueued: 1 },
        now: () => time,
        generateRunId: () => `run-${++runIdCounter}`,
        logger: createSilentLogger(),
      });
      await manager.start();

      // First fire succeeds
      await fire('t1', {});
      expect(storage.runs.save).toHaveBeenCalledTimes(1);

      // Second fire dropped due to maxQueued (but cooldown should still be set)
      time += 100;
      await fire('t1', {});
      expect(storage.runs.save).toHaveBeenCalledTimes(1);

      // Clear queue, but within cooldown - should still be dropped
      queueMap.clear();
      await fire('t1', {});
      expect(storage.runs.save).toHaveBeenCalledTimes(1);

      // After cooldown - should succeed
      time += 500;
      await fire('t1', {});
      expect(storage.runs.save).toHaveBeenCalledTimes(2);
    });
  });
});
