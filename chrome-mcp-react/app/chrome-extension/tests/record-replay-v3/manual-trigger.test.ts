/**
 * @fileoverview Manual Trigger Handler 测试 (P4-08)
 * @description
 * Tests for:
 * - Basic install/uninstall operations
 * - getInstalledIds tracking
 */

import { describe, expect, it, vi } from 'vitest';

import type { TriggerSpecByKind } from '@/entrypoints/background/record-replay-v3/domain/triggers';
import type { TriggerFireCallback } from '@/entrypoints/background/record-replay-v3/engine/triggers/trigger-handler';
import { createManualTriggerHandlerFactory } from '@/entrypoints/background/record-replay-v3/engine/triggers/manual-trigger';

// ==================== Test Utilities ====================

function createSilentLogger(): Pick<Console, 'debug' | 'info' | 'warn' | 'error'> {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

// ==================== Manual Trigger Tests ====================

describe('V3 ManualTriggerHandler', () => {
  describe('Installation', () => {
    it('installs trigger', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createManualTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      const trigger: TriggerSpecByKind<'manual'> = {
        id: 't1' as never,
        kind: 'manual',
        enabled: true,
        flowId: 'flow-1' as never,
      };

      await handler.install(trigger);

      expect(handler.getInstalledIds()).toEqual(['t1']);
    });

    it('installs multiple triggers', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createManualTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      await handler.install({
        id: 't1' as never,
        kind: 'manual',
        enabled: true,
        flowId: 'flow-1' as never,
      });

      await handler.install({
        id: 't2' as never,
        kind: 'manual',
        enabled: true,
        flowId: 'flow-2' as never,
      });

      expect(handler.getInstalledIds().sort()).toEqual(['t1', 't2']);
    });
  });

  describe('Uninstallation', () => {
    it('uninstalls trigger', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createManualTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      await handler.install({
        id: 't1' as never,
        kind: 'manual',
        enabled: true,
        flowId: 'flow-1' as never,
      });

      await handler.uninstall('t1');

      expect(handler.getInstalledIds()).toEqual([]);
    });

    it('uninstallAll clears all triggers', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createManualTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      await handler.install({
        id: 't1' as never,
        kind: 'manual',
        enabled: true,
        flowId: 'flow-1' as never,
      });

      await handler.install({
        id: 't2' as never,
        kind: 'manual',
        enabled: true,
        flowId: 'flow-2' as never,
      });

      await handler.uninstallAll();

      expect(handler.getInstalledIds()).toEqual([]);
    });
  });

  describe('getInstalledIds', () => {
    it('returns empty array when no triggers installed', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createManualTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      expect(handler.getInstalledIds()).toEqual([]);
    });

    it('tracks partial uninstall', async () => {
      const fireCallback: TriggerFireCallback = { onFire: vi.fn(async () => {}) };
      const handler = createManualTriggerHandlerFactory({ logger: createSilentLogger() })(
        fireCallback,
      );

      await handler.install({
        id: 't1' as never,
        kind: 'manual',
        enabled: true,
        flowId: 'flow-1' as never,
      });

      await handler.install({
        id: 't2' as never,
        kind: 'manual',
        enabled: true,
        flowId: 'flow-2' as never,
      });

      await handler.uninstall('t1');

      expect(handler.getInstalledIds()).toEqual(['t2']);
    });
  });
});
