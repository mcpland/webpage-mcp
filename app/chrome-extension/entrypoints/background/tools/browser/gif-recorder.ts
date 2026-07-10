/**
 * GIF Recorder Tool
 *
 * Records browser tab activity as an animated GIF.
 *
 * Features:
 * - Two recording modes:
 *   1. Fixed FPS mode (start): Captures frames at regular intervals
 *   2. Auto-capture mode (auto_start): Captures frames on tool actions
 * - Configurable frame rate, duration, and dimensions
 * - Quality/size optimization options
 * - CDP-based screenshot capture for background recording
 * - Offscreen document encoding via gifenc
 */

import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { toPublicDownloadLocation } from '@/entrypoints/background/download-paths';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import {
  MessageTarget,
  OFFSCREEN_MESSAGE_TYPES,
  type OffscreenMessageType,
} from '@/common/message-types';
import {
  createGifFrameOperationId,
  createGifOperationId,
  createGifRecordingId,
} from '@/common/gif-encoder-protocol';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { offscreenManager } from '@/utils/offscreen-manager';
import { createImageBitmapFromUrl } from '@/utils/image-utils';
import {
  GIF_TRANSPORT_LIMITS,
  GifBudgetError,
  decodeGifFinishPayload,
  encodeBytesToBase64,
  getBoundedGifFrameCount,
  getGifFramePixels,
  nextGifBudgetSnapshot,
} from '@/common/gif-transport';
import {
  startAutoCapture,
  stopAutoCapture,
  isAutoCaptureActive,
  getAutoCaptureStatus,
  captureFrameOnAction,
  captureInitialFrame,
  clearAllAutoCapture,
  discardCompletedAutoCapture,
  hasCompletedAutoCapture,
  type ActionMetadata,
  type GifEnhancedRenderingConfig,
} from './gif-auto-capture';
import {
  acquireGifCaptureOwner,
  describeGifCaptureOwner,
  getGifCaptureOwner,
  isGifCaptureOwner,
  releaseGifCaptureOwner,
  type GifCaptureOwner,
} from './gif-capture-owner';
import { encodeGifCanvasFrame } from './gif-frame-transport';
import { getResolvedViewportCoordinates } from './target-resolution';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_FPS = 5;
const DEFAULT_DURATION_MS = 5000;
const DEFAULT_MAX_FRAMES = 50;
const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 600;
const DEFAULT_MAX_COLORS = 256;
const CDP_SESSION_KEY = 'gif-recorder';
const FIXED_CAPTURE_TTL_GRACE_MS = 15_000;

// ============================================================================
// Types
// ============================================================================

type GifRecorderAction =
  | 'start'
  | 'stop'
  | 'status'
  | 'auto_start'
  | 'capture'
  | 'clear'
  | 'export';

interface GifRecorderParams {
  action: GifRecorderAction;
  tabId?: number;
  fps?: number;
  durationMs?: number;
  maxFrames?: number;
  width?: number;
  height?: number;
  maxColors?: number;
  filename?: string;
  // Auto-capture mode specific
  captureDelayMs?: number;
  frameDelayCs?: number;
  enhancedRendering?: GifEnhancedRenderingConfig;
  // Manual annotation for action="capture"
  annotation?: string;
  // Export action specific
  download?: boolean; // true to download, false to upload via drag&drop
  coordinates?: { x: number; y: number }; // target position for drag&drop upload
  ref?: string; // element ref for drag&drop upload (alternative to coordinates)
  selector?: string; // CSS selector for drag&drop upload (alternative to coordinates)
}

interface RecordingState {
  owner: GifCaptureOwner;
  recordingId: string;
  isRecording: boolean;
  isStopping: boolean;
  tabId: number;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  frameIntervalMs: number;
  frameDelayCs: number;
  maxFrames: number;
  maxColors: number;
  frameCount: number;
  totalPixels: number;
  totalInputBytes: number;
  budgetExhausted: boolean;
  startTime: number;
  captureTimer: ReturnType<typeof setTimeout> | null;
  ttlTimer: ReturnType<typeof setTimeout> | null;
  captureInProgress: Promise<void> | null;
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  filename?: string;
}

interface GifResult {
  success: boolean;
  action: GifRecorderAction;
  tabId?: number;
  frameCount?: number;
  durationMs?: number;
  byteLength?: number;
  downloadId?: number;
  filename?: string;
  pathRedacted?: boolean;
  isRecording?: boolean;
  mode?: 'fixed_fps' | 'auto_capture';
  actionsCount?: number;
  error?: string;
  // Clear action specific
  clearedAutoCapture?: boolean;
  clearedFixedFps?: boolean;
  clearedCache?: boolean;
  // Export action specific (drag&drop upload)
  uploadTarget?: {
    x: number;
    y: number;
    tagName?: string;
    id?: string;
  };
}

function hasDisallowedPublicPageScheme(url: string): boolean {
  const match = url.trim().match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
  if (!match) {
    return false;
  }

  const protocol = match[1]?.toLowerCase();
  return protocol !== 'http' && protocol !== 'https';
}

// ============================================================================
// Recording State Management
// ============================================================================

let recordingState: RecordingState | null = null;
let stopPromise: Promise<GifResult> | null = null;

// Auto-capture mode state
interface AutoCaptureMetadata {
  tabId: number;
  filename?: string;
}
let autoCaptureMetadata: AutoCaptureMetadata | null = null;

// Last recorded GIF cache for export
interface ExportableGif {
  gifData: Uint8Array;
  width: number;
  height: number;
  frameCount: number;
  durationMs: number;
  tabId: number;
  filename?: string;
  actionsCount?: number;
  mode: 'fixed_fps' | 'auto_capture';
  createdAt: number;
}
let lastRecordedGif: ExportableGif | null = null;

// Maximum cache lifetime for exportable GIF (5 minutes)
const EXPORT_CACHE_LIFETIME_MS = 5 * 60 * 1000;

// ============================================================================
// Offscreen Document Communication
// ============================================================================

type OffscreenResponseBase = {
  success: boolean;
  error?: string;
  recordingId?: string;
  operationId?: string;
};

function isIdempotentGifOperation(type: OffscreenMessageType): boolean {
  return (
    type === OFFSCREEN_MESSAGE_TYPES.GIF_START ||
    type === OFFSCREEN_MESSAGE_TYPES.GIF_ADD_FRAME ||
    type === OFFSCREEN_MESSAGE_TYPES.GIF_FINISH ||
    type === OFFSCREEN_MESSAGE_TYPES.GIF_RESET
  );
}

async function sendToOffscreen<TResponse extends OffscreenResponseBase>(
  type: OffscreenMessageType,
  payload: Record<string, unknown> = {},
): Promise<TResponse> {
  await offscreenManager.ensureOffscreenDocument();

  const message = {
    target: MessageTarget.Offscreen,
    type,
    ...payload,
  };
  const maxAttempts = isIdempotentGifOperation(type) ? 3 : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: TResponse | undefined;
    try {
      response = (await chrome.runtime.sendMessage(message)) as
        | TResponse
        | undefined;
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        continue;
      }
      throw error;
    }

    if (!response) {
      lastError = new Error('No response received from offscreen document');
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
        continue;
      }
      throw lastError;
    }
    // Explicit encoder failures are deterministic and must not be retried.
    if (!response.success) {
      throw new Error(response.error || 'Unknown offscreen error');
    }
    if (
      response.recordingId !== undefined &&
      response.recordingId !== payload.recordingId
    ) {
      throw new Error('Offscreen GIF response recordingId mismatch');
    }
    if (
      response.operationId !== undefined &&
      response.operationId !== payload.operationId
    ) {
      throw new Error('Offscreen GIF response operationId mismatch');
    }
    return response;
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isActiveFixedState(state: RecordingState): boolean {
  return (
    recordingState === state &&
    state.isRecording &&
    !state.isStopping &&
    isGifCaptureOwner(state.owner)
  );
}

function clearFixedTimers(state: RecordingState): void {
  if (state.captureTimer) {
    clearTimeout(state.captureTimer);
    state.captureTimer = null;
  }
  if (state.ttlTimer) {
    clearTimeout(state.ttlTimer);
    state.ttlTimer = null;
  }
}

async function resetFixedEncoderBestEffort(recordingId: string): Promise<void> {
  try {
    await sendToOffscreen(OFFSCREEN_MESSAGE_TYPES.GIF_RESET, {
      recordingId,
      operationId: createGifOperationId(recordingId, 'reset'),
    });
  } catch {
    // Owner/CDP cleanup must continue even if the offscreen document is gone.
  }
}

async function discardFixedRecording(state: RecordingState): Promise<void> {
  if (recordingState !== state) return;
  if (stopPromise) {
    await stopPromise.catch(() => undefined);
    return;
  }

  state.isRecording = false;
  state.isStopping = true;
  clearFixedTimers(state);
  recordingState = null;

  try {
    await state.captureInProgress;
  } catch {
    // Ignore an interrupted frame.
  }
  await resetFixedEncoderBestEffort(state.recordingId);
  try {
    await cdpSessionManager.detach(state.tabId, CDP_SESSION_KEY);
  } catch {
    // Ignore cleanup errors.
  }
  releaseGifCaptureOwner(state.owner);
}

// ============================================================================
// Frame Capture
// ============================================================================

async function captureFrame(
  tabId: number,
  width: number,
  height: number,
  ctx: OffscreenCanvasRenderingContext2D,
): Promise<void> {
  // Get viewport metrics
  const metrics: {
    layoutViewport?: { clientWidth: number; clientHeight: number };
  } = await cdpSessionManager.sendCommand(tabId, 'Page.getLayoutMetrics', {});

  const viewportWidth = metrics.layoutViewport?.clientWidth || width;
  const viewportHeight = metrics.layoutViewport?.clientHeight || height;

  // Capture screenshot
  const screenshot: { data: string } = await cdpSessionManager.sendCommand(
    tabId,
    'Page.captureScreenshot',
    {
      format: 'png',
      clip: {
        x: 0,
        y: 0,
        width: viewportWidth,
        height: viewportHeight,
        scale: 1,
      },
    },
  );

  const imageBitmap = await createImageBitmapFromUrl(
    `data:image/png;base64,${screenshot.data}`,
  );

  try {
    // Scale image to target dimensions
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(imageBitmap, 0, 0, width, height);
  } finally {
    imageBitmap.close();
  }
}

async function captureAndEncodeFrame(state: RecordingState): Promise<void> {
  if (!isActiveFixedState(state) || state.frameCount >= state.maxFrames) return;

  try {
    await captureFrame(state.tabId, state.width, state.height, state.ctx);
    if (!isActiveFixedState(state)) return;

    const frame = await encodeGifCanvasFrame(
      state.canvas,
      state.ctx,
      state.width,
      state.height,
    );
    if (recordingState !== state || !isGifCaptureOwner(state.owner)) return;
    const nextBudget = nextGifBudgetSnapshot(
      state,
      state.width,
      state.height,
      frame.inputBytes,
    );
    try {
      const sequence = state.frameCount;
      await sendToOffscreen(OFFSCREEN_MESSAGE_TYPES.GIF_ADD_FRAME, {
        recordingId: state.recordingId,
        sequence,
        operationId: createGifFrameOperationId(state.recordingId, sequence),
        protocolVersion: 2,
        frameBase64: frame.frameBase64,
        frameEncoding: frame.frameEncoding,
        frameByteLength: frame.inputBytes,
        width: state.width,
        height: state.height,
        delay: state.frameDelayCs,
        maxColors: state.maxColors,
      });
    } catch (error) {
      state.budgetExhausted = true;
      throw error;
    }

    if (recordingState === state && isGifCaptureOwner(state.owner)) {
      state.frameCount = nextBudget.frameCount;
      state.totalPixels = nextBudget.totalPixels;
      state.totalInputBytes = nextBudget.totalInputBytes;
    }
  } catch (error) {
    if (error instanceof GifBudgetError) state.budgetExhausted = true;
    throw error;
  }
}

async function captureTick(state: RecordingState): Promise<void> {
  if (!isActiveFixedState(state)) {
    return;
  }

  const elapsed = Date.now() - state.startTime;
  if (
    elapsed >= state.durationMs ||
    state.frameCount >= state.maxFrames ||
    state.budgetExhausted
  ) {
    await stopRecording();
    return;
  }

  const startedAt = Date.now();
  state.captureInProgress = captureAndEncodeFrame(state);

  try {
    await state.captureInProgress;
  } catch (error) {
    console.error('Frame capture error:', error);
  } finally {
    if (recordingState === state) {
      state.captureInProgress = null;
    }
  }

  if (!isActiveFixedState(state)) {
    return;
  }

  const elapsedAfter = Date.now() - state.startTime;
  if (
    elapsedAfter >= state.durationMs ||
    state.frameCount >= state.maxFrames ||
    state.budgetExhausted
  ) {
    await stopRecording();
    return;
  }

  const delayMs = Math.max(0, state.frameIntervalMs - (Date.now() - startedAt));
  state.captureTimer = setTimeout(() => {
    void captureTick(state).catch((error) => {
      console.error('GIF recorder tick error:', error);
    });
  }, delayMs);
}

// ============================================================================
// Recording Control
// ============================================================================

async function startRecording(
  tabId: number,
  fps: number,
  durationMs: number,
  maxFrames: number,
  width: number,
  height: number,
  maxColors: number,
  filename?: string,
): Promise<GifResult> {
  let boundedMaxFrames: number;
  try {
    getGifFramePixels(width, height);
    boundedMaxFrames = getBoundedGifFrameCount(width, height, maxFrames);
  } catch (error) {
    return {
      success: false,
      action: 'start',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const acquisition = acquireGifCaptureOwner('fixed_fps', tabId);
  if (!acquisition.ok) {
    return {
      success: false,
      action: 'start',
      error: describeGifCaptureOwner(acquisition.owner),
    };
  }
  const owner = acquisition.owner;
  const recordingId = createGifRecordingId();

  let attached = false;
  try {
    await cdpSessionManager.attach(tabId, CDP_SESSION_KEY);
    attached = true;
  } catch (error) {
    releaseGifCaptureOwner(owner);
    return {
      success: false,
      action: 'start',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    await sendToOffscreen(OFFSCREEN_MESSAGE_TYPES.GIF_START, {
      recordingId,
      operationId: createGifOperationId(recordingId, 'start'),
    });

    if (typeof OffscreenCanvas === 'undefined') {
      throw new Error('OffscreenCanvas not available in this context');
    }

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    const frameIntervalMs = Math.round(1000 / fps);
    const frameDelayCs = Math.max(1, Math.round(100 / fps));

    const state: RecordingState = {
      owner,
      recordingId,
      isRecording: true,
      isStopping: false,
      tabId,
      width,
      height,
      fps,
      durationMs,
      frameIntervalMs,
      frameDelayCs,
      maxFrames: boundedMaxFrames,
      maxColors,
      frameCount: 0,
      totalPixels: 0,
      totalInputBytes: 0,
      budgetExhausted: false,
      startTime: Date.now(),
      captureTimer: null,
      ttlTimer: null,
      captureInProgress: null,
      canvas,
      ctx,
      filename,
    };

    recordingState = state;

    // Capture first frame eagerly so start() fails fast if capture/encoding is broken
    await captureAndEncodeFrame(state);

    state.captureTimer = setTimeout(() => {
      void captureTick(state).catch((error) => {
        console.error('GIF recorder tick error:', error);
      });
    }, frameIntervalMs);
    state.ttlTimer = setTimeout(() => {
      void discardFixedRecording(state).catch((error) => {
        console.error('GIF recorder TTL cleanup failed:', error);
      });
    }, durationMs + FIXED_CAPTURE_TTL_GRACE_MS);

    return {
      success: true,
      action: 'start',
      tabId,
      isRecording: true,
    };
  } catch (error) {
    if (recordingState?.owner === owner) {
      clearFixedTimers(recordingState);
      recordingState = null;
    }
    await resetFixedEncoderBestEffort(recordingId);
    if (attached) {
      try {
        await cdpSessionManager.detach(tabId, CDP_SESSION_KEY);
      } catch {
        // ignore
      }
    }
    releaseGifCaptureOwner(owner);
    return {
      success: false,
      action: 'start',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function stopRecording(): Promise<GifResult> {
  if (stopPromise) {
    return stopPromise;
  }

  if (
    !recordingState ||
    (!recordingState.isRecording && !recordingState.isStopping)
  ) {
    return {
      success: false,
      action: 'stop',
      error: 'No recording in progress',
    };
  }

  stopPromise = (async () => {
    const state = recordingState!;
    const tabId = state.tabId;

    clearFixedTimers(state);

    state.isStopping = true;
    state.isRecording = false;
    let encoderFinalized = false;

    try {
      await state.captureInProgress;
    } catch {
      // ignore
    }

    // Best-effort final frame capture to preserve end state without exceeding budgets.
    if (!state.budgetExhausted && state.frameCount < state.maxFrames) {
      try {
        await captureFrame(state.tabId, state.width, state.height, state.ctx);
        if (!isGifCaptureOwner(state.owner)) {
          throw new Error('GIF capture owner changed while stopping');
        }
        const frame = await encodeGifCanvasFrame(
          state.canvas,
          state.ctx,
          state.width,
          state.height,
        );
        const nextBudget = nextGifBudgetSnapshot(
          state,
          state.width,
          state.height,
          frame.inputBytes,
        );
        const sequence = state.frameCount;
        await sendToOffscreen(OFFSCREEN_MESSAGE_TYPES.GIF_ADD_FRAME, {
          recordingId: state.recordingId,
          sequence,
          operationId: createGifFrameOperationId(state.recordingId, sequence),
          protocolVersion: 2,
          frameBase64: frame.frameBase64,
          frameEncoding: frame.frameEncoding,
          frameByteLength: frame.inputBytes,
          width: state.width,
          height: state.height,
          delay: state.frameDelayCs,
          maxColors: state.maxColors,
        });
        state.frameCount = nextBudget.frameCount;
        state.totalPixels = nextBudget.totalPixels;
        state.totalInputBytes = nextBudget.totalInputBytes;
      } catch (error) {
        if (error instanceof GifBudgetError) state.budgetExhausted = true;
        console.warn(
          'GIF recorder: Final frame capture error (non-fatal):',
          error,
        );
      }
    }

    const frameCount = state.frameCount;
    const durationMs = Date.now() - state.startTime;
    const filename = state.filename;

    try {
      if (frameCount <= 0) {
        try {
          await resetFixedEncoderBestEffort(state.recordingId);
        } catch {
          // ignore
        }
        return {
          success: false,
          action: 'stop' as const,
          tabId,
          frameCount,
          durationMs,
          error: 'No frames captured',
        };
      }

      const response = await sendToOffscreen<{
        success: boolean;
        gifBase64?: string;
        gifData?: number[];
        byteLength?: number;
      }>(OFFSCREEN_MESSAGE_TYPES.GIF_FINISH, {
        recordingId: state.recordingId,
        operationId: createGifOperationId(state.recordingId, 'finish'),
      });
      encoderFinalized = true;
      const gifBytes = decodeGifFinishPayload(response);

      // Cache for later export
      lastRecordedGif = {
        gifData: gifBytes,
        width: state.width,
        height: state.height,
        frameCount,
        durationMs,
        tabId,
        filename,
        mode: 'fixed_fps',
        createdAt: Date.now(),
      };

      const blob = new Blob([toBlobArrayBuffer(gifBytes)], {
        type: 'image/gif',
      });
      const dataUrl = await blobToDataUrl(blob);

      // Save GIF file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputFilename =
        filename?.replace(/[^a-z0-9_-]/gi, '_') || `recording_${timestamp}`;
      const fullFilename = outputFilename.endsWith('.gif')
        ? outputFilename
        : `${outputFilename}.gif`;

      const downloadId = await chrome.downloads.download({
        url: dataUrl,
        filename: fullFilename,
        saveAs: false,
      });

      return {
        success: true,
        action: 'stop' as const,
        tabId,
        frameCount,
        durationMs,
        byteLength: gifBytes.byteLength,
        downloadId,
        ...toPublicDownloadLocation({ filename: fullFilename }),
      };
    } catch (error) {
      return {
        success: false,
        action: 'stop' as const,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (!encoderFinalized) {
        await resetFixedEncoderBestEffort(state.recordingId);
      }
      try {
        await cdpSessionManager.detach(tabId, CDP_SESSION_KEY);
      } catch {
        // ignore
      }
      if (recordingState === state) recordingState = null;
      releaseGifCaptureOwner(state.owner);
    }
  })();

  return await stopPromise.finally(() => {
    stopPromise = null;
  });
}

function getRecordingStatus(): GifResult {
  if (!recordingState) {
    return {
      success: true,
      action: 'status',
      isRecording: false,
    };
  }

  return {
    success: true,
    action: 'status',
    isRecording: recordingState.isRecording,
    tabId: recordingState.tabId,
    frameCount: recordingState.frameCount,
    durationMs: Date.now() - recordingState.startTime,
  };
}

// ============================================================================
// Utilities
// ============================================================================

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

function toBlobArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes;
  if (buffer instanceof ArrayBuffer) {
    return buffer.slice(byteOffset, byteOffset + byteLength);
  }

  const copy = new Uint8Array(byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function normalizePositiveInt(
  value: unknown,
  fallback: number,
  max?: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const result = Math.max(1, Math.floor(value));
  return max !== undefined ? Math.min(result, max) : result;
}

// ============================================================================
// Tool Implementation
// ============================================================================

class GifRecorderTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GIF_RECORDER;

  async execute(args: GifRecorderParams): Promise<ToolResult> {
    const action = args.action;
    const validActions = [
      'start',
      'stop',
      'status',
      'auto_start',
      'capture',
      'clear',
      'export',
    ];

    if (!action || !validActions.includes(action)) {
      return createErrorResponse(
        `Parameter [action] is required and must be one of: ${validActions.join(', ')}`,
      );
    }

    try {
      switch (action) {
        case 'start': {
          // Fixed-FPS mode: captures frames at regular intervals
          const tab = await this.resolveTargetTab(args.tabId);
          if (!tab?.id) {
            return createErrorResponse(
              typeof args.tabId === 'number'
                ? `Tab not found: ${args.tabId}`
                : 'No active tab found',
            );
          }

          if (this.isRestrictedUrl(tab.url)) {
            return createErrorResponse(
              'Cannot record special browser pages or web store pages due to security restrictions.',
            );
          }
          if (hasDisallowedPublicPageScheme(String(tab.url || ''))) {
            return createErrorResponse(
              'Only http:// and https:// pages are supported by chrome_gif_recorder recording actions.',
            );
          }

          // Check if auto-capture is active
          if (isAutoCaptureActive(tab.id)) {
            return createErrorResponse(
              'Auto-capture mode is active for this tab. Use action="stop" to stop it first.',
            );
          }

          const fps = normalizePositiveInt(args.fps, DEFAULT_FPS, 30);
          const durationMs = normalizePositiveInt(
            args.durationMs,
            DEFAULT_DURATION_MS,
            60000,
          );
          const maxFrames = normalizePositiveInt(
            args.maxFrames,
            DEFAULT_MAX_FRAMES,
            300,
          );
          const width = normalizePositiveInt(args.width, DEFAULT_WIDTH, 1920);
          const height = normalizePositiveInt(
            args.height,
            DEFAULT_HEIGHT,
            1080,
          );
          const maxColors = normalizePositiveInt(
            args.maxColors,
            DEFAULT_MAX_COLORS,
            256,
          );

          const result = await startRecording(
            tab.id,
            fps,
            durationMs,
            maxFrames,
            width,
            height,
            maxColors,
            args.filename,
          );

          if (result.success) {
            result.mode = 'fixed_fps';
            autoCaptureMetadata = null;
            discardCompletedAutoCapture();
          }

          return this.buildResponse(result);
        }

        case 'auto_start': {
          // Auto-capture mode: captures frames when tools succeed
          const tab = await this.resolveTargetTab(args.tabId);
          if (!tab?.id) {
            return createErrorResponse(
              typeof args.tabId === 'number'
                ? `Tab not found: ${args.tabId}`
                : 'No active tab found',
            );
          }

          if (this.isRestrictedUrl(tab.url)) {
            return createErrorResponse(
              'Cannot record special browser pages or web store pages due to security restrictions.',
            );
          }
          if (hasDisallowedPublicPageScheme(String(tab.url || ''))) {
            return createErrorResponse(
              'Only http:// and https:// pages are supported by chrome_gif_recorder recording actions.',
            );
          }

          // Check if fixed-FPS recording is active
          if (recordingState?.isRecording && recordingState.tabId === tab.id) {
            return createErrorResponse(
              'Fixed-FPS recording is active for this tab. Use action="stop" to stop it first.',
            );
          }

          // Check if auto-capture is already active
          if (isAutoCaptureActive(tab.id)) {
            return createErrorResponse(
              'Auto-capture is already active for this tab.',
            );
          }

          const width = normalizePositiveInt(args.width, DEFAULT_WIDTH, 1920);
          const height = normalizePositiveInt(
            args.height,
            DEFAULT_HEIGHT,
            1080,
          );
          const maxColors = normalizePositiveInt(
            args.maxColors,
            DEFAULT_MAX_COLORS,
            256,
          );
          const maxFrames = normalizePositiveInt(args.maxFrames, 100, 300);
          const captureDelayMs = normalizePositiveInt(
            args.captureDelayMs,
            150,
            2000,
          );
          const frameDelayCs = normalizePositiveInt(args.frameDelayCs, 20, 100);

          const startResult = await startAutoCapture(tab.id, {
            width,
            height,
            maxColors,
            maxFrames,
            captureDelayMs,
            frameDelayCs,
            enhancedRendering: args.enhancedRendering,
          });

          if (!startResult.success) {
            return this.buildResponse({
              success: false,
              action: 'auto_start',
              tabId: tab.id,
              error: startResult.error,
            });
          }

          // Store metadata for stop
          autoCaptureMetadata = {
            tabId: tab.id,
            filename: args.filename,
          };

          // Capture initial frame
          const initialCapture = await captureInitialFrame(tab.id);
          if (!initialCapture.success) {
            await clearAllAutoCapture();
            autoCaptureMetadata = null;
            return this.buildResponse({
              success: false,
              action: 'auto_start',
              tabId: tab.id,
              error:
                initialCapture.error || 'Failed to capture initial GIF frame',
            });
          }

          return this.buildResponse({
            success: true,
            action: 'auto_start',
            tabId: tab.id,
            mode: 'auto_capture',
            isRecording: isAutoCaptureActive(tab.id),
          });
        }

        case 'capture': {
          // Manual frame capture in auto mode
          const tab = await this.resolveTargetTab(args.tabId);
          if (!tab?.id) {
            return createErrorResponse(
              typeof args.tabId === 'number'
                ? `Tab not found: ${args.tabId}`
                : 'No active tab found',
            );
          }

          if (!isAutoCaptureActive(tab.id)) {
            return createErrorResponse(
              'Auto-capture is not active for this tab. Use action="auto_start" first.',
            );
          }
          if (hasDisallowedPublicPageScheme(String(tab.url || ''))) {
            return createErrorResponse(
              'Only http:// and https:// pages are supported by chrome_gif_recorder recording actions.',
            );
          }

          // Support optional annotation for manual captures
          const annotation =
            typeof args.annotation === 'string' &&
            args.annotation.trim().length > 0
              ? args.annotation.trim()
              : undefined;

          const action: ActionMetadata | undefined = annotation
            ? { type: 'annotation', label: annotation }
            : undefined;

          const captureResult = await captureFrameOnAction(
            tab.id,
            action,
            true,
          );

          return this.buildResponse({
            success: captureResult.success,
            action: 'capture',
            tabId: tab.id,
            frameCount: captureResult.frameNumber,
            error: captureResult.error,
          });
        }

        case 'stop': {
          // Stop either mode
          const owner = getGifCaptureOwner();
          const autoTab =
            owner?.mode === 'auto_capture'
              ? owner.tabId
              : autoCaptureMetadata?.tabId;
          const shouldStopAuto =
            owner?.mode === 'auto_capture' ||
            (!owner &&
              autoTab !== undefined &&
              hasCompletedAutoCapture(autoTab));
          if (autoTab !== undefined && shouldStopAuto) {
            const stopResult = await stopAutoCapture(autoTab);
            const filename = autoCaptureMetadata?.filename;
            autoCaptureMetadata = null;

            if (!stopResult.success || !stopResult.gifData) {
              return this.buildResponse({
                success: false,
                action: 'stop',
                tabId: autoTab,
                mode: 'auto_capture',
                frameCount: stopResult.frameCount,
                durationMs: stopResult.durationMs,
                actionsCount: stopResult.actions?.length,
                error: stopResult.error || 'No GIF data generated',
              });
            }

            // Cache for later export
            lastRecordedGif = {
              gifData: stopResult.gifData,
              width: DEFAULT_WIDTH, // auto mode uses default dimensions
              height: DEFAULT_HEIGHT,
              frameCount: stopResult.frameCount ?? 0,
              durationMs: stopResult.durationMs ?? 0,
              tabId: autoTab,
              filename,
              actionsCount: stopResult.actions?.length,
              mode: 'auto_capture',
              createdAt: Date.now(),
            };

            // Save GIF file
            const blob = new Blob([toBlobArrayBuffer(stopResult.gifData)], {
              type: 'image/gif',
            });
            const dataUrl = await blobToDataUrl(blob);

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const outputFilename =
              filename?.replace(/[^a-z0-9_-]/gi, '_') ||
              `recording_${timestamp}`;
            const fullFilename = outputFilename.endsWith('.gif')
              ? outputFilename
              : `${outputFilename}.gif`;

            const downloadId = await chrome.downloads.download({
              url: dataUrl,
              filename: fullFilename,
              saveAs: false,
            });

            return this.buildResponse({
              success: true,
              action: 'stop',
              tabId: autoTab,
              mode: 'auto_capture',
              frameCount: stopResult.frameCount,
              durationMs: stopResult.durationMs,
              byteLength: stopResult.gifData.byteLength,
              actionsCount: stopResult.actions?.length,
              downloadId,
              ...toPublicDownloadLocation({ filename: fullFilename }),
            });
          }

          // Fall back to fixed-FPS stop
          const result = await stopRecording();
          if (result.success) {
            result.mode = 'fixed_fps';
          }
          return this.buildResponse(result);
        }

        case 'status': {
          const owner = getGifCaptureOwner();
          const autoTab =
            owner?.mode === 'auto_capture'
              ? owner.tabId
              : autoCaptureMetadata?.tabId;
          if (autoTab !== undefined && owner?.mode === 'auto_capture') {
            const status = getAutoCaptureStatus(autoTab);
            return this.buildResponse({
              success: true,
              action: 'status',
              tabId: autoTab,
              isRecording: status.active,
              mode: 'auto_capture',
              frameCount: status.frameCount,
              durationMs: status.durationMs,
              actionsCount: status.actionsCount,
            });
          }
          if (
            !owner &&
            autoTab !== undefined &&
            hasCompletedAutoCapture(autoTab)
          ) {
            return this.buildResponse({
              success: true,
              action: 'status',
              tabId: autoTab,
              isRecording: false,
              mode: 'auto_capture',
            });
          }

          // Fall back to fixed-FPS status
          const result = getRecordingStatus();
          if (result.isRecording) {
            result.mode = 'fixed_fps';
          }
          return this.buildResponse(result);
        }

        case 'clear': {
          // Clear all recording state and cached GIF
          let clearedAuto = false;
          let clearedFixedFps = false;
          let clearedCache = false;

          const owner = getGifCaptureOwner();
          const autoTab = autoCaptureMetadata?.tabId;
          clearedAuto =
            owner?.mode === 'auto_capture' ||
            (autoTab !== undefined && hasCompletedAutoCapture(autoTab));
          await clearAllAutoCapture();
          autoCaptureMetadata = null;

          // Stop fixed-FPS recording if active or stopping
          if (recordingState) {
            const wasRecording =
              recordingState.isRecording || recordingState.isStopping;
            await discardFixedRecording(recordingState);
            if (wasRecording) {
              clearedFixedFps = true;
            }
          }

          // Clear cached GIF
          if (lastRecordedGif) {
            lastRecordedGif = null;
            clearedCache = true;
          }

          return this.buildResponse({
            success: true,
            action: 'clear',
            clearedAutoCapture: clearedAuto,
            clearedFixedFps,
            clearedCache,
          } as GifResult);
        }

        case 'export': {
          // Export the last recorded GIF (download or drag&drop upload)

          // Check if cache is valid
          if (!lastRecordedGif) {
            return createErrorResponse(
              'No recorded GIF available for export. Use action="stop" to finish a recording first.',
            );
          }

          // Check cache expiration
          if (
            Date.now() - lastRecordedGif.createdAt >
            EXPORT_CACHE_LIFETIME_MS
          ) {
            lastRecordedGif = null;
            return createErrorResponse(
              'Cached GIF has expired. Please record a new GIF.',
            );
          }

          const download = args.download !== false; // Default to download

          if (download) {
            // Download mode
            const blob = new Blob(
              [toBlobArrayBuffer(lastRecordedGif.gifData)],
              { type: 'image/gif' },
            );
            const dataUrl = await blobToDataUrl(blob);

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = args.filename ?? lastRecordedGif.filename;
            const outputFilename =
              filename?.replace(/[^a-z0-9_-]/gi, '_') || `export_${timestamp}`;
            const fullFilename = outputFilename.endsWith('.gif')
              ? outputFilename
              : `${outputFilename}.gif`;

            const downloadId = await chrome.downloads.download({
              url: dataUrl,
              filename: fullFilename,
              saveAs: false,
            });

            return this.buildResponse({
              success: true,
              action: 'export',
              mode: lastRecordedGif.mode,
              frameCount: lastRecordedGif.frameCount,
              durationMs: lastRecordedGif.durationMs,
              byteLength: lastRecordedGif.gifData.byteLength,
              downloadId,
              ...toPublicDownloadLocation({ filename: fullFilename }),
            });
          } else {
            // Drag&drop upload mode
            const { coordinates, ref, selector } = args;

            if (!coordinates && !ref && !selector) {
              return createErrorResponse(
                'For drag&drop upload, provide coordinates, ref, or selector to identify the drop target.',
              );
            }

            // Resolve target tab
            const tab = await this.resolveTargetTab(args.tabId);
            if (!tab?.id) {
              return createErrorResponse(
                typeof args.tabId === 'number'
                  ? `Tab not found: ${args.tabId}`
                  : 'No active tab found',
              );
            }

            // Security check
            if (this.isRestrictedUrl(tab.url)) {
              return createErrorResponse(
                'Cannot upload to special browser pages or web store pages.',
              );
            }
            if (hasDisallowedPublicPageScheme(String(tab.url || ''))) {
              return createErrorResponse(
                'Only http:// and https:// pages are supported for chrome_gif_recorder drag-and-drop export.',
              );
            }

            // Prepare GIF data as base64
            const gifBase64 = encodeBytesToBase64(
              lastRecordedGif.gifData,
              GIF_TRANSPORT_LIMITS.maxOutputBytes,
              'Encoded GIF output',
            );

            // Resolve drop target coordinates
            let targetX: number | undefined;
            let targetY: number | undefined;

            if (ref) {
              // Use the project's built-in ref resolution mechanism
              try {
                await this.injectContentScript(tab.id, [
                  'inject-scripts/accessibility-tree-helper.js',
                ]);
                const resolved = await this.sendMessageToTab(tab.id, {
                  action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
                  ref,
                });
                const targetPoint = getResolvedViewportCoordinates(resolved);
                if (resolved?.success && targetPoint) {
                  targetX = targetPoint.x;
                  targetY = targetPoint.y;
                } else {
                  return createErrorResponse(`Could not resolve ref: ${ref}`);
                }
              } catch (err) {
                return createErrorResponse(
                  `Failed to resolve ref: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            } else if (selector) {
              // Use executeScript to get element center coordinates by CSS selector
              try {
                const [result] = await chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  func: (cssSelector: string) => {
                    const el = document.querySelector(cssSelector);
                    if (!el) return null;
                    const rect = el.getBoundingClientRect();
                    return {
                      x: rect.left + rect.width / 2,
                      y: rect.top + rect.height / 2,
                    };
                  },
                  args: [selector],
                });

                if (result?.result) {
                  targetX = result.result.x;
                  targetY = result.result.y;
                } else {
                  return createErrorResponse(
                    `Could not find element: ${selector}`,
                  );
                }
              } catch (err) {
                return createErrorResponse(
                  `Failed to resolve selector: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            } else if (coordinates) {
              targetX = coordinates.x;
              targetY = coordinates.y;
            }

            if (typeof targetX !== 'number' || typeof targetY !== 'number') {
              return createErrorResponse('Invalid drop target coordinates.');
            }

            // Execute drag&drop upload
            try {
              const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
              const filename =
                args.filename ??
                lastRecordedGif.filename ??
                `recording_${timestamp}`;
              const fullFilename = filename.endsWith('.gif')
                ? filename
                : `${filename}.gif`;

              const [result] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: (
                  base64Data: string,
                  x: number,
                  y: number,
                  fname: string,
                ) => {
                  // Convert base64 to Blob
                  const byteChars = atob(base64Data);
                  const byteArray = new Uint8Array(byteChars.length);
                  for (let i = 0; i < byteChars.length; i++) {
                    byteArray[i] = byteChars.charCodeAt(i);
                  }
                  const blob = new Blob([byteArray], { type: 'image/gif' });
                  const file = new File([blob], fname, { type: 'image/gif' });

                  // Find drop target element
                  const target = document.elementFromPoint(x, y);
                  if (!target) {
                    return {
                      success: false,
                      error: 'No element at drop coordinates',
                    };
                  }

                  // Create DataTransfer with the file
                  const dt = new DataTransfer();
                  dt.items.add(file);

                  // Dispatch drag events
                  const events = ['dragenter', 'dragover', 'drop'] as const;
                  for (const eventType of events) {
                    const evt = new DragEvent(eventType, {
                      bubbles: true,
                      cancelable: true,
                      dataTransfer: dt,
                      clientX: x,
                      clientY: y,
                    });
                    target.dispatchEvent(evt);
                  }

                  return {
                    success: true,
                    targetTagName: target.tagName,
                    targetId: target.id || undefined,
                  };
                },
                args: [gifBase64, targetX, targetY, fullFilename],
              });

              if (!result?.result?.success) {
                return createErrorResponse(
                  result?.result?.error || 'Drag&drop upload failed',
                );
              }

              return this.buildResponse({
                success: true,
                action: 'export',
                mode: lastRecordedGif.mode,
                frameCount: lastRecordedGif.frameCount,
                durationMs: lastRecordedGif.durationMs,
                byteLength: lastRecordedGif.gifData.byteLength,
                uploadTarget: {
                  x: targetX,
                  y: targetY,
                  tagName: result.result.targetTagName,
                  id: result.result.targetId,
                },
              } as GifResult);
            } catch (err) {
              return createErrorResponse(
                `Drag&drop upload failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }

        default:
          return createErrorResponse(`Unknown action: ${action}`);
      }
    } catch (error) {
      console.error('GifRecorderTool.execute error:', error);
      return createErrorResponse(
        `GIF recorder error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private isRestrictedUrl(url?: string): boolean {
    if (!url) return false;
    return (
      url.startsWith('chrome://') ||
      url.startsWith('edge://') ||
      url.startsWith('https://chrome.google.com/webstore') ||
      url.startsWith('https://microsoftedge.microsoft.com/')
    );
  }

  private async resolveTargetTab(
    tabId?: number,
  ): Promise<chrome.tabs.Tab | null> {
    if (typeof tabId === 'number') {
      return this.tryGetTab(tabId);
    }
    try {
      return await this.getActiveTabOrThrow();
    } catch {
      return null;
    }
  }

  private buildResponse(result: GifResult): ToolResult {
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: !result.success,
    };
  }
}

export async function cleanupGifRecorderForTab(tabId: number): Promise<void> {
  if (autoCaptureMetadata?.tabId === tabId) autoCaptureMetadata = null;
  const state = recordingState;
  if (state?.tabId === tabId) await discardFixedRecording(state);
}

chrome.tabs?.onRemoved?.addListener((tabId) => {
  void cleanupGifRecorderForTab(tabId).catch((error) => {
    console.error('GIF recorder tab-close cleanup failed:', error);
  });
});

export const gifRecorderTool = new GifRecorderTool();

// Re-export auto-capture utilities for use by other tools (e.g., chrome_computer, chrome_navigate)
export {
  captureFrameOnAction,
  isAutoCaptureActive,
  type ActionMetadata,
  type ActionType,
} from './gif-auto-capture';
