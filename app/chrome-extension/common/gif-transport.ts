export const GIF_TRANSPORT_LIMITS = Object.freeze({
  maxWidth: 1920,
  maxHeight: 1080,
  maxFramePixels: 1920 * 1080,
  maxFrames: 300,
  maxTotalPixels: 64 * 1024 * 1024,
  maxFrameInputBytes: 12 * 1024 * 1024,
  maxTotalInputBytes: 128 * 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
});

export type GifFrameEncoding = 'png' | 'rgba';

export interface GifFrameTransportPayload {
  frameBase64: string;
  frameEncoding: GifFrameEncoding;
  inputBytes: number;
}

export interface GifBudgetSnapshot {
  frameCount: number;
  totalPixels: number;
  totalInputBytes: number;
}

export class GifBudgetError extends Error {
  override name = 'GifBudgetError';
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

function formatLimit(value: number): string {
  return value.toLocaleString('en-US');
}

export function getGifFramePixels(width: number, height: number): number {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error('GIF frame dimensions must be positive integers');
  }
  if (
    width > GIF_TRANSPORT_LIMITS.maxWidth ||
    height > GIF_TRANSPORT_LIMITS.maxHeight
  ) {
    throw new GifBudgetError(
      `GIF frame dimensions exceed ${GIF_TRANSPORT_LIMITS.maxWidth}x${GIF_TRANSPORT_LIMITS.maxHeight}`,
    );
  }

  const pixels = width * height;
  if (
    !Number.isSafeInteger(pixels) ||
    pixels > GIF_TRANSPORT_LIMITS.maxFramePixels
  ) {
    throw new GifBudgetError(
      `GIF frame exceeds the ${formatLimit(GIF_TRANSPORT_LIMITS.maxFramePixels)} pixel limit`,
    );
  }
  return pixels;
}

export function getBoundedGifFrameCount(
  width: number,
  height: number,
  requestedFrames: number,
): number {
  const pixels = getGifFramePixels(width, height);
  if (!Number.isSafeInteger(requestedFrames) || requestedFrames <= 0) {
    throw new Error('GIF maxFrames must be a positive integer');
  }

  return Math.min(
    requestedFrames,
    GIF_TRANSPORT_LIMITS.maxFrames,
    Math.floor(GIF_TRANSPORT_LIMITS.maxTotalPixels / pixels),
  );
}

export function assertGifFrameInputBytes(inputBytes: number): void {
  if (!Number.isSafeInteger(inputBytes) || inputBytes <= 0) {
    throw new Error('GIF frame input must contain bytes');
  }
  if (inputBytes > GIF_TRANSPORT_LIMITS.maxFrameInputBytes) {
    throw new GifBudgetError(
      `GIF frame input exceeds the ${formatLimit(GIF_TRANSPORT_LIMITS.maxFrameInputBytes)} byte limit`,
    );
  }
}

export function nextGifBudgetSnapshot(
  current: GifBudgetSnapshot,
  width: number,
  height: number,
  inputBytes: number,
): GifBudgetSnapshot {
  const pixels = getGifFramePixels(width, height);
  assertGifFrameInputBytes(inputBytes);

  const next: GifBudgetSnapshot = {
    frameCount: current.frameCount + 1,
    totalPixels: current.totalPixels + pixels,
    totalInputBytes: current.totalInputBytes + inputBytes,
  };

  if (next.frameCount > GIF_TRANSPORT_LIMITS.maxFrames) {
    throw new GifBudgetError(
      `GIF frame count exceeds the ${GIF_TRANSPORT_LIMITS.maxFrames} frame limit`,
    );
  }
  if (next.totalPixels > GIF_TRANSPORT_LIMITS.maxTotalPixels) {
    throw new GifBudgetError(
      `GIF recording exceeds the ${formatLimit(GIF_TRANSPORT_LIMITS.maxTotalPixels)} cumulative pixel limit`,
    );
  }
  if (next.totalInputBytes > GIF_TRANSPORT_LIMITS.maxTotalInputBytes) {
    throw new GifBudgetError(
      `GIF recording exceeds the ${formatLimit(GIF_TRANSPORT_LIMITS.maxTotalInputBytes)} input byte limit`,
    );
  }

  return next;
}

export function assertGifOutputBytes(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new Error('Encoded GIF output is empty');
  }
  if (byteLength > GIF_TRANSPORT_LIMITS.maxOutputBytes) {
    throw new GifBudgetError(
      `Encoded GIF exceeds the ${formatLimit(GIF_TRANSPORT_LIMITS.maxOutputBytes)} byte limit`,
    );
  }
}

function maxBase64Length(maxBytes: number): number {
  return Math.ceil(maxBytes / 3) * 4;
}

function base64Sextet(character: string): number {
  const code = character.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  return character === '+' ? 62 : 63;
}

export function encodeBytesToBase64(
  bytes: Uint8Array | Uint8ClampedArray,
  maxBytes: number,
  label: string,
): string {
  if (bytes.byteLength > maxBytes) {
    throw new GifBudgetError(
      `${label} exceeds the ${formatLimit(maxBytes)} byte limit`,
    );
  }

  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)),
    );
  }
  return btoa(chunks.join(''));
}

export function decodeBoundedBase64(
  value: unknown,
  maxBytes: number,
  label: string,
): Uint8Array {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty base64 string`);
  }
  if (value.length > maxBase64Length(maxBytes)) {
    throw new GifBudgetError(
      `${label} exceeds the ${formatLimit(maxBytes)} byte limit`,
    );
  }
  if (
    value.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value) ||
    value.slice(0, -2).includes('=')
  ) {
    throw new Error(`${label} is not valid bounded base64`);
  }

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (
    (padding === 2 && (base64Sextet(value[value.length - 3]!) & 0x0f) !== 0) ||
    (padding === 1 && (base64Sextet(value[value.length - 2]!) & 0x03) !== 0)
  ) {
    throw new Error(`${label} is not canonical base64`);
  }
  const decodedLength = (value.length / 4) * 3 - padding;
  if (decodedLength > maxBytes) {
    throw new GifBudgetError(
      `${label} exceeds the ${formatLimit(maxBytes)} byte limit`,
    );
  }

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`${label} is not valid bounded base64`);
  }
  if (binary.length !== decodedLength) {
    throw new Error(`${label} decoded length is invalid`);
  }

  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function assertPngDimensions(
  bytes: Uint8Array,
  expectedWidth: number,
  expectedHeight: number,
): void {
  getGifFramePixels(expectedWidth, expectedHeight);
  if (bytes.byteLength < 24) {
    throw new Error('GIF frame PNG is truncated');
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      throw new Error('GIF frame input is not a PNG image');
    }
  }
  if (
    bytes[12] !== 73 ||
    bytes[13] !== 72 ||
    bytes[14] !== 68 ||
    bytes[15] !== 82
  ) {
    throw new Error('GIF frame PNG is missing its IHDR header');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  getGifFramePixels(width, height);
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(
      `GIF frame PNG dimensions ${width}x${height} do not match ${expectedWidth}x${expectedHeight}`,
    );
  }
}

function decodeLegacyGifData(value: unknown): Uint8Array {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Legacy GIF output is missing byte data');
  }
  assertGifOutputBytes(value.length);

  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new Error('Legacy GIF output contains an invalid byte');
    }
    bytes[index] = byte;
  }
  return bytes;
}

export function decodeGifFinishPayload(response: {
  gifBase64?: unknown;
  gifData?: unknown;
  byteLength?: unknown;
}): Uint8Array {
  if (response.gifBase64 !== undefined && response.gifData !== undefined) {
    throw new Error('Encoded GIF response contains multiple payloads');
  }
  const bytes =
    response.gifBase64 !== undefined
      ? decodeBoundedBase64(
          response.gifBase64,
          GIF_TRANSPORT_LIMITS.maxOutputBytes,
          'Encoded GIF output',
        )
      : decodeLegacyGifData(response.gifData);

  assertGifOutputBytes(bytes.byteLength);
  if (
    response.byteLength !== undefined &&
    (!Number.isSafeInteger(response.byteLength) ||
      response.byteLength !== bytes.byteLength)
  ) {
    throw new Error('Encoded GIF byteLength does not match its payload');
  }
  return bytes;
}

export function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
