const PROPS_AGENT_SCRIPT_PATH = 'inject-scripts/props-agent.js';
const REGISTRATION_ID_PREFIX = 'mcp_we_props_early';
const TAB_REGISTRATION_STORAGE_PREFIX = 'web-editor-props-early-tab-';
const TAB_REGISTRATION_STORAGE_VERSION = 1;

interface EarlyInjectionLocation {
  host: string;
  origin: string;
  matches: string[];
}

interface StoredTabRegistration {
  version: typeof TAB_REGISTRATION_STORAGE_VERSION;
  registrationId: string;
  host: string;
  origin: string;
}

export interface EarlyInjectionResult {
  id: string;
  host: string;
  origin: string;
  matches: string[];
  alreadyRegistered: boolean;
}

let registryQueue: Promise<void> = Promise.resolve();
let navigationLifecycleInitialized = false;

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

function parseRegistrationStorageTabId(key: string): number | null {
  if (!key.startsWith(TAB_REGISTRATION_STORAGE_PREFIX)) return null;
  const rawTabId = key.slice(TAB_REGISTRATION_STORAGE_PREFIX.length);
  if (!/^\d+$/.test(rawTabId)) return null;
  const tabId = Number(rawTabId);
  return Number.isSafeInteger(tabId) && tabId >= 0 ? tabId : null;
}

function isManagedRegistrationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(`${REGISTRATION_ID_PREFIX}_`) &&
    value.length <= 256
  );
}

function readStoredRegistration(value: unknown): StoredTabRegistration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<StoredTabRegistration>;
  if (
    candidate.version !== TAB_REGISTRATION_STORAGE_VERSION ||
    !isManagedRegistrationId(candidate.registrationId) ||
    typeof candidate.host !== 'string' ||
    !candidate.host ||
    candidate.host.length > 255 ||
    typeof candidate.origin !== 'string' ||
    candidate.origin.length > 2_048
  ) {
    return null;
  }
  const normalizedOrigin = tryBuildEarlyInjectionLocation(candidate.origin);
  if (
    !normalizedOrigin ||
    normalizedOrigin.host !== candidate.host ||
    normalizedOrigin.origin !== candidate.origin
  ) {
    return null;
  }
  return candidate as StoredTabRegistration;
}

function readStoredRegistrationId(value: unknown): string | undefined {
  const record = readStoredRegistration(value);
  if (record) return record.registrationId;
  // Migration support for the previous tab -> registrationId string schema.
  if (isManagedRegistrationId(value)) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidateId = (value as { registrationId?: unknown }).registrationId;
    if (isManagedRegistrationId(candidateId)) return candidateId;
  }
  return undefined;
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

function buildEarlyInjectionLocation(tabUrl: string): EarlyInjectionLocation {
  let url: URL;
  try {
    url = new URL(tabUrl);
  } catch {
    throw new Error('Invalid tab URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Early injection only supports http/https pages (got ${url.protocol})`);
  }

  const host = url.hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!host) {
    throw new Error('Unable to derive host from tab URL');
  }

  // Canonicalize an equivalent trailing-dot hostname before persisting the
  // origin so navigation comparisons survive service-worker restarts.
  url.hostname = host;
  return {
    host,
    origin: url.origin,
    matches: [`*://${host}/*`],
  };
}

function tryBuildEarlyInjectionLocation(tabUrl: string): EarlyInjectionLocation | null {
  try {
    return buildEarlyInjectionLocation(tabUrl);
  } catch {
    return null;
  }
}

function toStoredRegistration(
  registrationId: string,
  location: Pick<EarlyInjectionLocation, 'host' | 'origin'>,
): StoredTabRegistration {
  return {
    version: TAB_REGISTRATION_STORAGE_VERSION,
    registrationId,
    host: location.host,
    origin: location.origin,
  };
}

function referencedRegistrationIds(stored: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(TAB_REGISTRATION_STORAGE_PREFIX)) continue;
    const record = readStoredRegistration(value);
    const id = record?.registrationId ?? (isManagedRegistrationId(value) ? value : undefined);
    if (id) ids.add(id);
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

function registeredContentScript(
  id: string,
  matches: string[],
): chrome.scripting.RegisteredContentScript {
  return {
    id,
    js: [PROPS_AGENT_SCRIPT_PATH],
    matches,
    runAt: 'document_start',
    world: 'MAIN',
    allFrames: false,
    persistAcrossSessions: false,
  };
}

async function releaseStoredTabRegistration(storageKey: string, id?: string): Promise<void> {
  await chrome.storage.session.remove(storageKey);
  if (id) await unregisterIfUnreferenced(id);
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
    const { host, origin, matches } = buildEarlyInjectionLocation(tabUrl);
    const id = await buildRegistrationId(host);
    const storageKey = registrationStorageKey(tabId);
    const previous = await chrome.storage.session.get(storageKey);
    const previousId = readStoredRegistrationId(previous[storageKey]);

    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    const alreadyRegistered = existing.some((script) => script.id === id);

    if (!alreadyRegistered) {
      await chrome.scripting.registerContentScripts([registeredContentScript(id, matches)]);
      console.log(`[WebEditor] Registered early injection for ${host}`);
    }

    try {
      await chrome.storage.session.set({
        [storageKey]: toStoredRegistration(id, { host, origin }),
      });
    } catch (error) {
      if (!alreadyRegistered) {
        await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
      }
      throw error;
    }

    if (previousId && previousId !== id) {
      await unregisterIfUnreferenced(previousId);
    }

    return { id, host, origin, matches, alreadyRegistered };
  });
}

/** Release a tab's registration and remove the script when no other tab uses it. */
export function releasePropsAgentEarlyInjection(tabId: number): Promise<void> {
  return serializeRegistryOperation(async () => {
    const storageKey = registrationStorageKey(tabId);
    const stored = await chrome.storage.session.get(storageKey);
    const id = readStoredRegistrationId(stored[storageKey]);

    await releaseStoredTabRegistration(storageKey, id);
  });
}

/**
 * Reconcile a committed top-level navigation with the tab's persisted host
 * association. Same-host navigations retain document_start coverage; every
 * cross-host or non-http(s) commit releases the old global registration ref.
 */
export function reconcilePropsAgentEarlyInjectionNavigation(
  tabId: number,
  tabUrl: string,
): Promise<boolean> {
  return serializeRegistryOperation(async () => {
    if (!Number.isSafeInteger(tabId) || tabId < 0) return false;

    const storageKey = registrationStorageKey(tabId);
    const stored = await chrome.storage.session.get(storageKey);
    const rawRegistration = stored[storageKey];
    if (rawRegistration === undefined) return false;

    const registrationId = readStoredRegistrationId(rawRegistration);
    const currentLocation = tryBuildEarlyInjectionLocation(tabUrl);
    if (registrationId && currentLocation) {
      const expectedId = await buildRegistrationId(currentLocation.host);
      const storedRecord = readStoredRegistration(rawRegistration);
      const sameHost =
        registrationId === expectedId &&
        (!storedRecord || storedRecord.host === currentLocation.host);

      if (sameHost) {
        // Migrate the legacy string schema and keep the last committed origin
        // current without widening the host-scoped registration.
        if (
          !storedRecord ||
          storedRecord.origin !== currentLocation.origin ||
          storedRecord.host !== currentLocation.host
        ) {
          await chrome.storage.session.set({
            [storageKey]: toStoredRegistration(registrationId, currentLocation),
          });
        }
        return false;
      }
    }

    await releaseStoredTabRegistration(storageKey, registrationId);
    return true;
  });
}

function handleTopLevelNavigation(
  details: chrome.webNavigation.WebNavigationTransitionCallbackDetails,
): void {
  if (details.frameId !== 0) return;
  void reconcilePropsAgentEarlyInjectionNavigation(details.tabId, details.url).catch((error) => {
    console.warn('[WebEditor] Failed to reconcile props early injection after navigation:', error);
  });
}

function handleTabReplacement(
  details: chrome.webNavigation.WebNavigationReplacementCallbackDetails,
): void {
  void releasePropsAgentEarlyInjection(details.replacedTabId).catch((error) => {
    console.warn('[WebEditor] Failed to release props early injection for replaced tab:', error);
  });
}

/** Register the persistent MV3 event listeners synchronously during SW startup. */
export function initPropsAgentEarlyInjectionNavigationLifecycle(): void {
  if (navigationLifecycleInitialized) return;
  chrome.webNavigation.onCommitted.addListener(handleTopLevelNavigation);
  chrome.webNavigation.onTabReplaced?.addListener(handleTabReplacement);
  navigationLifecycleInitialized = true;
}

/** Remove registrations left behind by older releases or interrupted setup. */
export function pruneOrphanedPropsAgentEarlyInjections(): Promise<void> {
  return serializeRegistryOperation(async () => {
    const [initialStored, scripts] = await Promise.all([
      chrome.storage.session.get(null),
      chrome.scripting.getRegisteredContentScripts(),
    ]);
    const scriptsById = new Map(scripts.map((script) => [script.id, script]));
    const storageUpdates: Record<string, StoredTabRegistration> = {};
    const storageRemovals: string[] = [];

    // Reconcile persisted tab ownership with the browser's current top-level
    // URL. This also migrates the legacy tab -> registrationId string schema.
    for (const [key, value] of Object.entries(initialStored)) {
      if (!key.startsWith(TAB_REGISTRATION_STORAGE_PREFIX)) continue;
      const tabId = parseRegistrationStorageTabId(key);
      const registrationId = readStoredRegistrationId(value);
      if (tabId === null || !registrationId) {
        storageRemovals.push(key);
        continue;
      }

      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const currentLocation = tryBuildEarlyInjectionLocation(tab?.url ?? '');
      if (!currentLocation) {
        storageRemovals.push(key);
        continue;
      }

      const expectedId = await buildRegistrationId(currentLocation.host);
      const storedRecord = readStoredRegistration(value);
      if (
        registrationId !== expectedId ||
        (storedRecord !== null && storedRecord.host !== currentLocation.host)
      ) {
        storageRemovals.push(key);
        continue;
      }

      const nextRecord = toStoredRegistration(registrationId, currentLocation);
      if (
        !storedRecord ||
        storedRecord.origin !== nextRecord.origin ||
        storedRecord.host !== nextRecord.host
      ) {
        storageUpdates[key] = nextRecord;
      }

      if (!scriptsById.has(registrationId)) {
        const restoredScript = registeredContentScript(registrationId, currentLocation.matches);
        await chrome.scripting.registerContentScripts([restoredScript]);
        scriptsById.set(registrationId, restoredScript);
      }
    }

    if (storageRemovals.length > 0) {
      await chrome.storage.session.remove(storageRemovals);
    }
    if (Object.keys(storageUpdates).length > 0) {
      await chrome.storage.session.set(storageUpdates);
    }

    const stored = { ...initialStored, ...storageUpdates };
    for (const key of storageRemovals) delete stored[key];
    const referencedIds = referencedRegistrationIds(stored);
    const orphanedIds = scripts
      .map((script) => script.id)
      .filter((id) => id.startsWith(`${REGISTRATION_ID_PREFIX}_`) && !referencedIds.has(id));

    if (orphanedIds.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: orphanedIds });
    }
  });
}
