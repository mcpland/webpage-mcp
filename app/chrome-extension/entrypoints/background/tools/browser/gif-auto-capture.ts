/**
 * GIF Auto-Capture Hook System
 *
 * Provides automatic frame capture for GIF recording when browser actions succeed.
 * Tools like chrome_computer and chrome_navigate can trigger frame captures
 * after successful operations, creating smooth recordings of user interactions.
 *
 * Architecture:
 * - Centralized capture manager with per-tab recording state
 * - Hooks can be registered/unregistered per tab
 * - Configurable capture delay for UI stabilization
 * - Enhanced rendering overlays (click indicators, drag paths, labels)
 */

import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { OFFSCREEN_MESSAGE_TYPES, MessageTarget } from '@/common/message-types';
import { offscreenManager } from '@/utils/offscreen-manager';
import { createImageBitmapFromUrl } from '@/utils/image-utils';
import {
  GifBudgetError,
  decodeGifFinishPayload,
  getBoundedGifFrameCount,
  getGifFramePixels,
  nextGifBudgetSnapshot,
} from '@/common/gif-transport';
import {
  acquireGifCaptureOwner,
  describeGifCaptureOwner,
  isGifCaptureOwner,
  releaseGifCaptureOwner,
  type GifCaptureOwner,
} from './gif-capture-owner';
import {
  pruneActionEventsInPlace,
  renderGifEnhancedOverlays,
  resolveCapturePlanForAction,
  resolveGifEnhancedRenderingConfig,
  type ActionEvent,
  type ActionMetadata,
  type ActionType,
  type GifEnhancedRenderingConfig,
  type ResolvedGifEnhancedRenderingConfig,
} from './gif-enhanced-renderer';
import { encodeGifCanvasFrame } from './gif-frame-transport';

// Re-export types for consumers
export type {
  ActionMetadata,
  ActionType,
  GifEnhancedRenderingConfig,
} from './gif-enhanced-renderer';

// ============================================================================
// Constants
// ============================================================================

const CDP_SESSION_KEY = 'gif-auto-capture';
const DEFAULT_CAPTURE_DELAY_MS = 150;
const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 600;
const DEFAULT_FRAME_DELAY_CS = 20; // 20 centiseconds = 200ms per frame
const DEFAULT_MAX_COLORS = 256;
const AUTO_CAPTURE_TTL_MS = 5 * 60 * 1000;
const COMPLETED_CAPTURE_TTL_MS = 5 * 60 * 1000;

// ============================================================================
// Types
// ============================================================================

export interface AutoCaptureConfig {
  width: number;
  height: number;
  maxColors: number;
  frameDelayCs: number;
  captureDelayMs: number;
  maxFrames: number;
  enhancedRendering?: GifEnhancedRenderingConfig;
}

interface TabCaptureState {
  owner: GifCaptureOwner;
  tabId: number;
  config: AutoCaptureConfig;
  rendering: ResolvedGifEnhancedRenderingConfig;
  frameCount: number;
  totalPixels: number;
  totalInputBytes: number;
  budgetExhausted: boolean;
  startTime: number;
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  pendingCapture: Promise<void> | null;
  actions: ActionMetadata[];
  actionEvents: ActionEvent[];
  lastViewportWidth: number;
  lastViewportHeight: number;
  ttlTimer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
  cacheOnFinish: boolean;
  lifecyclePromise: Promise<AutoCaptureResult> | null;
}

export interface AutoCaptureResult {
  success: boolean;
  gifData?: Uint8Array;
  frameCount?: number;
  durationMs?: number;
  actions?: ActionMetadata[];
  error?: string;
}

interface CompletedAutoCapture {
  tabId: number;
  result: AutoCaptureResult;
  expiresTimer: ReturnType<typeof setTimeout>;
}

// ============================================================================
// State Management
// ============================================================================

const tabStates = new Map<number, TabCaptureState>();
let completedAutoCapture: CompletedAutoCapture | null = null;

// ============================================================================
// Utilities
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertIntegerInRange(
  value: number,
  min: number,
  max: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
}

function normalizeActionMetadata(
  action: ActionMetadata,
  atMs: number,
): ActionMetadata {
  const normalized: ActionMetadata = {
    ...action,
    timestampMs: atMs,
    coordinateSpace: action.coordinateSpace ?? 'viewport',
  };

  // For drag, treat `coordinates` as end position (legacy) and also populate `endCoordinates`
  if (normalized.type === 'drag') {
    const end = normalized.endCoordinates ?? normalized.coordinates;
    if (end) {
      normalized.endCoordinates = end;
      normalized.coordinates = end;
    }
  }

  return normalized;
}

// ============================================================================
// Offscreen Communication
// ============================================================================

async function sendToOffscreen<T extends { success: boolean; error?: string }>(
  type: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  await offscreenManager.ensureOffscreenDocument();

  const response = (await chrome.runtime.sendMessage({
    target: MessageTarget.Offscreen,
    type,
    ...payload,
  })) as T | undefined;

  if (!response) {
    throw new Error('No response from offscreen document');
  }
  if (!response.success) {
    throw new Error(response.error || 'Unknown offscreen error');
  }

  return response;
}

function clearCompletedAutoCapture(): void {
  if (!completedAutoCapture) return;
  clearTimeout(completedAutoCapture.expiresTimer);
  completedAutoCapture = null;
}

function rememberCompletedAutoCapture(
  tabId: number,
  result: AutoCaptureResult,
): void {
  clearCompletedAutoCapture();
  const completed: CompletedAutoCapture = {
    tabId,
    result,
    expiresTimer: setTimeout(() => {
      if (completedAutoCapture === completed) completedAutoCapture = null;
    }, COMPLETED_CAPTURE_TTL_MS),
  };
  completedAutoCapture = completed;
}

function takeCompletedAutoCapture(tabId: number): AutoCaptureResult | null {
  if (!completedAutoCapture || completedAutoCapture.tabId !== tabId)
    return null;
  const result = completedAutoCapture.result;
  clearCompletedAutoCapture();
  return result;
}

export function hasCompletedAutoCapture(tabId: number): boolean {
  return completedAutoCapture?.tabId === tabId;
}

export function discardCompletedAutoCapture(): void {
  clearCompletedAutoCapture();
}

function clearAutoCaptureTtl(state: TabCaptureState): void {
  if (!state.ttlTimer) return;
  clearTimeout(state.ttlTimer);
  state.ttlTimer = null;
}

function isActiveAutoCaptureState(state: TabCaptureState): boolean {
  return (
    tabStates.get(state.tabId) === state &&
    !state.stopping &&
    isGifCaptureOwner(state.owner)
  );
}

async function resetEncoderBestEffort(): Promise<void> {
  try {
    await sendToOffscreen(OFFSCREEN_MESSAGE_TYPES.GIF_RESET, {});
  } catch {
    // Cleanup is best-effort; owner/CDP state must still be released.
  }
}

function finalizeAutoCaptureState(
  state: TabCaptureState,
  cacheForLater: boolean,
): Promise<AutoCaptureResult> {
  state.cacheOnFinish ||= cacheForLater;
  if (state.lifecyclePromise) return state.lifecyclePromise;

  state.stopping = true;
  clearAutoCaptureTtl(state);
  state.lifecyclePromise = (async () => {
    let encoderFinalized = false;
    let result: AutoCaptureResult;
    try {
      if (state.pendingCapture) {
        try {
          await state.pendingCapture;
        } catch {
          // Preserve frames already encoded before a capture/budget failure.
        }
      }

      const frameCount = state.frameCount;
      const durationMs = Date.now() - state.startTime;
      const actions = [...state.actions];

      if (frameCount === 0) {
        result = {
          success: false,
          error: 'No frames captured',
          frameCount: 0,
          durationMs,
          actions,
        };
      } else {
        const response = await sendToOffscreen<{
          success: boolean;
          gifBase64?: string;
          gifData?: number[];
          byteLength?: number;
          error?: string;
        }>(OFFSCREEN_MESSAGE_TYPES.GIF_FINISH, {});
        encoderFinalized = true;
        const gifData = decodeGifFinishPayload(response);

        result = {
          success: true,
          gifData,
          frameCount,
          durationMs,
          actions,
        };
      }
    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (tabStates.get(state.tabId) === state) tabStates.delete(state.tabId);
      if (!encoderFinalized) await resetEncoderBestEffort();
      try {
        await cdpSessionManager.detach(state.tabId, CDP_SESSION_KEY);
      } catch {
        // Ignore cleanup errors.
      }
      releaseGifCaptureOwner(state.owner);
    }

    if (state.cacheOnFinish) rememberCompletedAutoCapture(state.tabId, result);
    return result;
  })();

  return state.lifecyclePromise;
}

async function abortAutoCaptureState(state: TabCaptureState): Promise<void> {
  if (state.lifecyclePromise) {
    await state.lifecyclePromise.catch(() => undefined);
    clearCompletedAutoCapture();
    return;
  }

  state.stopping = true;
  clearAutoCaptureTtl(state);
  if (tabStates.get(state.tabId) === state) tabStates.delete(state.tabId);

  try {
    if (state.pendingCapture) await state.pendingCapture;
  } catch {
    // Ignore an interrupted frame.
  }
  await resetEncoderBestEffort();
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

async function renderFrameToCanvas(
  tabId: number,
  state: TabCaptureState,
): Promise<void> {
  const width = state.config.width;
  const height = state.config.height;
  const ctx = state.ctx;

  // Get viewport metrics
  const metrics: {
    layoutViewport?: { clientWidth: number; clientHeight: number };
  } = await cdpSessionManager.sendCommand(tabId, 'Page.getLayoutMetrics', {});

  const viewportWidth = metrics.layoutViewport?.clientWidth || width;
  const viewportHeight = metrics.layoutViewport?.clientHeight || height;

  // Store viewport dimensions for coordinate projection
  state.lastViewportWidth = viewportWidth;
  state.lastViewportHeight = viewportHeight;

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
    // Scale to target dimensions
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(imageBitmap, 0, 0, width, height);
  } finally {
    imageBitmap.close();
  }

  // Apply enhanced rendering overlays
  if (state.rendering.enabled) {
    const nowMs = Date.now();
    renderGifEnhancedOverlays({
      ctx,
      outputWidth: width,
      outputHeight: height,
      viewportWidth,
      viewportHeight,
      nowMs,
      events: state.actionEvents,
      config: state.rendering,
    });
    pruneActionEventsInPlace(state.actionEvents, nowMs, state.rendering);
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Start auto-capture for a tab. This initializes the GIF encoder
 * and prepares for automatic frame capture on tool actions.
 */
export async function startAutoCapture(
  tabId: number,
  config?: Partial<AutoCaptureConfig>,
): Promise<{ success: boolean; error?: string }> {
  let finalConfig: AutoCaptureConfig;
  try {
    const width = config?.width ?? DEFAULT_WIDTH;
    const height = config?.height ?? DEFAULT_HEIGHT;
    const maxColors = config?.maxColors ?? DEFAULT_MAX_COLORS;
    const frameDelayCs = config?.frameDelayCs ?? DEFAULT_FRAME_DELAY_CS;
    const captureDelayMs = config?.captureDelayMs ?? DEFAULT_CAPTURE_DELAY_MS;
    const requestedMaxFrames = config?.maxFrames ?? 100;

    getGifFramePixels(width, height);
    assertIntegerInRange(maxColors, 2, 256, 'GIF maxColors');
    assertIntegerInRange(frameDelayCs, 1, 6_000, 'GIF frameDelayCs');
    assertIntegerInRange(captureDelayMs, 0, 5_000, 'GIF captureDelayMs');
    finalConfig = {
      width,
      height,
      maxColors,
      frameDelayCs,
      captureDelayMs,
      maxFrames: getBoundedGifFrameCount(width, height, requestedMaxFrames),
      enhancedRendering: config?.enhancedRendering,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const acquisition = acquireGifCaptureOwner('auto_capture', tabId);
  if (!acquisition.ok) {
    return {
      success: false,
      error: describeGifCaptureOwner(acquisition.owner),
    };
  }
  const owner = acquisition.owner;
  clearCompletedAutoCapture();

  let attached = false;
  let encoderTouched = false;
  try {
    // Attach CDP session
    await cdpSessionManager.attach(tabId, CDP_SESSION_KEY);
    attached = true;

    // Reset offscreen encoder
    encoderTouched = true;
    await sendToOffscreen(OFFSCREEN_MESSAGE_TYPES.GIF_RESET, {});

    // Create canvas
    if (typeof OffscreenCanvas === 'undefined') {
      throw new Error('OffscreenCanvas not available');
    }

    const canvas = new OffscreenCanvas(finalConfig.width, finalConfig.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    const state: TabCaptureState = {
      owner,
      tabId,
      config: finalConfig,
      rendering: resolveGifEnhancedRenderingConfig(
        finalConfig.enhancedRendering,
      ),
      frameCount: 0,
      totalPixels: 0,
      totalInputBytes: 0,
      budgetExhausted: false,
      startTime: Date.now(),
      canvas,
      ctx,
      pendingCapture: null,
      actions: [],
      actionEvents: [],
      lastViewportWidth: finalConfig.width,
      lastViewportHeight: finalConfig.height,
      ttlTimer: null,
      stopping: false,
      cacheOnFinish: false,
      lifecyclePromise: null,
    };

    tabStates.set(tabId, state);
    state.ttlTimer = setTimeout(() => {
      void finalizeAutoCaptureState(state, true).catch((error) => {
        console.error('[GIF Auto-Capture] TTL cleanup failed:', error);
      });
    }, AUTO_CAPTURE_TTL_MS);

    return { success: true };
  } catch (error) {
    if (encoderTouched) await resetEncoderBestEffort();
    if (attached) {
      try {
        await cdpSessionManager.detach(tabId, CDP_SESSION_KEY);
      } catch {
        // Ignore
      }
    }
    releaseGifCaptureOwner(owner);

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Stop auto-capture and finalize the GIF.
 * Returns the GIF data for saving/downloading.
 */
export async function stopAutoCapture(tabId: number): Promise<{
  success: boolean;
  gifData?: Uint8Array;
  frameCount?: number;
  durationMs?: number;
  actions?: ActionMetadata[];
  error?: string;
}> {
  const state = tabStates.get(tabId);
  if (!state) {
    const completed = takeCompletedAutoCapture(tabId);
    if (completed) return completed;
    return { success: false, error: 'No auto-capture active for this tab' };
  }

  const result = await finalizeAutoCaptureState(state, false);
  clearCompletedAutoCapture();
  return result;
}

/**
 * Check if auto-capture is active for a tab.
 */
export function isAutoCaptureActive(tabId: number): boolean {
  const state = tabStates.get(tabId);
  return !!state && isActiveAutoCaptureState(state);
}

/**
 * Get current auto-capture status for a tab.
 */
export function getAutoCaptureStatus(tabId: number): {
  active: boolean;
  frameCount?: number;
  durationMs?: number;
  actionsCount?: number;
  enhancedRenderingEnabled?: boolean;
} {
  const state = tabStates.get(tabId);
  if (!state || !isActiveAutoCaptureState(state)) {
    return { active: false };
  }

  return {
    active: true,
    frameCount: state.frameCount,
    durationMs: Date.now() - state.startTime,
    actionsCount: state.actions.length,
    enhancedRenderingEnabled: state.rendering.enabled,
  };
}

/**
 * Trigger a frame capture after a successful action.
 * This is the main hook that tools should call.
 *
 * @param tabId - The tab to capture
 * @param action - Optional action metadata for overlay rendering
 * @param immediate - If true, capture immediately without delay
 */
export async function captureFrameOnAction(
  tabId: number,
  action?: ActionMetadata,
  immediate = false,
): Promise<{ success: boolean; frameNumber?: number; error?: string }> {
  const state = tabStates.get(tabId);
  if (!state || !isActiveAutoCaptureState(state)) {
    // No auto-capture active - silently succeed (tools shouldn't fail because recording isn't active)
    return { success: true };
  }

  // Check frame limit
  if (state.frameCount >= state.config.maxFrames) {
    await finalizeAutoCaptureState(state, true);
    return { success: false, error: 'Max frame limit reached' };
  }

  // Wait for any pending capture to complete
  if (state.pendingCapture) {
    try {
      await state.pendingCapture;
    } catch {
      // Ignore errors from previous capture
    }
  }

  // Verify state still exists (might have been stopped while awaiting)
  const currentState = tabStates.get(tabId);
  if (!currentState || !isActiveAutoCaptureState(currentState)) {
    return { success: true };
  }

  // Calculate delay for UI stabilization
  const delayMs = immediate ? 0 : currentState.config.captureDelayMs;

  // Normalize and record action metadata
  let normalizedAction: ActionMetadata | undefined;
  if (action) {
    const atMs = Date.now() + delayMs;
    normalizedAction = normalizeActionMetadata(action, atMs);
    currentState.actions.push(normalizedAction);
    currentState.actionEvents.push({ action: normalizedAction, atMs });
  }

  // Determine capture plan (may involve multiple frames for click animations)
  const plan = resolveCapturePlanForAction(
    currentState.rendering,
    normalizedAction,
    currentState.config.frameDelayCs,
  );

  const capturePromise = (async () => {
    if (delayMs > 0) await sleep(delayMs);

    for (let i = 0; i < plan.frames; i++) {
      const activeState = tabStates.get(tabId);
      if (!activeState || !isActiveAutoCaptureState(activeState)) return;

      if (activeState.frameCount >= activeState.config.maxFrames) return;

      try {
        await renderFrameToCanvas(tabId, activeState);
        if (!isActiveAutoCaptureState(activeState)) return;

        const frame = await encodeGifCanvasFrame(
          activeState.canvas,
          activeState.ctx,
          activeState.config.width,
          activeState.config.height,
        );
        if (!isActiveAutoCaptureState(activeState)) return;
        const nextBudget = nextGifBudgetSnapshot(
          activeState,
          activeState.config.width,
          activeState.config.height,
          frame.inputBytes,
        );

        // Use animation delay for intermediate frames, regular delay for final frame
        const delayCs =
          i < plan.frames - 1 ? plan.delayCs : activeState.config.frameDelayCs;

        try {
          await sendToOffscreen(OFFSCREEN_MESSAGE_TYPES.GIF_ADD_FRAME, {
            protocolVersion: 2,
            frameBase64: frame.frameBase64,
            frameEncoding: frame.frameEncoding,
            frameByteLength: frame.inputBytes,
            width: activeState.config.width,
            height: activeState.config.height,
            delay: delayCs,
            maxColors: activeState.config.maxColors,
          });
        } catch (error) {
          activeState.budgetExhausted = true;
          throw error;
        }

        if (
          tabStates.get(tabId) === activeState &&
          isGifCaptureOwner(activeState.owner)
        ) {
          activeState.frameCount = nextBudget.frameCount;
          activeState.totalPixels = nextBudget.totalPixels;
          activeState.totalInputBytes = nextBudget.totalInputBytes;
        }
      } catch (error) {
        if (error instanceof GifBudgetError) {
          activeState.budgetExhausted = true;
        }
        console.error('[GIF Auto-Capture] Frame capture failed:', error);
        throw error;
      }

      // Wait between animation frames
      if (i < plan.frames - 1 && plan.intervalMs > 0) {
        await sleep(plan.intervalMs);
      }
    }
  })();

  state.pendingCapture = capturePromise;

  try {
    await capturePromise;
    const frameNumber = state.frameCount;
    if (
      isActiveAutoCaptureState(state) &&
      frameNumber >= state.config.maxFrames
    ) {
      await finalizeAutoCaptureState(state, true);
    }
    return { success: true, frameNumber };
  } catch (error) {
    if (state.budgetExhausted && tabStates.get(tabId) === state) {
      await finalizeAutoCaptureState(state, true);
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Clean up reference to avoid holding completed Promise
    const currentState = tabStates.get(tabId);
    if (currentState?.pendingCapture === capturePromise) {
      currentState.pendingCapture = null;
    }
  }
}

/**
 * Capture an initial frame immediately (useful for recording start state).
 */
export async function captureInitialFrame(
  tabId: number,
): Promise<{ success: boolean; error?: string }> {
  return captureFrameOnAction(tabId, undefined, true);
}

/**
 * Clear all auto-capture state (useful for cleanup).
 */
export async function clearAllAutoCapture(): Promise<void> {
  const tabIds = Array.from(tabStates.keys());
  for (const tabId of tabIds) {
    const state = tabStates.get(tabId);
    if (state) await abortAutoCaptureState(state);
  }
  clearCompletedAutoCapture();
}

export async function cleanupAutoCaptureForTab(tabId: number): Promise<void> {
  const state = tabStates.get(tabId);
  if (state) await abortAutoCaptureState(state);
  if (completedAutoCapture?.tabId === tabId) clearCompletedAutoCapture();
}

chrome.tabs?.onRemoved?.addListener((tabId) => {
  void cleanupAutoCaptureForTab(tabId).catch((error) => {
    console.error('[GIF Auto-Capture] tab-close cleanup failed:', error);
  });
});
