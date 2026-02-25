/**
 * @fileoverview URL Trigger Handler (P4-03)
 * @description
 * Listens to `chrome.webNavigation.onCompleted` and fires installed URL triggers.
 *
 * URL matching semantics:
 * - kind:'url' - Full URL prefix match (allows query/hash variations)
 * - kind:'domain' - Safe subdomain match (hostname === domain OR hostname.endsWith('.' + domain))
 * - kind:'path' - Pathname prefix match
 *
 * Design rationale:
 * - No regex/wildcards for performance and auditability
 * - Domain matching uses safe subdomain logic to avoid false positives (e.g. 'notexample.com')
 * - Single listener instance manages multiple triggers efficiently
 */

import type { TriggerId } from '../../domain/ids';
import type { TriggerSpecByKind, UrlMatchRule } from '../../domain/triggers';
import type { TriggerFireCallback, TriggerHandler, TriggerHandlerFactory } from './trigger-handler';

// ==================== Types ====================

export interface UrlTriggerHandlerDeps {
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

type UrlTriggerSpec = TriggerSpecByKind<'url'>;

/**
 * Compiled URL match rules for efficient matching
 */
interface CompiledUrlRules {
  /** Full URL prefixes */
  urlPrefixes: string[];
  /** Normalized domains (lowercase, no leading/trailing dots) */
  domains: string[];
  /** Normalized path prefixes (always starts with '/') */
  pathPrefixes: string[];
}

interface InstalledUrlTrigger {
  spec: UrlTriggerSpec;
  rules: CompiledUrlRules;
}

// ==================== Normalization Utilities ====================

/**
 * Normalize domain value
 * - Trim whitespace
 * - Convert to lowercase
 * - Remove leading/trailing dots
 */
function normalizeDomain(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  return normalized || null;
}

/**
 * Normalize path prefix
 * - Trim whitespace
 * - Ensure starts with '/'
 */
function normalizePathPrefix(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Normalize URL prefix
 * - Trim whitespace only
 */
function normalizeUrlPrefix(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Compile URL match rules from spec
 */
function compileUrlMatchRules(match: UrlMatchRule[] | undefined): CompiledUrlRules {
  const urlPrefixes: string[] = [];
  const domains: string[] = [];
  const pathPrefixes: string[] = [];

  for (const rule of match ?? []) {
    const { kind } = rule;
    const raw = typeof rule.value === 'string' ? rule.value : String(rule.value ?? '');

    switch (kind) {
      case 'url': {
        const normalized = normalizeUrlPrefix(raw);
        if (normalized) urlPrefixes.push(normalized);
        break;
      }
      case 'domain': {
        const normalized = normalizeDomain(raw);
        if (normalized) domains.push(normalized);
        break;
      }
      case 'path': {
        const normalized = normalizePathPrefix(raw);
        if (normalized) pathPrefixes.push(normalized);
        break;
      }
    }
  }

  return { urlPrefixes, domains, pathPrefixes };
}

// ==================== Matching Logic ====================

/**
 * Check if hostname matches domain (exact or subdomain)
 */
function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  if (hostname === domain) return true;
  return hostname.endsWith(`.${domain}`);
}

/**
 * Check if URL matches any of the compiled rules
 */
function matchesRules(compiled: CompiledUrlRules, urlString: string, parsed: URL): boolean {
  // URL prefix match
  for (const prefix of compiled.urlPrefixes) {
    if (urlString.startsWith(prefix)) return true;
  }

  // Domain match
  const hostname = parsed.hostname.toLowerCase();
  for (const domain of compiled.domains) {
    if (hostnameMatchesDomain(hostname, domain)) return true;
  }

  // Path prefix match
  const pathname = parsed.pathname || '/';
  for (const prefix of compiled.pathPrefixes) {
    if (pathname.startsWith(prefix)) return true;
  }

  return false;
}

// ==================== Handler Implementation ====================

/**
 * Create URL trigger handler factory
 */
export function createUrlTriggerHandlerFactory(
  deps?: UrlTriggerHandlerDeps,
): TriggerHandlerFactory<'url'> {
  return (fireCallback) => createUrlTriggerHandler(fireCallback, deps);
}

/**
 * Create URL trigger handler
 */
export function createUrlTriggerHandler(
  fireCallback: TriggerFireCallback,
  deps?: UrlTriggerHandlerDeps,
): TriggerHandler<'url'> {
  const logger = deps?.logger ?? console;

  const installed = new Map<TriggerId, InstalledUrlTrigger>();
  let listening = false;

  /**
   * Handle webNavigation.onCompleted event
   */
  const onCompleted = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails): void => {
    // Only handle main frame navigations
    if (details.frameId !== 0) return;

    const urlString = details.url;

    // Parse URL
    let parsed: URL;
    try {
      parsed = new URL(urlString);
    } catch {
      return; // Invalid URL, skip
    }

    if (installed.size === 0) return;

    // Snapshot to avoid iteration hazards during concurrent install/uninstall
    const snapshot = Array.from(installed.entries());

    for (const [triggerId, trigger] of snapshot) {
      if (!matchesRules(trigger.rules, urlString, parsed)) continue;

      // Fire and forget: chrome event listeners should not block navigation
      Promise.resolve(
        fireCallback.onFire(triggerId, {
          sourceTabId: details.tabId,
          sourceUrl: urlString,
        }),
      ).catch((e) => {
        logger.error(`[UrlTriggerHandler] onFire failed for trigger "${triggerId}":`, e);
      });
    }
  };

  /**
   * Ensure listener is registered
   */
  function ensureListening(): void {
    if (listening) return;
    if (!chrome.webNavigation?.onCompleted?.addListener) {
      logger.warn('[UrlTriggerHandler] chrome.webNavigation.onCompleted is unavailable');
      return;
    }
    chrome.webNavigation.onCompleted.addListener(onCompleted);
    listening = true;
  }

  /**
   * Stop listening
   */
  function stopListening(): void {
    if (!listening) return;
    try {
      chrome.webNavigation.onCompleted.removeListener(onCompleted);
    } catch (e) {
      logger.debug('[UrlTriggerHandler] removeListener failed:', e);
    } finally {
      listening = false;
    }
  }

  return {
    kind: 'url',

    async install(trigger: UrlTriggerSpec): Promise<void> {
      installed.set(trigger.id, {
        spec: trigger,
        rules: compileUrlMatchRules(trigger.match),
      });
      ensureListening();
    },

    async uninstall(triggerId: string): Promise<void> {
      installed.delete(triggerId as TriggerId);
      if (installed.size === 0) {
        stopListening();
      }
    },

    async uninstallAll(): Promise<void> {
      installed.clear();
      stopListening();
    },

    getInstalledIds(): string[] {
      return Array.from(installed.keys());
    },
  };
}
