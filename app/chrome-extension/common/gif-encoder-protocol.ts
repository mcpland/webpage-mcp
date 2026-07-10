import { GIF_TRANSPORT_LIMITS } from "./gif-transport";

const RECORDING_ID_PREFIX = "gif_";
const RECORDING_ID_BYTES = 16;
const RECORDING_ID_PATTERN = /^gif_[0-9a-f]{32}$/;

export const GIF_ENCODER_PROTOCOL_LIMITS = Object.freeze({
  recordingIdBytes: RECORDING_ID_BYTES,
  recordingIdLength: RECORDING_ID_PREFIX.length + RECORDING_ID_BYTES * 2,
  maxFrameSequence: GIF_TRANSPORT_LIMITS.maxFrames - 1,
  terminalResponseTtlMs: 5 * 60 * 1000,
});

export type GifEncoderOperation = "start" | "finish" | "reset";

export function isGifRecordingId(value: unknown): value is string {
  return typeof value === "string" && RECORDING_ID_PATTERN.test(value);
}

export function requireGifRecordingId(value: unknown): string {
  if (!isGifRecordingId(value)) {
    throw new Error(
      `GIF recordingId must match ${RECORDING_ID_PREFIX}<32 lowercase hex characters>`,
    );
  }
  return value;
}

export function createGifRecordingId(): string {
  const bytes = new Uint8Array(RECORDING_ID_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  let suffix = "";
  for (const byte of bytes) suffix += byte.toString(16).padStart(2, "0");
  return `${RECORDING_ID_PREFIX}${suffix}`;
}

export function createGifOperationId(
  recordingId: string,
  operation: GifEncoderOperation,
): string {
  return `${requireGifRecordingId(recordingId)}:${operation}`;
}

export function createGifFrameOperationId(
  recordingId: string,
  sequence: number,
): string {
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    sequence > GIF_ENCODER_PROTOCOL_LIMITS.maxFrameSequence
  ) {
    throw new Error(
      `GIF frame sequence must be an integer between 0 and ${GIF_ENCODER_PROTOCOL_LIMITS.maxFrameSequence}`,
    );
  }
  return `${requireGifRecordingId(recordingId)}:frame:${sequence}`;
}

export function requireGifOperationId(
  value: unknown,
  expected: string,
): string {
  if (value !== expected) {
    throw new Error("GIF operationId does not match the requested operation");
  }
  return expected;
}
