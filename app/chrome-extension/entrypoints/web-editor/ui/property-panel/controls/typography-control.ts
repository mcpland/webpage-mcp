/**
 * Typography Control (Phase 3.7)
 *
 * Edits inline typography styles:
 * - font-family (select + custom input)
 * - font-size (input)
 * - font-weight (select)
 * - line-height (input)
 * - letter-spacing (input)
 * - text-align (icon button group)
 * - vertical-align (icon button group)
 * - color (input with optional token picker)
 *
 * Phase 5.4: Added optional DesignTokensService integration for color field.
 */

import { Disposer } from '../../../utils/disposables';
import type { StyleTransactionHandle, TransactionManager } from '../../../core/transaction-manager';
import type { DesignTokensService } from '../../../core/design-tokens';
import { createColorField, type ColorField } from './color-field';
import { createGradientControl } from './gradient-control';
import { createInputContainer, type InputContainer } from '../components/input-container';
import { createIconButtonGroup, type IconButtonGroup } from '../components/icon-button-group';
import { combineLengthValue, formatLengthForDisplay, hasExplicitUnit } from './css-helpers';
import { wireNumberStepping } from './number-stepping';
import type { DesignControl } from '../types';

// =============================================================================
// Constants
// =============================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';

const FONT_WEIGHT_VALUES = ['100', '200', '300', '400', '500', '600', '700', '800', '900'] as const;
const TEXT_ALIGN_VALUES = ['left', 'center', 'right', 'justify'] as const;
const VERTICAL_ALIGN_VALUES = ['baseline', 'middle', 'top', 'bottom'] as const;

/** Text color type: solid uses 'color' property, gradient uses background-clip: text */
const TEXT_COLOR_TYPE_VALUES = ['solid', 'gradient'] as const;
type TextColorType = (typeof TEXT_COLOR_TYPE_VALUES)[number];

type TextAlignValue = (typeof TEXT_ALIGN_VALUES)[number];
type VerticalAlignValue = (typeof VERTICAL_ALIGN_VALUES)[number];
const FONT_FAMILY_PRESET_VALUES = [
  'inherit',
  'system-ui',
  'sans-serif',
  'serif',
  'monospace',
] as const;
const FONT_FAMILY_CUSTOM_VALUE = 'custom';

type TypographyProperty =
  | 'font-family'
  | 'font-size'
  | 'font-weight'
  | 'line-height'
  | 'letter-spacing'
  | 'text-align'
  | 'vertical-align'
  | 'color';

/** Standard input/select field state */
interface StandardFieldState {
  kind: 'standard';
  property: TypographyProperty;
  element: HTMLSelectElement | HTMLInputElement;
  handle: StyleTransactionHandle | null;
  /** InputContainer reference for input fields (null/undefined for selects) */
  container?: InputContainer;
}

/** Font-family field state (preset select + optional custom input) */
interface FontFamilyFieldState {
  kind: 'font-family';
  property: 'font-family';
  select: HTMLSelectElement;
  custom: InputContainer;
  controlsContainer: HTMLElement;
  handle: StyleTransactionHandle | null;
}

/** Text-align field state (icon button group) */
interface TextAlignFieldState {
  kind: 'text-align';
  property: 'text-align';
  group: IconButtonGroup<TextAlignValue>;
  handle: StyleTransactionHandle | null;
}

/** Vertical-align field state (icon button group) */
interface VerticalAlignFieldState {
  kind: 'vertical-align';
  property: 'vertical-align';
  group: IconButtonGroup<VerticalAlignValue>;
  handle: StyleTransactionHandle | null;
}

/** Color field state */
interface ColorFieldState {
  kind: 'color';
  property: TypographyProperty;
  field: ColorField;
  handle: StyleTransactionHandle | null;
}

type FieldState =
  | StandardFieldState
  | FontFamilyFieldState
  | TextAlignFieldState
  | VerticalAlignFieldState
  | ColorFieldState;

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

function createTextAlignIcon(value: TextAlignValue): SVGElement {
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

  // Text line position config: [x-start, width] for each line
  const lineConfigs: Record<TextAlignValue, Array<[number, number]>> = {
    left: [
      [3.5, 8], // Long line
      [3.5, 5], // Short line
      [3.5, 6.5], // Medium line
    ],
    center: [
      [3.5, 8], // Long line centered
      [5, 5], // Short line centered
      [4.25, 6.5], // Medium line centered
    ],
    right: [
      [3.5, 8], // Long line
      [6.5, 5], // Short line right-aligned
      [5.5, 6.5], // Medium line right-aligned
    ],
    justify: [
      [3.5, 8], // Full width
      [3.5, 8], // Full width
      [3.5, 8], // Full width
    ],
  };

  const yPositions = [4.5, 7.5, 10.5];
  const configs = lineConfigs[value];

  configs.forEach(([x, width], index) => {
    const line = document.createElementNS(SVG_NS, 'rect');
    line.setAttribute('x', String(x));
    line.setAttribute('y', String(yPositions[index] - 0.5));
    line.setAttribute('width', String(width));
    line.setAttribute('height', '1');
    line.setAttribute('rx', '0.5');
    line.setAttribute('fill', 'currentColor');
    svg.append(line);
  });

  svg.prepend(container);
  return svg;
}

function createVerticalAlignIcon(value: VerticalAlignValue): SVGElement {
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
  const blockY: Record<VerticalAlignValue, number> = {
    top: 3.5, // Top aligned
    middle: 5.5, // Center aligned
    bottom: 7.5, // Bottom aligned
    baseline: 6.5, // Baseline slightly lower
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

  // Add baseline indicator line in baseline mode
  if (value === 'baseline') {
    const baselinePath = document.createElementNS(SVG_NS, 'path');
    baselinePath.setAttribute('d', 'M3 10H12');
    baselinePath.setAttribute('stroke', 'currentColor');
    baselinePath.setAttribute('stroke-width', '1');
    baselinePath.setAttribute('stroke-dasharray', '1.5 1');
    svg.append(baselinePath);
  }

  return svg;
}

function isTextAlignValue(value: string): value is TextAlignValue {
  return (TEXT_ALIGN_VALUES as readonly string[]).includes(value);
}

function isVerticalAlignValue(value: string): value is VerticalAlignValue {
  return (VERTICAL_ALIGN_VALUES as readonly string[]).includes(value);
}

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

/**
 * Normalize line-height value.
 * Keeps unitless numbers as-is (e.g., "1.5" stays "1.5", not "1.5px")
 * because unitless line-height is relative to font-size.
 */
function normalizeLineHeight(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Keep unitless numbers as-is for line-height
  return trimmed;
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
 * Check if a value is a gradient background-image.
 */
function isGradientBackgroundValue(raw: string): boolean {
  return /\b(?:linear|radial|conic)-gradient\s*\(/i.test(raw.trim());
}

/**
 * Check if text-fill-color is transparent (for gradient text detection).
 */
function isTransparentTextFillColor(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (!v) return false;
  if (v === 'transparent') return true;
  // Some browsers compute transparent as rgba(..., 0)
  if (/^rgba\([^)]*,\s*0\s*\)$/.test(v)) return true;
  return false;
}

/**
 * Infer text color type from element's computed styles.
 * Returns 'gradient' if background-clip: text pattern is detected.
 */
function inferTextColorType(target: Element): TextColorType {
  const bgImage =
    readInlineValue(target, 'background-image') || readComputedValue(target, 'background-image');
  const bgClip =
    readInlineValue(target, '-webkit-background-clip') ||
    readComputedValue(target, '-webkit-background-clip');
  const textFill =
    readInlineValue(target, '-webkit-text-fill-color') ||
    readComputedValue(target, '-webkit-text-fill-color');

  const hasGradientBg =
    bgImage && bgImage.toLowerCase() !== 'none' && isGradientBackgroundValue(bgImage);
  const hasClipText = bgClip.toLowerCase().includes('text');
  const hasTransparentFill = isTransparentTextFillColor(textFill);

  return hasGradientBg && hasClipText && hasTransparentFill ? 'gradient' : 'solid';
}

// =============================================================================
// Factory
// =============================================================================

export interface TypographyControlOptions {
  container: HTMLElement;
  transactionManager: TransactionManager;
  /** Optional: DesignTokensService for token picker integration (Phase 5.4) */
  tokensService?: DesignTokensService;
}

export function createTypographyControl(options: TypographyControlOptions): DesignControl {
  const { container, transactionManager, tokensService } = options;
  const disposer = new Disposer();

  let currentTarget: Element | null = null;
  let currentTextColorType: TextColorType = 'solid';

  const root = document.createElement('div');
  root.className = 'we-field-group';

  // ---------------------------------------------------------------------------
  // Font Family (preset select + optional custom input)
  // ---------------------------------------------------------------------------
  const fontFamilyRow = document.createElement('div');
  fontFamilyRow.className = 'we-field';
  const fontFamilyLabel = document.createElement('span');
  fontFamilyLabel.className = 'we-field-label';
  fontFamilyLabel.textContent = 'Font';

  const fontFamilyControls = document.createElement('div');
  fontFamilyControls.className = 'we-field-content';
  fontFamilyControls.style.display = 'flex';
  fontFamilyControls.style.flexDirection = 'column';
  fontFamilyControls.style.gap = '4px';

  const fontFamilySelect = document.createElement('select');
  fontFamilySelect.className = 'we-select';
  fontFamilySelect.setAttribute('aria-label', 'Font Family');
  for (const v of FONT_FAMILY_PRESET_VALUES) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    fontFamilySelect.append(opt);
  }
  const customFontOpt = document.createElement('option');
  customFontOpt.value = FONT_FAMILY_CUSTOM_VALUE;
  customFontOpt.textContent = 'Custom…';
  fontFamilySelect.append(customFontOpt);

  const fontFamilyCustomContainer = createInputContainer({
    ariaLabel: 'Custom Font Family',
    prefix: null,
    suffix: null,
    placeholder: 'e.g. Inter, system-ui',
  });
  fontFamilyCustomContainer.root.style.display = 'none';
  fontFamilyCustomContainer.input.disabled = true;

  fontFamilyControls.append(fontFamilySelect, fontFamilyCustomContainer.root);
  fontFamilyRow.append(fontFamilyLabel, fontFamilyControls);

  // ---------------------------------------------------------------------------
  // Font Size (with input-container for suffix support)
  // ---------------------------------------------------------------------------
  const fontSizeRow = document.createElement('div');
  fontSizeRow.className = 'we-field';
  const fontSizeLabel = document.createElement('span');
  fontSizeLabel.className = 'we-field-label';
  fontSizeLabel.textContent = 'Size';
  const fontSizeContainer = createInputContainer({
    ariaLabel: 'Font Size',
    inputMode: 'decimal',
    prefix: null,
    suffix: 'px',
  });
  fontSizeRow.append(fontSizeLabel, fontSizeContainer.root);

  // Font Weight
  const fontWeightRow = document.createElement('div');
  fontWeightRow.className = 'we-field';
  const fontWeightLabel = document.createElement('span');
  fontWeightLabel.className = 'we-field-label';
  fontWeightLabel.textContent = 'Weight';
  const fontWeightSelect = document.createElement('select');
  fontWeightSelect.className = 'we-select';
  fontWeightSelect.setAttribute('aria-label', 'Font Weight');
  for (const v of FONT_WEIGHT_VALUES) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    fontWeightSelect.append(opt);
  }
  fontWeightRow.append(fontWeightLabel, fontWeightSelect);

  // Line Height (with input-container, suffix only shown if value has unit)
  const lineHeightRow = document.createElement('div');
  lineHeightRow.className = 'we-field';
  const lineHeightLabel = document.createElement('span');
  lineHeightLabel.className = 'we-field-label';
  lineHeightLabel.textContent = 'Line Height';
  const lineHeightContainer = createInputContainer({
    ariaLabel: 'Line Height',
    inputMode: 'decimal',
    prefix: null,
    suffix: null, // Will be set dynamically based on value
  });
  lineHeightRow.append(lineHeightLabel, lineHeightContainer.root);

  // ---------------------------------------------------------------------------
  // Letter Spacing
  // ---------------------------------------------------------------------------
  const letterSpacingRow = document.createElement('div');
  letterSpacingRow.className = 'we-field';
  const letterSpacingLabel = document.createElement('span');
  letterSpacingLabel.className = 'we-field-label';
  letterSpacingLabel.textContent = 'Spacing';
  const letterSpacingContainer = createInputContainer({
    ariaLabel: 'Letter Spacing',
    inputMode: 'decimal',
    prefix: null,
    suffix: 'px',
  });
  letterSpacingRow.append(letterSpacingLabel, letterSpacingContainer.root);

  // Wire up keyboard stepping for arrow up/down
  wireNumberStepping(disposer, fontSizeContainer.input, { mode: 'css-length' });
  wireNumberStepping(disposer, lineHeightContainer.input, {
    mode: 'css-length',
    step: 0.1,
    shiftStep: 1,
    altStep: 0.01,
  });
  wireNumberStepping(disposer, letterSpacingContainer.input, {
    mode: 'css-length',
    step: 0.1,
    shiftStep: 1,
    altStep: 0.01,
  });

  // ---------------------------------------------------------------------------
  // Text Align (icon button group)
  // ---------------------------------------------------------------------------
  const textAlignRow = document.createElement('div');
  textAlignRow.className = 'we-field';
  const textAlignLabel = document.createElement('span');
  textAlignLabel.className = 'we-field-label';
  textAlignLabel.textContent = 'Text Align';
  const textAlignMount = document.createElement('div');
  textAlignMount.className = 'we-field-content';
  textAlignRow.append(textAlignLabel, textAlignMount);

  // ---------------------------------------------------------------------------
  // Vertical Align (icon button group)
  // ---------------------------------------------------------------------------
  const verticalAlignRow = document.createElement('div');
  verticalAlignRow.className = 'we-field';
  const verticalAlignLabel = document.createElement('span');
  verticalAlignLabel.className = 'we-field-label';
  verticalAlignLabel.textContent = 'Vertical Align';
  const verticalAlignMount = document.createElement('div');
  verticalAlignMount.className = 'we-field-content';
  verticalAlignRow.append(verticalAlignLabel, verticalAlignMount);

  // ---------------------------------------------------------------------------
  // Text Color Type selector (solid / gradient)
  // ---------------------------------------------------------------------------
  const textColorTypeRow = document.createElement('div');
  textColorTypeRow.className = 'we-field';

  const textColorTypeLabel = document.createElement('span');
  textColorTypeLabel.className = 'we-field-label';
  textColorTypeLabel.textContent = 'Type';

  const textColorTypeSelect = document.createElement('select');
  textColorTypeSelect.className = 'we-select';
  textColorTypeSelect.setAttribute('aria-label', 'Text Color Type');
  for (const v of TEXT_COLOR_TYPE_VALUES) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v.charAt(0).toUpperCase() + v.slice(1);
    textColorTypeSelect.append(opt);
  }
  textColorTypeRow.append(textColorTypeLabel, textColorTypeSelect);

  // ---------------------------------------------------------------------------
  // Color (with ColorField - TokenPill and TokenPicker are now built into ColorField)
  // ---------------------------------------------------------------------------
  const colorRow = document.createElement('div');
  colorRow.className = 'we-field';

  const colorLabel = document.createElement('span');
  colorLabel.className = 'we-field-label';
  colorLabel.textContent = 'Color';

  const colorFieldContainer = document.createElement('div');
  colorFieldContainer.style.minWidth = '0';

  colorRow.append(colorLabel, colorFieldContainer);

  // Gradient mount for text gradient (uses background-image + background-clip: text)
  const textGradientMount = document.createElement('div');

  // Create combined row for Size and Weight
  const sizeAndWeightRow = document.createElement('div');
  sizeAndWeightRow.className = 'we-field-row';
  fontSizeRow.style.flex = '1';
  fontSizeRow.style.minWidth = '0';
  fontWeightRow.style.flex = '1';
  fontWeightRow.style.minWidth = '0';
  sizeAndWeightRow.append(fontSizeRow, fontWeightRow);

  // Create combined row for Line Height and Spacing
  const lineHeightAndSpacingRow = document.createElement('div');
  lineHeightAndSpacingRow.className = 'we-field-row';
  lineHeightRow.style.flex = '1';
  lineHeightRow.style.minWidth = '0';
  letterSpacingRow.style.flex = '1';
  letterSpacingRow.style.minWidth = '0';
  lineHeightAndSpacingRow.append(lineHeightRow, letterSpacingRow);

  root.append(
    fontFamilyRow,
    sizeAndWeightRow,
    lineHeightAndSpacingRow,
    textAlignRow,
    verticalAlignRow,
    textColorTypeRow,
    colorRow,
    textGradientMount,
  );
  container.append(root);
  disposer.add(() => root.remove());

  // -------------------------------------------------------------------------
  // Create IconButtonGroup instances for text-align and vertical-align
  // -------------------------------------------------------------------------
  const textAlignGroup = createIconButtonGroup<TextAlignValue>({
    container: textAlignMount,
    ariaLabel: 'Text Align',
    columns: 4,
    items: TEXT_ALIGN_VALUES.map((v) => ({
      value: v,
      ariaLabel: `text-align: ${v}`,
      title: v.charAt(0).toUpperCase() + v.slice(1),
      icon: createTextAlignIcon(v),
    })),
    onChange: (value) => {
      const handle = beginTransaction('text-align');
      if (handle) handle.set(value);
      commitTransaction('text-align');
      syncAllFields();
    },
  });
  disposer.add(() => textAlignGroup.dispose());

  const verticalAlignGroup = createIconButtonGroup<VerticalAlignValue>({
    container: verticalAlignMount,
    ariaLabel: 'Vertical Align',
    columns: 4,
    items: VERTICAL_ALIGN_VALUES.map((v) => ({
      value: v,
      ariaLabel: `vertical-align: ${v}`,
      title: v.charAt(0).toUpperCase() + v.slice(1),
      icon: createVerticalAlignIcon(v),
    })),
    onChange: (value) => {
      const handle = beginTransaction('vertical-align');
      if (handle) handle.set(value);
      commitTransaction('vertical-align');
      syncAllFields();
    },
  });
  disposer.add(() => verticalAlignGroup.dispose());

  // -------------------------------------------------------------------------
  // Create ColorField instance for text color
  // (TokenPill and TokenPicker are built into ColorField when tokensService is provided)
  // -------------------------------------------------------------------------
  const textColorField = createColorField({
    container: colorFieldContainer,
    ariaLabel: 'Text Color',
    tokensService,
    getTokenTarget: () => currentTarget,
    onInput: (value) => {
      const handle = beginTransaction('color');
      if (handle) handle.set(value);
    },
    onCommit: () => {
      commitTransaction('color');
      syncAllFields();
    },
    onCancel: () => {
      rollbackTransaction('color');
      syncField('color', true);
    },
  });
  disposer.add(() => textColorField.dispose());

  // -------------------------------------------------------------------------
  // Text Gradient Control (uses background-image + background-clip: text)
  // Note: This intentionally uses background-image which may conflict with
  // Background control. Users should be aware that text gradient and element
  // background cannot be used simultaneously on the same element.
  // -------------------------------------------------------------------------
  const textGradientControl = createGradientControl({
    container: textGradientMount,
    transactionManager,
    tokensService,
    property: 'background-image',
    // Disable 'none' option since transparent text-fill-color with no background
    // would make text invisible
    allowNone: false,
  });
  disposer.add(() => textGradientControl.dispose());

  // -------------------------------------------------------------------------
  // Field state map
  // -------------------------------------------------------------------------
  const fields: Record<TypographyProperty, FieldState> = {
    'font-family': {
      kind: 'font-family',
      property: 'font-family',
      select: fontFamilySelect,
      custom: fontFamilyCustomContainer,
      controlsContainer: fontFamilyControls,
      handle: null,
    },
    'font-size': {
      kind: 'standard',
      property: 'font-size',
      element: fontSizeContainer.input,
      container: fontSizeContainer,
      handle: null,
    },
    'font-weight': {
      kind: 'standard',
      property: 'font-weight',
      element: fontWeightSelect,
      handle: null,
    },
    'line-height': {
      kind: 'standard',
      property: 'line-height',
      element: lineHeightContainer.input,
      container: lineHeightContainer,
      handle: null,
    },
    'letter-spacing': {
      kind: 'standard',
      property: 'letter-spacing',
      element: letterSpacingContainer.input,
      container: letterSpacingContainer,
      handle: null,
    },
    'text-align': {
      kind: 'text-align',
      property: 'text-align',
      group: textAlignGroup,
      handle: null,
    },
    'vertical-align': {
      kind: 'vertical-align',
      property: 'vertical-align',
      group: verticalAlignGroup,
      handle: null,
    },
    color: { kind: 'color', property: 'color', field: textColorField, handle: null },
  };

  const PROPS: readonly TypographyProperty[] = [
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'letter-spacing',
    'text-align',
    'vertical-align',
    'color',
  ];

  function beginTransaction(property: TypographyProperty): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;
    const target = currentTarget;
    if (!target || !target.isConnected) return null;
    const field = fields[property];
    if (field.handle) return field.handle;
    const handle = transactionManager.beginStyle(target, property);
    field.handle = handle;
    return handle;
  }

  function commitTransaction(property: TypographyProperty): void {
    const field = fields[property];
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackTransaction(property: TypographyProperty): void {
    const field = fields[property];
    const handle = field.handle;
    field.handle = null;
    if (handle) handle.rollback();
  }

  function commitAllTransactions(): void {
    for (const p of PROPS) commitTransaction(p);
  }

  // -------------------------------------------------------------------------
  // Text Color Type (Solid / Gradient)
  // -------------------------------------------------------------------------

  /**
   * Update visibility of color-related rows based on currentTextColorType.
   */
  function updateTextColorTypeVisibility(): void {
    colorRow.hidden = currentTextColorType !== 'solid';
    textGradientMount.hidden = currentTextColorType !== 'gradient';
  }

  /**
   * Set text color type and apply necessary CSS changes.
   * Uses multiStyle transaction to atomically set background-clip text properties.
   */
  function setTextColorType(type: TextColorType): void {
    const target = currentTarget;

    currentTextColorType = type;
    textColorTypeSelect.value = type;
    updateTextColorTypeVisibility();

    if (!target || !target.isConnected) return;

    // Ensure we don't leave an open 'color' handle when switching modes
    commitTransaction('color');

    // Use multiStyle to atomically manage text gradient properties
    const handle = transactionManager.beginMultiStyle(target, [
      'background-image',
      '-webkit-background-clip',
      '-webkit-text-fill-color',
    ]);
    if (!handle) return;

    if (type === 'solid') {
      // Clear text gradient properties when switching to solid color
      handle.set({
        'background-image': '',
        '-webkit-background-clip': '',
        '-webkit-text-fill-color': '',
      });
    } else {
      // Set up text gradient properties
      const inlineBg = readInlineValue(target, 'background-image');
      const computedBg = readComputedValue(target, 'background-image');
      const currentBg = inlineBg || computedBg;

      // Use existing gradient or provide a default
      const hasValidGradient = currentBg && isGradientBackgroundValue(currentBg);
      const gradientValue = hasValidGradient
        ? currentBg
        : 'linear-gradient(90deg, #000000, #ffffff)';

      handle.set({
        'background-image': gradientValue,
        '-webkit-background-clip': 'text',
        '-webkit-text-fill-color': 'transparent',
      });
    }

    handle.commit({ merge: true });
  }

  // Wire text color type selector change event
  disposer.listen(textColorTypeSelect, 'change', () => {
    const type = textColorTypeSelect.value as TextColorType;
    setTextColorType(type);
    textGradientControl.refresh();
    syncAllFields();
  });

  function syncField(property: TypographyProperty, force = false): void {
    const field = fields[property];
    const target = currentTarget;

    // Handle font-family field (preset select + custom input)
    if (field.kind === 'font-family') {
      const presetValues = FONT_FAMILY_PRESET_VALUES as readonly string[];

      if (!target || !target.isConnected) {
        field.select.disabled = true;
        field.select.value = presetValues[0] ?? 'inherit';
        field.custom.input.disabled = true;
        field.custom.input.value = '';
        field.custom.root.style.display = 'none';
        return;
      }

      field.select.disabled = false;

      const isEditing =
        field.handle !== null || isFieldFocused(field.select) || isFieldFocused(field.custom.input);
      if (isEditing && !force) return;

      const inlineValue = readInlineValue(target, property);
      const displayValue = inlineValue || readComputedValue(target, property);
      const normalized = displayValue.trim().toLowerCase();

      if (presetValues.includes(normalized)) {
        field.select.value = normalized;
        field.custom.root.style.display = 'none';
        field.custom.input.disabled = true;
      } else {
        field.select.value = FONT_FAMILY_CUSTOM_VALUE;
        field.custom.root.style.display = '';
        field.custom.input.disabled = false;
        field.custom.input.value = displayValue;
      }
      return;
    }

    // Handle text-align (icon button group)
    if (field.kind === 'text-align') {
      const group = field.group;

      if (!target || !target.isConnected) {
        group.setDisabled(true);
        group.setValue(null);
        return;
      }

      group.setDisabled(false);
      const isEditing = field.handle !== null;
      if (isEditing && !force) return;

      const inlineValue = readInlineValue(target, property);
      const computedValue = readComputedValue(target, property);
      const raw = (inlineValue || computedValue).trim();
      group.setValue(isTextAlignValue(raw) ? raw : 'left');
      return;
    }

    // Handle vertical-align (icon button group)
    if (field.kind === 'vertical-align') {
      const group = field.group;

      if (!target || !target.isConnected) {
        group.setDisabled(true);
        group.setValue(null);
        return;
      }

      group.setDisabled(false);
      const isEditing = field.handle !== null;
      if (isEditing && !force) return;

      const inlineValue = readInlineValue(target, property);
      const computedValue = readComputedValue(target, property);
      const raw = (inlineValue || computedValue).trim();
      // Default to baseline if value is not in our common values
      group.setValue(isVerticalAlignValue(raw) ? raw : 'baseline');
      return;
    }

    if (field.kind === 'color') {
      // Handle ColorField
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

      // Display real value: prefer inline style, fallback to computed style
      const inlineValue = readInlineValue(target, property);
      const computedValue = readComputedValue(target, property);
      if (inlineValue) {
        colorField.setValue(inlineValue);
        // Pass computed value as placeholder when using CSS variables
        // so color-field can resolve the actual color for swatch display
        colorField.setPlaceholder(/\bvar\s*\(/i.test(inlineValue) ? computedValue : '');
      } else {
        colorField.setValue(computedValue);
        colorField.setPlaceholder('');
      }
      return;
    }

    // Handle standard input/select (remaining fields)
    const el = field.element;

    if (!target || !target.isConnected) {
      el.disabled = true;
      if (el instanceof HTMLInputElement) {
        el.value = '';
        el.placeholder = '';
        // Reset suffix to defaults
        if (field.container) {
          if (property === 'font-size' || property === 'letter-spacing') {
            field.container.setSuffix('px');
          } else if (property === 'line-height') {
            field.container.setSuffix(null);
          }
        }
      }
      return;
    }

    el.disabled = false;
    const isEditing = field.handle !== null || isFieldFocused(el);

    if (el instanceof HTMLInputElement) {
      if (isEditing && !force) return;

      const inlineValue = readInlineValue(target, property);
      const displayValue = inlineValue || readComputedValue(target, property);

      // Update value and suffix dynamically
      if (field.container) {
        if (property === 'font-size' || property === 'letter-spacing') {
          const formatted = formatLengthForDisplay(displayValue);
          el.value = formatted.value;
          field.container.setSuffix(formatted.suffix);
        } else if (property === 'line-height') {
          // Line-height: only show suffix if value has explicit unit
          if (hasExplicitUnit(displayValue)) {
            const formatted = formatLengthForDisplay(displayValue);
            el.value = formatted.value;
            field.container.setSuffix(formatted.suffix);
          } else {
            el.value = displayValue;
            field.container.setSuffix(null);
          }
        } else {
          el.value = displayValue;
        }
      } else {
        el.value = displayValue;
      }
      el.placeholder = '';
    } else {
      const inline = readInlineValue(target, property);
      const computed = readComputedValue(target, property);
      if (isEditing && !force) return;
      const val = inline || computed;
      const hasOption = Array.from(el.options).some((o) => o.value === val);
      el.value = hasOption ? val : (el.options[0]?.value ?? '');
    }
  }

  function syncAllFields(): void {
    for (const p of PROPS) syncField(p);
    const hasTarget = Boolean(currentTarget && currentTarget.isConnected);
    textColorTypeSelect.disabled = !hasTarget;
    updateTextColorTypeVisibility();
  }

  function wireSelect(property: TypographyProperty): void {
    const field = fields[property];
    if (field.kind !== 'standard') return;

    const select = field.element as HTMLSelectElement;

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

  function wireInput(
    property: TypographyProperty,
    normalize: (v: string, suffix: string | null) => string = (v) => v.trim(),
  ): void {
    const field = fields[property];
    if (field.kind !== 'standard') return;

    const input = field.element as HTMLInputElement;

    disposer.listen(input, 'input', () => {
      const handle = beginTransaction(property);
      if (!handle) return;
      // Get current suffix from container to preserve unit
      const suffix = field.container?.getSuffixText() ?? null;
      handle.set(normalize(input.value, suffix));
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

  // ---------------------------------------------------------------------------
  // Wire font-family (preset select + custom input)
  // ---------------------------------------------------------------------------
  function wireFontFamily(): void {
    const field = fields['font-family'];
    if (field.kind !== 'font-family') return;

    const { select, custom, controlsContainer } = field;

    const updateCustomVisibility = () => {
      const isCustom = select.value === FONT_FAMILY_CUSTOM_VALUE;
      custom.root.style.display = isCustom ? '' : 'none';
      custom.input.disabled = !isCustom;
      if (isCustom) custom.input.focus();
    };

    const previewSelect = () => {
      updateCustomVisibility();
      if (select.value === FONT_FAMILY_CUSTOM_VALUE) return;
      const handle = beginTransaction('font-family');
      if (handle) handle.set(select.value);
    };

    disposer.listen(select, 'input', previewSelect);
    disposer.listen(select, 'change', previewSelect);

    disposer.listen(custom.input, 'input', () => {
      const handle = beginTransaction('font-family');
      if (handle) handle.set(custom.input.value.trim());
    });

    // Commit when focus leaves the whole font-family control
    disposer.listen(controlsContainer, 'focusout', (e: FocusEvent) => {
      const next = e.relatedTarget;
      if (next instanceof Node && controlsContainer.contains(next)) return;
      commitTransaction('font-family');
      syncAllFields();
    });

    disposer.listen(select, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTransaction('font-family');
        syncAllFields();
        select.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rollbackTransaction('font-family');
        syncField('font-family', true);
      }
    });

    disposer.listen(custom.input, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTransaction('font-family');
        syncAllFields();
        custom.input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rollbackTransaction('font-family');
        syncField('font-family', true);
      }
    });
  }

  // Wire standard inputs/selects (color field is wired via its own callbacks)
  // Note: text-align and vertical-align are now handled by IconButtonGroup with onChange callbacks
  wireFontFamily();
  wireInput('font-size', combineLengthValue);
  wireSelect('font-weight');
  // line-height is special: can be unitless (like 1.5) or with unit (like 24px)
  wireInput('line-height', (v, suffix) => {
    const trimmed = v.trim();
    if (!trimmed) return '';
    // If user typed a unit explicitly (like "24px"), use as-is
    if (/[a-zA-Z%]/.test(trimmed)) return trimmed;
    // For pure numbers, append suffix if exists, otherwise keep unitless
    return suffix ? `${trimmed}${suffix}` : trimmed;
  });
  wireInput('letter-spacing', combineLengthValue);

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;
    if (element !== currentTarget) commitAllTransactions();
    currentTarget = element;

    // Infer text color type from element styles
    if (element && element.isConnected) {
      currentTextColorType = inferTextColorType(element);
    } else {
      currentTextColorType = 'solid';
    }
    textColorTypeSelect.value = currentTextColorType;
    updateTextColorTypeVisibility();

    // Update gradient control target
    textGradientControl.setTarget(element);
    syncAllFields();
    // Token picker target is now managed by ColorField internally via getTokenTarget callback
  }

  function refresh(): void {
    if (disposer.isDisposed) return;

    // Re-infer text color type from element to handle external changes (CSS panel, Undo/Redo)
    const target = currentTarget;
    if (target && target.isConnected) {
      const inferredType = inferTextColorType(target);
      if (inferredType !== currentTextColorType) {
        currentTextColorType = inferredType;
        textColorTypeSelect.value = inferredType;
      }
    }

    textGradientControl.refresh();
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
