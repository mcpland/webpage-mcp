/**
 * Background Control
 *
 * Edits inline background styles:
 * - type selector (solid/gradient/image)
 * - solid: background-color picker
 * - gradient: gradient editor (reuses gradient-control.ts)
 * - image: background-image URL input
 */

import { Disposer } from '../../../utils/disposables';
import type { StyleTransactionHandle, TransactionManager } from '../../../core/transaction-manager';
import type { DesignTokensService } from '../../../core/design-tokens';
import { createColorField, type ColorField } from './color-field';
import { createGradientControl } from './gradient-control';
import type { DesignControl } from '../types';

// =============================================================================
// Constants
// =============================================================================

const BACKGROUND_TYPE_VALUES = ['solid', 'gradient', 'image'] as const;
type BackgroundType = (typeof BACKGROUND_TYPE_VALUES)[number];

// =============================================================================
// Types
// =============================================================================

type BackgroundProperty = 'background-color' | 'background-image';

interface TextFieldState {
  kind: 'text';
  property: BackgroundProperty;
  element: HTMLInputElement;
  handle: StyleTransactionHandle | null;
}

interface ColorFieldState {
  kind: 'color';
  property: BackgroundProperty;
  field: ColorField;
  handle: StyleTransactionHandle | null;
}

type FieldState = TextFieldState | ColorFieldState;

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

function inferBackgroundType(bgImage: string): BackgroundType {
  const trimmed = bgImage.trim().toLowerCase();
  if (!trimmed || trimmed === 'none') return 'solid';
  if (/\b(?:linear|radial|conic)-gradient\s*\(/i.test(trimmed)) return 'gradient';
  if (/\burl\s*\(/i.test(trimmed)) return 'image';
  return 'solid';
}

function extractUrlFromBackgroundImage(raw: string): string {
  const match = raw.trim().match(/\burl\(\s*(['"]?)(.*?)\1\s*\)/i);
  return match?.[2]?.trim() ?? '';
}

function normalizeBackgroundImageUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^none$/i.test(trimmed)) return 'none';
  if (/^url\s*\(/i.test(trimmed)) return trimmed;
  const escaped = trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `url("${escaped}")`;
}

// =============================================================================
// Factory
// =============================================================================

export interface BackgroundControlOptions {
  container: HTMLElement;
  transactionManager: TransactionManager;
  tokensService?: DesignTokensService;
}

export function createBackgroundControl(options: BackgroundControlOptions): DesignControl {
  const { container, transactionManager, tokensService } = options;
  const disposer = new Disposer();

  let currentTarget: Element | null = null;
  let currentBackgroundType: BackgroundType = 'solid';

  const root = document.createElement('div');
  root.className = 'we-field-group';

  // ===========================================================================
  // DOM Helpers
  // ===========================================================================

  function createInputRow(
    labelText: string,
    ariaLabel: string,
  ): { row: HTMLDivElement; input: HTMLInputElement } {
    const row = document.createElement('div');
    row.className = 'we-field';
    const label = document.createElement('span');
    label.className = 'we-field-label';
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'we-input';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', ariaLabel);
    row.append(label, input);
    return { row, input };
  }

  function createColorRow(labelText: string): {
    row: HTMLDivElement;
    colorFieldContainer: HTMLDivElement;
  } {
    const row = document.createElement('div');
    row.className = 'we-field';
    const label = document.createElement('span');
    label.className = 'we-field-label';
    label.textContent = labelText;
    const colorFieldContainer = document.createElement('div');
    colorFieldContainer.style.flex = '1';
    colorFieldContainer.style.minWidth = '0';
    row.append(label, colorFieldContainer);
    return { row, colorFieldContainer };
  }

  // ===========================================================================
  // Build DOM
  // ===========================================================================

  // Type selector
  const bgTypeRow = document.createElement('div');
  bgTypeRow.className = 'we-field';
  const bgTypeLabel = document.createElement('span');
  bgTypeLabel.className = 'we-field-label';
  bgTypeLabel.textContent = 'Type';
  const bgTypeSelect = document.createElement('select');
  bgTypeSelect.className = 'we-select';
  bgTypeSelect.setAttribute('aria-label', 'Background Type');
  for (const v of BACKGROUND_TYPE_VALUES) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v.charAt(0).toUpperCase() + v.slice(1);
    bgTypeSelect.appendChild(opt);
  }
  bgTypeRow.append(bgTypeLabel, bgTypeSelect);

  // Solid color row
  const { row: bgColorRow, colorFieldContainer: bgColorContainer } = createColorRow('Color');

  // Gradient mount
  const bgGradientMount = document.createElement('div');

  // Image URL row
  const { row: bgImageRow, input: bgImageInput } = createInputRow('URL', 'Background Image URL');
  bgImageInput.placeholder = 'https://...';
  bgImageInput.spellcheck = false;

  root.append(bgTypeRow, bgColorRow, bgGradientMount, bgImageRow);
  container.appendChild(root);
  disposer.add(() => root.remove());

  // ===========================================================================
  // Gradient Control
  // ===========================================================================

  const gradientControl = createGradientControl({
    container: bgGradientMount,
    transactionManager,
    tokensService,
  });
  disposer.add(() => gradientControl.dispose());

  // ===========================================================================
  // Color Field
  // ===========================================================================

  const bgColorField = createColorField({
    container: bgColorContainer,
    ariaLabel: 'Background Color',
    tokensService,
    getTokenTarget: () => currentTarget,
    onInput: (value) => {
      const handle = beginTransaction('background-color');
      if (handle) handle.set(value);
    },
    onCommit: () => {
      commitTransaction('background-color');
      syncAllFields();
    },
    onCancel: () => {
      rollbackTransaction('background-color');
      syncField('background-color', true);
    },
  });
  disposer.add(() => bgColorField.dispose());

  // ===========================================================================
  // Field State Map
  // ===========================================================================

  const fields: Record<BackgroundProperty, FieldState> = {
    'background-color': {
      kind: 'color',
      property: 'background-color',
      field: bgColorField,
      handle: null,
    },
    'background-image': {
      kind: 'text',
      property: 'background-image',
      element: bgImageInput,
      handle: null,
    },
  };

  const PROPS: readonly BackgroundProperty[] = ['background-color', 'background-image'];

  // ===========================================================================
  // Transaction Management
  // ===========================================================================

  function beginTransaction(property: BackgroundProperty): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;
    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    const field = fields[property];
    if (field.handle) return field.handle;

    const handle = transactionManager.beginStyle(target, property);
    field.handle = handle;
    return handle;
  }

  function commitTransaction(property: BackgroundProperty): void {
    const field = fields[property];
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackTransaction(property: BackgroundProperty): void {
    const field = fields[property];
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.rollback();
  }

  function commitAllTransactions(): void {
    for (const p of PROPS) commitTransaction(p);
  }

  // ===========================================================================
  // Background Type Visibility
  // ===========================================================================

  function updateBackgroundVisibility(): void {
    bgColorRow.hidden = currentBackgroundType !== 'solid';
    bgGradientMount.hidden = currentBackgroundType !== 'gradient';
    bgImageRow.hidden = currentBackgroundType !== 'image';
  }

  function setBackgroundType(type: BackgroundType): void {
    const target = currentTarget;
    currentBackgroundType = type;
    bgTypeSelect.value = type;
    updateBackgroundVisibility();

    if (!target || !target.isConnected) return;

    // Clear conflicting background-image when switching to solid
    if (type === 'solid') {
      commitTransaction('background-image');
      const handle = transactionManager.beginStyle(target, 'background-image');
      if (handle) {
        handle.set('none');
        handle.commit({ merge: true });
      }
    }
  }

  disposer.listen(bgTypeSelect, 'change', () => {
    const type = bgTypeSelect.value as BackgroundType;
    setBackgroundType(type);
    gradientControl.refresh();
    syncAllFields();
  });

  // ===========================================================================
  // Field Synchronization
  // ===========================================================================

  function syncField(property: BackgroundProperty, force = false): void {
    const field = fields[property];
    const target = currentTarget;

    if (field.kind === 'text') {
      const input = field.element;

      if (!target || !target.isConnected) {
        input.disabled = true;
        input.value = '';
        input.placeholder = '';
        return;
      }

      input.disabled = false;

      const isEditing = field.handle !== null || isFieldFocused(input);
      if (isEditing && !force) return;

      const inlineValue = readInlineValue(target, property);
      const computedValue = readComputedValue(target, property);
      const displayValue = inlineValue || computedValue;

      if (property === 'background-image') {
        input.value = extractUrlFromBackgroundImage(displayValue);
      } else {
        input.value = displayValue;
      }
      input.placeholder = '';
    } else {
      const colorField = field.field;

      if (!target || !target.isConnected) {
        colorField.setDisabled(true);
        colorField.setValue('');
        colorField.setPlaceholder('');
        return;
      }

      colorField.setDisabled(false);

      const isEditing = field.handle !== null || colorField.isFocused();
      if (isEditing && !force) return;

      const inlineValue = readInlineValue(target, property);
      const computedValue = readComputedValue(target, property);
      if (inlineValue) {
        colorField.setValue(inlineValue);
        colorField.setPlaceholder(/\bvar\s*\(/i.test(inlineValue) ? computedValue : '');
      } else {
        colorField.setValue(computedValue);
        colorField.setPlaceholder('');
      }
    }
  }

  function syncAllFields(): void {
    for (const p of PROPS) syncField(p);
    const hasTarget = Boolean(currentTarget && currentTarget.isConnected);
    bgTypeSelect.disabled = !hasTarget;
    updateBackgroundVisibility();
  }

  // ===========================================================================
  // Event Wiring
  // ===========================================================================

  function wireTextInput(property: BackgroundProperty): void {
    const field = fields[property];
    if (field.kind !== 'text') return;

    const input = field.element;
    const normalize =
      property === 'background-image' ? normalizeBackgroundImageUrl : (v: string) => v.trim();

    disposer.listen(input, 'input', () => {
      const handle = beginTransaction(property);
      if (handle) handle.set(normalize(input.value));
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

  wireTextInput('background-image');

  // ===========================================================================
  // Public API
  // ===========================================================================

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;
    if (element !== currentTarget) commitAllTransactions();
    currentTarget = element;

    if (element && element.isConnected) {
      const bgImage =
        readInlineValue(element, 'background-image') ||
        readComputedValue(element, 'background-image');
      currentBackgroundType = inferBackgroundType(bgImage);
      bgTypeSelect.value = currentBackgroundType;
    } else {
      currentBackgroundType = 'solid';
      bgTypeSelect.value = 'solid';
    }

    gradientControl.setTarget(element);
    updateBackgroundVisibility();
    syncAllFields();
  }

  function refresh(): void {
    if (disposer.isDisposed) return;
    gradientControl.refresh();
    syncAllFields();
  }

  function dispose(): void {
    commitAllTransactions();
    currentTarget = null;
    disposer.dispose();
  }

  updateBackgroundVisibility();
  syncAllFields();

  return { setTarget, refresh, dispose };
}
