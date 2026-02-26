/**
 * @fileoverview Command Trigger Handler (P4-04)
 * @description
 * Listens to `chrome.commands.onCommand` and fires installed command triggers.
 *
 * Command triggers allow users to execute flows via keyboard shortcuts
 * defined in the extension's manifest.
 *
 * Design notes:
 * - Commands must be registered in manifest.json under the "commands" key
 * - Each command is identified by its commandKey (e.g., "run-flow-1")
 * - Active tab info is captured when available
 */

import type { TriggerId } from '../../domain/ids';
import type { TriggerSpecByKind } from '../../domain/triggers';
import type { TriggerFireCallback, TriggerHandler, TriggerHandlerFactory } from './trigger-handler';

// ==================== Types ====================

export interface CommandTriggerHandlerDeps {
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

type CommandTriggerSpec = TriggerSpecByKind<'command'>;

interface InstalledCommandTrigger {
  spec: CommandTriggerSpec;
}

// ==================== Handler Implementation ====================

/**
 * Create command trigger handler factory
 */
export function createCommandTriggerHandlerFactory(
  deps?: CommandTriggerHandlerDeps,
): TriggerHandlerFactory<'command'> {
  return (fireCallback) => createCommandTriggerHandler(fireCallback, deps);
}

/**
 * Create command trigger handler
 */
export function createCommandTriggerHandler(
  fireCallback: TriggerFireCallback,
  deps?: CommandTriggerHandlerDeps,
): TriggerHandler<'command'> {
  const logger = deps?.logger ?? console;

  // Map commandKey -> triggerId for fast lookup
  const commandKeyToTriggerId = new Map<string, TriggerId>();
  const installed = new Map<TriggerId, InstalledCommandTrigger>();
  let listening = false;

  /**
   * Handle chrome.commands.onCommand event
   */
  const onCommand = (command: string, tab?: chrome.tabs.Tab): void => {
    const triggerId = commandKeyToTriggerId.get(command);
    if (!triggerId) return;

    const trigger = installed.get(triggerId);
    if (!trigger) return;

    // Fire and forget: chrome event listeners should not block
    Promise.resolve(
      fireCallback.onFire(triggerId, {
        sourceTabId: tab?.id,
        sourceUrl: tab?.url,
      }),
    ).catch((e) => {
      logger.error(`[CommandTriggerHandler] onFire failed for trigger "${triggerId}":`, e);
    });
  };

  /**
   * Ensure listener is registered
   */
  function ensureListening(): void {
    if (listening) return;
    if (!chrome.commands?.onCommand?.addListener) {
      logger.warn('[CommandTriggerHandler] chrome.commands.onCommand is unavailable');
      return;
    }
    chrome.commands.onCommand.addListener(onCommand);
    listening = true;
  }

  /**
   * Stop listening
   */
  function stopListening(): void {
    if (!listening) return;
    try {
      chrome.commands.onCommand.removeListener(onCommand);
    } catch (e) {
      logger.debug('[CommandTriggerHandler] removeListener failed:', e);
    } finally {
      listening = false;
    }
  }

  return {
    kind: 'command',

    async install(trigger: CommandTriggerSpec): Promise<void> {
      const { id, commandKey } = trigger;

      // Warn if commandKey already used by another trigger
      const existingTriggerId = commandKeyToTriggerId.get(commandKey);
      if (existingTriggerId && existingTriggerId !== id) {
        logger.warn(
          `[CommandTriggerHandler] Command "${commandKey}" already used by trigger "${existingTriggerId}", overwriting with "${id}"`,
        );
        // Remove old mapping
        installed.delete(existingTriggerId);
      }

      installed.set(id, { spec: trigger });
      commandKeyToTriggerId.set(commandKey, id);
      ensureListening();
    },

    async uninstall(triggerId: string): Promise<void> {
      const trigger = installed.get(triggerId as TriggerId);
      if (trigger) {
        commandKeyToTriggerId.delete(trigger.spec.commandKey);
        installed.delete(triggerId as TriggerId);
      }

      if (installed.size === 0) {
        stopListening();
      }
    },

    async uninstallAll(): Promise<void> {
      installed.clear();
      commandKeyToTriggerId.clear();
      stopListening();
    },

    getInstalledIds(): string[] {
      return Array.from(installed.keys());
    },
  };
}
