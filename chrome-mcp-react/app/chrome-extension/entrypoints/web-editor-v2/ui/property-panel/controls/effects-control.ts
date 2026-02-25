/**
 * Effects Control
 *
 * Current scope:
 * - Inline `box-shadow` list editor (Drop Shadow / Inner Shadow)
 *
 * Features:
 * - Add/remove multiple shadow effects
 * - Toggle visibility (hide/show) per shadow
 * - Adjust panel for detailed editing (type, offset, blur, spread, color)
 *
 * Notes:
 * - Rendering reads inline styles only (no computed fallback)
 * - Hidden shadows are kept in memory for the current editor session
 */

import { Disposer } from '../../../utils/disposables';
import type { StyleTransactionHandle, TransactionManager } from '../../../core/transaction-manager';
import type { DesignTokensService } from '../../../core/design-tokens';
import { createInputContainer, type InputContainer } from '../components/input-container';
import { createColorField, type ColorField } from './color-field';
import { combineLengthValue, formatLengthForDisplay } from './css-helpers';
import { wireNumberStepping } from './number-stepping';
import type { DesignControl } from '../types';

// =============================================================================
// Constants
// =============================================================================

const EFFECT_TYPES = [
  { value: 'drop-shadow', label: 'Drop Shadow' },
  { value: 'inner-shadow', label: 'Inner Shadow' },
  { value: 'layer-blur', label: 'Layer Blur' },
  { value: 'backdrop-blur', label: 'Backdrop Blur' },
] as const;

type EffectType = (typeof EFFECT_TYPES)[number]['value'];

type EffectsProperty = 'box-shadow' | 'filter' | 'backdrop-filter';

/**
 * Regex to match CSS length tokens (e.g., "10px", "-5.5em", "0")
 * Note: Does not match calc()/var() - those are treated as "other" tokens
 */
const LENGTH_TOKEN_REGEX = /^-?(?:\d+\.?\d*|\.\d+)(?:[a-zA-Z%]+)?$/;

/** Check if a token looks like a CSS function call (e.g., calc(), var()) */
function isCssFunctionToken(token: string): boolean {
  return /^[a-zA-Z_-]+\s*\(/.test(token);
}

// =============================================================================
// Types
// =============================================================================

interface ParsedBoxShadow {
  inset: boolean;
  offsetX: string;
  offsetY: string;
  blurRadius: string;
  spreadRadius: string;
  color: string;
}

interface CssFunctionMatch {
  start: number;
  end: number;
  args: string;
}

// =============================================================================
// CSS Parsing Helpers
// =============================================================================

/**
 * Check if an element is focused within Shadow DOM context
 */
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
 * Normalize a length value to include "px" unit if missing
 */
function normalizeLength(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return '';

  // Pure number: add "px" unit
  if (/^-?(?:\d+|\d*\.\d+)$/.test(trimmed)) return `${trimmed}px`;

  // Trailing dot: "10." -> "10px"
  if (/^-?\d+\.$/.test(trimmed)) return `${trimmed.slice(0, -1)}px`;

  return trimmed;
}

/**
 * Read inline style value from element
 */
function readInlineValue(element: Element, property: string): string {
  try {
    const style = (element as HTMLElement).style;
    return style?.getPropertyValue?.(property)?.trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * Read computed style value from element
 */
function readComputedValue(element: Element, property: string): string {
  try {
    return window.getComputedStyle(element).getPropertyValue(property).trim();
  } catch {
    return '';
  }
}

/**
 * Split a CSS value by a separator, respecting parentheses and quotes
 */
function splitTopLevel(value: string, separator: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escape = false;
  let start = 0;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\') {
      escape = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '(') {
      depth++;
      continue;
    }

    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth === 0 && ch === separator) {
      results.push(value.slice(start, i));
      start = i + 1;
    }
  }

  results.push(value.slice(start));
  return results;
}

/**
 * Tokenize a CSS value by whitespace, respecting parentheses and quotes
 */
function tokenizeTopLevel(value: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | null = null;
  let escape = false;
  let buffer = '';

  const flush = () => {
    const t = buffer.trim();
    if (t) tokens.push(t);
    buffer = '';
  };

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;

    if (escape) {
      buffer += ch;
      escape = false;
      continue;
    }

    if (ch === '\\') {
      buffer += ch;
      escape = true;
      continue;
    }

    if (quote) {
      buffer += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      buffer += ch;
      quote = ch;
      continue;
    }

    if (ch === '(') {
      depth++;
      buffer += ch;
      continue;
    }

    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      buffer += ch;
      continue;
    }

    if (depth === 0 && /\s/.test(ch)) {
      flush();
      continue;
    }

    buffer += ch;
  }

  flush();
  return tokens;
}

/**
 * Parse a single box-shadow value into components
 */
function parseBoxShadow(raw: string): ParsedBoxShadow | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return null;

  // Get the first shadow (before comma)
  const first = splitTopLevel(trimmed, ',')[0]?.trim() ?? '';
  if (!first || first.toLowerCase() === 'none') return null;

  const tokens = tokenizeTopLevel(first);
  if (tokens.length === 0) return null;

  let inset = false;
  const lengthTokens: string[] = [];
  const otherTokens: string[] = [];

  for (const token of tokens) {
    if (/^inset$/i.test(token)) {
      inset = true;
      continue;
    }

    // Pure length values (numbers with optional units)
    if (LENGTH_TOKEN_REGEX.test(token)) {
      lengthTokens.push(token);
    }
    // CSS functions like calc(), var() - treat as length if in length position
    else if (isCssFunctionToken(token) && lengthTokens.length < 4) {
      lengthTokens.push(token);
    } else {
      otherTokens.push(token);
    }
  }

  // Need at least 2 length values (offset-x, offset-y)
  if (lengthTokens.length < 2) return null;

  return {
    inset,
    offsetX: lengthTokens[0] ?? '',
    offsetY: lengthTokens[1] ?? '',
    blurRadius: lengthTokens[2] ?? '',
    spreadRadius: lengthTokens[3] ?? '',
    color: otherTokens.join(' ').trim(),
  };
}

/**
 * Format box-shadow components into CSS value
 */
function formatBoxShadow(input: {
  inset: boolean;
  offsetX: string;
  offsetY: string;
  blurRadius: string;
  spreadRadius: string;
  color: string;
}): string {
  const offsetX = normalizeLength(input.offsetX);
  const offsetY = normalizeLength(input.offsetY);
  const blurRadius = normalizeLength(input.blurRadius);
  const spreadRadius = normalizeLength(input.spreadRadius);
  const color = input.color.trim();

  // Return empty if no meaningful values
  if (!offsetX && !offsetY && !blurRadius && !spreadRadius && !color) return '';

  const parts: string[] = [];
  if (input.inset) parts.push('inset');

  parts.push(offsetX || '0px', offsetY || '0px');

  // Include blur if set or if spread is set
  if (blurRadius || spreadRadius) parts.push(blurRadius || '0px');
  if (spreadRadius) parts.push(spreadRadius);
  if (color) parts.push(color);

  return parts.join(' ');
}

/**
 * Update the first shadow in a comma-separated list, preserving others
 */
function upsertFirstShadow(existing: string, first: string): string {
  const base = existing.trim();
  const firstTrimmed = first.trim();

  const segments = base && base.toLowerCase() !== 'none' ? splitTopLevel(base, ',') : [];
  const tail = segments
    .slice(1)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!firstTrimmed) return tail.join(', ');
  if (tail.length === 0) return firstTrimmed;
  return `${firstTrimmed}, ${tail.join(', ')}`;
}

/**
 * Find a CSS function call (e.g., blur(...)) in a filter value
 * Handles word boundaries to avoid matching "myblur" when looking for "blur"
 */
function findCssFunction(value: string, fnName: string): CssFunctionMatch | null {
  const src = value;
  const lower = src.toLowerCase();
  const needle = fnName.toLowerCase();

  let searchIndex = 0;

  while (searchIndex < src.length) {
    const found = lower.indexOf(needle, searchIndex);
    if (found < 0) return null;

    // Check word boundary: must not be preceded by a letter/digit/underscore/hyphen
    if (found > 0) {
      const prevChar = src[found - 1]!;
      if (/[a-zA-Z0-9_-]/.test(prevChar)) {
        searchIndex = found + needle.length;
        continue;
      }
    }

    // Find opening parenthesis (allow whitespace)
    let i = found + needle.length;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] !== '(') {
      searchIndex = found + needle.length;
      continue;
    }

    const openIndex = i;
    let depth = 0;
    let quote: "'" | '"' | null = null;
    let escape = false;

    for (let j = openIndex; j < src.length; j++) {
      const ch = src[j]!;

      if (escape) {
        escape = false;
        continue;
      }

      if (ch === '\\') {
        escape = true;
        continue;
      }

      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }

      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }

      if (ch === '(') {
        depth++;
        continue;
      }

      if (ch === ')') {
        depth--;
        if (depth === 0) {
          return {
            start: found,
            end: j + 1,
            args: src.slice(openIndex + 1, j),
          };
        }
        continue;
      }
    }

    return null;
  }

  return null;
}

/**
 * Extract blur radius from filter/backdrop-filter value
 */
function parseBlurRadius(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return '';

  const match = findCssFunction(trimmed, 'blur');
  return match ? match.args.trim() : '';
}

/**
 * Update blur() function in filter value, preserving other functions
 */
function upsertBlurFunction(existing: string, radius: string): string {
  const base = existing.trim().toLowerCase() === 'none' ? '' : existing.trim();
  const match = base ? findCssFunction(base, 'blur') : null;

  const normalizedRadius = normalizeLength(radius);

  // Remove blur if radius is empty
  if (!normalizedRadius) {
    if (!match) return base;

    const left = base.slice(0, match.start).trimEnd();
    const right = base.slice(match.end).trimStart();
    if (left && right) return `${left} ${right}`.trim();
    return (left || right).trim();
  }

  const replacement = `blur(${normalizedRadius})`;

  // Add blur if not present
  if (!match) {
    if (!base) return replacement;
    return `${base} ${replacement}`.trim();
  }

  // Replace existing blur
  const left = base.slice(0, match.start).trimEnd();
  const right = base.slice(match.end).trimStart();
  const parts: string[] = [];
  if (left) parts.push(left);
  parts.push(replacement);
  if (right) parts.push(right);
  return parts.join(' ');
}

// =============================================================================
// Factory
// =============================================================================

export interface EffectsControlOptions {
  container: HTMLElement;
  transactionManager: TransactionManager;
  /** Optional: Design tokens service for TokenPill/TokenPicker integration (Phase 5.3) */
  tokensService?: DesignTokensService;
  /** Optional: Container element for header actions (e.g., add button) */
  headerActionsContainer?: HTMLElement;
}

/** @deprecated Use `createEffectsControl` (box-shadow list) instead. */
export function createLegacyEffectsControl(options: EffectsControlOptions): DesignControl {
  const { container, transactionManager, tokensService } = options;
  const disposer = new Disposer();

  let currentTarget: Element | null = null;
  let currentEffectType: EffectType = 'drop-shadow';
  let shadowColorValue = '';

  const handles: Record<EffectsProperty, StyleTransactionHandle | null> = {
    'box-shadow': null,
    filter: null,
    'backdrop-filter': null,
  };

  // Root container
  const root = document.createElement('div');
  root.className = 'we-field-group';

  // -------------------------------------------------------------------------
  // DOM Construction Helpers
  // -------------------------------------------------------------------------

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
    input.spellcheck = false;
    input.inputMode = 'decimal';
    input.setAttribute('aria-label', ariaLabel);

    row.append(label, input);
    return { row, input };
  }

  function createSelectRow(
    labelText: string,
    ariaLabel: string,
    values: readonly { value: string; label: string }[],
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
      opt.value = v.value;
      opt.textContent = v.label;
      select.append(opt);
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

  // -------------------------------------------------------------------------
  // Create UI Elements
  // -------------------------------------------------------------------------

  const { row: typeRow, select: effectTypeSelect } = createSelectRow(
    'Type',
    'Effect Type',
    EFFECT_TYPES,
  );

  // Shadow-specific fields
  const { row: offsetXRow, input: offsetXInput } = createInputRow('Offset X', 'Shadow Offset X');
  const { row: offsetYRow, input: offsetYInput } = createInputRow('Offset Y', 'Shadow Offset Y');
  const { row: shadowBlurRow, input: shadowBlurInput } = createInputRow(
    'Blur',
    'Shadow Blur Radius',
  );
  const { row: spreadRow, input: spreadInput } = createInputRow('Spread', 'Shadow Spread Radius');
  const { row: colorRow, colorFieldContainer } = createColorRow('Color');

  // Blur-specific fields
  const { row: blurRadiusRow, input: blurRadiusInput } = createInputRow('Radius', 'Blur Radius');

  root.append(typeRow, offsetXRow, offsetYRow, shadowBlurRow, spreadRow, colorRow, blurRadiusRow);
  container.append(root);
  disposer.add(() => root.remove());

  // Wire keyboard stepping for numeric inputs
  wireNumberStepping(disposer, offsetXInput, { mode: 'css-length' });
  wireNumberStepping(disposer, offsetYInput, { mode: 'css-length' });
  wireNumberStepping(disposer, shadowBlurInput, {
    mode: 'css-length',
    min: 0,
    step: 1,
    shiftStep: 10,
    altStep: 0.1,
  });
  wireNumberStepping(disposer, spreadInput, {
    mode: 'css-length',
    step: 1,
    shiftStep: 10,
    altStep: 0.1,
  });
  wireNumberStepping(disposer, blurRadiusInput, {
    mode: 'css-length',
    min: 0,
    step: 1,
    shiftStep: 10,
    altStep: 0.1,
  });

  // Create color field
  const shadowColorField: ColorField = createColorField({
    container: colorFieldContainer,
    ariaLabel: 'Shadow Color',
    tokensService,
    getTokenTarget: () => currentTarget,
    onInput: (value) => {
      shadowColorValue = value;
      previewShadow();
    },
    onCommit: () => {
      commitTransaction('box-shadow');
      syncAllFields();
    },
    onCancel: () => {
      rollbackTransaction('box-shadow');
      syncAllFields(true);
    },
  });
  disposer.add(() => shadowColorField.dispose());

  // -------------------------------------------------------------------------
  // Transaction Management
  // -------------------------------------------------------------------------

  function beginTransaction(property: EffectsProperty): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;

    const target = currentTarget;
    if (!target || !target.isConnected) return null;

    const existing = handles[property];
    if (existing) return existing;

    const handle = transactionManager.beginStyle(target, property);
    handles[property] = handle;
    return handle;
  }

  function commitTransaction(property: EffectsProperty): void {
    const handle = handles[property];
    handles[property] = null;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackTransaction(property: EffectsProperty): void {
    const handle = handles[property];
    handles[property] = null;
    if (handle) handle.rollback();
  }

  function commitAllTransactions(): void {
    commitTransaction('box-shadow');
    commitTransaction('filter');
    commitTransaction('backdrop-filter');
  }

  // -------------------------------------------------------------------------
  // Effect Type Helpers
  // -------------------------------------------------------------------------

  function isShadowType(type: EffectType): boolean {
    return type === 'drop-shadow' || type === 'inner-shadow';
  }

  function getBlurProperty(type: EffectType): EffectsProperty {
    return type === 'backdrop-blur' ? 'backdrop-filter' : 'filter';
  }

  function updateRowVisibility(): void {
    const isShadow = isShadowType(currentEffectType);

    offsetXRow.hidden = !isShadow;
    offsetYRow.hidden = !isShadow;
    shadowBlurRow.hidden = !isShadow;
    spreadRow.hidden = !isShadow;
    colorRow.hidden = !isShadow;
    blurRadiusRow.hidden = isShadow;
  }

  function isShadowEditing(): boolean {
    return (
      handles['box-shadow'] !== null ||
      isFieldFocused(offsetXInput) ||
      isFieldFocused(offsetYInput) ||
      isFieldFocused(shadowBlurInput) ||
      isFieldFocused(spreadInput) ||
      shadowColorField.isFocused()
    );
  }

  function isBlurEditing(property: EffectsProperty): boolean {
    return handles[property] !== null || isFieldFocused(blurRadiusInput);
  }

  // -------------------------------------------------------------------------
  // Live Preview
  // -------------------------------------------------------------------------

  function previewShadow(): void {
    if (disposer.isDisposed || !isShadowType(currentEffectType)) return;

    const target = currentTarget;
    if (!target || !target.isConnected) return;

    const handle = beginTransaction('box-shadow');
    if (!handle) return;

    const shadowValue = formatBoxShadow({
      inset: currentEffectType === 'inner-shadow',
      offsetX: offsetXInput.value,
      offsetY: offsetYInput.value,
      blurRadius: shadowBlurInput.value,
      spreadRadius: spreadInput.value,
      color: shadowColorValue,
    });

    const existingInline = readInlineValue(target, 'box-shadow');
    handle.set(upsertFirstShadow(existingInline, shadowValue));
  }

  function previewBlur(): void {
    if (disposer.isDisposed) return;
    if (currentEffectType !== 'layer-blur' && currentEffectType !== 'backdrop-blur') return;

    const target = currentTarget;
    if (!target || !target.isConnected) return;

    const property = getBlurProperty(currentEffectType);
    const handle = beginTransaction(property);
    if (!handle) return;

    const existingInline = readInlineValue(target, property);
    handle.set(upsertBlurFunction(existingInline, blurRadiusInput.value));
  }

  // -------------------------------------------------------------------------
  // Sync (Render from Element State)
  // -------------------------------------------------------------------------

  function setAllDisabled(disabled: boolean): void {
    effectTypeSelect.disabled = disabled;
    offsetXInput.disabled = disabled;
    offsetYInput.disabled = disabled;
    shadowBlurInput.disabled = disabled;
    spreadInput.disabled = disabled;
    blurRadiusInput.disabled = disabled;
    shadowColorField.setDisabled(disabled);
  }

  function clearAllValues(): void {
    offsetXInput.value = '';
    offsetYInput.value = '';
    shadowBlurInput.value = '';
    spreadInput.value = '';
    blurRadiusInput.value = '';
    shadowColorValue = '';
    shadowColorField.setValue('');
    shadowColorField.setPlaceholder('');
  }

  function syncShadowFields(force = false): void {
    const target = currentTarget;
    if (!target || !target.isConnected) return;

    if (isShadowEditing() && !force) return;

    const inlineValue = readInlineValue(target, 'box-shadow');
    const inlineParsed = inlineValue ? parseBoxShadow(inlineValue) : null;

    // Only read computed value if inline is empty or contains CSS variables
    const needsComputed = !inlineParsed || /\bvar\s*\(/i.test(inlineValue);
    const computedParsed = needsComputed
      ? parseBoxShadow(readComputedValue(target, 'box-shadow'))
      : null;

    const parsed = inlineParsed ?? computedParsed;

    if (!parsed) {
      offsetXInput.value = '';
      offsetYInput.value = '';
      shadowBlurInput.value = '';
      spreadInput.value = '';
      shadowColorValue = '';
      shadowColorField.setValue('');
      shadowColorField.setPlaceholder('');
      return;
    }

    offsetXInput.value = parsed.offsetX;
    offsetYInput.value = parsed.offsetY;
    shadowBlurInput.value = parsed.blurRadius;
    spreadInput.value = parsed.spreadRadius;

    if (inlineParsed) {
      shadowColorValue = inlineParsed.color;
      shadowColorField.setValue(inlineParsed.color);

      // Pass computed value as placeholder for CSS variables
      const needsPlaceholder = /\bvar\s*\(/i.test(inlineParsed.color);
      shadowColorField.setPlaceholder(needsPlaceholder ? (computedParsed?.color ?? '') : '');
    } else {
      shadowColorValue = parsed.color;
      shadowColorField.setValue(parsed.color);
      shadowColorField.setPlaceholder('');
    }
  }

  function syncBlurFields(property: EffectsProperty, force = false): void {
    const target = currentTarget;
    if (!target || !target.isConnected) return;

    if (isBlurEditing(property) && !force) return;

    const inlineValue = readInlineValue(target, property);
    // Only read computed if inline is empty
    const display = inlineValue || readComputedValue(target, property);

    blurRadiusInput.value = parseBlurRadius(display);
  }

  function syncAllFields(force = false): void {
    updateRowVisibility();

    const target = currentTarget;
    if (!target || !target.isConnected) {
      setAllDisabled(true);
      clearAllValues();
      return;
    }

    setAllDisabled(false);

    if (isShadowType(currentEffectType)) {
      syncShadowFields(force);
    } else {
      syncBlurFields(getBlurProperty(currentEffectType), force);
    }
  }

  /**
   * Infer the initial effect type based on existing styles
   */
  function inferEffectType(target: Element): EffectType {
    const shadowValue =
      readInlineValue(target, 'box-shadow') || readComputedValue(target, 'box-shadow');
    const parsedShadow = parseBoxShadow(shadowValue);
    if (parsedShadow) return parsedShadow.inset ? 'inner-shadow' : 'drop-shadow';

    const filterValue = readInlineValue(target, 'filter') || readComputedValue(target, 'filter');
    if (parseBlurRadius(filterValue)) return 'layer-blur';

    const backdropValue =
      readInlineValue(target, 'backdrop-filter') || readComputedValue(target, 'backdrop-filter');
    if (parseBlurRadius(backdropValue)) return 'backdrop-blur';

    return 'drop-shadow';
  }

  // -------------------------------------------------------------------------
  // Event Wiring
  // -------------------------------------------------------------------------

  function rollbackAllTransactions(): void {
    rollbackTransaction('box-shadow');
    rollbackTransaction('filter');
    rollbackTransaction('backdrop-filter');
  }

  const onEffectTypeChange = () => {
    const next = effectTypeSelect.value as EffectType;
    if (next === currentEffectType) return;

    // Rollback any in-progress edits when switching effect type
    // This prevents accidentally committing half-edited values
    rollbackAllTransactions();
    currentEffectType = next;
    updateRowVisibility();
    syncAllFields(true);
  };

  disposer.listen(effectTypeSelect, 'input', onEffectTypeChange);
  disposer.listen(effectTypeSelect, 'change', onEffectTypeChange);

  function wireShadowInput(input: HTMLInputElement): void {
    disposer.listen(input, 'input', previewShadow);

    disposer.listen(input, 'blur', () => {
      commitTransaction('box-shadow');
      syncAllFields();
    });

    disposer.listen(input, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTransaction('box-shadow');
        syncAllFields();
        input.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        rollbackTransaction('box-shadow');
        syncAllFields(true);
      }
    });
  }

  wireShadowInput(offsetXInput);
  wireShadowInput(offsetYInput);
  wireShadowInput(shadowBlurInput);
  wireShadowInput(spreadInput);

  disposer.listen(blurRadiusInput, 'input', previewBlur);

  disposer.listen(blurRadiusInput, 'blur', () => {
    if (currentEffectType !== 'layer-blur' && currentEffectType !== 'backdrop-blur') return;
    commitTransaction(getBlurProperty(currentEffectType));
    syncAllFields();
  });

  disposer.listen(blurRadiusInput, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (currentEffectType === 'layer-blur' || currentEffectType === 'backdrop-blur') {
        commitTransaction(getBlurProperty(currentEffectType));
        syncAllFields();
      }
      blurRadiusInput.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (currentEffectType === 'layer-blur' || currentEffectType === 'backdrop-blur') {
        rollbackTransaction(getBlurProperty(currentEffectType));
        syncAllFields(true);
      }
    }
  });

  // -------------------------------------------------------------------------
  // DesignControl Interface
  // -------------------------------------------------------------------------

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;

    if (element !== currentTarget) commitAllTransactions();
    currentTarget = element;

    if (element && element.isConnected) {
      currentEffectType = inferEffectType(element);
      effectTypeSelect.value = currentEffectType;
    }

    syncAllFields(true);
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

  // Initialize
  effectTypeSelect.value = currentEffectType;
  syncAllFields(true);

  return { setTarget, refresh, dispose };
}

// =============================================================================
// Box Shadow List (Effects v2)
// =============================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';
const BOX_SHADOW_PROPERTY = 'box-shadow';

// Effect type definitions
const EFFECT_TYPE_OPTIONS = [
  { value: 'drop-shadow', label: 'Drop Shadow', category: 'shadow' },
  { value: 'inner-shadow', label: 'Inner Shadow', category: 'shadow' },
  { value: 'layer-blur', label: 'Layer Blur', category: 'blur' },
  { value: 'backdrop-blur', label: 'Backdrop Blur', category: 'blur' },
] as const;

type EffectTypeValue = (typeof EFFECT_TYPE_OPTIONS)[number]['value'];
type EffectCategory = 'shadow' | 'blur';

// -----------------------------------------------------------------------------
// ID Generation
// -----------------------------------------------------------------------------

let shadowItemIdCounter = 0;

function createShadowItemId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fallback to counter
  }
  shadowItemIdCounter += 1;
  return `shadow_${shadowItemIdCounter}_${Date.now()}`;
}

// -----------------------------------------------------------------------------
// Effect Item Types
// -----------------------------------------------------------------------------

interface EffectItemBase {
  id: string;
  enabled: boolean;
}

// Shadow type effects (Drop Shadow / Inner Shadow)
interface ShadowEffectItem extends EffectItemBase {
  type: 'drop-shadow' | 'inner-shadow';
  kind: 'parsed';
  inset: boolean;
  offsetX: string;
  offsetY: string;
  blurRadius: string;
  spreadRadius: string;
  color: string;
}

// Blur type effects (Layer Blur / Backdrop Blur)
interface BlurEffectItem extends EffectItemBase {
  type: 'layer-blur' | 'backdrop-blur';
  kind: 'parsed';
  radius: string;
}

// Unparseable raw effect
interface RawEffectItem extends EffectItemBase {
  type: 'raw';
  kind: 'raw';
  property: 'box-shadow' | 'filter' | 'backdrop-filter';
  rawText: string;
}

type EffectItem = ShadowEffectItem | BlurEffectItem | RawEffectItem;

function isShadowEffect(item: EffectItem): item is ShadowEffectItem {
  return item.type === 'drop-shadow' || item.type === 'inner-shadow';
}

function isBlurEffect(item: EffectItem): item is BlurEffectItem {
  return item.type === 'layer-blur' || item.type === 'backdrop-blur';
}

// -----------------------------------------------------------------------------
// Effect Item Helpers
// -----------------------------------------------------------------------------

function createDefaultShadowEffect(): ShadowEffectItem {
  return {
    id: createShadowItemId(),
    enabled: true,
    type: 'drop-shadow',
    kind: 'parsed',
    inset: false,
    offsetX: '0px',
    offsetY: '4px',
    blurRadius: '12px',
    spreadRadius: '0px',
    color: 'rgba(0, 0, 0, 0.15)',
  };
}

function createDefaultBlurEffect(type: 'layer-blur' | 'backdrop-blur'): BlurEffectItem {
  return {
    id: createShadowItemId(),
    enabled: true,
    type,
    kind: 'parsed',
    radius: '8px',
  };
}

function getEffectItemLabel(item: EffectItem): string {
  const option = EFFECT_TYPE_OPTIONS.find((o) => o.value === item.type);
  if (option) return option.label;
  if (item.kind === 'raw') return 'Custom Effect';
  return 'Unknown Effect';
}

function effectItemKey(item: EffectItem): string {
  if (item.kind === 'raw') return `raw:${item.property}:${item.rawText.trim()}`;
  if (isShadowEffect(item)) {
    const css = formatBoxShadow({
      inset: item.inset,
      offsetX: item.offsetX,
      offsetY: item.offsetY,
      blurRadius: item.blurRadius,
      spreadRadius: item.spreadRadius,
      color: item.color,
    });
    return `shadow:${item.type}:${css.toLowerCase()}`;
  }
  // isBlurEffect(item) must be true at this point
  return `blur:${item.type}:${item.radius}`;
}

// -----------------------------------------------------------------------------
// Parsing & Formatting
// -----------------------------------------------------------------------------

function parseBoxShadowToEffects(raw: string): EffectItem[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') return [];

  const segments = splitTopLevel(trimmed, ',')
    .map((s) => s.trim())
    .filter(Boolean);

  const out: EffectItem[] = [];

  for (const seg of segments) {
    const parsed = parseBoxShadow(seg);
    if (parsed) {
      out.push({
        id: createShadowItemId(),
        enabled: true,
        type: parsed.inset ? 'inner-shadow' : 'drop-shadow',
        kind: 'parsed',
        inset: parsed.inset,
        offsetX: parsed.offsetX,
        offsetY: parsed.offsetY,
        blurRadius: parsed.blurRadius,
        spreadRadius: parsed.spreadRadius,
        color: parsed.color,
      });
    } else {
      out.push({
        id: createShadowItemId(),
        enabled: true,
        type: 'raw',
        kind: 'raw',
        property: 'box-shadow',
        rawText: seg,
      });
    }
  }

  return out;
}

function parseFilterBlurToEffect(
  raw: string,
  type: 'layer-blur' | 'backdrop-blur',
): BlurEffectItem | null {
  const radius = parseBlurRadius(raw);
  if (!radius) return null;

  return {
    id: createShadowItemId(),
    enabled: true,
    type,
    kind: 'parsed',
    radius,
  };
}

function formatEffectsToBoxShadow(items: EffectItem[]): string {
  const parts = items
    .filter(
      (item) =>
        item.enabled &&
        (isShadowEffect(item) || (item.kind === 'raw' && item.property === 'box-shadow')),
    )
    .map((item) => {
      if (item.kind === 'raw') return item.rawText.trim();
      if (isShadowEffect(item)) {
        return formatBoxShadow({
          inset: item.inset,
          offsetX: item.offsetX,
          offsetY: item.offsetY,
          blurRadius: item.blurRadius,
          spreadRadius: item.spreadRadius,
          color: item.color,
        });
      }
      return '';
    })
    .map((s) => s.trim())
    .filter(Boolean);

  return parts.join(', ');
}

function getBlurEffectByType(
  items: EffectItem[],
  type: 'layer-blur' | 'backdrop-blur',
): BlurEffectItem | null {
  const item = items.find((i) => i.type === type && i.enabled);
  return item && isBlurEffect(item) ? item : null;
}

function reconcileEffectItems(
  prevItems: EffectItem[],
  nextEnabledItems: EffectItem[],
): EffectItem[] {
  const usedIds = new Set<string>();
  const pool = new Map<string, EffectItem[]>();

  for (const item of prevItems) {
    const key = effectItemKey(item);
    const queue = pool.get(key) ?? [];
    queue.push(item);
    pool.set(key, queue);
  }

  const reconciledEnabled = nextEnabledItems.map((item) => {
    const key = effectItemKey(item);
    const queue = pool.get(key);
    const match = queue?.shift();
    if (match) {
      usedIds.add(match.id);
      return { ...item, id: match.id, enabled: true };
    }
    return item;
  });

  // Keep session-only hidden effects (enabled=false) that are not present in CSS
  const remainingHidden = prevItems.filter((item) => !item.enabled && !usedIds.has(item.id));

  return [...reconciledEnabled, ...remainingHidden];
}

// -----------------------------------------------------------------------------
// DOM Helpers
// -----------------------------------------------------------------------------

function getActiveElementInSameRoot(root: HTMLElement): Element | null {
  try {
    const rootNode = root.getRootNode();
    if (rootNode instanceof ShadowRoot) return rootNode.activeElement;
    return document.activeElement;
  } catch {
    return null;
  }
}

function isFocusedWithin(root: HTMLElement): boolean {
  const active = getActiveElementInSameRoot(root);
  return active instanceof HTMLElement ? root.contains(active) : false;
}

// -----------------------------------------------------------------------------
// SVG Icons
// -----------------------------------------------------------------------------

function createSvgIcon(pathD: string, viewBox = '0 0 24 24'): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', pathD);
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);

  return svg;
}

function createPlusIcon(): SVGElement {
  return createSvgIcon('M12 5v14M5 12h14');
}

function createTrashIcon(): SVGElement {
  return createSvgIcon('M9 6h6M10 6l.5-1.5h3L14 6M7 6l1 14h8l1-14');
}

function createAdjustIcon(): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const lines = document.createElementNS(SVG_NS, 'path');
  lines.setAttribute('d', 'M4 5H16 M4 10H16 M4 15H16');
  lines.setAttribute('stroke', 'currentColor');
  lines.setAttribute('stroke-width', '2');
  lines.setAttribute('stroke-linecap', 'round');
  lines.setAttribute('stroke-linejoin', 'round');
  svg.append(lines);

  const knobs: ReadonlyArray<readonly [number, number]> = [
    [7, 5],
    [13, 10],
    [9, 15],
  ];

  for (const [cx, cy] of knobs) {
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', '1.6');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '2');
    svg.append(circle);
  }

  return svg;
}

function createEyeIcon(enabled: boolean): SVGElement {
  if (enabled) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');

    const outline = document.createElementNS(SVG_NS, 'path');
    outline.setAttribute('d', 'M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z');
    outline.setAttribute('stroke', 'currentColor');
    outline.setAttribute('stroke-width', '2');
    outline.setAttribute('stroke-linecap', 'round');
    outline.setAttribute('stroke-linejoin', 'round');

    const iris = document.createElementNS(SVG_NS, 'circle');
    iris.setAttribute('cx', '12');
    iris.setAttribute('cy', '12');
    iris.setAttribute('r', '3');
    iris.setAttribute('stroke', 'currentColor');
    iris.setAttribute('stroke-width', '2');

    svg.append(outline, iris);
    return svg;
  }

  return createSvgIcon(
    'M3 3l18 18M10.6 10.6A3 3 0 0012 15a3 3 0 002.4-4.4M9.5 5.8A10.7 10.7 0 0112 5c6 0 9.5 7 9.5 7a17.4 17.4 0 01-3.1 4.1M6.2 6.2A17.8 17.8 0 002.5 12s3.5 7 9.5 7c1 0 1.9-.2 2.8-.5',
  );
}

function createIconButton(ariaLabel: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'we-effects-icon-btn';
  btn.setAttribute('aria-label', ariaLabel);
  return btn;
}

// -----------------------------------------------------------------------------
// Item View Types
// -----------------------------------------------------------------------------

interface EffectItemViewBase {
  id: string;
  root: HTMLDivElement;
  row: HTMLDivElement;
  adjustBtn: HTMLButtonElement;
  nameBtn: HTMLButtonElement;
  eyeBtn: HTMLButtonElement;
  deleteBtn: HTMLButtonElement;
  popover: HTMLDivElement;
  disposer: Disposer;
  setOpen(open: boolean): void;
  focusFirst(): void;
  sync(item: EffectItem): void;
  dispose(): void;
}

interface ShadowEffectItemView extends EffectItemViewBase {
  viewType: 'shadow';
  typeSelect: HTMLSelectElement;
  offsetX: InputContainer;
  offsetY: InputContainer;
  blur: InputContainer;
  spread: InputContainer;
  colorField: ColorField;
}

interface BlurEffectItemView extends EffectItemViewBase {
  viewType: 'blur';
  typeSelect: HTMLSelectElement;
  radiusInput: InputContainer;
}

interface RawEffectItemView extends EffectItemViewBase {
  viewType: 'raw';
  rawInput: HTMLInputElement;
}

type EffectItemView = ShadowEffectItemView | BlurEffectItemView | RawEffectItemView;

function getViewTypeForItem(item: EffectItem): EffectItemView['viewType'] {
  if (item.kind === 'raw') return 'raw';
  if (isShadowEffect(item)) return 'shadow';
  if (isBlurEffect(item)) return 'blur';
  return 'raw';
}

// -----------------------------------------------------------------------------
// Main Factory
// -----------------------------------------------------------------------------

export function createEffectsControl(options: EffectsControlOptions): DesignControl {
  const { container, transactionManager, tokensService, headerActionsContainer } = options;
  const disposer = new Disposer();

  // Effect items cache per element (current editing session only)
  // 使用 WeakMap 的原因：
  // 1. 隐藏的 effect 不会写入 CSS（enabled=false），但需要在会话内记住以便恢复
  // 2. WeakMap 保证元素被移除时自动释放内存，无需手动清理
  // 3. 只读取 inline style（不读 computed），因此缓存仅用于保留用户的隐藏操作
  const perTargetItems = new WeakMap<Element, EffectItem[]>();

  let currentTarget: Element | null = null;
  let currentItems: EffectItem[] = [];
  let itemsById = new Map<string, EffectItem>();
  let openItemId: string | null = null;
  let activeHandle: StyleTransactionHandle | null = null;
  let activeProperty: string | null = null;

  // Root container
  const root = document.createElement('div');
  root.className = 'we-field-group we-effects';
  container.append(root);
  disposer.add(() => root.remove());

  // Add button - placed in header if available, otherwise in toolbar
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'we-effects-icon-btn';
  addBtn.setAttribute('aria-label', 'Add effect');
  addBtn.append(createPlusIcon());

  if (headerActionsContainer) {
    // 将 + 按钮放在 group header 的右侧（chevron 左边）
    headerActionsContainer.insertBefore(addBtn, headerActionsContainer.firstChild);
    disposer.add(() => addBtn.remove());
  } else {
    // 回退：在内容区域显示 toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'we-effects-toolbar';
    toolbar.append(addBtn);
    root.append(toolbar);
  }

  // Effect list container
  const list = document.createElement('div');
  list.className = 'we-effects-list';

  root.append(list);

  // View registry
  const views = new Map<string, EffectItemView>();

  // -------------------------------------------------------------------------
  // State Management
  // -------------------------------------------------------------------------

  function setCurrentItems(next: EffectItem[]): void {
    currentItems = next;
    itemsById = new Map(next.map((i) => [i.id, i]));
    const target = currentTarget;
    if (target) perTargetItems.set(target, next);
  }

  function getItem(id: string): EffectItem | null {
    return itemsById.get(id) ?? null;
  }

  // -------------------------------------------------------------------------
  // Transaction Management
  // -------------------------------------------------------------------------

  function beginTransaction(property: string): StyleTransactionHandle | null {
    if (disposer.isDisposed) return null;
    const target = currentTarget;
    if (!target || !target.isConnected) return null;
    if (activeHandle && activeProperty === property) return activeHandle;
    // Commit previous if different property
    if (activeHandle) activeHandle.commit({ merge: true });
    activeHandle = transactionManager.beginStyle(target, property);
    activeProperty = property;
    return activeHandle;
  }

  function commitTransaction(): void {
    const handle = activeHandle;
    activeHandle = null;
    activeProperty = null;
    if (handle) handle.commit({ merge: true });
  }

  function rollbackTransaction(): void {
    const handle = activeHandle;
    activeHandle = null;
    activeProperty = null;
    if (handle) handle.rollback();
  }

  function isEditing(): boolean {
    // 只在有打开的 popover 或正在进行事务时阻止刷新
    // 避免过于宽泛的 focus 检测导致外部样式变化无法同步
    return activeHandle !== null || openItemId !== null;
  }

  // -------------------------------------------------------------------------
  // Preview & Apply
  // -------------------------------------------------------------------------

  function previewCurrentItems(): void {
    const target = currentTarget;
    if (!target || !target.isConnected) return;

    // Preview box-shadow
    const shadowHandle = beginTransaction(BOX_SHADOW_PROPERTY);
    if (shadowHandle) {
      shadowHandle.set(formatEffectsToBoxShadow(currentItems));
    }

    // Preview filter blur
    const layerBlur = getBlurEffectByType(currentItems, 'layer-blur');
    if (layerBlur) {
      const filterHandle = beginTransaction('filter');
      if (filterHandle) {
        const existing = readInlineValue(target, 'filter');
        filterHandle.set(upsertBlurFunction(existing, layerBlur.radius));
      }
    }

    // Preview backdrop-filter blur
    const backdropBlur = getBlurEffectByType(currentItems, 'backdrop-blur');
    if (backdropBlur) {
      const backdropHandle = beginTransaction('backdrop-filter');
      if (backdropHandle) {
        const existing = readInlineValue(target, 'backdrop-filter');
        backdropHandle.set(upsertBlurFunction(existing, backdropBlur.radius));
      }
    }
  }

  function applyCurrentItemsDiscrete(): void {
    const target = currentTarget;
    if (!target || !target.isConnected) return;
    commitTransaction();

    // Apply box-shadow
    transactionManager.applyStyle(
      target,
      BOX_SHADOW_PROPERTY,
      formatEffectsToBoxShadow(currentItems),
      {
        merge: false,
      },
    );

    // Apply filter blur
    const layerBlur = getBlurEffectByType(currentItems, 'layer-blur');
    const existingFilter = readInlineValue(target, 'filter');
    transactionManager.applyStyle(
      target,
      'filter',
      upsertBlurFunction(existingFilter, layerBlur?.radius ?? ''),
      {
        merge: false,
      },
    );

    // Apply backdrop-filter blur
    const backdropBlur = getBlurEffectByType(currentItems, 'backdrop-blur');
    const existingBackdrop = readInlineValue(target, 'backdrop-filter');
    transactionManager.applyStyle(
      target,
      'backdrop-filter',
      upsertBlurFunction(existingBackdrop, backdropBlur?.radius ?? ''),
      {
        merge: false,
      },
    );
  }

  // -------------------------------------------------------------------------
  // Popover Management
  // -------------------------------------------------------------------------

  function closePopover(opts?: { commit?: boolean; rollback?: boolean }): void {
    const commit = opts?.commit ?? false;
    const rollback = opts?.rollback ?? false;

    if (rollback) rollbackTransaction();
    else if (commit) commitTransaction();

    const wasOpen = openItemId !== null;
    openItemId = null;
    for (const view of views.values()) view.setOpen(false);

    // 关闭后同步一次，确保 currentItems 与真实 inline 一致
    // 避免浏览器归一化/修正值后产生不一致
    if (wasOpen && !rollback) {
      syncFromTarget(true);
    }
  }

  function setPopoverOpen(id: string | null): void {
    if (id === openItemId) {
      closePopover({ commit: true });
      return;
    }

    closePopover({ commit: true });

    if (!id) return;
    const view = views.get(id);
    if (!view) return;

    openItemId = id;
    for (const [vid, v] of views) v.setOpen(vid === id);
    view.focusFirst();
  }

  // -------------------------------------------------------------------------
  // Input Helpers
  // -------------------------------------------------------------------------

  function setLengthInput(containerRef: InputContainer, raw: string): void {
    const formatted = formatLengthForDisplay(raw);
    containerRef.input.value = formatted.value;
    containerRef.setSuffix(formatted.suffix);
  }

  // -------------------------------------------------------------------------
  // Effect Type Conversion
  // -------------------------------------------------------------------------

  /**
   * Convert an effect item to a new type, preserving compatible fields.
   */
  function createEffectItemWithType(
    prev: EffectItem,
    nextType: EffectTypeValue,
  ): EffectItem | null {
    if (prev.kind === 'raw') return null;

    // Convert to blur type
    if (nextType === 'layer-blur' || nextType === 'backdrop-blur') {
      const base = createDefaultBlurEffect(nextType);
      // Map blur radius from previous effect
      const mappedRadius = isBlurEffect(prev)
        ? prev.radius
        : isShadowEffect(prev)
          ? prev.blurRadius
          : base.radius;
      return {
        ...base,
        id: prev.id,
        enabled: prev.enabled,
        radius: mappedRadius || base.radius,
      };
    }

    // Convert to shadow type
    const base = createDefaultShadowEffect();
    const shadowPrev = isShadowEffect(prev) ? prev : null;
    const blurPrev = isBlurEffect(prev) ? prev : null;
    const mappedBlurRadius = shadowPrev?.blurRadius ?? blurPrev?.radius ?? base.blurRadius;

    return {
      ...base,
      id: prev.id,
      enabled: prev.enabled,
      type: nextType,
      inset: nextType === 'inner-shadow',
      offsetX: shadowPrev?.offsetX ?? base.offsetX,
      offsetY: shadowPrev?.offsetY ?? base.offsetY,
      blurRadius: mappedBlurRadius || base.blurRadius,
      spreadRadius: shadowPrev?.spreadRadius ?? base.spreadRadius,
      color: shadowPrev?.color ?? base.color,
    };
  }

  /**
   * Update an effect item's type, potentially converting between shadow/blur.
   */
  function updateEffectItemType(id: string, nextType: EffectTypeValue): void {
    const prev = getItem(id);
    if (!prev || prev.kind === 'raw') return;
    if (prev.type === nextType) return;

    const nextItem = createEffectItemWithType(prev, nextType);
    if (!nextItem) return;

    let nextItems = currentItems.map((it) => (it.id === id ? nextItem : it));

    // Only one blur effect per type (filter/backdrop-filter) is supported
    if (nextItem.type === 'layer-blur' || nextItem.type === 'backdrop-blur') {
      nextItems = nextItems.filter((it) => it.id === id || it.type !== nextItem.type);
    }

    setCurrentItems(nextItems);
    renderList();
    applyCurrentItemsDiscrete();

    // The view might have been recreated (shadow <-> blur), restore focus
    if (openItemId === id) {
      views.get(id)?.focusFirst();
    }
  }

  // -------------------------------------------------------------------------
  // Item View Factory
  // -------------------------------------------------------------------------

  function createItemView(item: EffectItem): EffectItemView {
    const itemDisposer = new Disposer();

    const wrap = document.createElement('div');
    wrap.className = 'we-effects-item-wrap';

    const row = document.createElement('div');
    row.className = 'we-effects-item';
    row.dataset.enabled = item.enabled ? 'true' : 'false';
    row.dataset.open = 'false';

    const adjustBtn = createIconButton('Adjust effect');
    adjustBtn.append(createAdjustIcon());

    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'we-effects-name';

    const eyeBtn = createIconButton('Toggle visibility');

    const deleteBtn = createIconButton('Remove effect');
    deleteBtn.append(createTrashIcon());

    row.append(adjustBtn, nameBtn, eyeBtn, deleteBtn);

    const popover = document.createElement('div');
    popover.className = 'we-effects-popover';
    popover.hidden = true;

    wrap.append(row, popover);

    // Common event handlers
    itemDisposer.listen(adjustBtn, 'click', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setPopoverOpen(item.id);
    });

    itemDisposer.listen(nameBtn, 'click', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setPopoverOpen(item.id);
    });

    itemDisposer.listen(eyeBtn, 'click', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const it = getItem(item.id);
      if (!it) return;
      it.enabled = !it.enabled;
      row.dataset.enabled = it.enabled ? 'true' : 'false';
      eyeBtn.replaceChildren(createEyeIcon(it.enabled));
      applyCurrentItemsDiscrete();
    });

    itemDisposer.listen(deleteBtn, 'click', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (openItemId === item.id) closePopover({ commit: true });
      setCurrentItems(currentItems.filter((i) => i.id !== item.id));
      views.get(item.id)?.dispose();
      views.delete(item.id);
      renderList();
      applyCurrentItemsDiscrete();
    });

    // Raw shadow item view
    if (item.kind === 'raw') {
      const content = document.createElement('div');
      content.className = 'we-effects-popover-content';

      const field = document.createElement('div');
      field.className = 'we-field';

      const label = document.createElement('span');
      label.className = 'we-field-label';
      label.textContent = 'Value';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'we-input';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', 'Shadow value');

      field.append(label, input);
      content.append(field);
      popover.append(content);

      itemDisposer.listen(input, 'input', () => {
        const it = getItem(item.id);
        if (!it || it.kind !== 'raw') return;
        it.rawText = input.value;
        previewCurrentItems();
      });

      itemDisposer.listen(input, 'blur', () => {
        commitTransaction();
      });

      itemDisposer.listen(input, 'keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitTransaction();
          input.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closePopover({ rollback: true });
          syncFromTarget(true);
        }
      });

      const view: RawEffectItemView = {
        id: item.id,
        viewType: 'raw',
        root: wrap,
        row,
        adjustBtn,
        nameBtn,
        eyeBtn,
        deleteBtn,
        popover,
        rawInput: input,
        disposer: itemDisposer,
        setOpen(open: boolean): void {
          row.dataset.open = open ? 'true' : 'false';
          popover.hidden = !open;
        },
        focusFirst(): void {
          input.focus();
          input.select();
        },
        sync(next: EffectItem): void {
          row.dataset.enabled = next.enabled ? 'true' : 'false';
          nameBtn.textContent = getEffectItemLabel(next);
          eyeBtn.replaceChildren(createEyeIcon(next.enabled));
          if (next.kind === 'raw') input.value = next.rawText;
        },
        dispose(): void {
          itemDisposer.dispose();
          wrap.remove();
        },
      };

      return view;
    }

    // Blur effect view (Layer Blur / Backdrop Blur)
    if (isBlurEffect(item)) {
      const content = document.createElement('div');
      content.className = 'we-effects-popover-content';

      // Type select (only blur types)
      const typeField = document.createElement('div');
      typeField.className = 'we-field';

      const typeLabel = document.createElement('span');
      typeLabel.className = 'we-field-label';
      typeLabel.textContent = 'Type';

      const typeSelect = document.createElement('select');
      typeSelect.className = 'we-select';
      typeSelect.setAttribute('aria-label', 'Effect type');

      for (const v of EFFECT_TYPE_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = v.value;
        opt.textContent = v.label;
        typeSelect.append(opt);
      }

      typeField.append(typeLabel, typeSelect);

      // Radius input
      const radiusField = document.createElement('div');
      radiusField.className = 'we-field';

      const radiusLabel = document.createElement('span');
      radiusLabel.className = 'we-field-label';
      radiusLabel.textContent = 'Blur';

      const radiusInput = createInputContainer({
        ariaLabel: 'Blur radius',
        inputMode: 'decimal',
        suffix: 'px',
      });

      radiusField.append(radiusLabel, radiusInput.root);
      content.append(typeField, radiusField);
      popover.append(content);

      wireNumberStepping(itemDisposer, radiusInput.input, {
        mode: 'css-length',
        min: 0,
        step: 1,
        shiftStep: 10,
        altStep: 0.1,
      });

      itemDisposer.listen(radiusInput.input, 'input', () => {
        const it = getItem(item.id);
        if (!it || !isBlurEffect(it)) return;
        it.radius = combineLengthValue(radiusInput.input.value, radiusInput.getSuffixText());
        previewCurrentItems();
      });

      itemDisposer.listen(radiusInput.input, 'blur', () => {
        commitTransaction();
        syncFromTarget(true);
      });

      itemDisposer.listen(radiusInput.input, 'keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitTransaction();
          syncFromTarget(true);
          radiusInput.input.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closePopover({ rollback: true });
          syncFromTarget(true);
        }
      });

      const onTypeChange = () => {
        updateEffectItemType(item.id, typeSelect.value as EffectTypeValue);
      };

      itemDisposer.listen(typeSelect, 'input', onTypeChange);
      itemDisposer.listen(typeSelect, 'change', onTypeChange);

      const view: BlurEffectItemView = {
        id: item.id,
        viewType: 'blur',
        root: wrap,
        row,
        adjustBtn,
        nameBtn,
        eyeBtn,
        deleteBtn,
        popover,
        disposer: itemDisposer,
        typeSelect,
        radiusInput,
        setOpen(open: boolean): void {
          row.dataset.open = open ? 'true' : 'false';
          popover.hidden = !open;
        },
        focusFirst(): void {
          radiusInput.input.focus();
          radiusInput.input.select();
        },
        sync(next: EffectItem): void {
          row.dataset.enabled = next.enabled ? 'true' : 'false';
          nameBtn.textContent = getEffectItemLabel(next);
          eyeBtn.replaceChildren(createEyeIcon(next.enabled));
          if (!isBlurEffect(next)) return;
          typeSelect.value = next.type;
          setLengthInput(radiusInput, next.radius);
        },
        dispose(): void {
          itemDisposer.dispose();
          wrap.remove();
        },
      };

      return view;
    }

    // Shadow effect view (Drop Shadow / Inner Shadow)
    const content = document.createElement('div');
    content.className = 'we-effects-popover-content';

    // Type select (only shadow types)
    const typeField = document.createElement('div');
    typeField.className = 'we-field';

    const typeLabel = document.createElement('span');
    typeLabel.className = 'we-field-label';
    typeLabel.textContent = 'Type';

    const typeSelect = document.createElement('select');
    typeSelect.className = 'we-select';
    typeSelect.setAttribute('aria-label', 'Effect type');

    for (const v of EFFECT_TYPE_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = v.value;
      opt.textContent = v.label;
      typeSelect.append(opt);
    }

    typeField.append(typeLabel, typeSelect);

    // X/Y row
    const xyRow = document.createElement('div');
    xyRow.className = 'we-field-row';

    const x = createInputContainer({
      ariaLabel: 'Shadow offset X',
      inputMode: 'decimal',
      prefix: 'X',
      suffix: 'px',
    });
    const y = createInputContainer({
      ariaLabel: 'Shadow offset Y',
      inputMode: 'decimal',
      prefix: 'Y',
      suffix: 'px',
    });
    xyRow.append(x.root, y.root);

    // Blur/Spread row
    const blurRow = document.createElement('div');
    blurRow.className = 'we-field-row';

    const blur = createInputContainer({
      ariaLabel: 'Shadow blur radius',
      inputMode: 'decimal',
      prefix: 'B',
      suffix: 'px',
    });
    const spread = createInputContainer({
      ariaLabel: 'Shadow spread radius',
      inputMode: 'decimal',
      prefix: 'S',
      suffix: 'px',
    });
    blurRow.append(blur.root, spread.root);

    // Color field
    const colorFieldRow = document.createElement('div');
    colorFieldRow.className = 'we-field';

    const colorLabel = document.createElement('span');
    colorLabel.className = 'we-field-label';
    colorLabel.textContent = 'Color';

    const colorMount = document.createElement('div');
    colorMount.style.minWidth = '0';

    colorFieldRow.append(colorLabel, colorMount);

    content.append(typeField, xyRow, blurRow, colorFieldRow);
    popover.append(content);

    // Wire number stepping
    wireNumberStepping(itemDisposer, x.input, { mode: 'css-length' });
    wireNumberStepping(itemDisposer, y.input, { mode: 'css-length' });
    wireNumberStepping(itemDisposer, blur.input, {
      mode: 'css-length',
      min: 0,
      step: 1,
      shiftStep: 10,
      altStep: 0.1,
    });
    wireNumberStepping(itemDisposer, spread.input, {
      mode: 'css-length',
      step: 1,
      shiftStep: 10,
      altStep: 0.1,
    });

    // Create color field
    const colorField = createColorField({
      container: colorMount,
      ariaLabel: 'Shadow color',
      tokensService,
      getTokenTarget: () => currentTarget,
      onInput: (value) => {
        const it = getItem(item.id);
        if (!it || !isShadowEffect(it)) return;
        it.color = value;
        previewCurrentItems();
      },
      onCommit: () => {
        commitTransaction();
      },
      onCancel: () => {
        rollbackTransaction();
        syncFromTarget(true);
      },
    });
    itemDisposer.add(() => colorField.dispose());

    // Wire length field handlers
    const wireShadowLengthField = (
      containerRef: InputContainer,
      key: keyof Pick<ShadowEffectItem, 'offsetX' | 'offsetY' | 'blurRadius' | 'spreadRadius'>,
    ) => {
      itemDisposer.listen(containerRef.input, 'input', () => {
        const it = getItem(item.id);
        if (!it || !isShadowEffect(it)) return;
        const next = combineLengthValue(containerRef.input.value, containerRef.getSuffixText());
        it[key] = next;
        previewCurrentItems();
      });

      itemDisposer.listen(containerRef.input, 'blur', () => {
        commitTransaction();
        syncFromTarget(true);
      });

      itemDisposer.listen(containerRef.input, 'keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitTransaction();
          syncFromTarget(true);
          containerRef.input.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          rollbackTransaction();
          syncFromTarget(true);
        }
      });
    };

    wireShadowLengthField(x, 'offsetX');
    wireShadowLengthField(y, 'offsetY');
    wireShadowLengthField(blur, 'blurRadius');
    wireShadowLengthField(spread, 'spreadRadius');

    // Type change handler
    const onTypeChange = () => {
      updateEffectItemType(item.id, typeSelect.value as EffectTypeValue);
    };

    itemDisposer.listen(typeSelect, 'input', onTypeChange);
    itemDisposer.listen(typeSelect, 'change', onTypeChange);

    const view: ShadowEffectItemView = {
      id: item.id,
      viewType: 'shadow',
      root: wrap,
      row,
      adjustBtn,
      nameBtn,
      eyeBtn,
      deleteBtn,
      popover,
      disposer: itemDisposer,
      typeSelect,
      offsetX: x,
      offsetY: y,
      blur,
      spread,
      colorField,
      setOpen(open: boolean): void {
        row.dataset.open = open ? 'true' : 'false';
        popover.hidden = !open;
      },
      focusFirst(): void {
        typeSelect.focus();
      },
      sync(next: EffectItem): void {
        row.dataset.enabled = next.enabled ? 'true' : 'false';
        nameBtn.textContent = getEffectItemLabel(next);
        eyeBtn.replaceChildren(createEyeIcon(next.enabled));
        if (!isShadowEffect(next)) return;
        typeSelect.value = next.type;
        setLengthInput(x, next.offsetX);
        setLengthInput(y, next.offsetY);
        setLengthInput(blur, next.blurRadius);
        setLengthInput(spread, next.spreadRadius);
        colorField.setValue(next.color);
      },
      dispose(): void {
        itemDisposer.dispose();
        wrap.remove();
      },
    };

    return view;
  }

  // -------------------------------------------------------------------------
  // List Rendering
  // -------------------------------------------------------------------------

  function renderList(): void {
    const ids = new Set(currentItems.map((i) => i.id));

    // Remove stale views
    for (const [id, view] of Array.from(views.entries())) {
      if (!ids.has(id)) {
        if (openItemId === id) openItemId = null;
        view.dispose();
        views.delete(id);
      }
    }

    // Create/update views
    for (const item of currentItems) {
      const existing = views.get(item.id);
      const expectedViewType = getViewTypeForItem(item);
      if (!existing || existing.viewType !== expectedViewType) {
        existing?.dispose();
        views.set(item.id, createItemView(item));
      }

      const view = views.get(item.id)!;
      view.sync(item);
      view.setOpen(openItemId === item.id);
      list.append(view.root);
    }
  }

  // -------------------------------------------------------------------------
  // Sync from Target
  // -------------------------------------------------------------------------

  function syncFromTarget(force = false): void {
    const target = currentTarget;

    if (!target || !target.isConnected) {
      addBtn.disabled = true;
      setCurrentItems([]);
      closePopover({ commit: true });
      renderList();
      return;
    }

    addBtn.disabled = false;
    if (!force && isEditing()) return;

    // Parse box-shadow effects
    const boxShadowInline = readInlineValue(target, BOX_SHADOW_PROPERTY);
    const shadowEffects = parseBoxShadowToEffects(boxShadowInline);

    // Parse filter blur
    const filterInline = readInlineValue(target, 'filter');
    const layerBlur = parseFilterBlurToEffect(filterInline, 'layer-blur');

    // Parse backdrop-filter blur
    const backdropInline = readInlineValue(target, 'backdrop-filter');
    const backdropBlur = parseFilterBlurToEffect(backdropInline, 'backdrop-blur');

    // Combine all enabled effects
    const nextEnabled: EffectItem[] = [
      ...shadowEffects,
      ...(layerBlur ? [layerBlur] : []),
      ...(backdropBlur ? [backdropBlur] : []),
    ];

    const prev = perTargetItems.get(target) ?? [];
    setCurrentItems(reconcileEffectItems(prev, nextEnabled));
    renderList();
  }

  // -------------------------------------------------------------------------
  // Event Handlers
  // -------------------------------------------------------------------------

  disposer.listen(addBtn, 'click', (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const target = currentTarget;
    if (!target || !target.isConnected) return;

    closePopover({ commit: true });
    const newEffect = createDefaultShadowEffect();
    const next = [...currentItems, newEffect];
    setCurrentItems(next);
    renderList();
    applyCurrentItemsDiscrete();
    setPopoverOpen(newEffect.id);
  });

  // Close popover when clicking outside the open item
  // 使用 document 的捕获阶段监听，确保点击 Effects 控件外也能关闭
  const handleClickOutside = (e: MouseEvent) => {
    const openId = openItemId;
    if (!openId) return;
    const view = views.get(openId);
    if (!view) return;

    // Use composedPath to handle Shadow DOM event retargeting
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    const clickedInside =
      path.length > 0
        ? path.includes(view.root)
        : (() => {
            const node = e.target as Node | null;
            return !!(node && view.root.contains(node));
          })();

    if (clickedInside) return;
    closePopover({ commit: true });
  };

  // 在 document 上监听捕获阶段的点击事件
  const doc = root.ownerDocument;
  doc.addEventListener('click', handleClickOutside, true);
  disposer.add(() => doc.removeEventListener('click', handleClickOutside, true));

  // Escape closes the popover and rolls back the current preview transaction
  // 在 root 上监听捕获阶段的键盘事件
  const handleEscape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (!openItemId) return;
    e.preventDefault();
    e.stopPropagation();
    closePopover({ rollback: true });
    syncFromTarget(true);
  };

  root.addEventListener('keydown', handleEscape, true);
  disposer.add(() => root.removeEventListener('keydown', handleEscape, true));

  // -------------------------------------------------------------------------
  // DesignControl Interface
  // -------------------------------------------------------------------------

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;

    if (element !== currentTarget) {
      commitTransaction();
      closePopover({ commit: true });
    }

    currentTarget = element;

    if (element && element.isConnected) {
      setCurrentItems(perTargetItems.get(element) ?? []);
    } else {
      setCurrentItems([]);
    }

    syncFromTarget(true);
  }

  function refresh(): void {
    if (disposer.isDisposed) return;
    syncFromTarget(false);
  }

  function dispose(): void {
    commitTransaction();
    currentTarget = null;
    for (const view of views.values()) view.dispose();
    views.clear();
    disposer.dispose();
  }

  // Initialize
  syncFromTarget(true);

  return { setTarget, refresh, dispose };
}
