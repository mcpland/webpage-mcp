/**
 * @fileoverview ContextMenu Trigger Handler 测试 (P4-05)
 * @description
 * Tests for:
 * - Menu item creation and removal
 * - Click event handling
 * - Listener lifecycle
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TriggerSpecByKind } from '@/entrypoints/background/record-replay-v3/domain/triggers';
import type { TriggerFireCallback } from '@/entrypoints/background/record-replay-v3/engine/triggers/trigger-handler';
import { createContextMenuTriggerHandlerFactory } from '@/entrypoints/background/record-replay-v3/engine/triggers/context-menu-trigger';

// ==================== Test Utilities ====================

function createSilentLogger(): Pick<Console, 'debug' | 'info' | 'warn' | 'error'> {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

interface ContextMenusMock {
  create: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  onClicked: {
    addListener: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };
  emitClicked: (
    info: { menuItemId: string | number; pageUrl?: string },
    tab?: { id?: number; url?: string },
  ) => void;
  createdItems: Map<string, { title: string; contexts: string[] }>;
}

function createContextMenusMock(): ContextMenusMock {
  const listeners = new Set<
    (
      info: { menuItemId: string | number; pageUrl?: string },
      tab?: { id?: number; url?: string },
    ) => void
  >();
  const createdItems = new Map<string, { title: string; contexts: string[] }>();

  const create = vi.fn(
    (props: { id: string; title: string; contexts: string[] }, callback?: () => void) => {
      createdItems.set(props.id, { title: props.title, contexts: props.contexts });
      if (callback) {
        // Simulate async callback
        setTimeout(() => callback(), 0);
      }
      return props.id;
    },
  );

  const remove = vi.fn((menuItemId: string, callback?: () => void) => {
    createdItems.delete(menuItemId);
    if (callback) {
      setTimeout(() => callback(), 0);
    }
  });

  const onClicked = {
    addListener: vi.fn(
      (
        cb: (
          info: { menuItemId: string | number; pageUrl?: string },
          tab?: { id?: number; url?: string },
        ) => void,
      ) => {
        listeners.add(cb);
      },
    ),
    removeListener: vi.fn(
      (
        cb: (
          info: { menuItemId: string | number; pageUrl?: string },
          tab?: { id?: number; url?: string },
        ) => void,
      ) => {
        listeners.delete(cb);
      },
    ),
  };

  return {
    create,
    remove,
    onClicked,
    emitClicked: (info, tab) => {
      for (const cb of listeners) cb(info, tab);
    },
    createdItems,
  };
}

function setupContextMenusMock(): ContextMenusMock {
  const mock = createContextMenusMock();
  (globalThis.chrome as unknown as { contextMenus: unknown }).contextMenus = {
    create: mock.create,
    remove: mock.remove,
    onClicked: mock.onClicked,
  };
  // Clear lastError
  (globalThis.chrome.runtime as { lastError?: { message: string } }).lastError = undefined;
  return mock;
}

// ==================== ContextMenu Trigger Tests ====================

describe('V3 ContextMenuTriggerHandler', () => {
  let contextMenusMock: ContextMenusMock;

  beforeEach(() => {
    contextMenusMock = setupContextMenusMock();
  });

  describe('Menu item creation', () => {
    it('creates menu item on install', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createContextMenuTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'contextMenu'> = {
        id: 't1' as never,
        kind: 'contextMenu',
        enabled: true,
        flowId: 'flow-1' as never,
        title: 'Run My Flow',
        contexts: ['page', 'selection'],
      };

      await handler.install(trigger);

      expect(contextMenusMock.create).toHaveBeenCalledWith(
        {
          id: 'rr_v3_t1',
          title: 'Run My Flow',
          contexts: ['page', 'selection'],
        },
        expect.any(Function),
      );
    });

    it('uses default contexts when not specified', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createContextMenuTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'contextMenu'> = {
        id: 't1' as never,
        kind: 'contextMenu',
        enabled: true,
        flowId: 'flow-1' as never,
        title: 'Run My Flow',
      };

      await handler.install(trigger);

      expect(contextMenusMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          contexts: ['page'],
        }),
        expect.any(Function),
      );
    });
  });

  describe('Click handling', () => {
    it('fires on menu item click', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createContextMenuTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'contextMenu'> = {
        id: 't1' as never,
        kind: 'contextMenu',
        enabled: true,
        flowId: 'flow-1' as never,
        title: 'Run My Flow',
      };

      await handler.install(trigger);

      contextMenusMock.emitClicked(
        { menuItemId: 'rr_v3_t1', pageUrl: 'https://example.com/page' },
        { id: 123, url: 'https://example.com/page' },
      );

      expect(fireCallback.onFire).toHaveBeenCalledWith('t1', {
        sourceTabId: 123,
        sourceUrl: 'https://example.com/page',
      });
    });

    it('ignores click on non-matching menu item', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createContextMenuTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'contextMenu'> = {
        id: 't1' as never,
        kind: 'contextMenu',
        enabled: true,
        flowId: 'flow-1' as never,
        title: 'Run My Flow',
      };

      await handler.install(trigger);

      contextMenusMock.emitClicked({ menuItemId: 'other_menu_item' });

      expect(fireCallback.onFire).not.toHaveBeenCalled();
    });

    it('uses tab url when pageUrl not available', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createContextMenuTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'contextMenu'> = {
        id: 't1' as never,
        kind: 'contextMenu',
        enabled: true,
        flowId: 'flow-1' as never,
        title: 'Run My Flow',
      };

      await handler.install(trigger);

      contextMenusMock.emitClicked(
        { menuItemId: 'rr_v3_t1' },
        { id: 123, url: 'https://example.com' },
      );

      expect(fireCallback.onFire).toHaveBeenCalledWith('t1', {
        sourceTabId: 123,
        sourceUrl: 'https://example.com',
      });
    });
  });

  describe('Menu item removal', () => {
    it('removes menu item on uninstall', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createContextMenuTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'contextMenu'> = {
        id: 't1' as never,
        kind: 'contextMenu',
        enabled: true,
        flowId: 'flow-1' as never,
        title: 'Run My Flow',
      };

      await handler.install(trigger);
      await handler.uninstall('t1');

      expect(contextMenusMock.remove).toHaveBeenCalledWith('rr_v3_t1', expect.any(Function));
    });

    it('removes all menu items on uninstallAll', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createContextMenuTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const t1: TriggerSpecByKind<'contextMenu'> = {
        id: 't1' as never,
        kind: 'contextMenu',
        enabled: true,
        flowId: 'flow-1' as never,
        title: 'Flow 1',
      };

      const t2: TriggerSpecByKind<'contextMenu'> = {
        id: 't2' as never,
        kind: 'contextMenu',
        enabled: true,
        flowId: 'flow-2' as never,
        title: 'Flow 2',
      };

      await handler.install(t1);
      await handler.install(t2);
      await handler.uninstallAll();

      expect(contextMenusMock.remove).toHaveBeenCalledTimes(2);
    });
  });

  describe('Listener lifecycle', () => {
    it('registers listener on first install', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createContextMenuTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'contextMenu'> = {
        id: 't1' as never,
        kind: 'contextMenu',
        enabled: true,
        flowId: 'flow-1' as never,
        title: 'Run',
      };

      await handler.install(trigger);

      expect(contextMenusMock.onClicked.addListener).toHaveBeenCalledTimes(1);
    });

    it('removes listener when all triggers uninstalled', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createContextMenuTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const t1: TriggerSpecByKind<'contextMenu'> = {
        id: 't1' as never,
        kind: 'contextMenu',
        enabled: true,
        flowId: 'flow-1' as never,
        title: 'Flow 1',
      };

      const t2: TriggerSpecByKind<'contextMenu'> = {
        id: 't2' as never,
        kind: 'contextMenu',
        enabled: true,
        flowId: 'flow-2' as never,
        title: 'Flow 2',
      };

      await handler.install(t1);
      await handler.install(t2);

      await handler.uninstall('t1');
      expect(contextMenusMock.onClicked.removeListener).not.toHaveBeenCalled();

      await handler.uninstall('t2');
      expect(contextMenusMock.onClicked.removeListener).toHaveBeenCalledTimes(1);
    });
  });

  describe('getInstalledIds', () => {
    it('returns installed trigger IDs', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createContextMenuTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const t1: TriggerSpecByKind<'contextMenu'> = {
        id: 't1' as never,
        kind: 'contextMenu',
        enabled: true,
        flowId: 'flow-1' as never,
        title: 'Flow 1',
      };

      const t2: TriggerSpecByKind<'contextMenu'> = {
        id: 't2' as never,
        kind: 'contextMenu',
        enabled: true,
        flowId: 'flow-2' as never,
        title: 'Flow 2',
      };

      await handler.install(t1);
      await handler.install(t2);

      expect(handler.getInstalledIds().sort()).toEqual(['t1', 't2']);

      await handler.uninstall('t1');
      expect(handler.getInstalledIds()).toEqual(['t2']);
    });
  });
});
