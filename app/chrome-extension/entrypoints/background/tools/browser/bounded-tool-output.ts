const TRUNCATION_SUFFIX = '…[truncated]';

function codePointUtf8Bytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function measureUtf8Bytes(
  value: string,
  stopAfter = Number.MAX_SAFE_INTEGER,
): number {
  let bytes = 0;
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index) ?? 0;
    bytes += codePointUtf8Bytes(codePoint);
    if (bytes > stopAfter) return bytes;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return bytes;
}

function prefixWithinUtf8Budget(value: string, maxBytes: number): string {
  let bytes = 0;
  let index = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index) ?? 0;
    const nextBytes = codePointUtf8Bytes(codePoint);
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return value.slice(0, index);
}

export function truncateUtf8(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || maxBytes <= 0) return '';
  const prefix = prefixWithinUtf8Budget(value, maxBytes);
  if (prefix.length === value.length) return value;

  const suffixBytes = measureUtf8Bytes(TRUNCATION_SUFFIX);
  if (suffixBytes > maxBytes) {
    return prefixWithinUtf8Budget(TRUNCATION_SUFFIX, maxBytes);
  }
  return (
    prefixWithinUtf8Budget(value, maxBytes - suffixBytes) +
    TRUNCATION_SUFFIX
  );
}

export function measureJsonBytes(value: unknown): number {
  try {
    return measureUtf8Bytes(JSON.stringify(value) ?? 'null');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function truncateJsonString(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || maxBytes <= 2) return '';
  let contentBudget = maxBytes - 2;
  while (contentBudget > 0) {
    const candidate = truncateUtf8(value, contentBudget);
    if (measureJsonBytes(candidate) <= maxBytes) return candidate;
    contentBudget = Math.floor(contentBudget * 0.75);
  }
  return '';
}

export function normalizeBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const numeric =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.floor(value)
      : fallback;
  return Math.min(maximum, Math.max(minimum, numeric));
}
