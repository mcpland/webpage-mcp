/**
 * Lightweight screenshot similarity helper.
 *
 * Uses sampled byte-distance over decoded base64 payloads.
 * Returns similarity score in [0, 1], or null when inputs are invalid.
 */

function normalizeBase64(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const commaIndex = raw.indexOf(',');
  if (commaIndex > 0 && /;base64/i.test(raw.slice(0, commaIndex))) {
    return raw.slice(commaIndex + 1).replace(/\s+/g, '');
  }
  return raw.replace(/\s+/g, '');
}

function decodeBase64(base64: string): Uint8Array | null {
  const normalized = normalizeBase64(base64);
  if (!normalized) return null;

  try {
    if (typeof atob === 'function') {
      const binary = atob(normalized);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i) & 0xff;
      }
      return bytes;
    }

    const maybeBuffer = (globalThis as any)?.Buffer;
    if (maybeBuffer?.from) {
      const buffer = maybeBuffer.from(normalized, 'base64');
      return new Uint8Array(buffer);
    }
  } catch {
    return null;
  }

  return null;
}

function sampledDifference(a: Uint8Array, b: Uint8Array, sampleCount = 2048): number {
  const minLen = Math.min(a.length, b.length);
  if (minLen <= 0) return 1;

  const step = Math.max(1, Math.floor(minLen / sampleCount));
  let sum = 0;
  let sampled = 0;
  for (let i = 0; i < minLen; i += step) {
    sum += Math.abs(a[i] - b[i]) / 255;
    sampled += 1;
  }

  const contentDiff = sampled > 0 ? sum / sampled : 1;
  const lengthDiff =
    Math.max(a.length, b.length) > 0
      ? Math.min(1, Math.abs(a.length - b.length) / Math.max(a.length, b.length))
      : 0;

  // Content difference dominates; length difference is a secondary penalty.
  return Math.min(1, contentDiff * 0.85 + lengthDiff * 0.15);
}

export function compareScreenshotBase64(actual: string, baseline: string): number | null {
  const left = decodeBase64(actual);
  const right = decodeBase64(baseline);
  if (!left || !right) return null;

  const diff = sampledDifference(left, right);
  const similarity = Math.max(0, Math.min(1, 1 - diff));
  return Number(similarity.toFixed(4));
}
