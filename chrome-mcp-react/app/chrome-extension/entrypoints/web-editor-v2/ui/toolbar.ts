/**
 * Toolbar UI (Phase 1.10, extended in Phase 5.5)
 *
 * Shadow DOM toolbar with Apply / Structure / Undo / Redo / Close buttons.
 * Displays transaction counts and operation status.
 *
 * Design:
 * - Fixed position at top of viewport
 * - Uses CSS classes defined in shadow-host.ts
 * - Disposer pattern for cleanup
 *
 * Phase 5.5 additions:
 * - Structure dropdown menu (Group/Stack/Ungroup/Delete/Duplicate)
 */

import type { StructureOperationData } from '@/common/web-editor-types';
import { Disposer } from '../utils/disposables';
import { installFloatingDrag, type FloatingPosition } from './floating-drag';
import {
  createChevronDownSmallIcon,
  createCloseIcon,
  createGripIcon,
  createRedoIcon,
  createUndoIcon,
} from './icons';

// =============================================================================
// Types
// =============================================================================

/** Toolbar position */
export type ToolbarDock = 'top' | 'bottom';

/** Operation status */
export type ToolbarStatus =
  | 'idle'
  | 'applying'
  | 'success'
  | 'error'
  | 'running'
  | 'starting'
  | 'locating'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  // Phase 4.8: HMR consistency verification statuses
  | 'verifying'
  | 'verified'
  | 'mismatch'
  | 'lost'
  | 'uncertain';

/** Result from apply operation */
export interface ApplyResult {
  requestId?: string;
  sessionId?: string;
}

/** Toolbar creation options */
export interface ToolbarOptions {
  /** Container element in Shadow DOM */
  container: HTMLElement;
  /** Position (default: top) */
  dock?: ToolbarDock;
  /**
   * Initial floating position (viewport coordinates).
   * When provided, the toolbar uses left/top positioning and becomes draggable.
   */
  initialPosition?: FloatingPosition | null;
  /**
   * Called whenever the floating position changes.
   * Use null to indicate the toolbar is in its default docked position.
   */
  onPositionChange?: (position: FloatingPosition | null) => void;
  /** Called when Apply button is clicked */
  onApply?: () => void | ApplyResult | Promise<void | ApplyResult>;
  /**
   * Pre-flight check to block Apply.
   * Return a non-empty string to disable the Apply button and show as tooltip.
   * Called during render to update button state.
   */
  getApplyBlockReason?: () => string | undefined;
  /**
   * Get the currently selected element (Phase 5.5).
   * Used to enable/disable Structure actions.
   */
  getSelectedElement?: () => Element | null;
  /**
   * Called when a Structure action is requested (Phase 5.5).
   */
  onStructure?: (data: StructureOperationData) => void;
  /** Called when Undo button is clicked */
  onUndo?: () => void;
  /** Called when Redo button is clicked */
  onRedo?: () => void;
  /** Called when Close button is clicked */
  onRequestClose?: () => void;
}

/** Toolbar public interface */
export interface Toolbar {
  /** Update undo/redo counts */
  setHistory(undoCount: number, redoCount: number): void;
  /** Update status display */
  setStatus(status: ToolbarStatus, message?: string): void;
  /** Get current floating position (viewport coordinates), null when docked */
  getPosition(): FloatingPosition | null;
  /** Set floating position (viewport coordinates), pass null to reset to docked */
  setPosition(position: FloatingPosition | null): void;
  /** Cleanup */
  dispose(): void;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check if value is Promise-like
 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Check if value is ApplyResult
 */
function isApplyResult(value: unknown): value is ApplyResult {
  if (!value || typeof value !== 'object') return false;
  const req = (value as { requestId?: unknown }).requestId;
  return req === undefined || typeof req === 'string';
}

/**
 * Format status message with optional request ID
 */
function formatStatusMessage(base: string, result?: ApplyResult): string {
  const req = result?.requestId ? `requestId=${result.requestId}` : '';
  return req ? `${base} (${req})` : base;
}

// =============================================================================
// Status Reset Timer
// =============================================================================

const STATUS_RESET_DELAY_MS = 2400;

// Status categories for UI styling
const SUCCESS_STATUSES: ToolbarStatus[] = ['success', 'completed', 'verified'];
const ERROR_STATUSES: ToolbarStatus[] = [
  'error',
  'failed',
  'timeout',
  'cancelled',
  'mismatch',
  'lost',
  'uncertain',
];
const PROGRESS_STATUSES: ToolbarStatus[] = [
  'applying',
  'running',
  'starting',
  'locating',
  'verifying',
];

function getStatusCategory(status: ToolbarStatus): 'idle' | 'progress' | 'success' | 'error' {
  if (SUCCESS_STATUSES.includes(status)) return 'success';
  if (ERROR_STATUSES.includes(status)) return 'error';
  if (PROGRESS_STATUSES.includes(status)) return 'progress';
  return 'idle';
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a Toolbar UI component
 */
export function createToolbar(options: ToolbarOptions): Toolbar {
  const disposer = new Disposer();
  const dock = options.dock ?? 'top';

  // State
  let undoCount = 0;
  let redoCount = 0;
  let status: ToolbarStatus = 'idle';
  let statusMessage = '';
  let applying = false;
  let resetTimer: number | null = null;
  let minimized = false;
  let floatingPosition: FloatingPosition | null = options.initialPosition ?? null;

  // ==========================================================================
  // DOM Structure
  // ==========================================================================

  // Root container
  const root = document.createElement('div');
  root.className = 'we-toolbar';
  root.dataset.position = dock;
  root.dataset.status = status;
  root.dataset.minimized = 'false';
  root.dataset.dragged = floatingPosition ? 'true' : 'false';
  root.dataset.structureOpen = 'false';
  root.setAttribute('role', 'toolbar');
  root.setAttribute('aria-label', 'Web Editor Toolbar');

  // ==========================================================================
  // Grip Toggle Button (unified toggle + drag handle)
  // ==========================================================================

  const dragHandle = document.createElement('button');
  dragHandle.type = 'button';
  dragHandle.className = 'we-drag-handle';
  dragHandle.setAttribute('aria-label', 'Collapse toolbar');
  dragHandle.dataset.tooltip = 'Collapse';
  dragHandle.append(createGripIcon());

  // ==========================================================================
  // Content Row (collapses with toolbar)
  // ==========================================================================

  const content = document.createElement('div');
  content.className = 'we-toolbar-content';

  // Status indicator: green dot + "Editor" label
  const indicator = document.createElement('div');
  indicator.className = 'we-toolbar-indicator';

  const indicatorDot = document.createElement('span');
  indicatorDot.className = 'we-toolbar-indicator-dot';

  const indicatorLabel = document.createElement('span');
  indicatorLabel.className = 'we-toolbar-indicator-label';
  indicatorLabel.textContent = 'Editor';

  indicator.append(indicatorDot, indicatorLabel);

  // Undo/Redo counts
  const historyEl = document.createElement('div');
  historyEl.className = 'we-toolbar-history';

  const undoCountLabel = document.createElement('span');
  const undoCountValue = document.createElement('b');
  undoCountValue.className = 'we-toolbar-history-value';
  undoCountLabel.append('Undo: ', undoCountValue);

  const redoCountLabel = document.createElement('span');
  const redoCountValue = document.createElement('b');
  redoCountValue.className = 'we-toolbar-history-value';
  redoCountLabel.append('Redo: ', redoCountValue);

  historyEl.append(undoCountLabel, redoCountLabel);

  // Divider
  const divider = document.createElement('div');
  divider.className = 'we-toolbar-divider';

  // Structure group container
  const structureGroup = document.createElement('div');
  structureGroup.className = 'we-toolbar-structure-group';

  // Group separator (between Structure button and Undo/Redo icons)
  const structureGroupSeparator = document.createElement('div');
  structureGroupSeparator.className = 'we-toolbar-structure-separator';

  // Apply button
  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'we-toolbar-apply-btn';
  applyBtn.textContent = 'Apply';
  applyBtn.setAttribute('aria-label', 'Apply changes to code');

  // Undo button (inside structure group)
  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.className = 'we-toolbar-group-icon-btn';
  undoBtn.setAttribute('aria-label', 'Undo last change');
  undoBtn.dataset.tooltip = 'Undo';
  undoBtn.append(createUndoIcon());

  // Redo button (inside structure group)
  const redoBtn = document.createElement('button');
  redoBtn.type = 'button';
  redoBtn.className = 'we-toolbar-group-icon-btn';
  redoBtn.setAttribute('aria-label', 'Redo last undone change');
  redoBtn.dataset.tooltip = 'Redo';
  redoBtn.append(createRedoIcon());

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'we-toolbar-close-btn';
  closeBtn.setAttribute('aria-label', 'Close Web Editor');
  closeBtn.dataset.tooltip = 'Exit Editor';
  closeBtn.append(createCloseIcon());

  // Hidden status live region (for screen readers)
  const statusEl = document.createElement('span');
  statusEl.className = 'we-sr-only';
  statusEl.setAttribute('aria-live', 'polite');

  // ==========================================================================
  // Structure Dropdown (Phase 5.5)
  // ==========================================================================

  type StructureMenuAction = 'group' | 'stack' | 'ungroup' | 'duplicate' | 'delete';

  // Tags that cannot be structure operation targets
  const DISALLOWED_TARGET_TAGS = new Set(['HTML', 'BODY', 'HEAD']);
  // Tags that cannot be parent containers for structure operations (BODY is allowed)
  const DISALLOWED_CONTAINER_TAGS = new Set(['HTML', 'HEAD']);
  const DEFAULT_STACK_GAP = '10px';

  // Structure dropdown wrapper
  const structureWrap = document.createElement('div');
  structureWrap.className = 'we-structure-wrap';
  structureWrap.style.position = 'relative';
  structureWrap.style.display = 'inline-flex';

  // Structure trigger button
  const structureBtn = document.createElement('button');
  structureBtn.type = 'button';
  structureBtn.className = 'we-toolbar-structure-btn';
  structureBtn.setAttribute('aria-label', 'Structure operations');
  structureBtn.setAttribute('aria-haspopup', 'menu');
  structureBtn.setAttribute('aria-expanded', 'false');
  structureBtn.append(document.createTextNode('Structure'), createChevronDownSmallIcon());

  // Structure dropdown menu
  const structureMenu = document.createElement('div');
  structureMenu.className = 'we-structure-menu';
  structureMenu.setAttribute('role', 'menu');
  structureMenu.setAttribute('aria-label', 'Structure actions');
  Object.assign(structureMenu.style, {
    position: 'absolute',
    top: 'calc(100% + 8px)',
    right: '0',
    minWidth: '160px',
    padding: '6px',
    background: 'rgba(255, 255, 255, 0.98)',
    border: '1px solid rgba(148, 163, 184, 0.45)',
    borderRadius: '10px',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.08), 0 10px 20px -5px rgba(0, 0, 0, 0.12)',
    backdropFilter: 'blur(8px)',
    display: 'none',
    flexDirection: 'column',
    gap: '4px',
    zIndex: '10001',
  });

  structureWrap.append(structureBtn, structureMenu);

  // Build StructureOperationData from menu action
  function buildStructureData(action: StructureMenuAction): StructureOperationData {
    switch (action) {
      case 'group':
        return { action: 'wrap', wrapperTag: 'div' };
      case 'stack':
        return {
          action: 'wrap',
          wrapperTag: 'div',
          wrapperStyles: {
            display: 'flex',
            'flex-direction': 'column',
            gap: DEFAULT_STACK_GAP,
          },
        };
      case 'ungroup':
        return { action: 'unwrap' };
      case 'duplicate':
        return { action: 'duplicate' };
      case 'delete':
        return { action: 'delete' };
    }
  }

  // Create menu item button
  function createStructureMenuItem(action: StructureMenuAction, label: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = action === 'delete' ? 'we-btn we-btn--danger' : 'we-btn';
    btn.textContent = label;
    btn.setAttribute('role', 'menuitem');
    btn.dataset.action = action;
    Object.assign(btn.style, {
      width: '100%',
      justifyContent: 'flex-start',
      padding: '6px 10px',
    });
    return btn;
  }

  // Menu items
  const structureItems: Array<{
    action: StructureMenuAction;
    label: string;
    el: HTMLButtonElement;
  }> = [
    { action: 'group', label: 'Group', el: createStructureMenuItem('group', 'Group') },
    { action: 'stack', label: 'Stack', el: createStructureMenuItem('stack', 'Stack') },
    { action: 'ungroup', label: 'Ungroup', el: createStructureMenuItem('ungroup', 'Ungroup') },
    {
      action: 'duplicate',
      label: 'Duplicate',
      el: createStructureMenuItem('duplicate', 'Duplicate'),
    },
    { action: 'delete', label: 'Delete', el: createStructureMenuItem('delete', 'Delete') },
  ];

  for (const item of structureItems) {
    structureMenu.append(item.el);
  }

  // Structure menu state
  let structureOpen = false;

  function setStructureOpen(open: boolean): void {
    structureOpen = open;
    structureMenu.style.display = open ? 'flex' : 'none';
    structureBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    // Toggle overflow on toolbar (CSS: overflow: visible when open + expanded)
    root.dataset.structureOpen = open ? 'true' : 'false';
  }

  function getSelectedElement(): Element | null {
    const el = options.getSelectedElement?.() ?? null;
    return el?.isConnected ? el : null;
  }

  function isDisallowedTarget(el: Element): boolean {
    const tag = el.tagName?.toUpperCase();
    return DISALLOWED_TARGET_TAGS.has(tag);
  }

  function isDisallowedContainer(el: Element): boolean {
    const tag = el.tagName?.toUpperCase();
    return DISALLOWED_CONTAINER_TAGS.has(tag);
  }

  function getStructureActionBlockReason(
    action: StructureMenuAction,
    target: Element | null,
  ): string | null {
    if (applying) return 'Operation in progress';
    if (!options.onStructure) return 'Not configured';
    if (!target) return 'Select an element first';
    if (isDisallowedTarget(target)) return 'Cannot edit <html>, <body>, or <head>';

    const parent = target.parentElement;

    switch (action) {
      case 'group':
      case 'stack':
        if (!parent) return 'Element has no parent';
        if (isDisallowedContainer(parent)) return 'Cannot wrap under <html> or <head>';
        return null;
      case 'ungroup':
        if (!parent) return 'Element has no parent';
        if (isDisallowedContainer(parent)) return 'Cannot unwrap under <html> or <head>';
        if (target.childElementCount !== 1) return 'Ungroup requires exactly one child';
        return null;
      case 'duplicate':
      case 'delete':
        if (!parent) return 'Element has no parent';
        if (isDisallowedContainer(parent)) return 'Cannot modify under <html> or <head>';
        return null;
    }
  }

  function renderStructureControls(): void {
    const target = getSelectedElement();

    let anyEnabled = false;
    for (const item of structureItems) {
      const reason = getStructureActionBlockReason(item.action, target);
      const disabled = !!reason;
      item.el.disabled = disabled;
      item.el.title = reason ?? '';
      anyEnabled = anyEnabled || !disabled;
    }

    structureBtn.disabled = !anyEnabled;
    structureBtn.title = !anyEnabled
      ? (getStructureActionBlockReason('group', target) ?? 'Unavailable')
      : '';

    if (structureBtn.disabled && structureOpen) {
      setStructureOpen(false);
    }
  }

  // Assemble structure group: Structure dropdown + separator + Undo/Redo icons
  structureGroup.append(structureWrap, structureGroupSeparator, undoBtn, redoBtn);

  // End actions: Apply + Close (pushed to right via margin-left: auto)
  const endActions = document.createElement('div');
  endActions.className = 'we-toolbar-end-actions';
  endActions.append(applyBtn, closeBtn);

  // Assemble content row
  content.append(indicator, historyEl, divider, structureGroup, endActions);

  // Assemble root: grip + content + hidden status
  root.append(dragHandle, content, statusEl);
  options.container.append(root);
  disposer.add(() => root.remove());

  // ==========================================================================
  // Floating Drag (Toolbar Position)
  // ==========================================================================

  const CLAMP_MARGIN_PX = 16;

  function clampToViewport(position: FloatingPosition): FloatingPosition {
    const rect = root.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    const margin = CLAMP_MARGIN_PX;
    const maxLeft = Math.max(margin, viewportW - margin - rect.width);
    const maxTop = Math.max(margin, viewportH - margin - rect.height);

    const left = Number.isFinite(position.left) ? position.left : 0;
    const top = Number.isFinite(position.top) ? position.top : 0;

    return {
      left: Math.round(Math.min(maxLeft, Math.max(margin, left))),
      top: Math.round(Math.min(maxTop, Math.max(margin, top))),
    };
  }

  function syncFloatingPositionStyles(): void {
    root.dataset.dragged = floatingPosition ? 'true' : 'false';

    // No floating position: use CSS-defined positioning (centered)
    if (!floatingPosition) {
      root.style.left = '';
      root.style.top = '';
      root.style.right = '';
      root.style.bottom = '';
      root.style.transform = '';
      return;
    }

    // Apply floating position (works for both collapsed and expanded states)
    root.style.left = `${floatingPosition.left}px`;
    root.style.top = `${floatingPosition.top}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    root.style.transform = 'none';
  }

  function setPosition(position: FloatingPosition | null): void {
    floatingPosition = position ? clampToViewport(position) : null;
    syncFloatingPositionStyles();
    options.onPositionChange?.(floatingPosition);
  }

  function getPosition(): FloatingPosition | null {
    return floatingPosition;
  }

  // Install drag behavior with delayed activation (supports short click + long press drag)
  disposer.add(
    installFloatingDrag({
      handleEl: dragHandle,
      targetEl: root,
      clampMargin: CLAMP_MARGIN_PX,
      onPositionChange: (pos) => setPosition(pos),
      // Delayed activation: short clicks pass through, long press/move activates drag
      clickThresholdMs: 200,
      moveThresholdPx: 5,
    }),
  );

  // Apply initial position (if provided)
  if (floatingPosition !== null) {
    setPosition(floatingPosition);
  } else {
    syncFloatingPositionStyles();
  }

  // ==========================================================================
  // Timer Management
  // ==========================================================================

  function clearResetTimer(): void {
    if (resetTimer !== null) {
      window.clearTimeout(resetTimer);
      resetTimer = null;
    }
  }
  disposer.add(clearResetTimer);

  // ==========================================================================
  // Minimize State
  // ==========================================================================

  /**
   * Toggle minimized (collapsed) state of toolbar
   * Design: toolbar collapses in-place from pill (580x44) to circle (44x44)
   */
  function setMinimized(value: boolean): void {
    const wasMinimized = minimized;
    minimized = value;
    root.dataset.minimized = minimized ? 'true' : 'false';

    // Close dropdown before collapsing
    if (minimized) {
      setStructureOpen(false);
    }

    // Re-clamp position on expand to prevent toolbar from overflowing viewport
    // (user may have dragged collapsed toolbar to edge, expand would cause overflow)
    if (wasMinimized && !minimized && floatingPosition) {
      // Immediate clamp for reduced-motion users (no transition)
      setPosition(floatingPosition);

      // For normal motion, clamp again after transition ends (when size is final)
      // Use { once: true } to auto-remove listener and prevent leaks
      root.addEventListener(
        'transitionend',
        (event: TransitionEvent) => {
          if (event.target !== root) return;
          if (event.propertyName !== 'width' && event.propertyName !== 'height') return;
          if (!minimized && floatingPosition) {
            setPosition(floatingPosition);
          }
        },
        { once: true },
      );
    }

    // Update grip button label and tooltip (icon rotates via CSS)
    dragHandle.setAttribute('aria-label', minimized ? 'Expand toolbar' : 'Collapse toolbar');
    dragHandle.dataset.tooltip = minimized ? 'Expand' : 'Collapse';
  }

  // ==========================================================================
  // Render Functions
  // ==========================================================================

  function renderCounts(): void {
    undoCountValue.textContent = String(undoCount);
    redoCountValue.textContent = String(redoCount);
  }

  function renderButtons(): void {
    undoBtn.disabled = applying || undoCount <= 0;
    redoBtn.disabled = applying || redoCount <= 0;

    // Check for apply block reason (e.g., move transaction not supported)
    const blockReason = options.getApplyBlockReason?.();
    const isBlocked = !!blockReason;

    applyBtn.disabled = applying || undoCount <= 0 || !options.onApply || isBlocked;
    applyBtn.textContent = applying ? 'Applying…' : 'Apply';
    applyBtn.title = isBlocked ? blockReason : '';

    // Update structure menu controls
    renderStructureControls();
  }

  function renderStatus(): void {
    const category = getStatusCategory(status);
    root.dataset.status = category;
    root.dataset.statusDetail = status;
    statusEl.textContent = status === 'idle' ? '' : statusMessage;
  }

  function scheduleStatusReset(): void {
    clearResetTimer();
    resetTimer = window.setTimeout(() => setStatus('idle'), STATUS_RESET_DELAY_MS);
  }

  // ==========================================================================
  // Public Methods
  // ==========================================================================

  function setHistory(nextUndo: number, nextRedo: number): void {
    undoCount = Math.max(0, Math.floor(nextUndo));
    redoCount = Math.max(0, Math.floor(nextRedo));
    renderCounts();
    renderButtons();
  }

  function setStatus(nextStatus: ToolbarStatus, message?: string): void {
    status = nextStatus;
    statusMessage = (message ?? '').trim();
    renderStatus();

    const category = getStatusCategory(status);
    if (category === 'success' || category === 'error') {
      scheduleStatusReset();
    } else {
      clearResetTimer();
    }
  }

  // ==========================================================================
  // Event Handlers
  // ==========================================================================

  async function handleApply(): Promise<void> {
    if (applyBtn.disabled) return;
    if (!options.onApply) return;

    applying = true;
    renderButtons();
    setStatus('applying', 'Sending…');

    try {
      const resultOrPromise = options.onApply();
      const result = isPromiseLike(resultOrPromise) ? await resultOrPromise : resultOrPromise;
      const applyResult = isApplyResult(result) ? result : undefined;
      setStatus('success', formatStatusMessage('Sent', applyResult));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setStatus('error', msg || 'Failed');
    } finally {
      applying = false;
      renderButtons();
    }
  }

  // Apply button
  disposer.listen(applyBtn, 'click', (event) => {
    event.preventDefault();
    void handleApply();
  });

  // Grip click toggles collapsed state (drag uses delayed activation, so short clicks pass through)
  disposer.listen(dragHandle, 'click', (event) => {
    event.preventDefault();
    setMinimized(!minimized);
  });

  // Structure button - toggle dropdown
  disposer.listen(structureBtn, 'click', (event) => {
    event.preventDefault();
    if (structureBtn.disabled) return;
    setStructureOpen(!structureOpen);
  });

  // Structure menu items
  for (const item of structureItems) {
    disposer.listen(item.el, 'click', (event) => {
      event.preventDefault();
      if (item.el.disabled) return;
      if (!options.onStructure) return;

      options.onStructure(buildStructureData(item.action));
      setStructureOpen(false);
    });
  }

  // Close structure menu on outside click
  disposer.listen(
    window,
    'pointerdown',
    (event: PointerEvent) => {
      if (!structureOpen) return;

      // Check if click is inside the structure wrapper
      try {
        if (typeof event.composedPath === 'function') {
          const inside = event.composedPath().some((n) => n === structureWrap);
          if (inside) return;
        }
      } catch {
        // fallback
      }

      const target = event.target;
      if (target instanceof Node && structureWrap.contains(target)) return;

      setStructureOpen(false);
    },
    { capture: true },
  );

  // Close structure menu on Escape
  disposer.listen(
    window,
    'keydown',
    (event: KeyboardEvent) => {
      if (!structureOpen) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setStructureOpen(false);
    },
    { capture: true },
  );

  // Undo button
  disposer.listen(undoBtn, 'click', (event) => {
    event.preventDefault();
    if (undoBtn.disabled) return;
    options.onUndo?.();
  });

  // Redo button
  disposer.listen(redoBtn, 'click', (event) => {
    event.preventDefault();
    if (redoBtn.disabled) return;
    options.onRedo?.();
  });

  // Close button
  disposer.listen(closeBtn, 'click', (event) => {
    event.preventDefault();
    options.onRequestClose?.();
  });

  // ==========================================================================
  // Selection Polling (Phase 5.5)
  // ==========================================================================
  // Poll selection changes to keep Structure enable/disable state in sync.
  // Selection is owned by the editor core; polling avoids expanding the
  // toolbar public API while keeping UI state accurate.

  const SELECTION_POLL_INTERVAL_MS = 140;
  let lastSelection: Element | null = null;
  let selectionPollTimer: number | null = null;

  function scheduleSelectionPoll(): void {
    if (disposer.isDisposed) return;
    selectionPollTimer = window.setTimeout(() => {
      selectionPollTimer = null;
      const current = getSelectedElement();
      if (current !== lastSelection) {
        lastSelection = current;
        setStructureOpen(false);
        renderButtons();
      }
      scheduleSelectionPoll();
    }, SELECTION_POLL_INTERVAL_MS);
  }

  if (options.getSelectedElement) {
    lastSelection = getSelectedElement();
    scheduleSelectionPoll();
    disposer.add(() => {
      if (selectionPollTimer !== null) {
        window.clearTimeout(selectionPollTimer);
        selectionPollTimer = null;
      }
    });
  }

  // Initial render
  renderCounts();
  renderButtons();
  renderStatus();

  // ==========================================================================
  // Return API
  // ==========================================================================

  return {
    setHistory,
    setStatus,
    getPosition,
    setPosition,
    dispose: () => disposer.dispose(),
  };
}
