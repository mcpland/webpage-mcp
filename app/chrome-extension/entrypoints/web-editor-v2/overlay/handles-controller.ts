/**
 * Handles Controller (Phase 4.9)
 *
 * Renders interactive resize handles on top of the selected element.
 * Integrates drag-to-resize with TransactionManager.beginMultiStyle() so each gesture
 * becomes a single undo/redo step.
 *
 * Design notes:
 * - Uses DOM (not Canvas) for reliable hit targets, cursors, and pointer capture.
 * - Uses rAF-throttled updates to bound work to at most once per frame.
 * - Handles are positioned using transform for GPU-accelerated performance.
 */

import {
  WEB_EDITOR_V2_DISTANCE_LABEL_MIN_PX,
  WEB_EDITOR_V2_LOG_PREFIX,
  WEB_EDITOR_V2_SNAP_HYSTERESIS_PX,
  WEB_EDITOR_V2_SNAP_THRESHOLD_PX,
} from '../constants';
import {
  collectSiblingAnchors,
  collectViewportAnchors,
  computeDistanceLabels,
  computeResizeSnap,
  mergeAnchors,
  type SnapAnchors,
  type SnapLockX,
  type SnapLockY,
} from '../core/snap-engine';
import type { PositionTracker } from '../core/position-tracker';
import type { MultiStyleTransactionHandle, TransactionManager } from '../core/transaction-manager';
import type { CanvasOverlay, ViewportRect } from './canvas-overlay';
import { Disposer } from '../utils/disposables';

// =============================================================================
// Types
// =============================================================================

/** Resize handle direction (8 cardinal + ordinal directions) */
export type ResizeHandleDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** Position mode for determining how to apply position changes */
type ResizePositionMode = 'fixed' | 'absolute' | 'relative' | 'static';

/** Options for creating the handles controller */
export interface HandlesControllerOptions {
  /** overlayRoot from ShadowHost (Canvas container) */
  container: HTMLElement;
  /** Canvas overlay for drawing alignment guide lines (Phase 4.2) */
  canvasOverlay: CanvasOverlay;
  /** Transaction manager for atomic multi-style resize commits */
  transactionManager: TransactionManager;
  /** Position tracker for final sync after commit/cancel */
  positionTracker: PositionTracker;
}

/** Handles controller public interface */
export interface HandlesController {
  /** Update the current selected element (null hides handles and cancels active drag) */
  setTarget(target: Element | null): void;
  /** Update the current selection rect in viewport coordinates (null hides handles) */
  setSelectionRect(rect: ViewportRect | null): void;
  /** Cleanup resources */
  dispose(): void;
}

/** Box-sizing extras for accurate size calculations */
interface BoxExtras {
  boxSizing: 'border-box' | 'content-box';
  horizontalExtras: number; // padding + border (horizontal)
  verticalExtras: number; // padding + border (vertical)
}

/** Origin info for absolute positioning calculations */
interface AbsoluteOrigin {
  originX: number;
  originY: number;
  scrollLeft: number;
  scrollTop: number;
}

/** Active resize session state */
interface ResizeSession {
  /** Pointer ID for capture tracking */
  pointerId: number;
  /** Direction being dragged */
  dir: ResizeHandleDir;
  /** Handle element being dragged */
  handleEl: HTMLElement;
  /** Target element being resized */
  target: HTMLElement;
  /** Position mode of target */
  mode: ResizePositionMode;
  /** CSS properties tracked for this gesture (used to start tx after threshold) */
  properties: readonly string[];
  /** Transaction handle for atomic commit/rollback (created after threshold) */
  tx: MultiStyleTransactionHandle | null;
  /** Whether the drag threshold has been exceeded (resize is active) */
  hasPassedThreshold: boolean;

  /** Whether this direction affects width */
  affectsWidth: boolean;
  /** Whether this direction affects height */
  affectsHeight: boolean;
  /** Whether dragging from west edge */
  hasWest: boolean;
  /** Whether dragging from north edge */
  hasNorth: boolean;

  // ===========================================================================
  // Snap state (Phase 4.2)
  // ===========================================================================

  /** Pre-collected anchors for this gesture (siblings + viewport) */
  anchors: SnapAnchors | null;
  /** Active X-axis snap lock (for hysteresis) */
  lockX: SnapLockX | null;
  /** Active Y-axis snap lock (for hysteresis) */
  lockY: SnapLockY | null;
  /** Whether guides were drawn last frame (for change detection) */
  hadGuidesLastFrame: boolean;
  /** Whether distance labels were drawn last frame (for change detection) */
  hadDistanceLabelsLastFrame: boolean;

  /** Start pointer position */
  startClientX: number;
  startClientY: number;
  /** Last pointer position (for rAF) */
  lastClientX: number;
  lastClientY: number;

  /** Starting element rect */
  startRect: ViewportRect;
  /** Starting position value (left/top or margin-left/margin-top) */
  startPosX: number;
  startPosY: number;
  /** Absolute positioning origin info (null for non-absolute) */
  absOrigin: AbsoluteOrigin | null;
  /** Box model extras for size calculations */
  extras: BoxExtras;

  /** Previous body styles for restoration */
  prevBodyCursor: string;
  prevBodyUserSelect: string;
}

// =============================================================================
// Constants
// =============================================================================

/** Minimum element size in border-box pixels */
const MIN_BORDER_BOX_SIZE_PX = 1;

/** Minimum pointer movement (px) to start resizing (prevents click -> transaction) */
const RESIZE_DRAG_THRESHOLD_PX = 3;

/** All resize handle directions */
const HANDLE_DIRS: readonly ResizeHandleDir[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Cursor style for each direction */
const CURSOR_BY_DIR: Readonly<Record<ResizeHandleDir, string>> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

// =============================================================================
// Utility Functions
// =============================================================================

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidRect(rect: ViewportRect | null): rect is ViewportRect {
  if (!rect) return false;
  return (
    isFiniteNumber(rect.left) &&
    isFiniteNumber(rect.top) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height) &&
    rect.width > 0.5 &&
    rect.height > 0.5
  );
}

function clampMin(value: number, min: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value;
}

/**
 * Parse a CSS pixel value (e.g., "10px", "auto", "10") to a number.
 * Returns null for non-numeric values like "auto".
 */
function parsePx(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'auto' || trimmed === 'none') return null;

  const match = trimmed.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (match) {
    const num = Number(match[1]);
    return Number.isFinite(num) ? num : null;
  }

  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
}

/**
 * Format a number as a CSS pixel value.
 * Rounds to 2 decimal places to avoid floating point noise.
 */
function formatPx(value: number): string {
  if (!Number.isFinite(value)) return '0px';
  const rounded = Math.round(value * 100) / 100;
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  return `${normalized}px`;
}

/**
 * Get the resize position mode from a CSS position value.
 */
function getResizeMode(position: string): ResizePositionMode {
  const p = position.trim().toLowerCase();
  if (p === 'fixed') return 'fixed';
  if (p === 'absolute') return 'absolute';
  if (p === 'relative' || p === 'sticky') return 'relative';
  return 'static';
}

// Direction helper functions
function dirHasWest(dir: ResizeHandleDir): boolean {
  return dir === 'w' || dir === 'nw' || dir === 'sw';
}

function dirHasEast(dir: ResizeHandleDir): boolean {
  return dir === 'e' || dir === 'ne' || dir === 'se';
}

function dirHasNorth(dir: ResizeHandleDir): boolean {
  return dir === 'n' || dir === 'nw' || dir === 'ne';
}

function dirHasSouth(dir: ResizeHandleDir): boolean {
  return dir === 's' || dir === 'sw' || dir === 'se';
}

/**
 * Read an element's bounding rect in viewport coordinates.
 */
function readViewportRect(element: Element): ViewportRect | null {
  try {
    const r = element.getBoundingClientRect();
    if (
      !Number.isFinite(r.left) ||
      !Number.isFinite(r.top) ||
      !Number.isFinite(r.width) ||
      !Number.isFinite(r.height)
    ) {
      return null;
    }
    return {
      left: r.left,
      top: r.top,
      width: Math.max(0, r.width),
      height: Math.max(0, r.height),
    };
  } catch {
    return null;
  }
}

/**
 * Safely get computed style for an element.
 */
function safeGetComputedStyle(element: Element): CSSStyleDeclaration | null {
  try {
    return window.getComputedStyle(element);
  } catch {
    return null;
  }
}

/**
 * Sum two CSS property values as pixels.
 */
function sumStylePx(style: CSSStyleDeclaration, propA: string, propB: string): number {
  const a = parsePx(style.getPropertyValue(propA)) ?? 0;
  const b = parsePx(style.getPropertyValue(propB)) ?? 0;
  return a + b;
}

/**
 * Read box model extras (padding + border) from computed style.
 */
function readBoxExtras(style: CSSStyleDeclaration): BoxExtras {
  const boxSizingRaw = style.getPropertyValue('box-sizing').trim();
  const boxSizing: BoxExtras['boxSizing'] =
    boxSizingRaw === 'border-box' ? 'border-box' : 'content-box';

  const paddingX = sumStylePx(style, 'padding-left', 'padding-right');
  const paddingY = sumStylePx(style, 'padding-top', 'padding-bottom');
  const borderX = sumStylePx(style, 'border-left-width', 'border-right-width');
  const borderY = sumStylePx(style, 'border-top-width', 'border-bottom-width');

  return {
    boxSizing,
    horizontalExtras: paddingX + borderX,
    verticalExtras: paddingY + borderY,
  };
}

/**
 * Convert border-box size to CSS width/height value based on box-sizing.
 */
function borderBoxToCssSize(
  borderBoxPx: number,
  extrasPx: number,
  boxSizing: BoxExtras['boxSizing'],
): number {
  if (boxSizing === 'border-box') return borderBoxPx;
  return Math.max(0, borderBoxPx - extrasPx);
}

/**
 * Compute the origin point for absolute positioning calculations.
 * For absolute elements, this is the padding-box of the offsetParent.
 */
function computeAbsoluteOrigin(target: HTMLElement): AbsoluteOrigin {
  try {
    const op = target.offsetParent;
    if (op instanceof HTMLElement) {
      const rect = op.getBoundingClientRect();
      const style = safeGetComputedStyle(op);
      const borderLeft = style ? (parsePx(style.getPropertyValue('border-left-width')) ?? 0) : 0;
      const borderTop = style ? (parsePx(style.getPropertyValue('border-top-width')) ?? 0) : 0;
      return {
        originX: rect.left + borderLeft,
        originY: rect.top + borderTop,
        scrollLeft: op.scrollLeft,
        scrollTop: op.scrollTop,
      };
    }
  } catch {
    // Best-effort fallback below
  }
  // Fallback to viewport origin (for fixed or when offsetParent is null)
  return { originX: 0, originY: 0, scrollLeft: 0, scrollTop: 0 };
}

/**
 * Stop event propagation and prevent default.
 */
function stopEvent(event: Event): void {
  if (event.cancelable) event.preventDefault();
  event.stopPropagation();
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a handles controller for resize interactions.
 */
export function createHandlesController(options: HandlesControllerOptions): HandlesController {
  const disposer = new Disposer();
  const { container, canvasOverlay, transactionManager, positionTracker } = options;

  // ===========================================================================
  // DOM Structure
  // ===========================================================================

  // Layer container (covers viewport, pointer-events: none)
  const layer = document.createElement('div');
  layer.className = 'we-handles-layer';
  layer.setAttribute('aria-hidden', 'true');
  container.append(layer);
  disposer.add(() => layer.remove());

  // Selection frame (positioned by selection rect)
  const frame = document.createElement('div');
  frame.className = 'we-selection-frame';
  frame.hidden = true;
  layer.append(frame);

  // Size HUD (displays W×H while dragging)
  const sizeHud = document.createElement('div');
  sizeHud.className = 'we-size-hud';
  sizeHud.hidden = true;
  frame.append(sizeHud);

  // Create 8 resize handles
  const handleEls = new Map<ResizeHandleDir, HTMLDivElement>();
  for (const dir of HANDLE_DIRS) {
    const el = document.createElement('div');
    el.className = 'we-resize-handle';
    el.dataset.dir = dir;
    el.tabIndex = -1;
    frame.append(el);
    handleEls.set(dir, el);
  }

  // ===========================================================================
  // State
  // ===========================================================================

  let currentTarget: HTMLElement | null = null;
  let currentSelectionRect: ViewportRect | null = null;
  let session: ResizeSession | null = null;

  // rAF scheduling
  let rafId: number | null = null;

  function cancelRaf(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }
  disposer.add(cancelRaf);

  // ===========================================================================
  // Rendering
  // ===========================================================================

  /**
   * Render the selection frame at the given rect.
   */
  function renderSelectionRect(rect: ViewportRect | null): void {
    const shouldShow = !!currentTarget && isValidRect(rect);
    if (!shouldShow) {
      frame.hidden = true;
      return;
    }

    frame.hidden = false;
    frame.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
    frame.style.width = `${rect.width}px`;
    frame.style.height = `${rect.height}px`;
  }

  /**
   * Update the size HUD text.
   */
  function setHud(text: string | null): void {
    if (!text) {
      sizeHud.hidden = true;
      sizeHud.textContent = '';
      return;
    }
    sizeHud.hidden = false;
    sizeHud.textContent = text;
  }

  // ===========================================================================
  // Session Lifecycle
  // ===========================================================================

  /**
   * Restore body styles after resize session ends.
   */
  function restoreBodyStyles(s: ResizeSession): void {
    document.body.style.cursor = s.prevBodyCursor;
    document.body.style.userSelect = s.prevBodyUserSelect;
  }

  /**
   * Cancel the current resize session and rollback changes.
   */
  function cancelSession(reason: string): void {
    const s = session;
    if (!s) return;

    cancelRaf();
    session = null;

    // Rollback transaction (only if a resize actually started)
    if (s.tx) {
      try {
        s.tx.rollback();
      } catch (error) {
        console.warn(`${WEB_EDITOR_V2_LOG_PREFIX} Resize rollback failed:`, error);
      }
    }

    // Restore body styles
    try {
      restoreBodyStyles(s);
    } catch {
      // Best-effort
    }

    // Clear snap overlays (Phase 4.2 & 4.3)
    try {
      canvasOverlay.setGuideLines(null);
      canvasOverlay.setDistanceLabels(null);
      canvasOverlay.render();
    } catch {
      // Best-effort
    }

    setHud(null);
    renderSelectionRect(currentSelectionRect);

    // Force position sync after rollback
    try {
      positionTracker.forceUpdate();
    } catch {
      // Best-effort
    }

    if (reason) {
      console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Resize cancelled (${reason})`);
    }
  }

  /**
   * Commit the current resize session.
   */
  function commitSession(): void {
    const s = session;
    if (!s) return;

    cancelRaf();
    session = null;

    // Commit transaction (no-op if drag never crossed threshold)
    if (s.tx) {
      try {
        s.tx.commit({ merge: false });
      } catch (error) {
        console.warn(`${WEB_EDITOR_V2_LOG_PREFIX} Resize commit failed:`, error);
        // Attempt rollback on commit failure
        try {
          s.tx.rollback();
        } catch {
          // Best-effort
        }
      }
    }

    // Restore body styles
    try {
      restoreBodyStyles(s);
    } catch {
      // Best-effort
    }

    // Clear snap overlays (Phase 4.2 & 4.3)
    try {
      canvasOverlay.setGuideLines(null);
      canvasOverlay.setDistanceLabels(null);
      canvasOverlay.render();
    } catch {
      // Best-effort
    }

    setHud(null);

    // Force position sync after commit
    try {
      positionTracker.forceUpdate();
    } catch {
      // Best-effort
    }
  }

  /**
   * Schedule an update frame if not already scheduled.
   */
  function scheduleFrame(): void {
    if (rafId !== null || disposer.isDisposed) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      updateFrame();
    });
  }

  /**
   * Update frame - apply style changes based on current drag position.
   */
  function updateFrame(): void {
    const s = session;
    if (!s) return;

    // Verify target is still connected
    if (!s.target.isConnected) {
      cancelSession('target_disconnected');
      return;
    }

    const dx = s.lastClientX - s.startClientX;
    const dy = s.lastClientY - s.startClientY;

    // Only start a real resize after pointer movement exceeds the threshold.
    // This prevents "clicking a handle" from generating a transaction or writing styles.
    if (!s.hasPassedThreshold) {
      if (Math.hypot(dx, dy) < RESIZE_DRAG_THRESHOLD_PX) {
        return;
      }

      s.hasPassedThreshold = true;

      const startedTx = transactionManager.beginMultiStyle(s.target, Array.from(s.properties));
      if (!startedTx) {
        cancelSession('tx_unavailable');
        return;
      }
      s.tx = startedTx;

      // Collect snap anchors once when gesture becomes active (Phase 4.2)
      // This avoids per-frame layout thrashing from reading sibling rects
      try {
        const siblingAnchors = collectSiblingAnchors(s.target);
        const viewportAnchors = collectViewportAnchors();
        s.anchors = mergeAnchors(siblingAnchors, viewportAnchors);
      } catch {
        // Snap will be disabled if anchor collection fails
        s.anchors = null;
      }
    }

    const tx = s.tx;
    if (!tx) {
      cancelSession('tx_missing');
      return;
    }

    // Calculate new border-box dimensions
    let nextWidthBorderBox = s.startRect.width;
    let nextHeightBorderBox = s.startRect.height;

    if (s.affectsWidth) {
      if (dirHasEast(s.dir)) {
        nextWidthBorderBox = clampMin(s.startRect.width + dx, MIN_BORDER_BOX_SIZE_PX);
      }
      if (dirHasWest(s.dir)) {
        nextWidthBorderBox = clampMin(s.startRect.width - dx, MIN_BORDER_BOX_SIZE_PX);
      }
    }

    if (s.affectsHeight) {
      if (dirHasSouth(s.dir)) {
        nextHeightBorderBox = clampMin(s.startRect.height + dy, MIN_BORDER_BOX_SIZE_PX);
      }
      if (dirHasNorth(s.dir)) {
        nextHeightBorderBox = clampMin(s.startRect.height - dy, MIN_BORDER_BOX_SIZE_PX);
      }
    }

    // Build proposed preview rect (before snapping)
    const proposedLeftDelta = s.hasWest ? s.startRect.width - nextWidthBorderBox : 0;
    const proposedTopDelta = s.hasNorth ? s.startRect.height - nextHeightBorderBox : 0;
    const proposedRect: ViewportRect = {
      left: s.startRect.left + proposedLeftDelta,
      top: s.startRect.top + proposedTopDelta,
      width: nextWidthBorderBox,
      height: nextHeightBorderBox,
    };

    // Apply snapping if anchors are available (Phase 4.2)
    let finalRect = proposedRect;
    if (s.anchors) {
      const hasEast = dirHasEast(s.dir);
      const hasSouth = dirHasSouth(s.dir);

      const snapResult = computeResizeSnap({
        rect: proposedRect,
        resize: {
          hasWest: s.hasWest,
          hasEast,
          hasNorth: s.hasNorth,
          hasSouth,
        },
        anchors: s.anchors,
        thresholdPx: WEB_EDITOR_V2_SNAP_THRESHOLD_PX,
        hysteresisPx: WEB_EDITOR_V2_SNAP_HYSTERESIS_PX,
        minSizePx: MIN_BORDER_BOX_SIZE_PX,
        lockX: s.lockX,
        lockY: s.lockY,
        viewport: {
          width: window.innerWidth || 1,
          height: window.innerHeight || 1,
        },
      });

      // Update lock state for hysteresis
      s.lockX = snapResult.lockX;
      s.lockY = snapResult.lockY;
      finalRect = snapResult.snappedRect;

      // Compute distance labels (Phase 4.3)
      const distanceLabels = computeDistanceLabels({
        rect: finalRect,
        lockX: s.lockX,
        lockY: s.lockY,
        minGapPx: WEB_EDITOR_V2_DISTANCE_LABEL_MIN_PX,
        viewport: {
          width: window.innerWidth || 1,
          height: window.innerHeight || 1,
        },
      });

      // Draw guide lines and distance labels (only update if state changed)
      const hasGuides = snapResult.guideLines.length > 0;
      const hasDistanceLabels = distanceLabels.length > 0;

      if (hasGuides || s.hadGuidesLastFrame || hasDistanceLabels || s.hadDistanceLabelsLastFrame) {
        try {
          canvasOverlay.setGuideLines(hasGuides ? snapResult.guideLines : null);
          canvasOverlay.setDistanceLabels(hasDistanceLabels ? distanceLabels : null);
          canvasOverlay.render();
        } catch {
          // Best-effort; snapping still applies even if overlay fails
        }
        s.hadGuidesLastFrame = hasGuides;
        s.hadDistanceLabelsLastFrame = hasDistanceLabels;
      }

      // Update dimensions from snapped rect
      nextWidthBorderBox = finalRect.width;
      nextHeightBorderBox = finalRect.height;
    }

    // Calculate edge deltas from snapped rect (for position updates)
    const leftEdgeDelta = finalRect.left - s.startRect.left;
    const topEdgeDelta = finalRect.top - s.startRect.top;

    // Render preview immediately
    renderSelectionRect(finalRect);

    // Update HUD
    setHud(`${Math.round(finalRect.width)} × ${Math.round(finalRect.height)}`);

    // Build style changes
    const styles: Record<string, string> = {};

    if (s.affectsWidth) {
      const widthCssPx = borderBoxToCssSize(
        nextWidthBorderBox,
        s.extras.horizontalExtras,
        s.extras.boxSizing,
      );
      styles.width = formatPx(widthCssPx);
    }

    if (s.affectsHeight) {
      const heightCssPx = borderBoxToCssSize(
        nextHeightBorderBox,
        s.extras.verticalExtras,
        s.extras.boxSizing,
      );
      styles.height = formatPx(heightCssPx);
    }

    // Position-mode specific handling
    if (s.mode === 'absolute' || s.mode === 'fixed') {
      // For absolute/fixed: update left/top and clear right/bottom to avoid over-constraint
      if (s.affectsWidth) {
        styles.left = formatPx(s.startPosX + leftEdgeDelta);
        styles.right = '';
      }
      if (s.affectsHeight) {
        styles.top = formatPx(s.startPosY + topEdgeDelta);
        styles.bottom = '';
      }
    } else if (s.mode === 'relative') {
      // For relative: only update position if dragging from edge that needs it
      if (s.affectsWidth && s.hasWest) {
        styles.left = formatPx(s.startPosX + leftEdgeDelta);
      }
      if (s.affectsHeight && s.hasNorth) {
        styles.top = formatPx(s.startPosY + topEdgeDelta);
      }
    } else {
      // For static: use margin as best-effort fallback
      if (s.affectsWidth && s.hasWest) {
        styles['margin-left'] = formatPx(s.startPosX + leftEdgeDelta);
      }
      if (s.affectsHeight && s.hasNorth) {
        styles['margin-top'] = formatPx(s.startPosY + topEdgeDelta);
      }
    }

    // Apply styles
    try {
      tx.set(styles);
    } catch (error) {
      console.warn(`${WEB_EDITOR_V2_LOG_PREFIX} Resize preview apply failed:`, error);
      cancelSession('apply_failed');
    }
  }

  /**
   * Start a resize session.
   */
  function startResize(dir: ResizeHandleDir, handleEl: HTMLElement, event: PointerEvent): void {
    if (disposer.isDisposed) return;

    // Only handle primary button
    if (event.button !== 0) return;

    const target = currentTarget;
    if (!target || !target.isConnected) return;

    // Cancel any existing session
    if (session) cancelSession('restart');

    const computed = safeGetComputedStyle(target);
    if (!computed) return;

    // Block transformed elements (matrix math required for proper handling)
    const transform = computed.getPropertyValue('transform').trim();
    if (transform && transform !== 'none') {
      console.warn(
        `${WEB_EDITOR_V2_LOG_PREFIX} Resize handles do not support transformed elements yet`,
      );
      return;
    }

    const position = computed.getPropertyValue('position');
    const mode = getResizeMode(position);

    // Determine which axes are affected
    const hasWest = dirHasWest(dir);
    const hasNorth = dirHasNorth(dir);
    const affectsWidth = hasWest || dirHasEast(dir);
    const affectsHeight = hasNorth || dirHasSouth(dir);

    // Read margins (needed for fixed/absolute origin and static auto detection)
    const marginLeftRaw = computed.getPropertyValue('margin-left').trim().toLowerCase();
    const marginTopRaw = computed.getPropertyValue('margin-top').trim().toLowerCase();
    const marginLeftPx = parsePx(marginLeftRaw) ?? 0;
    const marginTopPx = parsePx(marginTopRaw) ?? 0;

    // Static positioning: margin:auto is commonly used for centering in flex/grid.
    // Resizing from that side would force a numeric margin and break layout.
    if (mode === 'static') {
      if (hasWest && marginLeftRaw === 'auto') {
        console.warn(
          `${WEB_EDITOR_V2_LOG_PREFIX} Resize from west is disabled when margin-left is auto`,
        );
        return;
      }
      if (hasNorth && marginTopRaw === 'auto') {
        console.warn(
          `${WEB_EDITOR_V2_LOG_PREFIX} Resize from north is disabled when margin-top is auto`,
        );
        return;
      }
    }

    const rect = isValidRect(currentSelectionRect)
      ? currentSelectionRect
      : readViewportRect(target);
    if (!rect || !isValidRect(rect)) return;

    // Build properties list for transaction
    const properties: string[] = [];

    if (affectsWidth) {
      properties.push('width');
      if (mode === 'absolute' || mode === 'fixed') {
        properties.push('left', 'right');
      } else if (mode === 'relative') {
        if (hasWest) properties.push('left');
      } else {
        if (hasWest) properties.push('margin-left');
      }
    }

    if (affectsHeight) {
      properties.push('height');
      if (mode === 'absolute' || mode === 'fixed') {
        properties.push('top', 'bottom');
      } else if (mode === 'relative') {
        if (hasNorth) properties.push('top');
      } else {
        if (hasNorth) properties.push('margin-top');
      }
    }

    // Calculate starting position based on mode
    let absOrigin: AbsoluteOrigin | null = null;
    let startPosX = 0;
    let startPosY = 0;

    if (mode === 'absolute') {
      absOrigin = computeAbsoluteOrigin(target);
      // Subtract margin to get the actual CSS left/top value
      startPosX = affectsWidth
        ? rect.left - marginLeftPx - absOrigin.originX + absOrigin.scrollLeft
        : 0;
      startPosY = affectsHeight
        ? rect.top - marginTopPx - absOrigin.originY + absOrigin.scrollTop
        : 0;
    } else if (mode === 'fixed') {
      absOrigin = { originX: 0, originY: 0, scrollLeft: 0, scrollTop: 0 };
      // Subtract margin to get the actual CSS left/top value
      startPosX = affectsWidth ? rect.left - marginLeftPx : 0;
      startPosY = affectsHeight ? rect.top - marginTopPx : 0;
    } else if (mode === 'relative') {
      startPosX = affectsWidth && hasWest ? (parsePx(computed.getPropertyValue('left')) ?? 0) : 0;
      startPosY = affectsHeight && hasNorth ? (parsePx(computed.getPropertyValue('top')) ?? 0) : 0;
    } else {
      startPosX = affectsWidth && hasWest ? marginLeftPx : 0;
      startPosY = affectsHeight && hasNorth ? marginTopPx : 0;
    }

    const extras = readBoxExtras(computed);

    // Save current body styles
    const prevBodyCursor = document.body.style.cursor;
    const prevBodyUserSelect = document.body.style.userSelect;

    // Create session (transaction is created after threshold is crossed)
    session = {
      pointerId: event.pointerId,
      dir,
      handleEl,
      target,
      mode,
      properties,
      tx: null,
      hasPassedThreshold: false,
      affectsWidth,
      affectsHeight,
      hasWest,
      hasNorth,
      // Snap state (Phase 4.2 & 4.3) - initialized to null, populated after threshold
      anchors: null,
      lockX: null,
      lockY: null,
      hadGuidesLastFrame: false,
      hadDistanceLabelsLastFrame: false,
      startClientX: event.clientX,
      startClientY: event.clientY,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      startRect: rect,
      startPosX,
      startPosY,
      absOrigin,
      extras,
      prevBodyCursor,
      prevBodyUserSelect,
    };

    // Capture pointer for robust tracking
    try {
      handleEl.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture may fail on some elements/browsers
    }

    // Apply drag visual affordances
    document.body.style.cursor = CURSOR_BY_DIR[dir];
    document.body.style.userSelect = 'none';

    stopEvent(event);

    // Initial render and schedule first frame
    renderSelectionRect(rect);
    scheduleFrame();
  }

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  function handlePointerMove(event: PointerEvent): void {
    const s = session;
    if (!s) return;
    if (event.pointerId !== s.pointerId) return;

    stopEvent(event);
    s.lastClientX = event.clientX;
    s.lastClientY = event.clientY;
    scheduleFrame();
  }

  function handlePointerUp(event: PointerEvent): void {
    const s = session;
    if (!s) return;
    if (event.pointerId !== s.pointerId) return;

    stopEvent(event);
    s.lastClientX = event.clientX;
    s.lastClientY = event.clientY;
    commitSession();
  }

  function handlePointerCancel(event: PointerEvent): void {
    const s = session;
    if (!s) return;
    if (event.pointerId !== s.pointerId) return;

    stopEvent(event);
    cancelSession(event.type);
  }

  /**
   * Handle ESC key - cancel resize without triggering EventController deselect.
   * Uses stopImmediatePropagation to prevent other handlers from seeing the event.
   */
  function handleKeyDown(event: KeyboardEvent): void {
    if (!session) return;
    if (event.key !== 'Escape') return;

    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
    cancelSession('escape');
  }

  function handleWindowBlur(): void {
    if (!session) return;
    cancelSession('blur');
  }

  function handleVisibilityChange(): void {
    if (!session) return;
    if (document.visibilityState !== 'visible') {
      cancelSession('visibilitychange');
    }
  }

  // ===========================================================================
  // Event Wiring
  // ===========================================================================

  for (const [dir, el] of handleEls) {
    disposer.listen(el, 'pointerdown', (event: PointerEvent) => startResize(dir, el, event));
    disposer.listen(el, 'pointermove', handlePointerMove);
    disposer.listen(el, 'pointerup', handlePointerUp);
    disposer.listen(el, 'pointercancel', handlePointerCancel);
    disposer.listen(el, 'lostpointercapture', handlePointerCancel);
  }

  // Global event handlers
  disposer.listen(document, 'keydown', handleKeyDown, { capture: true });
  disposer.listen(window, 'blur', handleWindowBlur);
  disposer.listen(document, 'visibilitychange', handleVisibilityChange);

  // ===========================================================================
  // Public API
  // ===========================================================================

  function setTarget(target: Element | null): void {
    if (disposer.isDisposed) return;

    // Cancel active session when selection changes
    if (session) cancelSession('target_change');

    if (target instanceof HTMLElement && target.isConnected) {
      currentTarget = target;
    } else {
      currentTarget = null;
    }

    renderSelectionRect(currentSelectionRect);
  }

  function setSelectionRect(rect: ViewportRect | null): void {
    if (disposer.isDisposed) return;

    currentSelectionRect = isValidRect(rect) ? rect : null;

    // Hide if target is gone
    if (!currentTarget || !currentTarget.isConnected) {
      frame.hidden = true;
      return;
    }

    // Cancel session if rect becomes invalid
    if (session && !currentSelectionRect) {
      cancelSession('rect_lost');
      return;
    }

    // When idle, follow position tracker updates
    if (!session) {
      renderSelectionRect(currentSelectionRect);
    }
  }

  function dispose(): void {
    cancelSession('dispose');
    currentTarget = null;
    currentSelectionRect = null;
    disposer.dispose();
  }

  // Initial state
  renderSelectionRect(null);

  return { setTarget, setSelectionRect, dispose };
}
