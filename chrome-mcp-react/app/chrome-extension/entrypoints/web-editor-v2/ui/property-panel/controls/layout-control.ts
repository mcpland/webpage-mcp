/**
 * Layout Control (Phase 3.4 + 4.1/4.2 - Refactored)
 *
 * Edits inline layout styles:
 * - display (icon button group): block/inline/inline-block/flex/grid/none
 * - flex-direction (icon button group, shown when display=flex)
 * - justify-content + align-items (content bars, shown when display=flex)
 * - grid-template-columns/rows (dimensions picker, shown when display=grid)
 * - flex-wrap (select, shown when display=flex)
 * - gap (input, shown when display=flex/grid)
 */

import { Disposer } from '../../../utils/disposables';
import type {
  MultiStyleTransactionHandle,
  StyleTransactionHandle,
  TransactionManager,
} from '../../../core/transaction-manager';
import type { DesignControl } from '../types';
import { createIconButtonGroup, type IconButtonGroup } from '../components/icon-button-group';
import { createInputContainer, type InputContainer } from '../components/input-container';
import { combineLengthValue, formatLengthForDisplay } from './css-helpers';
import { wireNumberStepping } from './number-stepping';

// =============================================================================
// Constants
// =============================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';

const DISPLAY_VALUES = ['block', 'inline', 'inline-block', 'flex', 'grid', 'none'] as const;
const FLEX_DIRECTION_VALUES = ['row', 'column', 'row-reverse', 'column-reverse'] as const;
const FLEX_WRAP_VALUES = ['nowrap', 'wrap', 'wrap-reverse'] as const;
const ALIGNMENT_AXIS_VALUES = ['flex-start', 'center', 'flex-end'] as const;
const GRID_DIMENSION_MAX = 12;

type DisplayValue = (typeof DISPLAY_VALUES)[number];
type FlexDirectionValue = (typeof FLEX_DIRECTION_VALUES)[number];
type AlignmentAxisValue = (typeof ALIGNMENT_AXIS_VALUES)[number];

/** Single-property field keys */
type LayoutProperty = 'display' | 'flex-direction' | 'flex-wrap' | 'row-gap' | 'column-gap';

/** All field keys including composite fields */
type FieldKey = LayoutProperty | 'alignment' | 'grid-dimensions';

// =============================================================================
// Field State Types
// =============================================================================

interface DisplayFieldState {
  kind: 'display-group';
  property: 'display';
  group: IconButtonGroup<DisplayValue>;
  handle: StyleTransactionHandle | null;
  row: HTMLElement;
}

interface FlexDirectionFieldState {
  kind: 'flex-direction-group';
  property: 'flex-direction';
  group: IconButtonGroup<FlexDirectionValue>;
  handle: StyleTransactionHandle | null;
  row: HTMLElement;
}

interface SelectFieldState {
  kind: 'select';
  property: 'flex-wrap';
  element: HTMLSelectElement;
  handle: StyleTransactionHandle | null;
  row: HTMLElement;
}

interface InputFieldState {
  kind: 'input';
  property: 'row-gap' | 'column-gap';
  element: HTMLInputElement;
  container: InputContainer;
  handle: StyleTransactionHandle | null;
  row: HTMLElement;
}

interface FlexAlignmentFieldState {
  kind: 'flex-alignment';
  properties: readonly ['justify-content', 'align-items'];
  justifyGroup: IconButtonGroup<AlignmentAxisValue>;
  alignGroup: IconButtonGroup<AlignmentAxisValue>;
  handle: MultiStyleTransactionHandle | null;
  row: HTMLElement;
}

interface GridDimensionsFieldState {
  kind: 'grid-dimensions';
  properties: readonly ['grid-template-columns', 'grid-template-rows'];
  previewButton: HTMLButtonElement;
  previewColsValue: HTMLSpanElement;
  previewRowsValue: HTMLSpanElement;
  popover: HTMLDivElement;
  colsContainer: InputContainer;
  rowsContainer: InputContainer;
  matrix: HTMLDivElement;
  tooltip: HTMLDivElement;
  cells: HTMLButtonElement[];
  handle: MultiStyleTransactionHandle | null;
  row: HTMLElement;
}

type FieldState =
  | DisplayFieldState
  | FlexDirectionFieldState
  | SelectFieldState
  | InputFieldState
  | FlexAlignmentFieldState
  | GridDimensionsFieldState;

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

function isDisplayValue(value: string): value is DisplayValue {
  return (DISPLAY_VALUES as readonly string[]).includes(value);
}

function isFlexDirectionValue(value: string): value is FlexDirectionValue {
  return (FLEX_DIRECTION_VALUES as readonly string[]).includes(value);
}

function isAlignmentAxisValue(value: string): value is AlignmentAxisValue {
  return (ALIGNMENT_AXIS_VALUES as readonly string[]).includes(value);
}

/**
 * Map computed display values to the closest option value.
 */
function normalizeDisplayValue(computed: string): string {
  const trimmed = computed.trim();
  if (trimmed === 'inline-flex') return 'flex';
  if (trimmed === 'inline-grid') return 'grid';
  return trimmed;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Split CSS value into top-level tokens (respects parentheses depth).
 */
function splitTopLevelTokens(value: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '(') depth++;
    if (ch === ')' && depth > 0) depth--;

    if (depth === 0 && /\s/.test(ch)) {
      const t = current.trim();
      if (t) tokens.push(t);
      current = '';
      continue;
    }
    current += ch;
  }

  const tail = current.trim();
  if (tail) tokens.push(tail);
  return tokens;
}

function parseRepeatCount(token: string): number | null {
  const match = token.match(/^repeat\(\s*(\d+)\s*,/i);
  if (!match) return null;
  const n = parseInt(match[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Count grid tracks from grid-template-columns/rows value.
 */
function countGridTracks(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'none') return null;

  const tokens = splitTopLevelTokens(trimmed);
  let count = 0;

  for (const t of tokens) {
    // Ignore line-name tokens like [col-start]
    if (/^\[.*\]$/.test(t)) continue;
    count += parseRepeatCount(t) ?? 1;
  }

  return count > 0 ? count : null;
}

function formatGridTemplate(count: number): string {
  const n = clampInt(count, 1, GRID_DIMENSION_MAX);
  return n === 1 ? '1fr' : `repeat(${n}, 1fr)`;
}

// =============================================================================
// SVG Icon Helpers
// =============================================================================

function createBaseIconSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 15 15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}

function applyStroke(el: SVGElement, strokeWidth = '1.2'): void {
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', strokeWidth);
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
}

function createDisplayIcon(value: DisplayValue): SVGElement {
  const svg = createBaseIconSvg();

  // Container border (dashed rectangle represents container)
  const container = document.createElementNS(SVG_NS, 'rect');
  container.setAttribute('x', '2');
  container.setAttribute('y', '2');
  container.setAttribute('width', '11');
  container.setAttribute('height', '11');
  container.setAttribute('rx', '1.5');
  container.setAttribute('stroke', 'currentColor');
  container.setAttribute('stroke-width', '1');
  container.setAttribute('stroke-dasharray', '2 1');
  container.setAttribute('fill', 'none');
  container.setAttribute('opacity', '0.5');

  const addBlock = (x: number, y: number, w: number, h: number) => {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(w));
    rect.setAttribute('height', String(h));
    rect.setAttribute('rx', '0.5');
    rect.setAttribute('fill', 'currentColor');
    svg.append(rect);
  };

  const addLine = (x: number, y: number, w: number) => {
    const line = document.createElementNS(SVG_NS, 'rect');
    line.setAttribute('x', String(x));
    line.setAttribute('y', String(y));
    line.setAttribute('width', String(w));
    line.setAttribute('height', '1');
    line.setAttribute('rx', '0.5');
    line.setAttribute('fill', 'currentColor');
    svg.append(line);
  };

  switch (value) {
    case 'block':
      // 两个全宽的块级元素，垂直堆叠
      addBlock(3.5, 3.5, 8, 3);
      addBlock(3.5, 8.5, 8, 3);
      break;
    case 'inline':
      // 三行文本表示内联流
      addLine(3.5, 4.5, 8);
      addLine(3.5, 7.5, 5);
      addLine(3.5, 10.5, 6.5);
      break;
    case 'inline-block':
      // 左边一个块，右边两行文本
      addBlock(3.5, 4.5, 3.5, 6);
      addLine(8, 5.5, 4);
      addLine(8, 8.5, 3);
      break;
    case 'flex':
      // 三个水平排列的弹性子项
      addBlock(3.5, 4.5, 2.5, 6);
      addBlock(6.5, 4.5, 2.5, 6);
      addBlock(9.5, 4.5, 2.5, 6);
      break;
    case 'grid':
      // 2x2 网格布局
      addBlock(3.5, 3.5, 3.5, 3.5);
      addBlock(8, 3.5, 3.5, 3.5);
      addBlock(3.5, 8, 3.5, 3.5);
      addBlock(8, 8, 3.5, 3.5);
      break;
    case 'none': {
      // 禁用符号：斜线
      const slash = document.createElementNS(SVG_NS, 'path');
      slash.setAttribute('d', 'M4 11L11 4');
      slash.setAttribute('stroke', 'currentColor');
      slash.setAttribute('stroke-width', '1.5');
      slash.setAttribute('stroke-linecap', 'round');
      svg.append(slash);
      break;
    }
  }

  svg.prepend(container);
  return svg;
}

function createFlowIcon(direction: FlexDirectionValue): SVGElement {
  const svg = createBaseIconSvg();
  const path = document.createElementNS(SVG_NS, 'path');
  applyStroke(path, '1.5');

  const DIRECTION_PATHS: Record<FlexDirectionValue, string> = {
    row: 'M2 7.5H13M10 4.5L13 7.5L10 10.5',
    'row-reverse': 'M13 7.5H2M5 4.5L2 7.5L5 10.5',
    column: 'M7.5 2V13M4.5 10L7.5 13L10.5 10',
    'column-reverse': 'M7.5 13V2M4.5 5L7.5 2L10.5 5',
  };

  path.setAttribute('d', DIRECTION_PATHS[direction]);
  svg.append(path);
  return svg;
}

function createHorizontalAlignIcon(value: AlignmentAxisValue): SVGElement {
  const svg = createBaseIconSvg();

  // Container border (dashed rectangle represents container)
  const container = document.createElementNS(SVG_NS, 'rect');
  container.setAttribute('x', '2');
  container.setAttribute('y', '2');
  container.setAttribute('width', '11');
  container.setAttribute('height', '11');
  container.setAttribute('rx', '1.5');
  container.setAttribute('stroke', 'currentColor');
  container.setAttribute('stroke-width', '1');
  container.setAttribute('stroke-dasharray', '2 1');
  container.setAttribute('fill', 'none');
  container.setAttribute('opacity', '0.5');

  // 内容块的 X 坐标根据对齐方式不同
  const blockX: Record<AlignmentAxisValue, number> = {
    'flex-start': 3.5, // 左对齐
    center: 5.5, // Center aligned
    'flex-end': 7.5, // 右对齐
  };

  // 两个小方块表示子元素（水平方向排列变为垂直方向排列）
  const block1 = document.createElementNS(SVG_NS, 'rect');
  block1.setAttribute('x', String(blockX[value]));
  block1.setAttribute('y', '4');
  block1.setAttribute('width', '4');
  block1.setAttribute('height', '3');
  block1.setAttribute('rx', '0.5');
  block1.setAttribute('fill', 'currentColor');

  const block2 = document.createElementNS(SVG_NS, 'rect');
  block2.setAttribute('x', String(blockX[value]));
  block2.setAttribute('y', '8');
  block2.setAttribute('width', '4');
  block2.setAttribute('height', '3');
  block2.setAttribute('rx', '0.5');
  block2.setAttribute('fill', 'currentColor');

  svg.append(container, block1, block2);
  return svg;
}

function createVerticalAlignIcon(value: AlignmentAxisValue): SVGElement {
  const svg = createBaseIconSvg();

  // Container border (dashed rectangle represents container)
  const container = document.createElementNS(SVG_NS, 'rect');
  container.setAttribute('x', '2');
  container.setAttribute('y', '2');
  container.setAttribute('width', '11');
  container.setAttribute('height', '11');
  container.setAttribute('rx', '1.5');
  container.setAttribute('stroke', 'currentColor');
  container.setAttribute('stroke-width', '1');
  container.setAttribute('stroke-dasharray', '2 1');
  container.setAttribute('fill', 'none');
  container.setAttribute('opacity', '0.5');

  // Y coordinate of content block varies by alignment mode
  const blockY: Record<AlignmentAxisValue, number> = {
    'flex-start': 3.5, // Top aligned
    center: 5.5, // Center aligned
    'flex-end': 7.5, // Bottom aligned
  };

  // Two small blocks represent child elements
  const block1 = document.createElementNS(SVG_NS, 'rect');
  block1.setAttribute('x', '4');
  block1.setAttribute('y', String(blockY[value]));
  block1.setAttribute('width', '3');
  block1.setAttribute('height', '4');
  block1.setAttribute('rx', '0.5');
  block1.setAttribute('fill', 'currentColor');

  const block2 = document.createElementNS(SVG_NS, 'rect');
  block2.setAttribute('x', '8');
  block2.setAttribute('y', String(blockY[value]));
  block2.setAttribute('width', '3');
  block2.setAttribute('height', '4');
  block2.setAttribute('rx', '0.5');
  block2.setAttribute('fill', 'currentColor');

  svg.append(container, block1, block2);
  return svg;
}

function createGapIcon(): SVGElement {
  const svg = createBaseIconSvg();
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('d', 'M1.5 4.5H13.5M1.5 10.5H13.5');
  svg.append(path);
  return svg;
}

function createGridColumnsIcon(): SVGElement {
  const svg = createBaseIconSvg();

  const r1 = document.createElementNS(SVG_NS, 'rect');
  r1.setAttribute('x', '3');
  r1.setAttribute('y', '4');
  r1.setAttribute('width', '3.5');
  r1.setAttribute('height', '7');
  r1.setAttribute('rx', '1');
  applyStroke(r1);

  const r2 = document.createElementNS(SVG_NS, 'rect');
  r2.setAttribute('x', '8.5');
  r2.setAttribute('y', '4');
  r2.setAttribute('width', '3.5');
  r2.setAttribute('height', '7');
  r2.setAttribute('rx', '1');
  applyStroke(r2);

  svg.append(r1, r2);
  return svg;
}

function createGridRowsIcon(): SVGElement {
  const svg = createBaseIconSvg();

  const r1 = document.createElementNS(SVG_NS, 'rect');
  r1.setAttribute('x', '4');
  r1.setAttribute('y', '3');
  r1.setAttribute('width', '7');
  r1.setAttribute('height', '3.5');
  r1.setAttribute('rx', '1');
  applyStroke(r1);

  const r2 = document.createElementNS(SVG_NS, 'rect');
  r2.setAttribute('x', '4');
  r2.setAttribute('y', '8.5');
  r2.setAttribute('width', '7');
  r2.setAttribute('height', '3.5');
  r2.setAttribute('rx', '1');
  applyStroke(r2);

  svg.append(r1, r2);
  return svg;
}

// =============================================================================
// Factory
// =============================================================================

export interface LayoutControlOptions {
  container: HTMLElement;
  transactionManager: TransactionManager;
}

export function createLayoutControl(options: LayoutControlOptions): DesignControl {
  const { container, transactionManager } = options;
  const disposer = new Disposer();

  let currentTarget: Element | null = null;

  const root = document.createElement('div');
  root.className = 'we-field-group';

  // ---------------------------------------------------------------------------
  // Display row (icon button group)
  // ---------------------------------------------------------------------------
  const displayRow = document.createElement('div');
  displayRow.className = 'we-field';

  const displayLabel = document.createElement('span');
  displayLabel.className = 'we-field-label';
  displayLabel.textContent = 'Display';

  const displayMount = document.createElement('div');
  displayMount.className = 'we-field-content';

  displayRow.append(displayLabel, displayMount);

  const displayGroup = createIconButtonGroup<DisplayValue>({
    container: displayMount,
    ariaLabel: 'Display',
    columns: 6,
    items: DISPLAY_VALUES.map((v) => ({
      value: v,
      ariaLabel: v,
      title: v,
      icon: createDisplayIcon(v),
    })),
    onChange: (value) => {
      const handle = beginTransaction('display');
      if (handle) handle.set(value);
      commitTransaction('display');
      syncAllFields();
    },
  });
  disposer.add(() => displayGroup.dispose());

  // ---------------------------------------------------------------------------
  // Flex direction row (icon button group)
  // ---------------------------------------------------------------------------
  const directionRow = document.createElement('div');
  directionRow.className = 'we-field';

  const directionLabel = document.createElement('span');
  directionLabel.className = 'we-field-label';
  directionLabel.textContent = 'Flow';

  const directionMount = document.createElement('div');
  directionMount.className = 'we-field-content';

  directionRow.append(directionLabel, directionMount);

  const directionGroup = createIconButtonGroup<FlexDirectionValue>({
    container: directionMount,
    ariaLabel: 'Flex direction',
    columns: 4,
    items: FLEX_DIRECTION_VALUES.map((dir) => ({
      value: dir,
      ariaLabel: dir.replace('-', ' '),
      title: dir.replace('-', ' '),
      icon: createFlowIcon(dir),
    })),
    onChange: (value) => {
      const handle = beginTransaction('flex-direction');
      if (handle) handle.set(value);
      commitTransaction('flex-direction');
      syncAllFields();
    },
  });
  disposer.add(() => directionGroup.dispose());
  directionGroup.setValue(null);

  // ---------------------------------------------------------------------------
  // Flex wrap row (select)
  // ---------------------------------------------------------------------------
  const wrapRow = document.createElement('div');
  wrapRow.className = 'we-field';
  const wrapLabel = document.createElement('span');
  wrapLabel.className = 'we-field-label';
  wrapLabel.textContent = 'Wrap';
  const wrapSelect = document.createElement('select');
  wrapSelect.className = 'we-select';
  wrapSelect.setAttribute('aria-label', 'flex-wrap');
  for (const v of FLEX_WRAP_VALUES) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    wrapSelect.append(opt);
  }
  wrapRow.append(wrapLabel, wrapSelect);

  // ---------------------------------------------------------------------------
  // Alignment row (content bars for justify-content + align-items)
  // ---------------------------------------------------------------------------
  const alignmentRow = document.createElement('div');
  alignmentRow.className = 'we-field';

  const alignmentLabel = document.createElement('span');
  alignmentLabel.className = 'we-field-label';
  alignmentLabel.textContent = 'Align';

  const alignmentMount = document.createElement('div');
  alignmentMount.className = 'we-field-content';
  alignmentMount.style.display = 'flex';
  alignmentMount.style.gap = '4px';

  alignmentRow.append(alignmentLabel, alignmentMount);

  // Justify group with H label
  const justifyWrapper = document.createElement('div');
  justifyWrapper.style.flex = '1';
  justifyWrapper.style.minWidth = '0';
  justifyWrapper.style.display = 'flex';
  justifyWrapper.style.flexDirection = 'column';
  justifyWrapper.style.gap = '2px';

  const justifyHint = document.createElement('span');
  justifyHint.className = 'we-field-hint';
  justifyHint.textContent = 'H';

  const justifyMount = document.createElement('div');

  justifyWrapper.append(justifyHint, justifyMount);

  // Align group with V label
  const alignWrapper = document.createElement('div');
  alignWrapper.style.flex = '1';
  alignWrapper.style.minWidth = '0';
  alignWrapper.style.display = 'flex';
  alignWrapper.style.flexDirection = 'column';
  alignWrapper.style.gap = '2px';

  const alignHint = document.createElement('span');
  alignHint.className = 'we-field-hint';
  alignHint.textContent = 'V';

  const alignMount = document.createElement('div');

  alignWrapper.append(alignHint, alignMount);

  alignmentMount.append(justifyWrapper, alignWrapper);

  const justifyGroup = createIconButtonGroup<AlignmentAxisValue>({
    container: justifyMount,
    ariaLabel: 'Justify content',
    columns: 3,
    items: ALIGNMENT_AXIS_VALUES.map((v) => ({
      value: v,
      ariaLabel: `justify-content: ${v}`,
      title: v,
      icon: createHorizontalAlignIcon(v),
    })),
    onChange: (justifyContent) => {
      const handle = beginAlignmentTransaction();
      if (!handle) return;
      const alignItems = alignGroup.getValue() ?? 'center';
      handle.set({ 'justify-content': justifyContent, 'align-items': alignItems });
      commitAlignmentTransaction();
      syncAllFields();
    },
  });

  const alignGroup = createIconButtonGroup<AlignmentAxisValue>({
    container: alignMount,
    ariaLabel: 'Align items',
    columns: 3,
    items: ALIGNMENT_AXIS_VALUES.map((v) => ({
      value: v,
      ariaLabel: `align-items: ${v}`,
      title: v,
      icon: createVerticalAlignIcon(v),
    })),
    onChange: (alignItems) => {
      const handle = beginAlignmentTransaction();
      if (!handle) return;
      const justifyContent = justifyGroup.getValue() ?? 'center';
      handle.set({ 'justify-content': justifyContent, 'align-items': alignItems });
      commitAlignmentTransaction();
      syncAllFields();
    },
  });

  disposer.add(() => justifyGroup.dispose());
  disposer.add(() => alignGroup.dispose());
  justifyGroup.setValue(null);
  alignGroup.setValue(null);

  // ---------------------------------------------------------------------------
  // Grid dimensions row (grid-template-columns/rows)
  // ---------------------------------------------------------------------------
  const gridRow = document.createElement('div');
  gridRow.className = 'we-field';

  const gridLabel = document.createElement('span');
  gridLabel.className = 'we-field-label';
  gridLabel.textContent = 'Grid';

  const gridMount = document.createElement('div');
  gridMount.className = 'we-field-content';
  gridMount.style.position = 'relative';

  gridRow.append(gridLabel, gridMount);

  const gridPreviewButton = document.createElement('button');
  gridPreviewButton.type = 'button';
  gridPreviewButton.className = 'we-grid-dimensions-preview';
  gridPreviewButton.setAttribute('aria-label', 'Grid dimensions');
  gridPreviewButton.setAttribute('aria-expanded', 'false');
  gridPreviewButton.setAttribute('aria-haspopup', 'dialog');

  // Single line preview: cols × rows
  const gridPreviewColsValue = document.createElement('span');
  gridPreviewColsValue.textContent = '1';
  const gridPreviewTimes = document.createElement('span');
  gridPreviewTimes.textContent = ' × ';
  const gridPreviewRowsValue = document.createElement('span');
  gridPreviewRowsValue.textContent = '1';

  gridPreviewButton.append(gridPreviewColsValue, gridPreviewTimes, gridPreviewRowsValue);

  const gridPopover = document.createElement('div');
  gridPopover.className = 'we-grid-dimensions-popover';
  gridPopover.hidden = true;

  const gridInputs = document.createElement('div');
  gridInputs.className = 'we-grid-dimensions-inputs';

  const colsContainer = createInputContainer({
    ariaLabel: 'Grid columns',
    inputMode: 'numeric',
    prefix: createGridColumnsIcon(),
    suffix: null,
  });
  colsContainer.root.style.width = '72px';
  colsContainer.root.style.flex = '0 0 auto';

  const times = document.createElement('span');
  times.className = 'we-grid-dimensions-times';
  times.textContent = '×';

  const rowsContainer = createInputContainer({
    ariaLabel: 'Grid rows',
    inputMode: 'numeric',
    prefix: createGridRowsIcon(),
    suffix: null,
  });
  rowsContainer.root.style.width = '72px';
  rowsContainer.root.style.flex = '0 0 auto';

  gridInputs.append(colsContainer.root, times, rowsContainer.root);

  const matrix = document.createElement('div');
  matrix.className = 'we-grid-dimensions-matrix';
  matrix.setAttribute('role', 'grid');

  const cells: HTMLButtonElement[] = [];
  for (let r = 1; r <= GRID_DIMENSION_MAX; r++) {
    for (let c = 1; c <= GRID_DIMENSION_MAX; c++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'we-grid-dimensions-cell';
      cell.dataset.row = String(r);
      cell.dataset.col = String(c);
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', `${c} × ${r}`);
      cells.push(cell);
      matrix.append(cell);
    }
  }

  const tooltip = document.createElement('div');
  tooltip.className = 'we-grid-dimensions-tooltip';
  tooltip.hidden = true;

  gridPopover.append(gridInputs, matrix, tooltip);
  gridMount.append(gridPreviewButton, gridPopover);

  wireNumberStepping(disposer, colsContainer.input, {
    mode: 'number',
    integer: true,
    min: 1,
    max: GRID_DIMENSION_MAX,
  });
  wireNumberStepping(disposer, rowsContainer.input, {
    mode: 'number',
    integer: true,
    min: 1,
    max: GRID_DIMENSION_MAX,
  });

  // ---------------------------------------------------------------------------
  // Gap row (row-gap and column-gap inputs) - vertical layout
  // ---------------------------------------------------------------------------
  const gapRow = document.createElement('div');
  gapRow.className = 'we-field';
  const gapLabel = document.createElement('span');
  gapLabel.className = 'we-field-label';
  gapLabel.textContent = 'Gap';

  const gapMount = document.createElement('div');
  gapMount.className = 'we-field-content';

  const gapInputs = document.createElement('div');
  gapInputs.className = 'we-grid-gap-inputs';

  const rowGapContainer = createInputContainer({
    ariaLabel: 'Row gap',
    inputMode: 'decimal',
    prefix: createGridRowsIcon(),
    suffix: 'px',
  });

  const columnGapContainer = createInputContainer({
    ariaLabel: 'Column gap',
    inputMode: 'decimal',
    prefix: createGridColumnsIcon(),
    suffix: 'px',
  });

  gapInputs.append(rowGapContainer.root, columnGapContainer.root);
  gapMount.append(gapInputs);
  gapRow.append(gapLabel, gapMount);

  wireNumberStepping(disposer, rowGapContainer.input, { mode: 'css-length' });
  wireNumberStepping(disposer, columnGapContainer.input, { mode: 'css-length' });

  // ---------------------------------------------------------------------------
  // Grid + Gap combined row (two columns when display=grid)
  // ---------------------------------------------------------------------------
  const gridGapRow = document.createElement('div');
  gridGapRow.className = 'we-grid-gap-row';
  gridGapRow.hidden = true;

  // Adjust gridRow and gapRow to fit in two-column layout
  gridRow.classList.add('we-grid-gap-col', 'we-grid-gap-col--grid');
  gapRow.classList.add('we-grid-gap-col', 'we-grid-gap-col--gap');

  gridGapRow.append(gridRow, gapRow);

  // ---------------------------------------------------------------------------
  // Assemble DOM
  // ---------------------------------------------------------------------------
  root.append(displayRow, directionRow, wrapRow, alignmentRow, gridGapRow);
  container.append(root);
  disposer.add(() => root.remove());

  // ---------------------------------------------------------------------------
  // Field State Registry
  // ---------------------------------------------------------------------------
  const fields: Record<FieldKey, FieldState> = {
    display: {
      kind: 'display-group',
      property: 'display',
      group: displayGroup,
      handle: null,
      row: displayRow,
    },
    'flex-direction': {
      kind: 'flex-direction-group',
      property: 'flex-direction',
      group: directionGroup,
      handle: null,
      row: directionRow,
    },
    'flex-wrap': {
      kind: 'select',
      property: 'flex-wrap',
      element: wrapSelect,
      handle: null,
      row: wrapRow,
    },
    alignment: {
      kind: 'flex-alignment',
      properties: ['justify-content', 'align-items'] as const,
      justifyGroup,
      alignGroup,
      handle: null,
      row: alignmentRow,
    },
    'grid-dimensions': {
      kind: 'grid-dimensions',
      properties: ['grid-template-columns', 'grid-template-rows'] as const,
      previewButton: gridPreviewButton,
      previewColsValue: gridPreviewColsValue,
      previewRowsValue: gridPreviewRowsValue,
      popover: gridPopover,
      colsContainer,
      rowsContainer,
      matrix,
      tooltip,
      cells,
      handle: null,
      row: gridRow,
    },
    'row-gap': {
      kind: 'input',
      property: 'row-gap',
      element: rowGapContainer.input,
      container: rowGapContainer,
      handle: null,
      row: gapRow,
    },
    'column-gap': {
      kind: 'input',
      property: 'column-gap',
      element: columnGapContainer.input,
      container: columnGapContainer,
      handle: null,
      row: gapRow,
    },
  };

  /** Single-property fields for iteration */
  const STYLE_PROPS: readonly LayoutProperty[] = [
    'display',
    'flex-direction',
    'flex-wrap',
    'row-gap',
    'column-gap',
  ];
  /** All field keys for iteration */
  const FIELD_KEYS: readonly FieldKey[] = [
    'display',
    'flex-direction',
    'flex-wrap',
    'alignment',
    'grid-dimensions',
    'row-gap',
    'column-gap',
  ];

  // ---------------------------------------------------------------------------
  // Transaction Management
  // ---------------------------------------------------------------------------

  function beginTransaction(property: LayoutProperty): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;
    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    const field = fields[property];
    if (field.kind === 'flex-alignment' || field.kind === 'grid-dimensions') return null;
    if (field.handle) return field.handle;

    const handle = transactionManager.beginStyle(target, property);
    field.handle = handle;
    return handle;
  }

  function commitTransaction(property: LayoutProperty): void {
    const field = fields[property];
    if (field.kind === 'flex-alignment' || field.kind === 'grid-dimensions') return;
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackTransaction(property: LayoutProperty): void {
    const field = fields[property];
    if (field.kind === 'flex-alignment' || field.kind === 'grid-dimensions') return;
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.rollback();
  }

  function beginAlignmentTransaction(): MultiStyleTransactionHandle | null {
    if (disposer.isDisposed) return null;
    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    const field = fields.alignment;
    if (field.kind !== 'flex-alignment') return null;
    if (field.handle) return field.handle;

    const handle = transactionManager.beginMultiStyle(target, [...field.properties]);
    field.handle = handle;
    return handle;
  }

  function commitAlignmentTransaction(): void {
    const field = fields.alignment;
    if (field.kind !== 'flex-alignment') return;
    const handle = field.handle;
    field.handle = null;
    handle?.commit({ merge: true });
  }

  function beginGridTransaction(): MultiStyleTransactionHandle | null {
    if (disposer.isDisposed) return null;
    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    const field = fields['grid-dimensions'];
    if (field.kind !== 'grid-dimensions') return null;
    if (field.handle) return field.handle;

    const handle = transactionManager.beginMultiStyle(target, [...field.properties]);
    field.handle = handle;
    return handle;
  }

  function commitGridTransaction(): void {
    const field = fields['grid-dimensions'];
    if (field.kind !== 'grid-dimensions') return;
    const handle = field.handle;
    field.handle = null;
    handle?.commit({ merge: true });
  }

  function rollbackGridTransaction(): void {
    const field = fields['grid-dimensions'];
    if (field.kind !== 'grid-dimensions') return;
    const handle = field.handle;
    field.handle = null;
    handle?.rollback();
  }

  function commitAllTransactions(): void {
    for (const p of STYLE_PROPS) commitTransaction(p);
    commitAlignmentTransaction();
    commitGridTransaction();
  }

  // ---------------------------------------------------------------------------
  // Visibility Control
  // ---------------------------------------------------------------------------

  function updateVisibility(): void {
    const target = currentTarget;
    const rawDisplay = target
      ? readInlineValue(target, 'display') || readComputedValue(target, 'display')
      : (displayGroup.getValue() ?? 'block');
    const displayValue = normalizeDisplayValue(rawDisplay);

    const trimmed = displayValue.trim();
    const isFlex = trimmed === 'flex' || trimmed === 'inline-flex';
    const isGrid = trimmed === 'grid' || trimmed === 'inline-grid';
    const isFlexOrGrid = isFlex || isGrid;

    directionRow.hidden = !isFlex;
    wrapRow.hidden = !isFlex;
    alignmentRow.hidden = !isFlex;

    // Grid + Gap row visibility
    gridGapRow.hidden = !isFlexOrGrid;
    gridRow.hidden = !isGrid;
    gapRow.hidden = !isFlexOrGrid;
  }

  // ---------------------------------------------------------------------------
  // Field Synchronization
  // ---------------------------------------------------------------------------

  function syncField(key: FieldKey, force = false): void {
    const field = fields[key];
    const target = currentTarget;

    // Handle display icon button group
    if (field.kind === 'display-group') {
      const group = field.group;

      if (!target || !target.isConnected) {
        group.setDisabled(true);
        group.setValue(null);
        return;
      }

      group.setDisabled(false);
      const isEditing = field.handle !== null;
      if (isEditing && !force) return;

      const inline = readInlineValue(target, 'display');
      const computed = readComputedValue(target, 'display');
      let raw = (inline || computed).trim();
      raw = normalizeDisplayValue(raw);
      group.setValue(isDisplayValue(raw) ? raw : 'block');
      return;
    }

    // Handle flex-direction icon button group
    if (field.kind === 'flex-direction-group') {
      const group = field.group;

      if (!target || !target.isConnected) {
        group.setDisabled(true);
        group.setValue(null);
        return;
      }

      group.setDisabled(false);
      const isEditing = field.handle !== null;
      if (isEditing && !force) return;

      const inline = readInlineValue(target, 'flex-direction');
      const computed = readComputedValue(target, 'flex-direction');
      const raw = (inline || computed).trim();
      group.setValue(isFlexDirectionValue(raw) ? raw : null);
      return;
    }

    // Handle flex alignment (content bars)
    if (field.kind === 'flex-alignment') {
      if (!target || !target.isConnected) {
        field.justifyGroup.setDisabled(true);
        field.alignGroup.setDisabled(true);
        field.justifyGroup.setValue(null);
        field.alignGroup.setValue(null);
        return;
      }

      field.justifyGroup.setDisabled(false);
      field.alignGroup.setDisabled(false);
      const isEditing = field.handle !== null;
      if (isEditing && !force) return;

      const justifyInline = readInlineValue(target, 'justify-content');
      const justifyComputed = readComputedValue(target, 'justify-content');
      const alignInline = readInlineValue(target, 'align-items');
      const alignComputed = readComputedValue(target, 'align-items');

      const justifyRaw = (justifyInline || justifyComputed).trim();
      const alignRaw = (alignInline || alignComputed).trim();

      if (isAlignmentAxisValue(justifyRaw) && isAlignmentAxisValue(alignRaw)) {
        field.justifyGroup.setValue(justifyRaw);
        field.alignGroup.setValue(alignRaw);
      } else {
        field.justifyGroup.setValue(null);
        field.alignGroup.setValue(null);
      }
      return;
    }

    // Handle grid dimensions (grid-template-columns/rows)
    if (field.kind === 'grid-dimensions') {
      const {
        previewButton,
        popover,
        colsContainer,
        rowsContainer,
        tooltip,
        cells: gridCells,
      } = field;

      if (!target || !target.isConnected) {
        previewButton.disabled = true;
        field.previewColsValue.textContent = '—';
        field.previewRowsValue.textContent = '—';
        previewButton.setAttribute('aria-expanded', 'false');
        popover.hidden = true;
        colsContainer.input.disabled = true;
        rowsContainer.input.disabled = true;
        tooltip.hidden = true;
        for (const cell of gridCells) {
          cell.dataset.active = 'false';
          cell.dataset.selected = 'false';
        }
        return;
      }

      previewButton.disabled = false;
      colsContainer.input.disabled = false;
      rowsContainer.input.disabled = false;

      const isEditing =
        field.handle !== null ||
        isFieldFocused(colsContainer.input) ||
        isFieldFocused(rowsContainer.input);
      if (isEditing && !force) return;

      const colsRaw =
        readInlineValue(target, 'grid-template-columns') ||
        readComputedValue(target, 'grid-template-columns');
      const rowsRaw =
        readInlineValue(target, 'grid-template-rows') ||
        readComputedValue(target, 'grid-template-rows');

      const cols = clampInt(countGridTracks(colsRaw) ?? 1, 1, GRID_DIMENSION_MAX);
      const rows = clampInt(countGridTracks(rowsRaw) ?? 1, 1, GRID_DIMENSION_MAX);

      colsContainer.input.value = String(cols);
      rowsContainer.input.value = String(rows);
      field.previewColsValue.textContent = String(cols);
      field.previewRowsValue.textContent = String(rows);
      // Update aria-label for screen readers
      previewButton.setAttribute('aria-label', `Grid: ${cols} columns, ${rows} rows`);

      // Default rendering uses current values
      tooltip.hidden = true;
      for (const cell of gridCells) {
        const c = parseInt(cell.dataset.col ?? '0', 10);
        const r = parseInt(cell.dataset.row ?? '0', 10);
        const selected = c > 0 && r > 0 && c <= cols && r <= rows;
        cell.dataset.selected = selected ? 'true' : 'false';
        cell.dataset.active = selected ? 'true' : 'false';
      }
      return;
    }

    // Handle input field (row-gap / column-gap)
    if (field.kind === 'input') {
      const input = field.element;

      if (!target || !target.isConnected) {
        input.disabled = true;
        input.value = '';
        input.placeholder = '';
        field.container.setSuffix('px');
        return;
      }

      input.disabled = false;
      const isEditing = field.handle !== null || isFieldFocused(input);
      if (isEditing && !force) return;

      const inlineValue = readInlineValue(target, field.property);
      const displayValue = inlineValue || readComputedValue(target, field.property);
      const formatted = formatLengthForDisplay(displayValue);
      input.value = formatted.value;
      field.container.setSuffix(formatted.suffix);
      input.placeholder = '';
      return;
    }

    // Handle select field (flex-wrap)
    if (field.kind === 'select') {
      const select = field.element;

      if (!target || !target.isConnected) {
        select.disabled = true;
        return;
      }

      select.disabled = false;
      const isEditing = field.handle !== null || isFieldFocused(select);
      if (isEditing && !force) return;

      const inline = readInlineValue(target, field.property);
      const computed = readComputedValue(target, field.property);
      const val = inline || computed;

      const hasOption = Array.from(select.options).some((o) => o.value === val);
      select.value = hasOption ? val : (select.options[0]?.value ?? '');
    }
  }

  function syncAllFields(): void {
    for (const key of FIELD_KEYS) syncField(key);
    updateVisibility();
  }

  // ---------------------------------------------------------------------------
  // Event Wiring
  // ---------------------------------------------------------------------------

  function wireSelect(property: 'flex-wrap'): void {
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

  function wireInput(property: 'row-gap' | 'column-gap'): void {
    const field = fields[property];
    if (field.kind !== 'input') return;
    const input = field.element;

    disposer.listen(input, 'input', () => {
      const handle = beginTransaction(property);
      if (!handle) return;
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

  wireSelect('flex-wrap');
  wireInput('row-gap');
  wireInput('column-gap');

  // ---------------------------------------------------------------------------
  // Grid Dimensions Picker Wiring
  // ---------------------------------------------------------------------------

  let gridHoverCols: number | null = null;
  let gridHoverRows: number | null = null;

  function renderGridSelection(field: GridDimensionsFieldState, cols: number, rows: number): void {
    const activeCols = gridHoverCols ?? cols;
    const activeRows = gridHoverRows ?? rows;

    for (const cell of field.cells) {
      const c = parseInt(cell.dataset.col ?? '0', 10);
      const r = parseInt(cell.dataset.row ?? '0', 10);
      const selected = c > 0 && r > 0 && c <= cols && r <= rows;
      const active = c > 0 && r > 0 && c <= activeCols && r <= activeRows;
      cell.dataset.selected = selected ? 'true' : 'false';
      cell.dataset.active = active ? 'true' : 'false';
    }

    if (gridHoverCols !== null && gridHoverRows !== null) {
      field.tooltip.textContent = `${gridHoverCols} × ${gridHoverRows}`;
      field.tooltip.hidden = false;
    } else {
      field.tooltip.hidden = true;
    }
  }

  function setGridPopoverOpen(field: GridDimensionsFieldState, open: boolean): void {
    field.popover.hidden = !open;
    field.previewButton.setAttribute('aria-expanded', open ? 'true' : 'false');

    // Reset hover when opening/closing
    gridHoverCols = null;
    gridHoverRows = null;

    const cols = clampInt(
      parseInt(field.colsContainer.input.value || '1', 10) || 1,
      1,
      GRID_DIMENSION_MAX,
    );
    const rows = clampInt(
      parseInt(field.rowsContainer.input.value || '1', 10) || 1,
      1,
      GRID_DIMENSION_MAX,
    );
    renderGridSelection(field, cols, rows);
  }

  function previewGridDimensions(cols: number, rows: number): void {
    const handle = beginGridTransaction();
    if (!handle) return;
    handle.set({
      'grid-template-columns': formatGridTemplate(cols),
      'grid-template-rows': formatGridTemplate(rows),
    });
  }

  const gridField = fields['grid-dimensions'];
  if (gridField.kind === 'grid-dimensions') {
    disposer.listen(gridField.previewButton, 'click', (e: MouseEvent) => {
      e.preventDefault();
      setGridPopoverOpen(gridField, gridField.popover.hidden);
      if (!gridField.popover.hidden) {
        gridField.colsContainer.input.focus();
        gridField.colsContainer.input.select();
      }
    });

    // Close popover when clicking outside
    // Use capture phase to catch clicks in Shadow DOM
    const rootNode = gridField.previewButton.getRootNode() as Document | ShadowRoot;
    const clickTarget = rootNode instanceof ShadowRoot ? rootNode : document;

    const handleOutsideClick = (e: Event): void => {
      if (gridField.kind !== 'grid-dimensions') return;
      if (gridField.popover.hidden) return;
      const target = e.target as Node;
      // Check if click is inside gridRow (which contains both button and popover)
      if (!gridRow.contains(target)) {
        setGridPopoverOpen(gridField, false);
      }
    };

    clickTarget.addEventListener('click', handleOutsideClick, true);
    disposer.add(() => {
      clickTarget.removeEventListener('click', handleOutsideClick, true);
    });

    // Inputs: live preview, blur commit, ESC rollback
    const wireGridInput = (input: HTMLInputElement) => {
      disposer.listen(input, 'input', () => {
        const cols = clampInt(
          parseInt(gridField.colsContainer.input.value || '1', 10) || 1,
          1,
          GRID_DIMENSION_MAX,
        );
        const rows = clampInt(
          parseInt(gridField.rowsContainer.input.value || '1', 10) || 1,
          1,
          GRID_DIMENSION_MAX,
        );
        renderGridSelection(gridField, cols, rows);
        previewGridDimensions(cols, rows);
      });

      disposer.listen(input, 'blur', () => {
        commitGridTransaction();
        syncAllFields();
      });

      disposer.listen(input, 'keydown', (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          commitGridTransaction();
          syncAllFields();
          return;
        }
        if (ev.key === 'Escape') {
          ev.preventDefault();
          rollbackGridTransaction();
          setGridPopoverOpen(gridField, false);
          syncField('grid-dimensions', true);
        }
      });
    };

    wireGridInput(gridField.colsContainer.input);
    wireGridInput(gridField.rowsContainer.input);

    // Matrix hover + click select
    disposer.listen(gridField.matrix, 'mouseover', (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      const cell = el.closest('.we-grid-dimensions-cell') as HTMLButtonElement | null;
      if (!cell) return;
      gridHoverCols = clampInt(parseInt(cell.dataset.col ?? '1', 10) || 1, 1, GRID_DIMENSION_MAX);
      gridHoverRows = clampInt(parseInt(cell.dataset.row ?? '1', 10) || 1, 1, GRID_DIMENSION_MAX);
      const cols = clampInt(
        parseInt(gridField.colsContainer.input.value || '1', 10) || 1,
        1,
        GRID_DIMENSION_MAX,
      );
      const rows = clampInt(
        parseInt(gridField.rowsContainer.input.value || '1', 10) || 1,
        1,
        GRID_DIMENSION_MAX,
      );
      renderGridSelection(gridField, cols, rows);
    });

    disposer.listen(gridField.matrix, 'mouseleave', () => {
      gridHoverCols = null;
      gridHoverRows = null;
      const cols = clampInt(
        parseInt(gridField.colsContainer.input.value || '1', 10) || 1,
        1,
        GRID_DIMENSION_MAX,
      );
      const rows = clampInt(
        parseInt(gridField.rowsContainer.input.value || '1', 10) || 1,
        1,
        GRID_DIMENSION_MAX,
      );
      renderGridSelection(gridField, cols, rows);
    });

    disposer.listen(gridField.matrix, 'click', (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      const cell = el.closest('.we-grid-dimensions-cell') as HTMLButtonElement | null;
      if (!cell) return;
      const cols = clampInt(parseInt(cell.dataset.col ?? '1', 10) || 1, 1, GRID_DIMENSION_MAX);
      const rows = clampInt(parseInt(cell.dataset.row ?? '1', 10) || 1, 1, GRID_DIMENSION_MAX);
      gridField.colsContainer.input.value = String(cols);
      gridField.rowsContainer.input.value = String(rows);
      previewGridDimensions(cols, rows);
      commitGridTransaction();
      setGridPopoverOpen(gridField, false);
      syncAllFields();
    });
  }

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
