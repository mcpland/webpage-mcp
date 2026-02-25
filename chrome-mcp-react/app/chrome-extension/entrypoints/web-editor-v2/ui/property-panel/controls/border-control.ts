/**
 * Border Control
 *
 * Edits inline border styles:
 * - edge selector (all/top/right/bottom/left)
 * - border-width (input)
 * - border-style (select: solid/dashed/dotted/none)
 * - border-color (color picker)
 * - border-radius (unified + per-corner editing)
 */

import { Disposer } from '../../../utils/disposables';
import type {
  MultiStyleTransactionHandle,
  StyleTransactionHandle,
  TransactionManager,
} from '../../../core/transaction-manager';
import type { DesignTokensService } from '../../../core/design-tokens';
import { createIconButtonGroup, type IconButtonGroup } from '../components/icon-button-group';
import { createInputContainer, type InputContainer } from '../components/input-container';
import { createColorField, type ColorField } from './color-field';
import { createGradientControl } from './gradient-control';
import { combineLengthValue, formatLengthForDisplay } from './css-helpers';
import { wireNumberStepping } from './number-stepping';
import type { DesignControl } from '../types';

// =============================================================================
// Constants
// =============================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';

const BORDER_STYLE_VALUES = ['solid', 'dashed', 'dotted', 'none'] as const;

/** Color type for border: solid uses border-color, gradient uses border-image-source */
const BORDER_COLOR_TYPE_VALUES = ['solid', 'gradient'] as const;
type BorderColorType = (typeof BORDER_COLOR_TYPE_VALUES)[number];

const BORDER_EDGE_VALUES = ['all', 'top', 'right', 'bottom', 'left'] as const;
type BorderEdge = (typeof BORDER_EDGE_VALUES)[number];

const BORDER_RADIUS_CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;
type BorderRadiusCorner = (typeof BORDER_RADIUS_CORNERS)[number];

const BORDER_RADIUS_CORNER_PROPERTIES: Record<BorderRadiusCorner, string> = {
  'top-left': 'border-top-left-radius',
  'top-right': 'border-top-right-radius',
  'bottom-right': 'border-bottom-right-radius',
  'bottom-left': 'border-bottom-left-radius',
};

const BORDER_RADIUS_TRANSACTION_PROPERTIES = [
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
] as const;

// =============================================================================
// Types
// =============================================================================

type BorderProperty = 'border-width' | 'border-style' | 'border-color' | 'border-radius';

interface TextFieldState {
  kind: 'text';
  property: BorderProperty;
  element: HTMLInputElement;
  handle: StyleTransactionHandle | null;
}

interface SelectFieldState {
  kind: 'select';
  property: BorderProperty;
  element: HTMLSelectElement;
  handle: StyleTransactionHandle | null;
}

interface ColorFieldState {
  kind: 'color';
  property: BorderProperty;
  field: ColorField;
  handle: StyleTransactionHandle | null;
}

interface BorderRadiusFieldState {
  kind: 'border-radius';
  property: 'border-radius';
  root: HTMLDivElement;
  unified: InputContainer;
  toggleButton: HTMLButtonElement;
  cornersGrid: HTMLDivElement;
  corners: Record<BorderRadiusCorner, InputContainer>;
  handle: MultiStyleTransactionHandle | null;
  expanded: boolean;
  mode: 'unified' | 'corners' | null;
  cornersMaterialized: boolean;
}

type FieldState = TextFieldState | SelectFieldState | ColorFieldState | BorderRadiusFieldState;

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

/**
 * Infer border color type from border-image-source value.
 * Returns 'gradient' if a gradient is detected, 'solid' otherwise.
 */
function inferBorderColorType(borderImageSource: string): BorderColorType {
  const trimmed = borderImageSource.trim().toLowerCase();
  if (!trimmed || trimmed === 'none') return 'solid';
  if (/\b(?:linear|radial|conic)-gradient\s*\(/i.test(trimmed)) return 'gradient';
  return 'solid';
}

function createBorderEdgeIcon(edge: BorderEdge): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 15 15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const outline = document.createElementNS(SVG_NS, 'rect');
  outline.setAttribute('x', '3.5');
  outline.setAttribute('y', '3.5');
  outline.setAttribute('width', '8');
  outline.setAttribute('height', '8');
  outline.setAttribute('stroke', 'currentColor');
  outline.setAttribute('stroke-width', '1');
  outline.setAttribute('opacity', '0.4');
  svg.appendChild(outline);

  const highlight = document.createElementNS(SVG_NS, 'path');
  highlight.setAttribute('stroke', 'currentColor');
  highlight.setAttribute('stroke-width', '2');
  highlight.setAttribute('stroke-linecap', 'round');

  switch (edge) {
    case 'all':
      highlight.setAttribute('d', 'M3.5 3.5h8v8h-8z');
      break;
    case 'top':
      highlight.setAttribute('d', 'M3.5 3.5h8');
      break;
    case 'right':
      highlight.setAttribute('d', 'M11.5 3.5v8');
      break;
    case 'bottom':
      highlight.setAttribute('d', 'M3.5 11.5h8');
      break;
    case 'left':
      highlight.setAttribute('d', 'M3.5 3.5v8');
      break;
  }

  svg.appendChild(highlight);
  return svg;
}

function createEditCornersIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 15 15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('d', 'M4 6V4H6 M9 4H11V6 M11 9V11H9 M6 11H4V9');
  svg.appendChild(path);

  return svg;
}

function createCornerIcon(corner: BorderRadiusCorner): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 15 15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');

  switch (corner) {
    case 'top-left':
      path.setAttribute('d', 'M11 4H6Q4 4 4 6V11');
      break;
    case 'top-right':
      path.setAttribute('d', 'M4 4H9Q11 4 11 6V11');
      break;
    case 'bottom-right':
      path.setAttribute('d', 'M11 4V9Q11 11 9 11H4');
      break;
    case 'bottom-left':
      path.setAttribute('d', 'M4 4V9Q4 11 6 11H11');
      break;
  }

  svg.appendChild(path);
  return svg;
}

// =============================================================================
// Factory
// =============================================================================

export interface BorderControlOptions {
  container: HTMLElement;
  transactionManager: TransactionManager;
  tokensService?: DesignTokensService;
}

export function createBorderControl(options: BorderControlOptions): DesignControl {
  const { container, transactionManager, tokensService } = options;
  const disposer = new Disposer();

  let currentTarget: Element | null = null;
  let currentBorderEdge: BorderEdge = 'all';
  let currentColorType: BorderColorType = 'solid';

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

  // Edge selector row
  const borderEdgeRow = document.createElement('div');
  borderEdgeRow.className = 'we-field';
  const borderEdgeLabel = document.createElement('span');
  borderEdgeLabel.className = 'we-field-label';
  borderEdgeLabel.textContent = 'Edge';
  const borderEdgeMount = document.createElement('div');
  borderEdgeMount.style.flex = '1';
  borderEdgeRow.append(borderEdgeLabel, borderEdgeMount);

  // Border Width with InputContainer
  const borderWidthRow = document.createElement('div');
  borderWidthRow.className = 'we-field';
  const borderWidthLabel = document.createElement('span');
  borderWidthLabel.className = 'we-field-label';
  borderWidthLabel.textContent = 'Width';
  const borderWidthContainer = createInputContainer({
    ariaLabel: 'Border Width',
    inputMode: 'decimal',
    prefix: null,
    suffix: 'px',
  });
  borderWidthRow.append(borderWidthLabel, borderWidthContainer.root);
  const borderWidthInput = borderWidthContainer.input;

  const { row: borderStyleRow, select: borderStyleSelect } = createSelectRow(
    'Style',
    'Border Style',
    BORDER_STYLE_VALUES,
  );

  // Color Type selector (solid/gradient)
  const { row: colorTypeRow, select: colorTypeSelect } = createSelectRow(
    'Type',
    'Border Color Type',
    BORDER_COLOR_TYPE_VALUES,
  );

  // Solid color row
  const { row: borderColorRow, colorFieldContainer: borderColorContainer } =
    createColorRow('Color');

  // Gradient mount for border-image-source
  const borderGradientMount = document.createElement('div');

  // Border Radius (unified + per-corner editing)
  const borderRadiusRow = document.createElement('div');
  borderRadiusRow.className = 'we-field';

  const borderRadiusLabel = document.createElement('span');
  borderRadiusLabel.className = 'we-field-label';
  borderRadiusLabel.textContent = 'Radius';

  const borderRadiusControl = document.createElement('div');
  borderRadiusControl.className = 'we-radius-control';

  const borderRadiusUnifiedRow = document.createElement('div');
  borderRadiusUnifiedRow.className = 'we-field-row';

  const borderRadiusUnified = createInputContainer({
    ariaLabel: 'Border Radius',
    inputMode: 'decimal',
    prefix: null,
    suffix: 'px',
  });
  borderRadiusUnified.root.style.flex = '1';

  const borderRadiusToggleButton = document.createElement('button');
  borderRadiusToggleButton.type = 'button';
  borderRadiusToggleButton.className = 'we-toggle-btn';
  borderRadiusToggleButton.setAttribute('aria-label', 'Edit corners');
  borderRadiusToggleButton.setAttribute('aria-pressed', 'false');
  borderRadiusToggleButton.dataset.tooltip = 'Edit corners';
  borderRadiusToggleButton.append(createEditCornersIcon());

  borderRadiusUnifiedRow.append(borderRadiusUnified.root, borderRadiusToggleButton);

  const borderRadiusCornersGrid = document.createElement('div');
  borderRadiusCornersGrid.className = 'we-radius-corners-grid';
  borderRadiusCornersGrid.hidden = true;

  const borderRadiusCorners: Record<BorderRadiusCorner, InputContainer> = {
    'top-left': createInputContainer({
      ariaLabel: 'Top-left radius',
      inputMode: 'decimal',
      prefix: createCornerIcon('top-left'),
      suffix: 'px',
    }),
    'top-right': createInputContainer({
      ariaLabel: 'Top-right radius',
      inputMode: 'decimal',
      prefix: createCornerIcon('top-right'),
      suffix: 'px',
    }),
    'bottom-left': createInputContainer({
      ariaLabel: 'Bottom-left radius',
      inputMode: 'decimal',
      prefix: createCornerIcon('bottom-left'),
      suffix: 'px',
    }),
    'bottom-right': createInputContainer({
      ariaLabel: 'Bottom-right radius',
      inputMode: 'decimal',
      prefix: createCornerIcon('bottom-right'),
      suffix: 'px',
    }),
  };

  borderRadiusCornersGrid.append(
    borderRadiusCorners['top-left'].root,
    borderRadiusCorners['top-right'].root,
    borderRadiusCorners['bottom-left'].root,
    borderRadiusCorners['bottom-right'].root,
  );

  // Keep corners grid separate from the unified row for full-width display when expanded
  borderRadiusControl.append(borderRadiusUnifiedRow);
  borderRadiusRow.append(borderRadiusLabel, borderRadiusControl);

  const borderRadiusField: BorderRadiusFieldState = {
    kind: 'border-radius',
    property: 'border-radius',
    root: borderRadiusRow,
    unified: borderRadiusUnified,
    toggleButton: borderRadiusToggleButton,
    cornersGrid: borderRadiusCornersGrid,
    corners: borderRadiusCorners,
    handle: null,
    expanded: false,
    mode: null,
    cornersMaterialized: false,
  };

  // Create combined row for Width and Radius
  const widthAndRadiusRow = document.createElement('div');
  widthAndRadiusRow.className = 'we-field-row';
  borderWidthRow.style.flex = '1';
  borderWidthRow.style.minWidth = '0';
  borderRadiusRow.style.flex = '1';
  borderRadiusRow.style.minWidth = '0';
  widthAndRadiusRow.append(borderWidthRow, borderRadiusRow);

  wireNumberStepping(disposer, borderWidthInput, { mode: 'css-length' });
  wireNumberStepping(disposer, borderRadiusUnified.input, { mode: 'css-length' });
  for (const corner of BORDER_RADIUS_CORNERS) {
    wireNumberStepping(disposer, borderRadiusCorners[corner].input, { mode: 'css-length' });
  }

  // borderRadiusCornersGrid placed after widthAndRadiusRow to span full width when expanded
  root.append(
    borderEdgeRow,
    widthAndRadiusRow,
    borderRadiusCornersGrid,
    borderStyleRow,
    colorTypeRow,
    borderColorRow,
    borderGradientMount,
  );
  container.appendChild(root);
  disposer.add(() => root.remove());

  // ===========================================================================
  // Border Edge Selector
  // ===========================================================================

  const borderEdgeGroup = createIconButtonGroup<BorderEdge>({
    container: borderEdgeMount,
    ariaLabel: 'Border edge',
    columns: 5,
    value: currentBorderEdge,
    items: BORDER_EDGE_VALUES.map((edge) => ({
      value: edge,
      ariaLabel: edge,
      title: edge.charAt(0).toUpperCase() + edge.slice(1),
      icon: createBorderEdgeIcon(edge),
    })),
    onChange: (edge) => {
      if (edge === currentBorderEdge) return;
      commitTransaction('border-width');
      commitTransaction('border-style');
      commitTransaction('border-color');
      currentBorderEdge = edge;
      syncAllFields();
    },
  });
  disposer.add(() => borderEdgeGroup.dispose());

  // ===========================================================================
  // Color Field
  // ===========================================================================

  const borderColorField = createColorField({
    container: borderColorContainer,
    ariaLabel: 'Border Color',
    tokensService,
    getTokenTarget: () => currentTarget,
    onInput: (value) => {
      const handle = beginTransaction('border-color');
      if (handle) handle.set(value);
    },
    onCommit: () => {
      commitTransaction('border-color');
      syncAllFields();
    },
    onCancel: () => {
      rollbackTransaction('border-color');
      syncField('border-color', true);
    },
  });
  disposer.add(() => borderColorField.dispose());

  // ===========================================================================
  // Gradient Control (for border-image-source)
  // ===========================================================================

  const borderGradientControl = createGradientControl({
    container: borderGradientMount,
    transactionManager,
    tokensService,
    property: 'border-image-source',
    allowNone: true,
  });
  disposer.add(() => borderGradientControl.dispose());

  // ===========================================================================
  // Field State Map
  // ===========================================================================

  const fields: Record<BorderProperty, FieldState> = {
    'border-width': {
      kind: 'text',
      property: 'border-width',
      element: borderWidthInput,
      handle: null,
    },
    'border-style': {
      kind: 'select',
      property: 'border-style',
      element: borderStyleSelect,
      handle: null,
    },
    'border-color': {
      kind: 'color',
      property: 'border-color',
      field: borderColorField,
      handle: null,
    },
    'border-radius': borderRadiusField,
  };

  const PROPS: readonly BorderProperty[] = [
    'border-width',
    'border-style',
    'border-color',
    'border-radius',
  ];

  // ===========================================================================
  // CSS Property Resolution
  // ===========================================================================

  function resolveBorderProperty(kind: 'width' | 'style' | 'color'): string {
    if (currentBorderEdge === 'all') return `border-${kind}`;
    return `border-${currentBorderEdge}-${kind}`;
  }

  function resolveCssProperty(property: BorderProperty): string {
    if (property === 'border-width') return resolveBorderProperty('width');
    if (property === 'border-style') return resolveBorderProperty('style');
    if (property === 'border-color') return resolveBorderProperty('color');
    return property;
  }

  // ===========================================================================
  // Transaction Management
  // ===========================================================================

  function beginTransaction(property: BorderProperty): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;
    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    const field = fields[property];
    if (field.kind === 'border-radius') return null;
    if (field.handle) return field.handle;

    const cssProperty = resolveCssProperty(property);
    const handle = transactionManager.beginStyle(target, cssProperty);
    field.handle = handle;
    return handle;
  }

  function commitTransaction(property: BorderProperty): void {
    const field = fields[property];
    if (field.kind === 'border-radius') return;
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackTransaction(property: BorderProperty): void {
    const field = fields[property];
    if (field.kind === 'border-radius') return;
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.rollback();
  }

  function beginBorderRadiusTransaction(): MultiStyleTransactionHandle | null {
    if (disposer.isDisposed) return null;
    const field = fields['border-radius'];
    if (field.kind !== 'border-radius') return null;

    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    if (field.handle) return field.handle;

    const handle = transactionManager.beginMultiStyle(target, [
      ...BORDER_RADIUS_TRANSACTION_PROPERTIES,
    ]);
    field.handle = handle;
    field.mode = null;
    field.cornersMaterialized = false;
    return handle;
  }

  function commitBorderRadiusTransaction(): void {
    const field = fields['border-radius'];
    if (field.kind !== 'border-radius') return;
    const handle = field.handle;
    field.handle = null;
    field.mode = null;
    field.cornersMaterialized = false;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackBorderRadiusTransaction(): void {
    const field = fields['border-radius'];
    if (field.kind !== 'border-radius') return;
    const handle = field.handle;
    field.handle = null;
    field.mode = null;
    field.cornersMaterialized = false;
    if (handle) handle.rollback();
  }

  function commitAllTransactions(): void {
    for (const p of PROPS) commitTransaction(p);
    commitBorderRadiusTransaction();
  }

  // ===========================================================================
  // Color Type (Solid / Gradient)
  // ===========================================================================

  /**
   * Update visibility of color-related rows based on currentColorType.
   */
  function updateColorTypeVisibility(): void {
    borderColorRow.hidden = currentColorType !== 'solid';
    borderGradientMount.hidden = currentColorType !== 'gradient';
  }

  /**
   * Update edge selector disabled state based on color type.
   * Gradient mode requires 'all' edges (border-image doesn't support per-edge).
   */
  function updateEdgeSelectorState(): void {
    const hasTarget = Boolean(currentTarget && currentTarget.isConnected);

    // In gradient mode, lock edge to 'all' since border-image applies to all edges
    if (currentColorType === 'gradient') {
      if (currentBorderEdge !== 'all') {
        commitTransaction('border-width');
        commitTransaction('border-style');
        commitTransaction('border-color');
        currentBorderEdge = 'all';
      }
      borderEdgeGroup.setValue('all');
    }

    borderEdgeGroup.setDisabled(!hasTarget || currentColorType === 'gradient');
  }

  /**
   * Set border color type and apply necessary CSS changes.
   * Uses multiStyle transaction to atomically set border-image properties.
   */
  function setColorType(type: BorderColorType): void {
    const target = currentTarget;

    currentColorType = type;
    colorTypeSelect.value = type;

    updateColorTypeVisibility();
    updateEdgeSelectorState();

    if (!target || !target.isConnected) return;

    // Use multiStyle to atomically manage border-image properties
    const handle = transactionManager.beginMultiStyle(target, [
      'border-image-source',
      'border-image-slice',
    ]);
    if (!handle) return;

    if (type === 'solid') {
      // Clear border-image when switching to solid color
      handle.set({
        'border-image-source': 'none',
        'border-image-slice': '',
      });
    } else {
      // Set up border-image for gradient mode
      const inlineSource = readInlineValue(target, 'border-image-source');
      const computedSource = readComputedValue(target, 'border-image-source');
      const currentSource = inlineSource || computedSource;

      // Use existing gradient or provide a default
      const hasValidGradient =
        currentSource &&
        currentSource.trim() &&
        currentSource.trim().toLowerCase() !== 'none' &&
        /\b(?:linear|radial|conic)-gradient\s*\(/i.test(currentSource);

      const gradientValue = hasValidGradient
        ? currentSource
        : 'linear-gradient(90deg, #000000, #ffffff)';

      handle.set({
        'border-image-source': gradientValue,
        'border-image-slice': '1',
      });
    }

    handle.commit({ merge: true });
  }

  // Wire color type selector change event
  disposer.listen(colorTypeSelect, 'change', () => {
    const type = colorTypeSelect.value as BorderColorType;
    setColorType(type);
    borderGradientControl.refresh();
    syncAllFields();
  });

  // ===========================================================================
  // Field Synchronization
  // ===========================================================================

  function syncField(property: BorderProperty, force = false): void {
    const field = fields[property];
    const target = currentTarget;
    const cssProperty = resolveCssProperty(property);

    if (field.kind === 'border-radius') {
      const hasTarget = Boolean(target && target.isConnected);

      field.unified.input.disabled = !hasTarget;
      field.toggleButton.disabled = !hasTarget;
      for (const corner of BORDER_RADIUS_CORNERS) {
        field.corners[corner].input.disabled = !hasTarget;
      }

      if (!hasTarget || !target) {
        field.unified.input.value = '';
        field.unified.input.placeholder = '';
        field.unified.setSuffix('px');
        for (const corner of BORDER_RADIUS_CORNERS) {
          field.corners[corner].input.value = '';
          field.corners[corner].input.placeholder = '';
          field.corners[corner].setSuffix('px');
        }
        return;
      }

      const isCornerFocused = BORDER_RADIUS_CORNERS.some((c) =>
        isFieldFocused(field.corners[c].input),
      );
      const isEditing =
        field.handle !== null || isFieldFocused(field.unified.input) || isCornerFocused;
      if (isEditing && !force) return;

      const inlineUnified = readInlineValue(target, 'border-radius');
      if (inlineUnified) {
        const formatted = formatLengthForDisplay(inlineUnified);
        field.unified.input.value = formatted.value;
        field.unified.setSuffix(formatted.suffix);
      } else {
        const tl = readComputedValue(target, BORDER_RADIUS_CORNER_PROPERTIES['top-left']);
        const tr = readComputedValue(target, BORDER_RADIUS_CORNER_PROPERTIES['top-right']);
        const br = readComputedValue(target, BORDER_RADIUS_CORNER_PROPERTIES['bottom-right']);
        const bl = readComputedValue(target, BORDER_RADIUS_CORNER_PROPERTIES['bottom-left']);
        const displayValue =
          tl === tr && tl === br && tl === bl ? tl : readComputedValue(target, 'border-radius');
        const formatted = formatLengthForDisplay(displayValue);
        field.unified.input.value = formatted.value;
        field.unified.setSuffix(formatted.suffix);
      }
      field.unified.input.placeholder = '';

      for (const corner of BORDER_RADIUS_CORNERS) {
        const propName = BORDER_RADIUS_CORNER_PROPERTIES[corner];
        const inlineValue = readInlineValue(target, propName);
        const computedValue = readComputedValue(target, propName);
        const displayValue = inlineValue || computedValue;
        const formatted = formatLengthForDisplay(displayValue);
        field.corners[corner].input.value = formatted.value;
        field.corners[corner].input.placeholder = '';
        field.corners[corner].setSuffix(formatted.suffix);
      }
      return;
    }

    if (field.kind === 'text') {
      const input = field.element;

      if (!target || !target.isConnected) {
        input.disabled = true;
        input.value = '';
        input.placeholder = '';
        if (property === 'border-width') borderWidthContainer.setSuffix('px');
        return;
      }

      input.disabled = false;

      const isEditing = field.handle !== null || isFieldFocused(input);
      if (isEditing && !force) return;

      const inlineValue = readInlineValue(target, cssProperty);
      const computedValue = readComputedValue(target, cssProperty);

      // Use formatLengthForDisplay for border-width to set proper suffix
      if (property === 'border-width') {
        const formatted = formatLengthForDisplay(inlineValue || computedValue);
        input.value = formatted.value;
        borderWidthContainer.setSuffix(formatted.suffix);
      } else {
        input.value = inlineValue || computedValue;
      }
      input.placeholder = '';
    } else if (field.kind === 'select') {
      const select = field.element;

      if (!target || !target.isConnected) {
        select.disabled = true;
        return;
      }

      select.disabled = false;

      const isEditing = field.handle !== null || isFieldFocused(select);
      if (isEditing && !force) return;

      const inline = readInlineValue(target, cssProperty);
      const computed = readComputedValue(target, cssProperty);
      const val = inline || computed;
      const hasOption = Array.from(select.options).some((o) => o.value === val);
      select.value = hasOption ? val : (select.options[0]?.value ?? '');
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

      const inlineValue = readInlineValue(target, cssProperty);
      const computedValue = readComputedValue(target, cssProperty);
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
    colorTypeSelect.disabled = !hasTarget;
    updateColorTypeVisibility();
    updateEdgeSelectorState();
  }

  // ===========================================================================
  // Event Wiring
  // ===========================================================================

  function wireTextInput(property: BorderProperty): void {
    const field = fields[property];
    if (field.kind !== 'text') return;

    const input = field.element;

    // Use combineLengthValue for border-width to include suffix
    const getNextValue =
      property === 'border-width'
        ? () => combineLengthValue(input.value, borderWidthContainer.getSuffixText())
        : () => input.value.trim();

    disposer.listen(input, 'input', () => {
      const handle = beginTransaction(property);
      if (handle) handle.set(getNextValue());
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

  function wireSelect(property: BorderProperty): void {
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

  function wireBorderRadiusControl(): void {
    const field = fields['border-radius'];
    if (field.kind !== 'border-radius') return;

    const setExpanded = (expanded: boolean) => {
      field.expanded = expanded;
      field.cornersGrid.hidden = !expanded;
      field.toggleButton.setAttribute('aria-pressed', expanded ? 'true' : 'false');
    };
    setExpanded(false);

    disposer.listen(field.toggleButton, 'click', () => {
      setExpanded(!field.expanded);
    });

    const previewUnified = () => {
      const handle = beginBorderRadiusTransaction();
      if (!handle) return;

      field.mode = 'unified';
      field.cornersMaterialized = false;

      const v = combineLengthValue(field.unified.input.value, field.unified.getSuffixText());
      // Step 1: Clear longhand properties first
      handle.set({
        'border-top-left-radius': '',
        'border-top-right-radius': '',
        'border-bottom-right-radius': '',
        'border-bottom-left-radius': '',
        'border-radius': '',
      });
      // Step 2: Set shorthand value after longhands are cleared
      // This ensures the shorthand is applied last and not overwritten by empty longhands
      handle.set({
        'border-radius': v,
      });
    };

    const previewCorner = (corner: BorderRadiusCorner) => {
      const target = currentTarget;
      if (!target || !target.isConnected) return;

      const handle = beginBorderRadiusTransaction();
      if (!handle) return;

      const cornerProp = BORDER_RADIUS_CORNER_PROPERTIES[corner];
      const container = field.corners[corner];
      const next = combineLengthValue(container.input.value, container.getSuffixText());

      if (field.mode !== 'corners' || !field.cornersMaterialized) {
        const initialValues: Record<string, string> = {
          'border-radius': '',
          'border-top-left-radius':
            readInlineValue(target, 'border-top-left-radius') ||
            readComputedValue(target, 'border-top-left-radius'),
          'border-top-right-radius':
            readInlineValue(target, 'border-top-right-radius') ||
            readComputedValue(target, 'border-top-right-radius'),
          'border-bottom-right-radius':
            readInlineValue(target, 'border-bottom-right-radius') ||
            readComputedValue(target, 'border-bottom-right-radius'),
          'border-bottom-left-radius':
            readInlineValue(target, 'border-bottom-left-radius') ||
            readComputedValue(target, 'border-bottom-left-radius'),
        };
        initialValues[cornerProp] = next;
        handle.set(initialValues);
        field.mode = 'corners';
        field.cornersMaterialized = true;
        return;
      }

      handle.set({ 'border-radius': '', [cornerProp]: next });
    };

    disposer.listen(field.unified.input, 'input', previewUnified);
    for (const corner of BORDER_RADIUS_CORNERS) {
      disposer.listen(field.corners[corner].input, 'input', () => previewCorner(corner));
    }

    disposer.listen(field.root, 'focusout', (e: FocusEvent) => {
      const next = e.relatedTarget;
      if (next instanceof Node && field.root.contains(next)) return;
      commitBorderRadiusTransaction();
      syncAllFields();
    });

    const wireKeydown = (input: HTMLInputElement) => {
      disposer.listen(input, 'keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitBorderRadiusTransaction();
          syncAllFields();
          input.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          rollbackBorderRadiusTransaction();
          syncField('border-radius', true);
        }
      });
    };

    wireKeydown(field.unified.input);
    for (const corner of BORDER_RADIUS_CORNERS) {
      wireKeydown(field.corners[corner].input);
    }
  }

  wireTextInput('border-width');
  wireSelect('border-style');
  wireBorderRadiusControl();

  // ===========================================================================
  // Public API
  // ===========================================================================

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;
    if (element !== currentTarget) commitAllTransactions();
    currentTarget = element;

    // Infer color type from border-image-source
    if (element && element.isConnected) {
      const borderImageSource =
        readInlineValue(element, 'border-image-source') ||
        readComputedValue(element, 'border-image-source');
      currentColorType = inferBorderColorType(borderImageSource);
    } else {
      currentColorType = 'solid';
    }
    colorTypeSelect.value = currentColorType;

    // In gradient mode, ensure edge is set to 'all'
    if (currentColorType === 'gradient') {
      currentBorderEdge = 'all';
      borderEdgeGroup.setValue('all');
    }

    // Update gradient control target
    borderGradientControl.setTarget(element);
    syncAllFields();
  }

  function refresh(): void {
    if (disposer.isDisposed) return;

    // Re-infer color type from element to handle external changes (CSS panel, Undo/Redo)
    const target = currentTarget;
    if (target && target.isConnected) {
      const borderImageSource =
        readInlineValue(target, 'border-image-source') ||
        readComputedValue(target, 'border-image-source');
      const inferredType = inferBorderColorType(borderImageSource);
      if (inferredType !== currentColorType) {
        currentColorType = inferredType;
        colorTypeSelect.value = inferredType;
        if (inferredType === 'gradient') {
          currentBorderEdge = 'all';
          borderEdgeGroup.setValue('all');
        }
      }
    }

    borderGradientControl.refresh();
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
