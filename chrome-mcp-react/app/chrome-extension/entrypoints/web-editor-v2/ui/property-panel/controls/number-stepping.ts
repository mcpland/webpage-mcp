/**
 * Number Stepping (Keyboard)
 *
 * Adds ArrowUp/ArrowDown stepping for number-like inputs in the property panel.
 * Supports both pure numbers and CSS length values (e.g., "10px", "1.5rem").
 *
 * Usage:
 * - size-control.ts (width/height)
 * - spacing-control.ts (margin/padding)
 * - position-control.ts (top/right/bottom/left, z-index)
 * - layout-control.ts (gap)
 * - typography-control.ts (font-size, line-height)
 * - appearance-control.ts (opacity, border-radius, border-width)
 */

import type { Disposer } from '../../../utils/disposables';

// =============================================================================
// Types
// =============================================================================

/** Stepping mode: pure number or CSS length with unit */
export type NumberSteppingMode = 'number' | 'css-length';

export interface NumberSteppingOptions {
  /** Mode: 'number' for pure numbers, 'css-length' for values with units */
  mode: NumberSteppingMode;
  /** Base step amount (default: 1) */
  step?: number;
  /** Step amount when Shift is held (default: 10) */
  shiftStep?: number;
  /** Step amount when Alt/Option is held (default: 0.1) */
  altStep?: number;
  /** Minimum value (optional) */
  min?: number;
  /** Maximum value (optional) */
  max?: number;
  /** Round to integer (default: false) */
  integer?: boolean;
  /** Allowed units for css-length mode (default: ['', 'px']) */
  allowedUnits?: readonly string[];
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_STEP = 1;
const DEFAULT_SHIFT_STEP = 10;
const DEFAULT_ALT_STEP = 0.1;
// Default units for CSS length values
// Note: auto, calc(), var(), etc. are not steppable
const DEFAULT_ALLOWED_UNITS: readonly string[] = [
  '',
  'px',
  '%',
  'rem',
  'em',
  'vh',
  'vw',
  'vmin',
  'vmax',
];
const MAX_FRACTION_DIGITS = 10;

// =============================================================================
// Parsing Helpers
// =============================================================================

interface ParsedNumber {
  value: number;
  digits: number;
}

interface ParsedCssLength extends ParsedNumber {
  unit: string;
}

/**
 * Count decimal digits in a numeric string
 */
function countFractionDigits(raw: string): number {
  const dotIndex = raw.indexOf('.');
  if (dotIndex < 0) return 0;
  return Math.max(0, raw.length - dotIndex - 1);
}

/**
 * Get decimal digits needed to represent a step value
 */
function countStepDigits(step: number): number {
  if (!Number.isFinite(step)) return 0;
  const raw = String(step);
  // Avoid scientific notation
  if (raw.includes('e') || raw.includes('E')) return 0;
  return countFractionDigits(raw);
}

/**
 * Clamp fraction digits to a reasonable range
 */
function clampDigits(digits: number): number {
  if (!Number.isFinite(digits)) return 0;
  return Math.max(0, Math.min(MAX_FRACTION_DIGITS, Math.trunc(digits)));
}

/**
 * Format a number with specified decimal digits, trimming trailing zeros
 */
function formatNumber(value: number, digits: number): string {
  const d = clampDigits(digits);
  const fixed = value.toFixed(d);
  if (d === 0) return fixed;
  // Remove trailing zeros: "1.500" -> "1.5", "1.0" -> "1"
  return fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

// Regex for parsing numbers: 10, 10., 10.5, .5, -.5
const NUMBER_REGEX = /^(-?(?:(?:\d+\.\d+)|(?:\d+\.)|(?:\d+)|(?:\.\d+)))$/;

/**
 * Parse a pure number string
 */
function parseNumberValue(raw: string): ParsedNumber | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const match = trimmed.match(NUMBER_REGEX);
  if (!match) return null;

  const numRaw = match[1] ?? '';
  const normalized = numRaw.endsWith('.') ? numRaw.slice(0, -1) : numRaw;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;

  return { value, digits: countFractionDigits(normalized) };
}

// Regex for parsing CSS lengths: 10px, 10.5rem, .5em, etc.
const CSS_LENGTH_REGEX = /^(-?(?:(?:\d+\.\d+)|(?:\d+\.)|(?:\d+)|(?:\.\d+)))\s*([a-zA-Z%]*)$/;

/**
 * Parse a CSS length value (number + optional unit)
 */
function parseCssLengthValue(raw: string, allowedUnits: readonly string[]): ParsedCssLength | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const match = trimmed.match(CSS_LENGTH_REGEX);
  if (!match) return null;

  const numRaw = match[1] ?? '';
  const unit = (match[2] ?? '').toLowerCase();

  // Validate unit
  if (!allowedUnits.includes(unit)) return null;

  const normalized = numRaw.endsWith('.') ? numRaw.slice(0, -1) : numRaw;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;

  return { value, digits: countFractionDigits(normalized), unit };
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * Wire up keyboard stepping for a number input
 *
 * @param disposer - Disposer for cleanup
 * @param input - The input element to enhance
 * @param options - Stepping configuration
 */
export function wireNumberStepping(
  disposer: Disposer,
  input: HTMLInputElement,
  options: NumberSteppingOptions,
): void {
  const {
    mode,
    step: baseStep = DEFAULT_STEP,
    shiftStep = DEFAULT_SHIFT_STEP,
    altStep = DEFAULT_ALT_STEP,
    min,
    max,
    integer = false,
    allowedUnits = DEFAULT_ALLOWED_UNITS,
  } = options;

  disposer.listen(input, 'keydown', (event: KeyboardEvent) => {
    // Only handle arrow up/down
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

    // Preserve navigation shortcuts (Cmd/Ctrl + Arrow for cursor movement)
    if (event.metaKey || event.ctrlKey) return;

    // Skip disabled/readonly inputs
    if (input.disabled || input.readOnly) return;

    const direction = event.key === 'ArrowUp' ? 1 : -1;

    // Determine step size based on modifier keys
    let delta: number;
    if (event.altKey) {
      delta = altStep;
    } else if (event.shiftKey) {
      delta = shiftStep;
    } else {
      delta = baseStep;
    }

    if (!Number.isFinite(delta) || delta === 0) return;

    // Get current value (prefer input value, fallback to placeholder)
    const source = (input.value || input.placeholder || '').trim();

    // Parse based on mode
    let parsed: ParsedNumber | ParsedCssLength | null = null;
    let unit = '';

    if (mode === 'number') {
      parsed = parseNumberValue(source);
      if (!parsed && !source) {
        // Empty input: start from 0
        parsed = { value: 0, digits: 0 };
      }
    } else {
      const cssResult = parseCssLengthValue(source, allowedUnits);
      if (cssResult) {
        parsed = cssResult;
        unit = cssResult.unit;
      } else if (!source) {
        // Empty input: start from 0
        parsed = { value: 0, digits: 0 };
        unit = '';
      }
    }

    if (!parsed) return;

    // Calculate new value
    const digits = integer ? 0 : Math.max(parsed.digits, countStepDigits(delta));
    let next = parsed.value + direction * delta;

    // Apply constraints
    if (typeof min === 'number') next = Math.max(min, next);
    if (typeof max === 'number') next = Math.min(max, next);
    if (integer) next = Math.round(next);

    // Format result
    const formatted = formatNumber(next, digits);
    const nextRaw = mode === 'css-length' ? `${formatted}${unit}` : formatted;

    // Prevent default and update input
    event.preventDefault();
    input.value = nextRaw;

    // Dispatch input event to trigger existing preview/transaction logic
    try {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } catch {
      // Best-effort event dispatch
    }
  });
}
