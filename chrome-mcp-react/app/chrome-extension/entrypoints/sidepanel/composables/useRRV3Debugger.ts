/**
 * @fileoverview RR V3 Debugger Composable
 * @description Debugger state management, wraps all DebuggerCommand operations
 *
 * Responsibilities:
 * - Send all debug commands via rr_v3.debug RPC method
 * - Maintain reactive DebuggerState
 * - Provide consistent error handling and response normalization
 */

import { computed, onUnmounted, ref, type ComputedRef, type Ref } from 'vue';

import type {
  DebuggerCommand,
  DebuggerResponse,
  DebuggerState,
} from '@/entrypoints/background/record-replay-v3/domain/debug';
import type { NodeId, RunId } from '@/entrypoints/background/record-replay-v3/domain/ids';
import type { JsonObject, JsonValue } from '@/entrypoints/background/record-replay-v3/domain/json';
import type { RunEvent } from '@/entrypoints/background/record-replay-v3/domain/events';

import { useRRV3Rpc, type UseRRV3Rpc } from './useRRV3Rpc';

// ==================== Types ====================

/** Composable configuration */
export interface UseRRV3DebuggerOptions {
  /** Shared RPC client instance, creates new if not provided */
  rpc?: UseRRV3Rpc;
  /** Current runId resolver for command defaults */
  getRunId?: () => RunId | null;
  /** State update callback */
  onStateChange?: (state: DebuggerState) => void;
  /** Error callback */
  onError?: (error: string) => void;
  /**
   * Auto-refresh DebuggerState when relevant events are received.
   * Only effective when attached to a run.
   * Events: run.paused, run.resumed, node.started
   */
  autoRefreshOnEvents?: boolean;
}

/** Composable return type */
export interface UseRRV3Debugger {
  /** RPC client instance */
  rpc: UseRRV3Rpc;

  // State
  state: Ref<DebuggerState | null>;
  lastError: Ref<string | null>;
  busy: Ref<boolean>;

  // Derived state
  currentRunId: ComputedRef<RunId | null>;
  isAttached: ComputedRef<boolean>;
  isPaused: ComputedRef<boolean>;

  // Connection control
  attach: (runId?: RunId) => Promise<DebuggerResponse>;
  detach: (runId?: RunId) => Promise<DebuggerResponse>;

  // Execution control
  pause: (runId?: RunId) => Promise<DebuggerResponse>;
  resume: (runId?: RunId) => Promise<DebuggerResponse>;
  stepOver: (runId?: RunId) => Promise<DebuggerResponse>;

  // Breakpoint management
  setBreakpoints: (nodeIds: NodeId[], runId?: RunId) => Promise<DebuggerResponse>;
  addBreakpoint: (nodeId: NodeId, runId?: RunId) => Promise<DebuggerResponse>;
  removeBreakpoint: (nodeId: NodeId, runId?: RunId) => Promise<DebuggerResponse>;

  // State query
  getState: (runId?: RunId) => Promise<DebuggerResponse>;

  // Variable operations
  getVar: (name: string, runId?: RunId) => Promise<DebuggerResponse>;
  setVar: (name: string, value: JsonValue, runId?: RunId) => Promise<DebuggerResponse>;
}

// ==================== Helpers ====================

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate breakpoint structure
 */
function isValidBreakpoint(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const bp = value as Record<string, unknown>;
  return typeof bp.nodeId === 'string' && typeof bp.enabled === 'boolean';
}

/**
 * Validate DebuggerState structure
 */
function isValidDebuggerState(value: unknown): value is DebuggerState {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.runId === 'string' &&
    (obj.status === 'attached' || obj.status === 'detached') &&
    (obj.execution === 'running' || obj.execution === 'paused') &&
    Array.isArray(obj.breakpoints) &&
    obj.breakpoints.every(isValidBreakpoint)
  );
}

/**
 * Normalize RPC response to DebuggerResponse
 */
function normalizeResponse(raw: JsonValue): DebuggerResponse {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Invalid response format' };
  }

  const obj = raw as Record<string, unknown>;

  if (obj.ok === true) {
    const responseState = obj.state;
    // Validate state if present
    if (responseState !== undefined && !isValidDebuggerState(responseState)) {
      return { ok: false, error: 'Invalid DebuggerState in response' };
    }
    return {
      ok: true,
      state: responseState as DebuggerState | undefined,
      value: obj.value as JsonValue | undefined,
    };
  }

  if (obj.ok === false) {
    return {
      ok: false,
      error: typeof obj.error === 'string' ? obj.error : 'Unknown error',
    };
  }

  return { ok: false, error: 'Response missing ok field' };
}

// ==================== Composable ====================

/** Events that trigger state refresh */
const STATE_REFRESH_EVENTS = new Set(['run.paused', 'run.resumed', 'node.started']);

/**
 * RR V3 Debugger client
 */
export function useRRV3Debugger(options: UseRRV3DebuggerOptions = {}): UseRRV3Debugger {
  // RPC client (use provided or create new)
  const rpc = options.rpc ?? useRRV3Rpc();

  // State
  const state = ref<DebuggerState | null>(null);
  const lastError = ref<string | null>(null);
  const busy = ref(false);

  // Derived state
  const currentRunId = computed<RunId | null>(() => {
    // Prefer external resolver
    const fromGetter = options.getRunId?.();
    if (fromGetter) return fromGetter;
    // Fallback to current state
    return state.value?.runId ?? null;
  });

  const isAttached = computed(() => state.value?.status === 'attached');
  const isPaused = computed(() => state.value?.execution === 'paused');

  // ==================== Internal Methods ====================

  function setError(message: string | null): void {
    lastError.value = message;
    if (message) options.onError?.(message);
  }

  function updateState(next?: DebuggerState): void {
    if (!next) return;
    state.value = next;
    options.onStateChange?.(next);
  }

  function resolveRunId(explicit?: RunId): RunId | null {
    if (explicit) return explicit;
    return currentRunId.value;
  }

  /**
   * Send debug command
   */
  async function send(cmd: DebuggerCommand): Promise<DebuggerResponse> {
    busy.value = true;
    try {
      const raw = await rpc.request('rr_v3.debug', cmd as unknown as JsonObject);
      const response = normalizeResponse(raw);

      if (response.ok) {
        setError(null);
        if (response.state) {
          updateState(response.state);
        }
      } else {
        setError(response.error);
      }

      return response;
    } catch (error) {
      const message = toErrorMessage(error);
      setError(message);
      return { ok: false, error: message };
    } finally {
      busy.value = false;
    }
  }

  /**
   * Create error response for missing runId
   */
  function missingRunIdError(commandType: string): DebuggerResponse {
    const message = `${commandType} requires runId`;
    setError(message);
    return { ok: false, error: message };
  }

  // ==================== Public Methods ====================

  async function attach(runId?: RunId): Promise<DebuggerResponse> {
    const resolved = resolveRunId(runId);
    if (!resolved) return missingRunIdError('debug.attach');
    return send({ type: 'debug.attach', runId: resolved });
  }

  async function detach(runId?: RunId): Promise<DebuggerResponse> {
    const resolved = resolveRunId(runId);
    if (!resolved) return missingRunIdError('debug.detach');
    return send({ type: 'debug.detach', runId: resolved });
  }

  async function pause(runId?: RunId): Promise<DebuggerResponse> {
    const resolved = resolveRunId(runId);
    if (!resolved) return missingRunIdError('debug.pause');
    return send({ type: 'debug.pause', runId: resolved });
  }

  async function resume(runId?: RunId): Promise<DebuggerResponse> {
    const resolved = resolveRunId(runId);
    if (!resolved) return missingRunIdError('debug.resume');
    return send({ type: 'debug.resume', runId: resolved });
  }

  async function stepOver(runId?: RunId): Promise<DebuggerResponse> {
    const resolved = resolveRunId(runId);
    if (!resolved) return missingRunIdError('debug.stepOver');
    return send({ type: 'debug.stepOver', runId: resolved });
  }

  async function setBreakpoints(nodeIds: NodeId[], runId?: RunId): Promise<DebuggerResponse> {
    const resolved = resolveRunId(runId);
    if (!resolved) return missingRunIdError('debug.setBreakpoints');
    return send({ type: 'debug.setBreakpoints', runId: resolved, nodeIds });
  }

  async function addBreakpoint(nodeId: NodeId, runId?: RunId): Promise<DebuggerResponse> {
    const resolved = resolveRunId(runId);
    if (!resolved) return missingRunIdError('debug.addBreakpoint');
    return send({ type: 'debug.addBreakpoint', runId: resolved, nodeId });
  }

  async function removeBreakpoint(nodeId: NodeId, runId?: RunId): Promise<DebuggerResponse> {
    const resolved = resolveRunId(runId);
    if (!resolved) return missingRunIdError('debug.removeBreakpoint');
    return send({ type: 'debug.removeBreakpoint', runId: resolved, nodeId });
  }

  async function getState(runId?: RunId): Promise<DebuggerResponse> {
    const resolved = resolveRunId(runId);
    if (!resolved) return missingRunIdError('debug.getState');
    return send({ type: 'debug.getState', runId: resolved });
  }

  async function getVar(name: string, runId?: RunId): Promise<DebuggerResponse> {
    const resolved = resolveRunId(runId);
    if (!resolved) return missingRunIdError('debug.getVar');
    return send({ type: 'debug.getVar', runId: resolved, name });
  }

  async function setVar(name: string, value: JsonValue, runId?: RunId): Promise<DebuggerResponse> {
    const resolved = resolveRunId(runId);
    if (!resolved) return missingRunIdError('debug.setVar');
    return send({ type: 'debug.setVar', runId: resolved, name, value });
  }

  // ==================== Event Auto-Refresh ====================

  // State refresh scheduling (debounced)
  let refreshScheduled = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Schedule a debounced state refresh
   * Uses microtask to coalesce multiple events in the same tick
   */
  function scheduleRefresh(): void {
    if (refreshScheduled) return;
    refreshScheduled = true;

    // Clear any existing timer
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }

    // Use microtask for same-tick debouncing
    queueMicrotask(async () => {
      refreshScheduled = false;
      // Don't update busy state for auto-refresh to avoid UI flicker
      try {
        const resolved = currentRunId.value;
        if (!resolved || !isAttached.value) return;
        const raw = await rpc.request('rr_v3.debug', {
          type: 'debug.getState',
          runId: resolved,
        } as unknown as JsonObject);
        const response = normalizeResponse(raw);
        if (response.ok && response.state) {
          updateState(response.state);
        }
      } catch {
        // Ignore errors in auto-refresh
      }
    });
  }

  /**
   * Handle incoming events for auto-refresh
   */
  function handleEvent(event: RunEvent): void {
    // Only refresh if attached and event is for current run
    if (!isAttached.value) return;
    if (event.runId !== currentRunId.value) return;
    if (!STATE_REFRESH_EVENTS.has(event.type)) return;

    scheduleRefresh();
  }

  // Setup event listener if autoRefreshOnEvents is enabled
  let unsubscribeEvents: (() => void) | null = null;
  if (options.autoRefreshOnEvents) {
    unsubscribeEvents = rpc.onEvent(handleEvent);
  }

  // Cleanup on unmount
  onUnmounted(() => {
    unsubscribeEvents?.();
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
  });

  return {
    rpc,
    state,
    lastError,
    busy,
    currentRunId,
    isAttached,
    isPaused,
    attach,
    detach,
    pause,
    resume,
    stepOver,
    setBreakpoints,
    addBreakpoint,
    removeBreakpoint,
    getState,
    getVar,
    setVar,
  };
}
