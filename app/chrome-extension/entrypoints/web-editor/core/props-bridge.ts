/**
 * Props Bridge - ISOLATED World Communication Layer
 *
 * Bridges the Web Editor UI (ISOLATED world) and the Props Agent (MAIN world)
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
export type FrameworkType = 'react' | 'unknown';

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
 * Single prop entry with editability info
 */
export interface SerializedPropEntry {
  key: string;
  editable: boolean;
  value: SerializedValue;
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
  /** Framework version (e.g., "18.2.0" for React) */
  frameworkVersion?: string;
  componentName?: string;
  /** Source file location for the component (React _debugSource) */
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

export const PROPS_BRIDGE_RESOURCE_LIMITS = {
  minTimeoutMs: 200,
  maxTimeoutMs: 30_000,
  maxPendingRequests: 32,
  maxRequestIdBytes: 128,
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 256 * 1024,
  maxResponseValues: 20_000,
  maxResponseDepth: 24,
  maxResponseEntries: 512,
  maxResponseValidationMs: 100,
  maxSelectors: 16,
  maxLocatorChains: 16,
  maxSelectorBytes: 4 * 1024,
  maxFingerprintBytes: 4 * 1024,
  maxLocatorPath: 128,
  maxLocatorIndex: 1_000_000,
  maxPropPath: 32,
  maxPropPathBytes: 4 * 1024,
  maxPropSegmentBytes: 512,
  maxValueBytes: 16 * 1024,
  maxErrorBytes: 4 * 1024,
  maxSerializedEntries: 100,
  maxSerializedArray: 50,
  maxSerializedStringBytes: 4 * 1024,
} as const;

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

function utf8ByteLength(value: string, stopAfter = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

function isBoundedString(value: unknown, maxBytes: number, allowEmpty = true): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    utf8ByteLength(value, maxBytes) <= maxBytes
  );
}

function boundedTimeout(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return PROPS_BRIDGE_RESOURCE_LIMITS.maxTimeoutMs;
  return Math.max(
    PROPS_BRIDGE_RESOURCE_LIMITS.minTimeoutMs,
    Math.min(PROPS_BRIDGE_RESOURCE_LIMITS.maxTimeoutMs, Math.floor(numeric)),
  );
}

function normalizeSelectorArray(
  value: unknown,
  maximum: number,
  required: boolean,
): string[] | null {
  if (!Array.isArray(value) || value.length > maximum || (required && value.length === 0)) {
    return null;
  }
  const selectors: string[] = [];
  for (const item of value) {
    if (!isBoundedString(item, PROPS_BRIDGE_RESOURCE_LIMITS.maxSelectorBytes, false)) return null;
    const selector = item.trim();
    if (!selector || /:has\s*\(/i.test(selector)) return null;
    selectors.push(selector);
  }
  return selectors;
}

function normalizeLocator(locator: unknown): ElementLocator | null {
  if (!isObject(locator)) return null;
  const selectors = normalizeSelectorArray(
    locator.selectors,
    PROPS_BRIDGE_RESOURCE_LIMITS.maxSelectors,
    true,
  );
  const shadowHostChain = normalizeSelectorArray(
    locator.shadowHostChain ?? [],
    PROPS_BRIDGE_RESOURCE_LIMITS.maxLocatorChains,
    false,
  );
  const frameChain = normalizeSelectorArray(
    locator.frameChain ?? [],
    PROPS_BRIDGE_RESOURCE_LIMITS.maxLocatorChains,
    false,
  );
  if (!selectors || !shadowHostChain || !frameChain) return null;
  if (!isBoundedString(locator.fingerprint, PROPS_BRIDGE_RESOURCE_LIMITS.maxFingerprintBytes)) {
    return null;
  }
  if (
    !Array.isArray(locator.path) ||
    locator.path.length > PROPS_BRIDGE_RESOURCE_LIMITS.maxLocatorPath
  ) {
    return null;
  }
  const path: number[] = [];
  for (const item of locator.path) {
    if (
      !Number.isSafeInteger(item) ||
      (item as number) < 0 ||
      (item as number) > PROPS_BRIDGE_RESOURCE_LIMITS.maxLocatorIndex
    ) {
      return null;
    }
    path.push(item as number);
  }
  return {
    selectors,
    fingerprint: locator.fingerprint,
    path,
    ...(shadowHostChain.length > 0 ? { shadowHostChain } : {}),
    ...(frameChain.length > 0 ? { frameChain } : {}),
  };
}

function normalizePropPath(path: unknown): PropPath | null {
  if (
    !Array.isArray(path) ||
    path.length === 0 ||
    path.length > PROPS_BRIDGE_RESOURCE_LIMITS.maxPropPath
  ) {
    return null;
  }
  const normalized: PropPath = [];
  let bytes = 0;
  for (const segment of path) {
    if (typeof segment === 'string') {
      const value = segment.trim();
      if (
        !isBoundedString(value, PROPS_BRIDGE_RESOURCE_LIMITS.maxPropSegmentBytes, false) ||
        DANGEROUS_KEYS.has(value)
      ) {
        return null;
      }
      bytes += utf8ByteLength(value);
      if (bytes > PROPS_BRIDGE_RESOURCE_LIMITS.maxPropPathBytes) return null;
      normalized.push(value);
      continue;
    }
    if (
      typeof segment !== 'number' ||
      !Number.isSafeInteger(segment) ||
      segment < 0 ||
      segment > PROPS_BRIDGE_RESOURCE_LIMITS.maxLocatorIndex
    ) {
      return null;
    }
    normalized.push(segment);
  }
  return normalized;
}

function jsonByteLength(
  value: unknown,
  stopAfter = PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseBytes,
): number | null {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') return null;
    return utf8ByteLength(encoded, stopAfter);
  } catch {
    return null;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value);
}

function hasOnlyOwnKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  let count = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    count += 1;
    if (count > allowed.size || !allowed.has(key)) return false;
  }
  return true;
}

function isStructuredResponseWithinLimits(value: unknown): boolean {
  const state = {
    bytes: 0,
    values: 0,
    deadline: Date.now() + PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseValidationMs,
    seen: new WeakSet<object>(),
  };

  const visit = (current: unknown, depth: number): boolean => {
    if (
      Date.now() > state.deadline ||
      depth > PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseDepth ||
      state.values >= PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseValues
    ) {
      return false;
    }
    state.values += 1;
    state.bytes += 16;
    if (state.bytes > PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseBytes) return false;

    if (current === null || current === undefined || typeof current === 'boolean') return true;
    if (typeof current === 'number') return Number.isFinite(current);
    if (typeof current === 'string') {
      state.bytes += utf8ByteLength(
        current,
        PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseBytes - state.bytes,
      );
      return state.bytes <= PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseBytes;
    }
    if (typeof current !== 'object') return false;
    if (state.seen.has(current)) return false;
    state.seen.add(current);

    if (Array.isArray(current)) {
      if (current.length > PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseEntries) return false;
      for (let index = 0; index < current.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor || !('value' in descriptor) || !visit(descriptor.value, depth + 1)) {
          return false;
        }
      }
      return true;
    }

    let entries = 0;
    try {
      for (const key in current) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
        entries += 1;
        if (entries > PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseEntries) return false;
        state.bytes += utf8ByteLength(
          key,
          PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseBytes - state.bytes,
        );
        if (state.bytes > PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseBytes) return false;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !('value' in descriptor) || !visit(descriptor.value, depth + 1)) {
          return false;
        }
      }
    } catch {
      return false;
    }
    return true;
  };

  return visit(value, 0);
}

function responseString(value: unknown, maxBytes: number, allowEmpty = true): string | null {
  return isBoundedString(value, maxBytes, allowEmpty) ? value : null;
}

function responseCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function responseTruncated(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'boolean' ? value : null;
}

function sanitizeSerializedValue(raw: unknown, depth = 0): SerializedValue | null {
  if (
    !isRecord(raw) ||
    depth > PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseDepth ||
    !isBoundedString(raw.kind, 64, false)
  ) {
    return null;
  }

  const stringValue = (key: string, max = PROPS_BRIDGE_RESOURCE_LIMITS.maxSerializedStringBytes) =>
    responseString(raw[key], max);
  const truncated = responseTruncated(raw.truncated);
  if (truncated === null) return null;

  switch (raw.kind) {
    case 'null':
      return { kind: 'null' };
    case 'undefined':
      return { kind: 'undefined' };
    case 'boolean':
      return typeof raw.value === 'boolean' ? { kind: 'boolean', value: raw.value } : null;
    case 'number': {
      const special = raw.special;
      if (special !== undefined) {
        return special === 'NaN' || special === 'Infinity' || special === '-Infinity'
          ? { kind: 'number', special }
          : null;
      }
      return typeof raw.value === 'number' && Number.isFinite(raw.value)
        ? { kind: 'number', value: raw.value }
        : null;
    }
    case 'string': {
      const value = stringValue('value');
      const length = raw.length === undefined ? undefined : responseCount(raw.length);
      if (value === null || (raw.length !== undefined && length === null)) return null;
      return {
        kind: 'string',
        value,
        ...(truncated !== undefined ? { truncated } : {}),
        ...(length !== undefined && length !== null ? { length } : {}),
      };
    }
    case 'bigint': {
      const value = stringValue('value');
      return value === null ? null : { kind: 'bigint', value };
    }
    case 'symbol': {
      const description = stringValue('description');
      return description === null ? null : { kind: 'symbol', description };
    }
    case 'function': {
      let name: string | undefined;
      if (raw.name !== undefined) {
        const normalizedName = stringValue('name');
        if (normalizedName === null) return null;
        name = normalizedName;
      }
      return { kind: 'function', name };
    }
    case 'react_element': {
      const display = stringValue('display');
      return display === null ? null : { kind: 'react_element', display };
    }
    case 'dom_element': {
      const tagName = stringValue('tagName', 128);
      const id = raw.id === undefined ? undefined : stringValue('id');
      const className = raw.className === undefined ? undefined : stringValue('className');
      if (tagName === null || id === null || className === null) return null;
      return { kind: 'dom_element', tagName, id, className };
    }
    case 'date': {
      const value = stringValue('value');
      return value === null ? null : { kind: 'date', value };
    }
    case 'regexp': {
      const source = stringValue('source');
      const flags = stringValue('flags', 32);
      return source === null || flags === null ? null : { kind: 'regexp', source, flags };
    }
    case 'error': {
      const name = stringValue('name', 128);
      const message = stringValue('message');
      const stack = raw.stack === undefined ? undefined : stringValue('stack');
      return name === null || message === null || stack === null
        ? null
        : { kind: 'error', name, message, stack };
    }
    case 'circular':
      return Number.isSafeInteger(raw.refId) && (raw.refId as number) > 0
        ? { kind: 'circular', refId: raw.refId as number }
        : null;
    case 'max_depth':
    case 'unknown': {
      const type = stringValue('type', 128);
      const preview = stringValue('preview');
      return type === null || preview === null ? null : { kind: raw.kind, type, preview };
    }
    case 'array':
    case 'set': {
      const source = raw.kind === 'array' ? raw.items : raw.items;
      const size = responseCount(raw.kind === 'array' ? raw.length : raw.size);
      if (
        size === null ||
        !Array.isArray(source) ||
        source.length > PROPS_BRIDGE_RESOURCE_LIMITS.maxSerializedArray
      ) {
        return null;
      }
      const items: SerializedValue[] = [];
      for (const item of source) {
        const value = sanitizeSerializedValue(item, depth + 1);
        if (!value) return null;
        items.push(value);
      }
      return raw.kind === 'array'
        ? {
            kind: 'array',
            length: size,
            items,
            ...(truncated !== undefined ? { truncated } : {}),
          }
        : {
            kind: 'set',
            size,
            items,
            ...(truncated !== undefined ? { truncated } : {}),
          };
    }
    case 'object': {
      if (
        !Array.isArray(raw.entries) ||
        raw.entries.length > PROPS_BRIDGE_RESOURCE_LIMITS.maxSerializedEntries
      ) {
        return null;
      }
      const name = raw.name === undefined ? undefined : stringValue('name', 128);
      if (name === null) return null;
      const entries: Array<{ key: string; value: SerializedValue }> = [];
      for (const entry of raw.entries) {
        if (!isRecord(entry)) return null;
        const key = responseString(
          entry.key,
          PROPS_BRIDGE_RESOURCE_LIMITS.maxPropSegmentBytes,
          false,
        );
        const value = sanitizeSerializedValue(entry.value, depth + 1);
        if (key === null || !value) return null;
        entries.push({ key, value });
      }
      return {
        kind: 'object',
        name,
        entries,
        ...(truncated !== undefined ? { truncated } : {}),
      };
    }
    case 'map': {
      const size = responseCount(raw.size);
      if (
        size === null ||
        !Array.isArray(raw.entries) ||
        raw.entries.length > PROPS_BRIDGE_RESOURCE_LIMITS.maxSerializedEntries
      ) {
        return null;
      }
      const entries: Array<{ key: SerializedValue; value: SerializedValue }> = [];
      for (const entry of raw.entries) {
        if (!isRecord(entry)) return null;
        const key = sanitizeSerializedValue(entry.key, depth + 1);
        const value = sanitizeSerializedValue(entry.value, depth + 1);
        if (!key || !value) return null;
        entries.push({ key, value });
      }
      return {
        kind: 'map',
        size,
        entries,
        ...(truncated !== undefined ? { truncated } : {}),
      };
    }
    default:
      return null;
  }
}

function sanitizeSerializedProps(raw: unknown): SerializedProps | null {
  if (
    !isRecord(raw) ||
    raw.kind !== 'props' ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > PROPS_BRIDGE_RESOURCE_LIMITS.maxSerializedEntries
  ) {
    return null;
  }
  const truncated = responseTruncated(raw.truncated);
  if (truncated === null) return null;
  const entries: SerializedPropEntry[] = [];
  for (const entry of raw.entries) {
    if (!isRecord(entry) || typeof entry.editable !== 'boolean') return null;
    const key = responseString(entry.key, PROPS_BRIDGE_RESOURCE_LIMITS.maxPropSegmentBytes, false);
    const value = sanitizeSerializedValue(entry.value);
    if (key === null || !value) return null;
    let enumValues: SerializedEnumValue[] | undefined;
    if (entry.enumValues !== undefined) {
      if (
        !Array.isArray(entry.enumValues) ||
        entry.enumValues.length > PROPS_BRIDGE_RESOURCE_LIMITS.maxSerializedArray
      ) {
        return null;
      }
      enumValues = [];
      for (const item of entry.enumValues) {
        if (typeof item === 'string') {
          if (!isBoundedString(item, PROPS_BRIDGE_RESOURCE_LIMITS.maxSerializedStringBytes)) {
            return null;
          }
          enumValues.push(item);
        } else if (
          typeof item === 'boolean' ||
          (typeof item === 'number' && Number.isFinite(item))
        ) {
          enumValues.push(item);
        } else {
          return null;
        }
      }
    }
    entries.push({
      key,
      editable: entry.editable,
      value,
      ...(enumValues ? { enumValues } : {}),
    });
  }
  return {
    kind: 'props',
    entries,
    ...(truncated !== undefined ? { truncated } : {}),
  };
}

function sanitizeGenericJson(value: unknown, depth = 0): unknown | null {
  if (depth > 6) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    return isBoundedString(value, PROPS_BRIDGE_RESOURCE_LIMITS.maxSerializedStringBytes)
      ? value
      : null;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) return null;
    const out: unknown[] = [];
    for (const item of value) {
      const normalized = sanitizeGenericJson(item, depth + 1);
      if (normalized === null && item !== null) return null;
      out.push(normalized);
    }
    return out;
  }
  if (!isRecord(value)) return null;
  const out: Record<string, unknown> = Object.create(null);
  let entries = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    entries += 1;
    if (
      entries > 64 ||
      DANGEROUS_KEYS.has(key) ||
      !isBoundedString(key, PROPS_BRIDGE_RESOURCE_LIMITS.maxPropSegmentBytes, false)
    ) {
      return null;
    }
    const normalized = sanitizeGenericJson(value[key], depth + 1);
    if (normalized === null && value[key] !== null) return null;
    out[key] = normalized;
  }
  return out;
}

function sanitizeResponseData(raw: unknown): PropsResponseData | null {
  if (!isRecord(raw)) return null;
  if (
    !hasOnlyOwnKeys(
      raw,
      new Set([
        'hookStatus',
        'needsRefresh',
        'framework',
        'frameworkVersion',
        'componentName',
        'debugSource',
        'props',
        'capabilities',
        'meta',
      ]),
    )
  ) {
    return null;
  }
  const data: PropsResponseData = {};
  if (raw.hookStatus !== undefined) {
    if (
      raw.hookStatus !== 'READY' &&
      raw.hookStatus !== 'HOOK_PRESENT_NO_RENDERERS' &&
      raw.hookStatus !== 'RENDERERS_NO_EDITING' &&
      raw.hookStatus !== 'HOOK_MISSING'
    ) {
      return null;
    }
    data.hookStatus = raw.hookStatus;
  }
  if (raw.needsRefresh !== undefined) {
    if (typeof raw.needsRefresh !== 'boolean') return null;
    data.needsRefresh = raw.needsRefresh;
  }
  if (raw.framework !== undefined) {
    if (raw.framework !== 'react' && raw.framework !== 'unknown') return null;
    data.framework = raw.framework;
  }
  for (const key of ['frameworkVersion', 'componentName'] as const) {
    if (raw[key] === undefined) continue;
    const value = responseString(raw[key], 512, false);
    if (value === null) return null;
    data[key] = value;
  }
  if (raw.debugSource !== undefined) {
    if (!isRecord(raw.debugSource)) return null;
    const file = responseString(raw.debugSource.file, 4 * 1024, false);
    if (file === null) return null;
    const line = raw.debugSource.line;
    const column = raw.debugSource.column;
    if (line !== undefined && (!Number.isSafeInteger(line) || (line as number) <= 0)) return null;
    if (column !== undefined && (!Number.isSafeInteger(column) || (column as number) <= 0)) {
      return null;
    }
    data.debugSource = {
      file,
      line: line as number | undefined,
      column: column as number | undefined,
    };
  }
  if (raw.props !== undefined) {
    const props = sanitizeSerializedProps(raw.props);
    if (!props) return null;
    data.props = props;
  }
  if (raw.capabilities !== undefined) {
    if (
      !isRecord(raw.capabilities) ||
      typeof raw.capabilities.canRead !== 'boolean' ||
      typeof raw.capabilities.canWrite !== 'boolean' ||
      typeof raw.capabilities.canWriteHooks !== 'boolean'
    ) {
      return null;
    }
    data.capabilities = {
      canRead: raw.capabilities.canRead,
      canWrite: raw.capabilities.canWrite,
      canWriteHooks: raw.capabilities.canWriteHooks,
    };
  }
  if (raw.meta !== undefined) {
    const meta = sanitizeGenericJson(raw.meta);
    if (!isRecord(meta)) return null;
    data.meta = meta;
  }
  return data;
}

function normalizeRawResponse(detail: unknown): { requestId: string; result: PropsResult } | null {
  if (!isStructuredResponseWithinLimits(detail) || !isRecord(detail)) return null;
  if (!hasOnlyOwnKeys(detail, new Set(['v', 'requestId', 'success', 'data', 'error']))) return null;
  if (detail.v !== PROTOCOL_VERSION || typeof detail.success !== 'boolean') return null;
  const requestId = responseString(
    detail.requestId,
    PROPS_BRIDGE_RESOURCE_LIMITS.maxRequestIdBytes,
    false,
  );
  if (requestId === null) return null;
  let data: PropsResponseData | undefined;
  if (detail.data !== undefined) {
    const normalizedData = sanitizeResponseData(detail.data);
    if (!normalizedData) return null;
    data = normalizedData;
  }
  let error: string | undefined;
  if (detail.error !== undefined) {
    const normalizedError = responseString(
      detail.error,
      PROPS_BRIDGE_RESOURCE_LIMITS.maxErrorBytes,
    );
    if (normalizedError === null) return null;
    error = normalizedError;
  }
  const normalized = {
    v: PROTOCOL_VERSION,
    requestId,
    success: detail.success,
    data,
    error,
  } satisfies PropsRawResponse;
  const bytes = jsonByteLength(normalized);
  if (bytes === null || bytes > PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseBytes) return null;
  return {
    requestId,
    result: {
      ok: detail.success,
      data,
      error: detail.success ? undefined : error || 'Props agent error',
    },
  };
}

// =============================================================================
// Props Bridge Implementation
// =============================================================================

/**
 * Create a Props Bridge instance for communicating with the MAIN world agent
 */
export function createPropsBridge(options: PropsBridgeOptions = {}): PropsBridge {
  const defaultTimeoutMs = boundedTimeout(options.defaultTimeoutMs, DEFAULT_TIMEOUT_MS);

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
    try {
      const detail = (event as CustomEvent).detail as unknown;
      if (!isObject(detail)) return;
      const requestIdDescriptor = Object.getOwnPropertyDescriptor(detail, 'requestId');
      if (!requestIdDescriptor || !('value' in requestIdDescriptor)) return;
      const requestId = isBoundedString(
        requestIdDescriptor.value,
        PROPS_BRIDGE_RESOURCE_LIMITS.maxRequestIdBytes,
        false,
      )
        ? requestIdDescriptor.value
        : '';
      if (!requestId || !pending.has(requestId)) return;

      const entry = pending.get(requestId);
      if (!entry) return;

      const normalized = normalizeRawResponse(detail);
      if (!normalized || normalized.requestId !== requestId) return;

      pending.delete(requestId);
      clearTimeout(entry.timeoutId);
      entry.resolve(normalized.result);
    } catch {
      // Ignore malformed page-controlled responses; the real request may still arrive.
    }
  }

  // Register response listener
  window.addEventListener(EVENT_NAME.RESPONSE, onResponse as EventListener);

  function sendRequest<T extends PropsRequest>(
    request: T,
    timeoutMs: number,
  ): Promise<PropsResult> {
    assertActive();

    const { requestId } = request;
    if (!isBoundedString(requestId, PROPS_BRIDGE_RESOURCE_LIMITS.maxRequestIdBytes, false)) {
      return Promise.resolve({ ok: false, error: 'requestId is required' });
    }

    if (pending.has(requestId)) {
      return Promise.resolve({
        ok: false,
        error: `Duplicate requestId: ${requestId}`,
      });
    }

    if (pending.size >= PROPS_BRIDGE_RESOURCE_LIMITS.maxPendingRequests) {
      return Promise.resolve({
        ok: false,
        error: 'Too many pending props requests',
      });
    }

    const requestBytes = jsonByteLength(request, PROPS_BRIDGE_RESOURCE_LIMITS.maxRequestBytes);
    if (requestBytes === null || requestBytes > PROPS_BRIDGE_RESOURCE_LIMITS.maxRequestBytes) {
      return Promise.resolve({
        ok: false,
        error: 'Props request exceeds the resource limit',
      });
    }

    const boundedTimeoutMs = boundedTimeout(timeoutMs, defaultTimeoutMs);

    return new Promise<PropsResult>((resolve) => {
      const timeoutId = window.setTimeout(() => {
        pending.delete(requestId);
        resolve({
          ok: false,
          error: `Props agent timeout after ${boundedTimeoutMs}ms (op=${request.op})`,
        });
      }, boundedTimeoutMs);

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
    let normalizedLocator: ElementLocator | undefined;
    if (locator !== undefined) {
      const candidate = normalizeLocator(locator);
      if (!candidate) return { ok: false, error: 'Invalid element locator' };
      normalizedLocator = candidate;
    }
    const request: PropsProbeRequest = {
      v: PROTOCOL_VERSION,
      requestId: createRequestId(),
      op: 'probe',
      locator: normalizedLocator,
    };
    return sendRequest(request, boundedTimeout(timeoutMs, defaultTimeoutMs));
  }

  async function read(locator: ElementLocator, timeoutMs?: number): Promise<PropsResult> {
    const normalizedLocator = normalizeLocator(locator);
    if (!normalizedLocator) return { ok: false, error: 'Invalid element locator' };
    const request: PropsReadRequest = {
      v: PROTOCOL_VERSION,
      requestId: createRequestId(),
      op: 'read',
      locator: normalizedLocator,
    };
    return sendRequest(request, boundedTimeout(timeoutMs, defaultTimeoutMs));
  }

  async function write(
    locator: ElementLocator,
    path: PropPath,
    value: EditablePropValue,
    timeoutMs?: number,
  ): Promise<PropsResult> {
    const normalizedLocator = normalizeLocator(locator);
    if (!normalizedLocator) return { ok: false, error: 'Invalid element locator' };
    const normalizedPath = normalizePropPath(path);
    if (!normalizedPath) {
      return { ok: false, error: 'prop path is required' };
    }

    if (!isEditablePrimitive(value)) {
      return { ok: false, error: 'Only primitive prop values are supported' };
    }
    if (
      typeof value === 'string' &&
      utf8ByteLength(value, PROPS_BRIDGE_RESOURCE_LIMITS.maxValueBytes) >
        PROPS_BRIDGE_RESOURCE_LIMITS.maxValueBytes
    ) {
      return { ok: false, error: 'Prop value exceeds the resource limit' };
    }

    const request: PropsWriteRequest = {
      v: PROTOCOL_VERSION,
      requestId: createRequestId(),
      op: 'write',
      locator: normalizedLocator,
      payload: {
        propPath: normalizedPath,
        propValue: encodePropValue(value),
      },
    };
    return sendRequest(request, boundedTimeout(timeoutMs, defaultTimeoutMs));
  }

  async function reset(locator: ElementLocator, timeoutMs?: number): Promise<PropsResult> {
    const normalizedLocator = normalizeLocator(locator);
    if (!normalizedLocator) return { ok: false, error: 'Invalid element locator' };
    const request: PropsResetRequest = {
      v: PROTOCOL_VERSION,
      requestId: createRequestId(),
      op: 'reset',
      locator: normalizedLocator,
    };
    return sendRequest(request, boundedTimeout(timeoutMs, defaultTimeoutMs));
  }

  async function cleanup(timeoutMs?: number): Promise<void> {
    if (disposed) return;

    const ms = boundedTimeout(timeoutMs, 800);

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
