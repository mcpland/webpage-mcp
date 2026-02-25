/**
 * @fileoverview RR V3 Port-RPC Client Composable (Shared)
 * @description RPC client for UI components to connect with Background Service Worker
 *
 * This composable is shared between Sidepanel, Builder, and other UI entrypoints.
 *
 * Responsibilities:
 * - Connect to background via chrome.runtime.Port
 * - Provide request/response RPC calls (with timeout and cancellation)
 * - Support event stream subscription
 * - Auto-reconnect with exponential backoff
 *
 * Design considerations:
 * - MV3 service worker may be terminated due to idle, causing Port disconnect
 * - Implement idempotent reconnection and subscription recovery
 */

import { computed, onUnmounted, ref, shallowRef, type ComputedRef, type Ref } from 'vue';

import type { JsonObject, JsonValue } from '@/entrypoints/background/record-replay-v3/domain/json';
import type { RunEvent } from '@/entrypoints/background/record-replay-v3/domain/events';
import type { RunId } from '@/entrypoints/background/record-replay-v3/domain/ids';
import {
  RR_V3_PORT_NAME,
  createRpcRequest,
  isRpcEvent,
  isRpcResponse,
  type RpcMethod,
} from '@/entrypoints/background/record-replay-v3/engine/transport/rpc';

// ==================== Types ====================

/** RPC request options */
export interface RpcRequestOptions {
  /** Timeout in milliseconds, 0 means no timeout */
  timeoutMs?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/** Composable configuration */
export interface UseRRV3RpcOptions {
  /** Default request timeout (ms) */
  requestTimeoutMs?: number;
  /** Maximum reconnect attempts */
  maxReconnectAttempts?: number;
  /** Base delay for reconnection (ms) */
  baseReconnectDelayMs?: number;
  /** Auto-connect on initialization */
  autoConnect?: boolean;
  /** Connection state change callback */
  onConnectionChange?: (connected: boolean) => void;
  /** Error callback */
  onError?: (error: string) => void;
}

/** Event listener function */
type EventListener = (event: RunEvent) => void;

/** Pending request entry */
interface PendingRequest {
  method: RpcMethod;
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
  /** AbortSignal reference for cleanup */
  signal?: AbortSignal;
  /** Abort handler for cleanup */
  abortHandler?: () => void;
}

/** Composable return type */
export interface UseRRV3Rpc {
  // Connection state
  connected: Ref<boolean>;
  connecting: Ref<boolean>;
  reconnecting: Ref<boolean>;
  reconnectAttempts: Ref<number>;
  lastError: Ref<string | null>;
  isReady: ComputedRef<boolean>;

  // Diagnostics
  pendingCount: Ref<number>;
  subscribedRunIds: Ref<Array<RunId | null>>;

  // Connection lifecycle
  connect: () => Promise<boolean>;
  disconnect: (reason?: string) => void;
  ensureConnected: () => Promise<boolean>;

  // RPC calls
  request: <T extends JsonValue = JsonValue>(
    method: RpcMethod,
    params?: JsonObject,
    options?: RpcRequestOptions,
  ) => Promise<T>;

  // Event subscription
  subscribe: (runId?: RunId | null) => Promise<boolean>;
  unsubscribe: (runId?: RunId | null) => Promise<boolean>;
  onEvent: (listener: EventListener) => () => void;
}

// ==================== Helpers ====================

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.runId === 'string' &&
    typeof obj.type === 'string' &&
    typeof obj.seq === 'number' &&
    typeof obj.ts === 'number'
  );
}

// ==================== Composable ====================

/**
 * RR V3 Port-RPC client
 */
export function useRRV3Rpc(options: UseRRV3RpcOptions = {}): UseRRV3Rpc {
  // Configuration
  const DEFAULT_TIMEOUT_MS = options.requestTimeoutMs ?? 12_000;
  const MAX_RECONNECT_ATTEMPTS = options.maxReconnectAttempts ?? 8;
  const BASE_RECONNECT_DELAY_MS = options.baseReconnectDelayMs ?? 500;

  // Reactive state
  const connected = ref(false);
  const connecting = ref(false);
  const reconnecting = ref(false);
  const reconnectAttempts = ref(0);
  const lastError = ref<string | null>(null);
  const pendingCount = ref(0);
  const subscribedRunIds = ref<Array<RunId | null>>([]);

  // Internal state (non-reactive)
  const port = shallowRef<chrome.runtime.Port | null>(null);
  const pendingRequests = new Map<string, PendingRequest>();
  const eventListeners = new Set<EventListener>();
  const desiredSubscriptions = new Set<RunId | null>();
  let connectPromise: Promise<boolean> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let manualDisconnect = false;

  // Computed
  const isReady = computed(() => connected.value && port.value !== null);

  // ==================== Internal Methods ====================

  function setError(message: string | null): void {
    lastError.value = message;
    if (message) options.onError?.(message);
  }

  function setConnected(next: boolean): void {
    if (connected.value === next) return;
    connected.value = next;
    options.onConnectionChange?.(next);
  }

  function syncSubscriptionsSnapshot(): void {
    const arr = Array.from(desiredSubscriptions.values());
    arr.sort((a, b) => {
      // Both null - equal
      if (a === null && b === null) return 0;
      // null comes first
      if (a === null) return -1;
      if (b === null) return 1;
      return String(a).localeCompare(String(b));
    });
    subscribedRunIds.value = arr;
  }

  /**
   * Clean up a pending request entry (timeout, abort listener)
   */
  function cleanupPendingRequest(entry: PendingRequest): void {
    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId);
      entry.timeoutId = null;
    }
    if (entry.signal && entry.abortHandler) {
      try {
        entry.signal.removeEventListener('abort', entry.abortHandler);
      } catch {
        // Ignore - signal may be invalid
      }
    }
  }

  function rejectAllPending(reason: string): void {
    const error = new Error(reason);
    for (const [requestId, entry] of pendingRequests) {
      cleanupPendingRequest(entry);
      entry.reject(error);
      pendingRequests.delete(requestId);
    }
    pendingCount.value = 0;
  }

  async function rehydrateSubscriptions(): Promise<void> {
    if (!isReady.value || desiredSubscriptions.size === 0) return;

    for (const runId of desiredSubscriptions) {
      try {
        const params: JsonObject = runId === null ? {} : { runId };
        await request('rr_v3.subscribe', params).catch(() => {
          // Best-effort, ignore errors
        });
      } catch {
        // Ignore
      }
    }
  }

  function scheduleReconnect(): void {
    if (manualDisconnect || reconnectTimer) return;

    if (reconnectAttempts.value >= MAX_RECONNECT_ATTEMPTS) {
      reconnecting.value = false;
      setError('RR V3 RPC: max reconnect attempts reached');
      return;
    }

    reconnecting.value = true;
    const delay = BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts.value);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectAttempts.value += 1;
      void connect().then((ok) => {
        if (!ok) scheduleReconnect();
      });
    }, delay);
  }

  // ==================== Port Handlers ====================

  function handlePortDisconnect(): void {
    // Capture disconnect reason for debugging
    const disconnectReason = chrome.runtime.lastError?.message;
    const reason = disconnectReason
      ? `RR V3 RPC disconnected: ${disconnectReason}`
      : 'RR V3 RPC disconnected';

    port.value = null;
    setConnected(false);
    connecting.value = false;
    rejectAllPending(reason);

    // Update lastError for UI visibility (only on unexpected disconnect)
    if (!manualDisconnect) {
      setError(reason);
      scheduleReconnect();
    }
  }

  function handlePortMessage(msg: unknown): void {
    // Handle RPC response
    if (isRpcResponse(msg)) {
      const entry = pendingRequests.get(msg.requestId);
      if (!entry) return;

      pendingRequests.delete(msg.requestId);
      pendingCount.value = pendingRequests.size;

      // Clean up timeout and abort listener
      cleanupPendingRequest(entry);

      if (msg.ok) {
        entry.resolve(msg.result as JsonValue);
      } else {
        entry.reject(new Error(msg.error || `RPC error: ${entry.method}`));
      }
      return;
    }

    // Handle event push
    if (isRpcEvent(msg)) {
      const event = msg.event;
      if (!isRunEvent(event)) return;

      for (const listener of eventListeners) {
        try {
          listener(event);
        } catch (e) {
          console.error('[useRRV3Rpc] Event listener error:', e);
        }
      }
    }
  }

  // ==================== Public Methods ====================

  async function connect(): Promise<boolean> {
    if (isReady.value) return true;
    if (connectPromise) return connectPromise;

    connectPromise = (async () => {
      manualDisconnect = false;
      connecting.value = true;
      setError(null);

      try {
        if (typeof chrome === 'undefined' || !chrome.runtime?.connect) {
          setError('chrome.runtime.connect not available');
          return false;
        }

        const p = chrome.runtime.connect({ name: RR_V3_PORT_NAME });
        port.value = p;

        // Reset reconnect state
        reconnectAttempts.value = 0;
        reconnecting.value = false;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }

        p.onMessage.addListener(handlePortMessage);
        p.onDisconnect.addListener(handlePortDisconnect);

        setConnected(true);

        // Restore subscriptions
        void rehydrateSubscriptions();

        return true;
      } catch (error) {
        setError(`Connection failed: ${toErrorMessage(error)}`);
        return false;
      } finally {
        connecting.value = false;
        connectPromise = null;
      }
    })();

    return connectPromise;
  }

  function disconnect(reason?: string): void {
    manualDisconnect = true;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnecting.value = false;

    const p = port.value;
    port.value = null;
    setConnected(false);
    connecting.value = false;

    rejectAllPending(reason || 'RR V3 RPC: client disconnected');

    if (p) {
      try {
        p.onMessage.removeListener(handlePortMessage);
        p.onDisconnect.removeListener(handlePortDisconnect);
        p.disconnect();
      } catch {
        // Ignore
      }
    }
  }

  async function ensureConnected(): Promise<boolean> {
    if (isReady.value) return true;
    return connect();
  }

  async function request<T extends JsonValue = JsonValue>(
    method: RpcMethod,
    params?: JsonObject,
    reqOptions: RpcRequestOptions = {},
  ): Promise<T> {
    const ready = await ensureConnected();
    const p = port.value;

    if (!ready || !p) {
      throw new Error('RR V3 RPC: not connected');
    }

    const timeoutMs = reqOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const { signal } = reqOptions;

    if (signal?.aborted) {
      throw new Error('RPC request already aborted');
    }

    const req = createRpcRequest(method, params);

    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        method,
        resolve: resolve as (value: JsonValue) => void,
        reject,
        timeoutId: null,
        signal,
      };

      // Helper to complete request with cleanup
      const complete = (fn: () => void) => {
        pendingRequests.delete(req.requestId);
        pendingCount.value = pendingRequests.size;
        cleanupPendingRequest(entry);
        fn();
      };

      // Timeout handling
      if (timeoutMs > 0) {
        entry.timeoutId = setTimeout(() => {
          complete(() => reject(new Error(`RPC timeout (${timeoutMs}ms): ${method}`)));
        }, timeoutMs);
      }

      // Abort handling
      if (signal) {
        const onAbort = () => {
          complete(() => reject(new Error('RPC request aborted')));
        };
        entry.abortHandler = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }

      pendingRequests.set(req.requestId, entry);
      pendingCount.value = pendingRequests.size;

      try {
        p.postMessage(req);
      } catch (e) {
        complete(() => reject(new Error(`Failed to send RPC request: ${toErrorMessage(e)}`)));
      }
    });
  }

  async function subscribe(runId: RunId | null = null): Promise<boolean> {
    desiredSubscriptions.add(runId);
    syncSubscriptionsSnapshot();

    try {
      const params: JsonObject = runId === null ? {} : { runId };
      await request('rr_v3.subscribe', params);
      return true;
    } catch (error) {
      setError(toErrorMessage(error));
      return false;
    }
  }

  async function unsubscribe(runId: RunId | null = null): Promise<boolean> {
    desiredSubscriptions.delete(runId);
    syncSubscriptionsSnapshot();

    try {
      const params: JsonObject = runId === null ? {} : { runId };
      await request('rr_v3.unsubscribe', params);
      return true;
    } catch (error) {
      setError(toErrorMessage(error));
      return false;
    }
  }

  function onEvent(listener: EventListener): () => void {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  }

  // ==================== Lifecycle ====================

  onUnmounted(() => {
    disconnect('Component unmounted');
  });

  if (options.autoConnect) {
    void ensureConnected();
  }

  return {
    connected,
    connecting,
    reconnecting,
    reconnectAttempts,
    lastError,
    isReady,
    pendingCount,
    subscribedRunIds,
    connect,
    disconnect,
    ensureConnected,
    request,
    subscribe,
    unsubscribe,
    onEvent,
  };
}
