/**
 * Event Controller
 *
 * Capture-phase event interceptor for Web Editor V2.
 *
 * Responsibilities:
 * - Intercept document-level pointer/mouse/keyboard events in capture phase
 * - Allow editor UI events (Shadow DOM) to pass through unmodified
 * - Block page interactions while editor is active
 * - Provide hover/selecting mode state machine
 * - Trigger callbacks for element hover, selection, and deselection
 *
 * Performance considerations:
 * - Uses rAF throttling for hover updates (elementFromPoint is expensive)
 * - Supports both PointerEvents (modern) and MouseEvents (fallback)
 * - Events are blocked via stopImmediatePropagation for complete isolation
 */

import { WEB_EDITOR_V2_DRAG_THRESHOLD_PX } from '../constants';
import { Disposer } from '../utils/disposables';

// =============================================================================
// Types
// =============================================================================

/** Mode of the event controller state machine */
export type EventControllerMode = 'hover' | 'selecting' | 'editing' | 'dragging';

/** Keyboard modifiers state */
export interface EventModifiers {
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
}

/** Drag cancel reasons */
export type DragCancelReason =
  | 'escape'
  | 'pointercancel'
  | 'mode_change'
  | 'dispose'
  | 'blur'
  | 'visibilitychange';

/** Drag start event data */
export interface DragStartEvent {
  pointerId: number;
  draggedElement: Element;
  startClientX: number;
  startClientY: number;
  clientX: number;
  clientY: number;
  modifiers: EventModifiers;
}

/** Drag move event data */
export interface DragMoveEvent {
  pointerId: number;
  clientX: number;
  clientY: number;
}

/** Drag end event data */
export type DragEndEvent = DragMoveEvent;

/** Drag cancel event data */
export interface DragCancelEvent {
  reason: DragCancelReason;
}

/** Options for creating the event controller */
export interface EventControllerOptions {
  /** Check if a DOM node belongs to the editor overlay */
  isOverlayElement: (node: unknown) => boolean;
  /** Called when hovering over an element (null when hovering over nothing) */
  onHover: (element: Element | null) => void;
  /** Called when an element is selected via click */
  onSelect: (element: Element, modifiers: EventModifiers) => void;
  /** Called when selection is cancelled (ESC key or mode change) */
  onDeselect: () => void;
  /**
   * Called when user double-clicks an element to start editing.
   * Return true to enter `editing` mode, false to stay in current mode.
   */
  onStartEdit?: (element: Element, modifiers: EventModifiers) => boolean;
  /**
   * Optional custom target finder for selection (click).
   * If not provided, uses simple elementFromPoint.
   * Only used for selection, not hover (for performance).
   *
   * The event parameter enables Shadow DOM-aware selection via composedPath().
   */
  findTargetForSelect?: (
    x: number,
    y: number,
    modifiers: EventModifiers,
    event: PointerEvent | MouseEvent,
  ) => Element | null;
  /**
   * Get the currently selected element (used to gate drag start in selecting mode).
   */
  getSelectedElement?: () => Element | null;
  /**
   * Called when drag starts (after movement threshold is exceeded).
   * Return true to enter `dragging` mode.
   */
  onStartDrag?: (event: DragStartEvent) => boolean;
  /** Called for pointer moves while dragging */
  onDragMove?: (event: DragMoveEvent) => void;
  /** Called when drag ends (pointerup) */
  onDragEnd?: (event: DragEndEvent) => void;
  /** Called when drag is cancelled (ESC/pointercancel/dispose) */
  onDragCancel?: (event: DragCancelEvent) => void;
}

/** Event controller public interface */
export interface EventController {
  /** Get current interaction mode */
  getMode(): EventControllerMode;
  /** Set interaction mode programmatically */
  setMode(mode: EventControllerMode): void;
  /** Cleanup all event listeners */
  dispose(): void;
}

// =============================================================================
// Constants
// =============================================================================

/** Common capture-phase listener options */
const CAPTURE_OPTIONS: AddEventListenerOptions = {
  capture: true,
  passive: false,
};

/** Events to completely block on document (page interaction prevention) */
const BLOCKED_POINTER_EVENTS = [
  'pointerup',
  'pointercancel',
  'pointerover',
  'pointerout',
  'pointerenter',
  'pointerleave',
] as const;

const BLOCKED_MOUSE_EVENTS = [
  'mouseup',
  'click',
  'dblclick',
  'contextmenu',
  'auxclick',
  'mouseover',
  'mouseout',
  'mouseenter',
  'mouseleave',
] as const;

const BLOCKED_KEYBOARD_EVENTS = ['keyup', 'keypress'] as const;

const BLOCKED_TOUCH_EVENTS = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const;

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create an event controller for managing editor interactions.
 *
 * The controller operates in four modes:
 * - `hover`: Mouse movement triggers onHover callbacks, click transitions to selecting
 * - `selecting`: An element is selected, ESC key returns to hover mode
 * - `editing`: Text editing mode for the selected element (Phase 2.7)
 * - `dragging`: Drag reorder mode for the selected element (Phase 2.4-2.6)
 */
export function createEventController(options: EventControllerOptions): EventController {
  const {
    isOverlayElement,
    onHover,
    onSelect,
    onDeselect,
    onStartEdit,
    findTargetForSelect,
    getSelectedElement,
    onStartDrag,
    onDragMove,
    onDragEnd,
    onDragCancel,
  } = options;
  const disposer = new Disposer();

  // Feature detection for PointerEvents
  const hasPointerEvents = typeof PointerEvent !== 'undefined';

  // ==========================================================================
  // State
  // ==========================================================================

  let mode: EventControllerMode = 'hover';
  let lastHoveredElement: Element | null = null;
  /** Element currently being edited (Phase 2.7) */
  let editingElement: Element | null = null;

  // ==========================================================================
  // Drag State (Phase 2.4-2.6)
  // ==========================================================================

  interface DragCandidate {
    pointerId: number;
    startClientX: number;
    startClientY: number;
    modifiers: EventModifiers;
    selectedElement: Element;
    /** True if this candidate was created by a PointerEvent (not a fallback MouseEvent) */
    isPointerEventOrigin: boolean;
  }

  let dragCandidate: DragCandidate | null = null;
  let draggingPointerId: number | null = null;
  /** True if the current dragging session was initiated by PointerEvent */
  let draggingIsPointerOrigin = false;
  /** Flag to suppress mode_change cancel when we're intentionally leaving dragging */
  let suppressModeChangeDragCancel = false;

  // Pointer position tracking for rAF-throttled hover updates
  let hasPointerPosition = false;
  let lastClientX = 0;
  let lastClientY = 0;

  // Single rAF management (avoids Disposer array growth)
  let hoverRafId: number | null = null;

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Check if an event originated from the editor UI (Shadow DOM safe)
   */
  function isEventFromEditorUi(event: Event): boolean {
    try {
      if (typeof event.composedPath === 'function') {
        return event.composedPath().some((node) => isOverlayElement(node));
      }
    } catch {
      // Fallback to target check
    }
    return isOverlayElement(event.target);
  }

  /**
   * Check if an event originated from the current editing element (Shadow DOM safe).
   * Used to allow native interactions (typing, selection) inside the editing element.
   */
  function isEventFromEditingElement(event: Event): boolean {
    const el = editingElement;
    if (!el) return false;

    try {
      if (typeof event.composedPath === 'function') {
        return event.composedPath().some((node) => node === el);
      }
    } catch {
      // Fallback to target check
    }

    const target = event.target;
    return target instanceof Node && el.contains(target);
  }

  /**
   * Block an event from reaching the page
   */
  function blockPageEvent(event: Event): void {
    if (event.cancelable) {
      event.preventDefault();
    }
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  /** Default modifiers (all false) */
  const defaultModifiers: EventModifiers = {
    alt: false,
    shift: false,
    ctrl: false,
    meta: false,
  };

  /**
   * Extract modifiers from an event
   */
  function extractModifiers(event: MouseEvent | KeyboardEvent): EventModifiers {
    return {
      alt: event.altKey,
      shift: event.shiftKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
    };
  }

  /**
   * Get pointer ID from event (PointerEvent has pointerId, MouseEvent uses 0)
   */
  function getEventPointerId(event: PointerEvent | MouseEvent): number {
    return event instanceof PointerEvent ? event.pointerId : 0;
  }

  /**
   * Check if we should process this event as the primary pointer.
   * On browsers with PointerEvents, mouse events fire after pointer events;
   * we use mouse listeners only for blocking, not for interaction logic.
   */
  function shouldProcessAsPrimaryPointer(event: PointerEvent | MouseEvent): boolean {
    if (hasPointerEvents && !(event instanceof PointerEvent)) return false;
    return true;
  }

  /**
   * Check if an event originated from within a specific element (Shadow DOM safe)
   */
  function isEventWithinElement(event: Event, element: Element): boolean {
    try {
      if (typeof event.composedPath === 'function') {
        return event.composedPath().some((node) => node === element);
      }
    } catch {
      // Fallback
    }

    const target = event.target;
    return target instanceof Node && element.contains(target);
  }

  /**
   * Clear all drag-related state
   */
  function clearDragState(): void {
    dragCandidate = null;
    draggingPointerId = null;
    draggingIsPointerOrigin = false;
  }

  /**
   * Cancel the current dragging session
   */
  function cancelDragging(reason: DragCancelReason): void {
    if (mode !== 'dragging') return;

    clearDragState();

    try {
      onDragCancel?.({ reason });
    } catch {
      // Best-effort
    }

    suppressModeChangeDragCancel = true;
    setMode('selecting');
  }

  /**
   * End the current dragging session (successful drop)
   */
  function endDragging(pointerId: number, clientX: number, clientY: number): void {
    if (mode !== 'dragging') return;
    if (draggingPointerId === null || draggingPointerId !== pointerId) return;

    clearDragState();

    try {
      onDragEnd?.({ pointerId, clientX, clientY });
    } catch {
      // Best-effort
    }

    suppressModeChangeDragCancel = true;
    setMode('selecting');
  }

  /**
   * Get the topmost element at a viewport coordinate (fast, for hover).
   * Uses simple elementFromPoint to maintain 60FPS hover performance.
   */
  function getTargetElementAtFast(clientX: number, clientY: number): Element | null {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      return null;
    }

    const element = document.elementFromPoint(clientX, clientY);
    if (!element) return null;

    // Skip if element is part of the editor overlay
    if (isOverlayElement(element)) return null;

    return element;
  }

  /**
   * Get the best target element for selection (can be slower, uses intelligent picking).
   * Uses custom findTargetForSelect if provided, otherwise falls back to fast method.
   *
   * The event parameter is passed to enable Shadow DOM-aware selection via composedPath().
   */
  function getTargetElementForSelection(
    event: PointerEvent | MouseEvent,
    clientX: number,
    clientY: number,
    modifiers: EventModifiers,
  ): Element | null {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      return null;
    }

    // Use intelligent target finder if provided (e.g., SelectionEngine)
    if (findTargetForSelect) {
      const target = findTargetForSelect(clientX, clientY, modifiers, event);
      // Defensive check: ensure result is not an overlay element
      if (target && isOverlayElement(target)) return null;
      return target;
    }

    // Fallback: simple elementFromPoint
    return getTargetElementAtFast(clientX, clientY);
  }

  // ==========================================================================
  // Hover Logic (rAF throttled)
  // ==========================================================================

  /**
   * Cancel any pending hover rAF
   */
  function cancelHoverRaf(): void {
    if (hoverRafId !== null) {
      cancelAnimationFrame(hoverRafId);
      hoverRafId = null;
    }
  }
  // Register cleanup for disposal
  disposer.add(cancelHoverRaf);

  /**
   * Commit the hover update by finding element at current pointer position
   * Allowed in both 'hover' and 'selecting' modes to show hover highlight while element is selected
   */
  function commitHoverUpdate(forceUpdate = false): void {
    hoverRafId = null;

    if (disposer.isDisposed) return;
    // Allow hover updates in both hover and selecting modes
    if (mode !== 'hover' && mode !== 'selecting') return;
    if (!hasPointerPosition) return;

    // Use fast method for hover (60FPS performance)
    const nextElement = getTargetElementAtFast(lastClientX, lastClientY);

    // Skip if same element (pointer identity check), unless forced
    if (!forceUpdate && nextElement === lastHoveredElement) return;

    lastHoveredElement = nextElement;
    onHover(nextElement);
  }

  /**
   * Schedule a hover update on the next animation frame
   */
  function scheduleHoverUpdate(forceUpdate = false): void {
    // If already pending, don't schedule another
    if (hoverRafId !== null) return;
    if (disposer.isDisposed) return;

    // Use rAF to throttle elementFromPoint calls to once per frame
    // This prevents performance degradation from high-frequency pointer events
    hoverRafId = requestAnimationFrame(() => {
      commitHoverUpdate(forceUpdate);
    });
  }

  // ==========================================================================
  // Mode Management
  // ==========================================================================

  /**
   * Set the interaction mode.
   *
   * State cleanup invariants:
   * - Leaving `editing`: clear editingElement
   * - Leaving `selecting`: clear dragCandidate
   * - Leaving `dragging`: clear all drag state (candidate + pointer + origin flag)
   * - Entering `hover`: trigger onDeselect and resume hover tracking
   */
  function setMode(nextMode: EventControllerMode): void {
    if (disposer.isDisposed) return;
    if (mode === nextMode) return;

    const prevMode = mode;
    mode = nextMode;

    // Leaving editing mode always clears the tracked editing element
    if (prevMode === 'editing' && nextMode !== 'editing') {
      editingElement = null;
    }

    // Leaving selecting mode: clear drag candidate (but not full drag state)
    if (prevMode === 'selecting' && nextMode !== 'selecting') {
      dragCandidate = null;
    }

    // Leaving dragging mode: notify and reset all drag state
    if (prevMode === 'dragging' && nextMode !== 'dragging') {
      const shouldNotify = !suppressModeChangeDragCancel;
      suppressModeChangeDragCancel = false;
      clearDragState(); // Clears dragCandidate, draggingPointerId, draggingIsPointerOrigin
      if (shouldNotify) {
        try {
          onDragCancel?.({ reason: 'mode_change' });
        } catch {
          // Best-effort
        }
      }
    } else {
      suppressModeChangeDragCancel = false;
    }

    // Entering an interaction mode (selecting/editing/dragging) from hover
    if (prevMode === 'hover' && nextMode !== 'hover') {
      cancelHoverRaf();
      lastHoveredElement = null;
    }

    // Exiting interaction mode back to hover - notify and force resume hover tracking
    if (nextMode === 'hover' && prevMode !== 'hover') {
      // Reset lastHoveredElement to force onHover callback even if pointer is on same element
      lastHoveredElement = null;
      // Also ensure drag state is clean when returning to hover
      clearDragState();
      onDeselect();
      if (hasPointerPosition) {
        // Force update to re-highlight element under pointer
        scheduleHoverUpdate(true);
      }
    }
  }

  // ==========================================================================
  // Event Handlers
  // ==========================================================================

  /**
   * Handle pointer/mouse move for hover tracking
   */
  function handlePointerMove(event: PointerEvent | MouseEvent): void {
    // Allow native interactions inside the editing element
    if (mode === 'editing' && isEventFromEditingElement(event)) {
      return;
    }
    // If event is from editor UI, clear hover highlight and return
    if (isEventFromEditorUi(event)) {
      if (mode === 'hover' && lastHoveredElement !== null) {
        lastHoveredElement = null;
        onHover(null);
      }
      return;
    }
    blockPageEvent(event);

    // Update tracked position
    lastClientX = event.clientX;
    lastClientY = event.clientY;
    hasPointerPosition = true;

    // Dragging: forward pointer moves (only from matching event type)
    if (mode === 'dragging' && shouldProcessAsPrimaryPointer(event)) {
      const pointerId = getEventPointerId(event);
      const isPointerEvent = event instanceof PointerEvent;

      // Ensure event type matches the origin (prevent Pointer/Mouse conflict)
      if (draggingIsPointerOrigin !== isPointerEvent) return;

      if (draggingPointerId !== null && pointerId === draggingPointerId) {
        onDragMove?.({ pointerId, clientX: event.clientX, clientY: event.clientY });
      }
      return;
    }

    // Drag candidate: enter dragging when threshold is exceeded
    if (mode === 'selecting' && dragCandidate && shouldProcessAsPrimaryPointer(event)) {
      const pointerId = getEventPointerId(event);
      if (pointerId !== dragCandidate.pointerId) return;

      // Ensure event type matches the origin (prevent Pointer/Mouse conflict)
      const isPointerEvent = event instanceof PointerEvent;
      if (dragCandidate.isPointerEventOrigin !== isPointerEvent) return;

      const dx = event.clientX - dragCandidate.startClientX;
      const dy = event.clientY - dragCandidate.startClientY;
      if (Math.hypot(dx, dy) < WEB_EDITOR_V2_DRAG_THRESHOLD_PX) return;

      const startEvent: DragStartEvent = {
        pointerId,
        draggedElement: dragCandidate.selectedElement,
        startClientX: dragCandidate.startClientX,
        startClientY: dragCandidate.startClientY,
        clientX: event.clientX,
        clientY: event.clientY,
        modifiers: dragCandidate.modifiers,
      };

      const wasPointerOrigin = dragCandidate.isPointerEventOrigin;
      dragCandidate = null;

      const started = onStartDrag?.(startEvent) ?? false;
      if (!started) return;

      draggingPointerId = pointerId;
      draggingIsPointerOrigin = wasPointerOrigin;
      setMode('dragging');
      onDragMove?.({ pointerId, clientX: event.clientX, clientY: event.clientY });
      return;
    }

    // Process hover in both hover and selecting modes
    // This allows showing hover highlight on other elements while one is selected
    if (mode !== 'hover' && mode !== 'selecting') return;
    scheduleHoverUpdate();
  }

  /**
   * Handle pointer/mouse down for element selection
   */
  function handlePointerDown(event: PointerEvent | MouseEvent): void {
    // Allow native interactions inside the editing element
    if (mode === 'editing' && isEventFromEditingElement(event)) return;
    if (isEventFromEditorUi(event)) return;
    blockPageEvent(event);

    // Update tracked position
    lastClientX = event.clientX;
    lastClientY = event.clientY;
    hasPointerPosition = true;

    // Left-click only
    if (event.button !== 0) return;

    // Extract modifiers for intelligent selection
    const modifiers = extractModifiers(event);

    // In selecting mode: handle click for reselection or drag preparation
    if (mode === 'selecting') {
      if (!shouldProcessAsPrimaryPointer(event)) return;

      const selected = getSelectedElement?.() ?? null;

      // Always try to find the best target element first (enables child selection & drill-in/up)
      const target = getTargetElementForSelection(event, event.clientX, event.clientY, modifiers);

      // If target is different from current selection, reselect (including child elements)
      if (target && target !== selected) {
        dragCandidate = null;
        onSelect(target, modifiers);
        return;
      }

      // Target is the same as current selection (or no valid target):
      // prepare drag candidate if clicking within selection subtree
      if (
        onStartDrag &&
        selected &&
        selected.isConnected &&
        isEventWithinElement(event, selected)
      ) {
        const isPointerOrigin = event instanceof PointerEvent;

        dragCandidate = {
          pointerId: getEventPointerId(event),
          startClientX: event.clientX,
          startClientY: event.clientY,
          modifiers,
          selectedElement: selected,
          isPointerEventOrigin: isPointerOrigin,
        };
      }
      return;
    }

    // Ignore additional pointerdowns while dragging
    if (mode === 'dragging') {
      return;
    }

    // While editing: clicking outside commits and transitions to selecting
    if (mode === 'editing') {
      const target = getTargetElementForSelection(event, event.clientX, event.clientY, modifiers);
      setMode('selecting');
      if (target) {
        onSelect(target, modifiers);
      }
      return;
    }

    // Only process in hover mode
    if (mode !== 'hover') return;

    // Use intelligent selection for click (can afford more computation)
    // Pass event to enable Shadow DOM-aware selection via composedPath()
    const target = getTargetElementForSelection(event, event.clientX, event.clientY, modifiers);
    if (!target) return;

    // Transition to selecting mode
    setMode('selecting');
    onSelect(target, modifiers);
  }

  /**
   * Handle double-click for entering edit mode (Phase 2.7)
   */
  function handleDoubleClick(event: MouseEvent): void {
    // Allow native text selection inside the editing element
    if (mode === 'editing' && isEventFromEditingElement(event)) {
      return;
    }
    if (isEventFromEditorUi(event)) return;
    blockPageEvent(event);

    if (event.button !== 0) return;
    if (!onStartEdit) return;

    const modifiers = extractModifiers(event);
    const target = getTargetElementForSelection(event, event.clientX, event.clientY, modifiers);
    if (!target) return;

    const started = onStartEdit(target, modifiers);
    if (!started) return;

    editingElement = target;
    setMode('editing');
  }

  /**
   * Handle keydown for ESC cancellation
   */
  function handleKeyDown(event: KeyboardEvent): void {
    // Allow native typing inside the editing element (editor handles Escape via blur)
    if (mode === 'editing' && isEventFromEditingElement(event)) {
      return;
    }
    if (isEventFromEditorUi(event)) return;
    blockPageEvent(event);

    if (event.key === 'Escape') {
      // ESC cancels dragging first (but keeps selection)
      if (mode === 'dragging') {
        cancelDragging('escape');
        return;
      }

      // ESC key cancels selection
      if (mode === 'selecting') {
        dragCandidate = null;
        setMode('hover');
      }
    }
  }

  /**
   * Handle pointerup/mouseup for ending drag
   */
  function handlePointerUp(event: PointerEvent | MouseEvent): void {
    // Allow native interactions inside the editing element
    if (mode === 'editing' && isEventFromEditingElement(event)) return;
    if (isEventFromEditorUi(event)) return;
    blockPageEvent(event);

    if (!shouldProcessAsPrimaryPointer(event)) {
      return;
    }

    const pointerId = getEventPointerId(event);
    const isPointerEvent = event instanceof PointerEvent;

    // Clear candidate on pointerup (only if event type matches)
    if (
      mode === 'selecting' &&
      dragCandidate &&
      dragCandidate.pointerId === pointerId &&
      dragCandidate.isPointerEventOrigin === isPointerEvent
    ) {
      dragCandidate = null;
    }

    // End dragging on pointerup (only if event type matches)
    if (mode === 'dragging' && draggingIsPointerOrigin === isPointerEvent) {
      endDragging(pointerId, event.clientX, event.clientY);
    }
  }

  /**
   * Handle pointercancel for cancelling drag.
   * Note: pointercancel is a PointerEvent-only event, so we only process
   * drag state that was initiated by PointerEvents.
   */
  function handlePointerCancel(event: PointerEvent): void {
    // Allow native interactions inside the editing element
    if (mode === 'editing' && isEventFromEditingElement(event)) return;
    if (isEventFromEditorUi(event)) return;
    blockPageEvent(event);

    const pointerId = event.pointerId;

    // Clear candidate on cancel (only if it was created by PointerEvent)
    if (
      dragCandidate &&
      dragCandidate.pointerId === pointerId &&
      dragCandidate.isPointerEventOrigin
    ) {
      dragCandidate = null;
    }

    if (mode !== 'dragging') return;
    // Only cancel if the dragging was initiated by PointerEvent
    if (!draggingIsPointerOrigin) return;
    if (draggingPointerId === null || draggingPointerId !== pointerId) return;

    cancelDragging('pointercancel');
  }

  /**
   * Generic blocker for events that should never reach the page
   */
  function handleBlockedEvent(event: Event): void {
    if (isEventFromEditorUi(event)) return;
    // Allow native interactions inside the editing element
    if (mode === 'editing' && isEventFromEditingElement(event)) return;

    // Route dblclick to the handler instead of just blocking
    if (event.type === 'dblclick') {
      handleDoubleClick(event as MouseEvent);
      return;
    }

    // Route pointerup/mouseup to end drag candidate / dragging session
    if (event.type === 'pointerup' || event.type === 'mouseup') {
      handlePointerUp(event as PointerEvent | MouseEvent);
      return;
    }

    // Route pointercancel to cancel dragging session
    if (event.type === 'pointercancel') {
      handlePointerCancel(event as PointerEvent);
      return;
    }

    blockPageEvent(event);
  }

  // ==========================================================================
  // Event Registration
  // ==========================================================================

  // Register pointer events (modern browsers)
  if (hasPointerEvents) {
    disposer.listen(document, 'pointermove', handlePointerMove, CAPTURE_OPTIONS);
    disposer.listen(document, 'pointerdown', handlePointerDown, CAPTURE_OPTIONS);

    for (const eventType of BLOCKED_POINTER_EVENTS) {
      disposer.listen(document, eventType, handleBlockedEvent, CAPTURE_OPTIONS);
    }
  }

  // Register mouse events (fallback for older browsers, or when pointer events are unavailable)
  // Note: On modern browsers with PointerEvents, mouse events still fire after pointer events,
  // so we always register them to ensure complete blocking
  disposer.listen(document, 'mousemove', handlePointerMove, CAPTURE_OPTIONS);
  disposer.listen(document, 'mousedown', handlePointerDown, CAPTURE_OPTIONS);

  for (const eventType of BLOCKED_MOUSE_EVENTS) {
    disposer.listen(document, eventType, handleBlockedEvent, CAPTURE_OPTIONS);
  }

  // Register keyboard events
  disposer.listen(document, 'keydown', handleKeyDown, CAPTURE_OPTIONS);

  for (const eventType of BLOCKED_KEYBOARD_EVENTS) {
    disposer.listen(document, eventType, handleBlockedEvent, CAPTURE_OPTIONS);
  }

  // Register touch events (prevent touch interactions on mobile)
  for (const eventType of BLOCKED_TOUCH_EVENTS) {
    disposer.listen(document, eventType, handleBlockedEvent, CAPTURE_OPTIONS);
  }

  // ==========================================================================
  // Window/Page Focus Events (cancel dragging on blur/visibility change)
  // ==========================================================================

  /**
   * Cancel dragging when window loses focus.
   * This prevents the UI from getting stuck with pointer-events: none
   * if the user switches to another application mid-drag.
   */
  function handleWindowBlur(): void {
    // Clear drag candidate in selecting mode
    if (mode === 'selecting' && dragCandidate) {
      dragCandidate = null;
    }
    // Cancel active dragging
    if (mode === 'dragging') {
      cancelDragging('blur');
    }
  }

  /**
   * Cancel dragging when page becomes hidden.
   * This handles cases like switching browser tabs.
   */
  function handleVisibilityChange(): void {
    if (document.visibilityState !== 'visible') {
      // Clear drag candidate in selecting mode
      if (mode === 'selecting' && dragCandidate) {
        dragCandidate = null;
      }
      // Cancel active dragging
      if (mode === 'dragging') {
        cancelDragging('visibilitychange');
      }
    }
  }

  disposer.listen(window, 'blur', handleWindowBlur);
  disposer.listen(document, 'visibilitychange', handleVisibilityChange);

  // ==========================================================================
  // Public API
  // ==========================================================================

  // Cleanup drag state on dispose
  disposer.add(() => {
    if (mode === 'dragging') {
      try {
        onDragCancel?.({ reason: 'dispose' });
      } catch {
        // Best-effort
      }
    }
    clearDragState();
  });

  return {
    getMode: () => mode,
    setMode,
    dispose: () => disposer.dispose(),
  };
}
