import {
  BACKGROUND_MESSAGE_TYPES,
  PRIVILEGED_UI_SURFACES,
} from "@/common/message-types";
import { isExtensionTopFrameSender } from "@/common/runtime-sender-auth";
import { validatePrivilegedUiSurfaceSession } from "../privileged-ui-authorization";
import { executePropsOperationInMain } from "./props-main-runner";

const PROTOCOL_VERSION = 1 as const;

export const WEB_EDITOR_PROPS_RPC_LIMITS = {
  maxDocumentIdBytes: 512,
  maxRequestIdBytes: 128,
  maxRequestBytes: 64 * 1024,
  maxResponseBytes: 256 * 1024,
  maxErrorBytes: 4 * 1024,
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
  maxOriginals: 64,
  maxStateDeltaBytes: 48 * 1024,
  maxComponentGuardBytes: 512,
  maxResponseDepth: 24,
  maxResponseEntries: 512,
  maxResponseValues: 20_000,
  maxResponseValidationMs: 100,
  maxExecutionMs: 30_000,
  maxPerDocumentSessionConcurrency: 8,
  maxGlobalConcurrency: 64,
} as const;

type PropsOperation = "probe" | "read" | "write" | "reset";
type EncodedPropValue = string | number | boolean | null | { $we: "undefined" };
type PropPath = Array<string | number>;

interface NormalizedLocator {
  selectors: string[];
  fingerprint: string;
  path: number[];
  shadowHostChain?: string[];
  frameChain?: string[];
}

interface NormalizedResetOriginal {
  index: number;
  path: PropPath;
  encodedValue: EncodedPropValue;
  existed: boolean;
  componentGuard: string;
}

interface NormalizedPropsRequestBase {
  v: typeof PROTOCOL_VERSION;
  requestId: string;
  op: PropsOperation;
  locator?: NormalizedLocator;
}

interface NormalizedProbeRequest extends NormalizedPropsRequestBase {
  op: "probe";
}

interface NormalizedReadRequest extends NormalizedPropsRequestBase {
  op: "read";
  locator: NormalizedLocator;
}

interface NormalizedWriteRequest extends NormalizedPropsRequestBase {
  op: "write";
  locator: NormalizedLocator;
  payload: {
    propPath: PropPath;
    propValue: EncodedPropValue;
    captureOriginal: boolean;
    expectedTargetGuard?: string;
    stateBudgetBytes: number;
  };
}

interface NormalizedResetRequest extends NormalizedPropsRequestBase {
  op: "reset";
  locator: NormalizedLocator;
  payload: { originals: NormalizedResetOriginal[] };
}

type NormalizedPropsRequest =
  | NormalizedProbeRequest
  | NormalizedReadRequest
  | NormalizedWriteRequest
  | NormalizedResetRequest;

export type WebEditorPropsRpcResponse =
  | { success: true; execution: unknown }
  | { success: false; error: string };

const DANGEROUS_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

let globalInFlight = 0;
const inFlightByDocumentSession = new Map<string, number>();

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

function isDataRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyOwnDataKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  if (keys.length > allowed.size) return false;
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
      return false;
  }
  return true;
}

function jsonByteLength(value: unknown, stopAfter: number): number | null {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") return null;
    return utf8ByteLength(encoded, stopAfter);
  } catch {
    return null;
  }
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
        WEB_EDITOR_PROPS_RPC_LIMITS.maxSelectorBytes,
        false,
      )
    ) {
      return null;
    }
    const selector = item.trim();
    if (!selector || /:has\s*\(/i.test(selector)) return null;
    selectors.push(selector);
  }
  return selectors;
}

function normalizeLocator(value: unknown): NormalizedLocator | null {
  if (
    !isDataRecord(value) ||
    !hasOnlyOwnDataKeys(
      value,
      new Set([
        "selectors",
        "fingerprint",
        "path",
        "shadowHostChain",
        "frameChain",
      ]),
    )
  ) {
    return null;
  }
  const selectors = normalizeSelectorArray(
    value.selectors,
    WEB_EDITOR_PROPS_RPC_LIMITS.maxSelectors,
    true,
  );
  const shadowHostChain = normalizeSelectorArray(
    value.shadowHostChain ?? [],
    WEB_EDITOR_PROPS_RPC_LIMITS.maxLocatorChains,
    false,
  );
  const frameChain = normalizeSelectorArray(
    value.frameChain ?? [],
    WEB_EDITOR_PROPS_RPC_LIMITS.maxLocatorChains,
    false,
  );
  if (!selectors || !shadowHostChain || !frameChain || frameChain.length > 0)
    return null;
  if (
    !isBoundedString(
      value.fingerprint,
      WEB_EDITOR_PROPS_RPC_LIMITS.maxFingerprintBytes,
    ) ||
    !Array.isArray(value.path) ||
    value.path.length > WEB_EDITOR_PROPS_RPC_LIMITS.maxLocatorPath
  ) {
    return null;
  }
  const path: number[] = [];
  for (const item of value.path) {
    if (
      !Number.isSafeInteger(item) ||
      (item as number) < 0 ||
      (item as number) > WEB_EDITOR_PROPS_RPC_LIMITS.maxLocatorIndex
    ) {
      return null;
    }
    path.push(item as number);
  }
  return {
    selectors,
    fingerprint: value.fingerprint,
    path,
    ...(shadowHostChain.length > 0 ? { shadowHostChain } : {}),
    ...(frameChain.length > 0 ? { frameChain } : {}),
  };
}

function normalizePropPath(value: unknown): PropPath | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > WEB_EDITOR_PROPS_RPC_LIMITS.maxPropPath
  ) {
    return null;
  }
  const path: PropPath = [];
  let bytes = 0;
  for (const segment of value) {
    if (typeof segment === "string") {
      const normalized = segment.trim();
      if (
        !isBoundedString(
          normalized,
          WEB_EDITOR_PROPS_RPC_LIMITS.maxPropSegmentBytes,
          false,
        ) ||
        DANGEROUS_KEYS.has(normalized)
      ) {
        return null;
      }
      bytes += utf8ByteLength(normalized);
      if (bytes > WEB_EDITOR_PROPS_RPC_LIMITS.maxPropPathBytes) return null;
      path.push(normalized);
      continue;
    }
    if (
      !Number.isSafeInteger(segment) ||
      (segment as number) < 0 ||
      (segment as number) > WEB_EDITOR_PROPS_RPC_LIMITS.maxLocatorIndex
    ) {
      return null;
    }
    path.push(segment as number);
  }
  return path;
}

function normalizeEncodedPropValue(
  value: unknown,
  maxStringBytes = WEB_EDITOR_PROPS_RPC_LIMITS.maxValueBytes,
): { value: EncodedPropValue } | null {
  if (value === null || typeof value === "boolean") return { value };
  if (typeof value === "number") {
    return Number.isFinite(value) ? { value } : null;
  }
  if (typeof value === "string") {
    return utf8ByteLength(value, maxStringBytes) <= maxStringBytes
      ? { value }
      : null;
  }
  if (
    isDataRecord(value) &&
    hasOnlyOwnDataKeys(value, new Set(["$we"])) &&
    value.$we === "undefined"
  ) {
    return { value: { $we: "undefined" } };
  }
  return null;
}

/** Strictly copies a content-script request into the bounded MAIN-world wire format. */
export function normalizeWebEditorPropsRequest(
  value: unknown,
): NormalizedPropsRequest | null {
  if (
    !isDataRecord(value) ||
    !hasOnlyOwnDataKeys(
      value,
      new Set(["v", "requestId", "op", "locator", "payload"]),
    ) ||
    value.v !== PROTOCOL_VERSION ||
    (value.op !== "probe" &&
      value.op !== "read" &&
      value.op !== "write" &&
      value.op !== "reset") ||
    !isBoundedString(
      value.requestId,
      WEB_EDITOR_PROPS_RPC_LIMITS.maxRequestIdBytes,
      false,
    )
  ) {
    return null;
  }

  const op = value.op;
  const locator =
    value.locator === undefined ? undefined : normalizeLocator(value.locator);
  if (value.locator !== undefined && !locator) return null;
  if ((op === "read" || op === "write" || op === "reset") && !locator) {
    return null;
  }

  let normalized: NormalizedPropsRequest;
  if (op === "probe") {
    if (value.payload !== undefined) return null;
    normalized = {
      v: PROTOCOL_VERSION,
      requestId: value.requestId,
      op,
      ...(locator ? { locator } : {}),
    };
  } else if (op === "read") {
    if (value.payload !== undefined) return null;
    normalized = {
      v: PROTOCOL_VERSION,
      requestId: value.requestId,
      op,
      locator: locator as NormalizedLocator,
    };
  } else if (op === "write") {
    if (
      !isDataRecord(value.payload) ||
      !hasOnlyOwnDataKeys(
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
          WEB_EDITOR_PROPS_RPC_LIMITS.maxComponentGuardBytes,
          false,
        )) ||
      (!captureOriginal && expectedTargetGuard === undefined) ||
      !Number.isSafeInteger(stateBudgetBytes) ||
      (stateBudgetBytes as number) < 0 ||
      (stateBudgetBytes as number) >
        WEB_EDITOR_PROPS_RPC_LIMITS.maxStateDeltaBytes ||
      (captureOriginal
        ? (stateBudgetBytes as number) === 0
        : (stateBudgetBytes as number) !== 0)
    ) {
      return null;
    }
    normalized = {
      v: PROTOCOL_VERSION,
      requestId: value.requestId,
      op,
      locator: locator as NormalizedLocator,
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
      !isDataRecord(value.payload) ||
      !hasOnlyOwnDataKeys(value.payload, new Set(["originals"])) ||
      !Array.isArray(value.payload.originals) ||
      value.payload.originals.length === 0 ||
      value.payload.originals.length > WEB_EDITOR_PROPS_RPC_LIMITS.maxOriginals
    ) {
      return null;
    }
    const originals: NormalizedResetOriginal[] = [];
    const indexes = new Set<number>();
    for (const candidate of value.payload.originals) {
      if (
        !isDataRecord(candidate) ||
        !hasOnlyOwnDataKeys(
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
        WEB_EDITOR_PROPS_RPC_LIMITS.maxStateDeltaBytes,
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
          WEB_EDITOR_PROPS_RPC_LIMITS.maxComponentGuardBytes,
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
      requestId: value.requestId,
      op,
      locator: locator as NormalizedLocator,
      payload: { originals },
    };
  }

  const bytes = jsonByteLength(
    normalized,
    WEB_EDITOR_PROPS_RPC_LIMITS.maxRequestBytes,
  );
  return bytes !== null && bytes <= WEB_EDITOR_PROPS_RPC_LIMITS.maxRequestBytes
    ? normalized
    : null;
}

interface JsonCloneState {
  values: number;
  bytes: number;
  deadline: number;
  seen: WeakSet<object>;
}

type JsonCloneResult =
  | { valid: true; value: unknown }
  | { valid: false; value?: never };

function cloneBoundedJson(
  value: unknown,
  state: JsonCloneState,
  depth = 0,
): JsonCloneResult {
  if (
    Date.now() > state.deadline ||
    depth > WEB_EDITOR_PROPS_RPC_LIMITS.maxResponseDepth ||
    state.values >= WEB_EDITOR_PROPS_RPC_LIMITS.maxResponseValues
  ) {
    return { valid: false };
  }
  state.values += 1;
  state.bytes += 16;
  if (state.bytes > WEB_EDITOR_PROPS_RPC_LIMITS.maxResponseBytes) {
    return { valid: false };
  }
  if (value === null || typeof value === "boolean") {
    return { valid: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? { valid: true, value } : { valid: false };
  }
  if (typeof value === "string") {
    state.bytes += utf8ByteLength(
      value,
      WEB_EDITOR_PROPS_RPC_LIMITS.maxResponseBytes - state.bytes,
    );
    return state.bytes <= WEB_EDITOR_PROPS_RPC_LIMITS.maxResponseBytes
      ? { valid: true, value }
      : { valid: false };
  }
  if (typeof value !== "object" || value === null || state.seen.has(value)) {
    return { valid: false };
  }
  state.seen.add(value);

  if (Array.isArray(value)) {
    if (value.length > WEB_EDITOR_PROPS_RPC_LIMITS.maxResponseEntries) {
      return { valid: false };
    }
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return { valid: false };
      const cloned = cloneBoundedJson(descriptor.value, state, depth + 1);
      if (!cloned.valid) return cloned;
      result.push(cloned.value);
    }
    return { valid: true, value: result };
  }

  if (!isDataRecord(value)) return { valid: false };
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return { valid: false };
  }
  if (keys.length > WEB_EDITOR_PROPS_RPC_LIMITS.maxResponseEntries) {
    return { valid: false };
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (
      typeof key !== "string" ||
      DANGEROUS_KEYS.has(key) ||
      !isBoundedString(
        key,
        WEB_EDITOR_PROPS_RPC_LIMITS.maxPropSegmentBytes,
        false,
      )
    ) {
      return { valid: false };
    }
    state.bytes += utf8ByteLength(
      key,
      WEB_EDITOR_PROPS_RPC_LIMITS.maxResponseBytes - state.bytes,
    );
    if (state.bytes > WEB_EDITOR_PROPS_RPC_LIMITS.maxResponseBytes) {
      return { valid: false };
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      return { valid: false };
    }
    const cloned = cloneBoundedJson(descriptor.value, state, depth + 1);
    if (!cloned.valid) return cloned;
    result[key] = cloned.value;
  }
  return { valid: true, value: result };
}

function normalizeExecutionEnvelope(
  value: unknown,
  request: NormalizedPropsRequest,
): unknown | null {
  if (
    !isDataRecord(value) ||
    !hasOnlyOwnDataKeys(value, new Set(["response", "targetGuard", "stateDelta"])) ||
    !isDataRecord(value.response) ||
    !hasOnlyOwnDataKeys(
      value.response,
      new Set(["v", "requestId", "success", "data", "error"]),
    ) ||
    value.response.v !== PROTOCOL_VERSION ||
    value.response.requestId !== request.requestId ||
    typeof value.response.success !== "boolean"
  ) {
    return null;
  }

  const response: Record<string, unknown> = {
    v: PROTOCOL_VERSION,
    requestId: request.requestId,
    success: value.response.success,
  };
  const targetGuard =
    value.targetGuard === undefined
      ? undefined
      : isBoundedString(
            value.targetGuard,
            WEB_EDITOR_PROPS_RPC_LIMITS.maxComponentGuardBytes,
            false,
          )
        ? value.targetGuard
        : null;
  if (targetGuard === null) return null;
  if (value.response.data !== undefined) {
    if (!isDataRecord(value.response.data)) return null;
    const cloned = cloneBoundedJson(value.response.data, {
      values: 0,
      bytes: 0,
      deadline:
        Date.now() + WEB_EDITOR_PROPS_RPC_LIMITS.maxResponseValidationMs,
      seen: new WeakSet(),
    });
    if (!cloned.valid || !isDataRecord(cloned.value)) return null;
    response.data = cloned.value;
  }
  if (value.response.error !== undefined) {
    if (
      !isBoundedString(
        value.response.error,
        WEB_EDITOR_PROPS_RPC_LIMITS.maxErrorBytes,
      )
    ) {
      return null;
    }
    response.error = value.response.error;
  }

  let stateDelta: Record<string, unknown> | undefined;
  if (value.stateDelta !== undefined) {
    if (!isDataRecord(value.stateDelta)) return null;
    if (
      request.op === "write" &&
      request.payload.captureOriginal &&
      value.stateDelta.kind === "write_original" &&
      hasOnlyOwnDataKeys(
        value.stateDelta,
        new Set(["kind", "path", "encodedValue", "existed", "componentGuard"]),
      )
    ) {
      const path = normalizePropPath(value.stateDelta.path);
      const encodedValue = normalizeEncodedPropValue(
        value.stateDelta.encodedValue,
        WEB_EDITOR_PROPS_RPC_LIMITS.maxStateDeltaBytes,
      );
      if (
        !path ||
        JSON.stringify(path) !== JSON.stringify(request.payload.propPath) ||
        encodedValue === null ||
        typeof value.stateDelta.existed !== "boolean" ||
        !isBoundedString(
          value.stateDelta.componentGuard,
          WEB_EDITOR_PROPS_RPC_LIMITS.maxComponentGuardBytes,
          false,
        ) ||
        value.stateDelta.componentGuard !== targetGuard
      ) {
        return null;
      }
      stateDelta = {
        kind: "write_original",
        path,
        encodedValue: encodedValue.value,
        existed: value.stateDelta.existed,
        componentGuard: value.stateDelta.componentGuard,
      };
      const deltaBytes = jsonByteLength(
        stateDelta,
        request.payload.stateBudgetBytes,
      );
      if (
        deltaBytes === null ||
        deltaBytes > request.payload.stateBudgetBytes
      ) {
        return null;
      }
    } else if (
      request.op === "reset" &&
      value.stateDelta.kind === "reset_result" &&
      hasOnlyOwnDataKeys(
        value.stateDelta,
        new Set(["kind", "appliedIndexes", "guardMismatch"]),
      ) &&
      Array.isArray(value.stateDelta.appliedIndexes) &&
      value.stateDelta.appliedIndexes.length <=
        request.payload.originals.length &&
      typeof value.stateDelta.guardMismatch === "boolean"
    ) {
      const allowedIndexes = new Set(
        request.payload.originals.map((entry) => entry.index),
      );
      const indexes = new Set<number>();
      const appliedIndexes: number[] = [];
      for (const index of value.stateDelta.appliedIndexes) {
        if (
          !Number.isSafeInteger(index) ||
          !allowedIndexes.has(index as number) ||
          indexes.has(index as number)
        ) {
          return null;
        }
        indexes.add(index as number);
        appliedIndexes.push(index as number);
      }
      if (value.stateDelta.guardMismatch && appliedIndexes.length > 0) {
        return null;
      }
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
    response.success === true &&
    !stateDelta
  ) {
    return null;
  }

  if (
    request.op === "write" &&
    request.payload.expectedTargetGuard !== undefined &&
    response.success === true &&
    targetGuard !== request.payload.expectedTargetGuard
  ) {
    return null;
  }
  if (
    request.op === "reset" &&
    stateDelta?.kind === "reset_result" &&
    stateDelta.guardMismatch === false &&
    targetGuard !== request.payload.originals[0]?.componentGuard
  ) {
    return null;
  }
  if (request.op !== "probe" && response.success === true && !targetGuard) {
    return null;
  }

  const envelope = {
    response,
    ...(targetGuard ? { targetGuard } : {}),
    ...(stateDelta ? { stateDelta } : {}),
  };
  const bytes = jsonByteLength(
    envelope,
    WEB_EDITOR_PROPS_RPC_LIMITS.maxResponseBytes,
  );
  return bytes !== null && bytes <= WEB_EDITOR_PROPS_RPC_LIMITS.maxResponseBytes
    ? envelope
    : null;
}

function normalizeMessage(value: unknown): {
  surfaceSessionId: string;
  request: NormalizedPropsRequest;
} | null {
  if (
    !isDataRecord(value) ||
    !hasOnlyOwnDataKeys(
      value,
      new Set(["type", "surfaceSessionId", "request"]),
    ) ||
    value.type !== BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_PROPS_EXECUTE ||
    typeof value.surfaceSessionId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.surfaceSessionId)
  ) {
    return null;
  }
  const request = normalizeWebEditorPropsRequest(value.request);
  return request ? { surfaceSessionId: value.surfaceSessionId, request } : null;
}

function normalizeSender(sender: chrome.runtime.MessageSender): {
  tabId: number;
  documentId: string;
} | null {
  const documentId = sender.documentId;
  if (
    !isExtensionTopFrameSender(sender) ||
    !isBoundedString(
      documentId,
      WEB_EDITOR_PROPS_RPC_LIMITS.maxDocumentIdBytes,
      false,
    ) ||
    (sender.documentLifecycle !== undefined &&
      sender.documentLifecycle !== "active")
  ) {
    return null;
  }
  return { tabId: sender.tab.id, documentId };
}

function acquireQuota(key: string): boolean {
  const documentSessionInFlight = inFlightByDocumentSession.get(key) ?? 0;
  if (
    globalInFlight >= WEB_EDITOR_PROPS_RPC_LIMITS.maxGlobalConcurrency ||
    documentSessionInFlight >=
      WEB_EDITOR_PROPS_RPC_LIMITS.maxPerDocumentSessionConcurrency
  ) {
    return false;
  }
  globalInFlight += 1;
  inFlightByDocumentSession.set(key, documentSessionInFlight + 1);
  return true;
}

function releaseQuota(key: string): void {
  globalInFlight = Math.max(0, globalInFlight - 1);
  const documentSessionInFlight = inFlightByDocumentSession.get(key) ?? 0;
  if (documentSessionInFlight <= 1) inFlightByDocumentSession.delete(key);
  else inFlightByDocumentSession.set(key, documentSessionInFlight - 1);
}

/** Authenticate and execute one Web Editor props operation in the sender document. */
export async function executeWebEditorPropsRpc(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<WebEditorPropsRpcResponse> {
  const scope = normalizeSender(sender);
  if (!scope) {
    return {
      success: false,
      error: "Web Editor props requests require an active top-frame document.",
    };
  }
  const normalized = normalizeMessage(message);
  if (!normalized) {
    return { success: false, error: "Invalid Web Editor props request." };
  }

  const quotaKey = `${scope.tabId}\u0000${scope.documentId}\u0000${normalized.surfaceSessionId}`;
  if (!acquireQuota(quotaKey)) {
    return {
      success: false,
      error: "Too many pending Web Editor props requests.",
    };
  }

  let releaseAfterExecutionSettles = false;
  try {
    let active = false;
    try {
      active = await validatePrivilegedUiSurfaceSession(
        PRIVILEGED_UI_SURFACES.WEB_EDITOR,
        normalized.surfaceSessionId,
        sender,
      );
    } catch {
      active = false;
    }
    if (!active) {
      return {
        success: false,
        error: "Web Editor surface session is missing or expired.",
      };
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const executionPromise = chrome.scripting.executeScript({
      target: {
        tabId: scope.tabId,
        documentIds: [scope.documentId],
      },
      world: "MAIN",
      func: executePropsOperationInMain,
      args: [normalized.request],
    });
    let injections: Awaited<typeof executionPromise>;
    if (normalized.request.op === "write" || normalized.request.op === "reset") {
      // Mutations cannot be cancelled. Keep the runtime port, quota, and the
      // isolated bridge's mutation queue tied to the real executionPromise so
      // a late write can never overtake a later write/reset or lose its delta.
      injections = await executionPromise;
    } else {
      let executionTimedOut = false;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(
          () => {
            executionTimedOut = true;
            reject(new Error("Props execution timed out"));
          },
          WEB_EDITOR_PROPS_RPC_LIMITS.maxExecutionMs,
        );
      });
      try {
        injections = await Promise.race([executionPromise, timeoutPromise]);
      } catch (error) {
        if (executionTimedOut) {
          // executeScript cannot be cancelled. Keep the quota reserved until
          // the underlying read/probe really settles.
          releaseAfterExecutionSettles = true;
          void executionPromise
            .catch(() => undefined)
            .finally(() => releaseQuota(quotaKey));
        }
        throw error;
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    }
    if (!Array.isArray(injections) || injections.length !== 1) {
      return { success: false, error: "Props execution target changed." };
    }
    const injection = injections[0];
    if (
      !injection ||
      injection.frameId !== 0 ||
      injection.documentId !== scope.documentId
    ) {
      return { success: false, error: "Props execution target changed." };
    }
    const execution = normalizeExecutionEnvelope(
      injection.result,
      normalized.request,
    );
    if (!execution) {
      return { success: false, error: "Invalid props execution response." };
    }
    return { success: true, execution };
  } catch {
    return {
      success: false,
      error: "Unable to execute props in this document.",
    };
  } finally {
    if (!releaseAfterExecutionSettles) releaseQuota(quotaKey);
  }
}
