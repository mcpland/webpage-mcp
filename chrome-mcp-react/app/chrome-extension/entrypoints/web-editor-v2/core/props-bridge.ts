/**
 * Props Bridge - ISOLATED World Communication Layer
 *
 * Bridges the Web Editor V2 UI (ISOLATED world) and the Props Agent (MAIN world)
 * using CustomEvent-based messaging.
 *
 * Design notes:
 * - Uses requestId + pending map for request/response correlation
 * - Implements timeout to prevent hanging UI if agent is missing
 * - Returns structured results with both success/error state and partial data
 *
 * @module props-bridge
 */

import type { DebugSource, ElementLocator } from '@/common/web-editor-types';

// =============================================================================
// Types - Hook Status
// =============================================================================

/**
 * React DevTools Hook detection status
 */
export type HookStatus =
  | 'READY' // Hook exists with editable renderer
  | 'HOOK_PRESENT_NO_RENDERERS' // Hook exists but no renderers registered
  | 'RENDERERS_NO_EDITING' // Renderers exist but no overrideProps (production build)
  | 'HOOK_MISSING'; // No hook present

/**
 * Detected framework type
 */
export type FrameworkType = 'react' | 'vue' | 'unknown';

/**
 * Agent capabilities for the current element/framework
 */
export interface PropsCapabilities {
  canRead: boolean;
  canWrite: boolean;
  canWriteHooks: boolean;
}

// =============================================================================
// Types - Props Path & Value
// =============================================================================

export type PropPathSegment = string | number;
export type PropPath = PropPathSegment[];

/**
 * Primitive values that can be edited
 */
export type EditablePropValue = string | number | boolean | null | undefined;

/**
 * Wire format for prop values (undefined is encoded specially)
 */
export type EncodedPropValue = Exclude<EditablePropValue, undefined> | { $we: 'undefined' };

// =============================================================================
// Types - Serialized Values
// =============================================================================

interface SerializedValueBase {
  kind: string;
}

export type SerializedValue =
  | ({ kind: 'null' } & SerializedValueBase)
  | ({ kind: 'undefined' } & SerializedValueBase)
  | ({ kind: 'boolean'; value: boolean } & SerializedValueBase)
  | ({
      kind: 'number';
      value?: number;
      special?: 'NaN' | 'Infinity' | '-Infinity';
    } & SerializedValueBase)
  | ({
      kind: 'string';
      value: string;
      truncated?: boolean;
      length?: number;
    } & SerializedValueBase)
  | ({ kind: 'bigint'; value: string } & SerializedValueBase)
  | ({ kind: 'symbol'; description: string } & SerializedValueBase)
  | ({ kind: 'function'; name?: string } & SerializedValueBase)
  | ({ kind: 'react_element'; display: string } & SerializedValueBase)
  | ({
      kind: 'dom_element';
      tagName: string;
      id?: string;
      className?: string;
    } & SerializedValueBase)
  | ({ kind: 'date'; value: string } & SerializedValueBase)
  | ({ kind: 'regexp'; source: string; flags: string } & SerializedValueBase)
  | ({
      kind: 'error';
      name: string;
      message: string;
      stack?: string;
    } & SerializedValueBase)
  | ({ kind: 'circular'; refId: number } & SerializedValueBase)
  | ({ kind: 'max_depth'; type: string; preview: string } & SerializedValueBase)
  | ({
      kind: 'array';
      length: number;
      truncated?: boolean;
      items: SerializedValue[];
    } & SerializedValueBase)
  | ({
      kind: 'object';
      name?: string;
      truncated?: boolean;
      entries: Array<{ key: string; value: SerializedValue }>;
    } & SerializedValueBase)
  | ({
      kind: 'map';
      size: number;
      truncated?: boolean;
      entries: Array<{ key: SerializedValue; value: SerializedValue }>;
    } & SerializedValueBase)
  | ({
      kind: 'set';
      size: number;
      truncated?: boolean;
      items: SerializedValue[];
    } & SerializedValueBase)
  | ({ kind: 'unknown'; type: string; preview: string } & SerializedValueBase);

/**
 * Enum value type (primitive values only)
 */
export type SerializedEnumValue = string | number | boolean;

/**
 * Vue-only: source of a prop entry (declared props vs fallthrough attrs)
 */
export type PropEntrySource = 'props' | 'attrs';

/**
 * Single prop entry with editability info
 */
export interface SerializedPropEntry {
  key: string;
  editable: boolean;
  value: SerializedValue;
  /**
   * Vue-only: where this entry comes from.
   * - 'props': declared props (instance.props)
   * - 'attrs': fallthrough attrs (instance.attrs)
   */
  source?: PropEntrySource;
  /** Available enum values (if this prop is an enum type) */
  enumValues?: SerializedEnumValue[];
}

/**
 * Complete serialized props object
 */
export interface SerializedProps {
  kind: 'props';
  entries: SerializedPropEntry[];
  truncated?: boolean;
}

// =============================================================================
// Types - Protocol Messages
// =============================================================================

export type PropsOperation = 'probe' | 'read' | 'write' | 'reset' | 'cleanup';

interface PropsRequestPayload {
  propPath?: PropPath;
  propValue?: EncodedPropValue;
}

interface PropsRequestBase {
  v: 1;
  requestId: string;
  op: PropsOperation;
  locator?: ElementLocator;
  payload?: PropsRequestPayload;
}

interface PropsProbeRequest extends PropsRequestBase {
  op: 'probe';
}

interface PropsReadRequest extends PropsRequestBase {
  op: 'read';
  locator: ElementLocator;
}

interface PropsWriteRequest extends PropsRequestBase {
  op: 'write';
  locator: ElementLocator;
  payload: {
    propPath: PropPath;
    propValue: EncodedPropValue;
  };
}

interface PropsResetRequest extends PropsRequestBase {
  op: 'reset';
  locator: ElementLocator;
}

interface PropsCleanupRequest extends PropsRequestBase {
  op: 'cleanup';
}

type PropsRequest =
  | PropsProbeRequest
  | PropsReadRequest
  | PropsWriteRequest
  | PropsResetRequest
  | PropsCleanupRequest;

/**
 * Response data from agent
 */
export interface PropsResponseData {
  hookStatus?: HookStatus;
  needsRefresh?: boolean;
  framework?: FrameworkType;
  /** Framework version (e.g., "18.2.0" for React, "3.4.21" for Vue) */
  frameworkVersion?: string;
  componentName?: string;
  /** Source file location for the component (React _debugSource / Vue data-v-inspector) */
  debugSource?: DebugSource;
  props?: SerializedProps;
  capabilities?: PropsCapabilities;
  meta?: Record<string, unknown>;
}

interface PropsRawResponse {
  v: 1;
  requestId: string;
  success: boolean;
  data?: PropsResponseData;
  error?: string;
}

// =============================================================================
// Types - Bridge API
// =============================================================================

/**
 * Result type that preserves both success/error state and partial data
 */
export interface PropsResult<T = PropsResponseData> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Custom error with response data attached
 */
export class PropsError extends Error {
  readonly data?: PropsResponseData;

  constructor(message: string, data?: PropsResponseData) {
    super(message);
    this.name = 'PropsError';
    this.data = data;
  }
}

/**
 * Props Bridge public interface
 */
export interface PropsBridge {
  /**
   * Probe agent capabilities for an element
   */
  probe(locator?: ElementLocator, timeoutMs?: number): Promise<PropsResult>;

  /**
   * Read props from element's component
   */
  read(locator: ElementLocator, timeoutMs?: number): Promise<PropsResult>;

  /**
   * Write a prop value
   */
  write(
    locator: ElementLocator,
    path: PropPath,
    value: EditablePropValue,
    timeoutMs?: number,
  ): Promise<PropsResult>;

  /**
   * Reset overridden props to original values
   */
  reset(locator: ElementLocator, timeoutMs?: number): Promise<PropsResult>;

  /**
   * Cleanup agent resources
   */
  cleanup(timeoutMs?: number): Promise<void>;

  /**
   * Dispose bridge (remove listeners)
   */
  dispose(): void;

  /**
   * Check if bridge is disposed
   */
  isDisposed(): boolean;
}

/**
 * Options for creating Props Bridge
 */
export interface PropsBridgeOptions {
  defaultTimeoutMs?: number;
}

// =============================================================================
// Constants
// =============================================================================

const EVENT_NAME = {
  REQUEST: 'web-editor-props:request',
  RESPONSE: 'web-editor-props:response',
  CLEANUP: 'web-editor-props:cleanup',
} as const;

const PROTOCOL_VERSION = 1 as const;

const DEFAULT_TIMEOUT_MS = 2500;
const MIN_TIMEOUT_MS = 200;

// =============================================================================
// Utilities
// =============================================================================

function createRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fallback
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function encodePropValue(value: EditablePropValue): EncodedPropValue {
  if (value === undefined) return { $we: 'undefined' };
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function normalizeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

function isEditablePrimitive(value: unknown): value is EditablePropValue {
  if (value === null || value === undefined) return true;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(value as number);
  return false;
}

// Dangerous keys that could cause prototype pollution
const DANGEROUS_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

function hasDangerousKey(path: PropPath): boolean {
  return path.some((seg) => typeof seg === 'string' && DANGEROUS_KEYS.has(seg));
}

// =============================================================================
// Props Bridge Implementation
// =============================================================================

/**
 * Create a Props Bridge instance for communicating with the MAIN world agent
 */
export function createPropsBridge(options: PropsBridgeOptions = {}): PropsBridge {
  const defaultTimeoutMs = Math.max(MIN_TIMEOUT_MS, options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);

  interface PendingEntry {
    resolve: (result: PropsResult) => void;
    timeoutId: number;
  }

  const pending = new Map<string, PendingEntry>();
  let disposed = false;

  function assertActive(): void {
    if (disposed) {
      throw new PropsError('PropsBridge is disposed');
    }
  }

  function clearPending(error: string): void {
    for (const [requestId, entry] of pending) {
      clearTimeout(entry.timeoutId);
      entry.resolve({ ok: false, error });
      pending.delete(requestId);
    }
  }

  function onResponse(event: Event): void {
    if (disposed) return;

    const detail = (event as CustomEvent).detail as unknown;
    if (!isObject(detail)) return;
    if (detail.v !== PROTOCOL_VERSION) return;

    const requestId = typeof detail.requestId === 'string' ? detail.requestId : '';
    if (!requestId) return;

    const entry = pending.get(requestId);
    if (!entry) return;

    pending.delete(requestId);
    clearTimeout(entry.timeoutId);

    const success = Boolean(detail.success);
    const data = (detail.data as PropsResponseData | undefined) ?? undefined;
    const error = typeof detail.error === 'string' ? detail.error : undefined;

    // Always return result with data, even on failure
    entry.resolve({
      ok: success,
      data,
      error: success ? undefined : error || 'Props agent error',
    });
  }

  // Register response listener
  window.addEventListener(EVENT_NAME.RESPONSE, onResponse as EventListener);

  function sendRequest<T extends PropsRequest>(
    request: T,
    timeoutMs: number,
  ): Promise<PropsResult> {
    assertActive();

    const { requestId } = request;
    if (!requestId) {
      return Promise.resolve({ ok: false, error: 'requestId is required' });
    }

    if (pending.has(requestId)) {
      return Promise.resolve({ ok: false, error: `Duplicate requestId: ${requestId}` });
    }

    return new Promise<PropsResult>((resolve) => {
      const timeoutId = window.setTimeout(() => {
        pending.delete(requestId);
        resolve({
          ok: false,
          error: `Props agent timeout after ${timeoutMs}ms (op=${request.op})`,
        });
      }, timeoutMs);

      pending.set(requestId, { resolve, timeoutId });

      try {
        window.dispatchEvent(new CustomEvent(EVENT_NAME.REQUEST, { detail: request }));
      } catch (err) {
        clearTimeout(timeoutId);
        pending.delete(requestId);
        resolve({
          ok: false,
          error: `Failed to dispatch props request: ${normalizeErrorMessage(err)}`,
        });
      }
    });
  }

  async function probe(locator?: ElementLocator, timeoutMs?: number): Promise<PropsResult> {
    const request: PropsProbeRequest = {
      v: PROTOCOL_VERSION,
      requestId: createRequestId(),
      op: 'probe',
      locator,
    };
    return sendRequest(request, Math.max(MIN_TIMEOUT_MS, timeoutMs ?? defaultTimeoutMs));
  }

  async function read(locator: ElementLocator, timeoutMs?: number): Promise<PropsResult> {
    const request: PropsReadRequest = {
      v: PROTOCOL_VERSION,
      requestId: createRequestId(),
      op: 'read',
      locator,
    };
    return sendRequest(request, Math.max(MIN_TIMEOUT_MS, timeoutMs ?? defaultTimeoutMs));
  }

  async function write(
    locator: ElementLocator,
    path: PropPath,
    value: EditablePropValue,
    timeoutMs?: number,
  ): Promise<PropsResult> {
    if (!Array.isArray(path) || path.length === 0) {
      return { ok: false, error: 'prop path is required' };
    }

    // Security: reject dangerous keys to prevent prototype pollution
    if (hasDangerousKey(path)) {
      return { ok: false, error: 'Invalid prop path: contains dangerous key' };
    }

    if (!isEditablePrimitive(value)) {
      return { ok: false, error: 'Only primitive prop values are supported' };
    }

    const request: PropsWriteRequest = {
      v: PROTOCOL_VERSION,
      requestId: createRequestId(),
      op: 'write',
      locator,
      payload: {
        propPath: path,
        propValue: encodePropValue(value),
      },
    };
    return sendRequest(request, Math.max(MIN_TIMEOUT_MS, timeoutMs ?? defaultTimeoutMs));
  }

  async function reset(locator: ElementLocator, timeoutMs?: number): Promise<PropsResult> {
    const request: PropsResetRequest = {
      v: PROTOCOL_VERSION,
      requestId: createRequestId(),
      op: 'reset',
      locator,
    };
    return sendRequest(request, Math.max(MIN_TIMEOUT_MS, timeoutMs ?? defaultTimeoutMs));
  }

  async function cleanup(timeoutMs?: number): Promise<void> {
    if (disposed) return;

    const ms = Math.max(MIN_TIMEOUT_MS, timeoutMs ?? 800);

    // Best-effort: ask agent to cleanup first
    try {
      const request: PropsCleanupRequest = {
        v: PROTOCOL_VERSION,
        requestId: createRequestId(),
        op: 'cleanup',
      };
      await sendRequest(request, ms);
    } catch {
      // Ignore agent errors during cleanup
    } finally {
      // Dispatch cleanup event for any listeners
      try {
        window.dispatchEvent(new CustomEvent(EVENT_NAME.CLEANUP));
      } catch {
        // ignore
      }
      dispose();
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    try {
      window.removeEventListener(EVENT_NAME.RESPONSE, onResponse as EventListener);
    } catch {
      // ignore
    }

    clearPending('PropsBridge disposed');
  }

  function isDisposedFn(): boolean {
    return disposed;
  }

  return {
    probe,
    read,
    write,
    reset,
    cleanup,
    dispose,
    isDisposed: isDisposedFn,
  };
}
