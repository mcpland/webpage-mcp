/**
 * Spacing Control (Phase 3.6)
 *
 * Grid-based editor for inline padding and margin.
 *
 * Design ref: attr-ui.html:292-370
 *
 * Features:
 * - Separate Padding and Margin sections with 2x2 grid layout
 * - Direction-indicating SVG icons as input prefixes
 * - Dynamic unit suffix display
 * - Shows real values (inline if set, otherwise computed)
 * - ArrowUp/ArrowDown keyboard stepping for numeric values
 * - Live preview via TransactionManager.beginStyle().set()
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
// Constants
// =============================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';

/** All spacing properties in section order */
const SPACING_PROPERTIES = [
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
] as const;

type SpacingProperty = (typeof SPACING_PROPERTIES)[number];

/** SVG path data for edge direction icons (design ref: attr-ui.html:308-368) */
const EDGE_ICON_PATHS: Record<SpacingProperty, string> = {
  // Padding icons: horizontal line with vertical segment pointing inward
  'padding-top': 'M2 4h11M7.5 4v3.5',
  'padding-right': 'M4 2v11M4 7.5h3.5',
  'padding-bottom': 'M2 11h11M7.5 11v-3.5',
  'padding-left': 'M11 2v11M11 7.5h-3.5',
  // Margin icons: line with segment pointing outward
  'margin-top': 'M2 4h11M7.5 4v-3',
  'margin-right': 'M11 2v11M11 7.5h3',
  'margin-bottom': 'M2 11h11M7.5 11v3',
  'margin-left': 'M4 2v11M4 7.5h-3',
};

// =============================================================================
// Types
// =============================================================================

interface FieldState {
  property: SpacingProperty;
  input: HTMLInputElement;
  container: InputContainer;
  handle: StyleTransactionHandle | null;
}

// =============================================================================
// Helpers
// =============================================================================

function formatAriaLabel(property: SpacingProperty): string {
  const [box, edge] = property.split('-') as [string, string];
  return `${box.charAt(0).toUpperCase()}${box.slice(1)} ${edge}`;
}

function isInputFocused(input: HTMLInputElement): boolean {
  try {
    const rootNode = input.getRootNode();
    if (rootNode instanceof ShadowRoot) {
      return rootNode.activeElement === input;
    }
    return document.activeElement === input;
  } catch {
    return false;
  }
}

function readInlineValue(element: Element, property: SpacingProperty): string {
  try {
    const style = (element as HTMLElement).style;
    if (!style || typeof style.getPropertyValue !== 'function') return '';
    return style.getPropertyValue(property).trim();
  } catch {
    return '';
  }
}

function readComputedValue(element: Element, property: SpacingProperty): string {
  try {
    return window.getComputedStyle(element).getPropertyValue(property).trim();
  } catch {
    return '';
  }
}

function createEdgeIcon(pathD: string): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 15 15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('stroke', 'currentColor');
  svg.append(path);

  return svg;
}

// =============================================================================
// Factory
// =============================================================================

export interface SpacingControlOptions {
  container: HTMLElement;
  transactionManager: TransactionManager;
}

export function createSpacingControl(options: SpacingControlOptions): DesignControl {
  const { container, transactionManager } = options;
  const disposer = new Disposer();

  let currentTarget: Element | null = null;

  // ---------------------------------------------------------------------------
  // Field Factory
  // ---------------------------------------------------------------------------

  function createField(property: SpacingProperty): FieldState {
    const inputContainer = createInputContainer({
      ariaLabel: formatAriaLabel(property),
      inputMode: 'decimal',
      prefix: createEdgeIcon(EDGE_ICON_PATHS[property]),
      suffix: 'px',
    });

    wireNumberStepping(disposer, inputContainer.input, { mode: 'css-length' });

    return {
      property,
      input: inputContainer.input,
      container: inputContainer,
      handle: null,
    };
  }

  // ---------------------------------------------------------------------------
  // Create Fields
  // ---------------------------------------------------------------------------

  const fields = Object.create(null) as Record<SpacingProperty, FieldState>;
  for (const property of SPACING_PROPERTIES) {
    fields[property] = createField(property);
  }

  // ---------------------------------------------------------------------------
  // Section Factory
  // ---------------------------------------------------------------------------

  function createSection(
    title: string,
    properties: readonly [SpacingProperty, SpacingProperty, SpacingProperty, SpacingProperty],
  ): HTMLDivElement {
    const section = document.createElement('div');
    section.className = 'we-spacing-section';

    // Header with title
    const header = document.createElement('div');
    header.className = 'we-spacing-header';
    header.textContent = title;
    section.append(header);

    // 2x2 Grid
    const grid = document.createElement('div');
    grid.className = 'we-spacing-grid';

    // Row 1: top, right
    grid.append(fields[properties[0]].container.root);
    grid.append(fields[properties[1]].container.root);
    // Row 2: bottom, left
    grid.append(fields[properties[2]].container.root);
    grid.append(fields[properties[3]].container.root);

    section.append(grid);
    return section;
  }

  // ---------------------------------------------------------------------------
  // DOM Structure
  // ---------------------------------------------------------------------------

  const root = document.createElement('div');
  root.className = 'we-field-group';

  root.append(
    createSection('Padding', ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']),
    createSection('Margin', ['margin-top', 'margin-right', 'margin-bottom', 'margin-left']),
  );

  container.append(root);
  disposer.add(() => root.remove());

  // ---------------------------------------------------------------------------
  // Transaction Management
  // ---------------------------------------------------------------------------

  function beginTransaction(property: SpacingProperty): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;
    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    const field = fields[property];
    if (field.handle) return field.handle;

    const handle = transactionManager.beginStyle(target, property);
    field.handle = handle;
    return handle;
  }

  function commitTransaction(property: SpacingProperty): void {
    const field = fields[property];
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackTransaction(property: SpacingProperty): void {
    const field = fields[property];
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.rollback();
  }

  function commitAllTransactions(): void {
    for (const prop of SPACING_PROPERTIES) {
      commitTransaction(prop);
    }
  }

  // ---------------------------------------------------------------------------
  // Field Synchronization
  // ---------------------------------------------------------------------------

  function syncField(property: SpacingProperty, force = false): void {
    const field = fields[property];
    const target = currentTarget;

    if (!target || !target.isConnected) {
      field.input.value = '';
      field.input.placeholder = '';
      field.input.disabled = true;
      field.container.setSuffix('px');
      return;
    }

    field.input.disabled = false;

    const isEditing = field.handle !== null || isInputFocused(field.input);
    if (isEditing && !force) return;

    const inlineValue = readInlineValue(target, property);
    const displayValue = inlineValue || readComputedValue(target, property);
    const formatted = formatLengthForDisplay(displayValue);
    field.input.value = formatted.value;
    field.input.placeholder = '';
    field.container.setSuffix(formatted.suffix);
  }

  function syncAllFields(): void {
    for (const prop of SPACING_PROPERTIES) {
      syncField(prop);
    }
  }

  // ---------------------------------------------------------------------------
  // Event Wiring
  // ---------------------------------------------------------------------------

  function wireField(property: SpacingProperty): void {
    const field = fields[property];
    const input = field.input;

    disposer.listen(input, 'input', () => {
      const handle = beginTransaction(property);
      if (!handle) return;
      // Combine input value with current suffix to preserve unit
      const suffix = field.container.getSuffixText();
      handle.set(combineLengthValue(input.value, suffix));
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

  for (const prop of SPACING_PROPERTIES) {
    wireField(prop);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

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
