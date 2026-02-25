/**
 * @fileoverview Command Trigger Handler 测试 (P4-04)
 * @description
 * Tests for:
 * - Command event handling
 * - Listener lifecycle
 * - CommandKey mapping
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TriggerSpecByKind } from '@/entrypoints/background/record-replay-v3/domain/triggers';
import type { TriggerFireCallback } from '@/entrypoints/background/record-replay-v3/engine/triggers/trigger-handler';
import { createCommandTriggerHandlerFactory } from '@/entrypoints/background/record-replay-v3/engine/triggers/command-trigger';

// ==================== Test Utilities ====================

function createSilentLogger(): Pick<Console, 'debug' | 'info' | 'warn' | 'error'> {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

interface CommandsMock {
  onCommand: {
    addListener: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };
  emitCommand: (command: string, tab?: { id?: number; url?: string }) => void;
}

function createCommandsMock(): CommandsMock {
  const listeners = new Set<(command: string, tab?: { id?: number; url?: string }) => void>();

  const onCommand = {
    addListener: vi.fn((cb: (command: string, tab?: { id?: number; url?: string }) => void) => {
      listeners.add(cb);
    }),
    removeListener: vi.fn((cb: (command: string, tab?: { id?: number; url?: string }) => void) => {
      listeners.delete(cb);
    }),
  };

  return {
    onCommand,
    emitCommand: (command, tab) => {
      for (const cb of listeners) cb(command, tab);
    },
  };
}

// ==================== Command Trigger Tests ====================

describe('V3 CommandTriggerHandler', () => {
  let commandsMock: CommandsMock;

  beforeEach(() => {
    commandsMock = createCommandsMock();
    (globalThis.chrome as unknown as { commands: unknown }).commands = {
      onCommand: commandsMock.onCommand,
    };
  });

  describe('Command handling', () => {
    it('fires on matching command', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createCommandTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'command'> = {
        id: 't1' as never,
        kind: 'command',
        enabled: true,
        flowId: 'flow-1' as never,
        commandKey: 'run-flow-1',
      };

      await handler.install(trigger);

      commandsMock.emitCommand('run-flow-1', { id: 123, url: 'https://example.com' });

      expect(fireCallback.onFire).toHaveBeenCalledWith('t1', {
        sourceTabId: 123,
        sourceUrl: 'https://example.com',
      });
    });

    it('ignores non-matching command', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createCommandTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'command'> = {
        id: 't1' as never,
        kind: 'command',
        enabled: true,
        flowId: 'flow-1' as never,
        commandKey: 'run-flow-1',
      };

      await handler.install(trigger);

      commandsMock.emitCommand('run-flow-2');

      expect(fireCallback.onFire).not.toHaveBeenCalled();
    });

    it('handles command without tab info', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createCommandTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'command'> = {
        id: 't1' as never,
        kind: 'command',
        enabled: true,
        flowId: 'flow-1' as never,
        commandKey: 'run-flow-1',
      };

      await handler.install(trigger);

      commandsMock.emitCommand('run-flow-1');

      expect(fireCallback.onFire).toHaveBeenCalledWith('t1', {
        sourceTabId: undefined,
        sourceUrl: undefined,
      });
    });
  });

  describe('Multiple triggers', () => {
    it('handles multiple command triggers', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const handler = createCommandTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const t1: TriggerSpecByKind<'command'> = {
        id: 't1' as never,
        kind: 'command',
        enabled: true,
        flowId: 'flow-1' as never,
        commandKey: 'cmd-1',
      };

      const t2: TriggerSpecByKind<'command'> = {
        id: 't2' as never,
        kind: 'command',
        enabled: true,
        flowId: 'flow-2' as never,
        commandKey: 'cmd-2',
      };

      await handler.install(t1);
      await handler.install(t2);

      commandsMock.emitCommand('cmd-1');
      expect(fireCallback.onFire).toHaveBeenCalledWith('t1', expect.anything());

      commandsMock.emitCommand('cmd-2');
      expect(fireCallback.onFire).toHaveBeenCalledWith('t2', expect.anything());
    });

    it('overwrites when same commandKey used', async () => {
      const fireCallback: TriggerFireCallback = {
        onFire: vi.fn(async () => {}),
      };

      const warnFn = vi.fn();
      const handler = createCommandTriggerHandlerFactory({
        logger: { ...createSilentLogger(), warn: warnFn },
      })(fireCallback);

      const t1: TriggerSpecByKind<'command'> = {
        id: 't1' as never,
        kind: 'command',
        enabled: true,
        flowId: 'flow-1' as never,
        commandKey: 'same-cmd',
      };

      const t2: TriggerSpecByKind<'command'> = {
        id: 't2' as never,
        kind: 'command',
        enabled: true,
        flowId: 'flow-2' as never,
        commandKey: 'same-cmd',
      };

      await handler.install(t1);
      await handler.install(t2);

      // Should warn about overwriting
      expect(warnFn).toHaveBeenCalled();

      // Only t2 should be called
      commandsMock.emitCommand('same-cmd');
      expect(fireCallback.onFire).toHaveBeenCalledTimes(1);
      expect(fireCallback.onFire).toHaveBeenCalledWith('t2', expect.anything());

      // t1 should be removed from installed
      expect(handler.getInstalledIds()).toEqual(['t2']);
    });
  });

  describe('Listener lifecycle', () => {
    it('registers listener on first install', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCommandTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'command'> = {
        id: 't1' as never,
        kind: 'command',
        enabled: true,
        flowId: 'flow-1' as never,
        commandKey: 'cmd-1',
      };

      await handler.install(trigger);

      expect(commandsMock.onCommand.addListener).toHaveBeenCalledTimes(1);
    });

    it('removes listener when all triggers uninstalled', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCommandTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const t1: TriggerSpecByKind<'command'> = {
        id: 't1' as never,
        kind: 'command',
        enabled: true,
        flowId: 'flow-1' as never,
        commandKey: 'cmd-1',
      };

      const t2: TriggerSpecByKind<'command'> = {
        id: 't2' as never,
        kind: 'command',
        enabled: true,
        flowId: 'flow-2' as never,
        commandKey: 'cmd-2',
      };

      await handler.install(t1);
      await handler.install(t2);

      await handler.uninstall('t1');
      expect(commandsMock.onCommand.removeListener).not.toHaveBeenCalled();

      await handler.uninstall('t2');
      expect(commandsMock.onCommand.removeListener).toHaveBeenCalledTimes(1);
    });

    it('removes listener on uninstallAll', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCommandTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'command'> = {
        id: 't1' as never,
        kind: 'command',
        enabled: true,
        flowId: 'flow-1' as never,
        commandKey: 'cmd-1',
      };

      await handler.install(trigger);
      await handler.uninstallAll();

      expect(commandsMock.onCommand.removeListener).toHaveBeenCalledTimes(1);
    });
  });

  describe('getInstalledIds', () => {
    it('returns installed trigger IDs', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createCommandTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const t1: TriggerSpecByKind<'command'> = {
        id: 't1' as never,
        kind: 'command',
        enabled: true,
        flowId: 'flow-1' as never,
        commandKey: 'cmd-1',
      };

      const t2: TriggerSpecByKind<'command'> = {
        id: 't2' as never,
        kind: 'command',
        enabled: true,
        flowId: 'flow-2' as never,
        commandKey: 'cmd-2',
      };

      await handler.install(t1);
      await handler.install(t2);

      expect(handler.getInstalledIds().sort()).toEqual(['t1', 't2']);

      await handler.uninstall('t1');
      expect(handler.getInstalledIds()).toEqual(['t2']);
    });
  });
});
