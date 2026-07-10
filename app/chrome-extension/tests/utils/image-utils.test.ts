import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCREENSHOT_LIMITS } from 'webpage-mcp-shared';

import {
  assertPixelDimensions,
  canvasToDataURL,
  compressImage,
  createImageBitmapFromUrl,
  cropAndResizeImage,
  stitchImages,
} from '@/utils/image-utils';

const SMALL_DATA_URL = 'data:image/png;base64,AA==';

type MockBitmap = ImageBitmap & { close: ReturnType<typeof vi.fn> };

function makeBitmap(width: number, height: number): MockBitmap {
  return {
    width,
    height,
    close: vi.fn(),
  } as unknown as MockBitmap;
}

describe('bounded image utilities', () => {
  let bitmap: MockBitmap;
  let context: {
    fillStyle: string;
    fillRect: ReturnType<typeof vi.fn>;
    drawImage: ReturnType<typeof vi.fn>;
  };
  let canvasConstructor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bitmap = makeBitmap(100, 100);
    context = {
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        blob: async () => new Blob(['x'], { type: 'image/png' }),
      })),
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => bitmap),
    );

    canvasConstructor = vi.fn(function (this: any, width: number, height: number) {
      this.width = width;
      this.height = height;
      this.getContext = vi.fn(() => context);
      this.convertToBlob = vi.fn(async () => new Blob(['x'], { type: 'image/png' }));
    });
    vi.stubGlobal('OffscreenCanvas', canvasConstructor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts the exact source-pixel boundary and rejects one row beyond it', () => {
    expect(() =>
      assertPixelDimensions(10_000, 4_000, SCREENSHOT_LIMITS.MAX_SOURCE_PIXELS, 'Source image'),
    ).not.toThrow();
    expect(() =>
      assertPixelDimensions(10_000, 4_001, SCREENSHOT_LIMITS.MAX_SOURCE_PIXELS, 'Source image'),
    ).toThrow('pixel budget');
  });

  it('closes a decoded bitmap when post-decode pixel validation fails', async () => {
    bitmap = makeBitmap(10_000, 4_001);

    await expect(createImageBitmapFromUrl(SMALL_DATA_URL)).rejects.toThrow('pixel budget');
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('rejects an oversized stitched canvas before allocating or decoding', async () => {
    await expect(stitchImages([{ dataUrl: SMALL_DATA_URL, y: 0 }], 8_000, 8_001)).rejects.toThrow(
      'pixel budget',
    );

    expect(canvasConstructor).not.toHaveBeenCalled();
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('closes each stitched bitmap when drawing throws', async () => {
    context.drawImage.mockImplementation(() => {
      throw new Error('draw failed');
    });

    await expect(stitchImages([{ dataUrl: SMALL_DATA_URL, y: 0 }], 100, 100)).rejects.toThrow(
      'draw failed',
    );
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('closes the crop bitmap when canvas context creation fails', async () => {
    canvasConstructor.mockImplementation(function (this: any, width: number, height: number) {
      this.width = width;
      this.height = height;
      this.getContext = vi.fn(() => null);
    });

    await expect(
      cropAndResizeImage(SMALL_DATA_URL, { x: 0, y: 0, width: 50, height: 50 }),
    ).rejects.toThrow('Unable to get canvas context');
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('closes the compression bitmap when drawing fails', async () => {
    context.drawImage.mockImplementation(() => {
      throw new Error('compression draw failed');
    });

    await expect(compressImage(SMALL_DATA_URL, { scale: 0.5 })).rejects.toThrow(
      'compression draw failed',
    );
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('rejects an encoded output over the byte ceiling before reading it', async () => {
    const canvas = {
      width: 100,
      height: 100,
      convertToBlob: vi.fn(async () => ({
        size: SCREENSHOT_LIMITS.MAX_DATA_URL_BYTES,
        type: 'image/png',
      })),
    } as unknown as OffscreenCanvas;

    await expect(canvasToDataURL(canvas)).rejects.toThrow('encoded limit');
    expect(canvas.convertToBlob).toHaveBeenCalledOnce();
  });
});
