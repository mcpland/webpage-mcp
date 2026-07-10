export const NETWORK_CAPTURE_LIMITS = Object.freeze({
  maxTabs: 8,
  maxLineageDepth: 2,
  maxUrlBytes: 8 * 1024,
  maxMethodBytes: 32,
  maxTypeBytes: 128,
  maxStatusTextBytes: 1 * 1024,
  maxErrorBytes: 4 * 1024,
  maxMimeTypeBytes: 256,
  maxHeaderEntries: 64,
  maxHeaderNameBytes: 256,
  maxHeaderValueBytes: 8 * 1024,
  maxHeadersBytes: 64 * 1024,
  maxRequestBodyBytes: 64 * 1024,
  maxResponseBodyBytes: 512 * 1024,
  maxResponseBodiesBytes: 2 * 1024 * 1024,
  maxCaptureBytes: 4 * 1024 * 1024,
  maxCompletedResults: 4,
  maxPendingResponseBodies: 8,
  minCaptureTimeMs: 1_000,
  maxCaptureTimeMs: 10 * 60 * 1_000,
  defaultCaptureTimeMs: 3 * 60 * 1_000,
  minInactivityMs: 1_000,
  maxInactivityMs: 5 * 60 * 1_000,
  defaultInactivityMs: 60 * 1_000,
  completedResultTtlMs: 60 * 1_000,
});

const encoder = new TextEncoder();

export function utf8ByteLength(value: unknown): number {
  return encoder.encode(String(value ?? '')).byteLength;
}

export function jsonByteLength(value: unknown): number {
  try {
    return encoder.encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function truncateUtf8(value: unknown, maxBytes: number): string {
  const text = String(value ?? '');
  if (utf8ByteLength(text) <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8ByteLength(text.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

export function sanitizeHeaderRecord(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output: Record<string, string> = {};
  let bytes = 2;
  for (const [rawName, rawValue] of Object.entries(input)) {
    if (Object.keys(output).length >= NETWORK_CAPTURE_LIMITS.maxHeaderEntries) break;
    const name = truncateUtf8(rawName, NETWORK_CAPTURE_LIMITS.maxHeaderNameBytes);
    const value = truncateUtf8(rawValue, NETWORK_CAPTURE_LIMITS.maxHeaderValueBytes);
    if (!name) continue;
    const entryBytes = jsonByteLength({ [name]: value });
    if (bytes + entryBytes > NETWORK_CAPTURE_LIMITS.maxHeadersBytes) break;
    output[name] = value;
    bytes += entryBytes;
  }
  return output;
}

export function sanitizeWebRequestHeaders(
  headers: chrome.webRequest.HttpHeader[] | undefined,
): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const header of headers?.slice(0, NETWORK_CAPTURE_LIMITS.maxHeaderEntries) ?? []) {
    if (typeof header?.name !== 'string') continue;
    raw[header.name] = typeof header.value === 'string' ? header.value : '';
  }
  return sanitizeHeaderRecord(raw);
}

export function serializeBoundedFormData(
  formData: Record<string, string[]> | undefined,
): string | undefined {
  if (!formData || typeof formData !== 'object') return undefined;
  const bounded: Record<string, string[]> = {};
  for (const [rawKey, rawValues] of Object.entries(formData).slice(
    0,
    NETWORK_CAPTURE_LIMITS.maxHeaderEntries,
  )) {
    const key = truncateUtf8(rawKey, NETWORK_CAPTURE_LIMITS.maxHeaderNameBytes);
    if (!key || !Array.isArray(rawValues)) continue;
    bounded[key] = rawValues
      .slice(0, 16)
      .map((value) => truncateUtf8(value, NETWORK_CAPTURE_LIMITS.maxHeaderValueBytes));
  }
  return truncateUtf8(JSON.stringify(bounded), NETWORK_CAPTURE_LIMITS.maxRequestBodyBytes);
}

function normalizeDuration(
  input: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(input)));
}

export function normalizeCaptureTimings(input: {
  maxCaptureTime?: unknown;
  inactivityTimeout?: unknown;
}): { maxCaptureTime: number; inactivityTimeout: number } {
  const maxCaptureTime = normalizeDuration(
    input.maxCaptureTime,
    NETWORK_CAPTURE_LIMITS.defaultCaptureTimeMs,
    NETWORK_CAPTURE_LIMITS.minCaptureTimeMs,
    NETWORK_CAPTURE_LIMITS.maxCaptureTimeMs,
  );
  const inactivityTimeout = Math.min(
    maxCaptureTime,
    normalizeDuration(
      input.inactivityTimeout,
      NETWORK_CAPTURE_LIMITS.defaultInactivityMs,
      NETWORK_CAPTURE_LIMITS.minInactivityMs,
      NETWORK_CAPTURE_LIMITS.maxInactivityMs,
    ),
  );
  return { maxCaptureTime, inactivityTimeout };
}

export function normalizeEventTime(value: unknown, multiplier = 1): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  const normalized = value * multiplier;
  return Number.isSafeInteger(Math.floor(normalized)) ? normalized : undefined;
}

export function responseBodyKnownTooLarge(input: {
  encodedDataLength?: unknown;
  responseHeaders?: Record<string, string>;
}): boolean {
  const encodedLength = input.encodedDataLength;
  if (
    typeof encodedLength === 'number' &&
    Number.isFinite(encodedLength) &&
    encodedLength > NETWORK_CAPTURE_LIMITS.maxResponseBodyBytes
  ) {
    return true;
  }
  const contentLengthEntry = Object.entries(input.responseHeaders ?? {}).find(
    ([name]) => name.toLowerCase() === 'content-length',
  );
  const contentLength = Number(contentLengthEntry?.[1]);
  return Number.isFinite(contentLength) && contentLength > NETWORK_CAPTURE_LIMITS.maxResponseBodyBytes;
}

export function boundCaptureResult<T extends { requests: unknown[] }>(
  result: T,
): T & { resultTruncated?: boolean } {
  const bounded = { ...result, requests: [] as unknown[] } as T & {
    resultTruncated?: boolean;
  };
  let bytes = jsonByteLength(bounded);
  for (const request of result.requests) {
    const requestBytes = jsonByteLength(request) + 1;
    if (bytes + requestBytes > NETWORK_CAPTURE_LIMITS.maxCaptureBytes - 64 * 1024) {
      bounded.resultTruncated = true;
      break;
    }
    bounded.requests.push(request);
    bytes += requestBytes;
  }
  return bounded;
}
