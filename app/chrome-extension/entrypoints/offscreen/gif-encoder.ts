/**
 * Bounded GIF encoder for the offscreen document.
 *
 * Version 2 messages use PNG/RGBA base64 so Chrome's JSON message transport
 * never expands millions of RGBA bytes into a number[]. Legacy imageData is
 * accepted for one migration window, but is subject to the same hard limits.
 */

import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { MessageTarget, OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';
import {
  GIF_ENCODER_PROTOCOL_LIMITS,
  createGifFrameOperationId,
  createGifOperationId,
  requireGifOperationId,
  requireGifRecordingId,
} from '@/common/gif-encoder-protocol';
import {
  GIF_TRANSPORT_LIMITS,
  assertGifOutputBytes,
  assertPngDimensions,
  copyBytesToArrayBuffer,
  decodeBoundedBase64,
  encodeBytesToBase64,
  getGifFramePixels,
  nextGifBudgetSnapshot,
  type GifBudgetSnapshot,
  type GifFrameEncoding,
} from '@/common/gif-transport';

interface GifEncoderState extends GifBudgetSnapshot {
  encoder: ReturnType<typeof GIFEncoder> | null;
  recordingId: string | null;
  startOperationId: string | null;
  processedFrameOperationIds: Set<string>;
  width: number;
  height: number;
  isInitialized: boolean;
}

interface GifMessageRecord extends Record<string, unknown> {
  target: MessageTarget;
  type:
    | typeof OFFSCREEN_MESSAGE_TYPES.GIF_START
    | typeof OFFSCREEN_MESSAGE_TYPES.GIF_ADD_FRAME
    | typeof OFFSCREEN_MESSAGE_TYPES.GIF_FINISH
    | typeof OFFSCREEN_MESSAGE_TYPES.GIF_RESET;
}

export interface GifMessageResponse {
  success: boolean;
  error?: string;
  protocolVersion?: 2;
  frameCount?: number;
  gifBase64?: string;
  byteLength?: number;
  recordingId?: string;
  operationId?: string;
}

interface TerminalResponseCache {
  recordingId: string;
  operationId: string;
  response: GifMessageResponse;
  createdAt: number;
}

interface ResetTombstone {
  recordingId: string;
  operationId: string;
  createdAt: number;
}

interface DecodedFrame {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  delay: number;
  maxColors: number;
  inputBytes: number;
}

const state: GifEncoderState = {
  encoder: null,
  recordingId: null,
  startOperationId: null,
  processedFrameOperationIds: new Set(),
  width: 0,
  height: 0,
  frameCount: 0,
  totalPixels: 0,
  totalInputBytes: 0,
  isInitialized: false,
};

let operationQueue: Promise<void> = Promise.resolve();
let terminalResponseCache: TerminalResponseCache | null = null;
let resetTombstone: ResetTombstone | null = null;

function resetEncoder(): void {
  if (state.encoder) {
    try {
      state.encoder.reset();
    } catch {
      // State still needs to be discarded after an encoder failure.
    }
  }
  state.encoder = null;
  state.width = 0;
  state.height = 0;
  state.frameCount = 0;
  state.totalPixels = 0;
  state.totalInputBytes = 0;
  state.isInitialized = false;
}

function clearActiveRecording(): void {
  state.recordingId = null;
  state.startOperationId = null;
  state.processedFrameOperationIds.clear();
}

function discardActiveRecording(): void {
  resetEncoder();
  clearActiveRecording();
}

function pruneExpiredOperationCaches(): void {
  const cutoff = Date.now() - GIF_ENCODER_PROTOCOL_LIMITS.terminalResponseTtlMs;
  if (terminalResponseCache && terminalResponseCache.createdAt < cutoff) {
    terminalResponseCache = null;
  }
  if (resetTombstone && resetTombstone.createdAt < cutoff) {
    resetTombstone = null;
  }
}

function initializeEncoder(width: number, height: number): void {
  state.encoder = GIFEncoder();
  state.width = width;
  state.height = height;
  state.frameCount = 0;
  state.totalPixels = 0;
  state.totalInputBytes = 0;
  state.isInitialized = true;
}

function readInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function readLegacyRgba(
  value: unknown,
  expectedBytes: number,
): Uint8ClampedArray {
  if (!Array.isArray(value)) {
    throw new Error('Legacy GIF frame imageData must be a byte array');
  }
  if (value.length !== expectedBytes) {
    throw new Error(
      `Legacy GIF frame RGBA length ${value.length} does not match ${expectedBytes}`,
    );
  }
  if (value.length > GIF_TRANSPORT_LIMITS.maxFrameInputBytes) {
    throw new Error('Legacy GIF frame exceeds the input byte limit');
  }

  const rgba = new Uint8ClampedArray(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index];
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new Error('Legacy GIF frame contains an invalid byte');
    }
    rgba[index] = byte;
  }
  return rgba;
}

async function decodePngFrame(
  bytes: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8ClampedArray> {
  assertPngDimensions(bytes, width, height);
  const bitmap = await createImageBitmap(
    new Blob([copyBytesToArrayBuffer(bytes)], { type: 'image/png' }),
  );
  try {
    if (bitmap.width !== width || bitmap.height !== height) {
      throw new Error('Decoded GIF frame PNG dimensions do not match');
    }
    if (typeof OffscreenCanvas === 'undefined') {
      throw new Error('OffscreenCanvas is not available for GIF frame decode');
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to create GIF frame decode context');
    ctx.drawImage(bitmap, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height).data;
  } finally {
    bitmap.close();
  }
}

async function decodeFrame(message: GifMessageRecord): Promise<DecodedFrame> {
  const width = readInteger(
    message.width,
    'GIF frame width',
    1,
    GIF_TRANSPORT_LIMITS.maxWidth,
  );
  const height = readInteger(
    message.height,
    'GIF frame height',
    1,
    GIF_TRANSPORT_LIMITS.maxHeight,
  );
  const pixels = getGifFramePixels(width, height);
  const expectedRgbaBytes = pixels * 4;
  const delay = readInteger(message.delay, 'GIF frame delay', 1, 60_000);
  const maxColors = readInteger(
    message.maxColors ?? 256,
    'GIF maxColors',
    2,
    256,
  );

  if (
    state.isInitialized &&
    (state.width !== width || state.height !== height)
  ) {
    throw new Error(
      `GIF frame dimensions changed from ${state.width}x${state.height} to ${width}x${height}`,
    );
  }

  const hasVersion2Frame = message.frameBase64 !== undefined;
  const hasLegacyFrame = message.imageData !== undefined;
  if (hasVersion2Frame === hasLegacyFrame) {
    throw new Error('GIF frame must contain exactly one supported payload');
  }

  let rgba: Uint8ClampedArray;
  let inputBytes: number;
  if (hasVersion2Frame) {
    if (message.protocolVersion !== 2) {
      throw new Error('Unsupported GIF frame protocol version');
    }
    if (message.frameEncoding !== 'png' && message.frameEncoding !== 'rgba') {
      throw new Error('Unsupported GIF frame encoding');
    }
    const frameEncoding = message.frameEncoding as GifFrameEncoding;
    const bytes = decodeBoundedBase64(
      message.frameBase64,
      GIF_TRANSPORT_LIMITS.maxFrameInputBytes,
      'GIF frame payload',
    );
    inputBytes = bytes.byteLength;
    if (
      !Number.isSafeInteger(message.frameByteLength) ||
      message.frameByteLength !== inputBytes
    ) {
      throw new Error('GIF frame byteLength does not match its payload');
    }

    nextGifBudgetSnapshot(state, width, height, inputBytes);
    if (frameEncoding === 'png') {
      rgba = await decodePngFrame(bytes, width, height);
    } else {
      if (bytes.byteLength !== expectedRgbaBytes) {
        throw new Error(
          `GIF frame RGBA length ${bytes.byteLength} does not match ${expectedRgbaBytes}`,
        );
      }
      rgba = new Uint8ClampedArray(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
    }
  } else {
    rgba = readLegacyRgba(message.imageData, expectedRgbaBytes);
    inputBytes = rgba.byteLength;
    nextGifBudgetSnapshot(state, width, height, inputBytes);
  }

  if (rgba.byteLength !== expectedRgbaBytes) {
    throw new Error(
      `Decoded GIF frame RGBA length ${rgba.byteLength} does not match ${expectedRgbaBytes}`,
    );
  }
  return { rgba, width, height, delay, maxColors, inputBytes };
}

async function addFrame(message: GifMessageRecord): Promise<number> {
  const frame = await decodeFrame(message);
  const nextBudget = nextGifBudgetSnapshot(
    state,
    frame.width,
    frame.height,
    frame.inputBytes,
  );

  if (!state.isInitialized) initializeEncoder(frame.width, frame.height);
  if (!state.encoder) throw new Error('GIF encoder not initialized');

  try {
    const palette = quantize(frame.rgba, frame.maxColors, {
      format: 'rgb444',
    });
    const indexedPixels = applyPalette(frame.rgba, palette, 'rgb444');
    state.encoder.writeFrame(indexedPixels, frame.width, frame.height, {
      palette,
      delay: frame.delay,
      dispose: 2,
    });
    assertGifOutputBytes(state.encoder.bytesView().byteLength);
  } catch (error) {
    discardActiveRecording();
    throw error;
  }

  state.frameCount = nextBudget.frameCount;
  state.totalPixels = nextBudget.totalPixels;
  state.totalInputBytes = nextBudget.totalInputBytes;
  return state.frameCount;
}

function readRecordingEnvelope(
  message: GifMessageRecord,
  operation: 'start' | 'finish' | 'reset',
): { recordingId: string; operationId: string } {
  const recordingId = requireGifRecordingId(message.recordingId);
  const operationId = requireGifOperationId(
    message.operationId,
    createGifOperationId(recordingId, operation),
  );
  return { recordingId, operationId };
}

function startRecording(message: GifMessageRecord): GifMessageResponse {
  pruneExpiredOperationCaches();
  const { recordingId, operationId } = readRecordingEnvelope(message, 'start');

  if (state.recordingId === recordingId) {
    if (state.startOperationId !== operationId) {
      throw new Error('GIF start operation does not match the active recording');
    }
    return {
      success: true,
      recordingId,
      operationId,
      frameCount: state.frameCount,
    };
  }
  if (terminalResponseCache?.recordingId === recordingId) {
    throw new Error('GIF recording has already finished');
  }
  if (resetTombstone?.recordingId === recordingId) {
    throw new Error('GIF recording has already been reset');
  }

  // A new recording is the authoritative bounded generation boundary. It
  // discards any orphaned encoder state left by a previous worker instance.
  discardActiveRecording();
  terminalResponseCache = null;
  resetTombstone = null;
  state.recordingId = recordingId;
  state.startOperationId = operationId;
  return { success: true, recordingId, operationId, frameCount: 0 };
}

async function addFrameOperation(
  message: GifMessageRecord,
): Promise<GifMessageResponse> {
  pruneExpiredOperationCaches();
  const recordingId = requireGifRecordingId(message.recordingId);
  const sequence = readInteger(
    message.sequence,
    'GIF frame sequence',
    0,
    GIF_ENCODER_PROTOCOL_LIMITS.maxFrameSequence,
  );
  const operationId = requireGifOperationId(
    message.operationId,
    createGifFrameOperationId(recordingId, sequence),
  );

  if (state.recordingId !== recordingId) {
    throw new Error('GIF recordingId does not match the active recording');
  }
  if (state.processedFrameOperationIds.has(operationId)) {
    if (sequence >= state.frameCount) {
      throw new Error('GIF frame deduplication state is inconsistent');
    }
    return {
      success: true,
      recordingId,
      operationId,
      frameCount: sequence + 1,
    };
  }
  if (sequence !== state.frameCount) {
    throw new Error(
      `GIF frame sequence ${sequence} is out of order; expected ${state.frameCount}`,
    );
  }

  const frameCount = await addFrame(message);
  if (frameCount !== sequence + 1) {
    discardActiveRecording();
    throw new Error('GIF encoder frame count is inconsistent');
  }
  state.processedFrameOperationIds.add(operationId);
  return { success: true, recordingId, operationId, frameCount };
}

function finishRecording(message: GifMessageRecord): GifMessageResponse {
  pruneExpiredOperationCaches();
  const { recordingId, operationId } = readRecordingEnvelope(
    message,
    'finish',
  );
  if (
    terminalResponseCache?.recordingId === recordingId &&
    terminalResponseCache.operationId === operationId
  ) {
    return { ...terminalResponseCache.response };
  }
  if (state.recordingId !== recordingId) {
    throw new Error('GIF recordingId does not match the active recording');
  }

  try {
    const { bytes, frameCount } = finishEncoding();
    const response: GifMessageResponse = {
      success: true,
      protocolVersion: 2,
      recordingId,
      operationId,
      frameCount,
      gifBase64: encodeBytesToBase64(
        bytes,
        GIF_TRANSPORT_LIMITS.maxOutputBytes,
        'Encoded GIF output',
      ),
      byteLength: bytes.byteLength,
    };
    terminalResponseCache = {
      recordingId,
      operationId,
      response,
      createdAt: Date.now(),
    };
    resetTombstone = null;
    clearActiveRecording();
    return response;
  } catch (error) {
    discardActiveRecording();
    throw error;
  }
}

function resetRecording(message: GifMessageRecord): GifMessageResponse {
  pruneExpiredOperationCaches();
  const { recordingId, operationId } = readRecordingEnvelope(message, 'reset');

  if (state.recordingId !== null) {
    if (state.recordingId !== recordingId) {
      throw new Error('GIF recordingId does not match the active recording');
    }
    discardActiveRecording();
    terminalResponseCache = null;
  } else if (terminalResponseCache?.recordingId === recordingId) {
    terminalResponseCache = null;
  } else if (
    resetTombstone?.recordingId === recordingId &&
    resetTombstone.operationId === operationId
  ) {
    return { success: true, recordingId, operationId };
  } else {
    throw new Error('GIF recordingId does not match any active recording');
  }

  resetTombstone = { recordingId, operationId, createdAt: Date.now() };
  return { success: true, recordingId, operationId };
}

function finishEncoding(): { bytes: Uint8Array; frameCount: number } {
  if (!state.encoder || state.frameCount <= 0) {
    throw new Error('GIF encoder not initialized');
  }

  const frameCount = state.frameCount;
  try {
    assertGifOutputBytes(state.encoder.bytesView().byteLength);
    state.encoder.finish();
    const view = state.encoder.bytesView();
    assertGifOutputBytes(view.byteLength);
    return { bytes: new Uint8Array(view), frameCount };
  } finally {
    resetEncoder();
  }
}

function isGifMessage(message: unknown): message is GifMessageRecord {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as Record<string, unknown>;
  if (candidate.target !== MessageTarget.Offscreen) return false;
  return (
    candidate.type === OFFSCREEN_MESSAGE_TYPES.GIF_ADD_FRAME ||
    candidate.type === OFFSCREEN_MESSAGE_TYPES.GIF_START ||
    candidate.type === OFFSCREEN_MESSAGE_TYPES.GIF_FINISH ||
    candidate.type === OFFSCREEN_MESSAGE_TYPES.GIF_RESET
  );
}

async function processGifMessage(
  message: GifMessageRecord,
): Promise<GifMessageResponse> {
  switch (message.type) {
    case OFFSCREEN_MESSAGE_TYPES.GIF_START:
      return startRecording(message);

    case OFFSCREEN_MESSAGE_TYPES.GIF_ADD_FRAME:
      return addFrameOperation(message);

    case OFFSCREEN_MESSAGE_TYPES.GIF_FINISH:
      return finishRecording(message);

    case OFFSCREEN_MESSAGE_TYPES.GIF_RESET:
      return resetRecording(message);
  }
}

export function handleGifMessage(
  message: unknown,
  sendResponse: (response: GifMessageResponse) => void,
): boolean {
  if (!isGifMessage(message)) return false;

  const operation = operationQueue.then(() => processGifMessage(message));
  operationQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  void operation.then(sendResponse).catch((error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('GIF encoder error:', errorMessage);
    sendResponse({ success: false, error: errorMessage });
  });
  return true;
}

console.log('GIF encoder module loaded');
