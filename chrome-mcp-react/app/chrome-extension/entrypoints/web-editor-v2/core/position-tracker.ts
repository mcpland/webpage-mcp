/**
 * Position Tracker
 *
 * Keeps hover/selection rectangles in sync with viewport changes (scroll/resize).
 *
 * Design:
 * - Uses passive scroll/resize listeners to avoid blocking scrolling
 * - Coalesces updates with requestAnimationFrame so layout is read at most once per frame
 * - Drops references to elements that are no longer connected to the DOM
 * - Only emits updates when rect values actually change (with epsilon tolerance)
 *
 * Performance considerations:
 * - getBoundingClientRect() calls are batched to single rAF
 * - Sub-pixel jitter is filtered to reduce unnecessary redraws
 * - Passive listeners don't block smooth scrolling
 */

import type { ViewportRect } from '../overlay/canvas-overlay';
import { Disposer } from '../utils/disposables';

// =============================================================================
// Types
// =============================================================================

/** Options for creating the position tracker */
export interface PositionTrackerOptions {
  /** Callback when tracked positions change */
  onPositionUpdate: (rects: TrackedRects) => void;
}

/** Container for tracked element rectangles */
export interface TrackedRects {
  /** Hover element rectangle (null if no hover) */
  hover: ViewportRect | null;
  /** Selection element rectangle (null if no selection) */
  selection: ViewportRect | null;
}

/** Position tracker public interface */
export interface PositionTracker {
  /** Set the element to track for hover */
  setHoverElement(element: Element | null): void;
  /** Set the element to track for selection */
  setSelectionElement(element: Element | null): void;
  /** Force a synchronous position update (useful for initialization) */
  forceUpdate(): void;
  /** Cleanup listeners and pending rAF */
  dispose(): void;
}

// =============================================================================
// Constants
// =============================================================================

/** Passive listener options for scroll/resize */
const PASSIVE_LISTENER: AddEventListenerOptions = { passive: true };

/** Sub-pixel threshold for rect comparison (avoids jitter-induced redraws) */
const RECT_EPSILON = 0.5;

/**
 * MutationObserver options for selection sync.
 * Keep lightweight: only observe childList changes in subtree.
 * Attribute changes are not observed as they rarely affect element position/removal.
 */
const SELECTION_MUTATION_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert DOMRect to ViewportRect, returning null for invalid values
 */
function toViewportRect(domRect: DOMRectReadOnly): ViewportRect | null {
  const { left, top, width, height } = domRect;

  if (
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  // Ensure non-negative dimensions
  return {
    left,
    top,
    width: Math.max(0, width),
    height: Math.max(0, height),
  };
}

/**
 * Check if two numbers are approximately equal
 */
function approximatelyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < RECT_EPSILON;
}

/**
 * Check if two ViewportRects are approximately equal
 */
function rectApproximatelyEqual(a: ViewportRect | null, b: ViewportRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;

  return (
    approximatelyEqual(a.left, b.left) &&
    approximatelyEqual(a.top, b.top) &&
    approximatelyEqual(a.width, b.width) &&
    approximatelyEqual(a.height, b.height)
  );
}

/**
 * Check if two TrackedRects are approximately equal
 */
function trackedRectsEqual(a: TrackedRects, b: TrackedRects): boolean {
  return (
    rectApproximatelyEqual(a.hover, b.hover) && rectApproximatelyEqual(a.selection, b.selection)
  );
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a position tracker for monitoring element positions.
 *
 * The tracker automatically updates when the viewport scrolls or resizes,
 * and notifies via callback when tracked element positions change.
 */
export function createPositionTracker(options: PositionTrackerOptions): PositionTracker {
  const { onPositionUpdate } = options;
  const disposer = new Disposer();

  // ==========================================================================
  // State
  // ==========================================================================

  let hoverElement: Element | null = null;
  let selectionElement: Element | null = null;
  let lastRects: TrackedRects = { hover: null, selection: null };

  // Single rAF slot for coalescing updates
  let rafId: number | null = null;

  // ==========================================================================
  // RAF Management
  // ==========================================================================

  function cancelRaf(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }
  disposer.add(cancelRaf);

  function scheduleUpdate(): void {
    if (disposer.isDisposed) return;
    if (rafId !== null) return;

    rafId = requestAnimationFrame(() => {
      rafId = null;
      updateIfChanged();
    });
  }

  // ==========================================================================
  // Selection Observers (Phase 2.8)
  // ==========================================================================
  //
  // Observers are only active while an element is selected.
  // - ResizeObserver: watches selected element size changes
  // - MutationObserver: watches DOM structure changes to keep selection rect in sync
  //
  // Design decisions:
  // - Only observe selection (not hover) because hover changes too frequently
  // - MutationObserver on document.body with childList+subtree catches most DOM changes
  // - rAF coalescing in scheduleUpdate() prevents observer storms from causing issues

  /** Disposer for selection-specific observers (recreated when selection changes) */
  let selectionObservers = new Disposer();
  disposer.add(() => selectionObservers.dispose());

  /**
   * Reset selection observers when selection changes.
   * Disconnects old observers and sets up new ones for the current selection.
   */
  function resetSelectionObservers(): void {
    // Disconnect previous observers
    selectionObservers.dispose();
    selectionObservers = new Disposer();

    const target = selectionElement;
    if (!target) return;

    // ResizeObserver: watch selected element size changes
    // This catches CSS transitions, flex/grid reflow, content changes, etc.
    selectionObservers.observeResize(target, () => {
      if (disposer.isDisposed) return;
      // Guard against stale observer callbacks
      if (selectionElement !== target) return;
      scheduleUpdate();
    });

    // MutationObserver: watch for structural DOM changes
    // This catches element removal, reparenting, reordering, etc.
    const mutationCallback = () => {
      if (disposer.isDisposed) return;
      // Guard against stale observer callbacks
      if (selectionElement !== target) return;
      scheduleUpdate();
    };

    // If the element is inside a Shadow DOM, observe that shadow root
    // (MutationObserver doesn't cross shadow boundaries)
    const rootNode = target.getRootNode?.();
    if (rootNode instanceof ShadowRoot) {
      selectionObservers.observeMutation(rootNode, mutationCallback, SELECTION_MUTATION_OPTIONS);
    }

    // Always observe document.body to catch cross-tree changes and removals
    const body = document.body ?? document.documentElement;
    if (body) {
      selectionObservers.observeMutation(body, mutationCallback, SELECTION_MUTATION_OPTIONS);
    }
  }

  // ==========================================================================
  // Position Computation
  // ==========================================================================

  /**
   * Get element if still connected to DOM, null otherwise
   */
  function resolveConnected(element: Element | null): Element | null {
    if (!element) return null;
    return element.isConnected ? element : null;
  }

  /**
   * Safely read element's viewport rect
   */
  function readElementRect(element: Element | null): ViewportRect | null {
    if (!element) return null;
    try {
      return toViewportRect(element.getBoundingClientRect());
    } catch {
      return null;
    }
  }

  /**
   * Compute current rects for all tracked elements
   */
  function computeRects(): TrackedRects {
    // Resolve elements, dropping stale references
    const resolvedHover = resolveConnected(hoverElement);
    const resolvedSelection = resolveConnected(selectionElement);

    // Clear stale element references
    if (hoverElement && !resolvedHover) {
      hoverElement = null;
    }
    if (selectionElement && !resolvedSelection) {
      selectionElement = null;
      // Clean up observers when selection element is disconnected
      resetSelectionObservers();
    }

    // Optimization: if both point to same element, read rect once
    if (resolvedHover && resolvedSelection && resolvedHover === resolvedSelection) {
      const rect = readElementRect(resolvedHover);
      return { hover: rect, selection: rect };
    }

    return {
      hover: readElementRect(resolvedHover),
      selection: readElementRect(resolvedSelection),
    };
  }

  /**
   * Update rects and notify if changed
   */
  function updateIfChanged(): void {
    if (disposer.isDisposed) return;

    const nextRects = computeRects();
    if (trackedRectsEqual(nextRects, lastRects)) return;

    lastRects = nextRects;
    onPositionUpdate(nextRects);
  }

  // ==========================================================================
  // Event Handlers
  // ==========================================================================

  function handleViewportChange(): void {
    // Fast-path: nothing to track and nothing rendered
    if (!hoverElement && !selectionElement && !lastRects.hover && !lastRects.selection) {
      return;
    }
    scheduleUpdate();
  }

  // ==========================================================================
  // Event Registration
  // ==========================================================================

  // Listen for scroll on window (captures most scrolling scenarios)
  disposer.listen(window, 'scroll', handleViewportChange, PASSIVE_LISTENER);

  // Capture scroll events from scrollable containers (scroll doesn't bubble,
  // so we use capture phase to intercept scroll events from nested containers)
  disposer.listen(document, 'scroll', handleViewportChange, { ...PASSIVE_LISTENER, capture: true });

  // Listen for resize
  disposer.listen(window, 'resize', handleViewportChange, PASSIVE_LISTENER);

  // ==========================================================================
  // Public API
  // ==========================================================================

  function setHoverElement(element: Element | null): void {
    if (disposer.isDisposed) return;
    if (hoverElement === element) return;
    hoverElement = element;
    scheduleUpdate();
  }

  function setSelectionElement(element: Element | null): void {
    if (disposer.isDisposed) return;
    if (selectionElement === element) return;
    selectionElement = element;
    // Reset observers for new selection (or clear if null)
    resetSelectionObservers();
    scheduleUpdate();
  }

  function forceUpdate(): void {
    if (disposer.isDisposed) return;
    cancelRaf();
    updateIfChanged();
  }

  return {
    setHoverElement,
    setSelectionElement,
    forceUpdate,
    dispose: () => disposer.dispose(),
  };
}
