import { useEffect, useRef, useState } from 'react';

import type { RunEvent } from '@/entrypoints/background/record-replay-v3/domain/events';
import type { RunId } from '@/entrypoints/background/record-replay-v3/domain/ids';
import type { JsonObject, JsonValue } from '@/entrypoints/background/record-replay-v3/domain/json';
import {
  RR_V3_PORT_NAME,
  createRpcRequest,
  isRpcEvent,
  isRpcResponse,
  type RpcMethod,
} from '@/entrypoints/background/record-replay-v3/engine/transport/rpc';

export interface RpcRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface UseRRV3RpcOptions {
  requestTimeoutMs?: number;
  maxReconnectAttempts?: number;
  baseReconnectDelayMs?: number;
  autoConnect?: boolean;
  onConnectionChange?: (connected: boolean) => void;
  onError?: (error: string) => void;
}

type EventListener = (event: RunEvent) => void;

interface PendingRequest {
  method: RpcMethod;
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface PortListeners {
  onMessage: (msg: unknown) => void;
  onDisconnect: () => void;
}

export interface UseRRV3Rpc {
  connected: boolean;
  connecting: boolean;
  reconnecting: boolean;
  reconnectAttempts: number;
  lastError: string | null;
  isReady: boolean;
  pendingCount: number;
  subscribedRunIds: Array<RunId | null>;
  connect: () => Promise<boolean>;
  disconnect: (reason?: string) => void;
  ensureConnected: () => Promise<boolean>;
  request: <T extends JsonValue = JsonValue>(
    method: RpcMethod,
    params?: JsonObject,
    options?: RpcRequestOptions,
  ) => Promise<T>;
  subscribe: (runId?: RunId | null) => Promise<boolean>;
  unsubscribe: (runId?: RunId | null) => Promise<boolean>;
  onEvent: (listener: EventListener) => () => void;
}

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

export function useRRV3Rpc(options: UseRRV3RpcOptions = {}): UseRRV3Rpc {
  const DEFAULT_TIMEOUT_MS = options.requestTimeoutMs ?? 12_000;
  const MAX_RECONNECT_ATTEMPTS = options.maxReconnectAttempts ?? 8;
  const BASE_RECONNECT_DELAY_MS = options.baseReconnectDelayMs ?? 500;

  const [connected, setConnectedState] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectAttempts, setReconnectAttemptsState] = useState(0);
  const [lastError, setLastErrorState] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [subscribedRunIds, setSubscribedRunIds] = useState<Array<RunId | null>>([]);

  const connectedRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const portListenersRef = useRef<PortListeners | null>(null);
  const pendingRequestsRef = useRef<Map<string, PendingRequest>>(new Map());
  const eventListenersRef = useRef<Set<EventListener>>(new Set());
  const desiredSubscriptionsRef = useRef<Set<RunId | null>>(new Set());
  const connectPromiseRef = useRef<Promise<boolean> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualDisconnectRef = useRef(false);

  function updateConnected(next: boolean): void {
    if (connectedRef.current === next) {
      return;
    }
    connectedRef.current = next;
    setConnectedState(next);
    options.onConnectionChange?.(next);
  }

  function updateReconnectAttempts(next: number): void {
    reconnectAttemptsRef.current = next;
    setReconnectAttemptsState(next);
  }

  function setError(message: string | null): void {
    setLastErrorState(message);
    if (message) {
      options.onError?.(message);
    }
  }

  function syncSubscriptionsSnapshot(): void {
    const arr = Array.from(desiredSubscriptionsRef.current.values());
    arr.sort((a, b) => {
      if (a === null && b === null) return 0;
      if (a === null) return -1;
      if (b === null) return 1;
      return String(a).localeCompare(String(b));
    });
    setSubscribedRunIds(arr);
  }

  function cleanupPendingRequest(entry: PendingRequest): void {
    if (entry.timeoutId) {
      clearTimeout(entry.timeoutId);
      entry.timeoutId = null;
    }
    if (entry.signal && entry.abortHandler) {
      try {
        entry.signal.removeEventListener('abort', entry.abortHandler);
      } catch {
        // ignore
      }
    }
  }

  function rejectAllPending(reason: string): void {
    const error = new Error(reason);
    for (const [requestId, entry] of pendingRequestsRef.current) {
      cleanupPendingRequest(entry);
      entry.reject(error);
      pendingRequestsRef.current.delete(requestId);
    }
    setPendingCount(0);
  }

  async function rehydrateSubscriptions(): Promise<void> {
    if (!connectedRef.current || !portRef.current || desiredSubscriptionsRef.current.size === 0) {
      return;
    }

    for (const runId of desiredSubscriptionsRef.current) {
      try {
        const params: JsonObject = runId === null ? {} : { runId };
        await request('rr_v3.subscribe', params).catch(() => {
          // best-effort
        });
      } catch {
        // ignore
      }
    }
  }

  function scheduleReconnect(): void {
    if (manualDisconnectRef.current || reconnectTimerRef.current) {
      return;
    }

    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      setReconnecting(false);
      setError('RR V3 RPC: max reconnect attempts reached');
      return;
    }

    setReconnecting(true);
    const delay = BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttemptsRef.current);

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      updateReconnectAttempts(reconnectAttemptsRef.current + 1);
      void connect().then((ok) => {
        if (!ok) {
          scheduleReconnect();
        }
      });
    }, delay);
  }

  function clearPortListeners(port: chrome.runtime.Port | null): void {
    if (!port) {
      portListenersRef.current = null;
      return;
    }

    const listeners = portListenersRef.current;
    if (!listeners) {
      return;
    }

    try {
      port.onMessage.removeListener(listeners.onMessage);
      port.onDisconnect.removeListener(listeners.onDisconnect);
    } catch {
      // ignore
    }

    portListenersRef.current = null;
  }

  function handlePortDisconnect(): void {
    const disconnectReason = chrome.runtime.lastError?.message;
    const reason = disconnectReason
      ? `RR V3 RPC disconnected: ${disconnectReason}`
      : 'RR V3 RPC disconnected';

    const oldPort = portRef.current;
    clearPortListeners(oldPort);
    portRef.current = null;

    updateConnected(false);
    setConnecting(false);
    rejectAllPending(reason);

    if (!manualDisconnectRef.current) {
      setError(reason);
      scheduleReconnect();
    }
  }

  function handlePortMessage(msg: unknown): void {
    if (isRpcResponse(msg)) {
      const entry = pendingRequestsRef.current.get(msg.requestId);
      if (!entry) return;

      pendingRequestsRef.current.delete(msg.requestId);
      setPendingCount(pendingRequestsRef.current.size);
      cleanupPendingRequest(entry);

      if (msg.ok) {
        entry.resolve(msg.result as JsonValue);
      } else {
        entry.reject(new Error(msg.error || `RPC error: ${entry.method}`));
      }
      return;
    }

    if (isRpcEvent(msg)) {
      const event = msg.event;
      if (!isRunEvent(event)) {
        return;
      }

      for (const listener of eventListenersRef.current) {
        try {
          listener(event);
        } catch (error) {
          console.error('[useRRV3Rpc/react] Event listener error:', error);
        }
      }
    }
  }

  async function connect(): Promise<boolean> {
    if (connectedRef.current && portRef.current) {
      return true;
    }

    if (connectPromiseRef.current) {
      return connectPromiseRef.current;
    }

    connectPromiseRef.current = (async () => {
      manualDisconnectRef.current = false;
      setConnecting(true);
      setError(null);

      try {
        if (typeof chrome === 'undefined' || !chrome.runtime?.connect) {
          setError('chrome.runtime.connect not available');
          return false;
        }

        const port = chrome.runtime.connect({ name: RR_V3_PORT_NAME });
        portRef.current = port;

        updateReconnectAttempts(0);
        setReconnecting(false);
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }

        const onMessage = (msg: unknown) => handlePortMessage(msg);
        const onDisconnect = () => handlePortDisconnect();
        port.onMessage.addListener(onMessage);
        port.onDisconnect.addListener(onDisconnect);
        portListenersRef.current = { onMessage, onDisconnect };

        updateConnected(true);

        void rehydrateSubscriptions();
        return true;
      } catch (error) {
        setError(`Connection failed: ${toErrorMessage(error)}`);
        return false;
      } finally {
        setConnecting(false);
        connectPromiseRef.current = null;
      }
    })();

    return connectPromiseRef.current;
  }

  function disconnect(reason?: string): void {
    manualDisconnectRef.current = true;

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    setReconnecting(false);

    const oldPort = portRef.current;
    portRef.current = null;
    clearPortListeners(oldPort);

    updateConnected(false);
    setConnecting(false);

    rejectAllPending(reason || 'RR V3 RPC: client disconnected');

    if (oldPort) {
      try {
        oldPort.disconnect();
      } catch {
        // ignore
      }
    }
  }

  async function ensureConnected(): Promise<boolean> {
    if (connectedRef.current && portRef.current) {
      return true;
    }
    return connect();
  }

  async function request<T extends JsonValue = JsonValue>(
    method: RpcMethod,
    params?: JsonObject,
    reqOptions: RpcRequestOptions = {},
  ): Promise<T> {
    const ready = await ensureConnected();
    const port = portRef.current;

    if (!ready || !port) {
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

      const complete = (fn: () => void) => {
        pendingRequestsRef.current.delete(req.requestId);
        setPendingCount(pendingRequestsRef.current.size);
        cleanupPendingRequest(entry);
        fn();
      };

      if (timeoutMs > 0) {
        entry.timeoutId = setTimeout(() => {
          complete(() => reject(new Error(`RPC timeout (${timeoutMs}ms): ${method}`)));
        }, timeoutMs);
      }

      if (signal) {
        const onAbort = () => {
          complete(() => reject(new Error('RPC request aborted')));
        };
        entry.abortHandler = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }

      pendingRequestsRef.current.set(req.requestId, entry);
      setPendingCount(pendingRequestsRef.current.size);

      try {
        port.postMessage(req);
      } catch (error) {
        complete(() => reject(new Error(`Failed to send RPC request: ${toErrorMessage(error)}`)));
      }
    });
  }

  async function subscribe(runId: RunId | null = null): Promise<boolean> {
    desiredSubscriptionsRef.current.add(runId);
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
    desiredSubscriptionsRef.current.delete(runId);
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
    eventListenersRef.current.add(listener);
    return () => {
      eventListenersRef.current.delete(listener);
    };
  }

  useEffect(() => {
    return () => {
      disconnect('Component unmounted');
    };
  }, []);

  useEffect(() => {
    if (options.autoConnect) {
      void ensureConnected();
    }
  }, [options.autoConnect]);

  return {
    connected,
    connecting,
    reconnecting,
    reconnectAttempts,
    lastError,
    isReady: connected,
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
