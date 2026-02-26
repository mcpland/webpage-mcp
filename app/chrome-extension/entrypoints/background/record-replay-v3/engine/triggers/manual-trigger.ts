/**
 * @fileoverview Manual Trigger Handler (P4-08)
 * @description
 * Manual triggers are the simplest trigger type - they don't auto-fire.
 * They're only triggered programmatically via RPC or UI.
 *
 * This handler just tracks installed triggers but doesn't set up any listeners.
 * Manual triggers are fired by calling TriggerManager's fire method directly.
 */

import type { TriggerId } from '../../domain/ids';
import type { TriggerSpecByKind } from '../../domain/triggers';
import type { TriggerFireCallback, TriggerHandler, TriggerHandlerFactory } from './trigger-handler';

// ==================== Types ====================

export interface ManualTriggerHandlerDeps {
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

type ManualTriggerSpec = TriggerSpecByKind<'manual'>;

// ==================== Handler Implementation ====================

/**
 * Create manual trigger handler factory
 */
export function createManualTriggerHandlerFactory(
  deps?: ManualTriggerHandlerDeps,
): TriggerHandlerFactory<'manual'> {
  return (fireCallback) => createManualTriggerHandler(fireCallback, deps);
}

/**
 * Create manual trigger handler
 *
 * Manual triggers don't auto-fire - they're only triggered via RPC.
 * This handler just tracks which manual triggers are installed.
 */
export function createManualTriggerHandler(
  _fireCallback: TriggerFireCallback,
  _deps?: ManualTriggerHandlerDeps,
): TriggerHandler<'manual'> {
  const installed = new Map<TriggerId, ManualTriggerSpec>();

  return {
    kind: 'manual',

    async install(trigger: ManualTriggerSpec): Promise<void> {
      installed.set(trigger.id, trigger);
    },

    async uninstall(triggerId: string): Promise<void> {
      installed.delete(triggerId as TriggerId);
    },

    async uninstallAll(): Promise<void> {
      installed.clear();
    },

    getInstalledIds(): string[] {
      return Array.from(installed.keys());
    },
  };
}
