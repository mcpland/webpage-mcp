import {
  GIF_TRANSPORT_LIMITS,
  assertGifFrameInputBytes,
  encodeBytesToBase64,
  type GifFrameTransportPayload,
} from '@/common/gif-transport';

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error('Failed to read GIF frame PNG'));
    reader.readAsArrayBuffer(blob);
  });
}

export async function encodeGifCanvasFrame(
  canvas: OffscreenCanvas,
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): Promise<GifFrameTransportPayload> {
  if (typeof canvas.convertToBlob === 'function') {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    assertGifFrameInputBytes(blob.size);
    const bytes = await readBlobBytes(blob);
    return {
      frameBase64: encodeBytesToBase64(
        bytes,
        GIF_TRANSPORT_LIMITS.maxFrameInputBytes,
        'GIF frame PNG',
      ),
      frameEncoding: 'png',
      inputBytes: bytes.byteLength,
    };
  }

  const rgba = ctx.getImageData(0, 0, width, height).data;
  const expectedBytes = width * height * 4;
  if (rgba.byteLength !== expectedBytes) {
    throw new Error(
      `GIF frame RGBA length ${rgba.byteLength} does not match ${expectedBytes}`,
    );
  }
  assertGifFrameInputBytes(rgba.byteLength);
  return {
    frameBase64: encodeBytesToBase64(
      rgba,
      GIF_TRANSPORT_LIMITS.maxFrameInputBytes,
      'GIF frame RGBA',
    ),
    frameEncoding: 'rgba',
    inputBytes: rgba.byteLength,
  };
}
