/**
 * Hard resource limits shared by one-shot and persistent console capture.
 *
 * CDP events are controlled by the inspected page, so every value is bounded
 * before it is retained. Limits are expressed in UTF-8/JSON bytes rather than
 * JavaScript string length to match the size of the eventual tool payload.
 */

export const CONSOLE_MAX_MESSAGES = 500;
export const CONSOLE_MAX_EXCEPTIONS = 100;
export const CONSOLE_SNAPSHOT_MAX_EVENTS = 2_000;

export const CONSOLE_BUFFER_MAX_MESSAGES = 2_000;
export const CONSOLE_BUFFER_MAX_EXCEPTIONS = 500;
export const CONSOLE_BUFFER_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const CONSOLE_BUFFER_MAX_EXCEPTION_BYTES = 512 * 1024;
export const CONSOLE_SNAPSHOT_MAX_MESSAGE_BYTES = 512 * 1024;
export const CONSOLE_SNAPSHOT_MAX_EXCEPTION_BYTES = 256 * 1024;

export const CONSOLE_TEXT_MAX_UTF8_BYTES = 16 * 1024;
export const CONSOLE_ARG_MAX_ITEMS = 32;
export const CONSOLE_ARGS_MAX_UTF8_BYTES = 32 * 1024;
export const CONSOLE_VALUE_MAX_UTF8_BYTES = 8 * 1024;
export const CONSOLE_DESCRIPTION_MAX_UTF8_BYTES = 8 * 1024;
export const CONSOLE_STACK_MAX_UTF8_BYTES = 32 * 1024;
export const CONSOLE_URL_MAX_UTF8_BYTES = 4 * 1024;
export const CONSOLE_TITLE_MAX_UTF8_BYTES = 2 * 1024;
export const CONSOLE_METADATA_MAX_UTF8_BYTES = 256;

const STRUCTURED_MAX_DEPTH = 4;
const STRUCTURED_MAX_ENTRIES = 32;
const STRUCTURED_MAX_NODES = 128;
const TRUNCATED_SUFFIX = '…[truncated]';

export interface BoundedConsoleMessage {
  timestamp: number;
  level: string;
  text: string;
  args?: unknown[];
  source?: string;
  url?: string;
  lineNumber?: number;
  stackTrace?: unknown;
}

export interface BoundedConsoleException {
  timestamp: number;
  text: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  stackTrace?: unknown;
}

export interface StoredByteRingEntry<T> {
  value: T;
  byteSize: number;
}

export interface ByteRingState<T> {
  entries: Array<StoredByteRingEntry<T> | undefined>;
  head: number;
  byteSize: number;
  droppedCount: number;
}

function utf8CodePointBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function measureConsoleUtf8Bytes(
  value: string,
  stopAfter = Number.MAX_SAFE_INTEGER,
): number {
  let bytes = 0;
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index) ?? 0;
    bytes += utf8CodePointBytes(codePoint);
    if (bytes > stopAfter) return bytes;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return bytes;
}

export function truncateConsoleUtf8(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || maxBytes <= 0) return '';

  const suffixBytes = measureConsoleUtf8Bytes(TRUNCATED_SUFFIX);
  const contentBudget = Math.max(0, maxBytes - suffixBytes);
  let bytes = 0;
  let index = 0;

  while (index < value.length) {
    const codePoint = value.codePointAt(index) ?? 0;
    const nextBytes = utf8CodePointBytes(codePoint);
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    index += codePoint > 0xffff ? 2 : 1;
  }

  if (index === value.length) return value;

  bytes = 0;
  index = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index) ?? 0;
    const nextBytes = utf8CodePointBytes(codePoint);
    if (bytes + nextBytes > contentBudget) break;
    bytes += nextBytes;
    index += codePoint > 0xffff ? 2 : 1;
  }

  if (suffixBytes > maxBytes) {
    let suffixIndex = 0;
    let usedBytes = 0;
    while (suffixIndex < TRUNCATED_SUFFIX.length) {
      const codePoint = TRUNCATED_SUFFIX.codePointAt(suffixIndex) ?? 0;
      const nextBytes = utf8CodePointBytes(codePoint);
      if (usedBytes + nextBytes > maxBytes) break;
      usedBytes += nextBytes;
      suffixIndex += codePoint > 0xffff ? 2 : 1;
    }
    return TRUNCATED_SUFFIX.slice(0, suffixIndex);
  }
  return value.slice(0, index) + TRUNCATED_SUFFIX;
}

export function measureConsoleJsonBytes(value: unknown): number {
  try {
    return measureConsoleUtf8Bytes(JSON.stringify(value) ?? 'null');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function truncateConsoleJsonString(
  value: unknown,
  maxBytes: number,
): string {
  if (typeof value !== 'string' || maxBytes <= 2) return '';
  let contentBudget = maxBytes - 2;
  while (contentBudget > 0) {
    const candidate = truncateConsoleUtf8(value, contentBudget);
    if (measureConsoleJsonBytes(candidate) <= maxBytes) return candidate;
    contentBudget = Math.floor(contentBudget * 0.75);
  }
  return '';
}

function safeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function safeTimestamp(value: unknown, now: () => number): number {
  return safeFiniteNumber(value) ?? now();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

interface StructuredBudget {
  nodesRemaining: number;
  stringBytesRemaining: number;
  seen: WeakSet<object>;
}

function takeBudgetedString(
  value: unknown,
  perFieldMaxBytes: number,
  budget: StructuredBudget,
): string {
  if (typeof value !== 'string' || budget.stringBytesRemaining <= 0) return '';
  const bounded = truncateConsoleUtf8(
    value,
    Math.min(perFieldMaxBytes, budget.stringBytesRemaining),
  );
  budget.stringBytesRemaining = Math.max(
    0,
    budget.stringBytesRemaining - measureConsoleUtf8Bytes(bounded),
  );
  return bounded;
}

function sanitizeStructuredValue(
  value: unknown,
  budget: StructuredBudget,
  depth = 0,
): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') {
    return takeBudgetedString(value, CONSOLE_VALUE_MAX_UTF8_BYTES, budget);
  }
  if (typeof value === 'bigint') {
    return '[bigint]';
  }
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return '[symbol]';
  if (typeof value !== 'object') return '[unknown]';
  if (depth >= STRUCTURED_MAX_DEPTH) return '[MaxDepth]';
  if (budget.nodesRemaining <= 0) return '[NodeLimit]';
  if (budget.seen.has(value)) return '[Circular]';

  budget.nodesRemaining -= 1;
  budget.seen.add(value);

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    const length = Math.min(value.length, STRUCTURED_MAX_ENTRIES);
    for (
      let index = 0;
      index < length && budget.nodesRemaining > 0;
      index += 1
    ) {
      let child: unknown;
      try {
        child = value[index];
      } catch {
        child = '[Thrown]';
      }
      result.push(sanitizeStructuredValue(child, budget, depth + 1));
    }
    if (value.length > length) result.push('[ItemsTruncated]');
    return result;
  }

  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  let entryCount = 0;
  try {
    for (const rawKey in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, rawKey)) continue;
      if (entryCount >= STRUCTURED_MAX_ENTRIES || budget.nodesRemaining <= 0) {
        result.__truncated__ = true;
        break;
      }
      if (
        rawKey === '__proto__' ||
        rawKey === 'prototype' ||
        rawKey === 'constructor'
      )
        continue;
      const key = takeBudgetedString(
        rawKey,
        CONSOLE_METADATA_MAX_UTF8_BYTES,
        budget,
      );
      if (!key) continue;
      let child: unknown;
      try {
        child = (value as Record<string, unknown>)[rawKey];
      } catch {
        child = '[Thrown]';
      }
      result[key] = sanitizeStructuredValue(child, budget, depth + 1);
      entryCount += 1;
    }
  } catch {
    result.__unserializable__ = true;
  }
  return result;
}

function fitStructuredValue(value: unknown, maxBytes: number): unknown {
  if (measureConsoleJsonBytes(value) <= maxBytes) return value;

  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? 'null';
  } catch {
    serialized = '[Unserializable]';
  }

  let previewBudget = Math.max(0, maxBytes - 64);
  while (previewBudget > 0) {
    const candidate = {
      truncated: true,
      preview: truncateConsoleUtf8(serialized, previewBudget),
    };
    if (measureConsoleJsonBytes(candidate) <= maxBytes) return candidate;
    previewBudget = Math.floor(previewBudget * 0.75);
  }
  return '[Truncated]';
}

function sanitizeBoundedStructuredValue(
  value: unknown,
  maxBytes: number,
  includeTruncatedPreview = true,
): unknown {
  const budget: StructuredBudget = {
    nodesRemaining: STRUCTURED_MAX_NODES,
    stringBytesRemaining: maxBytes,
    seen: new WeakSet<object>(),
  };
  const sanitized = sanitizeStructuredValue(value, budget);
  if (
    !includeTruncatedPreview &&
    measureConsoleJsonBytes(sanitized) > maxBytes
  ) {
    return { truncated: true };
  }
  return fitStructuredValue(sanitized, maxBytes);
}

function sanitizeRemoteObject(arg: unknown): unknown {
  const record = asRecord(arg);
  if (!record) {
    return {
      type: truncateConsoleJsonString(
        typeof arg,
        CONSOLE_METADATA_MAX_UTF8_BYTES,
      ),
      value: sanitizeBoundedStructuredValue(arg, CONSOLE_VALUE_MAX_UTF8_BYTES),
    };
  }

  const preview: Record<string, unknown> = {};
  if (typeof record.type === 'string') {
    preview.type = truncateConsoleJsonString(
      record.type,
      CONSOLE_METADATA_MAX_UTF8_BYTES,
    );
  }
  if (typeof record.subtype === 'string') {
    preview.subtype = truncateConsoleJsonString(
      record.subtype,
      CONSOLE_METADATA_MAX_UTF8_BYTES,
    );
  }
  if (typeof record.className === 'string') {
    preview.className = truncateConsoleJsonString(
      record.className,
      CONSOLE_METADATA_MAX_UTF8_BYTES,
    );
  }
  if (typeof record.description === 'string') {
    preview.description = truncateConsoleJsonString(
      record.description,
      CONSOLE_DESCRIPTION_MAX_UTF8_BYTES,
    );
  }
  if (typeof record.unserializableValue === 'string') {
    preview.unserializableValue = truncateConsoleJsonString(
      record.unserializableValue,
      CONSOLE_VALUE_MAX_UTF8_BYTES,
    );
  }
  if (Object.prototype.hasOwnProperty.call(record, 'value')) {
    preview.value = sanitizeBoundedStructuredValue(
      record.value,
      CONSOLE_VALUE_MAX_UTF8_BYTES,
    );
  }
  return preview;
}

export function sanitizeConsoleArgs(args: unknown): unknown[] {
  if (!Array.isArray(args)) return [];

  const result: unknown[] = [];
  const length = Math.min(args.length, CONSOLE_ARG_MAX_ITEMS);
  for (let index = 0; index < length; index += 1) {
    const next = sanitizeRemoteObject(args[index]);
    const candidate = [...result, next];
    if (measureConsoleJsonBytes(candidate) > CONSOLE_ARGS_MAX_UTF8_BYTES) break;
    result.push(next);
  }

  if (args.length > result.length) {
    const marker = { type: 'truncated', description: '[ArgumentsTruncated]' };
    const candidate = [...result, marker];
    if (measureConsoleJsonBytes(candidate) <= CONSOLE_ARGS_MAX_UTF8_BYTES) {
      result.push(marker);
    }
  }
  return result;
}

function formatBoundedConsoleArgs(args: unknown[]): string {
  const parts = args.map((arg) => {
    const record = asRecord(arg);
    if (!record) return '';
    if (record.type === 'undefined') return 'undefined';
    if (record.type === 'string' && typeof record.value === 'string')
      return record.value;
    if (
      (record.type === 'number' || record.type === 'boolean') &&
      (typeof record.value === 'number' || typeof record.value === 'boolean')
    ) {
      return String(record.value);
    }
    if (typeof record.description === 'string') return record.description;
    if (typeof record.unserializableValue === 'string')
      return record.unserializableValue;
    if (typeof record.value === 'string') return record.value;
    if (record.type === 'object') return '[Object]';
    if (record.type === 'function') return '[Function]';
    return '';
  });
  return truncateConsoleJsonString(
    parts.filter(Boolean).join(' '),
    CONSOLE_TEXT_MAX_UTF8_BYTES,
  );
}

export function sanitizeConsoleStack(stackTrace: unknown): unknown {
  if (stackTrace === undefined || stackTrace === null) return undefined;
  return sanitizeBoundedStructuredValue(
    stackTrace,
    CONSOLE_STACK_MAX_UTF8_BYTES,
    false,
  );
}

export function sanitizeConsoleMessageInput(
  input: unknown,
  now: () => number = Date.now,
): BoundedConsoleMessage {
  const record = asRecord(input) ?? {};
  const args = sanitizeConsoleArgs(record.args);
  const rawText = typeof record.text === 'string' ? record.text : '';
  const message: BoundedConsoleMessage = {
    timestamp: safeTimestamp(record.timestamp, now),
    level:
      truncateConsoleJsonString(
        record.level,
        CONSOLE_METADATA_MAX_UTF8_BYTES,
      ) ||
      'log',
    text: truncateConsoleJsonString(
      rawText || formatBoundedConsoleArgs(args),
      CONSOLE_TEXT_MAX_UTF8_BYTES,
    ),
  };

  const source = truncateConsoleJsonString(
    record.source,
    CONSOLE_METADATA_MAX_UTF8_BYTES,
  );
  const url = truncateConsoleJsonString(
    record.url,
    CONSOLE_URL_MAX_UTF8_BYTES,
  );
  const lineNumber = safeFiniteNumber(record.lineNumber);
  const stackTrace = sanitizeConsoleStack(record.stackTrace);
  if (source) message.source = source;
  if (url) message.url = url;
  if (lineNumber !== undefined) message.lineNumber = lineNumber;
  if (stackTrace !== undefined) message.stackTrace = stackTrace;
  if (args.length > 0) message.args = args;
  return message;
}

export function sanitizeRuntimeConsoleEvent(
  params: unknown,
  now: () => number = Date.now,
): BoundedConsoleMessage {
  const record = asRecord(params) ?? {};
  const stackTrace = asRecord(record.stackTrace);
  const callFrames = Array.isArray(stackTrace?.callFrames)
    ? stackTrace.callFrames
    : [];
  const firstFrame = asRecord(callFrames[0]);
  return sanitizeConsoleMessageInput(
    {
      timestamp: record.timestamp,
      level: record.type,
      text: '',
      source: 'console-api',
      url: firstFrame?.url,
      lineNumber: firstFrame?.lineNumber,
      stackTrace: record.stackTrace,
      args: record.args,
    },
    now,
  );
}

export function sanitizeConsoleExceptionInput(
  input: unknown,
  now: () => number = Date.now,
): BoundedConsoleException {
  const record = asRecord(input) ?? {};
  const exception = asRecord(record.exception);
  const rawText =
    (typeof record.text === 'string' && record.text) ||
    (typeof exception?.description === 'string' && exception.description) ||
    'Unknown exception';
  const result: BoundedConsoleException = {
    timestamp: safeTimestamp(record.timestamp, now),
    text: truncateConsoleJsonString(rawText, CONSOLE_TEXT_MAX_UTF8_BYTES),
  };
  const url = truncateConsoleJsonString(
    record.url,
    CONSOLE_URL_MAX_UTF8_BYTES,
  );
  const lineNumber = safeFiniteNumber(record.lineNumber);
  const columnNumber = safeFiniteNumber(record.columnNumber);
  const stackTrace = sanitizeConsoleStack(record.stackTrace);
  if (url) result.url = url;
  if (lineNumber !== undefined) result.lineNumber = lineNumber;
  if (columnNumber !== undefined) result.columnNumber = columnNumber;
  if (stackTrace !== undefined) result.stackTrace = stackTrace;
  return result;
}

export function appendToByteRing<T>(
  ring: ByteRingState<T>,
  value: T,
  maxEntries: number,
  maxBytes: number,
): boolean {
  const byteSize = measureConsoleJsonBytes(value);
  if (byteSize > maxBytes || maxEntries <= 0) {
    ring.droppedCount += 1;
    return false;
  }

  ring.entries.push({ value, byteSize });
  ring.byteSize += byteSize;
  while (
    ring.entries.length - ring.head > maxEntries ||
    ring.byteSize > maxBytes
  ) {
    const removed = ring.entries[ring.head];
    if (!removed) break;
    // Release the evicted payload immediately; compaction is only an
    // amortized array bookkeeping optimization.
    ring.entries[ring.head] = undefined;
    ring.head += 1;
    ring.byteSize = Math.max(0, ring.byteSize - removed.byteSize);
    ring.droppedCount += 1;
  }
  if (ring.head >= 1_024 && ring.head * 2 >= ring.entries.length) {
    ring.entries.splice(0, ring.head);
    ring.head = 0;
  }
  return true;
}

export function getByteRingValues<T>(ring: ByteRingState<T>): T[] {
  const values: T[] = [];
  for (let index = ring.head; index < ring.entries.length; index += 1) {
    const entry = ring.entries[index];
    if (entry) values.push(entry.value);
  }
  return values;
}

export function getByteRingLength<T>(ring: ByteRingState<T>): number {
  return ring.entries.length - ring.head;
}
