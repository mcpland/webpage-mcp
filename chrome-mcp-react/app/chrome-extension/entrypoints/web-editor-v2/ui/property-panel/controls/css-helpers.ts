/**
 * CSS Value Helpers
 *
 * Shared utilities for parsing and normalizing CSS values.
 * Used by control components for input-container suffix management.
 */

// =============================================================================
// Constants
// =============================================================================

/** CSS keywords that should not display a unit suffix */
const LENGTH_KEYWORDS = new Set([
  'auto',
  'inherit',
  'initial',
  'unset',
  'none',
  'fit-content',
  'min-content',
  'max-content',
  'revert',
  'revert-layer',
]);

/** Regex to detect CSS function expressions */
const LENGTH_FUNCTION_REGEX = /\b(?:calc|var|clamp|min|max|fit-content)\s*\(/i;

/** Regex to match number with unit (e.g., "20px", "50%") */
const NUMBER_WITH_UNIT_REGEX = /^(-?(?:\d+|\d*\.\d+|\.\d+))\s*([a-zA-Z%]+)$/;

/** Regex to match pure numbers */
const PURE_NUMBER_REGEX = /^-?(?:\d+|\d*\.\d+|\.\d+)$/;

/** Regex to match numbers with trailing dot (e.g., "10.") */
const TRAILING_DOT_NUMBER_REGEX = /^-?\d+\.$/;

// =============================================================================
// Types
// =============================================================================

/** Result of formatting a length value for display */
export interface FormattedLength {
  /** The numeric or keyword value to display in the input */
  value: string;
  /** The unit suffix to display, or null if no suffix should be shown */
  suffix: string | null;
}

// =============================================================================
// Functions
// =============================================================================

/**
 * Extract CSS unit suffix from a length value.
 * Supports px, %, rem, em, vh, vw, etc.
 * Falls back to 'px' for pure numbers or unknown patterns.
 *
 * @example
 * extractUnitSuffix('100px') // 'px'
 * extractUnitSuffix('50%') // '%'
 * extractUnitSuffix('2rem') // 'rem'
 * extractUnitSuffix('100') // 'px' (default)
 * extractUnitSuffix('auto') // 'px' (fallback)
 */
export function extractUnitSuffix(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'px';

  // Handle shorthand values by taking first token
  const token = trimmed.split(/\s+/)[0] ?? '';

  // Match number + unit (including %)
  const match = token.match(/^-?(?:\d+|\d*\.\d+)([a-zA-Z%]+)$/);
  if (match) return match[1]!;

  // Pure number: default to px
  if (/^-?(?:\d+|\d*\.\d+)$/.test(token)) return 'px';
  if (/^-?\d+\.$/.test(token)) return 'px';

  return 'px';
}

/**
 * Check if a value has an explicit CSS unit.
 * Returns false for unitless numbers (e.g., "1.5" for line-height).
 *
 * @example
 * hasExplicitUnit('100px') // true
 * hasExplicitUnit('1.5') // false
 * hasExplicitUnit('auto') // false
 */
export function hasExplicitUnit(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const token = trimmed.split(/\s+/)[0] ?? '';
  return /^-?(?:\d+|\d*\.\d+)([a-zA-Z%]+)$/.test(token);
}

/**
 * Normalize a length value.
 * - Pure numbers (e.g., "100", "10.5") get "px" suffix
 * - Values with units or keywords pass through unchanged
 * - Empty string clears the inline style
 *
 * @example
 * normalizeLength('100') // '100px'
 * normalizeLength('10.5') // '10.5px'
 * normalizeLength('50%') // '50%'
 * normalizeLength('auto') // 'auto'
 * normalizeLength('') // ''
 */
export function normalizeLength(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  // Pure number patterns: "10", "-10", "10.5", ".5", "-.5"
  if (/^-?(?:\d+|\d*\.\d+)$/.test(trimmed)) {
    return `${trimmed}px`;
  }

  // Trailing dot (e.g., "10.") -> treat as integer px
  if (/^-?\d+\.$/.test(trimmed)) {
    return `${trimmed.slice(0, -1)}px`;
  }

  // Keep units/keywords/expressions as-is
  return trimmed;
}

/**
 * Format a CSS length value for display in an input + suffix UI.
 *
 * Separates the numeric value from its unit to avoid duplication
 * (e.g., displaying "20px" in input and "px" as suffix).
 *
 * @example
 * formatLengthForDisplay('20px')    // { value: '20', suffix: 'px' }
 * formatLengthForDisplay('50%')     // { value: '50', suffix: '%' }
 * formatLengthForDisplay('auto')    // { value: 'auto', suffix: null }
 * formatLengthForDisplay('calc(...)') // { value: 'calc(...)', suffix: null }
 * formatLengthForDisplay('20')      // { value: '20', suffix: 'px' }
 * formatLengthForDisplay('')        // { value: '', suffix: 'px' }
 */
export function formatLengthForDisplay(raw: string): FormattedLength {
  const trimmed = raw.trim();

  // Empty: show default "px" suffix for consistent affordance
  if (!trimmed) {
    return { value: '', suffix: 'px' };
  }

  const lower = trimmed.toLowerCase();

  // Keywords should not show any unit suffix
  if (LENGTH_KEYWORDS.has(lower)) {
    return { value: trimmed, suffix: null };
  }

  // Function expressions (calc, var, etc.) should not show suffix
  if (LENGTH_FUNCTION_REGEX.test(trimmed)) {
    return { value: trimmed, suffix: null };
  }

  // Number with unit: separate value and suffix
  const unitMatch = trimmed.match(NUMBER_WITH_UNIT_REGEX);
  if (unitMatch) {
    const value = unitMatch[1] ?? '';
    const suffix = unitMatch[2] ?? '';
    return { value, suffix: suffix || null };
  }

  // Pure number: default to "px" suffix
  if (PURE_NUMBER_REGEX.test(trimmed)) {
    return { value: trimmed, suffix: 'px' };
  }

  // Trailing dot number (e.g., "10."): treat as integer with "px"
  if (TRAILING_DOT_NUMBER_REGEX.test(trimmed)) {
    return { value: trimmed.slice(0, -1), suffix: 'px' };
  }

  // Fallback: unknown value, don't show misleading suffix
  return { value: trimmed, suffix: null };
}

/**
 * Combine an input value with a unit suffix to form a complete CSS value.
 *
 * This is the inverse of formatLengthForDisplay - it takes the separated
 * value and suffix and combines them for CSS writing.
 *
 * @param inputValue - The value from the input field
 * @param suffix - The current unit suffix (from getSuffixText)
 * @returns The complete CSS value ready for style.setProperty()
 *
 * @example
 * combineLengthValue('20', 'px')     // '20px'
 * combineLengthValue('50', '%')      // '50%'
 * combineLengthValue('auto', null)   // 'auto'
 * combineLengthValue('', 'px')       // ''
 * combineLengthValue('calc(...)', null) // 'calc(...)'
 */
export function combineLengthValue(inputValue: string, suffix: string | null): string {
  const trimmed = inputValue.trim();

  // Empty value clears the style
  if (!trimmed) return '';

  const lower = trimmed.toLowerCase();

  // Keywords should not have suffix appended
  if (LENGTH_KEYWORDS.has(lower)) return trimmed;

  // Function expressions should not have suffix appended
  if (LENGTH_FUNCTION_REGEX.test(trimmed)) return trimmed;

  // If input already has a unit (user typed "20px"), use it as-is
  if (NUMBER_WITH_UNIT_REGEX.test(trimmed)) return trimmed;

  // Trailing dot number (e.g., "10."): normalize and add suffix
  if (TRAILING_DOT_NUMBER_REGEX.test(trimmed)) {
    const normalized = trimmed.slice(0, -1);
    return suffix ? `${normalized}${suffix}` : `${normalized}px`;
  }

  // Pure number: append suffix (or default to px)
  if (PURE_NUMBER_REGEX.test(trimmed)) {
    return suffix ? `${trimmed}${suffix}` : `${trimmed}px`;
  }

  // Fallback: return as-is (might be invalid, but let browser handle it)
  return trimmed;
}
