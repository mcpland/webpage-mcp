import {
  DEFAULT_MCP_INSTANCE_ID,
  NativeMessageType,
  type McpServerInstanceConfig,
  type McpServerInstanceStatus,
  type NativeInstanceListPayload,
} from 'webpage-mcp-shared';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { NATIVE_HOST, STORAGE_KEYS, ERROR_MESSAGES, SUCCESS_MESSAGES } from '@/common/constants';
import { handleCallTool } from './tools';
import { listPublished, getFlow } from './record-replay/flow-store';
import { acquireKeepalive } from './keepalive-manager';
import {
  clearAllSessionContexts,
  clearSessionContextsForTab,
  clearSessionContextsForWindow,
} from './session-context';
import { clearTabQueue } from './tab-queue';

const LOG_PREFIX = '[NativeHost]';
const INSTANCE_ID_REGEX = /^[A-Za-z0-9._-]{1,64}$/;

let nativePort: chrome.runtime.Port | null = null;
export const HOST_NAME = NATIVE_HOST.NAME;

// ==================== Reconnect Configuration ====================

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 60_000;
const RECONNECT_MAX_FAST_ATTEMPTS = 8;
const RECONNECT_COOLDOWN_DELAY_MS = 5 * 60_000;

// ==================== Auto-connect State ====================

let keepaliveRelease: (() => void) | null = null;
let autoConnectEnabled = true;
let autoConnectLoaded = false;
let ensurePromise: Promise<boolean> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let manualDisconnect = false;

interface PendingNativeRequest {
  resolve: (payload: any) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pendingNativeRequests = new Map<string, PendingNativeRequest>();

interface ServerStatus {
  isRunning: boolean;
  port?: number;
  lastUpdated: number;
}

type ServerStatusMap = Record<string, ServerStatus>;

interface PortConflictResolution {
  instanceId: string;
  previousPort: number;
  nextPort: number;
}

let currentServerStatus: ServerStatus = {
  isRunning: false,
  lastUpdated: Date.now(),
};

let currentServerStatuses: ServerStatusMap = {
  [DEFAULT_MCP_INSTANCE_ID]: currentServerStatus,
};

let managedInstances: McpServerInstanceConfig[] = [];
let managedInstancesLoaded = false;

function makeRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function normalizeInstanceId(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_MCP_INSTANCE_ID;
  }
  const trimmed = value.trim();
  if (!trimmed || !INSTANCE_ID_REGEX.test(trimmed)) {
    return DEFAULT_MCP_INSTANCE_ID;
  }
  return trimmed;
}

function parseInstanceIdInput(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !INSTANCE_ID_REGEX.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function sortInstances(instances: McpServerInstanceConfig[]): McpServerInstanceConfig[] {
  return [...instances].sort((a, b) => {
    if (a.instanceId === DEFAULT_MCP_INSTANCE_ID && b.instanceId !== DEFAULT_MCP_INSTANCE_ID) return -1;
    if (b.instanceId === DEFAULT_MCP_INSTANCE_ID && a.instanceId !== DEFAULT_MCP_INSTANCE_ID) return 1;
    return a.instanceId.localeCompare(b.instanceId);
  });
}

/**
 * Normalize a port value to a valid port number or null.
 */
function normalizePort(value: unknown, options?: { allowZero?: boolean }): number | null {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return null;
  const port = Math.floor(n);
  if (options?.allowZero && port === 0) return 0;
  if (port <= 0 || port > 65535) return null;
  return port;
}

function normalizeServerStatus(raw: unknown, fallbackPort?: number): ServerStatus {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const normalizedPort = normalizePort(record.port) ?? fallbackPort;
  const updated =
    typeof record.lastUpdated === 'number' && Number.isFinite(record.lastUpdated)
      ? record.lastUpdated
      : Date.now();

  return {
    isRunning: Boolean(record.isRunning),
    port: normalizedPort ?? undefined,
    lastUpdated: updated,
  };
}

function createDefaultInstanceConfig(port: number): McpServerInstanceConfig {
  return {
    instanceId: DEFAULT_MCP_INSTANCE_ID,
    port,
    enabled: true,
    autoStart: true,
    label: 'Default',
  };
}

function normalizeInstanceConfig(raw: unknown, fallbackPort: number): McpServerInstanceConfig | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const record = raw as Record<string, unknown>;
  let instanceId = DEFAULT_MCP_INSTANCE_ID;
  if (record.instanceId !== undefined && record.instanceId !== null) {
    if (typeof record.instanceId !== 'string') {
      return null;
    }
    const trimmed = record.instanceId.trim();
    if (!trimmed || !INSTANCE_ID_REGEX.test(trimmed)) {
      return null;
    }
    instanceId = trimmed;
  }
  const normalizedPort = normalizePort(record.port) ?? (instanceId === DEFAULT_MCP_INSTANCE_ID ? fallbackPort : null);
  if (!normalizedPort) {
    return null;
  }

  const enabled = typeof record.enabled === 'boolean' ? record.enabled : true;
  const autoStart = typeof record.autoStart === 'boolean' ? record.autoStart : true;
  const label = typeof record.label === 'string' && record.label.trim() ? record.label.trim() : undefined;

  return {
    instanceId,
    port: normalizedPort,
    enabled,
    autoStart,
    ...(label ? { label } : {}),
  };
}

function findNextAvailablePort(used: Set<number>, startFrom: number): number {
  const start = Math.min(65535, Math.max(1, Math.floor(startFrom)));
  for (let offset = 0; offset < 65535; offset += 1) {
    const port = ((start - 1 + offset) % 65535) + 1;
    if (!used.has(port)) return port;
  }
  throw new Error('No available port left between 1 and 65535');
}

function resolveManagedInstancePortConflicts(
  instances: McpServerInstanceConfig[],
  options?: { preferredInstanceId?: string; seedPort?: number },
): { instances: McpServerInstanceConfig[]; resolutions: PortConflictResolution[] } {
  const preferredInstanceId = options?.preferredInstanceId?.trim();
  const seedPort = normalizePort(options?.seedPort) ?? NATIVE_HOST.DEFAULT_PORT;
  const ordered = sortInstances(instances);

  if (preferredInstanceId) {
    const index = ordered.findIndex((item) => item.instanceId === preferredInstanceId);
    if (index > 0) {
      const [preferred] = ordered.splice(index, 1);
      if (preferred) {
        ordered.unshift(preferred);
      }
    }
  }

  const usedPorts = new Set<number>();
  const byId = new Map<string, McpServerInstanceConfig>();
  const resolutions: PortConflictResolution[] = [];

  for (const current of ordered) {
    const nextPort = current.port;
    if (!usedPorts.has(nextPort)) {
      usedPorts.add(nextPort);
      byId.set(current.instanceId, current);
      continue;
    }

    const reassigned = findNextAvailablePort(usedPorts, Math.max(nextPort + 1, seedPort));
    usedPorts.add(reassigned);
    byId.set(current.instanceId, { ...current, port: reassigned });
    resolutions.push({
      instanceId: current.instanceId,
      previousPort: nextPort,
      nextPort: reassigned,
    });
  }

  return {
    instances: sortInstances(Array.from(byId.values())),
    resolutions,
  };
}

function warnPortResolutions(context: string, resolutions: PortConflictResolution[]): void {
  if (resolutions.length === 0) return;
  for (const item of resolutions) {
    console.warn(
      `${LOG_PREFIX} ${context}: reassigned instance "${item.instanceId}" port ${item.previousPort} -> ${item.nextPort}`,
    );
  }
}

async function saveServerStatuses(): Promise<void> {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.SERVER_STATUS]: currentServerStatus,
      [STORAGE_KEYS.SERVER_STATUSES]: currentServerStatuses,
    });
  } catch (error) {
    console.error(ERROR_MESSAGES.SERVER_STATUS_SAVE_FAILED, error);
  }
}

async function loadServerStatuses(): Promise<void> {
  try {
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.SERVER_STATUS,
      STORAGE_KEYS.SERVER_STATUSES,
    ]);

    const legacy = normalizeServerStatus(result[STORAGE_KEYS.SERVER_STATUS]);
    const mapRaw = result[STORAGE_KEYS.SERVER_STATUSES];
    const nextMap: ServerStatusMap = {};

    if (mapRaw && typeof mapRaw === 'object') {
      for (const [rawId, status] of Object.entries(mapRaw as Record<string, unknown>)) {
        const instanceId = normalizeInstanceId(rawId);
        nextMap[instanceId] = normalizeServerStatus(status, nextMap[instanceId]?.port);
      }
    }

    if (!nextMap[DEFAULT_MCP_INSTANCE_ID]) {
      nextMap[DEFAULT_MCP_INSTANCE_ID] = legacy;
    }

    currentServerStatuses = nextMap;
    currentServerStatus = currentServerStatuses[DEFAULT_MCP_INSTANCE_ID] || {
      isRunning: false,
      lastUpdated: Date.now(),
    };
  } catch (error) {
    console.error(ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED, error);
    currentServerStatuses = {
      [DEFAULT_MCP_INSTANCE_ID]: {
        isRunning: false,
        lastUpdated: Date.now(),
      },
    };
    currentServerStatus = currentServerStatuses[DEFAULT_MCP_INSTANCE_ID];
  }
}

function broadcastServerStatusChange(instanceId: string): void {
  const normalizedId = normalizeInstanceId(instanceId);
  chrome.runtime
    .sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.SERVER_STATUS_CHANGED,
      payload: currentServerStatus,
      instanceId: normalizedId,
      status: currentServerStatuses[normalizedId],
      statuses: currentServerStatuses,
    })
    .catch(() => {
      // Ignore errors if no listeners are present
    });
}

function broadcastServerInstancesChanged(): void {
  chrome.runtime
    .sendMessage({
      type: BACKGROUND_MESSAGE_TYPES.SERVER_INSTANCES_CHANGED,
      payload: {
        instances: managedInstances,
        statuses: currentServerStatuses,
      },
    })
    .catch(() => {
      // Ignore when no listeners
    });
}

async function persistManagedInstances(): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.MCP_SERVER_INSTANCES]: managedInstances,
  });
}

function applyInstanceStatus(status: McpServerInstanceStatus): void {
  const instanceId = normalizeInstanceId(status.instanceId);
  const nextStatus: ServerStatus = {
    isRunning: Boolean(status.isRunning),
    port: normalizePort(status.port) ?? currentServerStatuses[instanceId]?.port,
    lastUpdated:
      typeof status.lastUpdated === 'number' && Number.isFinite(status.lastUpdated)
        ? status.lastUpdated
        : Date.now(),
  };

  currentServerStatuses = {
    ...currentServerStatuses,
    [instanceId]: nextStatus,
  };
  if (instanceId === DEFAULT_MCP_INSTANCE_ID) {
    currentServerStatus = nextStatus;
  }
}

function applyInstanceStatusList(rawStatuses: unknown[]): void {
  const next: ServerStatusMap = {};
  for (const raw of rawStatuses) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const instanceId = normalizeInstanceId(item.instanceId);
    next[instanceId] = {
      isRunning: Boolean(item.isRunning),
      port: normalizePort(item.port) ?? next[instanceId]?.port,
      lastUpdated:
        typeof item.lastUpdated === 'number' && Number.isFinite(item.lastUpdated)
          ? item.lastUpdated
          : Date.now(),
    };
  }

  if (!next[DEFAULT_MCP_INSTANCE_ID]) {
    next[DEFAULT_MCP_INSTANCE_ID] = {
      isRunning: false,
      port: currentServerStatuses[DEFAULT_MCP_INSTANCE_ID]?.port ?? currentServerStatus.port,
      lastUpdated: Date.now(),
    };
  }

  currentServerStatuses = next;
  currentServerStatus = next[DEFAULT_MCP_INSTANCE_ID];
}

async function markAllServersStopped(reason: string): Promise<void> {
  const now = Date.now();
  const nextEntries = Object.entries(currentServerStatuses).map(([instanceId, status]) => {
    const normalizedId = normalizeInstanceId(instanceId);
    return [
      normalizedId,
      {
        isRunning: false,
        port: status.port,
        lastUpdated: now,
      } satisfies ServerStatus,
    ] as const;
  });

  if (nextEntries.length === 0) {
    nextEntries.push([
      DEFAULT_MCP_INSTANCE_ID,
      {
        isRunning: false,
        port: currentServerStatus.port,
        lastUpdated: now,
      },
    ]);
  }

  currentServerStatuses = Object.fromEntries(nextEntries);
  currentServerStatus = currentServerStatuses[DEFAULT_MCP_INSTANCE_ID] || {
    isRunning: false,
    lastUpdated: now,
  };

  await saveServerStatuses();
  broadcastServerStatusChange(DEFAULT_MCP_INSTANCE_ID);
  broadcastServerInstancesChanged();
  console.debug(`${LOG_PREFIX} All servers marked stopped (${reason})`);
}

function inferDefaultPort(
  preferredPort: number | null,
  storageSnapshot: Record<string, unknown>,
): number {
  if (preferredPort && preferredPort > 0) {
    return preferredPort;
  }

  const fromPreference = normalizePort(storageSnapshot[STORAGE_KEYS.NATIVE_SERVER_PORT]);
  if (fromPreference) {
    return fromPreference;
  }

  const statusMapRaw = storageSnapshot[STORAGE_KEYS.SERVER_STATUSES];
  if (statusMapRaw && typeof statusMapRaw === 'object') {
    const defaultStatus = (statusMapRaw as Record<string, unknown>)[DEFAULT_MCP_INSTANCE_ID];
    const fromMap = normalizePort((defaultStatus as Record<string, unknown> | undefined)?.port);
    if (fromMap) {
      return fromMap;
    }
  }

  const legacyStatus = storageSnapshot[STORAGE_KEYS.SERVER_STATUS] as Record<string, unknown> | undefined;
  const fromLegacy = normalizePort(legacyStatus?.port);
  if (fromLegacy) {
    return fromLegacy;
  }

  const fromMemory = normalizePort(currentServerStatus.port);
  if (fromMemory) {
    return fromMemory;
  }

  return NATIVE_HOST.DEFAULT_PORT;
}

async function ensureManagedInstancesLoaded(preferredDefaultPort?: number): Promise<McpServerInstanceConfig[]> {
  if (managedInstancesLoaded) {
    let nextManaged = managedInstances;
    if (typeof preferredDefaultPort === 'number' && preferredDefaultPort > 0) {
      let changed = false;
      nextManaged = managedInstances.map((cfg) => {
        if (cfg.instanceId !== DEFAULT_MCP_INSTANCE_ID || cfg.port === preferredDefaultPort) {
          return cfg;
        }
        changed = true;
        return { ...cfg, port: preferredDefaultPort };
      });
      if (!changed) {
        nextManaged = managedInstances;
      }
    }

    const resolved = resolveManagedInstancePortConflicts(nextManaged, {
      preferredInstanceId: DEFAULT_MCP_INSTANCE_ID,
      seedPort: preferredDefaultPort,
    });
    warnPortResolutions('resolved in-memory port conflicts', resolved.resolutions);
    const changed =
      resolved.resolutions.length > 0 ||
      resolved.instances.length !== managedInstances.length ||
      resolved.instances.some((item, index) => {
        const previous = managedInstances[index];
        return (
          !previous ||
          previous.instanceId !== item.instanceId ||
          previous.port !== item.port ||
          previous.enabled !== item.enabled ||
          previous.autoStart !== item.autoStart ||
          previous.label !== item.label
        );
      });
    if (changed) {
      managedInstances = resolved.instances;
      await persistManagedInstances();
    }
    return managedInstances;
  }

  const snapshot = await chrome.storage.local.get([
    STORAGE_KEYS.MCP_SERVER_INSTANCES,
    STORAGE_KEYS.NATIVE_SERVER_PORT,
    STORAGE_KEYS.SERVER_STATUS,
    STORAGE_KEYS.SERVER_STATUSES,
  ]);

  const fallbackPort = inferDefaultPort(normalizePort(preferredDefaultPort), snapshot);
  const rawList = Array.isArray(snapshot[STORAGE_KEYS.MCP_SERVER_INSTANCES])
    ? (snapshot[STORAGE_KEYS.MCP_SERVER_INSTANCES] as unknown[])
    : [];

  const byId = new Map<string, McpServerInstanceConfig>();
  for (const raw of rawList) {
    const normalized = normalizeInstanceConfig(raw, fallbackPort);
    if (!normalized) continue;
    byId.set(normalized.instanceId, normalized);
  }

  const defaultExisting = byId.get(DEFAULT_MCP_INSTANCE_ID);
  if (!defaultExisting) {
    byId.set(DEFAULT_MCP_INSTANCE_ID, createDefaultInstanceConfig(fallbackPort));
  } else if (typeof preferredDefaultPort === 'number' && preferredDefaultPort > 0) {
    byId.set(DEFAULT_MCP_INSTANCE_ID, {
      ...defaultExisting,
      port: preferredDefaultPort,
    });
  }

  const resolved = resolveManagedInstancePortConflicts(Array.from(byId.values()), {
    preferredInstanceId: DEFAULT_MCP_INSTANCE_ID,
    seedPort: fallbackPort,
  });
  warnPortResolutions('resolved persisted port conflicts', resolved.resolutions);
  managedInstances = resolved.instances;
  managedInstancesLoaded = true;

  await persistManagedInstances();
  return managedInstances;
}

async function getManagedInstancesById(): Promise<Map<string, McpServerInstanceConfig>> {
  const loaded = await ensureManagedInstancesLoaded();
  return new Map(loaded.map((cfg) => [cfg.instanceId, cfg]));
}

async function upsertManagedInstance(raw: unknown): Promise<McpServerInstanceConfig> {
  const defaultPort = inferDefaultPort(null, {
    [STORAGE_KEYS.NATIVE_SERVER_PORT]: managedInstances.find((it) => it.instanceId === DEFAULT_MCP_INSTANCE_ID)
      ?.port,
  });
  const normalized = normalizeInstanceConfig(raw, defaultPort);
  if (!normalized) {
    throw new Error('Invalid instance configuration');
  }

  const byId = await getManagedInstancesById();
  byId.set(normalized.instanceId, normalized);
  if (!byId.has(DEFAULT_MCP_INSTANCE_ID)) {
    byId.set(DEFAULT_MCP_INSTANCE_ID, createDefaultInstanceConfig(defaultPort));
  }

  const resolved = resolveManagedInstancePortConflicts(Array.from(byId.values()), {
    preferredInstanceId: normalized.instanceId,
    seedPort: defaultPort,
  });
  warnPortResolutions('resolved upsert port conflicts', resolved.resolutions);
  managedInstances = resolved.instances;
  await persistManagedInstances();
  if (normalized.instanceId === DEFAULT_MCP_INSTANCE_ID) {
    const defaultInstance = managedInstances.find((item) => item.instanceId === DEFAULT_MCP_INSTANCE_ID);
    if (defaultInstance) {
      await chrome.storage.local.set({ [STORAGE_KEYS.NATIVE_SERVER_PORT]: defaultInstance.port });
    }
  }
  broadcastServerInstancesChanged();
  return managedInstances.find((item) => item.instanceId === normalized.instanceId) ?? normalized;
}

async function removeManagedInstance(instanceId: string): Promise<void> {
  const normalized = normalizeInstanceId(instanceId);
  if (normalized === DEFAULT_MCP_INSTANCE_ID) {
    throw new Error('Default instance cannot be removed');
  }

  const byId = await getManagedInstancesById();
  byId.delete(normalized);
  managedInstances = sortInstances(Array.from(byId.values()));
  await persistManagedInstances();

  if (currentServerStatuses[normalized]) {
    const next = { ...currentServerStatuses };
    delete next[normalized];
    currentServerStatuses = next;
    await saveServerStatuses();
  }

  broadcastServerInstancesChanged();
}

async function requestNativeHost(
  type: string,
  payload?: unknown,
  timeoutMs: number = 5000,
): Promise<any> {
  const port = nativePort;
  if (!port) {
    throw new Error('Native host not connected');
  }

  const requestId = makeRequestId();
  return await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingNativeRequests.delete(requestId);
      reject(new Error(`Native request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingNativeRequests.set(requestId, { resolve, reject, timeoutId });

    try {
      port.postMessage({ type, requestId, payload });
    } catch (error) {
      clearTimeout(timeoutId);
      pendingNativeRequests.delete(requestId);
      reject(error);
    }
  });
}

function rejectAllPendingNativeRequests(reason: string): void {
  for (const [requestId, pending] of pendingNativeRequests.entries()) {
    clearTimeout(pending.timeoutId);
    pending.reject(new Error(reason));
    pendingNativeRequests.delete(requestId);
  }
}

async function startManagedInstanceOnNative(instance: McpServerInstanceConfig): Promise<boolean> {
  if (!nativePort) {
    return false;
  }
  try {
    await requestNativeHost(
      NativeMessageType.START,
      {
        instanceId: instance.instanceId,
        port: instance.port,
      },
      15_000,
    );
    return true;
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to start instance ${instance.instanceId}`, error);
    return false;
  }
}

async function stopManagedInstanceOnNative(instanceId: string): Promise<boolean> {
  if (!nativePort) {
    return false;
  }
  try {
    await requestNativeHost(
      NativeMessageType.STOP,
      {
        instanceId: normalizeInstanceId(instanceId),
      },
      15_000,
    );
    return true;
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to stop instance ${instanceId}`, error);
    return false;
  }
}

async function syncManagedInstancesOnNative(
  instances: McpServerInstanceConfig[],
  timeoutMs: number = 20_000,
): Promise<boolean> {
  if (!nativePort) {
    return false;
  }
  try {
    const response = (await requestNativeHost(
      NativeMessageType.SYNC_INSTANCES,
      { instances },
      timeoutMs,
    )) as NativeInstanceListPayload;
    if (response?.status !== 'success' || !Array.isArray(response.instances)) {
      return false;
    }

    applyInstanceStatusList(response.instances);
    await saveServerStatuses();
    broadcastServerStatusChange(DEFAULT_MCP_INSTANCE_ID);
    broadcastServerInstancesChanged();
    return true;
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to sync instance states`, error);
    return false;
  }
}

async function refreshStatusesFromNative(): Promise<void> {
  if (!nativePort) {
    return;
  }
  try {
    const response = (await requestNativeHost(
      NativeMessageType.LIST_INSTANCES,
      {},
      8000,
    )) as NativeInstanceListPayload;
    if (response?.status !== 'success' || !Array.isArray(response.instances)) {
      return;
    }

    applyInstanceStatusList(response.instances);
    await saveServerStatuses();
    broadcastServerStatusChange(DEFAULT_MCP_INSTANCE_ID);
    broadcastServerInstancesChanged();
  } catch (error) {
    console.debug(`${LOG_PREFIX} Failed to refresh native instance statuses`, error);
  }
}

async function ensureManagedInstancesRunning(preferredDefaultPort?: number): Promise<void> {
  if (!nativePort) {
    return;
  }

  const loaded = await ensureManagedInstancesLoaded(preferredDefaultPort);
  const synced = await syncManagedInstancesOnNative(loaded, 25_000);
  if (!synced) {
    const targets = loaded.filter((cfg) => cfg.enabled && cfg.autoStart);
    for (const instance of targets) {
      await startManagedInstanceOnNative(instance);
    }
    await refreshStatusesFromNative();
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  clearSessionContextsForTab(tabId);
  clearTabQueue(tabId);
});

chrome.windows.onRemoved.addListener((windowId) => {
  clearSessionContextsForWindow(windowId);
});

// ==================== Reconnect Utilities ====================

/**
 * Add jitter to a delay value to avoid thundering herd.
 */
function withJitter(ms: number): number {
  const ratio = 0.7 + Math.random() * 0.6;
  return Math.max(0, Math.round(ms * ratio));
}

/**
 * Calculate reconnect delay based on attempt number.
 * Uses exponential backoff with jitter, then switches to cooldown interval.
 */
function getReconnectDelayMs(attempt: number): number {
  if (attempt >= RECONNECT_MAX_FAST_ATTEMPTS) {
    return withJitter(RECONNECT_COOLDOWN_DELAY_MS);
  }
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt), RECONNECT_MAX_DELAY_MS);
  return withJitter(delay);
}

/**
 * Clear the reconnect timer if active.
 */
function clearReconnectTimer(): void {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

/**
 * Reset reconnect state after successful connection.
 */
function resetReconnectState(): void {
  reconnectAttempts = 0;
  clearReconnectTimer();
}

// ==================== Keepalive Management ====================

/**
 * Sync keepalive hold based on autoConnectEnabled state.
 * When auto-connect is enabled, we hold a keepalive reference to keep SW alive.
 */
function syncKeepaliveHold(): void {
  if (autoConnectEnabled) {
    if (!keepaliveRelease) {
      keepaliveRelease = acquireKeepalive('native-host');
      console.debug(`${LOG_PREFIX} Acquired keepalive`);
    }
    return;
  }
  if (keepaliveRelease) {
    try {
      keepaliveRelease();
      console.debug(`${LOG_PREFIX} Released keepalive`);
    } catch {
      // Ignore
    }
    keepaliveRelease = null;
  }
}

// ==================== Auto-connect Settings ====================

/**
 * Load the nativeAutoConnectEnabled setting from storage.
 */
async function loadNativeAutoConnectEnabled(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get([STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED]);
    const raw = result[STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED];
    if (typeof raw === 'boolean') return raw;
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to load nativeAutoConnectEnabled`, error);
  }
  return true; // Default to enabled
}

/**
 * Set the nativeAutoConnectEnabled setting and persist to storage.
 */
async function setNativeAutoConnectEnabled(enabled: boolean): Promise<void> {
  autoConnectEnabled = enabled;
  autoConnectLoaded = true;
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED]: enabled });
    console.debug(`${LOG_PREFIX} Set nativeAutoConnectEnabled=${enabled}`);
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to persist nativeAutoConnectEnabled`, error);
  }
  syncKeepaliveHold();
}

// ==================== Port Preference ====================

/**
 * Get the preferred default instance port.
 * Priority: explicit override > user preference > last known default status > default
 */
async function getPreferredPort(override?: unknown): Promise<number> {
  const explicit = normalizePort(override, { allowZero: true });
  if (explicit !== null) return explicit;

  try {
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.NATIVE_SERVER_PORT,
      STORAGE_KEYS.SERVER_STATUS,
      STORAGE_KEYS.SERVER_STATUSES,
    ]);

    const userPort = normalizePort(result[STORAGE_KEYS.NATIVE_SERVER_PORT]);
    if (userPort) return userPort;

    const statuses = result[STORAGE_KEYS.SERVER_STATUSES] as Record<string, unknown> | undefined;
    const defaultStatus = statuses?.[DEFAULT_MCP_INSTANCE_ID] as Record<string, unknown> | undefined;
    const statusPort = normalizePort(defaultStatus?.port);
    if (statusPort) return statusPort;

    const status = result[STORAGE_KEYS.SERVER_STATUS] as Partial<ServerStatus> | undefined;
    const legacyPort = normalizePort(status?.port);
    if (legacyPort) return legacyPort;
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to read preferred port`, error);
  }

  const inMemoryPort = normalizePort(currentServerStatus.port);
  if (inMemoryPort) return inMemoryPort;

  return NATIVE_HOST.DEFAULT_PORT;
}

// ==================== Reconnect Scheduling ====================

/**
 * Schedule a reconnect attempt with exponential backoff.
 */
function scheduleReconnect(reason: string): void {
  if (nativePort) return;
  if (manualDisconnect) return;
  if (!autoConnectEnabled) return;
  if (reconnectTimer) return;

  const delay = getReconnectDelayMs(reconnectAttempts);
  console.debug(
    `${LOG_PREFIX} Reconnect scheduled in ${delay}ms (attempt=${reconnectAttempts}, reason=${reason})`,
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (nativePort) return;
    if (manualDisconnect || !autoConnectEnabled) return;

    reconnectAttempts += 1;
    void ensureNativeConnected(`reconnect:${reason}`).catch(() => {});
  }, delay);
}

// ==================== Core Ensure Function ====================

/**
 * Ensure native connection is established.
 * This is the main entry point for auto-connect logic.
 *
 * @param trigger - Description of what triggered this call (for logging)
 * @param portOverride - Optional explicit default-instance port to use
 * @returns Whether the native host connection is established
 */
async function ensureNativeConnected(trigger: string, portOverride?: unknown): Promise<boolean> {
  // Concurrency protection: only one ensure flow at a time
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    // Load auto-connect setting if not yet loaded
    if (!autoConnectLoaded) {
      autoConnectEnabled = await loadNativeAutoConnectEnabled();
      autoConnectLoaded = true;
      syncKeepaliveHold();
    }

    // If auto-connect is disabled, do nothing
    if (!autoConnectEnabled) {
      console.debug(`${LOG_PREFIX} Auto-connect disabled, skipping ensure (trigger=${trigger})`);
      return false;
    }

    // Sync keepalive hold
    syncKeepaliveHold();

    // Preferred default instance port
    const port = await getPreferredPort(portOverride);

    await ensureManagedInstancesLoaded(port);

    // Already connected
    if (nativePort) {
      console.debug(`${LOG_PREFIX} Already connected (trigger=${trigger})`);
      await ensureManagedInstancesRunning(port);
      return true;
    }

    // Attempt connection
    const ok = connectNativeHost();
    if (!ok) {
      console.warn(`${LOG_PREFIX} Connection failed (trigger=${trigger})`);
      scheduleReconnect(`connect_failed:${trigger}`);
      return false;
    }

    console.debug(`${LOG_PREFIX} Connection initiated successfully (trigger=${trigger})`);
    await ensureManagedInstancesRunning(port);
    return true;
  })().finally(() => {
    ensurePromise = null;
  });

  return ensurePromise;
}

/**
 * Connect to the native messaging host
 * @returns Whether the connection was initiated successfully
 */
export function connectNativeHost(): boolean {
  if (nativePort) {
    return true;
  }

  try {
    nativePort = chrome.runtime.connectNative(HOST_NAME);

    nativePort.onMessage.addListener(async (message) => {
      if (message?.responseToRequestId) {
        const requestId = String(message.responseToRequestId);
        const pending = pendingNativeRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timeoutId);
          pendingNativeRequests.delete(requestId);
          if (message.error) {
            pending.reject(new Error(String(message.error)));
          } else {
            pending.resolve(message.payload);
          }
          return;
        }
      }

      if (message.type === NativeMessageType.PROCESS_DATA && message.requestId) {
        const requestId = message.requestId;
        const requestPayload = message.payload;

        nativePort?.postMessage({
          responseToRequestId: requestId,
          payload: {
            status: 'success',
            message: SUCCESS_MESSAGES.TOOL_EXECUTED,
            data: requestPayload,
          },
        });
      } else if (message.type === NativeMessageType.CALL_TOOL && message.requestId) {
        const requestId = message.requestId;
        try {
          const payload = (message.payload || {}) as {
            name?: string;
            args?: any;
            meta?: { mcpSessionId?: string; instanceId?: string };
          };
          const result = await handleCallTool({
            name: String(payload.name || ''),
            args: payload.args,
            meta: payload.meta,
          });
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: {
              status: 'success',
              message: SUCCESS_MESSAGES.TOOL_EXECUTED,
              data: result,
            },
          });
        } catch (error) {
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: {
              status: 'error',
              message: ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      } else if (message.type === 'rr_list_published_flows' && message.requestId) {
        const requestId = message.requestId;
        try {
          const published = await listPublished();
          const items = [] as any[];
          for (const p of published) {
            const flow = await getFlow(p.id);
            if (!flow) continue;
            items.push({
              id: p.id,
              slug: p.slug,
              version: p.version,
              name: p.name,
              description: p.description || flow.description || '',
              variables: flow.variables || [],
              meta: flow.meta || {},
            });
          }
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: { status: 'success', items },
          });
        } catch (error: any) {
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: { status: 'error', error: error?.message || String(error) },
          });
        }
      } else if (message.type === NativeMessageType.SERVER_STARTED) {
        const status: McpServerInstanceStatus = {
          instanceId: normalizeInstanceId(message.payload?.instanceId),
          isRunning: true,
          port: normalizePort(message.payload?.port) ?? undefined,
          lastUpdated: Date.now(),
        };

        applyInstanceStatus(status);
        await saveServerStatuses();
        broadcastServerStatusChange(status.instanceId);
        broadcastServerInstancesChanged();
        // Server is confirmed running - now we can reset reconnect state
        resetReconnectState();
        console.log(
          `${SUCCESS_MESSAGES.SERVER_STARTED} [${status.instanceId}] on port ${status.port ?? 'unknown'}`,
        );
      } else if (message.type === NativeMessageType.SERVER_STOPPED) {
        const status: McpServerInstanceStatus = {
          instanceId: normalizeInstanceId(message.payload?.instanceId),
          isRunning: false,
          port: normalizePort(message.payload?.port) ?? undefined,
          lastUpdated: Date.now(),
        };

        applyInstanceStatus(status);
        await saveServerStatuses();
        broadcastServerStatusChange(status.instanceId);
        broadcastServerInstancesChanged();
        console.log(`${SUCCESS_MESSAGES.SERVER_STOPPED} [${status.instanceId}]`);
      } else if (message.type === NativeMessageType.ERROR_FROM_NATIVE_HOST) {
        console.error('Error from native host:', message.payload?.message || 'Unknown error');
      } else if (message.type === 'file_operation_response') {
        // Forward file operation response back to the requesting tool
        chrome.runtime.sendMessage(message).catch(() => {
          // Ignore if no listeners
        });
      }
    });

    nativePort.onDisconnect.addListener(() => {
      console.warn(ERROR_MESSAGES.NATIVE_DISCONNECTED, chrome.runtime.lastError);
      nativePort = null;
      clearAllSessionContexts();
      rejectAllPendingNativeRequests('Native host disconnected');

      // Mark all known servers as stopped since native host disconnection means servers are down
      void markAllServersStopped('native_port_disconnected');

      // Handle reconnection based on disconnect reason
      if (manualDisconnect) {
        manualDisconnect = false;
        return;
      }
      if (!autoConnectEnabled) return;
      scheduleReconnect('native_port_disconnected');
    });

    return true;
  } catch (error) {
    console.warn(ERROR_MESSAGES.NATIVE_CONNECTION_FAILED, error);
    nativePort = null;
    return false;
  }
}

/**
 * Initialize native host listeners and load initial state
 */
export const initNativeHostListener = () => {
  // Initialize server status from storage
  void loadServerStatuses();
  void ensureManagedInstancesLoaded();

  // Auto-connect on SW activation (covers SW restart after idle termination)
  void ensureNativeConnected('sw_startup').catch(() => {});

  // Auto-connect on Chrome browser startup
  chrome.runtime.onStartup.addListener(() => {
    void ensureNativeConnected('onStartup').catch(() => {});
  });

  // Auto-connect on extension install/update
  chrome.runtime.onInstalled.addListener(() => {
    void ensureNativeConnected('onInstalled').catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Allow UI to call tools directly
    if (message && message.type === 'call_tool' && message.name) {
      handleCallTool({ name: message.name, args: message.args })
        .then((res) => sendResponse({ success: true, result: res }))
        .catch((err) =>
          sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }),
        );
      return true;
    }

    const msgType = typeof message === 'string' ? message : message?.type;

    // ENSURE_NATIVE: Trigger ensure without changing autoConnectEnabled
    if (msgType === NativeMessageType.ENSURE_NATIVE) {
      const portOverride = typeof message === 'object' ? message.port : undefined;
      ensureNativeConnected('ui_ensure', portOverride)
        .then((connected) => {
          sendResponse({ success: true, connected, autoConnectEnabled });
        })
        .catch((e) => {
          sendResponse({ success: false, connected: nativePort !== null, error: String(e) });
        });
      return true;
    }

    // CONNECT_NATIVE: Explicit user connect, re-enables auto-connect
    if (msgType === NativeMessageType.CONNECT_NATIVE) {
      const portOverride = typeof message === 'object' ? message.port : undefined;
      const normalized = normalizePort(portOverride, { allowZero: true });

      (async () => {
        // Explicit user connect: re-enable auto-connect
        await setNativeAutoConnectEnabled(true);

        if (typeof normalized === 'number' && normalized > 0) {
          // Best-effort: persist preferred port
          await chrome.storage.local.set({ [STORAGE_KEYS.NATIVE_SERVER_PORT]: normalized });
          await upsertManagedInstance({
            instanceId: DEFAULT_MCP_INSTANCE_ID,
            port: normalized,
            enabled: true,
            autoStart: true,
          });
        }

        return ensureNativeConnected('ui_connect', normalized ?? undefined);
      })()
        .then((connected) => {
          sendResponse({ success: true, connected });
        })
        .catch((e) => {
          sendResponse({ success: false, connected: nativePort !== null, error: String(e) });
        });
      return true;
    }

    if (msgType === NativeMessageType.PING_NATIVE) {
      const connected = nativePort !== null;
      sendResponse({ connected, autoConnectEnabled });
      return true;
    }

    // DISCONNECT_NATIVE: Explicit user disconnect, disables auto-connect
    if (msgType === NativeMessageType.DISCONNECT_NATIVE) {
      (async () => {
        // Explicit user disconnect: disable auto-connect and stop reconnect loop
        await setNativeAutoConnectEnabled(false);
        clearReconnectTimer();
        reconnectAttempts = 0;
        syncKeepaliveHold();

        if (nativePort) {
          // Only set manualDisconnect if we actually have a port to disconnect.
          // This prevents the flag from persisting when there's no active connection.
          manualDisconnect = true;
          try {
            nativePort.disconnect();
          } catch {
            // Ignore
          }
          nativePort = null;
        }
        await markAllServersStopped('manual_disconnect');
      })()
        .then(() => {
          sendResponse({ success: true });
        })
        .catch((e) => {
          sendResponse({ success: false, error: String(e) });
        });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.GET_SERVER_STATUS) {
      sendResponse({
        success: true,
        serverStatus: currentServerStatus,
        serverStatuses: currentServerStatuses,
        connected: nativePort !== null,
      });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.GET_SERVER_INSTANCES) {
      void ensureManagedInstancesLoaded()
        .then((instances) => {
          sendResponse({
            success: true,
            instances,
            statuses: currentServerStatuses,
            connected: nativePort !== null,
          });
        })
        .catch((error) => {
          sendResponse({
            success: false,
            error: String(error),
            instances: managedInstances,
            statuses: currentServerStatuses,
            connected: nativePort !== null,
          });
        });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.UPSERT_SERVER_INSTANCE) {
      void upsertManagedInstance(message?.payload)
        .then(async (instance) => {
          if (nativePort) {
            const synced = await syncManagedInstancesOnNative(managedInstances);
            if (!synced) {
              await refreshStatusesFromNative();
            }
            if (instance.enabled && message?.startNow === true) {
              await startManagedInstanceOnNative(instance);
              await refreshStatusesFromNative();
            }
          }
          sendResponse({ success: true, instance, instances: managedInstances });
        })
        .catch((error) => {
          sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
        });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.REMOVE_SERVER_INSTANCE) {
      const instanceId = parseInstanceIdInput(message?.instanceId);
      if (!instanceId) {
        sendResponse({ success: false, error: 'Invalid instanceId' });
        return true;
      }
      void (async () => {
        await removeManagedInstance(instanceId);
        if (nativePort) {
          const synced = await syncManagedInstancesOnNative(managedInstances);
          if (!synced) {
            await refreshStatusesFromNative();
          }
        }
      })()
        .then(() => {
          sendResponse({ success: true, instances: managedInstances });
        })
        .catch((error) => {
          sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
        });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.START_SERVER_INSTANCE) {
      const instanceId = parseInstanceIdInput(message?.instanceId);
      if (!instanceId) {
        sendResponse({ success: false, error: 'Invalid instanceId' });
        return true;
      }
      void (async () => {
        const connected = nativePort ? true : await ensureNativeConnected('ui_start_instance');
        if (!connected) {
          throw new Error('Native host not connected');
        }
        const byId = await getManagedInstancesById();
        const target = byId.get(instanceId);
        if (!target) {
          throw new Error(`Unknown instance: ${instanceId}`);
        }
        const started = await startManagedInstanceOnNative(target);
        if (!started) {
          throw new Error(`Failed to start instance: ${instanceId}`);
        }
        await refreshStatusesFromNative();
      })()
        .then(() => {
          sendResponse({ success: true, statuses: currentServerStatuses });
        })
        .catch((error) => {
          sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
        });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.STOP_SERVER_INSTANCE) {
      const instanceId = parseInstanceIdInput(message?.instanceId);
      if (!instanceId) {
        sendResponse({ success: false, error: 'Invalid instanceId' });
        return true;
      }
      void (async () => {
        if (!nativePort) {
          throw new Error('Native host not connected');
        }
        const stopped = await stopManagedInstanceOnNative(instanceId);
        if (!stopped) {
          throw new Error(`Failed to stop instance: ${instanceId}`);
        }
        await refreshStatusesFromNative();
      })()
        .then(() => {
          sendResponse({ success: true, statuses: currentServerStatuses });
        })
        .catch((error) => {
          sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
        });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.REFRESH_SERVER_STATUS) {
      void loadServerStatuses()
        .then(() => {
          sendResponse({
            success: true,
            serverStatus: currentServerStatus,
            serverStatuses: currentServerStatuses,
            connected: nativePort !== null,
          });
        })
        .catch((error) => {
          console.error(ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED, error);
          sendResponse({
            success: false,
            error: ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED,
            serverStatus: currentServerStatus,
            serverStatuses: currentServerStatuses,
            connected: nativePort !== null,
          });
        });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.GET_NATIVE_AUTH_TOKEN) {
      (async () => {
        if (!nativePort) {
          const connected = await ensureNativeConnected('ui_get_native_auth_token');
          if (!connected) {
            throw new Error('Native host not connected');
          }
        }
        const response = await requestNativeHost('auth_get_token', {}, 5000);
        return {
          enabled: response?.enabled === true,
          token: typeof response?.token === 'string' ? response.token : null,
        };
      })()
        .then((res) => {
          sendResponse({ success: true, ...res });
        })
        .catch((error) => {
          sendResponse({
            success: false,
            enabled: false,
            token: null,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    }

    // Forward file operation messages to native host
    if (message.type === 'forward_to_native' && message.message) {
      if (nativePort) {
        nativePort.postMessage(message.message);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Native host not connected' });
      }
      return true;
    }
  });
};
