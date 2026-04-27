const SENSITIVE_TEXT_PATTERN =
  /(authorization|auth|bearer|cookie|credential|key|password|secret|session|token)/i;

export function isSensitiveText(value: unknown): boolean {
  return typeof value === 'string' && SENSITIVE_TEXT_PATTERN.test(value);
}

export function isSensitiveKeyName(key: unknown): boolean {
  return typeof key === 'string' && SENSITIVE_TEXT_PATTERN.test(key.trim());
}

export function containsSensitiveValue(
  value: unknown,
  depth = 0,
  seen = new Set<unknown>(),
): boolean {
  if (value === null || value === undefined || depth > 6) {
    return false;
  }
  if (isSensitiveText(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveValue(item, depth + 1, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return Object.entries(value as Record<string, unknown>).some(
      ([key, item]) => isSensitiveKeyName(key) || containsSensitiveValue(item, depth + 1, seen),
    );
  }
  return false;
}

export function getVariableLikeName(variable: unknown): string | undefined {
  if (!variable || typeof variable !== 'object') {
    return undefined;
  }
  const record = variable as { name?: unknown; key?: unknown };
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (name) {
    return name;
  }
  const key = typeof record.key === 'string' ? record.key.trim() : '';
  return key || undefined;
}

export function isSensitiveVariableLike(variable: unknown): boolean {
  if (!variable || typeof variable !== 'object') {
    return false;
  }
  const record = variable as { sensitive?: unknown; default?: unknown };
  if (record.sensitive === true) {
    return true;
  }
  const variableName = getVariableLikeName(variable);
  if (isSensitiveKeyName(variableName)) {
    return true;
  }
  return containsSensitiveValue(record.default);
}
