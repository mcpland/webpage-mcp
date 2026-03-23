/**
 * Element Picker Controller
 *
 * Creates and manages the Element Picker Panel UI, which displays:
 * - List of element requests from the AI
 * - Current selection status for each request
 * - Countdown timer
 * - Cancel/Confirm actions
 */

import { Disposer } from '@/entrypoints/web-editor/utils/disposables';
import {
  mountQuickPanelShadowHost,
  type QuickPanelShadowHostElements,
  type QuickPanelShadowHostManager,
} from '@/shared/quick-panel/ui';
import type { PickedElement } from 'webpage-mcp-shared';

// ============================================================
// Types
// ============================================================

export interface ElementPickerControllerOptions {
  /** Custom host element ID */
  hostId?: string;
  /** Custom z-index */
  zIndex?: number;
  /** Called when user clicks Cancel */
  onCancel?: () => void;
  /** Called when user clicks Confirm */
  onConfirm?: () => void;
  /** Called when user switches to a different request */
  onSetActiveRequest?: (requestId: string) => void;
  /** Called when user clears a selection */
  onClearSelection?: (requestId: string) => void;
}

export interface ElementPickerController {
  /** Show the panel with initial state */
  show: (state: ElementPickerUiState) => void;
  /** Update the panel state */
  update: (patch: ElementPickerUiPatch) => void;
  /** Hide and clean up the panel */
  hide: () => void;
  /** Check if the panel is currently visible */
  isVisible: () => boolean;
  /** Dispose and clean up all resources */
  dispose: () => void;
}

export interface ElementPickerUiRequest {
  id: string;
  name: string;
  description?: string;
}

export interface ElementPickerUiState {
  sessionId: string;
  requests: ElementPickerUiRequest[];
  activeRequestId: string | null;
  selections: Record<string, PickedElement | null>;
  deadlineTs: number;
  errorMessage: string | null;
}

export type ElementPickerUiPatch = Partial<Omit<ElementPickerUiState, 'sessionId'>> & {
  sessionId: string;
};

// ============================================================
// Constants
// ============================================================

const DEFAULT_HOST_ID = '__mcp_element_picker_host__';
const DEFAULT_Z_INDEX = 2147483647;

// ============================================================
// Styles (Quick Panel compatible)
// ============================================================

const ELEMENT_PICKER_STYLES = /* css */ `
  /* Overlay positioning - bottom-right corner */
  .ep-overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: flex-end;
    justify-content: flex-end;
    padding: 16px;
    pointer-events: none;
  }

  /* Panel sizing */
  .ep-panel {
    width: min(480px, calc(100vw - 32px));
    max-height: min(600px, calc(100vh - 32px));
    pointer-events: auto;
  }

  /* Countdown badge */
  .ep-countdown {
    font-family: var(--ac-font-code);
    font-size: 12px;
    color: var(--ac-text-muted);
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--qp-glass-divider);
    background: color-mix(in srgb, var(--qp-glass-input-bg) 80%, transparent);
    user-select: none;
    white-space: nowrap;
  }

  .ep-countdown--warning {
    color: var(--ac-warning);
    border-color: color-mix(in srgb, var(--ac-warning) 40%, var(--qp-glass-divider));
  }

  .ep-countdown--danger {
    color: var(--ac-danger);
    border-color: color-mix(in srgb, var(--ac-danger) 40%, var(--qp-glass-divider));
    animation: ep-pulse 1s ease-in-out infinite;
  }

  @keyframes ep-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  /* Hint text */
  .ep-hint {
    margin: 0 0 10px 0;
    font-size: 12px;
    color: var(--ac-text-muted);
  }

  /* Error banner */
  .ep-error {
    margin: 0 0 10px 0;
    padding: 8px 10px;
    border-radius: var(--ac-radius-card);
    border: 1px solid color-mix(in srgb, var(--ac-danger) 55%, var(--ac-border));
    background: color-mix(in srgb, var(--ac-danger) 10%, transparent);
    color: color-mix(in srgb, var(--ac-danger) 85%, var(--ac-text));
    font-size: 12px;
  }

  /* Request list */
  .ep-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* Request item card */
  .ep-item {
    border-radius: var(--ac-radius-card);
    border: var(--ac-border-width) solid var(--ac-border);
    box-shadow: var(--ac-shadow-card);
    background: var(--ac-surface);
    padding: 10px 12px;
    transition: border-color var(--ac-motion-fast), box-shadow var(--ac-motion-fast);
  }

  .ep-item--active {
    border-color: color-mix(in srgb, var(--ac-accent) 55%, var(--ac-border));
    box-shadow:
      0 0 0 2px color-mix(in srgb, var(--ac-accent-subtle) 65%, transparent),
      var(--ac-shadow-card);
  }

  /* Item header */
  .ep-item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .ep-item-title {
    min-width: 0;
    font-weight: 600;
    font-size: 13px;
    color: var(--ac-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Status badge */
  .ep-badge {
    flex: none;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--qp-glass-divider);
    color: var(--ac-text-muted);
    background: color-mix(in srgb, var(--ac-surface-muted) 65%, transparent);
    user-select: none;
  }

  .ep-badge--selected {
    border-color: color-mix(in srgb, var(--ac-success) 55%, var(--qp-glass-divider));
    color: color-mix(in srgb, var(--ac-success) 85%, var(--ac-text));
    background: color-mix(in srgb, var(--ac-success) 10%, transparent);
  }

  .ep-badge--picking {
    border-color: color-mix(in srgb, var(--ac-accent) 55%, var(--qp-glass-divider));
    color: var(--ac-accent);
    background: color-mix(in srgb, var(--ac-accent) 10%, transparent);
    animation: ep-pulse 1.5s ease-in-out infinite;
  }

  /* Description text */
  .ep-desc {
    margin-top: 6px;
    font-size: 12px;
    color: var(--ac-text-muted);
    white-space: pre-wrap;
  }

  /* Picked element info */
  .ep-picked {
    margin-top: 8px;
    font-size: 12px;
    color: var(--ac-text);
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px;
    border-radius: var(--ac-radius-inner);
    background: var(--ac-surface-muted);
  }

  .ep-picked-text {
    font-weight: 500;
    word-break: break-word;
  }

  .ep-picked-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 11px;
  }

  .ep-picked code {
    font-family: var(--ac-font-code);
    font-size: 10px;
    color: var(--ac-text-muted);
    padding: 2px 4px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.05);
    word-break: break-all;
  }

  /* Action buttons row */
  .ep-actions {
    margin-top: 8px;
    display: flex;
    gap: 8px;
  }

  /* Footer */
  .ep-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .ep-footer-left {
    font-size: 11px;
    color: var(--ac-text-muted);
  }

  .ep-footer-right {
    display: flex;
    gap: 8px;
  }
`;

// ============================================================
// Utility Functions
// ============================================================

function formatCountdown(deadlineTs: number): {
  text: string;
  level: 'normal' | 'warning' | 'danger';
} {
  const remainingMs = Math.max(0, deadlineTs - Date.now());
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const text = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  // Warning at 1 minute, danger at 30 seconds
  let level: 'normal' | 'warning' | 'danger' = 'normal';
  if (totalSeconds <= 30) {
    level = 'danger';
  } else if (totalSeconds <= 60) {
    level = 'warning';
  }

  return { text, level };
}

function truncate(text: string, max = 80): string {
  const t = String(text || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1))}...`;
}

// ============================================================
// Controller Factory
// ============================================================

export function createElementPickerController(
  options: ElementPickerControllerOptions = {},
): ElementPickerController {
  let disposed = false;

  let shadowHost: QuickPanelShadowHostManager | null = null;
  let elements: QuickPanelShadowHostElements | null = null;
  let disposer: Disposer | null = null;
  let state: ElementPickerUiState | null = null;

  // DOM refs
  let overlayEl: HTMLDivElement | null = null;
  let panelEl: HTMLDivElement | null = null;
  let countdownEl: HTMLSpanElement | null = null;
  let errorEl: HTMLDivElement | null = null;
  let listEl: HTMLDivElement | null = null;
  let confirmBtn: HTMLButtonElement | null = null;
  let cancelBtn: HTMLButtonElement | null = null;
  let progressEl: HTMLSpanElement | null = null;
  let timerId: ReturnType<typeof setInterval> | null = null;

  // Cached item elements for incremental updates
  interface ItemElements {
    container: HTMLDivElement;
    badge: HTMLDivElement;
    pickedContainer: HTMLDivElement | null;
    pickBtn: HTMLButtonElement;
    clearBtn: HTMLButtonElement;
  }
  const itemElementsMap = new Map<string, ItemElements>();

  const hostId = options.hostId ?? DEFAULT_HOST_ID;
  const zIndex = options.zIndex ?? DEFAULT_Z_INDEX;

  function ensureMounted(): void {
    if (shadowHost && elements) return;

    shadowHost = mountQuickPanelShadowHost({ hostId, zIndex });
    elements = shadowHost.getElements();
    if (!elements) throw new Error('Failed to mount Element Picker shadow host');

    const localDisposer = new Disposer();
    disposer = localDisposer;

    // Inject local styles
    const styleEl = document.createElement('style');
    styleEl.textContent = ELEMENT_PICKER_STYLES;
    elements.shadowRoot.append(styleEl);
    localDisposer.add(() => styleEl.remove());

    // Build UI structure
    overlayEl = document.createElement('div');
    overlayEl.className = 'ep-overlay';

    panelEl = document.createElement('div');
    panelEl.className = 'qp-panel qp-liquid-shimmer ep-panel';
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-modal', 'false');
    panelEl.setAttribute('aria-label', 'Element Picker');

    // Header
    const headerEl = document.createElement('div');
    headerEl.className = 'qp-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'qp-header-left';

    const brand = document.createElement('div');
    brand.className = 'qp-brand';
    brand.textContent = '\u{1F446}'; // Pointing up emoji

    const title = document.createElement('div');
    title.className = 'qp-title';

    const titleName = document.createElement('div');
    titleName.className = 'qp-title-name';
    titleName.textContent = 'Element Picker';

    const titleSub = document.createElement('div');
    titleSub.className = 'qp-title-sub';
    titleSub.textContent = 'Click on the requested elements';

    title.append(titleName, titleSub);
    headerLeft.append(brand, title);

    const headerRight = document.createElement('div');
    headerRight.className = 'qp-header-right';

    countdownEl = document.createElement('span');
    countdownEl.className = 'ep-countdown';
    countdownEl.textContent = '03:00';

    headerRight.append(countdownEl);
    headerEl.append(headerLeft, headerRight);

    // Content
    const contentEl = document.createElement('div');
    contentEl.className = 'qp-content ac-scroll';

    const hintEl = document.createElement('div');
    hintEl.className = 'ep-hint';
    hintEl.textContent = 'Click on each element the AI needs. Press Esc to cancel.';

    errorEl = document.createElement('div');
    errorEl.className = 'ep-error';
    errorEl.hidden = true;

    listEl = document.createElement('div');
    listEl.className = 'ep-list';

    contentEl.append(hintEl, errorEl, listEl);

    // Footer
    const footerEl = document.createElement('div');
    footerEl.className = 'qp-composer';

    const footerInner = document.createElement('div');
    footerInner.className = 'ep-footer';

    const footerLeft = document.createElement('div');
    footerLeft.className = 'ep-footer-left';

    progressEl = document.createElement('span');
    progressEl.textContent = '0/0 selected';
    footerLeft.append(progressEl);

    const footerRight = document.createElement('div');
    footerRight.className = 'ep-footer-right';

    cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'qp-btn ac-btn ac-focus-ring';
    cancelBtn.textContent = 'Cancel';

    confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'qp-btn ac-btn ac-focus-ring qp-btn--primary';
    confirmBtn.textContent = 'Confirm';

    footerRight.append(cancelBtn, confirmBtn);
    footerInner.append(footerLeft, footerRight);
    footerEl.append(footerInner);

    panelEl.append(headerEl, contentEl, footerEl);
    overlayEl.append(panelEl);
    elements.root.append(overlayEl);
    localDisposer.add(() => overlayEl?.remove());

    // Event listeners
    localDisposer.listen(cancelBtn, 'click', () => options.onCancel?.());
    localDisposer.listen(confirmBtn, 'click', () => options.onConfirm?.());

    // Esc key to cancel - use capture phase on shadowRoot to intercept before Quick Panel stops propagation
    const handleEscKey = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        options.onCancel?.();
      }
    };
    elements.shadowRoot.addEventListener('keydown', handleEscKey, { capture: true });
    localDisposer.add(() =>
      elements?.shadowRoot.removeEventListener('keydown', handleEscKey, { capture: true }),
    );
  }

  function clearTimer(): void {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
  }

  /**
   * Render only the countdown timer (called frequently by interval).
   */
  function renderCountdown(): void {
    if (!state || !countdownEl) return;
    const countdown = formatCountdown(state.deadlineTs);
    countdownEl.textContent = countdown.text;
    countdownEl.className = `ep-countdown${countdown.level !== 'normal' ? ` ep-countdown--${countdown.level}` : ''}`;
  }

  /**
   * Create a picked element info container.
   */
  function createPickedInfoEl(picked: PickedElement): HTMLDivElement {
    const pickedEl = document.createElement('div');
    pickedEl.className = 'ep-picked';

    if (picked.text) {
      const textEl = document.createElement('div');
      textEl.className = 'ep-picked-text';
      textEl.textContent = `"${truncate(picked.text, 80)}"`;
      pickedEl.append(textEl);
    }

    const metaEl = document.createElement('div');
    metaEl.className = 'ep-picked-meta';

    const tagCode = document.createElement('code');
    tagCode.textContent = picked.tagName || 'element';
    metaEl.append(tagCode);

    const refCode = document.createElement('code');
    refCode.textContent = `ref=${picked.ref}`;
    metaEl.append(refCode);

    if (picked.frameId > 0) {
      const frameCode = document.createElement('code');
      frameCode.textContent = `frame=${picked.frameId}`;
      metaEl.append(frameCode);
    }

    pickedEl.append(metaEl);

    const selectorEl = document.createElement('div');
    const selectorCode = document.createElement('code');
    selectorCode.textContent = truncate(picked.selector || '', 100);
    selectorEl.append(selectorCode);
    pickedEl.append(selectorEl);

    return pickedEl;
  }

  /**
   * Create a single request item element.
   */
  function createItemEl(req: ElementPickerUiRequest): ItemElements {
    const item = document.createElement('div');
    item.className = 'ep-item';
    item.dataset.requestId = req.id;

    // Header row
    const header = document.createElement('div');
    header.className = 'ep-item-header';

    const titleEl = document.createElement('div');
    titleEl.className = 'ep-item-title';
    titleEl.textContent = req.name;

    const badge = document.createElement('div');
    badge.className = 'ep-badge';
    badge.textContent = 'Pending';

    header.append(titleEl, badge);
    item.append(header);

    // Description (static, only added once)
    if (req.description) {
      const desc = document.createElement('div');
      desc.className = 'ep-desc';
      desc.textContent = req.description;
      item.append(desc);
    }

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'ep-actions';

    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'qp-btn ac-btn ac-focus-ring';
    pickBtn.textContent = 'Pick';
    pickBtn.addEventListener('click', () => options.onSetActiveRequest?.(req.id));

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'qp-btn ac-btn ac-focus-ring';
    clearBtn.textContent = 'Clear';
    clearBtn.disabled = true;
    clearBtn.addEventListener('click', () => options.onClearSelection?.(req.id));

    actions.append(pickBtn, clearBtn);
    item.append(actions);

    return { container: item, badge, pickedContainer: null, pickBtn, clearBtn };
  }

  /**
   * Update a single item's display state.
   */
  function updateItemEl(
    itemEls: ItemElements,
    req: ElementPickerUiRequest,
    picked: PickedElement | null,
    isActive: boolean,
  ): void {
    const { container, badge, pickBtn, clearBtn } = itemEls;

    // Update active state
    container.classList.toggle('ep-item--active', isActive);

    // Update badge
    if (picked) {
      badge.className = 'ep-badge ep-badge--selected';
      badge.textContent = 'Selected';
    } else if (isActive) {
      badge.className = 'ep-badge ep-badge--picking';
      badge.textContent = 'Picking...';
    } else {
      badge.className = 'ep-badge';
      badge.textContent = 'Pending';
    }

    // Update pick button
    pickBtn.textContent = isActive ? 'Picking...' : 'Pick';
    pickBtn.disabled = isActive;

    // Update clear button
    clearBtn.disabled = !picked;

    // Handle picked info container
    const actionsEl = container.querySelector('.ep-actions');
    if (picked) {
      if (!itemEls.pickedContainer) {
        // Create and insert picked info before actions
        const pickedEl = createPickedInfoEl(picked);
        actionsEl?.parentNode?.insertBefore(pickedEl, actionsEl);
        itemEls.pickedContainer = pickedEl;
      } else {
        // Update existing picked info
        const newPickedEl = createPickedInfoEl(picked);
        itemEls.pickedContainer.replaceWith(newPickedEl);
        itemEls.pickedContainer = newPickedEl;
      }
    } else if (itemEls.pickedContainer) {
      // Remove picked info
      itemEls.pickedContainer.remove();
      itemEls.pickedContainer = null;
    }
  }

  /**
   * Build the list initially or rebuild if requests changed.
   */
  function buildList(): void {
    if (!state || !listEl) return;

    // Clear existing items and cache
    listEl.innerHTML = '';
    itemElementsMap.clear();

    for (const req of state.requests) {
      const itemEls = createItemEl(req);
      itemElementsMap.set(req.id, itemEls);
      listEl.append(itemEls.container);
    }
  }

  /**
   * Full render - updates all dynamic parts.
   */
  function render(): void {
    if (!state || !listEl || !countdownEl || !confirmBtn || !errorEl || !progressEl) return;

    // Countdown (always update)
    renderCountdown();

    // Error banner
    const err = state.errorMessage ? state.errorMessage.trim() : '';
    if (err) {
      errorEl.hidden = false;
      errorEl.textContent = err;
    } else {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }

    // Rebuild list if requests changed (rare case)
    const needsRebuild =
      itemElementsMap.size !== state.requests.length ||
      state.requests.some((r) => !itemElementsMap.has(r.id));
    if (needsRebuild) {
      buildList();
    }

    // Count selected and update items
    let selectedCount = 0;
    for (const req of state.requests) {
      const picked = state.selections[req.id] || null;
      const isActive = state.activeRequestId === req.id;
      if (picked) selectedCount++;

      const itemEls = itemElementsMap.get(req.id);
      if (itemEls) {
        updateItemEl(itemEls, req, picked, isActive);
      }
    }

    // Progress text
    progressEl.textContent = `${selectedCount}/${state.requests.length} selected`;

    // Confirm button state
    const allSelected = selectedCount === state.requests.length;
    confirmBtn.disabled = !allSelected;
    confirmBtn.textContent = allSelected
      ? 'Confirm'
      : `Confirm (${selectedCount}/${state.requests.length})`;
  }

  function show(next: ElementPickerUiState): void {
    if (disposed) return;
    ensureMounted();

    state = next;
    render();

    clearTimer();
    // Timer only updates countdown, not the full list
    timerId = setInterval(() => {
      if (disposed || !state) return;
      renderCountdown();
    }, 250);
  }

  function update(patch: ElementPickerUiPatch): void {
    if (disposed) return;
    if (!state || state.sessionId !== patch.sessionId) {
      // If we don't have matching state yet, ignore update
      return;
    }

    state = {
      ...state,
      ...patch,
      sessionId: state.sessionId, // Keep stable
      requests: patch.requests ?? state.requests,
      activeRequestId: patch.activeRequestId ?? state.activeRequestId,
      selections: patch.selections ?? state.selections,
      deadlineTs: patch.deadlineTs ?? state.deadlineTs,
      errorMessage: patch.errorMessage ?? state.errorMessage,
    };
    render();
  }

  function hide(): void {
    clearTimer();
    state = null;
    itemElementsMap.clear();

    try {
      disposer?.dispose();
    } finally {
      disposer = null;
    }

    overlayEl = null;
    panelEl = null;
    countdownEl = null;
    errorEl = null;
    listEl = null;
    confirmBtn = null;
    cancelBtn = null;
    progressEl = null;

    try {
      shadowHost?.dispose();
    } finally {
      shadowHost = null;
      elements = null;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    hide();
  }

  return {
    show,
    update,
    hide,
    isVisible: () => !!shadowHost && !!elements,
    dispose,
  };
}
