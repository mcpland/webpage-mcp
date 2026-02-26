/**
 * Drag Reorder Controller (Phase 2.4-2.6)
 *
 * Coordinates drag-to-reorder interactions:
 * - Renders drag ghost + insertion indicator via CanvasOverlay
 * - Computes insertion position from pointer hit-testing
 * - Applies DOM move on drop (sibling insert only in Phase 1)
 * - Records the drag as a single move transaction (undo/redo)
 *
 * Phase 1 constraints:
 * - Sibling insertion only (before/after hit target), no "insert as child"
 * - No cross-root moves (Document/ShadowRoot boundary)
 * - Disallow moving HTML/BODY/HEAD
 * - Disallow inserting into own subtree
 * - Layout heuristic: supports 1D layouts (vertical block, flex-column, flex-row)
 * - Grid layouts are not supported (2D positioning is too complex)
 * - RTL direction is not handled (future enhancement)
 */

import {
  WEB_EDITOR_V2_DRAG_HYSTERESIS_PX,
  WEB_EDITOR_V2_DRAG_MAX_HIT_ELEMENTS,
  WEB_EDITOR_V2_LOG_PREFIX,
} from '../constants';
import type {
  DragCancelEvent,
  DragEndEvent,
  DragMoveEvent,
  DragStartEvent,
} from '../core/event-controller';
import type { PositionTracker } from '../core/position-tracker';
import type { MoveTransactionHandle, TransactionManager } from '../core/transaction-manager';
import type { CanvasOverlay, ViewportLine, ViewportRect } from '../overlay/canvas-overlay';
import { Disposer } from '../utils/disposables';

// =============================================================================
// Types
// =============================================================================

export interface DragReorderControllerOptions {
  /** Check if a node belongs to the editor overlay */
  isOverlayElement: (node: unknown) => boolean;
  /** UI root element (for disabling pointer events during drag) */
  uiRoot: HTMLElement;
  /** Canvas overlay for rendering ghost and insertion line */
  canvasOverlay: CanvasOverlay;
  /** Position tracker for syncing after drop */
  positionTracker: PositionTracker;
  /** Transaction manager for recording move transactions */
  transactionManager: TransactionManager;
}

export interface DragReorderController {
  /** Called when drag starts */
  onDragStart(ev: DragStartEvent): boolean;
  /** Called on pointer move during drag */
  onDragMove(ev: DragMoveEvent): void;
  /** Called when drag ends (drop) */
  onDragEnd(ev: DragEndEvent): void;
  /** Called when drag is cancelled */
  onDragCancel(ev: DragCancelEvent): void;
  /** Cleanup resources */
  dispose(): void;
}

type InsertSide = 'before' | 'after';

interface InsertPosition {
  /** The hit element */
  target: Element;
  /** The parent element of the hit target */
  parent: Element;
  /** Insert before or after the target */
  side: InsertSide;
  /** The reference node for insertBefore (null means append) */
  referenceNode: ChildNode | null;
  /** Whether this is a no-op (same position as current) */
  isNoop: boolean;
  /** The indicator line to draw */
  indicatorLine: ViewportLine;
}

interface DragState {
  /** Pointer ID being tracked */
  pointerId: number;
  /** The element being dragged */
  draggedElement: Element;
  /** The root node of the dragged element (Document or ShadowRoot) */
  draggedRoot: Document | ShadowRoot;
  /** Initial bounding rect of the dragged element */
  startRect: ViewportRect;
  /** Offset from pointer to element top-left */
  pointerOffsetX: number;
  pointerOffsetY: number;
  /** Last known pointer position */
  lastClientX: number;
  lastClientY: number;
  /** Current insertion preview */
  preview: InsertPosition | null;
  /** Saved pointer-events style for uiRoot */
  uiPointerEventsBefore: string;
  /** Move transaction handle */
  moveHandle: MoveTransactionHandle;
}

// =============================================================================
// Helpers
// =============================================================================

function isDocumentOrShadowRoot(value: unknown): value is Document | ShadowRoot {
  return value instanceof Document || value instanceof ShadowRoot;
}

function isDisallowedDragElement(element: Element): boolean {
  const tag = element.tagName?.toUpperCase();
  return tag === 'HTML' || tag === 'BODY' || tag === 'HEAD';
}

function toViewportRect(rect: DOMRectReadOnly): ViewportRect | null {
  const { left, top, width, height } = rect;
  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null;
  }
  return {
    left,
    top,
    width: Math.max(0, width),
    height: Math.max(0, height),
  };
}

/**
 * Get elements at a viewport point from a specific root (Document or ShadowRoot).
 * This is Shadow DOM aware - uses the root's elementsFromPoint to correctly
 * hit elements inside that shadow tree.
 */
function getHitElementsFromRoot(
  root: Document | ShadowRoot,
  clientX: number,
  clientY: number,
): Element[] {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return [];

  try {
    if (typeof root.elementsFromPoint === 'function') {
      return root.elementsFromPoint(clientX, clientY);
    }
  } catch {
    // Fall back to elementFromPoint
  }

  try {
    const el = root.elementFromPoint(clientX, clientY);
    return el ? [el] : [];
  } catch {
    return [];
  }
}

/**
 * Container axis information for drag reordering.
 * - axis: The primary axis for insertion ('x' for horizontal, 'y' for vertical)
 * - reverse: Whether the visual order is reversed from DOM order
 */
type ContainerAxis = { axis: 'x' | 'y'; reverse: boolean } | null;

/**
 * Determine the insertion axis for the parent container.
 * - Grid layouts are not supported (returns null)
 * - Flex row/column are supported with appropriate axis
 * - Non-flex layouts default to vertical (block flow)
 */
function getContainerAxis(parent: Element): ContainerAxis {
  try {
    const style = window.getComputedStyle(parent);
    const display = style.display;

    // Reject grid layouts - 2D positioning is too complex for Phase 1
    if (display === 'grid' || display === 'inline-grid') return null;

    // Handle flex layouts with appropriate axis
    if (display === 'flex' || display === 'inline-flex') {
      // Reject wrapped flex layouts - they become 2D
      const wrap = style.flexWrap;
      if (wrap === 'wrap' || wrap === 'wrap-reverse') return null;

      const dir = style.flexDirection;
      switch (dir) {
        case 'row':
          return { axis: 'x', reverse: false };
        case 'row-reverse':
          return { axis: 'x', reverse: true };
        case 'column':
          return { axis: 'y', reverse: false };
        case 'column-reverse':
          return { axis: 'y', reverse: true };
        default:
          // Unknown flex direction - fall back to vertical
          return { axis: 'y', reverse: false };
      }
    }

    // Non-flex layouts (block, inline-block, etc.) use vertical flow
    return { axis: 'y', reverse: false };
  } catch {
    return null;
  }
}

/**
 * Choose insert side with hysteresis to avoid flip-flopping.
 * Supports both X and Y axes, with proper handling for reverse layouts.
 *
 * @param clientPos - The client coordinate (clientX for X axis, clientY for Y axis)
 * @param rect - The bounding rect of the target element
 * @param prevSide - The previous side (for hysteresis)
 * @param axis - The axis to use for comparison ('x' or 'y')
 * @param reverse - Whether the layout is reversed (row-reverse, column-reverse)
 * @returns The DOM insertion side ('before' or 'after')
 */
function chooseSideWithHysteresis(
  clientPos: number,
  rect: DOMRectReadOnly,
  prevSide: InsertSide | null,
  axis: 'x' | 'y',
  reverse: boolean,
): InsertSide {
  // Calculate midpoint based on axis
  const mid = axis === 'x' ? rect.left + rect.width / 2 : rect.top + rect.height / 2;

  // For reverse layouts, we need to flip the comparison logic
  // In reverse mode, "before in visual" means "after in DOM"
  const effectivePos = reverse ? -clientPos : clientPos;
  const effectiveMid = reverse ? -mid : mid;

  if (!prevSide) {
    return effectivePos < effectiveMid ? 'before' : 'after';
  }

  // Apply hysteresis band around midline
  if (prevSide === 'before') {
    return effectivePos > effectiveMid + WEB_EDITOR_V2_DRAG_HYSTERESIS_PX ? 'after' : 'before';
  }

  return effectivePos < effectiveMid - WEB_EDITOR_V2_DRAG_HYSTERESIS_PX ? 'before' : 'after';
}

/**
 * Check if the proposed move is a no-op (same position as current)
 */
function isNoopMove(
  draggedElement: Element,
  parent: Element,
  referenceNode: ChildNode | null,
): boolean {
  if (draggedElement.parentNode !== parent) return false;

  // Reference is the dragged element itself
  if (referenceNode === draggedElement) return true;

  // Reference is the element right after dragged (no change)
  if (referenceNode === draggedElement.nextSibling) return true;

  // Reference is null (append) and dragged is already last
  if (referenceNode === null && draggedElement.nextSibling === null) return true;

  return false;
}

/**
 * Check if an element is a valid drop target
 */
function isValidDropTarget(
  el: Element,
  draggedElement: Element,
  draggedRoot: Document | ShadowRoot,
  isOverlayElement: (node: unknown) => boolean,
): boolean {
  if (!el.isConnected) return false;
  if (isOverlayElement(el)) return false;
  if (el === draggedElement) return false;
  if (isDisallowedDragElement(el)) return false;

  // Prevent inserting into itself / its subtree
  if (draggedElement.contains(el)) return false;

  if (!el.parentElement) return false;

  const root = el.getRootNode?.();
  if (!isDocumentOrShadowRoot(root)) return false;
  if (root !== draggedRoot) return false;

  return true;
}

// =============================================================================
// Implementation
// =============================================================================

export function createDragReorderController(
  options: DragReorderControllerOptions,
): DragReorderController {
  const disposer = new Disposer();
  const { canvasOverlay, isOverlayElement, positionTracker, transactionManager, uiRoot } = options;

  let state: DragState | null = null;
  let rafId: number | null = null;

  function cancelRaf(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }
  disposer.add(cancelRaf);

  function setUiPointerEventsEnabled(enabled: boolean, s: DragState): void {
    uiRoot.style.pointerEvents = enabled ? s.uiPointerEventsBefore : 'none';
  }

  function clearVisuals(): void {
    canvasOverlay.setDragGhostRect(null);
    canvasOverlay.setInsertionLine(null);
    canvasOverlay.render();
  }

  function cleanup(): void {
    const s = state;
    if (!s) return;

    cancelRaf();
    setUiPointerEventsEnabled(true, s);
    clearVisuals();
    state = null;
  }

  /**
   * Compute the insertion position from current pointer location.
   * Uses the dragged element's root for hit-testing to correctly handle Shadow DOM.
   */
  function computeInsertPosition(s: DragState): InsertPosition | null {
    // Use the dragged element's root for Shadow DOM aware hit-testing
    const hits = getHitElementsFromRoot(s.draggedRoot, s.lastClientX, s.lastClientY).slice(
      0,
      WEB_EDITOR_V2_DRAG_MAX_HIT_ELEMENTS,
    );
    const target = hits.find((el) =>
      isValidDropTarget(el, s.draggedElement, s.draggedRoot, isOverlayElement),
    );
    if (!target) return null;

    const parent = target.parentElement;
    if (!parent) return null;

    // Get container axis info (null means unsupported layout like grid)
    const container = getContainerAxis(parent);
    if (!container) return null;

    let rect: DOMRectReadOnly;
    try {
      rect = target.getBoundingClientRect();
    } catch {
      return null;
    }

    if (
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.top) ||
      rect.width <= 0.5 ||
      rect.height <= 0.5
    ) {
      return null;
    }

    // Choose side based on the container's axis
    const prevSide = s.preview && s.preview.target === target ? s.preview.side : null;
    const clientPos = container.axis === 'x' ? s.lastClientX : s.lastClientY;
    const side = chooseSideWithHysteresis(
      clientPos,
      rect,
      prevSide,
      container.axis,
      container.reverse,
    );
    const referenceNode = side === 'before' ? target : target.nextSibling;

    const noop = isNoopMove(s.draggedElement, parent, referenceNode);

    // Draw indicator line based on axis and reverse mode
    let indicatorLine: ViewportLine;
    if (container.axis === 'x') {
      // Horizontal layout: draw vertical insertion line
      // For reverse layouts, swap the visual positions of before/after
      const beforeX = container.reverse ? rect.left + rect.width : rect.left;
      const afterX = container.reverse ? rect.left : rect.left + rect.width;
      const x = side === 'before' ? beforeX : afterX;
      indicatorLine = {
        x1: x,
        y1: rect.top,
        x2: x,
        y2: rect.top + rect.height,
      };
    } else {
      // Vertical layout: draw horizontal insertion line
      // For reverse layouts, swap the visual positions of before/after
      const beforeY = container.reverse ? rect.top + rect.height : rect.top;
      const afterY = container.reverse ? rect.top : rect.top + rect.height;
      const y = side === 'before' ? beforeY : afterY;
      indicatorLine = {
        x1: rect.left,
        y1: y,
        x2: rect.left + rect.width,
        y2: y,
      };
    }

    return { target, parent, side, referenceNode, isNoop: noop, indicatorLine };
  }

  /**
   * Update frame: compute ghost rect and insertion preview, then render
   */
  function updateFrame(): void {
    rafId = null;
    const s = state;
    if (!s) return;

    if (!s.draggedElement.isConnected) {
      s.moveHandle.cancel();
      cleanup();
      return;
    }

    // Compute ghost rect based on current pointer position
    const ghostRect: ViewportRect = {
      left: s.lastClientX - s.pointerOffsetX,
      top: s.lastClientY - s.pointerOffsetY,
      width: s.startRect.width,
      height: s.startRect.height,
    };

    s.preview = computeInsertPosition(s);

    canvasOverlay.setDragGhostRect(ghostRect);
    canvasOverlay.setInsertionLine(s.preview?.indicatorLine ?? null);
    canvasOverlay.render();
  }

  function scheduleUpdate(): void {
    if (disposer.isDisposed) return;
    if (rafId !== null) return;
    rafId = requestAnimationFrame(updateFrame);
  }

  /**
   * Apply the DOM move operation
   */
  function applyDomMove(draggedElement: Element, insert: InsertPosition): boolean {
    const parent = insert.parent;
    if (!parent.isConnected) return false;

    // Prevent cycles (moving into own descendant)
    if (draggedElement === parent) return false;
    if (draggedElement.contains(parent)) return false;

    // Disallow cross-root moves
    const rootA = draggedElement.getRootNode?.();
    const rootB = parent.getRootNode?.();
    if (!isDocumentOrShadowRoot(rootA) || !isDocumentOrShadowRoot(rootB) || rootA !== rootB) {
      return false;
    }

    // Re-validate target and parent relationship
    if (!insert.target.isConnected) return false;
    if (insert.target.parentElement !== parent) return false;

    const ref: ChildNode | null =
      insert.side === 'before' ? insert.target : insert.target.nextSibling;
    if (isNoopMove(draggedElement, parent, ref)) return true;

    try {
      parent.insertBefore(draggedElement, ref);
      return true;
    } catch (error) {
      console.warn(`${WEB_EDITOR_V2_LOG_PREFIX} DOM move failed:`, error);
      return false;
    }
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  function onDragStart(ev: DragStartEvent): boolean {
    if (disposer.isDisposed) return false;

    // Cancel any stale session first
    if (state) {
      state.moveHandle.cancel();
      cleanup();
    }

    const draggedElement = ev.draggedElement;
    if (!draggedElement || !(draggedElement instanceof Element)) return false;
    if (!draggedElement.isConnected) return false;
    if (isDisallowedDragElement(draggedElement)) return false;

    const rawRoot = draggedElement.getRootNode?.();
    const draggedRoot = isDocumentOrShadowRoot(rawRoot) ? rawRoot : document;

    let rect: DOMRectReadOnly;
    try {
      rect = draggedElement.getBoundingClientRect();
    } catch {
      return false;
    }

    const startRect = toViewportRect(rect);
    if (!startRect || startRect.width <= 0.5 || startRect.height <= 0.5) return false;

    const moveHandle = transactionManager.beginMove(draggedElement);
    if (!moveHandle) return false;

    const prevPointerEvents = uiRoot.style.pointerEvents;

    state = {
      pointerId: ev.pointerId,
      draggedElement,
      draggedRoot,
      startRect,
      pointerOffsetX: ev.startClientX - startRect.left,
      pointerOffsetY: ev.startClientY - startRect.top,
      lastClientX: ev.clientX,
      lastClientY: ev.clientY,
      preview: null,
      uiPointerEventsBefore: prevPointerEvents,
      moveHandle,
    };

    setUiPointerEventsEnabled(false, state);
    scheduleUpdate();

    console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Drag started`);
    return true;
  }

  function onDragMove(ev: DragMoveEvent): void {
    const s = state;
    if (!s) return;
    if (ev.pointerId !== s.pointerId) return;

    s.lastClientX = ev.clientX;
    s.lastClientY = ev.clientY;
    scheduleUpdate();
  }

  function onDragEnd(ev: DragEndEvent): void {
    const s = state;
    if (!s) return;
    if (ev.pointerId !== s.pointerId) return;

    s.lastClientX = ev.clientX;
    s.lastClientY = ev.clientY;

    cancelRaf();
    const insert = computeInsertPosition(s);

    if (!insert || insert.isNoop) {
      s.moveHandle.cancel();
      cleanup();
      console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Drag cancelled (no-op or no target)`);
      return;
    }

    const ok = applyDomMove(s.draggedElement, insert);
    if (!ok) {
      s.moveHandle.cancel();
      cleanup();
      console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Drag failed (DOM move error)`);
      return;
    }

    s.moveHandle.commit(s.draggedElement);
    positionTracker.forceUpdate();
    cleanup();

    console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Drag completed`);
  }

  function onDragCancel(_ev: DragCancelEvent): void {
    const s = state;
    if (!s) return;
    s.moveHandle.cancel();
    cleanup();

    console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Drag cancelled`);
  }

  // Cleanup on dispose
  disposer.add(() => {
    const s = state;
    if (!s) return;
    s.moveHandle.cancel();
    cleanup();
  });

  return {
    onDragStart,
    onDragMove,
    onDragEnd,
    onDragCancel,
    dispose: () => disposer.dispose(),
  };
}
