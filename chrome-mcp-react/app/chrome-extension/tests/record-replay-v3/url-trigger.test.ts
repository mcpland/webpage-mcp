/**
 * @fileoverview URL Trigger Handler 测试 (P4-03)
 * @description
 * Tests for:
 * - URL matching semantics (domain, path, url prefix)
 * - Listener lifecycle (add/remove on install/uninstall)
 * - Edge cases (subframe, invalid URL)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TriggerSpecByKind } from '@/entrypoints/background/record-replay-v3/domain/triggers';
import type { TriggerFireCallback } from '@/entrypoints/background/record-replay-v3/engine/triggers/trigger-handler';
import { createUrlTriggerHandlerFactory } from '@/entrypoints/background/record-replay-v3/engine/triggers/url-trigger';

// ==================== Test Utilities ====================

function createSilentLogger(): Pick<Console, 'debug' | 'info' | 'warn' | 'error'> {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
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

// ==================== URL Trigger Tests ====================

describe('V3 UrlTriggerHandler', () => {
  let webNav: WebNavigationMock;

  beforeEach(() => {
    webNav = createWebNavigationMock();
    (globalThis.chrome as unknown as { webNavigation: unknown }).webNavigation = {
      onCompleted: webNav.onCompleted,
    };
  });

  describe('Domain matching', () => {
    it('matches exact domain', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createUrlTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'url'> = {
        id: 't1' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [{ kind: 'domain', value: 'example.com' }],
      };

      await handler.install(trigger);

      webNav.emitCompleted({ tabId: 1, frameId: 0, url: 'https://example.com/page' });
      expect(fireCallback.onFire).toHaveBeenCalledWith('t1', {
        sourceTabId: 1,
        sourceUrl: 'https://example.com/page',
      });
    });

    it('matches subdomain', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createUrlTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'url'> = {
        id: 't1' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [{ kind: 'domain', value: 'example.com' }],
      };

      await handler.install(trigger);

      webNav.emitCompleted({ tabId: 1, frameId: 0, url: 'https://www.example.com/a' });
      expect(fireCallback.onFire).toHaveBeenCalledTimes(1);

      webNav.emitCompleted({ tabId: 1, frameId: 0, url: 'https://sub.sub.example.com/b' });
      expect(fireCallback.onFire).toHaveBeenCalledTimes(2);
    });

    it('avoids substring false-positives', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createUrlTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'url'> = {
        id: 't1' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [{ kind: 'domain', value: 'example.com' }],
      };

      await handler.install(trigger);

      // Should NOT match - domain contains "example.com" as substring but is not example.com or subdomain
      webNav.emitCompleted({ tabId: 1, frameId: 0, url: 'https://notexample.com/a' });
      expect(fireCallback.onFire).not.toHaveBeenCalled();

      webNav.emitCompleted({ tabId: 1, frameId: 0, url: 'https://example.com.evil.com/a' });
      expect(fireCallback.onFire).not.toHaveBeenCalled();
    });

    it('handles domain with leading/trailing dots', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createUrlTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'url'> = {
        id: 't1' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [{ kind: 'domain', value: '..example.com..' }],
      };

      await handler.install(trigger);

      webNav.emitCompleted({ tabId: 1, frameId: 0, url: 'https://example.com/page' });
      expect(fireCallback.onFire).toHaveBeenCalledTimes(1);
    });
  });

  describe('Path matching', () => {
    it('matches path prefix', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createUrlTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'url'> = {
        id: 't1' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [{ kind: 'path', value: '/foo' }],
      };

      await handler.install(trigger);

      webNav.emitCompleted({ tabId: 1, frameId: 0, url: 'https://any.com/foo/bar' });
      expect(fireCallback.onFire).toHaveBeenCalledTimes(1);

      webNav.emitCompleted({ tabId: 1, frameId: 0, url: 'https://any.com/foobar' });
      expect(fireCallback.onFire).toHaveBeenCalledTimes(2);
    });

    it('does not match non-matching path', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createUrlTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'url'> = {
        id: 't1' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [{ kind: 'path', value: '/foo' }],
      };

      await handler.install(trigger);

      webNav.emitCompleted({ tabId: 1, frameId: 0, url: 'https://any.com/bar' });
      expect(fireCallback.onFire).not.toHaveBeenCalled();
    });

    it('normalizes path without leading slash', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createUrlTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'url'> = {
        id: 't1' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [{ kind: 'path', value: 'foo' }], // No leading slash
      };

      await handler.install(trigger);

      webNav.emitCompleted({ tabId: 1, frameId: 0, url: 'https://any.com/foo/bar' });
      expect(fireCallback.onFire).toHaveBeenCalledTimes(1);
    });
  });

  describe('URL prefix matching', () => {
    it('matches full URL prefix', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createUrlTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'url'> = {
        id: 't1' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [{ kind: 'url', value: 'https://example.com/a' }],
      };

      await handler.install(trigger);

      // Matches prefix with query/hash
      webNav.emitCompleted({ tabId: 1, frameId: 0, url: 'https://example.com/a?x=1#hash' });
      expect(fireCallback.onFire).toHaveBeenCalledTimes(1);

      // Matches prefix with additional path
      webNav.emitCompleted({ tabId: 1, frameId: 0, url: 'https://example.com/a/b/c' });
      expect(fireCallback.onFire).toHaveBeenCalledTimes(2);
    });

    it('does not match non-matching URL', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createUrlTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'url'> = {
        id: 't1' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [{ kind: 'url', value: 'https://example.com/a' }],
      };

      await handler.install(trigger);

      webNav.emitCompleted({ tabId: 1, frameId: 0, url: 'https://example.com/b' });
      expect(fireCallback.onFire).not.toHaveBeenCalled();
    });
  });

  describe('Multiple rules (OR logic)', () => {
    it('fires if any rule matches', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createUrlTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'url'> = {
        id: 't1' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [
          { kind: 'domain', value: 'example.com' },
          { kind: 'path', value: '/special' },
        ],
      };

      await handler.install(trigger);

      // Match by domain
      webNav.emitCompleted({ tabId: 1, frameId: 0, url: 'https://example.com/any' });
      expect(fireCallback.onFire).toHaveBeenCalledTimes(1);

      // Match by path on different domain
      webNav.emitCompleted({ tabId: 1, frameId: 0, url: 'https://other.com/special/page' });
      expect(fireCallback.onFire).toHaveBeenCalledTimes(2);
    });
  });

  describe('Frame filtering', () => {
    it('ignores subframe navigations', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createUrlTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'url'> = {
        id: 't1' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [{ kind: 'domain', value: 'example.com' }],
      };

      await handler.install(trigger);

      // frameId !== 0 should be ignored
      webNav.emitCompleted({ tabId: 1, frameId: 1, url: 'https://example.com/' });
      expect(fireCallback.onFire).not.toHaveBeenCalled();

      webNav.emitCompleted({ tabId: 1, frameId: 99, url: 'https://example.com/' });
      expect(fireCallback.onFire).not.toHaveBeenCalled();
    });
  });

  describe('Listener lifecycle', () => {
    it('registers single listener on first install', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createUrlTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const t1: TriggerSpecByKind<'url'> = {
        id: 't1' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [{ kind: 'domain', value: 'a.com' }],
      };

      const t2: TriggerSpecByKind<'url'> = {
        id: 't2' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [{ kind: 'domain', value: 'b.com' }],
      };

      await handler.install(t1);
      await handler.install(t2);

      // Only one listener should be added
      expect(webNav.onCompleted.addListener).toHaveBeenCalledTimes(1);
    });

    it('removes listener when all triggers uninstalled', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createUrlTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const t1: TriggerSpecByKind<'url'> = {
        id: 't1' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [{ kind: 'domain', value: 'a.com' }],
      };

      const t2: TriggerSpecByKind<'url'> = {
        id: 't2' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [{ kind: 'domain', value: 'b.com' }],
      };

      await handler.install(t1);
      await handler.install(t2);

      await handler.uninstall('t1');
      expect(webNav.onCompleted.removeListener).not.toHaveBeenCalled();

      await handler.uninstall('t2');
      expect(webNav.onCompleted.removeListener).toHaveBeenCalledTimes(1);
    });

    it('removes listener on uninstallAll', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createUrlTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const t1: TriggerSpecByKind<'url'> = {
        id: 't1' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [{ kind: 'domain', value: 'example.com' }],
      };

      await handler.install(t1);
      await handler.uninstallAll();

      expect(webNav.onCompleted.removeListener).toHaveBeenCalledTimes(1);
    });
  });

  describe('getInstalledIds', () => {
    it('returns installed trigger IDs', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createUrlTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const t1: TriggerSpecByKind<'url'> = {
        id: 't1' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [{ kind: 'domain', value: 'a.com' }],
      };

      const t2: TriggerSpecByKind<'url'> = {
        id: 't2' as never,
        kind: 'url',
        enabled: true,
        flowId: 'flow-1' as never,
        match: [{ kind: 'domain', value: 'b.com' }],
      };

      await handler.install(t1);
      await handler.install(t2);

      expect(handler.getInstalledIds().sort()).toEqual(['t1', 't2']);

      await handler.uninstall('t1');
      expect(handler.getInstalledIds()).toEqual(['t2']);
    });
  });
});
