/**
 * Web Editor V2 Core
 *
 * Main orchestrator for the visual editor.
 * Manages lifecycle of all subsystems (Shadow Host, Canvas, Interaction Engine, etc.)
 */

import type {
  WebEditorApplyBatchPayload,
  WebEditorElementKey,
  WebEditorRevertElementResponse,
  WebEditorSelectionChangedPayload,
  SelectedElementSummary,
  WebEditorState,
  WebEditorTxChangedPayload,
  WebEditorTxChangeAction,
  WebEditorV2Api,
} from '@/common/web-editor-types';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { WEB_EDITOR_V2_VERSION, WEB_EDITOR_V2_LOG_PREFIX } from '../constants';
import { mountShadowHost, type ShadowHostManager } from '../ui/shadow-host';
import { createToolbar, type Toolbar } from '../ui/toolbar';
import { createBreadcrumbs, type Breadcrumbs } from '../ui/breadcrumbs';
import { createPropertyPanel, type PropertyPanel } from '../ui/property-panel';
import { createPropsBridge, type PropsBridge } from './props-bridge';
import { createCanvasOverlay, type CanvasOverlay } from '../overlay/canvas-overlay';
import { createHandlesController, type HandlesController } from '../overlay/handles-controller';
import {
  createDragReorderController,
  type DragReorderController,
} from '../drag/drag-reorder-controller';
import {
  createEventController,
  type EventController,
  type EventModifiers,
} from './event-controller';
import { createPositionTracker, type PositionTracker, type TrackedRects } from './position-tracker';
import { createSelectionEngine, type SelectionEngine } from '../selection/selection-engine';
import {
  createTransactionManager,
  type TransactionManager,
  type TransactionChangeEvent,
} from './transaction-manager';
import { locateElement, createElementLocator } from './locator';
import { sendTransactionToAgent } from './payload-builder';
import { aggregateTransactionsByElement } from './transaction-aggregator';
import {
  generateStableElementKey,
  generateElementLabel,
  generateFullElementLabel,
} from './element-key';
import {
  createExecutionTracker,
  type ExecutionTracker,
  type ExecutionState,
} from './execution-tracker';
import { createHmrConsistencyVerifier, type HmrConsistencyVerifier } from './hmr-consistency';
import { createPerfMonitor, type PerfMonitor } from './perf-monitor';
import { createDesignTokensService, type DesignTokensService } from './design-tokens';

// =============================================================================
// Types
// =============================================================================

/** Apply operation snapshot for rollback tracking */
interface ApplySnapshot {
  txId: string;
  txTimestamp: number;
}

/** Internal editor state */
interface EditorInternalState {
  active: boolean;
  shadowHost: ShadowHostManager | null;
  canvasOverlay: CanvasOverlay | null;
  handlesController: HandlesController | null;
  eventController: EventController | null;
  positionTracker: PositionTracker | null;
  selectionEngine: SelectionEngine | null;
  dragReorderController: DragReorderController | null;
  transactionManager: TransactionManager | null;
  executionTracker: ExecutionTracker | null;
  hmrConsistencyVerifier: HmrConsistencyVerifier | null;
  toolbar: Toolbar | null;
  breadcrumbs: Breadcrumbs | null;
  propertyPanel: PropertyPanel | null;
  /** Runtime props bridge (Phase 7) */
  propsBridge: PropsBridge | null;
  /** Design tokens service (Phase 5.3) */
  tokensService: DesignTokensService | null;
  /** Performance monitor (Phase 5.3) - disabled by default */
  perfMonitor: PerfMonitor | null;
  /** Cleanup function for perf monitor hotkey */
  perfHotkeyCleanup: (() => void) | null;
  /** Currently hovered element (for hover highlight) */
  hoveredElement: Element | null;
  /** One-shot flag: whether next hover rect update should animate */
  pendingHoverTransition: boolean;
  /** Currently selected element (for selection highlight) */
  selectedElement: Element | null;
  /** Snapshot of transaction being applied (for rollback on failure) */
  applyingSnapshot: ApplySnapshot | null;
  /** Floating toolbar position (viewport coordinates), null when docked */
  toolbarPosition: { left: number; top: number } | null;
  /** Floating property panel position (viewport coordinates), null when anchored */
  propertyPanelPosition: { left: number; top: number } | null;
  /** Cleanup for window resize clamping (floating UI) */
  uiResizeCleanup: (() => void) | null;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create the Web Editor V2 instance.
 *
 * This is the main factory function that creates the editor API.
 * The returned object implements WebEditorV2Api and is exposed on window.__MCP_WEB_EDITOR_V2__
 */
export function createWebEditorV2(): WebEditorV2Api {
  const state: EditorInternalState = {
    active: false,
    shadowHost: null,
    canvasOverlay: null,
    handlesController: null,
    eventController: null,
    positionTracker: null,
    selectionEngine: null,
    dragReorderController: null,
    transactionManager: null,
    executionTracker: null,
    hmrConsistencyVerifier: null,
    toolbar: null,
    breadcrumbs: null,
    propertyPanel: null,
    propsBridge: null,
    tokensService: null,
    perfMonitor: null,
    perfHotkeyCleanup: null,
    hoveredElement: null,
    pendingHoverTransition: false,
    selectedElement: null,
    applyingSnapshot: null,
    toolbarPosition: null,
    propertyPanelPosition: null,
    uiResizeCleanup: null,
  };

  /** Default modifiers for programmatic selection (e.g., from breadcrumbs) */
  const DEFAULT_MODIFIERS: EventModifiers = {
    alt: false,
    shift: false,
    ctrl: false,
    meta: false,
  };

  // ===========================================================================
  // Text Editing Session (Phase 2.7)
  // ===========================================================================

  interface EditSession {
    element: HTMLElement;
    beforeText: string;
    beforeContentEditable: string | null;
    beforeSpellcheck: boolean;
    keydownHandler: (ev: KeyboardEvent) => void;
    blurHandler: () => void;
  }

  let editSession: EditSession | null = null;

  /** Check if element is a valid text edit target */
  function isTextEditTarget(element: Element): element is HTMLElement {
    if (!(element instanceof HTMLElement)) return false;
    // Not for form controls
    if (element instanceof HTMLInputElement) return false;
    if (element instanceof HTMLTextAreaElement) return false;
    // Only for text-only targets (no element children)
    if (element.childElementCount > 0) return false;
    return true;
  }

  /** Restore element to pre-edit state */
  function restoreEditTarget(session: EditSession): void {
    const { element, beforeContentEditable, beforeSpellcheck } = session;

    if (beforeContentEditable === null) {
      element.removeAttribute('contenteditable');
    } else {
      element.setAttribute('contenteditable', beforeContentEditable);
    }

    element.spellcheck = beforeSpellcheck;

    // Remove event listeners
    element.removeEventListener('keydown', session.keydownHandler, true);
    element.removeEventListener('blur', session.blurHandler, true);
  }

  /** Commit the current edit session */
  function commitEdit(): void {
    const session = editSession;
    if (!session) return;

    editSession = null;

    const element = session.element;
    const afterText = element.textContent ?? '';

    // Normalize to text-only to avoid structure drift from contentEditable
    element.textContent = afterText;

    restoreEditTarget(session);

    // Record transaction if text changed
    if (session.beforeText !== afterText) {
      state.transactionManager?.recordText(element, session.beforeText, afterText);
    }

    console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Text edit committed`);
  }

  /** Cancel the current edit session */
  function cancelEdit(): void {
    const session = editSession;
    if (!session) return;

    editSession = null;

    // Restore original text
    session.element.textContent = session.beforeText;

    restoreEditTarget(session);
    console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Text edit cancelled`);
  }

  /** Start editing an element */
  function startEdit(element: Element, modifiers: EventModifiers): boolean {
    if (!isTextEditTarget(element)) return false;
    if (!element.isConnected) return false;

    // Ensure element is selected
    if (state.selectedElement !== element) {
      handleSelect(element, modifiers);
    }

    // If already editing this element, keep editing
    if (editSession?.element === element) return true;

    // Commit previous edit if any
    if (editSession) {
      commitEdit();
    }

    const beforeText = element.textContent ?? '';
    const beforeContentEditable = element.getAttribute('contenteditable');
    const beforeSpellcheck = element.spellcheck;

    // ESC cancels editing
    const keydownHandler = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      cancelEdit();
      state.eventController?.setMode('selecting');
    };

    // Blur commits editing
    const blurHandler = () => {
      commitEdit();
      state.eventController?.setMode('selecting');
    };

    element.addEventListener('keydown', keydownHandler, true);
    element.addEventListener('blur', blurHandler, true);

    element.setAttribute('contenteditable', 'true');
    element.spellcheck = false;

    try {
      element.focus({ preventScroll: true });
    } catch {
      try {
        element.focus();
      } catch {
        // Best-effort only
      }
    }

    editSession = {
      element,
      beforeText,
      beforeContentEditable,
      beforeSpellcheck,
      keydownHandler,
      blurHandler,
    };

    console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Text edit started`);
    return true;
  }

  // ===========================================================================
  // Event Handlers (wired to EventController callbacks)
  // ===========================================================================

  /**
   * Handle hover state changes from EventController
   */
  function handleHover(element: Element | null): void {
    const prevElement = state.hoveredElement;
    state.hoveredElement = element;

    // Determine if we should animate the hover rect transition
    // Only animate when switching between two valid elements (not null)
    const shouldAnimate = prevElement !== null && element !== null && prevElement !== element;
    state.pendingHoverTransition = shouldAnimate;

    // Delegate position tracking to PositionTracker
    // Use forceUpdate to avoid extra rAF frame delay
    if (state.positionTracker) {
      state.positionTracker.setHoverElement(element);
      state.positionTracker.forceUpdate();
    }
  }

  /**
   * Handle element selection from EventController
   */
  function handleSelect(element: Element, modifiers: EventModifiers): void {
    // Commit any in-progress edit when selecting a different element
    if (editSession && editSession.element !== element) {
      commitEdit();
    }

    state.selectedElement = element;
    state.hoveredElement = null;

    // Delegate position tracking to PositionTracker
    // Clear hover, set selection, then force immediate update
    if (state.positionTracker) {
      state.positionTracker.setHoverElement(null);
      state.positionTracker.setSelectionElement(element);
      state.positionTracker.forceUpdate();
    }

    // Update breadcrumbs to show element ancestry
    state.breadcrumbs?.setTarget(element);

    // Update property panel with selected element
    state.propertyPanel?.setTarget(element);

    // Update resize handles target (Phase 4.9)
    state.handlesController?.setTarget(element);

    // Notify HMR consistency verifier of selection change (Phase 4.8)
    state.hmrConsistencyVerifier?.onSelectionChange(element);

    // Broadcast selection to sidepanel for AgentChat context
    broadcastSelectionChanged(element);

    // Log selection with modifier info for debugging
    const modInfo = modifiers.alt ? ' (Alt: drill-up)' : '';
    console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Selected${modInfo}:`, element.tagName, element);
  }

  /**
   * Handle deselection (ESC key) from EventController
   */
  function handleDeselect(): void {
    state.selectedElement = null;

    // Clear selection tracking and force immediate update
    if (state.positionTracker) {
      state.positionTracker.setSelectionElement(null);
      state.positionTracker.forceUpdate();
    }

    // Clear breadcrumbs
    state.breadcrumbs?.setTarget(null);

    // Clear property panel
    state.propertyPanel?.setTarget(null);

    // Hide resize handles (Phase 4.9)
    state.handlesController?.setTarget(null);

    // Notify HMR consistency verifier of deselection (Phase 4.8)
    // Deselection should cancel any ongoing verification
    state.hmrConsistencyVerifier?.onSelectionChange(null);

    // Broadcast deselection to sidepanel
    broadcastSelectionChanged(null);

    console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Deselected`);
  }

  /**
   * Handle position updates from PositionTracker (scroll/resize sync)
   */
  function handlePositionUpdate(rects: TrackedRects): void {
    // Anchor breadcrumbs to the selection rect (viewport coordinates)
    state.breadcrumbs?.setAnchorRect(rects.selection);

    // Consume one-shot animation flag (must read before clearing)
    // This flag is only set when hover element changes, not for scroll/resize
    const animateHover = state.pendingHoverTransition;
    state.pendingHoverTransition = false;

    if (!state.canvasOverlay) return;

    // Update canvas overlay with new positions
    state.canvasOverlay.setHoverRect(rects.hover, { animate: animateHover });
    state.canvasOverlay.setSelectionRect(rects.selection);

    // Sync resize handles with latest selection rect (Phase 4.9)
    state.handlesController?.setSelectionRect(rects.selection);

    // Force immediate render to avoid extra rAF delay
    // This collapses the render to the same frame as position calculation
    state.canvasOverlay.render();
  }

  // ===========================================================================
  // AgentChat Integration (Phase 1.4)
  // ===========================================================================

  const WEB_EDITOR_TX_CHANGED_SESSION_KEY_PREFIX = 'web-editor-v2-tx-changed-' as const;
  const TX_CHANGED_BROADCAST_DEBOUNCE_MS = 100;

  let txChangedBroadcastTimer: number | null = null;
  let pendingTxAction: WebEditorTxChangeAction = 'push';

  /**
   * Broadcast aggregated transaction state to extension UI (e.g., Sidepanel).
   *
   * This runs on a short debounce because TransactionManager can emit frequent
   * merge events during continuous interactions (e.g., dragging sliders).
   *
   * NOTE: tabId is set to 0 here; background script will fill in the actual
   * tabId from sender.tab.id and update storage with per-tab keys.
   */
  function broadcastTxChanged(action: WebEditorTxChangeAction): void {
    // Track the action for when debounce fires
    pendingTxAction = action;

    // For 'clear' action, broadcast immediately without debounce
    // This ensures UI updates instantly when user applies changes
    const shouldBroadcastImmediately = action === 'clear';

    if (txChangedBroadcastTimer !== null) {
      window.clearTimeout(txChangedBroadcastTimer);
      txChangedBroadcastTimer = null;
    }

    const doBroadcast = (): void => {
      const tm = state.transactionManager;
      if (!tm) return;

      const undoStack = tm.getUndoStack();
      const redoStack = tm.getRedoStack();
      const elements = aggregateTransactionsByElement(undoStack);

      const payload: WebEditorTxChangedPayload = {
        tabId: 0, // Will be filled by background script from sender.tab.id
        action: pendingTxAction,
        elements,
        undoCount: undoStack.length,
        redoCount: redoStack.length,
        hasApplicableChanges: elements.length > 0,
        pageUrl: window.location.href,
      };

      // Broadcast to extension UI (background will handle storage persistence)
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime
          .sendMessage({
            type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED,
            payload,
          })
          .catch(() => {
            // Ignore if no listeners (e.g., sidepanel not open)
          });
      }
    };

    if (shouldBroadcastImmediately) {
      doBroadcast();
    } else {
      txChangedBroadcastTimer = window.setTimeout(doBroadcast, TX_CHANGED_BROADCAST_DEBOUNCE_MS);
    }
  }

  /** Last broadcasted selection key to avoid duplicate broadcasts */
  let lastBroadcastedSelectionKey: string | null = null;

  /**
   * Broadcast selection change to sidepanel (no debounce - immediate).
   * Called when user selects or deselects an element.
   */
  function broadcastSelectionChanged(element: Element | null): void {
    // Build selected element summary if element is provided
    let selected: SelectedElementSummary | null = null;

    if (element) {
      const elementKey = generateStableElementKey(element);

      // Dedupe: skip if same element already broadcasted
      if (elementKey === lastBroadcastedSelectionKey) return;
      lastBroadcastedSelectionKey = elementKey;

      const locator = createElementLocator(element);
      selected = {
        elementKey,
        locator,
        label: generateElementLabel(element),
        fullLabel: generateFullElementLabel(element),
        tagName: element.tagName.toLowerCase(),
        updatedAt: Date.now(),
      };
    } else {
      // Deselection - clear tracking
      if (lastBroadcastedSelectionKey === null) return; // Already deselected
      lastBroadcastedSelectionKey = null;
    }

    const payload: WebEditorSelectionChangedPayload = {
      tabId: 0, // Will be filled by background script from sender.tab.id
      selected,
      pageUrl: window.location.href,
    };

    // Broadcast immediately (no debounce for selection changes)
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime
        .sendMessage({
          type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_SELECTION_CHANGED,
          payload,
        })
        .catch(() => {
          // Ignore if no listeners (e.g., sidepanel not open)
        });
    }
  }

  /**
   * Broadcast "editor cleared" state when stopping.
   * Sends empty TX and null selection to remove chips from sidepanel.
   */
  function broadcastEditorCleared(): void {
    // Reset selection dedupe so next start can broadcast correctly
    lastBroadcastedSelectionKey = null;

    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;

    const pageUrl = window.location.href;

    // Send empty TX state
    const txPayload: WebEditorTxChangedPayload = {
      tabId: 0,
      action: 'clear',
      elements: [],
      undoCount: 0,
      redoCount: 0,
      hasApplicableChanges: false,
      pageUrl,
    };

    // Send null selection
    const selectionPayload: WebEditorSelectionChangedPayload = {
      tabId: 0,
      selected: null,
      pageUrl,
    };

    chrome.runtime
      .sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED,
        payload: txPayload,
      })
      .catch(() => {});

    chrome.runtime
      .sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_SELECTION_CHANGED,
        payload: selectionPayload,
      })
      .catch(() => {});
  }

  /**
   * Handle transaction changes from TransactionManager
   */
  function handleTransactionChange(event: TransactionChangeEvent): void {
    // Log transaction events for debugging
    const { action, undoCount, redoCount } = event;
    console.log(
      `${WEB_EDITOR_V2_LOG_PREFIX} Transaction: ${action} (undo: ${undoCount}, redo: ${redoCount})`,
    );

    // Update toolbar UI with undo/redo counts
    state.toolbar?.setHistory(undoCount, redoCount);

    // Refresh property panel after undo/redo to reflect current styles
    if (action === 'undo' || action === 'redo') {
      state.propertyPanel?.refresh();
    }

    // Broadcast aggregated TX state for AgentChat integration (Phase 1.4)
    broadcastTxChanged(action as WebEditorTxChangeAction);

    // Notify HMR consistency verifier of transaction change (Phase 4.8)
    state.hmrConsistencyVerifier?.onTransactionChange(event);
  }

  /**
   * Check if the transaction being applied is still the latest in undo stack.
   * Used to determine if we should auto-rollback on failure.
   *
   * Returns a detailed status to distinguish between:
   * - 'ok': Transaction is still latest, safe to rollback
   * - 'no_snapshot': No apply in progress
   * - 'tm_unavailable': TransactionManager not available
   * - 'stack_empty': Undo stack is empty (tx was already undone)
   * - 'tx_changed': User made new edits or tx was merged
   */
  type ApplyTxStatus = 'ok' | 'no_snapshot' | 'tm_unavailable' | 'stack_empty' | 'tx_changed';

  function checkApplyingTxStatus(): ApplyTxStatus {
    const snapshot = state.applyingSnapshot;
    if (!snapshot) return 'no_snapshot';

    const tm = state.transactionManager;
    if (!tm) return 'tm_unavailable';

    const undoStack = tm.getUndoStack();
    if (undoStack.length === 0) return 'stack_empty';

    const latest = undoStack[undoStack.length - 1]!;

    // Check both id and timestamp to handle merged transactions
    if (latest.id !== snapshot.txId || latest.timestamp !== snapshot.txTimestamp) {
      return 'tx_changed';
    }

    return 'ok';
  }

  /**
   * Attempt to rollback the applying transaction on failure.
   * Returns a descriptive error message based on rollback result.
   *
   * Rollback is only attempted when:
   * - The transaction is still the latest in undo stack
   * - No new edits were made during the apply operation
   */
  function attemptRollbackOnFailure(originalError: string): string {
    const status = checkApplyingTxStatus();

    // Cannot rollback: TM not available or no snapshot
    if (status === 'no_snapshot' || status === 'tm_unavailable') {
      console.error(`${WEB_EDITOR_V2_LOG_PREFIX} Apply failed, unable to revert (${status})`);
      return `${originalError} (unable to revert)`;
    }

    // Stack is empty - tx was already undone (race condition or user action)
    if (status === 'stack_empty') {
      console.warn(`${WEB_EDITOR_V2_LOG_PREFIX} Apply failed, stack empty (already reverted?)`);
      return `${originalError} (already reverted)`;
    }

    // User made new edits during apply - don't rollback their work
    if (status === 'tx_changed') {
      console.warn(
        `${WEB_EDITOR_V2_LOG_PREFIX} Apply failed but new edits detected, skipping auto-rollback`,
      );
      return `${originalError} (new edits detected, not reverted)`;
    }

    // Status is 'ok' - safe to attempt rollback
    const tm = state.transactionManager!;
    const undone = tm.undo();
    if (undone) {
      console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Apply failed, changes auto-reverted`);
      return `${originalError} (changes reverted)`;
    }

    // undo() returned null - likely locateElement() failed
    console.error(`${WEB_EDITOR_V2_LOG_PREFIX} Apply failed and auto-revert also failed`);
    return `${originalError} (revert failed)`;
  }

  /**
   * Apply the latest transaction to Agent (Apply to Code)
   *
   * Phase 2.10: On failure, automatically attempts to undo the transaction
   * to revert DOM changes. The transaction moves to redo stack so user can retry.
   */
  async function applyLatestTransaction(): Promise<{ requestId?: string; sessionId?: string }> {
    const tm = state.transactionManager;
    if (!tm) {
      throw new Error('Transaction manager not ready');
    }

    // Prevent concurrent apply operations
    if (state.applyingSnapshot) {
      throw new Error('Apply already in progress');
    }

    const undoStack = tm.getUndoStack();
    const tx = undoStack.length > 0 ? undoStack[undoStack.length - 1] : null;
    if (!tx) {
      throw new Error('No changes to apply');
    }

    // Apply-to-Code currently supports only style/text transactions
    if (tx.type !== 'style' && tx.type !== 'text') {
      throw new Error(`Apply does not support "${tx.type}" transactions yet`);
    }

    // Snapshot the transaction for rollback tracking
    state.applyingSnapshot = {
      txId: tx.id,
      txTimestamp: tx.timestamp,
    };

    // Markers indicating error was already processed by attemptRollbackOnFailure
    const ROLLBACK_MARKERS = [
      '(changes reverted)',
      '(new edits detected',
      '(revert failed)',
      '(unable to revert)',
      '(already reverted)',
    ];

    const isAlreadyProcessed = (err: unknown): boolean =>
      err instanceof Error && ROLLBACK_MARKERS.some((m) => err.message.includes(m));

    try {
      const resp = await sendTransactionToAgent(tx);
      const r = resp as {
        success?: unknown;
        requestId?: unknown;
        sessionId?: unknown;
        error?: unknown;
      } | null;

      if (r && r.success === true) {
        const requestId = typeof r.requestId === 'string' ? r.requestId : undefined;
        const sessionId = typeof r.sessionId === 'string' ? r.sessionId : undefined;

        // Start tracking execution status if we have a requestId
        if (requestId && sessionId && state.executionTracker) {
          state.executionTracker.track(requestId, sessionId);
        }

        // Start HMR consistency verification (Phase 4.8)
        state.hmrConsistencyVerifier?.start({
          tx,
          requestId,
          sessionId,
          element: state.selectedElement,
        });

        return { requestId, sessionId };
      }

      // Agent returned failure response - attempt rollback
      const errorMsg = typeof r?.error === 'string' ? r.error : 'Agent request failed';
      throw new Error(attemptRollbackOnFailure(errorMsg));
    } catch (error) {
      // Re-throw if already processed by attemptRollbackOnFailure
      if (isAlreadyProcessed(error)) {
        throw error;
      }

      // Network error or other unprocessed exception - attempt rollback
      const originalMsg = error instanceof Error ? error.message : String(error);
      throw new Error(attemptRollbackOnFailure(originalMsg));
    } finally {
      // Clear snapshot regardless of outcome
      state.applyingSnapshot = null;
    }
  }

  /**
   * Apply all applicable transactions to Agent (batch Apply to Code)
   *
   * Phase 1.4: Aggregates the undo stack by element and sends a single batch request.
   * Unlike applyLatestTransaction, this does NOT auto-rollback on failure.
   */
  async function applyAllTransactions(): Promise<{ requestId?: string; sessionId?: string }> {
    const tm = state.transactionManager;
    if (!tm) {
      throw new Error('Transaction manager not ready');
    }

    // Prevent concurrent apply operations
    if (state.applyingSnapshot) {
      throw new Error('Apply already in progress');
    }

    const undoStack = tm.getUndoStack();
    if (undoStack.length === 0) {
      throw new Error('No changes to apply');
    }

    // Block unsupported transaction types
    for (const tx of undoStack) {
      if (tx.type === 'move') {
        throw new Error('Apply does not support reorder operations yet');
      }
      if (tx.type === 'structure') {
        throw new Error('Apply does not support structure operations yet');
      }
      if (tx.type !== 'style' && tx.type !== 'text' && tx.type !== 'class') {
        throw new Error(`Apply does not support "${tx.type}" transactions`);
      }
    }

    const elements = aggregateTransactionsByElement(undoStack);
    if (elements.length === 0) {
      throw new Error('No net changes to apply');
    }

    // Snapshot latest transaction for concurrency tracking
    const latestTx = undoStack[undoStack.length - 1]!;
    state.applyingSnapshot = {
      txId: latestTx.id,
      txTimestamp: latestTx.timestamp,
    };

    try {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
        throw new Error('Chrome runtime API not available');
      }

      const payload: WebEditorApplyBatchPayload = {
        tabId: 0, // Will be filled by background script
        elements,
        excludedKeys: [], // TODO: Read from storage if exclude feature is implemented
        pageUrl: window.location.href,
      };

      const resp = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_APPLY_BATCH,
        payload,
      });

      const r = resp as {
        success?: unknown;
        requestId?: unknown;
        sessionId?: unknown;
        error?: unknown;
      } | null;

      if (r && r.success === true) {
        const requestId = typeof r.requestId === 'string' ? r.requestId : undefined;
        const sessionId = typeof r.sessionId === 'string' ? r.sessionId : undefined;

        // Start tracking execution status if we have a requestId
        if (requestId && sessionId && state.executionTracker) {
          state.executionTracker.track(requestId, sessionId);
        }

        // Clear transaction history after successful apply
        // This prevents undo/redo since changes are now committed to code
        tm.clear();

        // Deselect current element after successful apply
        // This clears the selection chip in the UI
        handleDeselect();

        return { requestId, sessionId };
      }

      const errorMsg = typeof r?.error === 'string' ? r.error : 'Agent request failed';
      throw new Error(errorMsg);
    } finally {
      state.applyingSnapshot = null;
    }
  }

  /**
   * Revert a specific element to its baseline state (Phase 2 - Selective Undo).
   * Creates compensating transactions so the user can undo the revert.
   */
  async function revertElement(
    elementKey: WebEditorElementKey,
  ): Promise<WebEditorRevertElementResponse> {
    const key = String(elementKey ?? '').trim();
    if (!key) {
      return { success: false, error: 'elementKey is required' };
    }

    const tm = state.transactionManager;
    if (!tm) {
      return { success: false, error: 'Transaction manager not ready' };
    }

    if (state.applyingSnapshot) {
      return { success: false, error: 'Cannot revert while Apply is in progress' };
    }

    try {
      const undoStack = tm.getUndoStack();
      const summaries = aggregateTransactionsByElement(undoStack);
      const summary = summaries.find((s) => s.elementKey === key);

      if (!summary) {
        return { success: false, error: 'Element not found in current changes' };
      }

      const element = locateElement(summary.locator);
      if (!element || !element.isConnected) {
        return { success: false, error: 'Failed to locate element for revert' };
      }

      const reverted: NonNullable<WebEditorRevertElementResponse['reverted']> = {};
      let didRevert = false;

      // Revert class first so subsequent locators are based on baseline classes.
      const classChanges = summary.netEffect.classChanges;
      if (classChanges) {
        const baselineClasses = Array.isArray(classChanges.before) ? classChanges.before : [];
        const beforeClasses = (() => {
          try {
            const list = (element as HTMLElement).classList;
            if (list && typeof list[Symbol.iterator] === 'function') {
              return Array.from(list).filter(Boolean);
            }
          } catch {
            // Fallback for non-HTMLElement
          }

          const raw = element.getAttribute('class') ?? '';
          return raw
            .split(/\s+/)
            .map((t) => t.trim())
            .filter(Boolean);
        })();

        const tx = tm.recordClass(element, beforeClasses, baselineClasses);
        if (tx) {
          reverted.class = true;
          didRevert = true;
        }
      }

      // Revert text content
      const textChange = summary.netEffect.textChange;
      if (textChange) {
        const baselineText = String(textChange.before ?? '');
        const beforeText = element.textContent ?? '';

        if (beforeText !== baselineText) {
          element.textContent = baselineText;
          const tx = tm.recordText(element, beforeText, baselineText);
          if (tx) {
            reverted.text = true;
            didRevert = true;
          }
        }
      }

      // Revert styles
      const styleChanges = summary.netEffect.styleChanges;
      if (styleChanges) {
        const before = styleChanges.before ?? {};
        const after = styleChanges.after ?? {};

        const properties = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]))
          .map((p) => String(p ?? '').trim())
          .filter(Boolean);

        if (properties.length > 0) {
          const handle = tm.beginMultiStyle(element, properties);
          if (handle) {
            handle.set(before);
            const tx = handle.commit({ merge: false });
            if (tx) {
              reverted.style = true;
              didRevert = true;
            }
          }
        }
      }

      if (!didRevert) {
        return { success: false, error: 'No changes were reverted' };
      }

      // Ensure property panel reflects reverted values immediately
      state.propertyPanel?.refresh();

      return { success: true, reverted };
    } catch (error) {
      console.error(`${WEB_EDITOR_V2_LOG_PREFIX} Revert element failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Clear current selection (called from sidepanel after send).
   * Triggers handleDeselect which broadcasts null selection to sidepanel.
   */
  function clearSelection(): void {
    if (!state.selectedElement) {
      // Already deselected
      return;
    }

    // Use EventController to properly transition to hover mode
    // This triggers onDeselect callback → handleDeselect → broadcastSelectionChanged(null)
    if (state.eventController) {
      state.eventController.setMode('hover');

      // Edge case: if setMode('hover') didn't trigger deselect (e.g., already in hover mode
      // but selectedElement was set programmatically), manually call handleDeselect
      if (state.selectedElement) {
        handleDeselect();
      }
    } else {
      // Fallback if eventController not available: directly call handleDeselect
      handleDeselect();
    }

    console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Selection cleared (from sidepanel)`);
  }

  /**
   * Handle transaction apply errors
   */
  function handleTransactionError(error: unknown): void {
    console.error(`${WEB_EDITOR_V2_LOG_PREFIX} Transaction apply error:`, error);
  }

  /**
   * Start the editor
   */
  function start(): void {
    if (state.active) {
      console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Already active`);
      return;
    }

    try {
      // Mount Shadow DOM host
      state.shadowHost = mountShadowHost({});

      // Initialize Canvas Overlay
      const elements = state.shadowHost.getElements();
      if (!elements?.overlayRoot) {
        throw new Error('Shadow host overlayRoot not available');
      }
      state.canvasOverlay = createCanvasOverlay({
        container: elements.overlayRoot,
      });

      // Initialize Performance Monitor (Phase 5.3) - disabled by default
      state.perfMonitor = createPerfMonitor({
        container: elements.overlayRoot,
        fpsUiIntervalMs: 500,
        memorySampleIntervalMs: 1000,
      });

      // Register hotkey: Ctrl/Cmd + Shift + P toggles perf monitor
      const perfHotkeyHandler = (event: KeyboardEvent): void => {
        // Ignore key repeats to avoid rapid toggles when holding the shortcut
        if (event.repeat) return;

        const isMod = event.metaKey || event.ctrlKey;
        if (!isMod) return;
        if (!event.shiftKey) return;
        if (event.altKey) return;

        const key = (event.key || '').toLowerCase();
        if (key !== 'p') return;

        const monitor = state.perfMonitor;
        if (!monitor) return;

        monitor.toggle();

        // Prevent browser shortcuts (e.g., print dialog)
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      };

      const hotkeyOptions: AddEventListenerOptions = { capture: true, passive: false };
      window.addEventListener('keydown', perfHotkeyHandler, hotkeyOptions);
      state.perfHotkeyCleanup = () => {
        window.removeEventListener('keydown', perfHotkeyHandler, hotkeyOptions);
      };

      // Initialize Selection Engine for intelligent element picking
      state.selectionEngine = createSelectionEngine({
        isOverlayElement: state.shadowHost.isOverlayElement,
      });

      // Initialize Position Tracker for scroll/resize synchronization
      state.positionTracker = createPositionTracker({
        onPositionUpdate: handlePositionUpdate,
      });

      // Initialize Transaction Manager for undo/redo support
      // Use isEventFromUi (not isOverlayElement) to properly check event source
      state.transactionManager = createTransactionManager({
        enableKeyBindings: true,
        // Include both Shadow UI events and events from editing element
        // This prevents Ctrl/Cmd+Z from triggering global undo while editing text
        isEventFromEditorUi: (event) => {
          if (state.shadowHost?.isEventFromUi(event)) return true;
          // Also ignore events from the editing element (allow native contentEditable undo)
          const session = editSession;
          if (session?.element) {
            try {
              const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
              if (path?.some((node) => node === session.element)) return true;
            } catch {
              // Fallback
              const target = event.target;
              if (target instanceof Node && session.element.contains(target)) return true;
            }
          }
          return false;
        },
        onChange: handleTransactionChange,
        onApplyError: handleTransactionError,
      });

      // Initialize Resize Handles Controller (Phase 4.9)
      state.handlesController = createHandlesController({
        container: elements.overlayRoot,
        canvasOverlay: state.canvasOverlay,
        transactionManager: state.transactionManager,
        positionTracker: state.positionTracker,
      });

      // Initialize Drag Reorder Controller (Phase 2.4-2.6)
      state.dragReorderController = createDragReorderController({
        isOverlayElement: state.shadowHost.isOverlayElement,
        uiRoot: elements.uiRoot,
        canvasOverlay: state.canvasOverlay,
        positionTracker: state.positionTracker,
        transactionManager: state.transactionManager,
      });

      // Initialize Event Controller for interaction handling
      // Wire up SelectionEngine's findBestTargetFromEvent for Shadow DOM-aware selection (click only)
      // Hover uses fast elementFromPoint for 60FPS performance
      state.eventController = createEventController({
        isOverlayElement: state.shadowHost.isOverlayElement,
        onHover: handleHover,
        onSelect: handleSelect,
        onDeselect: handleDeselect,
        onStartEdit: startEdit,
        findTargetForSelect: (_x, _y, modifiers, event) =>
          state.selectionEngine?.findBestTargetFromEvent(event, modifiers) ?? null,
        getSelectedElement: () => state.selectedElement,
        onStartDrag: (ev) => state.dragReorderController?.onDragStart(ev) ?? false,
        onDragMove: (ev) => state.dragReorderController?.onDragMove(ev),
        onDragEnd: (ev) => state.dragReorderController?.onDragEnd(ev),
        onDragCancel: (ev) => state.dragReorderController?.onDragCancel(ev),
      });

      // Initialize ExecutionTracker for tracking Agent execution status (Phase 3.10)
      state.executionTracker = createExecutionTracker({
        onStatusChange: (execState: ExecutionState) => {
          // Map execution status to toolbar status (only used when HMR verifier is not active)
          // When verifier is active, it controls toolbar status after execution completes
          const verifierPhase = state.hmrConsistencyVerifier?.getSnapshot().phase ?? 'idle';
          const verifierActive = verifierPhase !== 'idle';

          // Only update toolbar directly if verifier is not handling it
          if (!verifierActive || execState.status !== 'completed') {
            const statusMap: Record<string, string> = {
              pending: 'applying',
              starting: 'starting',
              running: 'running',
              locating: 'locating',
              applying: 'applying',
              completed: 'completed',
              failed: 'failed',
              error: 'failed', // Server may return 'error', treat same as 'failed'
              timeout: 'timeout',
              cancelled: 'cancelled',
            };
            type ToolbarStatusType = Parameters<NonNullable<typeof state.toolbar>['setStatus']>[0];
            const toolbarStatus = (statusMap[execState.status] ?? 'running') as ToolbarStatusType;
            state.toolbar?.setStatus(toolbarStatus, execState.message);
          }

          // Forward to HMR consistency verifier (Phase 4.8)
          state.hmrConsistencyVerifier?.onExecutionStatus(execState);
        },
      });

      // Initialize HMR Consistency Verifier (Phase 4.8)
      state.hmrConsistencyVerifier = createHmrConsistencyVerifier({
        transactionManager: state.transactionManager,
        getSelectedElement: () => state.selectedElement,
        onReselect: (element) => handleSelect(element, DEFAULT_MODIFIERS),
        onDeselect: handleDeselect,
        setToolbarStatus: (status, message) => state.toolbar?.setStatus(status, message),
        isOverlayElement: state.shadowHost?.isOverlayElement,
        selectionEngine: state.selectionEngine ?? undefined,
      });

      // Initialize Toolbar UI
      state.toolbar = createToolbar({
        container: elements.uiRoot,
        dock: 'top',
        initialPosition: state.toolbarPosition,
        onPositionChange: (position) => {
          state.toolbarPosition = position;
        },
        getApplyBlockReason: () => {
          const tm = state.transactionManager;
          if (!tm) return undefined;

          const undoStack = tm.getUndoStack();
          if (undoStack.length === 0) return undefined;

          // Check all transactions for unsupported types (Phase 1.4)
          // NOTE: We only do O(n) type checking here, NOT aggregation.
          // Full net effect check happens in applyAllTransactions() to avoid
          // performance issues during frequent merge events.
          for (const tx of undoStack) {
            if (tx.type === 'move') {
              return 'Apply does not support reorder operations yet';
            }
            if (tx.type === 'structure') {
              return 'Apply does not support structure operations yet';
            }
            if (tx.type !== 'style' && tx.type !== 'text' && tx.type !== 'class') {
              return `Apply does not support "${tx.type}" transactions`;
            }
          }

          return undefined;
        },
        getSelectedElement: () => state.selectedElement,
        onStructure: (data) => {
          const target = state.selectedElement;
          if (!target) return;

          const tm = state.transactionManager;
          if (!tm) return;

          const tx = tm.applyStructure(target, data);
          if (!tx) return;

          // Update selection based on action type
          // For wrap/stack: select the new wrapper
          // For unwrap: select the unwrapped child
          // For duplicate: select the clone
          // For delete: deselect
          if (data.action === 'delete') {
            handleDeselect();
          } else {
            // The transaction's targetLocator points to the new selection target
            // For wrap/stack: wrapper
            // For unwrap: child
            // For duplicate: clone
            const newTarget = locateElement(tx.targetLocator);
            if (newTarget && newTarget.isConnected) {
              handleSelect(newTarget, DEFAULT_MODIFIERS);
            }
          }
        },
        onApply: applyAllTransactions,
        onUndo: () => state.transactionManager?.undo(),
        onRedo: () => state.transactionManager?.redo(),
        onRequestClose: () => stop(),
      });

      // Initialize toolbar history display
      state.toolbar.setHistory(
        state.transactionManager.getUndoStack().length,
        state.transactionManager.getRedoStack().length,
      );

      // Initialize Breadcrumbs UI (shows selected element ancestry)
      state.breadcrumbs = createBreadcrumbs({
        container: elements.uiRoot,
        dock: 'top',
        onSelect: (element) => {
          // When a breadcrumb is clicked, select that ancestor element
          if (element.isConnected) {
            handleSelect(element, DEFAULT_MODIFIERS);
          }
        },
      });

      // Initialize Props Bridge (Phase 7)
      state.propsBridge = createPropsBridge({});

      // Initialize Design Tokens Service (Phase 5.3)
      state.tokensService = createDesignTokensService();

      // Initialize Property Panel (Phase 3)
      state.propertyPanel = createPropertyPanel({
        container: elements.uiRoot,
        transactionManager: state.transactionManager,
        propsBridge: state.propsBridge,
        tokensService: state.tokensService,
        initialPosition: state.propertyPanelPosition,
        onPositionChange: (position) => {
          state.propertyPanelPosition = position;
        },
        defaultTab: 'design',
        onSelectElement: (element) => {
          // When an element is selected from Components tree
          if (element.isConnected) {
            handleSelect(element, DEFAULT_MODIFIERS);
          }
        },
        onRequestClose: () => stop(),
      });

      // Clamp floating UI positions on window resize (session-only persistence)
      let uiResizeRafId: number | null = null;

      const clampFloatingUi = (): void => {
        const toolbarPos = state.toolbarPosition;
        const panelPos = state.propertyPanelPosition;

        if (state.toolbar && toolbarPos) {
          state.toolbar.setPosition(toolbarPos);
        }
        if (state.propertyPanel && panelPos) {
          state.propertyPanel.setPosition(panelPos);
        }
      };

      const onWindowResize = (): void => {
        if (!state.active) return;
        if (uiResizeRafId !== null) return;
        uiResizeRafId = window.requestAnimationFrame(() => {
          uiResizeRafId = null;
          clampFloatingUi();
        });
      };

      window.addEventListener('resize', onWindowResize, { passive: true });
      state.uiResizeCleanup = () => {
        window.removeEventListener('resize', onWindowResize);
        if (uiResizeRafId !== null) {
          window.cancelAnimationFrame(uiResizeRafId);
          uiResizeRafId = null;
        }
      };

      // Ensure restored positions are visible on first render
      clampFloatingUi();

      state.active = true;
      console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Started`);
    } catch (error) {
      // Cleanup on failure (reverse order)
      state.uiResizeCleanup?.();
      state.uiResizeCleanup = null;
      state.propertyPanel?.dispose();
      state.propertyPanel = null;
      state.tokensService?.dispose();
      state.tokensService = null;
      state.propsBridge?.dispose();
      state.propsBridge = null;
      state.breadcrumbs?.dispose();
      state.breadcrumbs = null;
      state.toolbar?.dispose();
      state.toolbar = null;
      state.eventController?.dispose();
      state.eventController = null;
      state.dragReorderController?.dispose();
      state.dragReorderController = null;
      state.handlesController?.dispose();
      state.handlesController = null;
      state.transactionManager?.dispose();
      state.transactionManager = null;
      state.positionTracker?.dispose();
      state.positionTracker = null;
      state.selectionEngine?.dispose();
      state.selectionEngine = null;
      state.perfHotkeyCleanup?.();
      state.perfHotkeyCleanup = null;
      state.perfMonitor?.dispose();
      state.perfMonitor = null;
      state.canvasOverlay?.dispose();
      state.canvasOverlay = null;
      state.shadowHost?.dispose();
      state.shadowHost = null;
      state.hoveredElement = null;
      state.selectedElement = null;
      state.applyingSnapshot = null;
      state.active = false;

      console.error(`${WEB_EDITOR_V2_LOG_PREFIX} Failed to start:`, error);
    }
  }

  /**
   * Stop the editor
   */
  function stop(): void {
    if (!state.active) {
      return;
    }

    state.active = false;

    // Cancel pending debounced broadcasts (Phase 1.4)
    if (txChangedBroadcastTimer !== null) {
      window.clearTimeout(txChangedBroadcastTimer);
      txChangedBroadcastTimer = null;
    }

    try {
      // Cleanup in reverse order of initialization

      // Commit any in-progress text edit before cleanup
      if (editSession) {
        commitEdit();
      }

      // Cleanup resize listener for floating UI
      state.uiResizeCleanup?.();
      state.uiResizeCleanup = null;

      // Cleanup Property Panel (Phase 3)
      state.propertyPanel?.dispose();
      state.propertyPanel = null;

      // Cleanup Design Tokens Service (Phase 5.3)
      state.tokensService?.dispose();
      state.tokensService = null;

      // Cleanup Props Bridge (Phase 7) - best effort cleanup
      void state.propsBridge?.cleanup();
      state.propsBridge = null;

      // Cleanup Breadcrumbs UI
      state.breadcrumbs?.dispose();
      state.breadcrumbs = null;

      // Cleanup Toolbar UI
      state.toolbar?.dispose();
      state.toolbar = null;

      // Cleanup Event Controller (stops event interception)
      state.eventController?.dispose();
      state.eventController = null;

      // Cleanup Drag Reorder Controller
      state.dragReorderController?.dispose();
      state.dragReorderController = null;

      // Cleanup Resize Handles Controller (Phase 4.9)
      state.handlesController?.dispose();
      state.handlesController = null;

      // Cleanup Execution Tracker (Phase 3.10)
      state.executionTracker?.dispose();
      state.executionTracker = null;

      // Cleanup HMR Consistency Verifier (Phase 4.8)
      state.hmrConsistencyVerifier?.dispose();
      state.hmrConsistencyVerifier = null;

      // Cleanup Transaction Manager (clears history)
      state.transactionManager?.dispose();
      state.transactionManager = null;

      // Cleanup Position Tracker (stops scroll/resize monitoring)
      state.positionTracker?.dispose();
      state.positionTracker = null;

      // Cleanup Selection Engine
      state.selectionEngine?.dispose();
      state.selectionEngine = null;

      // Cleanup Performance Monitor (Phase 5.3)
      state.perfHotkeyCleanup?.();
      state.perfHotkeyCleanup = null;
      state.perfMonitor?.dispose();
      state.perfMonitor = null;

      // Cleanup Canvas Overlay
      state.canvasOverlay?.dispose();
      state.canvasOverlay = null;

      // Cleanup Shadow DOM host
      state.shadowHost?.dispose();
      state.shadowHost = null;

      // Clear element references and apply state
      state.hoveredElement = null;
      state.selectedElement = null;
      state.applyingSnapshot = null;

      console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Stopped`);
    } catch (error) {
      console.error(`${WEB_EDITOR_V2_LOG_PREFIX} Error during cleanup:`, error);

      // Force cleanup
      state.propertyPanel = null;
      state.propsBridge = null;
      state.breadcrumbs = null;
      state.toolbar = null;
      state.eventController = null;
      state.dragReorderController = null;
      state.handlesController = null;
      state.transactionManager = null;
      state.positionTracker = null;
      state.selectionEngine = null;
      state.perfHotkeyCleanup = null;
      state.perfMonitor = null;
      state.canvasOverlay = null;
      state.shadowHost = null;
      state.hoveredElement = null;
      state.selectedElement = null;
      state.applyingSnapshot = null;
    } finally {
      // Always broadcast clear state to sidepanel (removes chips)
      broadcastEditorCleared();
    }
  }

  /**
   * Toggle the editor on/off
   */
  function toggle(): boolean {
    if (state.active) {
      stop();
    } else {
      start();
    }
    return state.active;
  }

  /**
   * Get current editor state
   */
  function getState(): WebEditorState {
    return {
      active: state.active,
      version: WEB_EDITOR_V2_VERSION,
    };
  }

  return {
    start,
    stop,
    toggle,
    getState,
    revertElement,
    clearSelection,
  };
}
