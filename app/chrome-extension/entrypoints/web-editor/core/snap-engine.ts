/**
 * Snap Engine (Phase 4.2)
 *
 * Computes snapping and alignment guide lines for interactive resize operations.
 *
 * Architecture:
 * - Anchor collection (DOM reads) - called once per gesture to avoid layout thrash
 * - Pure geometry computation (called every frame) - no DOM access
 *
 * Performance considerations:
 * - Siblings are collected once when gesture threshold is exceeded
 * - Distance-based filtering limits anchor count to nearest N elements
 * - Lock/hysteresis mechanism prevents flicker at threshold boundaries
 */

import {
  WEB_EDITOR_SNAP_MAX_ANCHOR_ELEMENTS,
  WEB_EDITOR_SNAP_MAX_SIBLINGS_SCAN,
} from '../constants';
import type { DistanceLabel, ViewportLine, ViewportRect } from '../overlay/canvas-overlay';

// =============================================================================
// Types
// =============================================================================

/** Source of a snap anchor */
export type SnapAnchorSource = 'sibling' | 'viewport';

/** X-axis anchor types (edges and center) */
export type SnapAnchorXType = 'left' | 'center' | 'right';

/** Y-axis anchor types (edges and center) */
export type SnapAnchorYType = 'top' | 'middle' | 'bottom';

/** Union of all anchor types */
export type SnapAnchorType = SnapAnchorXType | SnapAnchorYType;

/** Base interface for snap anchors */
interface SnapAnchorBase<TType extends SnapAnchorType> {
  /** Anchor coordinate in viewport space */
  readonly value: number;
  /** Type of anchor (which edge or center) */
  readonly type: TType;
  /** Where this anchor came from */
  readonly source: SnapAnchorSource;
  /** Source element rect (for guide line extent calculation) */
  readonly sourceRect?: ViewportRect;
}

/** X-axis snap anchor */
export type SnapAnchorX = SnapAnchorBase<SnapAnchorXType>;

/** Y-axis snap anchor */
export type SnapAnchorY = SnapAnchorBase<SnapAnchorYType>;

/** Collection of anchors for both axes */
export interface SnapAnchors {
  readonly x: readonly SnapAnchorX[];
  readonly y: readonly SnapAnchorY[];
}

/** Active snap lock state for X axis */
export interface SnapLockX {
  readonly type: SnapAnchorXType;
  readonly value: number;
  readonly source: SnapAnchorSource;
  readonly sourceRect: ViewportRect | null;
}

/** Active snap lock state for Y axis */
export interface SnapLockY {
  readonly type: SnapAnchorYType;
  readonly value: number;
  readonly source: SnapAnchorSource;
  readonly sourceRect: ViewportRect | null;
}

/** Result of snap computation */
export interface SnapResult {
  /** Rectangle after snapping applied */
  readonly snappedRect: ViewportRect;
  /** Guide lines to render */
  readonly guideLines: readonly ViewportLine[];
  /** Active X-axis lock (for hysteresis) */
  readonly lockX: SnapLockX | null;
  /** Active Y-axis lock (for hysteresis) */
  readonly lockY: SnapLockY | null;
}

/** Resize direction info for snap computation */
export interface ResizeDirection {
  readonly hasWest: boolean;
  readonly hasEast: boolean;
  readonly hasNorth: boolean;
  readonly hasSouth: boolean;
}

/** Viewport dimensions for guide line calculation */
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

/** Parameters for computeResizeSnap */
export interface ComputeResizeSnapParams {
  /** Current proposed rectangle (before snapping) */
  readonly rect: ViewportRect;
  /** Which directions are being resized */
  readonly resize: ResizeDirection;
  /** Available snap anchors */
  readonly anchors: SnapAnchors;
  /** Distance threshold for snap activation (px) */
  readonly thresholdPx: number;
  /** Additional distance to maintain lock once snapped (px) */
  readonly hysteresisPx: number;
  /** Minimum allowed element size (px) */
  readonly minSizePx: number;
  /** Current X-axis lock from previous frame */
  readonly lockX: SnapLockX | null;
  /** Current Y-axis lock from previous frame */
  readonly lockY: SnapLockY | null;
  /** Viewport dimensions for guide line extent calculation */
  readonly viewport: ViewportSize;
}

/** Parameters for computeDistanceLabels (Phase 4.3) */
export interface ComputeDistanceLabelsParams {
  /** Current rectangle (typically snappedRect from computeResizeSnap) */
  readonly rect: ViewportRect;
  /** Active X-axis lock (from snap result) */
  readonly lockX: SnapLockX | null;
  /** Active Y-axis lock (from snap result) */
  readonly lockY: SnapLockY | null;
  /** Viewport dimensions */
  readonly viewport: ViewportSize;
  /** Minimum gap (px) to display label - hides 0 and sub-pixel gaps */
  readonly minGapPx: number;
}

// =============================================================================
// Internal Types
// =============================================================================

/** Fixed edge during resize (opposite to drag direction) */
type FixedEdgeX = 'left' | 'right' | null;
type FixedEdgeY = 'top' | 'bottom' | null;

/** Candidate for best snap match */
interface SnapCandidate<TAnchor> {
  readonly distance: number;
  readonly anchor: TAnchor;
  readonly snappedRect: ViewportRect;
}

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

function readElementRect(element: Element): ViewportRect | null {
  try {
    const r = element.getBoundingClientRect();
    const rect: ViewportRect = {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
    };
    return isValidRect(rect) ? rect : null;
  } catch {
    return null;
  }
}

// Rectangle edge/center accessors
function rectRight(r: ViewportRect): number {
  return r.left + r.width;
}

function rectBottom(r: ViewportRect): number {
  return r.top + r.height;
}

function rectCenterX(r: ViewportRect): number {
  return r.left + r.width / 2;
}

function rectCenterY(r: ViewportRect): number {
  return r.top + r.height / 2;
}

/** Get X coordinate for a specific anchor type from a rect */
function getRectXValue(rect: ViewportRect, type: SnapAnchorXType): number {
  switch (type) {
    case 'left':
      return rect.left;
    case 'center':
      return rectCenterX(rect);
    case 'right':
      return rectRight(rect);
  }
}

/** Get Y coordinate for a specific anchor type from a rect */
function getRectYValue(rect: ViewportRect, type: SnapAnchorYType): number {
  switch (type) {
    case 'top':
      return rect.top;
    case 'middle':
      return rectCenterY(rect);
    case 'bottom':
      return rectBottom(rect);
  }
}

// =============================================================================
// Anchor Collection
// =============================================================================

function createEmptyAnchors(): SnapAnchors {
  return { x: [], y: [] };
}

/**
 * Collect snap anchors from sibling elements.
 *
 * Strategy:
 * 1. Find target's index in parent.children
 * 2. Scan outward from target (windowed scan) to avoid missing nearby siblings
 *    when target is in the middle/end of a large children list
 * 3. Read bounding rects (single layout pass per element)
 * 4. Sort by distance to target center
 * 5. Take nearest N elements
 * 6. Extract left/center/right and top/middle/bottom anchors
 *
 * Note: Uses bidirectional scanning strategy, expanding from target position in both directions,
 * to avoid missing nearby elements when target is in the second half of children.
 */
export function collectSiblingAnchors(target: Element): SnapAnchors {
  const parent = target.parentElement;
  if (!parent) return createEmptyAnchors();

  const targetRect = readElementRect(target);
  const refX = targetRect ? rectCenterX(targetRect) : 0;
  const refY = targetRect ? rectCenterY(targetRect) : 0;

  const children = parent.children;
  const childCount = children.length;

  // Find target index for windowed scan
  let targetIndex = -1;
  for (let i = 0; i < childCount; i++) {
    if (children[i] === target) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex === -1) return createEmptyAnchors();

  // Windowed scan: expand outward from target index
  // This ensures we scan nearby siblings first regardless of target position
  const candidates: Array<{ rect: ViewportRect; distanceSquared: number }> = [];
  let scanned = 0;
  let leftOffset = 1;
  let rightOffset = 1;

  while (scanned < WEB_EDITOR_SNAP_MAX_SIBLINGS_SCAN) {
    const leftIndex = targetIndex - leftOffset;
    const rightIndex = targetIndex + rightOffset;
    const canGoLeft = leftIndex >= 0;
    const canGoRight = rightIndex < childCount;

    if (!canGoLeft && !canGoRight) break;

    // Scan left
    if (canGoLeft) {
      const child = children[leftIndex];
      const rect = readElementRect(child);
      if (rect) {
        const dx = rectCenterX(rect) - refX;
        const dy = rectCenterY(rect) - refY;
        candidates.push({ rect, distanceSquared: dx * dx + dy * dy });
      }
      scanned++;
      leftOffset++;
    }

    // Scan right
    if (canGoRight && scanned < WEB_EDITOR_SNAP_MAX_SIBLINGS_SCAN) {
      const child = children[rightIndex];
      const rect = readElementRect(child);
      if (rect) {
        const dx = rectCenterX(rect) - refX;
        const dy = rectCenterY(rect) - refY;
        candidates.push({ rect, distanceSquared: dx * dx + dy * dy });
      }
      scanned++;
      rightOffset++;
    }
  }

  // Sort by distance and take nearest
  candidates.sort((a, b) => a.distanceSquared - b.distanceSquared);
  const selected = candidates.slice(0, WEB_EDITOR_SNAP_MAX_ANCHOR_ELEMENTS);

  // Build anchor arrays
  const xAnchors: SnapAnchorX[] = [];
  const yAnchors: SnapAnchorY[] = [];

  for (const { rect } of selected) {
    // X-axis anchors
    xAnchors.push({ type: 'left', value: rect.left, source: 'sibling', sourceRect: rect });
    xAnchors.push({
      type: 'center',
      value: rectCenterX(rect),
      source: 'sibling',
      sourceRect: rect,
    });
    xAnchors.push({ type: 'right', value: rectRight(rect), source: 'sibling', sourceRect: rect });

    // Y-axis anchors
    yAnchors.push({ type: 'top', value: rect.top, source: 'sibling', sourceRect: rect });
    yAnchors.push({
      type: 'middle',
      value: rectCenterY(rect),
      source: 'sibling',
      sourceRect: rect,
    });
    yAnchors.push({ type: 'bottom', value: rectBottom(rect), source: 'sibling', sourceRect: rect });
  }

  return { x: xAnchors, y: yAnchors };
}

/**
 * Collect snap anchors from viewport boundaries.
 *
 * Provides left/center/right edges at x=0, x=viewport/2, x=viewport
 * and top/middle/bottom edges at corresponding y positions.
 */
export function collectViewportAnchors(): SnapAnchors {
  const viewportWidth = Math.max(1, window.innerWidth || 1);
  const viewportHeight = Math.max(1, window.innerHeight || 1);

  return {
    x: [
      { type: 'left', value: 0, source: 'viewport' },
      { type: 'center', value: viewportWidth / 2, source: 'viewport' },
      { type: 'right', value: viewportWidth, source: 'viewport' },
    ],
    y: [
      { type: 'top', value: 0, source: 'viewport' },
      { type: 'middle', value: viewportHeight / 2, source: 'viewport' },
      { type: 'bottom', value: viewportHeight, source: 'viewport' },
    ],
  };
}

/**
 * Merge multiple anchor collections into one.
 */
export function mergeAnchors(...collections: SnapAnchors[]): SnapAnchors {
  const x: SnapAnchorX[] = [];
  const y: SnapAnchorY[] = [];

  for (const collection of collections) {
    x.push(...collection.x);
    y.push(...collection.y);
  }

  return { x, y };
}

// =============================================================================
// Snap Application
// =============================================================================

/**
 * Apply X-axis snap by adjusting rect to align specified edge/center with anchor value.
 *
 * @param rect Current rectangle
 * @param fixedEdge Which edge is fixed (opposite to drag direction)
 * @param type Which part of rect to align
 * @param value Target coordinate to snap to
 * @param minSize Minimum allowed width
 * @returns Adjusted rect or null if constraint violated
 */
function applyXSnap(
  rect: ViewportRect,
  fixedEdge: FixedEdgeX,
  type: SnapAnchorXType,
  value: number,
  minSize: number,
): ViewportRect | null {
  const left = rect.left;
  const right = rectRight(rect);

  // When left edge is fixed, we can snap right edge or center
  if (fixedEdge === 'left') {
    if (type === 'right') {
      const width = value - left;
      if (!isFiniteNumber(width) || width < minSize) return null;
      return { left, top: rect.top, width, height: rect.height };
    }
    if (type === 'center') {
      // Center at value means right = 2*value - left
      const width = (value - left) * 2;
      if (!isFiniteNumber(width) || width < minSize) return null;
      return { left, top: rect.top, width, height: rect.height };
    }
    // Snapping to 'left' when left is fixed doesn't make sense
    return rect;
  }

  // When right edge is fixed, we can snap left edge or center
  if (fixedEdge === 'right') {
    if (type === 'left') {
      const width = right - value;
      if (!isFiniteNumber(width) || width < minSize) return null;
      return { left: value, top: rect.top, width, height: rect.height };
    }
    if (type === 'center') {
      // Center at value means left = 2*value - right
      const nextLeft = 2 * value - right;
      const width = right - nextLeft;
      if (!isFiniteNumber(width) || width < minSize) return null;
      return { left: nextLeft, top: rect.top, width, height: rect.height };
    }
    // Snapping to 'right' when right is fixed doesn't make sense
    return rect;
  }

  // No fixed edge - no X resize happening
  return rect;
}

/**
 * Apply Y-axis snap by adjusting rect to align specified edge/center with anchor value.
 */
function applyYSnap(
  rect: ViewportRect,
  fixedEdge: FixedEdgeY,
  type: SnapAnchorYType,
  value: number,
  minSize: number,
): ViewportRect | null {
  const top = rect.top;
  const bottom = rectBottom(rect);

  if (fixedEdge === 'top') {
    if (type === 'bottom') {
      const height = value - top;
      if (!isFiniteNumber(height) || height < minSize) return null;
      return { left: rect.left, top, width: rect.width, height };
    }
    if (type === 'middle') {
      const height = (value - top) * 2;
      if (!isFiniteNumber(height) || height < minSize) return null;
      return { left: rect.left, top, width: rect.width, height };
    }
    return rect;
  }

  if (fixedEdge === 'bottom') {
    if (type === 'top') {
      const height = bottom - value;
      if (!isFiniteNumber(height) || height < minSize) return null;
      return { left: rect.left, top: value, width: rect.width, height };
    }
    if (type === 'middle') {
      const nextTop = 2 * value - bottom;
      const height = bottom - nextTop;
      if (!isFiniteNumber(height) || height < minSize) return null;
      return { left: rect.left, top: nextTop, width: rect.width, height };
    }
    return rect;
  }

  return rect;
}

// =============================================================================
// Best Snap Selection
// =============================================================================

/**
 * Find the best X-axis snap among all anchors.
 *
 * Selection criteria:
 * 1. Within threshold distance
 * 2. Produces valid rect (respects minSize)
 * 3. Closest distance wins
 * 4. Sibling anchors preferred over viewport at equal distance
 */
function findBestXSnap(
  rect: ViewportRect,
  fixedEdge: FixedEdgeX,
  anchors: readonly SnapAnchorX[],
  allowedTypes: readonly SnapAnchorXType[],
  threshold: number,
  minSize: number,
): SnapCandidate<SnapAnchorX> | null {
  let best: SnapCandidate<SnapAnchorX> | null = null;

  for (const anchor of anchors) {
    if (!allowedTypes.includes(anchor.type)) continue;

    const currentValue = getRectXValue(rect, anchor.type);
    const distance = Math.abs(anchor.value - currentValue);
    if (distance > threshold) continue;

    const snappedRect = applyXSnap(rect, fixedEdge, anchor.type, anchor.value, minSize);
    if (!snappedRect) continue;

    // Compare with current best
    const isBetter =
      !best ||
      distance < best.distance ||
      (distance === best.distance &&
        anchor.source === 'sibling' &&
        best.anchor.source !== 'sibling');

    if (isBetter) {
      best = { distance, anchor, snappedRect };
    }
  }

  return best;
}

/**
 * Find the best Y-axis snap among all anchors.
 */
function findBestYSnap(
  rect: ViewportRect,
  fixedEdge: FixedEdgeY,
  anchors: readonly SnapAnchorY[],
  allowedTypes: readonly SnapAnchorYType[],
  threshold: number,
  minSize: number,
): SnapCandidate<SnapAnchorY> | null {
  let best: SnapCandidate<SnapAnchorY> | null = null;

  for (const anchor of anchors) {
    if (!allowedTypes.includes(anchor.type)) continue;

    const currentValue = getRectYValue(rect, anchor.type);
    const distance = Math.abs(anchor.value - currentValue);
    if (distance > threshold) continue;

    const snappedRect = applyYSnap(rect, fixedEdge, anchor.type, anchor.value, minSize);
    if (!snappedRect) continue;

    const isBetter =
      !best ||
      distance < best.distance ||
      (distance === best.distance &&
        anchor.source === 'sibling' &&
        best.anchor.source !== 'sibling');

    if (isBetter) {
      best = { distance, anchor, snappedRect };
    }
  }

  return best;
}

// =============================================================================
// Guide Line Generation
// =============================================================================

/**
 * Build guide lines from active snap locks.
 *
 * Guide line extent:
 * - For viewport anchors: full viewport span
 * - For sibling anchors: from source element edge to snapped element edge
 *
 * Note: viewport dimensions are passed as parameters to keep this function pure
 * (no global window access), enabling better testability and potential worker usage.
 */
function buildGuideLines(
  snappedRect: ViewportRect,
  lockX: SnapLockX | null,
  lockY: SnapLockY | null,
  viewport: ViewportSize,
): ViewportLine[] {
  const guides: ViewportLine[] = [];
  const viewportWidth = Math.max(1, viewport.width);
  const viewportHeight = Math.max(1, viewport.height);

  if (lockX) {
    const x = lockX.value;
    if (lockX.source === 'viewport' || !lockX.sourceRect) {
      // Full viewport vertical line
      guides.push({ x1: x, y1: 0, x2: x, y2: viewportHeight });
    } else {
      // Line spanning from source to target
      const sourceRect = lockX.sourceRect;
      const y1 = Math.min(sourceRect.top, snappedRect.top);
      const y2 = Math.max(rectBottom(sourceRect), rectBottom(snappedRect));
      guides.push({ x1: x, y1, x2: x, y2 });
    }
  }

  if (lockY) {
    const y = lockY.value;
    if (lockY.source === 'viewport' || !lockY.sourceRect) {
      // Full viewport horizontal line
      guides.push({ x1: 0, y1: y, x2: viewportWidth, y2: y });
    } else {
      // Line spanning from source to target
      const sourceRect = lockY.sourceRect;
      const x1 = Math.min(sourceRect.left, snappedRect.left);
      const x2 = Math.max(rectRight(sourceRect), rectRight(snappedRect));
      guides.push({ x1, y1: y, x2, y2: y });
    }
  }

  return guides;
}

// =============================================================================
// Main Computation
// =============================================================================

/**
 * Compute snapping for a resize operation.
 *
 * This function is pure (no DOM access) and should be called every frame
 * during resize drag operations.
 *
 * Snap semantics for resize:
 * - One edge is fixed (opposite to drag direction)
 * - The moving edge or center can snap to anchors
 * - Hysteresis keeps snap stable once activated
 */
export function computeResizeSnap(params: ComputeResizeSnapParams): SnapResult {
  const { rect, resize, anchors, thresholdPx, hysteresisPx, minSizePx, viewport } = params;

  // Early return for invalid input
  if (!isValidRect(rect)) {
    return { snappedRect: rect, guideLines: [], lockX: null, lockY: null };
  }

  // Determine fixed edges based on resize direction
  // When dragging from west, right edge is fixed; when from east, left is fixed
  const fixedEdgeX: FixedEdgeX = resize.hasWest ? 'right' : resize.hasEast ? 'left' : null;
  const fixedEdgeY: FixedEdgeY = resize.hasNorth ? 'bottom' : resize.hasSouth ? 'top' : null;

  // Determine allowed snap targets based on fixed edge
  // When left is fixed, we can snap right edge or center
  // When right is fixed, we can snap left edge or center
  const allowedXTypes: readonly SnapAnchorXType[] =
    fixedEdgeX === 'left' ? ['right', 'center'] : fixedEdgeX === 'right' ? ['left', 'center'] : [];

  const allowedYTypes: readonly SnapAnchorYType[] =
    fixedEdgeY === 'top' ? ['bottom', 'middle'] : fixedEdgeY === 'bottom' ? ['top', 'middle'] : [];

  // Start with input rect
  let snappedRect: ViewportRect = { ...rect };
  let lockX: SnapLockX | null = params.lockX;
  let lockY: SnapLockY | null = params.lockY;

  // ==========================================================================
  // X-axis snapping
  // ==========================================================================
  if (fixedEdgeX) {
    // Check if existing lock should be maintained (hysteresis)
    if (lockX) {
      if (!allowedXTypes.includes(lockX.type)) {
        // Lock type no longer valid for current resize direction
        lockX = null;
      } else {
        const currentValue = getRectXValue(snappedRect, lockX.type);
        const distance = Math.abs(lockX.value - currentValue);
        const canApply = applyXSnap(snappedRect, fixedEdgeX, lockX.type, lockX.value, minSizePx);

        // Keep lock if within threshold + hysteresis and can apply
        if (distance > thresholdPx + hysteresisPx || !canApply) {
          lockX = null;
        }
      }
    }

    // Apply existing lock or find new snap
    if (lockX) {
      const applied = applyXSnap(snappedRect, fixedEdgeX, lockX.type, lockX.value, minSizePx);
      if (applied) snappedRect = applied;
    } else {
      const best = findBestXSnap(
        snappedRect,
        fixedEdgeX,
        anchors.x,
        allowedXTypes,
        thresholdPx,
        minSizePx,
      );
      if (best) {
        lockX = {
          type: best.anchor.type,
          value: best.anchor.value,
          source: best.anchor.source,
          sourceRect: best.anchor.sourceRect ?? null,
        };
        snappedRect = best.snappedRect;
      }
    }
  } else {
    // Not resizing horizontally - clear lock
    lockX = null;
  }

  // ==========================================================================
  // Y-axis snapping
  // ==========================================================================
  if (fixedEdgeY) {
    // Check if existing lock should be maintained (hysteresis)
    if (lockY) {
      if (!allowedYTypes.includes(lockY.type)) {
        lockY = null;
      } else {
        const currentValue = getRectYValue(snappedRect, lockY.type);
        const distance = Math.abs(lockY.value - currentValue);
        const canApply = applyYSnap(snappedRect, fixedEdgeY, lockY.type, lockY.value, minSizePx);

        if (distance > thresholdPx + hysteresisPx || !canApply) {
          lockY = null;
        }
      }
    }

    // Apply existing lock or find new snap
    if (lockY) {
      const applied = applyYSnap(snappedRect, fixedEdgeY, lockY.type, lockY.value, minSizePx);
      if (applied) snappedRect = applied;
    } else {
      const best = findBestYSnap(
        snappedRect,
        fixedEdgeY,
        anchors.y,
        allowedYTypes,
        thresholdPx,
        minSizePx,
      );
      if (best) {
        lockY = {
          type: best.anchor.type,
          value: best.anchor.value,
          source: best.anchor.source,
          sourceRect: best.anchor.sourceRect ?? null,
        };
        snappedRect = best.snappedRect;
      }
    }
  } else {
    lockY = null;
  }

  // Build guide lines (viewport passed for pure function)
  const guideLines = buildGuideLines(snappedRect, lockX, lockY, viewport);

  return { snappedRect, guideLines, lockX, lockY };
}

// =============================================================================
// Distance Labels (Phase 4.3)
// =============================================================================

/**
 * Check if a gap should be shown as a distance label.
 * Requires gap > 0 (no overlap/touching) AND gap >= minGap threshold.
 */
function shouldShowGap(gap: number, minGap: number): boolean {
  return isFiniteNumber(gap) && gap > 0 && gap >= minGap;
}

/**
 * Format a pixel value for display.
 */
function formatDistanceText(px: number): string {
  const rounded = Math.round(px);
  const normalized = Object.is(rounded, -0) ? 0 : rounded;
  return `${normalized}px`;
}

/**
 * Clamp a value within a range.
 */
function clamp(value: number, min: number, max: number): number {
  if (!isFiniteNumber(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Compute distance labels from active snap locks.
 *
 * Rules (as per Phase 4.3 decisions):
 * - Hide when gap <= 0 (overlap or touching)
 * - Hide when gap < minGapPx (default 1px)
 * - For sibling locks:
 *   - lockX (vertical guide) → show vertical gap (Y) between rect and sourceRect
 *   - lockY (horizontal guide) → show horizontal gap (X) between rect and sourceRect
 * - For viewport locks:
 *   - Edge align shows the corresponding margin; if filtered, fallback to opposite side
 *   - Center align shows both margins (may yield 2 labels)
 *
 * Note:
 * - When alignment occurs, show spacing in "the other direction"
 * - lockX is a vertical alignment line, so show Y-direction spacing
 * - lockY is a horizontal alignment line, so show X-direction spacing
 */
export function computeDistanceLabels(params: ComputeDistanceLabelsParams): DistanceLabel[] {
  const { rect, lockX, lockY, viewport, minGapPx } = params;

  if (!isValidRect(rect)) return [];

  // Ensure viewport dimensions are valid (NaN-safe)
  const viewportWidth = isFiniteNumber(viewport.width) ? Math.max(1, viewport.width) : 1;
  const viewportHeight = isFiniteNumber(viewport.height) ? Math.max(1, viewport.height) : 1;
  const minGap = Math.max(0, minGapPx);

  const labels: DistanceLabel[] = [];

  // ==========================================================================
  // Sibling gaps (derived from active locks)
  // ==========================================================================

  // X lock (vertical guide) → show vertical gap (Y-axis distance)
  if (lockX && lockX.source === 'sibling' && lockX.sourceRect) {
    const other = lockX.sourceRect;
    const gapAbove = rect.top - rectBottom(other); // target is below source
    const gapBelow = other.top - rectBottom(rect); // target is above source

    if (shouldShowGap(gapAbove, minGap)) {
      labels.push({
        kind: 'sibling',
        axis: 'y',
        value: Math.round(gapAbove),
        text: formatDistanceText(gapAbove),
        line: { x1: lockX.value, y1: rectBottom(other), x2: lockX.value, y2: rect.top },
      });
    } else if (shouldShowGap(gapBelow, minGap)) {
      labels.push({
        kind: 'sibling',
        axis: 'y',
        value: Math.round(gapBelow),
        text: formatDistanceText(gapBelow),
        line: { x1: lockX.value, y1: rectBottom(rect), x2: lockX.value, y2: other.top },
      });
    }
  }

  // Y lock (horizontal guide) → show horizontal gap (X-axis distance)
  if (lockY && lockY.source === 'sibling' && lockY.sourceRect) {
    const other = lockY.sourceRect;
    const gapLeft = rect.left - rectRight(other); // target is right of source
    const gapRight = other.left - rectRight(rect); // target is left of source

    if (shouldShowGap(gapLeft, minGap)) {
      labels.push({
        kind: 'sibling',
        axis: 'x',
        value: Math.round(gapLeft),
        text: formatDistanceText(gapLeft),
        line: { x1: rectRight(other), y1: lockY.value, x2: rect.left, y2: lockY.value },
      });
    } else if (shouldShowGap(gapRight, minGap)) {
      labels.push({
        kind: 'sibling',
        axis: 'x',
        value: Math.round(gapRight),
        text: formatDistanceText(gapRight),
        line: { x1: rectRight(rect), y1: lockY.value, x2: other.left, y2: lockY.value },
      });
    }
  }

  // ==========================================================================
  // Viewport margins (derived from viewport locks)
  // ==========================================================================

  if (lockX && lockX.source === 'viewport') {
    // Y position for horizontal measurement lines (center of element)
    const y = clamp(rectCenterY(rect), 0, viewportHeight);
    const leftGap = rect.left;
    const rightGap = viewportWidth - rectRight(rect);

    const addLeft = (): boolean => {
      if (!shouldShowGap(leftGap, minGap)) return false;
      labels.push({
        kind: 'viewport',
        axis: 'x',
        value: Math.round(leftGap),
        text: formatDistanceText(leftGap),
        line: { x1: 0, y1: y, x2: rect.left, y2: y },
      });
      return true;
    };

    const addRight = (): boolean => {
      if (!shouldShowGap(rightGap, minGap)) return false;
      labels.push({
        kind: 'viewport',
        axis: 'x',
        value: Math.round(rightGap),
        text: formatDistanceText(rightGap),
        line: { x1: rectRight(rect), y1: y, x2: viewportWidth, y2: y },
      });
      return true;
    };

    // Center align: show both margins
    // Edge align: show corresponding margin, fallback to opposite
    if (lockX.type === 'center') {
      addLeft();
      addRight();
    } else if (lockX.type === 'left') {
      if (!addLeft()) addRight();
    } else {
      if (!addRight()) addLeft();
    }
  }

  if (lockY && lockY.source === 'viewport') {
    // X position for vertical measurement lines (center of element)
    const x = clamp(rectCenterX(rect), 0, viewportWidth);
    const topGap = rect.top;
    const bottomGap = viewportHeight - rectBottom(rect);

    const addTop = (): boolean => {
      if (!shouldShowGap(topGap, minGap)) return false;
      labels.push({
        kind: 'viewport',
        axis: 'y',
        value: Math.round(topGap),
        text: formatDistanceText(topGap),
        line: { x1: x, y1: 0, x2: x, y2: rect.top },
      });
      return true;
    };

    const addBottom = (): boolean => {
      if (!shouldShowGap(bottomGap, minGap)) return false;
      labels.push({
        kind: 'viewport',
        axis: 'y',
        value: Math.round(bottomGap),
        text: formatDistanceText(bottomGap),
        line: { x1: x, y1: rectBottom(rect), x2: x, y2: viewportHeight },
      });
      return true;
    };

    // Middle align: show both margins
    // Edge align: show corresponding margin, fallback to opposite
    if (lockY.type === 'middle') {
      addTop();
      addBottom();
    } else if (lockY.type === 'top') {
      if (!addTop()) addBottom();
    } else {
      if (!addBottom()) addTop();
    }
  }

  return labels;
}
