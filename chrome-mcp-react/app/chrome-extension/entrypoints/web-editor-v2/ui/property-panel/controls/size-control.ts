/**
 * Size Control (Phase 3.5 + Mode Selection)
 *
 * Design control for editing inline width and height styles with mode selection.
 *
 * Features:
 * - Mode selection: Fixed (custom value), Fit (fit-content/auto), Fill (100%)
 * - Live preview via TransactionManager.beginStyle().set()
 * - Shows real values (inline if set, otherwise computed)
 * - ArrowUp/ArrowDown keyboard stepping for numeric values
 * - Blur commits, Enter commits + blurs, ESC rollbacks
 * - Pure numbers default to px
 * - Empty value clears inline style
 */

import { Disposer } from '../../../utils/disposables';
import type { StyleTransactionHandle, TransactionManager } from '../../../core/transaction-manager';
import type { DesignControl } from '../types';
import { createInputContainer, type InputContainer } from '../components/input-container';
import { combineLengthValue, formatLengthForDisplay } from './css-helpers';
import { wireNumberStepping } from './number-stepping';

// =============================================================================
// Types
// =============================================================================

type SizeProperty = 'width' | 'height';

/** Size mode determines how dimension value is calculated */
type SizeMode = 'fixed' | 'fit' | 'fill';

interface SizeModeOption {
  value: SizeMode;
  label: string;
}

interface FieldState {
  property: SizeProperty;
  column: HTMLElement;
  modeSelect: HTMLSelectElement;
  input: HTMLInputElement;
  container: InputContainer;
  /** Cached fixed value for mode switching (per-target, cleared on target change) */
  lastFixedValue: string;
  handle: StyleTransactionHandle | null;
}

// =============================================================================
// Constants
// =============================================================================

const SIZE_MODE_OPTIONS: readonly SizeModeOption[] = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'fit', label: 'Fit' },
  { value: 'fill', label: 'Fill' },
] as const;

/** Keywords that indicate fit mode */
const FIT_KEYWORDS = ['auto', 'fit-content', 'max-content', 'min-content'] as const;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check if element is focused in Shadow DOM context
 */
function isElementFocused(el: HTMLElement): boolean {
  try {
    const rootNode = el.getRootNode();
    if (rootNode instanceof ShadowRoot) return rootNode.activeElement === el;
    return document.activeElement === el;
  } catch {
    return false;
  }
}

/**
 * Read inline style property value from element
 */
function readInlineValue(element: Element, property: SizeProperty): string {
  try {
    const style = (element as HTMLElement).style;
    if (!style || typeof style.getPropertyValue !== 'function') return '';
    return style.getPropertyValue(property).trim();
  } catch {
    return '';
  }
}

/**
 * Read computed style property value from element
 */
function readComputedValue(element: Element, property: SizeProperty): string {
  try {
    const computed = window.getComputedStyle(element);
    return computed.getPropertyValue(property).trim();
  } catch {
    return '';
  }
}

/**
 * Get bounding rect dimension as px string
 * Preserves 2 decimal places for sub-pixel accuracy
 */
function getBoundingRectPx(element: Element, property: SizeProperty): string {
  try {
    const rect = element.getBoundingClientRect();
    const value = property === 'width' ? rect.width : rect.height;
    if (!Number.isFinite(value)) return '0px';
    // Round to 2 decimal places for sub-pixel layouts
    const rounded = Math.round(value * 100) / 100;
    return `${rounded}px`;
  } catch {
    return '0px';
  }
}

/**
 * Infer size mode from CSS value
 *
 * Priority:
 * - '100%' -> fill
 * - fit keywords (auto, fit-content, etc.) -> fit
 * - Everything else (px, %, calc, var, etc.) -> fixed
 */
function inferSizeMode(value: string): SizeMode {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return 'fixed';

  // Fill: exactly 100%
  if (trimmed === '100%') return 'fill';

  // Fit: various content-sizing keywords
  for (const keyword of FIT_KEYWORDS) {
    if (trimmed === keyword || trimmed.startsWith(`${keyword}(`)) {
      return 'fit';
    }
  }

  // Everything else is fixed (including other percentages, calc, var, etc.)
  return 'fixed';
}

/**
 * Get the CSS value for fit mode
 * If the current value is already a fit keyword, preserve it.
 * Otherwise uses fit-content if supported, or falls back to auto.
 */
function getFitValue(property: SizeProperty, currentValue: string): string {
  const trimmed = currentValue.trim().toLowerCase();

  // If already a fit keyword, preserve it
  for (const keyword of FIT_KEYWORDS) {
    if (trimmed === keyword || trimmed.startsWith(`${keyword}(`)) {
      return currentValue.trim(); // Preserve original casing
    }
  }

  // Default fit value
  try {
    if (typeof CSS !== 'undefined' && CSS.supports?.(property, 'fit-content')) {
      return 'fit-content';
    }
  } catch {
    // Ignore
  }
  return 'auto';
}

/**
 * Create mode select element
 */
function createModeSelect(ariaLabel: string): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'we-select we-size-mode-select';
  select.setAttribute('aria-label', ariaLabel);

  for (const { value, label } of SIZE_MODE_OPTIONS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  }

  return select;
}

// =============================================================================
// Factory
// =============================================================================

export interface SizeControlOptions {
  /** Container element to mount the control */
  container: HTMLElement;
  /** TransactionManager for style editing with undo/redo */
  transactionManager: TransactionManager;
}

/**
 * Create a Size control for editing width/height with mode selection
 */
export function createSizeControl(options: SizeControlOptions): DesignControl {
  const { container, transactionManager } = options;
  const disposer = new Disposer();

  // State
  let currentTarget: Element | null = null;

  // ==========================================================================
  // DOM Structure
  // ==========================================================================

  const root = document.createElement('div');
  root.className = 'we-field-group';

  /**
   * Create a size field column with mode select and input
   */
  function createSizeField(property: SizeProperty, prefix: string): FieldState {
    const column = document.createElement('div');
    column.className = 'we-size-field';

    // Mode select
    const modeSelect = createModeSelect(`${property} mode`);

    // Input container
    const inputContainer = createInputContainer({
      ariaLabel: property.charAt(0).toUpperCase() + property.slice(1),
      inputMode: 'decimal',
      prefix,
      suffix: 'px',
    });

    // Wire keyboard stepping
    wireNumberStepping(disposer, inputContainer.input, { mode: 'css-length' });

    column.append(modeSelect, inputContainer.root);

    return {
      property,
      column,
      modeSelect,
      input: inputContainer.input,
      container: inputContainer,
      lastFixedValue: '',
      handle: null,
    };
  }

  // Create width and height fields
  const widthField = createSizeField('width', 'W');
  const heightField = createSizeField('height', 'H');

  // Row layout
  const row = document.createElement('div');
  row.className = 'we-field-row';
  row.append(widthField.column, heightField.column);

  root.append(row);
  container.append(root);
  disposer.add(() => root.remove());

  // Field map for iteration
  const fields: Record<SizeProperty, FieldState> = {
    width: widthField,
    height: heightField,
  };

  // ==========================================================================
  // Transaction Management
  // ==========================================================================

  function beginTransaction(property: SizeProperty): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;
    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    const field = fields[property];
    if (field.handle) return field.handle;

    const handle = transactionManager.beginStyle(target, property);
    field.handle = handle;
    return handle;
  }

  function commitTransaction(property: SizeProperty): void {
    const field = fields[property];
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackTransaction(property: SizeProperty): void {
    const field = fields[property];
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.rollback();
  }

  function commitAllTransactions(): void {
    commitTransaction('width');
    commitTransaction('height');
  }

  // ==========================================================================
  // Visibility Control
  // ==========================================================================

  /**
   * Update input visibility based on mode
   * Input is only visible in fixed mode
   */
  function updateInputVisibility(field: FieldState, mode: SizeMode): void {
    field.container.root.hidden = mode !== 'fixed';
  }

  // ==========================================================================
  // Sync / Render
  // ==========================================================================

  /**
   * Get fixed value for mode switching
   * Prioritizes: lastFixedValue > computed > bounding rect
   */
  function getFixedValueCandidate(field: FieldState, target: Element): string {
    // Try cached fixed value
    const cached = field.lastFixedValue.trim();
    if (cached && inferSizeMode(cached) === 'fixed') {
      return cached;
    }

    // Try computed value
    const computed = readComputedValue(target, field.property);
    if (computed && inferSizeMode(computed) === 'fixed') {
      return computed;
    }

    // Fallback to bounding rect
    return getBoundingRectPx(target, field.property);
  }

  /**
   * Sync a single field's display with element styles
   */
  function syncField(property: SizeProperty, force = false): void {
    const field = fields[property];
    const target = currentTarget;

    // Disabled state when no target
    if (!target || !target.isConnected) {
      field.modeSelect.value = 'fixed';
      field.modeSelect.disabled = true;
      updateInputVisibility(field, 'fixed');
      field.input.value = '';
      field.input.placeholder = '';
      field.input.disabled = true;
      field.container.setSuffix('px');
      return;
    }

    field.modeSelect.disabled = false;
    field.input.disabled = false;

    // Don't overwrite during active editing (unless forced)
    if (!force) {
      const isEditing =
        field.handle !== null ||
        isElementFocused(field.input) ||
        isElementFocused(field.modeSelect);
      if (isEditing) return;
    }

    // Get current value and infer mode
    const inlineValue = readInlineValue(target, property);
    const displayValue = inlineValue || readComputedValue(target, property);
    const mode = inferSizeMode(inlineValue || displayValue);

    // Update mode select and visibility
    field.modeSelect.value = mode;
    updateInputVisibility(field, mode);

    // Track fixed value for mode switching
    if (mode === 'fixed') {
      const candidate = inlineValue || displayValue;
      if (candidate && inferSizeMode(candidate) === 'fixed') {
        field.lastFixedValue = candidate;
      }
    }

    // Update input value (only relevant for fixed mode)
    if (mode === 'fixed') {
      const formatted = formatLengthForDisplay(displayValue);
      field.input.value = formatted.value;
      field.input.placeholder = '';
      field.container.setSuffix(formatted.suffix);
    }
  }

  function syncAllFields(): void {
    syncField('width');
    syncField('height');
  }

  // ==========================================================================
  // Event Handlers
  // ==========================================================================

  /**
   * Wire mode select event handlers
   */
  function wireModeSelect(property: SizeProperty): void {
    const field = fields[property];
    const select = field.modeSelect;

    const handleModeChange = () => {
      const target = currentTarget;
      if (!target || !target.isConnected) return;

      const mode = select.value as SizeMode;
      const previousMode = inferSizeMode(
        readInlineValue(target, property) || readComputedValue(target, property),
      );

      // Save current fixed value before switching away
      if (previousMode === 'fixed' && mode !== 'fixed') {
        const suffix = field.container.getSuffixText();
        const combined = combineLengthValue(field.input.value, suffix);
        if (combined) field.lastFixedValue = combined;
      }

      updateInputVisibility(field, mode);

      const handle = beginTransaction(property);
      if (!handle) return;

      switch (mode) {
        case 'fit': {
          const currentValue =
            readInlineValue(target, property) || readComputedValue(target, property);
          handle.set(getFitValue(property, currentValue));
          break;
        }
        case 'fill':
          handle.set('100%');
          break;
        case 'fixed': {
          // Restore fixed value
          const fixedValue = getFixedValueCandidate(field, target);
          field.lastFixedValue = fixedValue;
          handle.set(fixedValue);

          // Update input to show restored value
          const formatted = formatLengthForDisplay(fixedValue);
          field.input.value = formatted.value;
          field.container.setSuffix(formatted.suffix);
          break;
        }
      }
    };

    disposer.listen(select, 'input', handleModeChange);
    disposer.listen(select, 'change', handleModeChange);

    disposer.listen(select, 'blur', () => {
      commitTransaction(property);
      syncAllFields();
    });

    disposer.listen(select, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTransaction(property);
        syncAllFields();
        select.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rollbackTransaction(property);
        syncField(property, true);
      }
    });
  }

  /**
   * Wire input field event handlers
   */
  function wireInput(property: SizeProperty): void {
    const field = fields[property];
    const input = field.input;

    disposer.listen(input, 'input', () => {
      const handle = beginTransaction(property);
      if (!handle) return;

      const suffix = field.container.getSuffixText();
      const combined = combineLengthValue(input.value, suffix);
      handle.set(combined);
    });

    disposer.listen(input, 'blur', () => {
      commitTransaction(property);
      syncAllFields();
    });

    disposer.listen(input, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTransaction(property);
        syncAllFields();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rollbackTransaction(property);
        syncField(property, true);
      }
    });
  }

  // Wire all event handlers
  wireModeSelect('width');
  wireModeSelect('height');
  wireInput('width');
  wireInput('height');

  // ==========================================================================
  // Public API (DesignControl interface)
  // ==========================================================================

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;
    if (element !== currentTarget) {
      commitAllTransactions();
      // Clear cached fixed values when target changes to avoid cross-element pollution
      fields.width.lastFixedValue = '';
      fields.height.lastFixedValue = '';
    }
    currentTarget = element;
    syncAllFields();
  }

  function refresh(): void {
    if (disposer.isDisposed) return;
    syncAllFields();
  }

  function dispose(): void {
    commitAllTransactions();
    currentTarget = null;
    disposer.dispose();
  }

  // Initial state
  syncAllFields();

  return {
    setTarget,
    refresh,
    dispose,
  };
}
