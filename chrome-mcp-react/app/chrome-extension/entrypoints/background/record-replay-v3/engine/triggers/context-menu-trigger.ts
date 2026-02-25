/**
 * @fileoverview ContextMenu Trigger Handler (P4-05)
 * @description
 * Uses `chrome.contextMenus` API to create right-click menu items that fire triggers.
 *
 * Design notes:
 * - Each trigger creates a separate menu item with unique ID
 * - Menu item ID is prefixed with 'rr_v3_' to avoid conflicts
 * - Context types: 'page', 'selection', 'link', 'image', 'video', 'audio', etc.
 * - Captures click info and tab info for trigger context
 */

import type { TriggerId } from '../../domain/ids';
import type { TriggerSpecByKind } from '../../domain/triggers';
import type { TriggerFireCallback, TriggerHandler, TriggerHandlerFactory } from './trigger-handler';

// ==================== Types ====================

export interface ContextMenuTriggerHandlerDeps {
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

type ContextMenuTriggerSpec = TriggerSpecByKind<'contextMenu'>;

interface InstalledContextMenuTrigger {
  spec: ContextMenuTriggerSpec;
  menuItemId: string;
}

// ==================== Constants ====================

const MENU_ITEM_PREFIX = 'rr_v3_';

// Default context types if not specified
const DEFAULT_CONTEXTS: chrome.contextMenus.ContextType[] = ['page'];

// ==================== Handler Implementation ====================

/**
 * Create context menu trigger handler factory
 */
export function createContextMenuTriggerHandlerFactory(
  deps?: ContextMenuTriggerHandlerDeps,
): TriggerHandlerFactory<'contextMenu'> {
  return (fireCallback) => createContextMenuTriggerHandler(fireCallback, deps);
}

/**
 * Create context menu trigger handler
 */
export function createContextMenuTriggerHandler(
  fireCallback: TriggerFireCallback,
  deps?: ContextMenuTriggerHandlerDeps,
): TriggerHandler<'contextMenu'> {
  const logger = deps?.logger ?? console;

  // Map menuItemId -> triggerId for fast lookup
  const menuItemIdToTriggerId = new Map<string, TriggerId>();
  const installed = new Map<TriggerId, InstalledContextMenuTrigger>();
  let listening = false;

  /**
   * Generate unique menu item ID for a trigger
   */
  function generateMenuItemId(triggerId: TriggerId): string {
    return `${MENU_ITEM_PREFIX}${triggerId}`;
  }

  /**
   * Handle chrome.contextMenus.onClicked event
   */
  const onClicked = (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): void => {
    const menuItemId = String(info.menuItemId);
    const triggerId = menuItemIdToTriggerId.get(menuItemId);
    if (!triggerId) return;

    const trigger = installed.get(triggerId);
    if (!trigger) return;

    // Fire and forget: chrome event listeners should not block
    Promise.resolve(
      fireCallback.onFire(triggerId, {
        sourceTabId: tab?.id,
        sourceUrl: info.pageUrl ?? tab?.url,
      }),
    ).catch((e) => {
      logger.error(`[ContextMenuTriggerHandler] onFire failed for trigger "${triggerId}":`, e);
    });
  };

  /**
   * Ensure listener is registered
   */
  function ensureListening(): void {
    if (listening) return;
    if (!chrome.contextMenus?.onClicked?.addListener) {
      logger.warn('[ContextMenuTriggerHandler] chrome.contextMenus.onClicked is unavailable');
      return;
    }
    chrome.contextMenus.onClicked.addListener(onClicked);
    listening = true;
  }

  /**
   * Stop listening
   */
  function stopListening(): void {
    if (!listening) return;
    try {
      chrome.contextMenus.onClicked.removeListener(onClicked);
    } catch (e) {
      logger.debug('[ContextMenuTriggerHandler] removeListener failed:', e);
    } finally {
      listening = false;
    }
  }

  /**
   * Convert context types from spec to chrome API format
   */
  function normalizeContexts(
    contexts: ReadonlyArray<string> | undefined,
  ): chrome.contextMenus.ContextType[] {
    if (!contexts || contexts.length === 0) {
      return DEFAULT_CONTEXTS;
    }
    return contexts as chrome.contextMenus.ContextType[];
  }

  return {
    kind: 'contextMenu',

    async install(trigger: ContextMenuTriggerSpec): Promise<void> {
      const { id, title, contexts } = trigger;
      const menuItemId = generateMenuItemId(id);

      // Check if chrome.contextMenus.create is available
      if (!chrome.contextMenus?.create) {
        logger.warn('[ContextMenuTriggerHandler] chrome.contextMenus.create is unavailable');
        return;
      }

      // Create menu item
      await new Promise<void>((resolve, reject) => {
        chrome.contextMenus.create(
          {
            id: menuItemId,
            title: title,
            contexts: normalizeContexts(contexts),
          },
          () => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve();
            }
          },
        );
      });

      installed.set(id, { spec: trigger, menuItemId });
      menuItemIdToTriggerId.set(menuItemId, id);
      ensureListening();
    },

    async uninstall(triggerId: string): Promise<void> {
      const trigger = installed.get(triggerId as TriggerId);
      if (!trigger) return;

      // Remove menu item
      if (chrome.contextMenus?.remove) {
        await new Promise<void>((resolve) => {
          chrome.contextMenus.remove(trigger.menuItemId, () => {
            // Ignore errors (item may not exist)
            if (chrome.runtime.lastError) {
              logger.debug(
                `[ContextMenuTriggerHandler] Failed to remove menu item: ${chrome.runtime.lastError.message}`,
              );
            }
            resolve();
          });
        });
      }

      menuItemIdToTriggerId.delete(trigger.menuItemId);
      installed.delete(triggerId as TriggerId);

      if (installed.size === 0) {
        stopListening();
      }
    },

    async uninstallAll(): Promise<void> {
      // Remove all menu items created by this handler
      if (chrome.contextMenus?.remove) {
        const removePromises = Array.from(installed.values()).map(
          (trigger) =>
            new Promise<void>((resolve) => {
              chrome.contextMenus.remove(trigger.menuItemId, () => {
                // Ignore errors
                resolve();
              });
            }),
        );
        await Promise.all(removePromises);
      }

      installed.clear();
      menuItemIdToTriggerId.clear();
      stopListening();
    },

    getInstalledIds(): string[] {
      return Array.from(installed.keys());
    },
  };
}
