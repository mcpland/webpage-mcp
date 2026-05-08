import {
  DEFAULT_MCP_INSTANCE_ID,
  TOOL_SCHEMAS,
  WEBPAGE_MCP_CAPABILITY_VERSION,
  WEBPAGE_MCP_PROTOCOL_VERSION,
  WEBPAGE_MCP_SUPPORTED_WORKFLOW_RUN_OPTIONS,
  isAgentRpcRequestPayload,
  NativeMessageType,
  type AgentRpcRequestPayload,
  type AgentRpcResponsePayload,
  type WebpageMcpCapabilityHandshakeRequest,
  type WebpageMcpExtensionCapabilities,
  type McpServerInstanceConfig,
  type McpServerInstanceStatus,
  type NativeInstanceListPayload,
} from "webpage-mcp-shared";
import { BACKGROUND_MESSAGE_TYPES } from "@/common/message-types";
import {
  NATIVE_HOST,
  STORAGE_KEYS,
  ERROR_MESSAGES,
  SUCCESS_MESSAGES,
} from "@/common/constants";
import { handleCallTool } from "./tools";
import { createStoragePort } from "./record-replay-v3";
import { listPublishedFlowDetails } from "./record-replay-v3/flows/publish";
import { acquireKeepalive } from "./keepalive-manager";
import { updateConnectionBadge } from "./action-badge";
import { maybeShowFirstConnectNotification } from "./first-connect-notification";
import {
  clearAllSessionContexts,
  clearSessionContextsForTab,
  clearSessionContextsForWindow,
} from "./session-context";
import { clearTabQueue } from "./tab-queue";

const LOG_PREFIX = "[NativeHost]";
const INSTANCE_ID_REGEX = /^[A-Za-z0-9._-]{1,64}$/;
const WORKFLOW_RUNTIME_FEATURE_FLAGS = [
  "workflow_run",
  "published_workflow_descriptors",
  "workflow_descriptor_revision",
  "workflow_stabilize_analyze_only",
  "segmented_workflow_run",
  "per_flow_write_lock",
  "locator_metadata_v1",
  "workflow_publish_tools",
  "workflow_quality_metadata",
  "workflow_secret_refs",
  "workflow_output_validation",
  "workflow_selector_repair",
  "workflow_wait_assert_repair",
  "workflow_metrics_audit",
] as const;

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
let lastNativeDisconnectError: string | null = null;

function getNativeConnectionErrorMessage(): string {
  if (lastNativeDisconnectError && lastNativeDisconnectError.trim()) {
    return `Native host not connected: ${lastNativeDisconnectError.trim()}`;
  }
  return "Native host not connected";
}

interface PendingNativeRequest {
  resolve: (payload: any) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pendingNativeRequests = new Map<string, PendingNativeRequest>();

interface ServerStatus {
  isRunning: boolean;
  lastUpdated: number;
}

type ServerStatusMap = Record<string, ServerStatus>;

let currentServerStatus: ServerStatus = {
  isRunning: false,
  lastUpdated: Date.now(),
};

function getExtensionVersion(): string {
  try {
    const version = chrome.runtime.getManifest?.().version;
    return typeof version === "string" && version.trim() ? version : "unknown";
  } catch {
    return "unknown";
  }
}

function normalizeCapabilityHandshakeRequest(
  value: unknown,
): WebpageMcpCapabilityHandshakeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const payload = value as Record<string, unknown>;
  const rawHandshake =
    payload.handshake && typeof payload.handshake === "object" && !Array.isArray(payload.handshake)
      ? (payload.handshake as Record<string, unknown>)
      : payload;
  return {
    protocolVersion:
      typeof rawHandshake.protocolVersion === "string"
        ? rawHandshake.protocolVersion
        : undefined,
    mcpServerVersion:
      typeof rawHandshake.mcpServerVersion === "string"
        ? rawHandshake.mcpServerVersion
        : undefined,
    clientCapabilities: Array.isArray(rawHandshake.clientCapabilities)
      ? rawHandshake.clientCapabilities.filter(
          (capability): capability is string => typeof capability === "string",
        )
      : undefined,
  };
}

function buildExtensionCapabilities(
  requestPayload?: unknown,
): WebpageMcpExtensionCapabilities {
  const request = normalizeCapabilityHandshakeRequest(requestPayload);
  const warnings: string[] = [];
  if (
    request.protocolVersion &&
    request.protocolVersion !== WEBPAGE_MCP_PROTOCOL_VERSION
  ) {
    warnings.push(
      `MCP server requested protocol ${request.protocolVersion}; extension supports ${WEBPAGE_MCP_PROTOCOL_VERSION}.`,
    );
  }

  return {
    protocolVersion: WEBPAGE_MCP_PROTOCOL_VERSION,
    capabilityVersion: WEBPAGE_MCP_CAPABILITY_VERSION,
    extensionVersion: getExtensionVersion(),
    ...(request.mcpServerVersion ? { mcpServerVersion: request.mcpServerVersion } : {}),
    supportedTools: TOOL_SCHEMAS.map((tool) => tool.name),
    supportedRunOptions: [...WEBPAGE_MCP_SUPPORTED_WORKFLOW_RUN_OPTIONS],
    featureFlags: [...WORKFLOW_RUNTIME_FEATURE_FLAGS],
    ...(warnings.length > 0 ? { warnings } : {}),
    generatedAt: new Date().toISOString(),
  };
}

let currentServerStatuses: ServerStatusMap = {
  [DEFAULT_MCP_INSTANCE_ID]: currentServerStatus,
};

let managedInstances: McpServerInstanceConfig[] = [];
let managedInstancesLoaded = false;

function syncConnectionBadge(): void {
  void updateConnectionBadge({
    connected: nativePort !== null,
    serverRunning: currentServerStatus.isRunning,
  });
}

function makeRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function normalizeInstanceId(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_MCP_INSTANCE_ID;
  }
  const trimmed = value.trim();
  if (!trimmed || !INSTANCE_ID_REGEX.test(trimmed)) {
    return DEFAULT_MCP_INSTANCE_ID;
  }
  return trimmed;
}

function parseInstanceIdInput(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !INSTANCE_ID_REGEX.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function sortInstances(
  instances: McpServerInstanceConfig[],
): McpServerInstanceConfig[] {
  return [...instances].sort((a, b) => {
    if (
      a.instanceId === DEFAULT_MCP_INSTANCE_ID &&
      b.instanceId !== DEFAULT_MCP_INSTANCE_ID
    )
      return -1;
    if (
      b.instanceId === DEFAULT_MCP_INSTANCE_ID &&
      a.instanceId !== DEFAULT_MCP_INSTANCE_ID
    )
      return 1;
    return a.instanceId.localeCompare(b.instanceId);
  });
}

function normalizeServerStatus(raw: unknown): ServerStatus {
  const record =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const updated =
    typeof record.lastUpdated === "number" &&
    Number.isFinite(record.lastUpdated)
      ? record.lastUpdated
      : Date.now();

  return {
    isRunning: Boolean(record.isRunning),
    lastUpdated: updated,
  };
}

function createDefaultInstanceConfig(): McpServerInstanceConfig {
  return {
    instanceId: DEFAULT_MCP_INSTANCE_ID,
    enabled: true,
    autoStart: true,
    label: "Default",
  };
}

function normalizeInstanceConfig(raw: unknown): McpServerInstanceConfig | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  let instanceId = DEFAULT_MCP_INSTANCE_ID;
  if (record.instanceId !== undefined && record.instanceId !== null) {
    if (typeof record.instanceId !== "string") {
      return null;
    }
    const trimmed = record.instanceId.trim();
    if (!trimmed || !INSTANCE_ID_REGEX.test(trimmed)) {
      return null;
    }
    instanceId = trimmed;
  }

  const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
  const autoStart =
    typeof record.autoStart === "boolean" ? record.autoStart : true;
  const label =
    typeof record.label === "string" && record.label.trim()
      ? record.label.trim()
      : undefined;

  return {
    instanceId,
    enabled,
    autoStart,
    ...(label ? { label } : {}),
  };
}

function normalizeManagedInstances(
  instances: McpServerInstanceConfig[],
): McpServerInstanceConfig[] {
  return sortInstances(instances);
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

    if (mapRaw && typeof mapRaw === "object") {
      for (const [rawId, status] of Object.entries(
        mapRaw as Record<string, unknown>,
      )) {
        const instanceId = normalizeInstanceId(rawId);
        nextMap[instanceId] = normalizeServerStatus(status);
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
    syncConnectionBadge();
  } catch (error) {
    console.error(ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED, error);
    currentServerStatuses = {
      [DEFAULT_MCP_INSTANCE_ID]: {
        isRunning: false,
        lastUpdated: Date.now(),
      },
    };
    currentServerStatus = currentServerStatuses[DEFAULT_MCP_INSTANCE_ID];
    syncConnectionBadge();
  }
}

function broadcastServerStatusChange(instanceId: string): void {
  const normalizedId = normalizeInstanceId(instanceId);
  syncConnectionBadge();
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
    lastUpdated:
      typeof status.lastUpdated === "number" &&
      Number.isFinite(status.lastUpdated)
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
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const instanceId = normalizeInstanceId(item.instanceId);
    next[instanceId] = {
      isRunning: Boolean(item.isRunning),
      lastUpdated:
        typeof item.lastUpdated === "number" &&
        Number.isFinite(item.lastUpdated)
          ? item.lastUpdated
          : Date.now(),
    };
  }

  if (!next[DEFAULT_MCP_INSTANCE_ID]) {
    next[DEFAULT_MCP_INSTANCE_ID] = {
      isRunning: false,
      lastUpdated: Date.now(),
    };
  }

  currentServerStatuses = next;
  currentServerStatus = next[DEFAULT_MCP_INSTANCE_ID];
}

async function markAllServersStopped(reason: string): Promise<void> {
  const now = Date.now();
  const nextEntries = Object.entries(currentServerStatuses).map(
    ([instanceId, status]) => {
      const normalizedId = normalizeInstanceId(instanceId);
      return [
        normalizedId,
        {
          isRunning: false,
          lastUpdated: now,
        } satisfies ServerStatus,
      ] as const;
    },
  );

  if (nextEntries.length === 0) {
    nextEntries.push([
      DEFAULT_MCP_INSTANCE_ID,
      {
        isRunning: false,
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

async function ensureManagedInstancesLoaded(): Promise<
  McpServerInstanceConfig[]
> {
  if (managedInstancesLoaded) {
    const resolvedInstances = normalizeManagedInstances(managedInstances);
    const changed =
      resolvedInstances.length !== managedInstances.length ||
      resolvedInstances.some((item, index) => {
        const previous = managedInstances[index];
        return (
          !previous ||
          previous.instanceId !== item.instanceId ||
          previous.enabled !== item.enabled ||
          previous.autoStart !== item.autoStart ||
          previous.label !== item.label
        );
      });
    if (changed) {
      managedInstances = resolvedInstances;
      await persistManagedInstances();
    }
    return managedInstances;
  }

  const snapshot = await chrome.storage.local.get([
    STORAGE_KEYS.MCP_SERVER_INSTANCES,
  ]);

  const rawList = Array.isArray(snapshot[STORAGE_KEYS.MCP_SERVER_INSTANCES])
    ? (snapshot[STORAGE_KEYS.MCP_SERVER_INSTANCES] as unknown[])
    : [];

  const byId = new Map<string, McpServerInstanceConfig>();
  for (const raw of rawList) {
    const normalized = normalizeInstanceConfig(raw);
    if (!normalized) continue;
    byId.set(normalized.instanceId, normalized);
  }

  if (!byId.has(DEFAULT_MCP_INSTANCE_ID)) {
    byId.set(DEFAULT_MCP_INSTANCE_ID, createDefaultInstanceConfig());
  }

  managedInstances = normalizeManagedInstances(Array.from(byId.values()));
  managedInstancesLoaded = true;

  await persistManagedInstances();
  return managedInstances;
}

async function getManagedInstancesById(): Promise<
  Map<string, McpServerInstanceConfig>
> {
  const loaded = await ensureManagedInstancesLoaded();
  return new Map(loaded.map((cfg) => [cfg.instanceId, cfg]));
}

async function upsertManagedInstance(
  raw: unknown,
): Promise<McpServerInstanceConfig> {
  const normalized = normalizeInstanceConfig(raw);
  if (!normalized) {
    throw new Error("Invalid instance configuration");
  }

  const byId = await getManagedInstancesById();
  byId.set(normalized.instanceId, normalized);
  if (!byId.has(DEFAULT_MCP_INSTANCE_ID)) {
    byId.set(DEFAULT_MCP_INSTANCE_ID, createDefaultInstanceConfig());
  }

  managedInstances = normalizeManagedInstances(Array.from(byId.values()));
  await persistManagedInstances();
  broadcastServerInstancesChanged();
  return (
    managedInstances.find(
      (item) => item.instanceId === normalized.instanceId,
    ) ?? normalized
  );
}

async function removeManagedInstance(instanceId: string): Promise<void> {
  const normalized = normalizeInstanceId(instanceId);
  if (normalized === DEFAULT_MCP_INSTANCE_ID) {
    throw new Error("Default instance cannot be removed");
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
  const nativeBridgePort = nativePort;
  if (!nativeBridgePort) {
    throw new Error("Native host not connected");
  }

  const requestId = makeRequestId();
  return await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingNativeRequests.delete(requestId);
      reject(new Error(`Native request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingNativeRequests.set(requestId, { resolve, reject, timeoutId });

    try {
      nativeBridgePort.postMessage({ type, requestId, payload });
    } catch (error) {
      clearTimeout(timeoutId);
      pendingNativeRequests.delete(requestId);
      reject(error);
    }
  });
}

async function probeNativeHostReady(
  timeoutMs: number = 3000,
): Promise<boolean> {
  if (!nativePort) {
    return false;
  }

  try {
    const response = (await requestNativeHost(
      NativeMessageType.LIST_INSTANCES,
      {},
      timeoutMs,
    )) as NativeInstanceListPayload;

    return response?.status === "success" && Array.isArray(response.instances);
  } catch (error) {
    console.debug(`${LOG_PREFIX} Native host probe failed`, error);
    return false;
  }
}

export async function requestAgentRpcFetch(
  payload: AgentRpcRequestPayload,
  timeoutMs: number = 30_000,
): Promise<AgentRpcResponsePayload> {
  if (!isAgentRpcRequestPayload(payload)) {
    throw new Error("Invalid agent_rpc payload: operation is required");
  }

  const connected = nativePort
    ? true
    : await ensureNativeConnected("agent_rpc_fetch");
  if (!connected) {
    throw new Error("Native host not connected");
  }
  const response = (await requestNativeHost(
    NativeMessageType.AGENT_RPC,
    payload,
    timeoutMs,
  )) as AgentRpcResponsePayload;
  return response;
}

export async function subscribeAgentStream(
  sessionId: string,
  options?: {
    instanceId?: string;
    subscriptionId?: string;
    timeoutMs?: number;
  },
): Promise<{ subscriptionId: string }> {
  const connected = nativePort
    ? true
    : await ensureNativeConnected("agent_stream_subscribe");
  if (!connected) {
    throw new Error("Native host not connected");
  }
  const response = (await requestNativeHost(
    NativeMessageType.AGENT_STREAM_SUBSCRIBE,
    {
      sessionId,
      instanceId: options?.instanceId || DEFAULT_MCP_INSTANCE_ID,
      subscriptionId: options?.subscriptionId,
    },
    options?.timeoutMs ?? 10_000,
  )) as { success?: boolean; subscriptionId?: string };

  if (!response?.success || typeof response.subscriptionId !== "string") {
    throw new Error("Failed to subscribe agent stream");
  }
  return { subscriptionId: response.subscriptionId };
}

export async function unsubscribeAgentStream(
  subscriptionId: string,
  timeoutMs: number = 10_000,
): Promise<void> {
  if (!subscriptionId.trim()) {
    return;
  }
  if (!nativePort) {
    return;
  }
  await requestNativeHost(
    NativeMessageType.AGENT_STREAM_UNSUBSCRIBE,
    {
      subscriptionId,
    },
    timeoutMs,
  );
}

function rejectAllPendingNativeRequests(reason: string): void {
  for (const [requestId, pending] of pendingNativeRequests.entries()) {
    clearTimeout(pending.timeoutId);
    pending.reject(new Error(reason));
    pendingNativeRequests.delete(requestId);
  }
}

async function startManagedInstanceOnNative(
  instance: McpServerInstanceConfig,
): Promise<boolean> {
  if (!nativePort) {
    return false;
  }
  try {
    await requestNativeHost(
      NativeMessageType.START,
      {
        instanceId: instance.instanceId,
      },
      15_000,
    );
    return true;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Failed to start instance ${instance.instanceId}`,
      error,
    );
    return false;
  }
}

async function stopManagedInstanceOnNative(
  instanceId: string,
): Promise<boolean> {
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
    if (response?.status !== "success" || !Array.isArray(response.instances)) {
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

async function refreshStatusesFromNative(options?: {
  bestEffort?: boolean;
}): Promise<void> {
  const bestEffort = options?.bestEffort === true;

  try {
    if (!nativePort) {
      throw new Error("Native host not connected");
    }

    const response = (await requestNativeHost(
      NativeMessageType.LIST_INSTANCES,
      {},
      8000,
    )) as NativeInstanceListPayload;

    if (response?.status !== "success") {
      throw new Error("Failed to list native instances");
    }
    if (!Array.isArray(response.instances)) {
      throw new Error("Native host returned an invalid instance list");
    }

    applyInstanceStatusList(response.instances);
    await saveServerStatuses();
    broadcastServerStatusChange(DEFAULT_MCP_INSTANCE_ID);
    broadcastServerInstancesChanged();
  } catch (error) {
    console.debug(
      `${LOG_PREFIX} Failed to refresh native instance statuses`,
      error,
    );
    if (bestEffort) {
      return;
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function ensureManagedInstancesRunning(): Promise<void> {
  if (!nativePort) {
    return;
  }

  const loaded = await ensureManagedInstancesLoaded();
  const synced = await syncManagedInstancesOnNative(loaded, 25_000);
  if (!synced) {
    const targets = loaded.filter((cfg) => cfg.enabled && cfg.autoStart);
    for (const instance of targets) {
      await startManagedInstanceOnNative(instance);
    }
    await refreshStatusesFromNative({ bestEffort: true });
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
  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt),
    RECONNECT_MAX_DELAY_MS,
  );
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
      keepaliveRelease = acquireKeepalive("native-host");
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
    const result = await chrome.storage.local.get([
      STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED,
    ]);
    const raw = result[STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED];
    if (typeof raw === "boolean") return raw;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Failed to load nativeAutoConnectEnabled`,
      error,
    );
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
    await chrome.storage.local.set({
      [STORAGE_KEYS.NATIVE_AUTO_CONNECT_ENABLED]: enabled,
    });
    console.debug(`${LOG_PREFIX} Set nativeAutoConnectEnabled=${enabled}`);
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} Failed to persist nativeAutoConnectEnabled`,
      error,
    );
  }
  syncKeepaliveHold();
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
 * @returns Whether the native host connection is established
 */
async function ensureNativeConnected(trigger: string): Promise<boolean> {
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
      console.debug(
        `${LOG_PREFIX} Auto-connect disabled, skipping ensure (trigger=${trigger})`,
      );
      return false;
    }

    // Sync keepalive hold
    syncKeepaliveHold();

    await ensureManagedInstancesLoaded();

    // Already connected
    if (nativePort) {
      const ready = await probeNativeHostReady(1500);
      if (!ready) {
        console.warn(
          `${LOG_PREFIX} Native probe failed on existing port (trigger=${trigger})`,
        );
        if (!lastNativeDisconnectError) {
          lastNativeDisconnectError = "Native host probe failed";
        }
        const port: any = nativePort;
        if (port) {
          try {
            if (typeof port.disconnect === "function") {
              port.disconnect();
            }
          } catch {
            // Ignore disconnect failures.
          }
        }
        nativePort = null;
        rejectAllPendingNativeRequests(
          "Native host probe failed on existing connection",
        );
        await markAllServersStopped("native_probe_failed");
        scheduleReconnect(`probe_failed:${trigger}`);
        return false;
      }

      console.debug(`${LOG_PREFIX} Already connected (trigger=${trigger})`);
      await ensureManagedInstancesRunning();
      await maybeShowFirstConnectNotification();
      return true;
    }

    // Attempt connection
    const ok = connectNativeHost();
    if (!ok) {
      console.warn(`${LOG_PREFIX} Connection failed (trigger=${trigger})`);
      if (!lastNativeDisconnectError) {
        lastNativeDisconnectError = "Failed to open native messaging port";
      }
      scheduleReconnect(`connect_failed:${trigger}`);
      return false;
    }

    const ready = await probeNativeHostReady(3000);
    if (!ready) {
      console.warn(
        `${LOG_PREFIX} Native handshake failed (trigger=${trigger})`,
      );
      if (!lastNativeDisconnectError) {
        lastNativeDisconnectError = "Native host handshake failed";
      }
      const port: any = nativePort;
      if (port) {
        try {
          if (typeof port.disconnect === "function") {
            port.disconnect();
          }
        } catch {
          // Ignore disconnect failures.
        }
      }
      nativePort = null;
      rejectAllPendingNativeRequests("Native host handshake failed");
      await markAllServersStopped("native_handshake_failed");
      scheduleReconnect(`handshake_failed:${trigger}`);
      return false;
    }

    console.debug(
      `${LOG_PREFIX} Connection initiated successfully (trigger=${trigger})`,
    );
    lastNativeDisconnectError = null;
    await ensureManagedInstancesRunning();
    await maybeShowFirstConnectNotification();
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
    lastNativeDisconnectError = null;
    nativePort = chrome.runtime.connectNative(HOST_NAME);
    syncConnectionBadge();

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

      if (
        message.type === NativeMessageType.PROCESS_DATA &&
        message.requestId
      ) {
        const requestId = message.requestId;
        const requestPayload = message.payload;

        nativePort?.postMessage({
          responseToRequestId: requestId,
          payload: {
            status: "success",
            message: SUCCESS_MESSAGES.TOOL_EXECUTED,
            data: requestPayload,
          },
        });
      } else if (
        message.type === NativeMessageType.CALL_TOOL &&
        message.requestId
      ) {
        const requestId = message.requestId;
        try {
          const payload = (message.payload || {}) as {
            name?: string;
            args?: any;
            meta?: {
              mcpSessionId?: string;
              instanceId?: string;
              clientCapabilities?:
                | string[]
                | {
                    toolListChanged?: boolean;
                    resourceReferences?: boolean;
                    cancellation?: boolean;
                    structuredErrors?: boolean;
                    largeResults?: boolean;
                    source?: string;
                    warnings?: string[];
                  };
            };
          };
          const result = await handleCallTool({
            name: String(payload.name || ""),
            args: payload.args,
            meta: { ...payload.meta, source: "mcp" },
          });
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: {
              status: "success",
              message: SUCCESS_MESSAGES.TOOL_EXECUTED,
              data: result,
            },
          });
        } catch (error) {
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: {
              status: "error",
              message: ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      } else if (
        message.type === "rr_list_published_flows" &&
        message.requestId
      ) {
        const requestId = message.requestId;
        try {
          const items = listPublishedFlowDetails(
            await createStoragePort().flows.list(),
          );
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: {
              status: "success",
              items,
              capabilities: buildExtensionCapabilities(message.payload),
            },
          });
        } catch (error: any) {
          nativePort?.postMessage({
            responseToRequestId: requestId,
            payload: {
              status: "error",
              error: error?.message || String(error),
            },
          });
        }
      } else if (
        message.type === NativeMessageType.GET_CAPABILITIES &&
        message.requestId
      ) {
        nativePort?.postMessage({
          responseToRequestId: message.requestId,
          payload: {
            status: "success",
            capabilities: buildExtensionCapabilities(message.payload),
          },
        });
      } else if (message.type === NativeMessageType.AGENT_STREAM_EVENT) {
        chrome.runtime
          .sendMessage({
            type: BACKGROUND_MESSAGE_TYPES.AGENT_STREAM_EVENT,
            payload: message.payload,
          })
          .catch(() => {
            // ignore when no listeners
          });
      } else if (message.type === NativeMessageType.SERVER_STARTED) {
        const status: McpServerInstanceStatus = {
          instanceId: normalizeInstanceId(message.payload?.instanceId),
          isRunning: true,
          lastUpdated: Date.now(),
        };

        applyInstanceStatus(status);
        await saveServerStatuses();
        broadcastServerStatusChange(status.instanceId);
        broadcastServerInstancesChanged();
        // Server is confirmed running - now we can reset reconnect state
        resetReconnectState();
        console.log(
          `${SUCCESS_MESSAGES.SERVER_STARTED} [${status.instanceId}]`,
        );
      } else if (message.type === NativeMessageType.SERVER_STOPPED) {
        const status: McpServerInstanceStatus = {
          instanceId: normalizeInstanceId(message.payload?.instanceId),
          isRunning: false,
          lastUpdated: Date.now(),
        };

        applyInstanceStatus(status);
        await saveServerStatuses();
        broadcastServerStatusChange(status.instanceId);
        broadcastServerInstancesChanged();
        console.log(
          `${SUCCESS_MESSAGES.SERVER_STOPPED} [${status.instanceId}]`,
        );
      } else if (message.type === NativeMessageType.ERROR_FROM_NATIVE_HOST) {
        console.error(
          "Error from native host:",
          message.payload?.message || "Unknown error",
        );
      } else if (message.type === "file_operation_response") {
        // Forward file operation response back to the requesting tool
        chrome.runtime.sendMessage(message).catch(() => {
          // Ignore if no listeners
        });
      }
    });

    nativePort.onDisconnect.addListener(() => {
      const disconnectMessage =
        chrome.runtime.lastError?.message || ERROR_MESSAGES.NATIVE_DISCONNECTED;
      lastNativeDisconnectError = disconnectMessage;
      console.warn(
        ERROR_MESSAGES.NATIVE_DISCONNECTED,
        chrome.runtime.lastError,
      );
      nativePort = null;
      syncConnectionBadge();
      clearAllSessionContexts();
      rejectAllPendingNativeRequests("Native host disconnected");

      // Mark all known servers as stopped since native host disconnection means servers are down
      void markAllServersStopped("native_port_disconnected");

      // Handle reconnection based on disconnect reason
      if (manualDisconnect) {
        manualDisconnect = false;
        return;
      }
      if (!autoConnectEnabled) return;
      scheduleReconnect("native_port_disconnected");
    });

    return true;
  } catch (error) {
    console.warn(ERROR_MESSAGES.NATIVE_CONNECTION_FAILED, error);
    lastNativeDisconnectError =
      error instanceof Error
        ? error.message
        : ERROR_MESSAGES.NATIVE_CONNECTION_FAILED;
    nativePort = null;
    syncConnectionBadge();
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
  void ensureNativeConnected("sw_startup").catch(() => {});

  // Auto-connect on Chrome browser startup
  chrome.runtime.onStartup.addListener(() => {
    void ensureNativeConnected("onStartup").catch(() => {});
  });

  // Auto-connect on extension install/update
  chrome.runtime.onInstalled.addListener(() => {
    void ensureNativeConnected("onInstalled").catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Allow UI to call tools directly
    if (message && message.type === "call_tool" && message.name) {
      handleCallTool({ name: message.name, args: message.args })
        .then((res) => sendResponse({ success: true, result: res }))
        .catch((err) =>
          sendResponse({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    const msgType = typeof message === "string" ? message : message?.type;

    // ENSURE_NATIVE: Trigger ensure without changing autoConnectEnabled
    if (msgType === NativeMessageType.ENSURE_NATIVE) {
      ensureNativeConnected("ui_ensure")
        .then((connected) => {
          sendResponse({
            success: connected,
            connected,
            autoConnectEnabled,
            error: connected ? undefined : getNativeConnectionErrorMessage(),
          });
        })
        .catch((e) => {
          sendResponse({
            success: false,
            connected: nativePort !== null,
            error: String(e),
          });
        });
      return true;
    }

    // CONNECT_NATIVE: Explicit user connect, re-enables auto-connect
    if (msgType === NativeMessageType.CONNECT_NATIVE) {
      (async () => {
        // Explicit user connect: re-enable auto-connect
        await setNativeAutoConnectEnabled(true);
        return ensureNativeConnected("ui_connect");
      })()
        .then((connected) => {
          sendResponse({
            success: connected,
            connected,
            error: connected ? undefined : getNativeConnectionErrorMessage(),
          });
        })
        .catch((e) => {
          sendResponse({
            success: false,
            connected: nativePort !== null,
            error: String(e),
          });
        });
      return true;
    }

    if (msgType === NativeMessageType.PING_NATIVE) {
      (async () => {
        const connected = await probeNativeHostReady(1000);
        sendResponse({ connected, autoConnectEnabled });
      })().catch((e) => {
        sendResponse({
          connected: false,
          autoConnectEnabled,
          error: String(e),
        });
      });
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
          // Only set manualDisconnect if we have an active native connection to close.
          // This prevents the flag from persisting when there's no active connection.
          manualDisconnect = true;
          try {
            nativePort.disconnect();
          } catch {
            // Ignore
          }
          nativePort = null;
        }
        await markAllServersStopped("manual_disconnect");
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
              await refreshStatusesFromNative({ bestEffort: true });
              throw new Error(
                "Failed to synchronize managed instances with native host",
              );
            }
            if (instance.enabled && message?.startNow === true) {
              const started = await startManagedInstanceOnNative(instance);
              if (!started) {
                await refreshStatusesFromNative({ bestEffort: true });
                throw new Error(
                  `Failed to start instance: ${instance.instanceId}`,
                );
              }
              await refreshStatusesFromNative();
            }
          }
          sendResponse({
            success: true,
            instance,
            instances: managedInstances,
          });
        })
        .catch((error) => {
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.REMOVE_SERVER_INSTANCE) {
      const instanceId = parseInstanceIdInput(message?.instanceId);
      if (!instanceId) {
        sendResponse({ success: false, error: "Invalid instanceId" });
        return true;
      }
      void (async () => {
        await removeManagedInstance(instanceId);
        if (nativePort) {
          const synced = await syncManagedInstancesOnNative(managedInstances);
          if (!synced) {
            await refreshStatusesFromNative({ bestEffort: true });
            throw new Error(
              "Failed to synchronize managed instances with native host",
            );
          }
        }
      })()
        .then(() => {
          sendResponse({ success: true, instances: managedInstances });
        })
        .catch((error) => {
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.START_SERVER_INSTANCE) {
      const instanceId = parseInstanceIdInput(message?.instanceId);
      if (!instanceId) {
        sendResponse({ success: false, error: "Invalid instanceId" });
        return true;
      }
      void (async () => {
        const connected = nativePort
          ? true
          : await ensureNativeConnected("ui_start_instance");
        if (!connected) {
          throw new Error("Native host not connected");
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
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.STOP_SERVER_INSTANCE) {
      const instanceId = parseInstanceIdInput(message?.instanceId);
      if (!instanceId) {
        sendResponse({ success: false, error: "Invalid instanceId" });
        return true;
      }
      void (async () => {
        if (!nativePort) {
          throw new Error("Native host not connected");
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
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.REFRESH_SERVER_STATUS) {
      void (async () => {
        await ensureManagedInstancesLoaded();
        await setNativeAutoConnectEnabled(true);
        const connected = await ensureNativeConnected("ui_refresh_status");
        if (!connected) {
          await markAllServersStopped("ui_refresh_status_failed");
          throw new Error(
            getNativeConnectionErrorMessage() || "Native host not connected",
          );
        }
        await refreshStatusesFromNative();
      })()
        .then(() => {
          sendResponse({
            success: true,
            serverStatus: currentServerStatus,
            serverStatuses: currentServerStatuses,
            connected: nativePort !== null,
          });
        })
        .catch((error) => {
          const messageText =
            error instanceof Error
              ? error.message
              : ERROR_MESSAGES.SERVER_STATUS_LOAD_FAILED;
          console.error(
            "[NativeHost] Failed to reconnect and sync status",
            error,
          );
          sendResponse({
            success: false,
            error: messageText,
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
          const connected = await ensureNativeConnected(
            "ui_get_native_auth_token",
          );
          if (!connected) {
            throw new Error("Native host not connected");
          }
        }
        const response = await requestNativeHost("auth_get_token", {}, 5000);
        return {
          enabled: response?.enabled === true,
          token: typeof response?.token === "string" ? response.token : null,
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

    if (message.type === BACKGROUND_MESSAGE_TYPES.AGENT_RPC_FETCH) {
      requestAgentRpcFetch(message?.payload)
        .then((payload) => {
          sendResponse({ success: true, payload });
        })
        .catch((error) => {
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.AGENT_STREAM_SUBSCRIBE) {
      const payload =
        message?.payload && typeof message.payload === "object"
          ? (message.payload as {
              sessionId?: string;
              instanceId?: string;
              subscriptionId?: string;
            })
          : {};
      const sessionId =
        typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
      if (!sessionId) {
        sendResponse({ success: false, error: "sessionId is required" });
        return true;
      }

      subscribeAgentStream(sessionId, {
        instanceId: payload.instanceId,
        subscriptionId: payload.subscriptionId,
      })
        .then((res) => {
          sendResponse({ success: true, ...res });
        })
        .catch((error) => {
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    }

    if (message.type === BACKGROUND_MESSAGE_TYPES.AGENT_STREAM_UNSUBSCRIBE) {
      const payload =
        message?.payload && typeof message.payload === "object"
          ? (message.payload as { subscriptionId?: string })
          : {};
      const subscriptionId =
        typeof payload.subscriptionId === "string"
          ? payload.subscriptionId.trim()
          : "";
      if (!subscriptionId) {
        sendResponse({ success: true });
        return true;
      }

      unsubscribeAgentStream(subscriptionId)
        .then(() => {
          sendResponse({ success: true });
        })
        .catch((error) => {
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    }

    // Forward file operation messages to native host
    if (message.type === "forward_to_native" && message.message) {
      if (nativePort) {
        nativePort.postMessage(message.message);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: "Native host not connected" });
      }
      return true;
    }
  });
};
