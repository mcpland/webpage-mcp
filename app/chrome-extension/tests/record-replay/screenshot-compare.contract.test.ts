import { describe, expect, it } from 'vitest';
import { compareScreenshotBase64 } from '@/entrypoints/background/record-replay/engine/utils/screenshot-compare';

function bytesToBase64(bytes: number[]): string {
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b & 0xff);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  const maybeBuffer = (globalThis as any)?.Buffer;
  if (maybeBuffer?.from) {
    return maybeBuffer.from(binary, 'binary').toString('base64');
  }
  throw new Error('No base64 encoder available in test runtime');
}

describe('screenshot compare contract', () => {
  it('returns 1 for identical payloads', () => {
    const sample = bytesToBase64([0, 1, 2, 3, 4, 5, 200, 255]);
    expect(compareScreenshotBase64(sample, sample)).toBe(1);
  });

  it('returns lower similarity for different payloads', () => {
    const baseline = bytesToBase64([0, 20, 40, 60, 80, 100, 120, 140]);
    const mutated = bytesToBase64([255, 220, 200, 180, 160, 140, 120, 100]);

    const similarity = compareScreenshotBase64(mutated, baseline);
    expect(similarity).not.toBeNull();
    expect(similarity!).toBeLessThan(0.7);
  });

  it('supports data-uri base64 inputs', () => {
    const payload = bytesToBase64([1, 2, 3, 4, 5, 6, 7, 8]);
    const dataUri = `data:image/png;base64,${payload}`;
    expect(compareScreenshotBase64(dataUri, payload)).toBe(1);
  });

  it('returns null for invalid payload', () => {
    const payload = bytesToBase64([10, 11, 12, 13]);
    expect(compareScreenshotBase64('not-base64', payload)).toBeNull();
  });
});
