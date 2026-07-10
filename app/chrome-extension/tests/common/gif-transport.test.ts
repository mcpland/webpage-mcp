import { describe, expect, it } from 'vitest';

import {
  GIF_TRANSPORT_LIMITS,
  decodeBoundedBase64,
  decodeGifFinishPayload,
  encodeBytesToBase64,
  getGifFramePixels,
  nextGifBudgetSnapshot,
} from '@/common/gif-transport';

describe('GIF transport budgets', () => {
  it('round-trips canonical bounded base64 without number arrays', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const encoded = encodeBytesToBase64(bytes, bytes.byteLength, 'test bytes');

    expect(encoded).toBe('AAEC/f7/');
    expect(
      decodeBoundedBase64(encoded, bytes.byteLength, 'test bytes'),
    ).toEqual(bytes);
  });

  it('rejects decoded base64 that is one byte over its budget', () => {
    expect(() => decodeBoundedBase64('AAAA', 2, 'test bytes')).toThrow(
      'byte limit',
    );
  });

  it('rejects non-canonical padding bits', () => {
    expect(() => decodeBoundedBase64('AB==', 1, 'test bytes')).toThrow(
      'canonical base64',
    );
  });

  it('enforces cumulative pixel and input-byte budgets at their boundary', () => {
    const exact = nextGifBudgetSnapshot(
      {
        frameCount: 0,
        totalPixels: GIF_TRANSPORT_LIMITS.maxTotalPixels - 1,
        totalInputBytes: GIF_TRANSPORT_LIMITS.maxTotalInputBytes - 1,
      },
      1,
      1,
      1,
    );
    expect(exact.totalPixels).toBe(GIF_TRANSPORT_LIMITS.maxTotalPixels);
    expect(exact.totalInputBytes).toBe(GIF_TRANSPORT_LIMITS.maxTotalInputBytes);

    expect(() => nextGifBudgetSnapshot(exact, 1, 1, 1)).toThrow(
      'cumulative pixel limit',
    );
    expect(() =>
      nextGifBudgetSnapshot(
        {
          frameCount: 0,
          totalPixels: 0,
          totalInputBytes: GIF_TRANSPORT_LIMITS.maxTotalInputBytes,
        },
        1,
        1,
        1,
      ),
    ).toThrow('input byte limit');
  });

  it('validates frame dimensions and legacy finish byte arrays', () => {
    expect(getGifFramePixels(1920, 1080)).toBe(2_073_600);
    expect(() => getGifFramePixels(1921, 1)).toThrow('dimensions exceed');
    expect(
      decodeGifFinishPayload({ gifData: [1, 2, 3], byteLength: 3 }),
    ).toEqual(new Uint8Array([1, 2, 3]));
    expect(() =>
      decodeGifFinishPayload({ gifData: [1, 300], byteLength: 2 }),
    ).toThrow('invalid byte');
  });
});
