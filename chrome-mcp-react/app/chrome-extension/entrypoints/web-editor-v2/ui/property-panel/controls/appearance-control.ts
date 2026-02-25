/**
 * Appearance Control
 *
 * Edits general appearance styles:
 * - overflow (select)
 * - box-sizing (select)
 * - opacity (input)
 *
 * Note: Border and Background controls have been split into separate controls
 * (border-control.ts and background-control.ts) for better organization.
 */

import { Disposer } from '../../../utils/disposables';
import type { StyleTransactionHandle, TransactionManager } from '../../../core/transaction-manager';
import { wireNumberStepping } from './number-stepping';
import type { DesignControl } from '../types';
import { createSliderInput, type SliderInput } from '../components/slider-input';

// =============================================================================
// Constants
// =============================================================================

const OVERFLOW_VALUES = ['visible', 'hidden', 'scroll', 'auto'] as const;
const BOX_SIZING_VALUES = ['content-box', 'border-box'] as const;

// =============================================================================
// Types
// =============================================================================

type AppearanceProperty = 'overflow' | 'box-sizing' | 'opacity';

interface OpacityFieldState {
  kind: 'opacity';
  property: 'opacity';
  control: SliderInput;
  handle: StyleTransactionHandle | null;
}

interface SelectFieldState {
  kind: 'select';
  property: Exclude<AppearanceProperty, 'opacity'>;
  element: HTMLSelectElement;
  handle: StyleTransactionHandle | null;
}

type FieldState = OpacityFieldState | SelectFieldState;

// =============================================================================
// Helpers
// =============================================================================

function isFieldFocused(el: HTMLElement): boolean {
  try {
    const rootNode = el.getRootNode();
    if (rootNode instanceof ShadowRoot) return rootNode.activeElement === el;
    return document.activeElement === el;
  } catch {
    return false;
  }
}

function normalizeOpacity(raw: string): string {
  return raw.trim();
}

/** Regex to match valid numeric values for opacity (including decimal) */
const OPACITY_NUMBER_REGEX = /^-?(?:(?:\d+\.\d+)|(?:\d+\.)|(?:\d+)|(?:\.\d+))$/;

/**
 * Clamp opacity value to valid range [0, 1]
 */
function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const clamped = Math.min(1, Math.max(0, value));
  // Handle negative zero
  return Object.is(clamped, -0) ? 0 : clamped;
}

/**
 * Parse a string to a numeric opacity value
 * Returns null if the string is not a valid number
 */
function parseOpacityNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!OPACITY_NUMBER_REGEX.test(trimmed)) return null;
  // Handle trailing decimal point (e.g., "0.")
  const normalized = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return value;
}

function readInlineValue(element: Element, property: string): string {
  try {
    const style = (element as HTMLElement).style;
    return style?.getPropertyValue?.(property)?.trim() ?? '';
  } catch {
    return '';
  }
}

function readComputedValue(element: Element, property: string): string {
  try {
    return window.getComputedStyle(element).getPropertyValue(property).trim();
  } catch {
    return '';
  }
}

// =============================================================================
// Factory
// =============================================================================

export interface AppearanceControlOptions {
  container: HTMLElement;
  transactionManager: TransactionManager;
}

export function createAppearanceControl(options: AppearanceControlOptions): DesignControl {
  const { container, transactionManager } = options;
  const disposer = new Disposer();

  let currentTarget: Element | null = null;

  const root = document.createElement('div');
  root.className = 'we-field-group';

  // ===========================================================================
  // DOM Helpers
  // ===========================================================================

  function createSelectRow(
    labelText: string,
    ariaLabel: string,
    values: readonly string[],
  ): { row: HTMLDivElement; select: HTMLSelectElement } {
    const row = document.createElement('div');
    row.className = 'we-field';
    const label = document.createElement('span');
    label.className = 'we-field-label';
    label.textContent = labelText;
    const select = document.createElement('select');
    select.className = 'we-select';
    select.setAttribute('aria-label', ariaLabel);
    for (const v of values) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      select.appendChild(opt);
    }
    row.append(label, select);
    return { row, select };
  }

  // ===========================================================================
  // Build DOM
  // ===========================================================================

  const { row: overflowRow, select: overflowSelect } = createSelectRow(
    'Overflow',
    'Overflow',
    OVERFLOW_VALUES,
  );
  const { row: boxSizingRow, select: boxSizingSelect } = createSelectRow(
    'Box Sizing',
    'Box Sizing',
    BOX_SIZING_VALUES,
  );

  // ---------------------------------------------------------------------------
  // Opacity row with slider + input
  // ---------------------------------------------------------------------------
  const opacityRow = document.createElement('div');
  opacityRow.className = 'we-field';

  const opacityLabel = document.createElement('span');
  opacityLabel.className = 'we-field-label';
  opacityLabel.textContent = 'Opacity';

  const opacityMount = document.createElement('div');
  opacityMount.className = 'we-field-content';

  opacityRow.append(opacityLabel, opacityMount);

  const opacityControl = createSliderInput({
    sliderAriaLabel: 'Opacity slider',
    inputAriaLabel: 'Opacity value',
    min: 0,
    max: 1,
    step: 0.01,
    inputMode: 'decimal',
    inputWidthPx: 72,
  });
  opacityMount.append(opacityControl.root);

  wireNumberStepping(disposer, opacityControl.input, {
    mode: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    shiftStep: 0.1,
    altStep: 0.001,
  });

  root.append(overflowRow, boxSizingRow, opacityRow);
  container.appendChild(root);
  disposer.add(() => root.remove());

  // ===========================================================================
  // Field State Map
  // ===========================================================================

  const fields: Record<AppearanceProperty, FieldState> = {
    overflow: { kind: 'select', property: 'overflow', element: overflowSelect, handle: null },
    'box-sizing': {
      kind: 'select',
      property: 'box-sizing',
      element: boxSizingSelect,
      handle: null,
    },
    opacity: { kind: 'opacity', property: 'opacity', control: opacityControl, handle: null },
  };

  const PROPS: readonly AppearanceProperty[] = ['overflow', 'box-sizing', 'opacity'];

  // ===========================================================================
  // Transaction Management
  // ===========================================================================

  function beginTransaction(property: AppearanceProperty): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;
    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    const field = fields[property];
    if (field.handle) return field.handle;

    const handle = transactionManager.beginStyle(target, property);
    field.handle = handle;
    return handle;
  }

  function commitTransaction(property: AppearanceProperty): void {
    const field = fields[property];
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackTransaction(property: AppearanceProperty): void {
    const field = fields[property];
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.rollback();
  }

  function commitAllTransactions(): void {
    for (const p of PROPS) commitTransaction(p);
  }

  // ===========================================================================
  // Field Synchronization
  // ===========================================================================

  function syncField(property: AppearanceProperty, force = false): void {
    const field = fields[property];
    const target = currentTarget;

    if (field.kind === 'opacity') {
      const { slider, input } = field.control;

      if (!target || !target.isConnected) {
        field.control.setDisabled(true);
        slider.value = '0';
        input.value = '';
        input.placeholder = '';
        return;
      }

      field.control.setDisabled(false);

      const isEditing = field.handle !== null || isFieldFocused(slider) || isFieldFocused(input);
      if (isEditing && !force) return;

      const inlineValue = readInlineValue(target, property);
      const computedValue = readComputedValue(target, property);
      const displayValue = inlineValue || computedValue;

      input.value = displayValue;
      input.placeholder = '';

      const inlineNumeric = parseOpacityNumber(displayValue);
      const computedNumeric = parseOpacityNumber(computedValue);

      // If inline value is non-numeric (e.g., var(...)), keep the text input
      // but disable the slider (it cannot represent non-numeric values)
      if (inlineValue && inlineNumeric === null) {
        field.control.setSliderDisabled(true);
        if (computedNumeric !== null) {
          field.control.setSliderValue(clampOpacity(computedNumeric));
        }
        return;
      }

      const numeric = inlineNumeric ?? computedNumeric ?? 1;
      field.control.setSliderDisabled(false);
      field.control.setSliderValue(clampOpacity(numeric));
    } else {
      // Handle select field (overflow / box-sizing)
      const select = field.element;

      if (!target || !target.isConnected) {
        select.disabled = true;
        return;
      }

      select.disabled = false;

      const isEditing = field.handle !== null || isFieldFocused(select);
      if (isEditing && !force) return;

      const inline = readInlineValue(target, property);
      const computed = readComputedValue(target, property);
      const val = inline || computed;
      const hasOption = Array.from(select.options).some((o) => o.value === val);
      select.value = hasOption ? val : (select.options[0]?.value ?? '');
    }
  }

  function syncAllFields(): void {
    for (const p of PROPS) syncField(p);
  }

  // ===========================================================================
  // Event Wiring
  // ===========================================================================

  function wireOpacity(): void {
    const field = fields.opacity;
    if (field.kind !== 'opacity') return;

    const { slider, input } = field.control;

    /**
     * Commit opacity value with optional clamping for numeric values.
     * Non-numeric values (like CSS variables) are preserved as-is.
     */
    const commit = () => {
      // Normalize and clamp numeric values before committing
      const raw = normalizeOpacity(input.value);
      const numeric = parseOpacityNumber(raw);
      if (numeric !== null) {
        const clamped = clampOpacity(numeric);
        const clampedStr = String(clamped);
        // Update both input and style if value was clamped
        if (raw !== clampedStr) {
          input.value = clampedStr;
          const handle = field.handle;
          if (handle) handle.set(clampedStr);
        }
      }
      commitTransaction('opacity');
      syncAllFields();
    };

    // Slider events
    disposer.listen(slider, 'input', () => {
      if (slider.disabled) return;
      input.value = slider.value;
      const handle = beginTransaction('opacity');
      if (handle) handle.set(normalizeOpacity(slider.value));
    });

    disposer.listen(slider, 'change', commit);
    disposer.listen(slider, 'blur', commit);

    disposer.listen(slider, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTransaction('opacity');
        syncAllFields();
        slider.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rollbackTransaction('opacity');
        syncField('opacity', true);
      }
    });

    // Input events
    disposer.listen(input, 'input', () => {
      const raw = normalizeOpacity(input.value);
      const handle = beginTransaction('opacity');
      if (handle) handle.set(raw);

      const numeric = parseOpacityNumber(raw);
      if (numeric === null) {
        // Empty keeps slider enabled; non-numeric disables the slider
        field.control.setSliderDisabled(raw.length > 0);
        return;
      }

      field.control.setSliderDisabled(false);
      field.control.setSliderValue(clampOpacity(numeric));
    });

    disposer.listen(input, 'blur', commit);

    disposer.listen(input, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTransaction('opacity');
        syncAllFields();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rollbackTransaction('opacity');
        syncField('opacity', true);
      }
    });
  }

  function wireSelect(property: Exclude<AppearanceProperty, 'opacity'>): void {
    const field = fields[property];
    if (field.kind !== 'select') return;

    const select = field.element;

    const preview = () => {
      const handle = beginTransaction(property);
      if (handle) handle.set(select.value);
    };

    disposer.listen(select, 'input', preview);
    disposer.listen(select, 'change', preview);
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

  wireSelect('overflow');
  wireSelect('box-sizing');
  wireOpacity();

  // ===========================================================================
  // Public API
  // ===========================================================================

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;
    if (element !== currentTarget) commitAllTransactions();
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

  syncAllFields();

  return { setTarget, refresh, dispose };
}
