/**
 * @fileoverview 触发器测试 (P4-01)
 * @description
 * Tests for:
 * - TriggerStore CRUD operations
 * - TriggerSpec type validation
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { TriggerSpec } from '@/entrypoints/background/record-replay-v3/domain/triggers';
import {
  createTriggersStore,
  closeRrV3Db,
  deleteRrV3Db,
} from '@/entrypoints/background/record-replay-v3';

// ==================== Test Utilities ====================

function createUrlTrigger(id: string, flowId: string): TriggerSpec {
  return {
    id: id as any,
    kind: 'url',
    enabled: true,
    flowId: flowId as any,
    match: [{ kind: 'domain', value: 'example.com' }],
  };
}

function createCronTrigger(id: string, flowId: string): TriggerSpec {
  return {
    id: id as any,
    kind: 'cron',
    enabled: true,
    flowId: flowId as any,
    cron: '0 9 * * *', // Every day at 9am
    timezone: 'UTC',
  };
}

function createCommandTrigger(id: string, flowId: string): TriggerSpec {
  return {
    id: id as any,
    kind: 'command',
    enabled: true,
    flowId: flowId as any,
    commandKey: 'run-flow-1',
  };
}

function createContextMenuTrigger(id: string, flowId: string): TriggerSpec {
  return {
    id: id as any,
    kind: 'contextMenu',
    enabled: true,
    flowId: flowId as any,
    title: 'Run Flow',
    contexts: ['page', 'selection'],
  };
}

function createDomTrigger(id: string, flowId: string): TriggerSpec {
  return {
    id: id as any,
    kind: 'dom',
    enabled: true,
    flowId: flowId as any,
    selector: '#submit-button',
    appear: true,
    once: false,
    debounceMs: 1000,
  };
}

function createManualTrigger(id: string, flowId: string): TriggerSpec {
  return {
    id: id as any,
    kind: 'manual',
    enabled: true,
    flowId: flowId as any,
  };
}

// ==================== TriggerStore Tests ====================

describe('TriggerStore CRUD', () => {
  beforeEach(async () => {
    await deleteRrV3Db();
    closeRrV3Db();
  });

  describe('Basic CRUD', () => {
    it('save and get a trigger', async () => {
      const store = createTriggersStore();
      const trigger = createUrlTrigger('trigger-1', 'flow-1');

      await store.save(trigger);
      const retrieved = await store.get('trigger-1' as any);

      expect(retrieved).not.toBeNull();
      expect(retrieved).toMatchObject({
        id: 'trigger-1',
        kind: 'url',
        enabled: true,
        flowId: 'flow-1',
        match: [{ kind: 'domain', value: 'example.com' }],
      });
    });

    it('get returns null for non-existent trigger', async () => {
      const store = createTriggersStore();

      const retrieved = await store.get('non-existent' as any);

      expect(retrieved).toBeNull();
    });

    it('list returns all triggers', async () => {
      const store = createTriggersStore();

      await store.save(createUrlTrigger('trigger-1', 'flow-1'));
      await store.save(createCronTrigger('trigger-2', 'flow-2'));
      await store.save(createCommandTrigger('trigger-3', 'flow-3'));

      const triggers = await store.list();

      expect(triggers).toHaveLength(3);
      expect(triggers.map((t) => t.id)).toContain('trigger-1');
      expect(triggers.map((t) => t.id)).toContain('trigger-2');
      expect(triggers.map((t) => t.id)).toContain('trigger-3');
    });

    it('list returns empty array when no triggers', async () => {
      const store = createTriggersStore();

      const triggers = await store.list();

      expect(triggers).toHaveLength(0);
    });

    it('save updates existing trigger', async () => {
      const store = createTriggersStore();

      await store.save(createUrlTrigger('trigger-1', 'flow-1'));

      // Update
      const updated: TriggerSpec = {
        id: 'trigger-1' as any,
        kind: 'url',
        enabled: false, // Changed
        flowId: 'flow-1' as any,
        match: [{ kind: 'url', value: 'https://example.com/new' }], // Changed
      };
      await store.save(updated);

      const retrieved = await store.get('trigger-1' as any);
      expect(retrieved).toMatchObject({
        id: 'trigger-1',
        enabled: false,
        match: [{ kind: 'url', value: 'https://example.com/new' }],
      });
    });

    it('delete removes a trigger', async () => {
      const store = createTriggersStore();

      await store.save(createUrlTrigger('trigger-1', 'flow-1'));
      await store.delete('trigger-1' as any);

      const retrieved = await store.get('trigger-1' as any);
      expect(retrieved).toBeNull();
    });

    it('delete is idempotent for non-existent trigger', async () => {
      const store = createTriggersStore();

      // Should not throw
      await expect(store.delete('non-existent' as any)).resolves.toBeUndefined();
    });
  });

  describe('All trigger kinds', () => {
    it('stores and retrieves URL trigger', async () => {
      const store = createTriggersStore();
      const trigger = createUrlTrigger('url-1', 'flow-1');

      await store.save(trigger);
      const retrieved = await store.get('url-1' as any);

      expect(retrieved?.kind).toBe('url');
      expect((retrieved as any).match).toEqual([{ kind: 'domain', value: 'example.com' }]);
    });

    it('stores and retrieves cron trigger', async () => {
      const store = createTriggersStore();
      const trigger = createCronTrigger('cron-1', 'flow-1');

      await store.save(trigger);
      const retrieved = await store.get('cron-1' as any);

      expect(retrieved?.kind).toBe('cron');
      expect((retrieved as any).cron).toBe('0 9 * * *');
      expect((retrieved as any).timezone).toBe('UTC');
    });

    it('stores and retrieves command trigger', async () => {
      const store = createTriggersStore();
      const trigger = createCommandTrigger('cmd-1', 'flow-1');

      await store.save(trigger);
      const retrieved = await store.get('cmd-1' as any);

      expect(retrieved?.kind).toBe('command');
      expect((retrieved as any).commandKey).toBe('run-flow-1');
    });

    it('stores and retrieves contextMenu trigger', async () => {
      const store = createTriggersStore();
      const trigger = createContextMenuTrigger('ctx-1', 'flow-1');

      await store.save(trigger);
      const retrieved = await store.get('ctx-1' as any);

      expect(retrieved?.kind).toBe('contextMenu');
      expect((retrieved as any).title).toBe('Run Flow');
      expect((retrieved as any).contexts).toEqual(['page', 'selection']);
    });

    it('stores and retrieves DOM trigger', async () => {
      const store = createTriggersStore();
      const trigger = createDomTrigger('dom-1', 'flow-1');

      await store.save(trigger);
      const retrieved = await store.get('dom-1' as any);

      expect(retrieved?.kind).toBe('dom');
      expect((retrieved as any).selector).toBe('#submit-button');
      expect((retrieved as any).appear).toBe(true);
      expect((retrieved as any).once).toBe(false);
      expect((retrieved as any).debounceMs).toBe(1000);
    });

    it('stores and retrieves manual trigger', async () => {
      const store = createTriggersStore();
      const trigger = createManualTrigger('manual-1', 'flow-1');

      await store.save(trigger);
      const retrieved = await store.get('manual-1' as any);

      expect(retrieved?.kind).toBe('manual');
    });
  });

  describe('Trigger with args', () => {
    it('stores and retrieves trigger with args', async () => {
      const store = createTriggersStore();
      const trigger: TriggerSpec = {
        ...createUrlTrigger('trigger-1', 'flow-1'),
        args: {
          mode: 'production',
          retryCount: 3,
          tags: ['important', 'automated'],
        },
      };

      await store.save(trigger);
      const retrieved = await store.get('trigger-1' as any);

      expect(retrieved?.args).toEqual({
        mode: 'production',
        retryCount: 3,
        tags: ['important', 'automated'],
      });
    });
  });
});
