const PROPS_AGENT_SCRIPT_PATH = 'inject-scripts/props-agent.js';
const REGISTRATION_ID_PREFIX = 'mcp_we_props_early';
const TAB_REGISTRATION_STORAGE_PREFIX = 'web-editor-props-early-tab-';

export interface EarlyInjectionResult {
  id: string;
  host: string;
  matches: string[];
  alreadyRegistered: boolean;
}

let registryQueue: Promise<void> = Promise.resolve();

function serializeRegistryOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = registryQueue.then(operation, operation);
  registryQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function registrationStorageKey(tabId: number): string {
  return `${TAB_REGISTRATION_STORAGE_PREFIX}${tabId}`;
}

function sanitizeContentScriptId(input: string): string {
  const cleaned = String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 64) || 'site';
}

async function buildRegistrationId(host: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(host));
  const hash = Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${REGISTRATION_ID_PREFIX}_${sanitizeContentScriptId(host)}_${hash}`;
}

function buildEarlyInjectionPatterns(tabUrl: string): { host: string; matches: string[] } {
  let url: URL;
  try {
    url = new URL(tabUrl);
  } catch {
    throw new Error('Invalid tab URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Early injection only supports http/https pages (got ${url.protocol})`);
  }

  const host = url.hostname.trim();
  if (!host) {
    throw new Error('Unable to derive host from tab URL');
  }

  return { host, matches: [`*://${host}/*`] };
}

function referencedRegistrationIds(stored: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith(TAB_REGISTRATION_STORAGE_PREFIX) && typeof value === 'string') {
      ids.add(value);
    }
  }
  return ids;
}

async function unregisterIfUnreferenced(id: string): Promise<void> {
  const stored = await chrome.storage.session.get(null);
  if (referencedRegistrationIds(stored).has(id)) {
    return;
  }

  await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {
    // The registration may already have been removed by an extension update.
  });
}

/**
 * Register the MAIN-world props agent for the current browser session.
 * Per-tab associations keep the host registration alive only while at least
 * one editor tab explicitly requested it.
 */
export function registerPropsAgentEarlyInjection(
  tabId: number,
  tabUrl: string,
): Promise<EarlyInjectionResult> {
  return serializeRegistryOperation(async () => {
    const { host, matches } = buildEarlyInjectionPatterns(tabUrl);
    const id = await buildRegistrationId(host);
    const storageKey = registrationStorageKey(tabId);
    const previous = await chrome.storage.session.get(storageKey);
    const previousId = typeof previous[storageKey] === 'string' ? previous[storageKey] : undefined;

    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    const alreadyRegistered = existing.some((script) => script.id === id);

    if (!alreadyRegistered) {
      await chrome.scripting.registerContentScripts([
        {
          id,
          js: [PROPS_AGENT_SCRIPT_PATH],
          matches,
          runAt: 'document_start',
          world: 'MAIN',
          allFrames: false,
          persistAcrossSessions: false,
        },
      ]);
      console.log(`[WebEditor] Registered early injection for ${host}`);
    }

    try {
      await chrome.storage.session.set({ [storageKey]: id });
    } catch (error) {
      if (!alreadyRegistered) {
        await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
      }
      throw error;
    }

    if (previousId && previousId !== id) {
      await unregisterIfUnreferenced(previousId);
    }

    return { id, host, matches, alreadyRegistered };
  });
}

/** Release a tab's registration and remove the script when no other tab uses it. */
export function releasePropsAgentEarlyInjection(tabId: number): Promise<void> {
  return serializeRegistryOperation(async () => {
    const storageKey = registrationStorageKey(tabId);
    const stored = await chrome.storage.session.get(storageKey);
    const id = typeof stored[storageKey] === 'string' ? stored[storageKey] : undefined;

    await chrome.storage.session.remove(storageKey);
    if (id) {
      await unregisterIfUnreferenced(id);
    }
  });
}

/** Remove registrations left behind by older releases or interrupted setup. */
export function pruneOrphanedPropsAgentEarlyInjections(): Promise<void> {
  return serializeRegistryOperation(async () => {
    const [stored, scripts] = await Promise.all([
      chrome.storage.session.get(null),
      chrome.scripting.getRegisteredContentScripts(),
    ]);
    const referencedIds = referencedRegistrationIds(stored);
    const orphanedIds = scripts
      .map((script) => script.id)
      .filter((id) => id.startsWith(`${REGISTRATION_ID_PREFIX}_`) && !referencedIds.has(id));

    if (orphanedIds.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: orphanedIds });
    }
  });
}
