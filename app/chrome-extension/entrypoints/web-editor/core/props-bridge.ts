/**
 * Props Bridge - ISOLATED World Communication Layer
 *
 * Bridges the Web Editor UI to the background worker, which authenticates the
 * active surface and executes one bounded function in the exact MAIN document.
 *
 * Design notes:
 * - Uses requestId + pending map for request/response correlation
 * - Implements timeout to prevent hanging UI if agent is missing
 * - Returns structured results with both success/error state and partial data
 *
 * @module props-bridge
 */

import type { DebugSource, ElementLocator } from "@/common/web-editor-types";
import { BACKGROUND_MESSAGE_TYPES } from "@/common/message-types";
import { sendWebEditorRuntimeMessage } from "./runtime-messaging";

// =============================================================================
// Types - Hook Status
// =============================================================================

/**
 * React DevTools Hook detection status
 */
export type HookStatus =
  | "READY" // Hook exists with editable renderer
  | "HOOK_PRESENT_NO_RENDERERS" // Hook exists but no renderers registered
  | "RENDERERS_NO_EDITING" // Renderers exist but no overrideProps (production build)
  | "HOOK_MISSING"; // No hook present

/**
 * Detected framework type
 */
export type FrameworkType = "react" | "unknown";

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
export type EncodedPropValue =
  | Exclude<EditablePropValue, undefined>
  | { $we: "undefined" };

// =============================================================================
// Types - Serialized Values
// =============================================================================

interface SerializedValueBase {
  kind: string;
}

export type SerializedValue =
  | ({ kind: "null" } & SerializedValueBase)
  | ({ kind: "undefined" } & SerializedValueBase)
  | ({ kind: "boolean"; value: boolean } & SerializedValueBase)
  | ({
      kind: "number";
      value?: number;
      special?: "NaN" | "Infinity" | "-Infinity";
    } & SerializedValueBase)
  | ({
      kind: "string";
      value: string;
      truncated?: boolean;
      length?: number;
    } & SerializedValueBase)
  | ({ kind: "bigint"; value: string } & SerializedValueBase)
  | ({ kind: "symbol"; description: string } & SerializedValueBase)
  | ({ kind: "function"; name?: string } & SerializedValueBase)
  | ({ kind: "react_element"; display: string } & SerializedValueBase)
  | ({
      kind: "dom_element";
      tagName: string;
      id?: string;
      className?: string;
    } & SerializedValueBase)
  | ({ kind: "date"; value: string } & SerializedValueBase)
  | ({ kind: "regexp"; source: string; flags: string } & SerializedValueBase)
  | ({
      kind: "error";
      name: string;
      message: string;
      stack?: string;
    } & SerializedValueBase)
  | ({ kind: "circular"; refId: number } & SerializedValueBase)
  | ({ kind: "max_depth"; type: string; preview: string } & SerializedValueBase)
  | ({
      kind: "array";
      length: number;
      truncated?: boolean;
      items: SerializedValue[];
    } & SerializedValueBase)
  | ({
      kind: "object";
      name?: string;
      truncated?: boolean;
      entries: Array<{ key: string; value: SerializedValue }>;
    } & SerializedValueBase)
  | ({
      kind: "map";
      size: number;
      truncated?: boolean;
      entries: Array<{ key: SerializedValue; value: SerializedValue }>;
    } & SerializedValueBase)
  | ({
      kind: "set";
      size: number;
      truncated?: boolean;
      items: SerializedValue[];
    } & SerializedValueBase)
  | ({ kind: "unknown"; type: string; preview: string } & SerializedValueBase);

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
  kind: "props";
  entries: SerializedPropEntry[];
  truncated?: boolean;
}

// =============================================================================
// Types - Protocol Messages
// =============================================================================

export type PropsOperation = "probe" | "read" | "write" | "reset";

export interface PropsOriginalEntry {
  path: PropPath;
  encodedValue: EncodedPropValue;
  existed: boolean;
  componentGuard: string;
}

export interface PropsResetOriginalEntry extends PropsOriginalEntry {
  index: number;
}

interface PropsRequestBase {
  v: 1;
  requestId: string;
  op: PropsOperation;
  locator?: ElementLocator;
}

interface PropsProbeRequest extends PropsRequestBase {
  op: "probe";
}

interface PropsReadRequest extends PropsRequestBase {
  op: "read";
  locator: ElementLocator;
}

interface PropsWriteRequest extends PropsRequestBase {
  op: "write";
  locator: ElementLocator;
  payload: {
    propPath: PropPath;
    propValue: EncodedPropValue;
    captureOriginal: boolean;
    expectedTargetGuard?: string;
    stateBudgetBytes: number;
  };
}

interface PropsResetRequest extends PropsRequestBase {
  op: "reset";
  locator: ElementLocator;
  payload: {
    originals: PropsResetOriginalEntry[];
  };
}

export type PropsRpcRequest =
  | PropsProbeRequest
  | PropsReadRequest
  | PropsWriteRequest
  | PropsResetRequest;

export type PropsStateDelta =
  | ({ kind: "write_original" } & PropsOriginalEntry)
  | {
      kind: "reset_result";
      appliedIndexes: number[];
      guardMismatch: boolean;
    };

export interface PropsExecutionEnvelope {
  response: PropsRawResponse;
  targetGuard?: string;
  stateDelta?: PropsStateDelta;
}

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
    this.name = "PropsError";
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
  /** Background-owned active Web Editor surface session. */
  surfaceSessionId: string;
}

// =============================================================================
// Constants
// =============================================================================

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
  maxOriginalEntries: 256,
  maxOriginalBytes: 256 * 1024,
  maxOriginalsPerLocator: 64,
  maxOriginalBytesPerLocator: 48 * 1024,
  maxComponentGuardBytes: 512,
  maxTargetAliases: 512,
} as const;

// =============================================================================
// Utilities
// =============================================================================

function createRequestId(): string {
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
  } catch {
    // Fallback
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function utf8ByteLength(
  value: string,
  stopAfter = Number.POSITIVE_INFINITY,
): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

function isBoundedString(
  value: unknown,
  maxBytes: number,
  allowEmpty = true,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    utf8ByteLength(value, maxBytes) <= maxBytes
  );
}

function boundedTimeout(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric))
    return PROPS_BRIDGE_RESOURCE_LIMITS.maxTimeoutMs;
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
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    (required && value.length === 0)
  ) {
    return null;
  }
  const selectors: string[] = [];
  for (const item of value) {
    if (
      !isBoundedString(
        item,
        PROPS_BRIDGE_RESOURCE_LIMITS.maxSelectorBytes,
        false,
      )
    )
      return null;
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
  if (!selectors || !shadowHostChain || !frameChain || frameChain.length > 0)
    return null;
  if (
    !isBoundedString(
      locator.fingerprint,
      PROPS_BRIDGE_RESOURCE_LIMITS.maxFingerprintBytes,
    )
  ) {
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
    if (typeof segment === "string") {
      const value = segment.trim();
      if (
        !isBoundedString(
          value,
          PROPS_BRIDGE_RESOURCE_LIMITS.maxPropSegmentBytes,
          false,
        ) ||
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
      typeof segment !== "number" ||
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
    if (typeof encoded !== "string") return null;
    return utf8ByteLength(encoded, stopAfter);
  } catch {
    return null;
  }
}

function encodePropValue(value: EditablePropValue): EncodedPropValue {
  if (value === undefined) return { $we: "undefined" };
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function normalizeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

function isEditablePrimitive(value: unknown): value is EditablePropValue {
  if (value === null || value === undefined) return true;
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(value as number);
  return false;
}

// Dangerous keys that could cause prototype pollution
const DANGEROUS_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value);
}

function hasOnlyOwnKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
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
    if (state.bytes > PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseBytes)
      return false;

    if (
      current === null ||
      current === undefined ||
      typeof current === "boolean"
    )
      return true;
    if (typeof current === "number") return Number.isFinite(current);
    if (typeof current === "string") {
      state.bytes += utf8ByteLength(
        current,
        PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseBytes - state.bytes,
      );
      return state.bytes <= PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseBytes;
    }
    if (typeof current !== "object") return false;
    if (state.seen.has(current)) return false;
    state.seen.add(current);

    if (Array.isArray(current)) {
      if (current.length > PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseEntries)
        return false;
      for (let index = 0; index < current.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(
          current,
          String(index),
        );
        if (
          !descriptor ||
          !("value" in descriptor) ||
          !visit(descriptor.value, depth + 1)
        ) {
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
        if (entries > PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseEntries)
          return false;
        state.bytes += utf8ByteLength(
          key,
          PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseBytes - state.bytes,
        );
        if (state.bytes > PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseBytes)
          return false;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (
          !descriptor ||
          !("value" in descriptor) ||
          !visit(descriptor.value, depth + 1)
        ) {
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

function responseString(
  value: unknown,
  maxBytes: number,
  allowEmpty = true,
): string | null {
  return isBoundedString(value, maxBytes, allowEmpty) ? value : null;
}

function responseCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function responseTruncated(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : null;
}

function sanitizeSerializedValue(
  raw: unknown,
  depth = 0,
): SerializedValue | null {
  if (
    !isRecord(raw) ||
    depth > PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseDepth ||
    !isBoundedString(raw.kind, 64, false)
  ) {
    return null;
  }

  const stringValue = (
    key: string,
    max = PROPS_BRIDGE_RESOURCE_LIMITS.maxSerializedStringBytes,
  ) => responseString(raw[key], max);
  const truncated = responseTruncated(raw.truncated);
  if (truncated === null) return null;

  switch (raw.kind) {
    case "null":
      return { kind: "null" };
    case "undefined":
      return { kind: "undefined" };
    case "boolean":
      return typeof raw.value === "boolean"
        ? { kind: "boolean", value: raw.value }
        : null;
    case "number": {
      const special = raw.special;
      if (special !== undefined) {
        return special === "NaN" ||
          special === "Infinity" ||
          special === "-Infinity"
          ? { kind: "number", special }
          : null;
      }
      return typeof raw.value === "number" && Number.isFinite(raw.value)
        ? { kind: "number", value: raw.value }
        : null;
    }
    case "string": {
      const value = stringValue("value");
      const length =
        raw.length === undefined ? undefined : responseCount(raw.length);
      if (value === null || (raw.length !== undefined && length === null))
        return null;
      return {
        kind: "string",
        value,
        ...(truncated !== undefined ? { truncated } : {}),
        ...(length !== undefined && length !== null ? { length } : {}),
      };
    }
    case "bigint": {
      const value = stringValue("value");
      return value === null ? null : { kind: "bigint", value };
    }
    case "symbol": {
      const description = stringValue("description");
      return description === null ? null : { kind: "symbol", description };
    }
    case "function": {
      let name: string | undefined;
      if (raw.name !== undefined) {
        const normalizedName = stringValue("name");
        if (normalizedName === null) return null;
        name = normalizedName;
      }
      return { kind: "function", name };
    }
    case "react_element": {
      const display = stringValue("display");
      return display === null ? null : { kind: "react_element", display };
    }
    case "dom_element": {
      const tagName = stringValue("tagName", 128);
      const id = raw.id === undefined ? undefined : stringValue("id");
      const className =
        raw.className === undefined ? undefined : stringValue("className");
      if (tagName === null || id === null || className === null) return null;
      return { kind: "dom_element", tagName, id, className };
    }
    case "date": {
      const value = stringValue("value");
      return value === null ? null : { kind: "date", value };
    }
    case "regexp": {
      const source = stringValue("source");
      const flags = stringValue("flags", 32);
      return source === null || flags === null
        ? null
        : { kind: "regexp", source, flags };
    }
    case "error": {
      const name = stringValue("name", 128);
      const message = stringValue("message");
      const stack = raw.stack === undefined ? undefined : stringValue("stack");
      return name === null || message === null || stack === null
        ? null
        : { kind: "error", name, message, stack };
    }
    case "circular":
      return Number.isSafeInteger(raw.refId) && (raw.refId as number) > 0
        ? { kind: "circular", refId: raw.refId as number }
        : null;
    case "max_depth":
    case "unknown": {
      const type = stringValue("type", 128);
      const preview = stringValue("preview");
      return type === null || preview === null
        ? null
        : { kind: raw.kind, type, preview };
    }
    case "array":
    case "set": {
      const source = raw.kind === "array" ? raw.items : raw.items;
      const size = responseCount(raw.kind === "array" ? raw.length : raw.size);
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
      return raw.kind === "array"
        ? {
            kind: "array",
            length: size,
            items,
            ...(truncated !== undefined ? { truncated } : {}),
          }
        : {
            kind: "set",
            size,
            items,
            ...(truncated !== undefined ? { truncated } : {}),
          };
    }
    case "object": {
      if (
        !Array.isArray(raw.entries) ||
        raw.entries.length > PROPS_BRIDGE_RESOURCE_LIMITS.maxSerializedEntries
      ) {
        return null;
      }
      const name =
        raw.name === undefined ? undefined : stringValue("name", 128);
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
        kind: "object",
        name,
        entries,
        ...(truncated !== undefined ? { truncated } : {}),
      };
    }
    case "map": {
      const size = responseCount(raw.size);
      if (
        size === null ||
        !Array.isArray(raw.entries) ||
        raw.entries.length > PROPS_BRIDGE_RESOURCE_LIMITS.maxSerializedEntries
      ) {
        return null;
      }
      const entries: Array<{ key: SerializedValue; value: SerializedValue }> =
        [];
      for (const entry of raw.entries) {
        if (!isRecord(entry)) return null;
        const key = sanitizeSerializedValue(entry.key, depth + 1);
        const value = sanitizeSerializedValue(entry.value, depth + 1);
        if (!key || !value) return null;
        entries.push({ key, value });
      }
      return {
        kind: "map",
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
    raw.kind !== "props" ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > PROPS_BRIDGE_RESOURCE_LIMITS.maxSerializedEntries
  ) {
    return null;
  }
  const truncated = responseTruncated(raw.truncated);
  if (truncated === null) return null;
  const entries: SerializedPropEntry[] = [];
  for (const entry of raw.entries) {
    if (!isRecord(entry) || typeof entry.editable !== "boolean") return null;
    const key = responseString(
      entry.key,
      PROPS_BRIDGE_RESOURCE_LIMITS.maxPropSegmentBytes,
      false,
    );
    const value = sanitizeSerializedValue(entry.value);
    if (key === null || !value) return null;
    let enumValues: SerializedEnumValue[] | undefined;
    if (entry.enumValues !== undefined) {
      if (
        !Array.isArray(entry.enumValues) ||
        entry.enumValues.length >
          PROPS_BRIDGE_RESOURCE_LIMITS.maxSerializedArray
      ) {
        return null;
      }
      enumValues = [];
      for (const item of entry.enumValues) {
        if (typeof item === "string") {
          if (
            !isBoundedString(
              item,
              PROPS_BRIDGE_RESOURCE_LIMITS.maxSerializedStringBytes,
            )
          ) {
            return null;
          }
          enumValues.push(item);
        } else if (
          typeof item === "boolean" ||
          (typeof item === "number" && Number.isFinite(item))
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
    kind: "props",
    entries,
    ...(truncated !== undefined ? { truncated } : {}),
  };
}

function sanitizeGenericJson(value: unknown, depth = 0): unknown | null {
  if (depth > 6) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    return isBoundedString(
      value,
      PROPS_BRIDGE_RESOURCE_LIMITS.maxSerializedStringBytes,
    )
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
      !isBoundedString(
        key,
        PROPS_BRIDGE_RESOURCE_LIMITS.maxPropSegmentBytes,
        false,
      )
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
        "hookStatus",
        "needsRefresh",
        "framework",
        "frameworkVersion",
        "componentName",
        "debugSource",
        "props",
        "capabilities",
        "meta",
      ]),
    )
  ) {
    return null;
  }
  const data: PropsResponseData = {};
  if (raw.hookStatus !== undefined) {
    if (
      raw.hookStatus !== "READY" &&
      raw.hookStatus !== "HOOK_PRESENT_NO_RENDERERS" &&
      raw.hookStatus !== "RENDERERS_NO_EDITING" &&
      raw.hookStatus !== "HOOK_MISSING"
    ) {
      return null;
    }
    data.hookStatus = raw.hookStatus;
  }
  if (raw.needsRefresh !== undefined) {
    if (typeof raw.needsRefresh !== "boolean") return null;
    data.needsRefresh = raw.needsRefresh;
  }
  if (raw.framework !== undefined) {
    if (raw.framework !== "react" && raw.framework !== "unknown") return null;
    data.framework = raw.framework;
  }
  for (const key of ["frameworkVersion", "componentName"] as const) {
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
    if (
      line !== undefined &&
      (!Number.isSafeInteger(line) || (line as number) <= 0)
    )
      return null;
    if (
      column !== undefined &&
      (!Number.isSafeInteger(column) || (column as number) <= 0)
    ) {
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
      typeof raw.capabilities.canRead !== "boolean" ||
      typeof raw.capabilities.canWrite !== "boolean" ||
      typeof raw.capabilities.canWriteHooks !== "boolean"
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

export function normalizePropsRawResponse(detail: unknown): {
  requestId: string;
  response: PropsRawResponse;
  result: PropsResult;
} | null {
  if (!isStructuredResponseWithinLimits(detail) || !isRecord(detail))
    return null;
  if (
    !hasOnlyOwnKeys(
      detail,
      new Set(["v", "requestId", "success", "data", "error"]),
    )
  )
    return null;
  if (detail.v !== PROTOCOL_VERSION || typeof detail.success !== "boolean")
    return null;
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
  if (bytes === null || bytes > PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseBytes)
    return null;
  return {
    requestId,
    response: normalized,
    result: {
      ok: detail.success,
      data,
      error: detail.success ? undefined : error || "Props agent error",
    },
  };
}

function normalizeEncodedPropValue(
  value: unknown,
  maxStringBytes = PROPS_BRIDGE_RESOURCE_LIMITS.maxValueBytes,
): { value: EncodedPropValue } | null {
  if (isEditablePrimitive(value) && value !== undefined) {
    if (
      typeof value === "string" &&
      utf8ByteLength(value, maxStringBytes) > maxStringBytes
    ) {
      return null;
    }
    return { value };
  }
  if (
    isRecord(value) &&
    hasOnlyOwnKeys(value, new Set(["$we"])) &&
    value.$we === "undefined"
  ) {
    return { value: { $we: "undefined" } };
  }
  return null;
}

/** Strictly copy a page-to-background props request into a bounded wire value. */
export function normalizePropsRpcRequest(
  value: unknown,
): PropsRpcRequest | null {
  if (!isRecord(value)) return null;
  const op = value.op;
  const allowedKeys = new Set(["v", "requestId", "op", "locator", "payload"]);
  if (!hasOnlyOwnKeys(value, allowedKeys) || value.v !== PROTOCOL_VERSION)
    return null;
  if (op !== "probe" && op !== "read" && op !== "write" && op !== "reset")
    return null;
  const requestId = isBoundedString(
    value.requestId,
    PROPS_BRIDGE_RESOURCE_LIMITS.maxRequestIdBytes,
    false,
  )
    ? value.requestId
    : null;
  if (!requestId) return null;

  const locator =
    value.locator === undefined ? undefined : normalizeLocator(value.locator);
  if (value.locator !== undefined && !locator) return null;
  if ((op === "read" || op === "write" || op === "reset") && !locator)
    return null;

  let normalized: PropsRpcRequest;
  if (op === "probe") {
    if (value.payload !== undefined) return null;
    normalized = {
      v: PROTOCOL_VERSION,
      requestId,
      op,
      ...(locator ? { locator } : {}),
    };
  } else if (op === "read") {
    if (value.payload !== undefined) return null;
    normalized = {
      v: PROTOCOL_VERSION,
      requestId,
      op,
      locator: locator as ElementLocator,
    };
  } else if (op === "write") {
    if (
      !isRecord(value.payload) ||
      !hasOnlyOwnKeys(
        value.payload,
        new Set([
          "propPath",
          "propValue",
          "captureOriginal",
          "expectedTargetGuard",
          "stateBudgetBytes",
        ]),
      )
    ) {
      return null;
    }
    const propPath = normalizePropPath(value.payload.propPath);
    const propValue = normalizeEncodedPropValue(value.payload.propValue);
    const captureOriginal = value.payload.captureOriginal;
    const expectedTargetGuard = value.payload.expectedTargetGuard;
    const stateBudgetBytes = value.payload.stateBudgetBytes;
    if (
      !propPath ||
      propValue === null ||
      typeof captureOriginal !== "boolean" ||
      (expectedTargetGuard !== undefined &&
        !isBoundedString(
          expectedTargetGuard,
          PROPS_BRIDGE_RESOURCE_LIMITS.maxComponentGuardBytes,
          false,
        )) ||
      (!captureOriginal && expectedTargetGuard === undefined) ||
      !Number.isSafeInteger(stateBudgetBytes) ||
      (stateBudgetBytes as number) < 0 ||
      (stateBudgetBytes as number) >
        PROPS_BRIDGE_RESOURCE_LIMITS.maxOriginalBytesPerLocator ||
      (captureOriginal
        ? (stateBudgetBytes as number) === 0
        : (stateBudgetBytes as number) !== 0)
    ) {
      return null;
    }
    normalized = {
      v: PROTOCOL_VERSION,
      requestId,
      op,
      locator: locator as ElementLocator,
      payload: {
        propPath,
        propValue: propValue.value,
        captureOriginal,
        ...(expectedTargetGuard !== undefined ? { expectedTargetGuard } : {}),
        stateBudgetBytes: stateBudgetBytes as number,
      },
    };
  } else {
    if (
      !isRecord(value.payload) ||
      !hasOnlyOwnKeys(value.payload, new Set(["originals"])) ||
      !Array.isArray(value.payload.originals) ||
      value.payload.originals.length === 0 ||
      value.payload.originals.length >
        PROPS_BRIDGE_RESOURCE_LIMITS.maxOriginalsPerLocator
    ) {
      return null;
    }
    const originals: PropsResetOriginalEntry[] = [];
    const indexes = new Set<number>();
    for (const candidate of value.payload.originals) {
      if (
        !isRecord(candidate) ||
        !hasOnlyOwnKeys(
          candidate,
          new Set([
            "index",
            "path",
            "encodedValue",
            "existed",
            "componentGuard",
          ]),
        )
      ) {
        return null;
      }
      const index = candidate.index;
      const path = normalizePropPath(candidate.path);
      const encodedValue = normalizeEncodedPropValue(
        candidate.encodedValue,
        PROPS_BRIDGE_RESOURCE_LIMITS.maxOriginalBytesPerLocator,
      );
      if (
        !Number.isSafeInteger(index) ||
        (index as number) < 0 ||
        (index as number) >= value.payload.originals.length ||
        indexes.has(index as number) ||
        !path ||
        encodedValue === null ||
        typeof candidate.existed !== "boolean" ||
        !isBoundedString(
          candidate.componentGuard,
          PROPS_BRIDGE_RESOURCE_LIMITS.maxComponentGuardBytes,
          false,
        )
      ) {
        return null;
      }
      indexes.add(index as number);
      originals.push({
        index: index as number,
        path,
        encodedValue: encodedValue.value,
        existed: candidate.existed,
        componentGuard: candidate.componentGuard,
      });
    }
    normalized = {
      v: PROTOCOL_VERSION,
      requestId,
      op,
      locator: locator as ElementLocator,
      payload: { originals },
    };
  }

  const bytes = jsonByteLength(
    normalized,
    PROPS_BRIDGE_RESOURCE_LIMITS.maxRequestBytes,
  );
  return bytes !== null && bytes <= PROPS_BRIDGE_RESOURCE_LIMITS.maxRequestBytes
    ? normalized
    : null;
}

/** Validate the private MAIN result without exposing reset state as public props data. */
export function normalizePropsExecutionEnvelope(
  value: unknown,
  request: PropsRpcRequest,
): PropsExecutionEnvelope | null {
  const envelopeBytes = jsonByteLength(
    value,
    PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseBytes,
  );
  if (
    !isRecord(value) ||
    !hasOnlyOwnKeys(
      value,
      new Set(["response", "targetGuard", "stateDelta"]),
    ) ||
    envelopeBytes === null ||
    envelopeBytes > PROPS_BRIDGE_RESOURCE_LIMITS.maxResponseBytes
  ) {
    return null;
  }
  const normalizedResponse = normalizePropsRawResponse(value.response);
  if (!normalizedResponse || normalizedResponse.requestId !== request.requestId)
    return null;

  const targetGuard =
    value.targetGuard === undefined
      ? undefined
      : isBoundedString(
            value.targetGuard,
            PROPS_BRIDGE_RESOURCE_LIMITS.maxComponentGuardBytes,
            false,
          )
        ? value.targetGuard
        : null;
  if (targetGuard === null) return null;

  let stateDelta: PropsStateDelta | undefined;
  if (value.stateDelta !== undefined) {
    if (
      !isRecord(value.stateDelta) ||
      typeof value.stateDelta.kind !== "string"
    )
      return null;
    if (request.op === "write" && value.stateDelta.kind === "write_original") {
      if (
        !request.payload.captureOriginal ||
        !hasOnlyOwnKeys(
          value.stateDelta,
          new Set([
            "kind",
            "path",
            "existed",
            "encodedValue",
            "componentGuard",
          ]),
        )
      ) {
        return null;
      }
      const path = normalizePropPath(value.stateDelta.path);
      const encodedValue = normalizeEncodedPropValue(
        value.stateDelta.encodedValue,
        PROPS_BRIDGE_RESOURCE_LIMITS.maxOriginalBytesPerLocator,
      );
      if (
        !path ||
        JSON.stringify(path) !== JSON.stringify(request.payload.propPath) ||
        encodedValue === null ||
        typeof value.stateDelta.existed !== "boolean" ||
        !isBoundedString(
          value.stateDelta.componentGuard,
          PROPS_BRIDGE_RESOURCE_LIMITS.maxComponentGuardBytes,
          false,
        ) ||
        value.stateDelta.componentGuard !== targetGuard
      ) {
        return null;
      }
      const deltaBytes = jsonByteLength(
        value.stateDelta,
        request.payload.stateBudgetBytes,
      );
      if (deltaBytes === null || deltaBytes > request.payload.stateBudgetBytes)
        return null;
      stateDelta = {
        kind: "write_original",
        path,
        encodedValue: encodedValue.value,
        existed: value.stateDelta.existed,
        componentGuard: value.stateDelta.componentGuard,
      };
    } else if (
      request.op === "reset" &&
      value.stateDelta.kind === "reset_result"
    ) {
      if (
        !hasOnlyOwnKeys(
          value.stateDelta,
          new Set(["kind", "appliedIndexes", "guardMismatch"]),
        ) ||
        !Array.isArray(value.stateDelta.appliedIndexes) ||
        value.stateDelta.appliedIndexes.length >
          request.payload.originals.length ||
        typeof value.stateDelta.guardMismatch !== "boolean"
      ) {
        return null;
      }
      const allowedIndexes = new Set(
        request.payload.originals.map((entry) => entry.index),
      );
      const appliedIndexes: number[] = [];
      const seen = new Set<number>();
      for (const index of value.stateDelta.appliedIndexes) {
        if (
          !Number.isSafeInteger(index) ||
          !allowedIndexes.has(index) ||
          seen.has(index)
        ) {
          return null;
        }
        seen.add(index);
        appliedIndexes.push(index);
      }
      if (value.stateDelta.guardMismatch && appliedIndexes.length > 0)
        return null;
      stateDelta = {
        kind: "reset_result",
        appliedIndexes,
        guardMismatch: value.stateDelta.guardMismatch,
      };
    } else {
      return null;
    }
  }
  if (
    request.op === "write" &&
    request.payload.captureOriginal &&
    normalizedResponse.response.success &&
    stateDelta?.kind !== "write_original"
  ) {
    return null;
  }
  if (
    request.op === "write" &&
    request.payload.expectedTargetGuard !== undefined &&
    normalizedResponse.response.success &&
    targetGuard !== request.payload.expectedTargetGuard
  ) {
    return null;
  }
  if (
    request.op === "reset" &&
    stateDelta?.kind === "reset_result" &&
    !stateDelta.guardMismatch &&
    targetGuard !== request.payload.originals[0]?.componentGuard
  ) {
    return null;
  }
  if (
    request.op !== "probe" &&
    normalizedResponse.response.success &&
    targetGuard === undefined
  ) {
    return null;
  }
  return {
    response: normalizedResponse.response,
    ...(targetGuard !== undefined ? { targetGuard } : {}),
    ...(stateDelta ? { stateDelta } : {}),
  };
}

// =============================================================================
// Props Bridge Implementation
// =============================================================================

/**
 * Create a Props Bridge instance for communicating with the MAIN world agent
 */
export function createPropsBridge(options: PropsBridgeOptions): PropsBridge {
  const defaultTimeoutMs = boundedTimeout(
    options.defaultTimeoutMs,
    DEFAULT_TIMEOUT_MS,
  );
  const surfaceSessionId = options.surfaceSessionId;
  if (!/^[a-f0-9]{64}$/.test(surfaceSessionId)) {
    throw new PropsError("A valid Web Editor surface session is required");
  }

  interface PendingEntry {
    resolve: (result: PropsResult) => void;
    timeoutId: number;
  }

  interface StoredOriginal extends PropsOriginalEntry {
    bytes: number;
    sourceLocatorKey: string;
  }

  interface GuardOriginals {
    entries: Map<string, StoredOriginal>;
    bytes: number;
  }

  interface RequestHandle {
    result: Promise<PropsResult>;
    settled: Promise<void>;
  }

  const pending = new Map<string, PendingEntry>();
  const originalsByGuard = new Map<string, GuardOriginals>();
  const targetGuardByLocator = new Map<string, string>();
  const pinnedGuardByLocator = new Map<
    string,
    { guard: string; entries: number }
  >();
  let originalEntries = 0;
  let originalBytes = 0;
  let inFlightTransports = 0;
  let mutationQueue: Promise<void> = Promise.resolve();
  let lifecycle: "active" | "closing" | "disposed" = "active";
  let cleanupPromise: Promise<void> | null = null;

  function assertActive(): void {
    if (lifecycle !== "active") throw new PropsError("PropsBridge is disposed");
  }

  function locatorKey(locator: ElementLocator): string {
    return JSON.stringify(locator);
  }

  function propPathKey(path: PropPath): string {
    return JSON.stringify(path);
  }

  function clearOriginals(): void {
    originalsByGuard.clear();
    targetGuardByLocator.clear();
    pinnedGuardByLocator.clear();
    originalEntries = 0;
    originalBytes = 0;
  }

  function targetGuardForLocator(key: string): string | undefined {
    return (
      pinnedGuardByLocator.get(key)?.guard ?? targetGuardByLocator.get(key)
    );
  }

  function rememberTargetGuard(key: string, guard: string): void {
    targetGuardByLocator.delete(key);
    while (
      targetGuardByLocator.size >= PROPS_BRIDGE_RESOURCE_LIMITS.maxTargetAliases
    ) {
      const oldest = targetGuardByLocator.keys().next().value as
        | string
        | undefined;
      if (!oldest) break;
      targetGuardByLocator.delete(oldest);
    }
    targetGuardByLocator.set(key, guard);
  }

  function clearPending(error: string): void {
    for (const [requestId, entry] of pending) {
      clearTimeout(entry.timeoutId);
      entry.resolve({ ok: false, error });
      pending.delete(requestId);
    }
  }

  function absorbStateDelta(
    request: PropsRpcRequest,
    envelope: PropsExecutionEnvelope,
  ): void {
    if (lifecycle === "disposed") return;
    const key = request.locator ? locatorKey(request.locator) : "";
    const delta = envelope.stateDelta;
    if (
      envelope.targetGuard &&
      (envelope.response.success || delta?.kind === "write_original")
    ) {
      rememberTargetGuard(key, envelope.targetGuard);
    }
    if (!delta) return;

    if (request.op === "write" && delta.kind === "write_original") {
      const pathKey = propPathKey(delta.path);
      let guardState = originalsByGuard.get(delta.componentGuard);
      if (guardState?.entries.has(pathKey)) return;

      const bytes = jsonByteLength(
        delta,
        PROPS_BRIDGE_RESOURCE_LIMITS.maxOriginalBytes,
      );
      if (
        bytes === null ||
        bytes > PROPS_BRIDGE_RESOURCE_LIMITS.maxOriginalBytesPerLocator ||
        originalEntries >= PROPS_BRIDGE_RESOURCE_LIMITS.maxOriginalEntries ||
        originalBytes + bytes > PROPS_BRIDGE_RESOURCE_LIMITS.maxOriginalBytes
      ) {
        return;
      }

      if (!guardState) {
        guardState = { entries: new Map(), bytes: 0 };
        originalsByGuard.set(delta.componentGuard, guardState);
      }
      guardState.entries.set(pathKey, {
        path: delta.path,
        encodedValue: delta.encodedValue,
        existed: delta.existed,
        componentGuard: delta.componentGuard,
        bytes,
        sourceLocatorKey: key,
      });
      const pinned = pinnedGuardByLocator.get(key);
      if (!pinned) {
        pinnedGuardByLocator.set(key, {
          guard: delta.componentGuard,
          entries: 1,
        });
      } else if (pinned.guard === delta.componentGuard) {
        pinned.entries += 1;
      }
      guardState.bytes += bytes;
      originalEntries += 1;
      originalBytes += bytes;
      return;
    }

    if (request.op === "reset" && delta.kind === "reset_result") {
      const guard = request.payload.originals[0]?.componentGuard;
      const guardState = guard ? originalsByGuard.get(guard) : undefined;
      if (!guardState) return;
      for (const index of delta.appliedIndexes) {
        const requested = request.payload.originals.find(
          (entry) => entry.index === index,
        );
        if (!requested) continue;
        const pathKey = propPathKey(requested.path);
        const stored = guardState.entries.get(pathKey);
        if (
          !stored ||
          stored.componentGuard !== requested.componentGuard ||
          stored.existed !== requested.existed ||
          JSON.stringify(stored.encodedValue) !==
            JSON.stringify(requested.encodedValue)
        ) {
          continue;
        }
        guardState.entries.delete(pathKey);
        guardState.bytes -= stored.bytes;
        originalEntries -= 1;
        originalBytes -= stored.bytes;
        const pinned = pinnedGuardByLocator.get(stored.sourceLocatorKey);
        if (pinned?.guard === guard) {
          if (pinned.entries <= 1)
            pinnedGuardByLocator.delete(stored.sourceLocatorKey);
          else pinned.entries -= 1;
        }
      }
      if (guardState.entries.size === 0 && guard)
        originalsByGuard.delete(guard);
    }
  }

  function backgroundFailure(value: unknown): PropsResult {
    if (
      isRecord(value) &&
      value.success === false &&
      isBoundedString(
        value.error,
        PROPS_BRIDGE_RESOURCE_LIMITS.maxErrorBytes,
        false,
      )
    ) {
      return { ok: false, error: value.error };
    }
    return { ok: false, error: "Invalid props response from background" };
  }

  function dispatchRequest(
    requestValue: PropsRpcRequest,
    timeoutMs: number,
    allowClosing = false,
  ): RequestHandle {
    const request = normalizePropsRpcRequest(requestValue);
    if (!request) {
      return {
        result: Promise.resolve({ ok: false, error: "Invalid props request" }),
        settled: Promise.resolve(),
      };
    }
    if (lifecycle === "disposed" || (!allowClosing && lifecycle !== "active")) {
      return {
        result: Promise.resolve({ ok: false, error: "PropsBridge disposed" }),
        settled: Promise.resolve(),
      };
    }
    if (pending.has(request.requestId)) {
      return {
        result: Promise.resolve({
          ok: false,
          error: "Duplicate props request ID",
        }),
        settled: Promise.resolve(),
      };
    }
    if (inFlightTransports >= PROPS_BRIDGE_RESOURCE_LIMITS.maxPendingRequests) {
      return {
        result: Promise.resolve({
          ok: false,
          error: "Too many pending props requests",
        }),
        settled: Promise.resolve(),
      };
    }

    const boundedTimeoutMs = boundedTimeout(timeoutMs, defaultTimeoutMs);
    let resolveResult!: (result: PropsResult) => void;
    const result = new Promise<PropsResult>((resolve) => {
      resolveResult = resolve;
    });
    const timeoutId = window.setTimeout(() => {
      const entry = pending.get(request.requestId);
      if (!entry) return;
      pending.delete(request.requestId);
      entry.resolve({
        ok: false,
        error:
          "Props agent timeout after " +
          boundedTimeoutMs +
          "ms (op=" +
          request.op +
          ")",
      });
    }, boundedTimeoutMs);
    pending.set(request.requestId, { resolve: resolveResult, timeoutId });
    inFlightTransports += 1;

    const settled = Promise.resolve()
      .then(() =>
        sendWebEditorRuntimeMessage({
          type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_PROPS_EXECUTE,
          surfaceSessionId,
          request,
        }),
      )
      .then((rawResponse: unknown) => {
        let publicResult: PropsResult;
        if (
          isRecord(rawResponse) &&
          hasOnlyOwnKeys(rawResponse, new Set(["success", "execution"])) &&
          rawResponse.success === true
        ) {
          const envelope = normalizePropsExecutionEnvelope(
            rawResponse.execution,
            request,
          );
          if (envelope) {
            // State is absorbed even after the UI timeout. This preserves the
            // pre-mutation original for a late but successful MAIN operation.
            absorbStateDelta(request, envelope);
            publicResult =
              normalizePropsRawResponse(envelope.response)?.result ??
              ({
                ok: false,
                error: "Invalid props response from MAIN world",
              } as PropsResult);
          } else {
            publicResult = {
              ok: false,
              error: "Invalid props response from MAIN world",
            };
          }
        } else {
          publicResult = backgroundFailure(rawResponse);
        }

        const entry = pending.get(request.requestId);
        if (!entry) return;
        pending.delete(request.requestId);
        clearTimeout(entry.timeoutId);
        entry.resolve(publicResult);
      })
      .catch((error: unknown) => {
        const entry = pending.get(request.requestId);
        if (!entry) return;
        pending.delete(request.requestId);
        clearTimeout(entry.timeoutId);
        entry.resolve({
          ok: false,
          error: "Props request failed: " + normalizeErrorMessage(error),
        });
      })
      .finally(() => {
        inFlightTransports = Math.max(0, inFlightTransports - 1);
      });

    return { result, settled };
  }

  function enqueueMutation(
    createRequest: () => PropsRpcRequest | PropsResult,
    timeoutMs: number,
  ): Promise<PropsResult> {
    let resolveResult!: (result: PropsResult) => void;
    const result = new Promise<PropsResult>((resolve) => {
      resolveResult = resolve;
    });

    const operation = mutationQueue.then(async () => {
      if (lifecycle === "disposed") {
        resolveResult({ ok: false, error: "PropsBridge disposed" });
        return;
      }
      const request = createRequest();
      if ("ok" in request) {
        resolveResult(request);
        return;
      }
      const handle = dispatchRequest(request, timeoutMs, true);
      void handle.result.then(resolveResult);
      await handle.settled;
    });
    mutationQueue = operation.catch(() => undefined);
    void operation.catch((error: unknown) => {
      resolveResult({
        ok: false,
        error: "Props mutation failed: " + normalizeErrorMessage(error),
      });
    });
    return result;
  }

  async function probe(
    locator?: ElementLocator,
    timeoutMs?: number,
  ): Promise<PropsResult> {
    assertActive();
    let normalizedLocator: ElementLocator | undefined;
    if (locator !== undefined) {
      const candidate = normalizeLocator(locator);
      if (!candidate)
        return Promise.resolve({ ok: false, error: "Invalid element locator" });
      normalizedLocator = candidate;
    }
    const request: PropsProbeRequest = {
      v: PROTOCOL_VERSION,
      requestId: createRequestId(),
      op: "probe",
      ...(normalizedLocator ? { locator: normalizedLocator } : {}),
    };
    return dispatchRequest(request, boundedTimeout(timeoutMs, defaultTimeoutMs))
      .result;
  }

  async function read(
    locator: ElementLocator,
    timeoutMs?: number,
  ): Promise<PropsResult> {
    assertActive();
    const normalizedLocator = normalizeLocator(locator);
    if (!normalizedLocator) {
      return Promise.resolve({ ok: false, error: "Invalid element locator" });
    }
    const request: PropsReadRequest = {
      v: PROTOCOL_VERSION,
      requestId: createRequestId(),
      op: "read",
      locator: normalizedLocator,
    };
    return dispatchRequest(request, boundedTimeout(timeoutMs, defaultTimeoutMs))
      .result;
  }

  async function write(
    locator: ElementLocator,
    path: PropPath,
    value: EditablePropValue,
    timeoutMs?: number,
  ): Promise<PropsResult> {
    assertActive();
    const normalizedLocator = normalizeLocator(locator);
    if (!normalizedLocator) {
      return Promise.resolve({ ok: false, error: "Invalid element locator" });
    }
    const normalizedPath = normalizePropPath(path);
    if (!normalizedPath)
      return Promise.resolve({ ok: false, error: "prop path is required" });
    if (!isEditablePrimitive(value)) {
      return Promise.resolve({
        ok: false,
        error: "Only primitive prop values are supported",
      });
    }
    if (
      typeof value === "string" &&
      utf8ByteLength(value, PROPS_BRIDGE_RESOURCE_LIMITS.maxValueBytes) >
        PROPS_BRIDGE_RESOURCE_LIMITS.maxValueBytes
    ) {
      return Promise.resolve({
        ok: false,
        error: "Prop value exceeds the resource limit",
      });
    }

    return enqueueMutation(
      () => {
        const key = locatorKey(normalizedLocator);
        const pathKey = propPathKey(normalizedPath);
        const expectedTargetGuard = targetGuardForLocator(key);
        const guardState = expectedTargetGuard
          ? originalsByGuard.get(expectedTargetGuard)
          : undefined;
        const alreadyCaptured = guardState?.entries.has(pathKey) === true;
        let stateBudgetBytes = 0;
        if (!alreadyCaptured) {
          if (
            originalEntries >= PROPS_BRIDGE_RESOURCE_LIMITS.maxOriginalEntries
          ) {
            return {
              ok: false,
              error: "Props reset storage entry limit reached",
            };
          }
          stateBudgetBytes = Math.min(
            PROPS_BRIDGE_RESOURCE_LIMITS.maxOriginalBytes - originalBytes,
            PROPS_BRIDGE_RESOURCE_LIMITS.maxOriginalBytesPerLocator,
          );
          if (stateBudgetBytes <= 0) {
            return {
              ok: false,
              error: "Props reset storage byte limit reached",
            };
          }
        }
        return {
          v: PROTOCOL_VERSION,
          requestId: createRequestId(),
          op: "write",
          locator: normalizedLocator,
          payload: {
            propPath: normalizedPath,
            propValue: encodePropValue(value),
            captureOriginal: !alreadyCaptured,
            ...(expectedTargetGuard ? { expectedTargetGuard } : {}),
            stateBudgetBytes,
          },
        };
      },
      boundedTimeout(timeoutMs, defaultTimeoutMs),
    );
  }

  async function reset(
    locator: ElementLocator,
    timeoutMs?: number,
  ): Promise<PropsResult> {
    assertActive();
    const normalizedLocator = normalizeLocator(locator);
    if (!normalizedLocator) {
      return Promise.resolve({ ok: false, error: "Invalid element locator" });
    }

    const key = locatorKey(normalizedLocator);
    const requestTimeoutMs = boundedTimeout(timeoutMs, defaultTimeoutMs);
    let resolveResult!: (result: PropsResult) => void;
    const result = new Promise<PropsResult>((resolve) => {
      resolveResult = resolve;
    });

    const operation = mutationQueue.then(async () => {
      if (lifecycle === "disposed") {
        resolveResult({ ok: false, error: "PropsBridge disposed" });
        return;
      }
      while (true) {
        const guard = targetGuardForLocator(key);
        if (!guard) {
          resolveResult({ ok: true });
          return;
        }
        const guardState = originalsByGuard.get(guard);
        if (!guardState || guardState.entries.size === 0) {
          resolveResult({ ok: true });
          return;
        }

        const requestId = createRequestId();
        const batch: PropsResetOriginalEntry[] = [];
        for (const entry of guardState.entries.values()) {
          const candidate = batch.concat({
            index: batch.length,
            path: entry.path,
            encodedValue: entry.encodedValue,
            existed: entry.existed,
            componentGuard: entry.componentGuard,
          });
          const requestCandidate: PropsResetRequest = {
            v: PROTOCOL_VERSION,
            requestId,
            op: "reset",
            locator: normalizedLocator,
            payload: { originals: candidate },
          };
          if (!normalizePropsRpcRequest(requestCandidate)) break;
          batch.push(candidate[candidate.length - 1]!);
        }
        if (batch.length === 0) {
          resolveResult({
            ok: false,
            error: "Original prop cannot fit a reset request",
          });
          return;
        }

        const before = guardState.entries.size;
        const handle = dispatchRequest(
          {
            v: PROTOCOL_VERSION,
            requestId,
            op: "reset",
            locator: normalizedLocator,
            payload: { originals: batch },
          },
          requestTimeoutMs,
          true,
        );
        const publicResult = handle.result;
        await handle.settled;
        const current = originalsByGuard.get(guard);
        if ((current?.entries.size ?? 0) >= before) {
          resolveResult(await publicResult);
          return;
        }
      }
    });
    mutationQueue = operation.catch(() => undefined);
    void operation.catch((error: unknown) => {
      resolveResult({
        ok: false,
        error: "Props reset failed: " + normalizeErrorMessage(error),
      });
    });
    return result;
  }

  function cleanup(_timeoutMs?: number): Promise<void> {
    if (cleanupPromise) return cleanupPromise;
    if (lifecycle === "disposed") return Promise.resolve();
    lifecycle = "closing";
    cleanupPromise = mutationQueue
      .catch(() => undefined)
      .then(() => {
        lifecycle = "disposed";
        clearPending("PropsBridge disposed");
        clearOriginals();
      });
    return cleanupPromise;
  }

  function dispose(): void {
    void cleanup();
  }

  function isDisposedFn(): boolean {
    return lifecycle !== "active";
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
