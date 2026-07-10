/**
 * @fileoverview DOM Trigger Handler (P4-06)
 * @description
 * Bridges DOM triggers to a content-script MutationObserver (`inject-scripts/dom-observer.js`).
 *
 * Contract:
 * - Background -> content: { action: 'set_dom_triggers', triggers: [...] }
 * - Content -> background: { action: 'dom_trigger_fired', triggerId, url }
 * - Ping: { action: 'dom_observer_ping' } -> { status:'pong' }
 *
 * Design notes:
 * - Reuses the existing DOM observer script for consistency and auditability.
 * - Single handler instance manages multiple triggers.
 * - Sync is coalesced to avoid storms during TriggerManager.refresh().
 * - Top-frame only (no frameId in TriggerFireContext).
 */

import type { TriggerId } from '../../domain/ids';
import type { TriggerSpecByKind } from '../../domain/triggers';
import {
  DOM_TRIGGER_LIMITS,
  normalizeDomTriggerDebounceMs,
  normalizeDomTriggerSelector,
  normalizeDomTriggerTabId,
} from '../../domain/dom-trigger-policy';
import { CONTENT_MESSAGE_TYPES, TOOL_MESSAGE_TYPES } from '../../../../../common/message-types';
import type { TriggerFireCallback, TriggerHandler, TriggerHandlerFactory } from './trigger-handler';

// ==================== Types ====================

export interface DomTriggerHandlerDeps {
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

type DomTriggerSpec = TriggerSpecByKind<'dom'>;

/**
 * Payload sent to dom-observer content script
 */
interface DomObserverTriggerPayload {
  id: string;
  selector: string;
  appear: boolean;
  once: boolean;
  debounceMs: number;
}

/**
 * Message received when DOM trigger fires
 */
interface DomTriggerFiredMessage {
  action: string;
  triggerId: string;
  url?: string;
}

// ==================== Constants ====================

const DOM_OBSERVER_SCRIPT_FILE = 'inject-scripts/dom-observer.js';

// ==================== Utilities ====================

/**
 * Build payload for dom-observer content script
 */
function buildDomObserverPayload(
  installed: Map<TriggerId, DomTriggerSpec>,
  tabId: number,
): DomObserverTriggerPayload[] {
  const out: DomObserverTriggerPayload[] = [];

  for (const t of installed.values()) {
    if (t.tabId !== tabId) continue;

    out.push({
      id: t.id,
      selector: t.selector,
      appear: t.appear !== false, // default true
      once: t.once !== false, // default true
      debounceMs: normalizeDomTriggerDebounceMs(t.debounceMs),
    });
    if (out.length >= DOM_TRIGGER_LIMITS.maxTriggersPerTab) break;
  }

  // Deterministic ordering for tests and debugging
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Check if URL is injectable (http/https/file)
 */
function isInjectableUrl(url: string): boolean {
  return /^(https?:|file:)/i.test(url);
}

/**
 * Type guard for DOM trigger fired message
 */
function isDomTriggerFiredMessage(msg: unknown): msg is DomTriggerFiredMessage {
  if (!msg || typeof msg !== 'object') return false;
  const anyMsg = msg as Record<string, unknown>;
  return (
    anyMsg.action === TOOL_MESSAGE_TYPES.DOM_TRIGGER_FIRED &&
    typeof anyMsg.triggerId === 'string' &&
    anyMsg.triggerId.length > 0 &&
    anyMsg.triggerId.length <= 256
  );
}

// ==================== Handler Implementation ====================

/**
 * Create DOM trigger handler factory
 */
export function createDomTriggerHandlerFactory(
  deps?: DomTriggerHandlerDeps,
): TriggerHandlerFactory<'dom'> {
  return (fireCallback) => createDomTriggerHandler(fireCallback, deps);
}

/**
 * Create DOM trigger handler
 */
export function createDomTriggerHandler(
  fireCallback: TriggerFireCallback,
  deps?: DomTriggerHandlerDeps,
): TriggerHandler<'dom'> {
  const logger = deps?.logger ?? console;

  const installed = new Map<TriggerId, DomTriggerSpec>();

  // Tabs that received a payload are retained until an empty payload clears them.
  let previouslyScopedTabs = new Set<number>();

  // Listener states
  let messageListening = false;
  let navigationListening = false;

  // Coalesce sync to avoid storms (e.g. TriggerManager.refresh)
  let syncPromise: Promise<void> | null = null;
  let pendingSync = false;

  /**
   * Ping dom-observer to check if injected
   */
  async function pingDomObserver(tabId: number): Promise<boolean> {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, {
        action: CONTENT_MESSAGE_TYPES.DOM_OBSERVER_PING,
      });
      return (resp as { status?: string } | undefined)?.status === 'pong';
    } catch {
      return false;
    }
  }

  /**
   * Inject dom-observer script if not present
   */
  async function ensureDomObserverInjected(tabId: number): Promise<void> {
    const ok = await pingDomObserver(tabId);
    if (ok) return;

    if (!chrome.scripting?.executeScript) {
      logger.warn('[DomTriggerHandler] chrome.scripting.executeScript is unavailable');
      return;
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [DOM_OBSERVER_SCRIPT_FILE],
        world: 'ISOLATED',
      });
    } catch (e) {
      // Best-effort: injection can fail on restricted pages (chrome://, etc.)
      logger.debug('[DomTriggerHandler] executeScript failed:', e);
    }
  }

  /**
   * Send triggers to dom-observer
   */
  async function setDomTriggers(
    tabId: number,
    triggers: DomObserverTriggerPayload[],
  ): Promise<void> {
    try {
      await chrome.tabs.sendMessage(tabId, {
        action: TOOL_MESSAGE_TYPES.SET_DOM_TRIGGERS,
        triggers,
      });
    } catch (e) {
      // No receiver / restricted pages are expected; keep best-effort.
      logger.debug('[DomTriggerHandler] set_dom_triggers sendMessage failed:', e);
    }
  }

  /**
   * Sync triggers to a single tab
   */
  async function syncTab(tabId: number): Promise<void> {
    let url: string | undefined;
    if (chrome.tabs?.get) {
      try {
        url = (await chrome.tabs.get(tabId)).url;
      } catch {
        // A removed tab is expected while clearing a stale scope.
        return;
      }
    }
    if (typeof url === 'string' && url && !isInjectableUrl(url)) return;

    const payload = buildDomObserverPayload(installed, tabId);
    if (payload.length > 0) {
      await ensureDomObserverInjected(tabId);
    }
    await setDomTriggers(tabId, payload);
  }

  async function doSyncScopedTabs(): Promise<void> {
    const nextScopedTabs = new Set<number>();
    for (const trigger of installed.values()) {
      if (trigger.tabId !== undefined) nextScopedTabs.add(trigger.tabId);
    }

    const tabsToSync = new Set([...previouslyScopedTabs, ...nextScopedTabs]);
    previouslyScopedTabs = nextScopedTabs;
    await Promise.all(Array.from(tabsToSync, (tabId) => syncTab(tabId)));
  }

  /**
   * Request sync (coalesced)
   */
  async function requestSyncScopedTabs(): Promise<void> {
    pendingSync = true;
    if (!syncPromise) {
      syncPromise = (async () => {
        while (pendingSync) {
          pendingSync = false;
          await doSyncScopedTabs();
        }
      })().finally(() => {
        syncPromise = null;
      });
    }
    return syncPromise;
  }

  /**
   * Handle runtime message (dom_trigger_fired)
   */
  const onRuntimeMessage = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean => {
    if (!isDomTriggerFiredMessage(message)) return false;

    const triggerId = message.triggerId as TriggerId;
    const trigger = installed.get(triggerId);
    const sourceTabId = sender.tab?.id;
    if (
      !trigger ||
      sourceTabId === undefined ||
      trigger.tabId !== sourceTabId ||
      (sender.id !== undefined && sender.id !== chrome.runtime.id) ||
      (sender.frameId !== undefined && sender.frameId !== 0)
    ) {
      try {
        sendResponse({ ok: false });
      } catch {
        // ignore
      }
      return false;
    }

    const sourceUrl = sender.tab?.url;

    // Fire-and-forget: do not block chrome messaging thread
    Promise.resolve(fireCallback.onFire(triggerId, { sourceTabId, sourceUrl })).catch((e) => {
      logger.error(`[DomTriggerHandler] onFire failed for trigger "${triggerId}":`, e);
    });

    try {
      sendResponse({ ok: true });
    } catch {
      // ignore
    }
    return false;
  };

  /**
   * Handle navigation completed (re-sync triggers to tab)
   */
  const onNavigationCompleted = (
    details: chrome.webNavigation.WebNavigationFramedCallbackDetails,
  ): void => {
    if (details.frameId !== 0) return; // Top frame only
    if (installed.size === 0) return;
    if (!Array.from(installed.values()).some((trigger) => trigger.tabId === details.tabId)) return;
    if (typeof details.url === 'string' && details.url && !isInjectableUrl(details.url)) return;

    void syncTab(details.tabId).catch((e) => {
      logger.debug('[DomTriggerHandler] syncTab on navigation failed:', e);
    });
  };

  function ensureMessageListening(): void {
    if (messageListening) return;
    if (!chrome.runtime?.onMessage?.addListener) {
      logger.warn('[DomTriggerHandler] chrome.runtime.onMessage is unavailable');
      return;
    }
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    messageListening = true;
  }

  function stopMessageListening(): void {
    if (!messageListening) return;
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (e) {
      logger.debug('[DomTriggerHandler] runtime.onMessage.removeListener failed:', e);
    } finally {
      messageListening = false;
    }
  }

  function ensureNavigationListening(): void {
    if (navigationListening) return;
    if (!chrome.webNavigation?.onCompleted?.addListener) {
      logger.warn('[DomTriggerHandler] chrome.webNavigation.onCompleted is unavailable');
      return;
    }
    chrome.webNavigation.onCompleted.addListener(onNavigationCompleted);
    navigationListening = true;
  }

  function stopNavigationListening(): void {
    if (!navigationListening) return;
    try {
      chrome.webNavigation.onCompleted.removeListener(onNavigationCompleted);
    } catch (e) {
      logger.debug('[DomTriggerHandler] webNavigation.onCompleted.removeListener failed:', e);
    } finally {
      navigationListening = false;
    }
  }

  return {
    kind: 'dom',

    async install(trigger: DomTriggerSpec): Promise<void> {
      let normalized: DomTriggerSpec;
      try {
        if (trigger.tabId === undefined) {
          logger.warn(
            `[DomTriggerHandler] Ignoring legacy unscoped DOM trigger "${trigger.id}"`,
          );
          return;
        }
        const tabId = normalizeDomTriggerTabId(trigger.tabId);
        const existingForTab = Array.from(installed.values()).filter(
          (candidate) => candidate.id !== trigger.id && candidate.tabId === tabId,
        ).length;
        if (existingForTab >= DOM_TRIGGER_LIMITS.maxTriggersPerTab) {
          logger.warn(
            `[DomTriggerHandler] Ignoring DOM trigger "${trigger.id}": tab ${tabId} reached its trigger limit`,
          );
          return;
        }
        normalized = {
          ...trigger,
          tabId,
          selector: normalizeDomTriggerSelector(trigger.selector),
          debounceMs: normalizeDomTriggerDebounceMs(trigger.debounceMs),
        };
      } catch (error) {
        logger.warn(`[DomTriggerHandler] Ignoring invalid DOM trigger "${trigger.id}":`, error);
        return;
      }
      installed.set(normalized.id, normalized);

      // Ensure listeners are ready before pushing triggers
      ensureMessageListening();
      ensureNavigationListening();

      await requestSyncScopedTabs();
    },

    async uninstall(triggerId: string): Promise<void> {
      installed.delete(triggerId as TriggerId);

      await requestSyncScopedTabs();

      if (installed.size === 0) {
        stopNavigationListening();
        stopMessageListening();
      }
    },

    async uninstallAll(): Promise<void> {
      installed.clear();

      await requestSyncScopedTabs();

      stopNavigationListening();
      stopMessageListening();
    },

    getInstalledIds(): string[] {
      return Array.from(installed.keys());
    },
  };
}
