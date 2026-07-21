const PROPS_AGENT_SCRIPT_PATH = "inject-scripts/props-hook-bootstrap.js";
const REGISTRATION_ID_PREFIX = "mcp_we_props_early";
const TAB_REGISTRATION_STORAGE_PREFIX = "web-editor-props-early-tab-";
const TAB_REGISTRATION_STORAGE_VERSION = 2;
const SURFACE_SESSION_PATTERN = /^[a-f0-9]{64}$/;
const LEGACY_RETIREMENT_MIGRATION_STORAGE_KEY =
  "web-editor-props-legacy-retirement-version";
const LEGACY_RETIREMENT_MIGRATION_VERSION = 2;
const LEGACY_RETIREMENT_CONCURRENCY = 4;
const LEGACY_RETIREMENT_PER_TAB_TIMEOUT_MS = 1_500;
const LEGACY_RETIREMENT_SWEEP_TIMEOUT_MS = 6_000;

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
  surfaceSessionId: string;
}

export interface EarlyInjectionResult {
  id: string;
  host: string;
  origin: string;
  matches: string[];
  alreadyRegistered: boolean;
}

type LegacyRetirementStatus = "retired" | "gone" | "retry";

async function executeLegacyPropsAgentRetirement(
  tabId: number,
  documentId?: string,
): Promise<LegacyRetirementStatus> {
  if (!Number.isSafeInteger(tabId) || tabId < 0) return "gone";
  if (
    documentId !== undefined &&
    (typeof documentId !== "string" || !documentId || documentId.length > 512)
  ) {
    return "retry";
  }
  if (typeof chrome.scripting?.executeScript !== "function") return "retry";
  try {
    const results = await chrome.scripting.executeScript({
      target:
        documentId === undefined
          ? { tabId, frameIds: [0] }
          : { tabId, documentIds: [documentId] },
      world: "MAIN",
      func: () => {
        const legacyAgent = (window as any).__MCP_WEB_EDITOR_PROPS_AGENT__;
        if (
          legacyAgent &&
          legacyAgent.version !== 2 &&
          typeof legacyAgent.dispose === "function"
        ) {
          try {
            legacyAgent.dispose();
          } catch {
            // Always install the inert v2 sentinel below.
          }
        }
        try {
          window.dispatchEvent(new Event("web-editor-props:cleanup"));
        } catch {
          // Legacy cleanup is best-effort.
        }
        (window as any).__MCP_WEB_EDITOR_PROPS_AGENT__ = Object.freeze({
          version: 2,
          transport: "background-only",
        });
      },
    });
    if (
      !Array.isArray(results) ||
      results.length !== 1 ||
      results[0]?.frameId !== 0 ||
      (documentId !== undefined && results[0]?.documentId !== documentId)
    ) {
      return "retry";
    }
    return "retired";
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? "");
    if (
      /No tab with id|tab (?:was )?closed|The tab was closed/i.test(message)
    ) {
      return "gone";
    }
    return "retry";
  }
}

function retireLegacyPropsAgentWithStatus(
  tabId: number,
  documentId?: string,
): Promise<LegacyRetirementStatus> {
  const execution = executeLegacyPropsAgentRetirement(tabId, documentId);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: LegacyRetirementStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(status);
    };
    const timeoutId = setTimeout(
      () => finish("retry"),
      LEGACY_RETIREMENT_PER_TAB_TIMEOUT_MS,
    );
    void execution.then(finish, () => finish("retry"));
  });
}

/** Retire a legacy long-lived MAIN-world agent in the currently open document. */
export function retireLegacyPropsAgentInTab(
  tabId: number,
  documentId?: string,
): Promise<boolean> {
  const result = legacyRetirementQueue.then(async () => {
    const status = await retireLegacyPropsAgentWithStatus(tabId, documentId);
    if (status === "retry") {
      // A future worker startup will repeat the versioned full-tab sweep.
      legacyRetirementMigrationComplete = false;
      await chrome.storage.session
        .remove(LEGACY_RETIREMENT_MIGRATION_STORAGE_KEY)
        .catch(() => undefined);
    }
    return status !== "retry";
  });
  legacyRetirementQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isEligibleLegacyRetirementUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    // Browser extension galleries cannot be scripted and could never have
    // received the legacy agent through chrome.scripting in the first place.
    return !(
      url.hostname === "chromewebstore.google.com" ||
      (url.hostname === "chrome.google.com" &&
        url.pathname.startsWith("/webstore")) ||
      (url.hostname === "microsoftedge.microsoft.com" &&
        url.pathname.startsWith("/addons"))
    );
  } catch {
    return false;
  }
}

function isEligibleLegacyRetirementTab(tab: chrome.tabs.Tab): boolean {
  return (
    tab.discarded !== true &&
    Number.isSafeInteger(tab.id) &&
    (tab.id ?? -1) >= 0 &&
    isEligibleLegacyRetirementUrl(tab.url ?? tab.pendingUrl ?? "")
  );
}

async function retireLegacyPropsAgentsForMigration(): Promise<boolean> {
  const startedAt = Date.now();
  const tabs = await chrome.tabs.query({});
  const tabIds = Array.from(
    new Set(
      tabs.filter(isEligibleLegacyRetirementTab).map((tab) => tab.id as number),
    ),
  );
  let retryNeeded = false;
  for (
    let offset = 0;
    offset < tabIds.length;
    offset += LEGACY_RETIREMENT_CONCURRENCY
  ) {
    if (Date.now() - startedAt >= LEGACY_RETIREMENT_SWEEP_TIMEOUT_MS) {
      return false;
    }
    const statuses = await Promise.all(
      tabIds
        .slice(offset, offset + LEGACY_RETIREMENT_CONCURRENCY)
        .map((tabId) => retireLegacyPropsAgentWithStatus(tabId)),
    );
    if (statuses.includes("retry")) retryNeeded = true;
  }
  return !retryNeeded;
}

let registryQueue: Promise<void> = Promise.resolve();
let legacyRetirementQueue: Promise<void> = Promise.resolve();
let navigationLifecycleInitialized = false;
let legacyRetirementMigrationComplete = false;

async function isLegacyRetirementMigrationComplete(): Promise<boolean> {
  if (legacyRetirementMigrationComplete) return true;
  try {
    const stored = await chrome.storage.session.get(
      LEGACY_RETIREMENT_MIGRATION_STORAGE_KEY,
    );
    legacyRetirementMigrationComplete =
      stored[LEGACY_RETIREMENT_MIGRATION_STORAGE_KEY] ===
      LEGACY_RETIREMENT_MIGRATION_VERSION;
  } catch {
    // Storage failures must keep retirement fail-closed.
    legacyRetirementMigrationComplete = false;
  }
  return legacyRetirementMigrationComplete;
}

function serializeRegistryOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = registryQueue.then(operation, operation);
  registryQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function ensureLegacyRetirementMigration(): Promise<void> {
  const result = legacyRetirementQueue.then(async () => {
    const stored = await chrome.storage.session.get(
      LEGACY_RETIREMENT_MIGRATION_STORAGE_KEY,
    );
    if (
      stored[LEGACY_RETIREMENT_MIGRATION_STORAGE_KEY] ===
      LEGACY_RETIREMENT_MIGRATION_VERSION
    ) {
      legacyRetirementMigrationComplete = true;
      return;
    }
    const retired = await retireLegacyPropsAgentsForMigration();
    if (!retired) {
      throw new Error("Legacy props-agent retirement sweep must be retried");
    }
    await chrome.storage.session.set({
      [LEGACY_RETIREMENT_MIGRATION_STORAGE_KEY]:
        LEGACY_RETIREMENT_MIGRATION_VERSION,
    });
    legacyRetirementMigrationComplete = true;
  });
  legacyRetirementQueue = result.then(
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
    typeof value === "string" &&
    value.startsWith(`${REGISTRATION_ID_PREFIX}_`) &&
    value.length <= 256
  );
}

function readStoredRegistration(value: unknown): StoredTabRegistration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<StoredTabRegistration>;
  if (
    candidate.version !== TAB_REGISTRATION_STORAGE_VERSION ||
    !isManagedRegistrationId(candidate.registrationId) ||
    typeof candidate.host !== "string" ||
    !candidate.host ||
    candidate.host.length > 255 ||
    typeof candidate.origin !== "string" ||
    candidate.origin.length > 2_048 ||
    typeof candidate.surfaceSessionId !== "string" ||
    !SURFACE_SESSION_PATTERN.test(candidate.surfaceSessionId)
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
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidateId = (value as { registrationId?: unknown }).registrationId;
    if (isManagedRegistrationId(candidateId)) return candidateId;
  }
  return undefined;
}

function sanitizeContentScriptId(input: string): string {
  const cleaned = String(input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 64) || "site";
}

async function buildRegistrationId(host: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(host),
  );
  const hash = Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${REGISTRATION_ID_PREFIX}_${sanitizeContentScriptId(host)}_${hash}`;
}

function buildEarlyInjectionLocation(tabUrl: string): EarlyInjectionLocation {
  let url: URL;
  try {
    url = new URL(tabUrl);
  } catch {
    throw new Error("Invalid tab URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Early injection only supports http/https pages (got ${url.protocol})`,
    );
  }

  const host = url.hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) {
    throw new Error("Unable to derive host from tab URL");
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

function tryBuildEarlyInjectionLocation(
  tabUrl: string,
): EarlyInjectionLocation | null {
  try {
    return buildEarlyInjectionLocation(tabUrl);
  } catch {
    return null;
  }
}

function toStoredRegistration(
  registrationId: string,
  location: Pick<EarlyInjectionLocation, "host" | "origin">,
  surfaceSessionId: string,
): StoredTabRegistration {
  return {
    version: TAB_REGISTRATION_STORAGE_VERSION,
    registrationId,
    host: location.host,
    origin: location.origin,
    surfaceSessionId,
  };
}

function referencedRegistrationIds(
  stored: Record<string, unknown>,
): Set<string> {
  const ids = new Set<string>();
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(TAB_REGISTRATION_STORAGE_PREFIX)) continue;
    const record = readStoredRegistration(value);
    const id =
      record?.registrationId ??
      (isManagedRegistrationId(value) ? value : undefined);
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
    runAt: "document_start",
    world: "MAIN",
    allFrames: false,
    matchOriginAsFallback: false,
    persistAcrossSessions: false,
  };
}

function matchesExpectedRegistration(
  script: chrome.scripting.RegisteredContentScript,
  id: string,
  matches: string[],
): boolean {
  const extended = script as chrome.scripting.RegisteredContentScript & {
    includeGlobs?: string[];
    excludeGlobs?: string[];
  };
  return (
    script.id === id &&
    Array.isArray(script.js) &&
    script.js.length === 1 &&
    script.js[0] === PROPS_AGENT_SCRIPT_PATH &&
    Array.isArray(script.matches) &&
    script.matches.length === matches.length &&
    script.matches.every((match, index) => match === matches[index]) &&
    script.runAt === "document_start" &&
    script.world === "MAIN" &&
    script.allFrames === false &&
    script.matchOriginAsFallback !== true &&
    (!script.css || script.css.length === 0) &&
    (!extended.includeGlobs || extended.includeGlobs.length === 0) &&
    (!extended.excludeGlobs || extended.excludeGlobs.length === 0) &&
    (!script.excludeMatches || script.excludeMatches.length === 0) &&
    script.persistAcrossSessions === false
  );
}

async function releaseStoredTabRegistration(
  storageKey: string,
  id?: string,
): Promise<void> {
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
  surfaceSessionId: string,
): Promise<EarlyInjectionResult> {
  return serializeRegistryOperation(async () => {
    if (!SURFACE_SESSION_PATTERN.test(surfaceSessionId)) {
      throw new Error("A valid Web Editor surface session is required");
    }
    const { host, origin, matches } = buildEarlyInjectionLocation(tabUrl);
    const id = await buildRegistrationId(host);
    const storageKey = registrationStorageKey(tabId);
    const previous = await chrome.storage.session.get(storageKey);
    const previousId = readStoredRegistrationId(previous[storageKey]);

    const existing = await chrome.scripting.getRegisteredContentScripts({
      ids: [id],
    });
    const existingScript = existing.find((script) => script.id === id);
    const alreadyRegistered = Boolean(
      existingScript &&
      matchesExpectedRegistration(existingScript, id, matches),
    );

    if (existingScript && !alreadyRegistered) {
      await chrome.scripting.unregisterContentScripts({ ids: [id] });
    }

    if (!alreadyRegistered) {
      await chrome.scripting.registerContentScripts([
        registeredContentScript(id, matches),
      ]);
      console.log(`[WebEditor] Registered early injection for ${host}`);
    }

    try {
      await chrome.storage.session.set({
        [storageKey]: toStoredRegistration(
          id,
          { host, origin },
          surfaceSessionId,
        ),
      });
    } catch (error) {
      if (!alreadyRegistered) {
        await chrome.scripting
          .unregisterContentScripts({ ids: [id] })
          .catch(() => {});
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
export function releasePropsAgentEarlyInjection(
  tabId: number,
  expectedSurfaceSessionId?: string,
): Promise<boolean> {
  return serializeRegistryOperation(async () => {
    const storageKey = registrationStorageKey(tabId);
    const stored = await chrome.storage.session.get(storageKey);
    const record = readStoredRegistration(stored[storageKey]);
    if (
      expectedSurfaceSessionId !== undefined &&
      (!SURFACE_SESSION_PATTERN.test(expectedSurfaceSessionId) ||
        record?.surfaceSessionId !== expectedSurfaceSessionId)
    ) {
      return false;
    }
    const id =
      record?.registrationId ?? readStoredRegistrationId(stored[storageKey]);

    await releaseStoredTabRegistration(storageKey, id);
    return true;
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
    const storedRecord = readStoredRegistration(rawRegistration);
    if (registrationId && currentLocation && storedRecord) {
      const expectedId = await buildRegistrationId(currentLocation.host);
      const sameHost =
        registrationId === expectedId &&
        storedRecord.host === currentLocation.host;

      if (sameHost) {
        // Keep the last committed origin current without widening the
        // host-scoped registration.
        if (
          storedRecord.origin !== currentLocation.origin ||
          storedRecord.host !== currentLocation.host
        ) {
          await chrome.storage.session.set({
            [storageKey]: toStoredRegistration(
              registrationId,
              currentLocation,
              storedRecord.surfaceSessionId,
            ),
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
  void (async () => {
    if (
      isEligibleLegacyRetirementUrl(details.url) &&
      !(await isLegacyRetirementMigrationComplete())
    ) {
      await retireLegacyPropsAgentInTab(details.tabId, details.documentId);
    }
    await reconcilePropsAgentEarlyInjectionNavigation(
      details.tabId,
      details.url,
    );
  })().catch((error) => {
    console.warn(
      "[WebEditor] Failed to reconcile props early injection after navigation:",
      error,
    );
  });
}

function handleTabReplacement(
  details: chrome.webNavigation.WebNavigationReplacementCallbackDetails,
): void {
  void releasePropsAgentEarlyInjection(details.replacedTabId).catch((error) => {
    console.warn(
      "[WebEditor] Failed to release props early injection for replaced tab:",
      error,
    );
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
export async function pruneOrphanedPropsAgentEarlyInjections(): Promise<void> {
  // Security migration is independent from the operational registration
  // queue: stale registry state cannot delay retiring page-visible v1 agents.
  await ensureLegacyRetirementMigration();
  await serializeRegistryOperation(async () => {
    const [initialStored, scripts] = await Promise.all([
      chrome.storage.session.get(null),
      chrome.scripting.getRegisteredContentScripts(),
    ]);
    const scriptsById = new Map(scripts.map((script) => [script.id, script]));
    const storageUpdates: Record<string, StoredTabRegistration> = {};
    const storageRemovals: string[] = [];

    // Reconcile persisted tab ownership with the browser's current top-level
    // URL. Unowned records from older schemas are retired instead of being
    // silently attached to a future surface session.
    for (const [key, value] of Object.entries(initialStored)) {
      if (!key.startsWith(TAB_REGISTRATION_STORAGE_PREFIX)) continue;
      const tabId = parseRegistrationStorageTabId(key);
      const registrationId = readStoredRegistrationId(value);
      const storedRecord = readStoredRegistration(value);
      if (tabId === null || !registrationId || !storedRecord) {
        storageRemovals.push(key);
        continue;
      }

      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const currentLocation = tryBuildEarlyInjectionLocation(tab?.url ?? "");
      if (!currentLocation) {
        storageRemovals.push(key);
        continue;
      }
      await retireLegacyPropsAgentInTab(tabId);

      const expectedId = await buildRegistrationId(currentLocation.host);
      if (
        registrationId !== expectedId ||
        storedRecord.host !== currentLocation.host
      ) {
        storageRemovals.push(key);
        continue;
      }

      const nextRecord = toStoredRegistration(
        registrationId,
        currentLocation,
        storedRecord.surfaceSessionId,
      );
      if (
        storedRecord.origin !== nextRecord.origin ||
        storedRecord.host !== nextRecord.host
      ) {
        storageUpdates[key] = nextRecord;
      }

      const registered = scriptsById.get(registrationId);
      if (
        registered &&
        !matchesExpectedRegistration(
          registered,
          registrationId,
          currentLocation.matches,
        )
      ) {
        await chrome.scripting.unregisterContentScripts({
          ids: [registrationId],
        });
        scriptsById.delete(registrationId);
      }
      if (!scriptsById.has(registrationId)) {
        const restoredScript = registeredContentScript(
          registrationId,
          currentLocation.matches,
        );
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
      .filter(
        (id) =>
          id.startsWith(`${REGISTRATION_ID_PREFIX}_`) && !referencedIds.has(id),
      );

    if (orphanedIds.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: orphanedIds });
    }
  });
}
