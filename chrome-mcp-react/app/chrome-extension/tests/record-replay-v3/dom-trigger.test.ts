/**
 * @fileoverview DOM Trigger Handler 测试 (P4-06)
 * @description
 * Tests for:
 * - Syncing triggers to tabs (inject + set_dom_triggers)
 * - Handling dom_trigger_fired messages
 * - Re-syncing on navigation completion
 * - Listener lifecycle
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CONTENT_MESSAGE_TYPES, TOOL_MESSAGE_TYPES } from '@/common/message-types';
import type { TriggerSpecByKind } from '@/entrypoints/background/record-replay-v3/domain/triggers';
import type { TriggerFireCallback } from '@/entrypoints/background/record-replay-v3/engine/triggers/trigger-handler';
import { createDomTriggerHandlerFactory } from '@/entrypoints/background/record-replay-v3/engine/triggers/dom-trigger';

// ==================== Test Utilities ====================

function createSilentLogger(): Pick<Console, 'debug' | 'info' | 'warn' | 'error'> {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

interface RuntimeOnMessageMock {
  onMessage: {
    addListener: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };
  emit: (message: unknown, sender?: Partial<chrome.runtime.MessageSender>) => void;
}

function createRuntimeOnMessageMock(): RuntimeOnMessageMock {
  const listeners = new Set<
    (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ) => boolean | void
  >();

  const onMessage = {
    addListener: vi.fn((cb) => {
      listeners.add(cb);
    }),
    removeListener: vi.fn((cb) => {
      listeners.delete(cb);
    }),
  };

  return {
    onMessage,
    emit: (message, sender) => {
      for (const cb of listeners) {
        cb(message, sender as chrome.runtime.MessageSender, vi.fn());
      }
    },
  };
}

interface WebNavigationMock {
  onCompleted: {
    addListener: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };
  emitCompleted: (details: { tabId: number; frameId: number; url: string }) => void;
}

function createWebNavigationMock(): WebNavigationMock {
  const listeners = new Set<(details: unknown) => void>();

  const onCompleted = {
    addListener: vi.fn((cb: (details: unknown) => void) => {
      listeners.add(cb);
    }),
    removeListener: vi.fn((cb: (details: unknown) => void) => {
      listeners.delete(cb);
    }),
  };

  return {
    onCompleted,
    emitCompleted: (details) => {
      for (const cb of listeners) cb(details);
    },
  };
}

// ==================== DOM Trigger Tests ====================

describe('V3 DomTriggerHandler', () => {
  let runtimeMock: RuntimeOnMessageMock;
  let webNav: WebNavigationMock;

  beforeEach(() => {
    runtimeMock = createRuntimeOnMessageMock();
    webNav = createWebNavigationMock();

    (globalThis.chrome as unknown as { runtime: unknown }).runtime = {
      ...(globalThis.chrome as unknown as { runtime: object }).runtime,
      onMessage: runtimeMock.onMessage,
    };

    (globalThis.chrome as unknown as { webNavigation: unknown }).webNavigation = {
      onCompleted: webNav.onCompleted,
    };

    (globalThis.chrome as unknown as { scripting: unknown }).scripting = {
      executeScript: vi.fn().mockResolvedValue([]),
    };

    (globalThis.chrome as unknown as { tabs: unknown }).tabs = {
      query: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn().mockResolvedValue({}),
    };
  });

  describe('Installation and sync', () => {
    it('injects dom-observer and pushes triggers on install', async () => {
      (globalThis.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 1, url: 'https://example.com' },
        { id: 2, url: 'chrome://extensions' }, // Should be skipped
      ]);

      (globalThis.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
        async (_tabId: number, msg: { action?: string; triggers?: unknown[] }) => {
          if (msg.action === CONTENT_MESSAGE_TYPES.DOM_OBSERVER_PING) {
            throw new Error('no observer'); // Simulate not injected
          }
          if (msg.action === TOOL_MESSAGE_TYPES.SET_DOM_TRIGGERS) {
            return { success: true, count: Array.isArray(msg.triggers) ? msg.triggers.length : 0 };
          }
          return undefined;
        },
      );

      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createDomTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'dom'> = {
        id: 't1' as never,
        kind: 'dom',
        enabled: true,
        flowId: 'flow-1' as never,
        selector: '#submit-button',
      };

      await handler.install(trigger);

      // Listeners should be registered
      expect(runtimeMock.onMessage.addListener).toHaveBeenCalledTimes(1);
      expect(webNav.onCompleted.addListener).toHaveBeenCalledTimes(1);

      // Should inject script to injectable tab only
      expect(globalThis.chrome.scripting.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { tabId: 1 },
          files: ['inject-scripts/dom-observer.js'],
          world: 'ISOLATED',
        }),
      );

      // Should not inject to chrome:// URL
      const executeScriptCalls = (
        globalThis.chrome.scripting.executeScript as ReturnType<typeof vi.fn>
      ).mock.calls;
      expect(executeScriptCalls.every((c) => c[0].target.tabId !== 2)).toBe(true);

      // Should send triggers
      const sendCalls = (globalThis.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      const setCalls = sendCalls.filter(
        (c) => c[1]?.action === TOOL_MESSAGE_TYPES.SET_DOM_TRIGGERS,
      );

      expect(setCalls.length).toBeGreaterThan(0);
      expect(setCalls[0][1]).toEqual({
        action: TOOL_MESSAGE_TYPES.SET_DOM_TRIGGERS,
        triggers: [
          {
            id: 't1',
            selector: '#submit-button',
            appear: true,
            once: true,
            debounceMs: 800,
          },
        ],
      });
    });

    it('uses custom debounceMs when specified', async () => {
      (globalThis.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 1, url: 'https://example.com' },
      ]);

      (globalThis.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
        async (_tabId: number, msg: { action?: string }) => {
          if (msg.action === CONTENT_MESSAGE_TYPES.DOM_OBSERVER_PING) {
            return { status: 'pong' }; // Already injected
          }
          return { success: true };
        },
      );

      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createDomTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'dom'> = {
        id: 't1' as never,
        kind: 'dom',
        enabled: true,
        flowId: 'flow-1' as never,
        selector: '#btn',
        debounceMs: 2000,
        once: false,
        appear: false,
      };

      await handler.install(trigger);

      const sendCalls = (globalThis.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
      const setCalls = sendCalls.filter(
        (c) => c[1]?.action === TOOL_MESSAGE_TYPES.SET_DOM_TRIGGERS,
      );

      expect(setCalls[0][1].triggers[0]).toMatchObject({
        debounceMs: 2000,
        once: false,
        appear: false,
      });
    });
  });

  describe('Message handling', () => {
    it('fires when receiving dom_trigger_fired for installed trigger', async () => {
      (globalThis.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createDomTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'dom'> = {
        id: 't1' as never,
        kind: 'dom',
        enabled: true,
        flowId: 'flow-1' as never,
        selector: '#x',
      };

      await handler.install(trigger);

      runtimeMock.emit(
        {
          action: TOOL_MESSAGE_TYPES.DOM_TRIGGER_FIRED,
          triggerId: 't1',
          url: 'https://example.com/page',
        },
        { tab: { id: 123, url: 'https://example.com/page' } as chrome.tabs.Tab },
      );

      expect(fireCallback.onFire).toHaveBeenCalledWith('t1', {
        sourceTabId: 123,
        sourceUrl: 'https://example.com/page',
      });
    });

    it('ignores dom_trigger_fired for unknown trigger', async () => {
      (globalThis.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createDomTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'dom'> = {
        id: 't1' as never,
        kind: 'dom',
        enabled: true,
        flowId: 'flow-1' as never,
        selector: '#x',
      };

      await handler.install(trigger);

      runtimeMock.emit(
        {
          action: TOOL_MESSAGE_TYPES.DOM_TRIGGER_FIRED,
          triggerId: 'unknown',
          url: 'https://example.com/page',
        },
        { tab: { id: 123 } as chrome.tabs.Tab },
      );

      expect(fireCallback.onFire).not.toHaveBeenCalled();
    });

    it('ignores non-dom_trigger_fired messages', async () => {
      (globalThis.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createDomTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      await handler.install({
        id: 't1' as never,
        kind: 'dom',
        enabled: true,
        flowId: 'flow-1' as never,
        selector: '#x',
      });

      runtimeMock.emit({ action: 'some_other_action', data: 'test' }, {});

      expect(fireCallback.onFire).not.toHaveBeenCalled();
    });
  });

  describe('Navigation handling', () => {
    it('re-syncs on main-frame navigation completion', async () => {
      (globalThis.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (globalThis.chrome.tabs.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
        async (_tabId: number, msg: { action?: string }) => {
          if (msg.action === CONTENT_MESSAGE_TYPES.DOM_OBSERVER_PING) {
            throw new Error('no observer');
          }
          return { ok: true };
        },
      );

      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createDomTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      await handler.install({
        id: 't1' as never,
        kind: 'dom',
        enabled: true,
        flowId: 'flow-1' as never,
        selector: '#x',
      });

      // Clear previous calls
      (globalThis.chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockClear();

      // Emit navigation completed
      webNav.emitCompleted({ tabId: 5, frameId: 0, url: 'https://example.com' });
      await new Promise((r) => setTimeout(r, 0));

      expect(globalThis.chrome.scripting.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { tabId: 5 },
          files: ['inject-scripts/dom-observer.js'],
          world: 'ISOLATED',
        }),
      );
    });

    it('ignores subframe navigation', async () => {
      (globalThis.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createDomTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      await handler.install({
        id: 't1' as never,
        kind: 'dom',
        enabled: true,
        flowId: 'flow-1' as never,
        selector: '#x',
      });

      (globalThis.chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockClear();

      // Emit subframe navigation
      webNav.emitCompleted({ tabId: 5, frameId: 1, url: 'https://example.com' });
      await new Promise((r) => setTimeout(r, 0));

      expect(globalThis.chrome.scripting.executeScript).not.toHaveBeenCalled();
    });

    it('ignores non-injectable URLs on navigation', async () => {
      (globalThis.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createDomTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      await handler.install({
        id: 't1' as never,
        kind: 'dom',
        enabled: true,
        flowId: 'flow-1' as never,
        selector: '#x',
      });

      (globalThis.chrome.scripting.executeScript as ReturnType<typeof vi.fn>).mockClear();

      // Emit navigation to chrome:// URL
      webNav.emitCompleted({ tabId: 5, frameId: 0, url: 'chrome://extensions' });
      await new Promise((r) => setTimeout(r, 0));

      expect(globalThis.chrome.scripting.executeScript).not.toHaveBeenCalled();
    });
  });

  describe('Lifecycle', () => {
    it('stops listening when last trigger uninstalled', async () => {
      (globalThis.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createDomTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      await handler.install({
        id: 't1' as never,
        kind: 'dom',
        enabled: true,
        flowId: 'flow-1' as never,
        selector: '#x',
      });

      await handler.uninstall('t1');

      expect(runtimeMock.onMessage.removeListener).toHaveBeenCalledTimes(1);
      expect(webNav.onCompleted.removeListener).toHaveBeenCalledTimes(1);
      expect(handler.getInstalledIds()).toEqual([]);
    });

    it('uninstallAll clears all and stops listening', async () => {
      (globalThis.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createDomTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      await handler.install({
        id: 't1' as never,
        kind: 'dom',
        enabled: true,
        flowId: 'flow-1' as never,
        selector: '#x',
      });
      await handler.install({
        id: 't2' as never,
        kind: 'dom',
        enabled: true,
        flowId: 'flow-2' as never,
        selector: '#y',
      });

      await handler.uninstallAll();

      expect(runtimeMock.onMessage.removeListener).toHaveBeenCalledTimes(1);
      expect(webNav.onCompleted.removeListener).toHaveBeenCalledTimes(1);
      expect(handler.getInstalledIds()).toEqual([]);
    });
  });

  describe('getInstalledIds', () => {
    it('returns installed trigger IDs', async () => {
      (globalThis.chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createDomTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      await handler.install({
        id: 't1' as never,
        kind: 'dom',
        enabled: true,
        flowId: 'flow-1' as never,
        selector: '#x',
      });
      await handler.install({
        id: 't2' as never,
        kind: 'dom',
        enabled: true,
        flowId: 'flow-2' as never,
        selector: '#y',
      });

      expect(handler.getInstalledIds().sort()).toEqual(['t1', 't2']);

      await handler.uninstall('t1');
      expect(handler.getInstalledIds()).toEqual(['t2']);
    });
  });
});
