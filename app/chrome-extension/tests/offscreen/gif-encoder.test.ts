import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gifencMocks = vi.hoisted(() => {
  const encoder = {
    writeFrame: vi.fn(),
    finish: vi.fn(),
    bytes: vi.fn(),
    bytesView: vi.fn(),
    reset: vi.fn(),
  };
  return {
    encoder,
    GIFEncoder: vi.fn(() => encoder),
    quantize: vi.fn(() => [0, 0, 0]),
    applyPalette: vi.fn(() => new Uint8Array([0])),
  };
});

vi.mock('gifenc', () => gifencMocks);

import {
  handleGifMessage,
  type GifMessageResponse,
} from '@/entrypoints/offscreen/gif-encoder';
import { MessageTarget, OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';
import { GIF_TRANSPORT_LIMITS } from '@/common/gif-transport';

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error('Failed to read test PNG'));
    reader.readAsArrayBuffer(blob);
  });
}

function version2Frame(width = 1, height = 1): Record<string, unknown> {
  const bytes = pngBytes(width, height);
  return {
    target: MessageTarget.Offscreen,
    type: OFFSCREEN_MESSAGE_TYPES.GIF_ADD_FRAME,
    protocolVersion: 2,
    frameEncoding: 'png',
    frameBase64: toBase64(bytes),
    frameByteLength: bytes.byteLength,
    width,
    height,
    delay: 20,
    maxColors: 256,
  };
}

function dispatch(message: unknown): Promise<GifMessageResponse> {
  return new Promise((resolve) => {
    expect(handleGifMessage(message, resolve)).toBe(true);
  });
}

describe('offscreen GIF encoder', () => {
  beforeEach(async () => {
    gifencMocks.encoder.bytesView.mockReturnValue(new Uint8Array([71, 73, 70]));
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async (blob: Blob) => {
        const bytes = await readBlobBytes(blob);
        const view = new DataView(bytes.buffer);
        return {
          width: view.getUint32(16, false),
          height: view.getUint32(20, false),
          close: vi.fn(),
        };
      }),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class MockOffscreenCanvas {
        constructor(
          readonly width: number,
          readonly height: number,
        ) {}

        getContext() {
          return {
            drawImage: vi.fn(),
            getImageData: vi.fn(() => ({
              data: { byteLength: this.width * this.height * 4 },
            })),
          };
        }
      },
    );
    await dispatch({
      target: MessageTarget.Offscreen,
      type: OFFSCREEN_MESSAGE_TYPES.GIF_RESET,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('accepts protocol-v2 PNG frames and returns bounded gifBase64', async () => {
    const add = await dispatch(version2Frame());
    const finish = await dispatch({
      target: MessageTarget.Offscreen,
      type: OFFSCREEN_MESSAGE_TYPES.GIF_FINISH,
    });

    expect(add).toMatchObject({ success: true, frameCount: 1 });
    expect(finish).toMatchObject({
      success: true,
      protocolVersion: 2,
      gifBase64: 'R0lG',
      byteLength: 3,
      frameCount: 1,
    });
    expect(finish).not.toHaveProperty('gifData');
  });

  it('accepts a strictly bounded legacy imageData frame', async () => {
    const response = await dispatch({
      target: MessageTarget.Offscreen,
      type: OFFSCREEN_MESSAGE_TYPES.GIF_ADD_FRAME,
      imageData: [0, 1, 2, 255],
      width: 1,
      height: 1,
      delay: 20,
      maxColors: 256,
    });

    expect(response).toMatchObject({ success: true, frameCount: 1 });
    expect(gifencMocks.encoder.writeFrame).toHaveBeenCalledOnce();
  });

  it('rejects oversized dimensions before decoding or encoding', async () => {
    const response = await dispatch(
      version2Frame(GIF_TRANSPORT_LIMITS.maxWidth + 1, 1),
    );

    expect(response.success).toBe(false);
    expect(response.error).toContain('width');
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(gifencMocks.quantize).not.toHaveBeenCalled();
  });

  it('rejects legacy RGBA length mismatches before allocating encoder state', async () => {
    const response = await dispatch({
      target: MessageTarget.Offscreen,
      type: OFFSCREEN_MESSAGE_TYPES.GIF_ADD_FRAME,
      imageData: [0, 1, 2],
      width: 1,
      height: 1,
      delay: 20,
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain('does not match 4');
    expect(gifencMocks.GIFEncoder).not.toHaveBeenCalled();
  });

  it('rejects mismatched declared input bytes and invalid PNG headers', async () => {
    const mismatched = version2Frame();
    mismatched.frameByteLength = 23;
    const lengthResponse = await dispatch(mismatched);

    const invalidPng = version2Frame();
    invalidPng.frameBase64 = toBase64(new Uint8Array(24));
    const pngResponse = await dispatch(invalidPng);

    expect(lengthResponse.success).toBe(false);
    expect(lengthResponse.error).toContain('byteLength');
    expect(pngResponse.success).toBe(false);
    expect(pngResponse.error).toContain('not a PNG');
    expect(gifencMocks.quantize).not.toHaveBeenCalled();
  });

  it('enforces the cumulative pixel budget in the offscreen boundary', async () => {
    const fullFrame = version2Frame(
      GIF_TRANSPORT_LIMITS.maxWidth,
      GIF_TRANSPORT_LIMITS.maxHeight,
    );
    const allowedFrames = Math.floor(
      GIF_TRANSPORT_LIMITS.maxTotalPixels / GIF_TRANSPORT_LIMITS.maxFramePixels,
    );

    for (let index = 0; index < allowedFrames; index += 1) {
      const response = await dispatch(fullFrame);
      expect(response.success).toBe(true);
    }
    const rejected = await dispatch(fullFrame);

    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain('cumulative pixel limit');
    expect(gifencMocks.encoder.writeFrame).toHaveBeenCalledTimes(allowedFrames);
  });

  it('enforces the hard frame-count budget for legacy callers too', async () => {
    const legacyFrame = {
      target: MessageTarget.Offscreen,
      type: OFFSCREEN_MESSAGE_TYPES.GIF_ADD_FRAME,
      imageData: [0, 1, 2, 255],
      width: 1,
      height: 1,
      delay: 20,
    };

    for (let index = 0; index < GIF_TRANSPORT_LIMITS.maxFrames; index += 1) {
      expect((await dispatch(legacyFrame)).success).toBe(true);
    }
    const rejected = await dispatch(legacyFrame);

    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain('frame limit');
    expect(gifencMocks.encoder.writeFrame).toHaveBeenCalledTimes(
      GIF_TRANSPORT_LIMITS.maxFrames,
    );
  });

  it('rejects dimension changes without silently replacing the encoder', async () => {
    expect((await dispatch(version2Frame(1, 1))).success).toBe(true);
    const changed = await dispatch(version2Frame(2, 1));
    const finish = await dispatch({
      target: MessageTarget.Offscreen,
      type: OFFSCREEN_MESSAGE_TYPES.GIF_FINISH,
    });

    expect(changed.success).toBe(false);
    expect(changed.error).toContain('dimensions changed');
    expect(gifencMocks.GIFEncoder).toHaveBeenCalledOnce();
    expect(finish.success).toBe(true);
    expect(finish.frameCount).toBe(1);
  });

  it('rejects oversized encoder output before finish serialization and resets state', async () => {
    expect((await dispatch(version2Frame())).success).toBe(true);
    gifencMocks.encoder.bytesView
      .mockReset()
      .mockReturnValueOnce(new Uint8Array([71, 73, 70]))
      .mockReturnValueOnce({
        byteLength: GIF_TRANSPORT_LIMITS.maxOutputBytes + 1,
      } as unknown as Uint8Array);

    const finish = await dispatch({
      target: MessageTarget.Offscreen,
      type: OFFSCREEN_MESSAGE_TYPES.GIF_FINISH,
    });

    expect(finish.success).toBe(false);
    expect(finish.error).toContain('byte limit');
    expect(finish).not.toHaveProperty('gifBase64');
    expect(gifencMocks.encoder.finish).toHaveBeenCalledOnce();
    expect(gifencMocks.encoder.reset).toHaveBeenCalled();

    gifencMocks.encoder.bytesView.mockReturnValue(new Uint8Array([71, 73, 70]));
    expect((await dispatch(version2Frame())).success).toBe(true);
  });

  it('resets immediately when encoded output crosses the limit while adding a frame', async () => {
    gifencMocks.encoder.bytesView.mockReturnValue({
      byteLength: GIF_TRANSPORT_LIMITS.maxOutputBytes + 1,
    } as unknown as Uint8Array);

    const response = await dispatch(version2Frame());

    expect(response.success).toBe(false);
    expect(response.error).toContain('byte limit');
    expect(gifencMocks.encoder.reset).toHaveBeenCalled();
  });
});
