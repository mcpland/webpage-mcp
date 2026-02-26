/**
 * CSS Compare Utilities (Phase 4.8)
 *
 * Provides robust CSS value comparison for HMR consistency verification.
 *
 * Design goals:
 * - Compare computed style values (format-agnostic: "1rem" vs "16px" both resolve to same computed value)
 * - Handle numeric tolerance for px-based values and transform matrices
 * - Provide detailed diff information for UI feedback
 *
 * Why computed styles?
 * - Editor mutates live DOM via inline styles for immediate preview
 * - Agent may persist changes via classes/CSS modules/Tailwind, not inline styles
 * - Comparing computed values avoids false mismatches from authoring format differences
 */

// =============================================================================
// Types
// =============================================================================

/** Detailed diff for a single CSS property */
export interface ComputedDiffItem {
  /** CSS property name */
  readonly property: string;
  /** Expected value (from baseline) */
  readonly expected: string;
  /** Actual value (from current DOM) */
  readonly actual: string;
  /** Whether values match */
  readonly match: boolean;
  /** How comparison was determined */
  readonly reason?: 'exact' | 'px_epsilon' | 'matrix_epsilon' | 'string';
}

/** Result of comparing two computed style maps */
export interface CompareComputedResult {
  /** Overall match status */
  readonly matches: boolean;
  /** Per-property diff details */
  readonly diffs: readonly ComputedDiffItem[];
}

/** Options for CSS value comparison */
export interface CompareComputedOptions {
  /**
   * Epsilon for px-based numeric comparison.
   * Defaults to 0.5 to tolerate sub-pixel jitter from rounding.
   */
  readonly pxEpsilon?: number;
  /**
   * Epsilon for matrix()/matrix3d() numeric comparison.
   * Defaults to 1e-3 for floating-point precision tolerance.
   */
  readonly matrixEpsilon?: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_PX_EPSILON = 0.5;
const DEFAULT_MATRIX_EPSILON = 1e-3;

// Regex patterns (defined once for performance)
const PX_VALUE_REGEX = /(-?\d*\.?\d+(?:e[+-]?\d+)?)px/gi;
const MATRIX_NUMBER_REGEX = /-?\d*\.?\d+(?:e[+-]?\d+)?/gi;

// =============================================================================
// Public API
// =============================================================================

/**
 * Normalize text content for robust comparison.
 * Collapses whitespace and trims edges.
 */
export function normalizeText(text: string): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read computed style values for specified CSS properties.
 *
 * @param element - Target element
 * @param properties - CSS property names to read
 * @returns Map of property name to computed value (normalized)
 */
export function readComputedMap(
  element: Element,
  properties: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};

  // Deduplicate and filter empty property names
  const uniqueProps: string[] = [];
  const seen = new Set<string>();
  for (const raw of properties) {
    const prop = String(raw ?? '').trim();
    if (!prop || seen.has(prop)) continue;
    seen.add(prop);
    uniqueProps.push(prop);
  }

  // Safely get computed style declaration
  let computed: CSSStyleDeclaration | null = null;
  try {
    computed = window.getComputedStyle(element);
  } catch {
    // Element may not be attached to DOM or other edge cases
    computed = null;
  }

  // Read each property
  for (const property of uniqueProps) {
    let value = '';
    try {
      value = computed?.getPropertyValue(property) ?? '';
    } catch {
      value = '';
    }
    result[property] = normalizeCssValue(value);
  }

  return result;
}

/**
 * Compare two computed style maps with numeric tolerance.
 *
 * Comparison strategy:
 * 1. Exact string match → pass
 * 2. matrix()/matrix3d() numeric tolerance → pass if within epsilon
 * 3. px-based numeric tolerance → pass if same shape and within epsilon
 * 4. Otherwise → fail
 *
 * @param expected - Baseline computed values
 * @param actual - Current computed values
 * @param options - Comparison options
 * @returns Comparison result with per-property diffs
 */
export function compareComputed(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
  options: CompareComputedOptions = {},
): CompareComputedResult {
  const pxEps = Number.isFinite(options.pxEpsilon) ? options.pxEpsilon! : DEFAULT_PX_EPSILON;
  const matrixEps = Number.isFinite(options.matrixEpsilon)
    ? options.matrixEpsilon!
    : DEFAULT_MATRIX_EPSILON;

  const diffs: ComputedDiffItem[] = [];

  for (const property of Object.keys(expected)) {
    const exp = normalizeCssValue(expected[property] ?? '');
    const act = normalizeCssValue(actual[property] ?? '');

    const { match, reason } = compareSingleValue(exp, act, pxEps, matrixEps);
    diffs.push({ property, expected: exp, actual: act, match, reason });
  }

  const matches = diffs.every((d) => d.match);
  return { matches, diffs };
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Normalize a CSS value string for consistent comparison.
 * Collapses whitespace and normalizes spacing around punctuation.
 */
function normalizeCssValue(raw: string): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ') // Collapse whitespace
    .replace(/,\s+/g, ',') // Remove space after commas
    .replace(/\(\s+/g, '(') // Remove space after open paren
    .replace(/\s+\)/g, ')') // Remove space before close paren
    .trim();
}

/**
 * Check if two numbers are approximately equal within epsilon.
 */
function approximatelyEqual(a: number, b: number, epsilon: number): boolean {
  return Math.abs(a - b) <= epsilon;
}

/**
 * Check if value looks like a CSS matrix transform.
 */
function isMatrixValue(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.startsWith('matrix(') || lower.startsWith('matrix3d(');
}

/**
 * Extract numeric components from a matrix() or matrix3d() value.
 * Returns null if not a valid matrix or contains invalid numbers.
 */
function extractMatrixNumbers(value: string): number[] | null {
  if (!isMatrixValue(value)) return null;

  const matches = value.match(MATRIX_NUMBER_REGEX);
  if (!matches || matches.length === 0) return null;

  const nums: number[] = [];
  for (const m of matches) {
    const n = Number(m);
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }

  return nums.length > 0 ? nums : null;
}

/**
 * Extract px numeric values from a CSS value string.
 * Returns null if no px values found or contains invalid numbers.
 */
function extractPxNumbers(value: string): number[] | null {
  const nums: number[] = [];

  // Reset regex state (global flag requires this)
  PX_VALUE_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = PX_VALUE_REGEX.exec(value)) !== null) {
    const n = Number(match[1]);
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }

  return nums.length > 0 ? nums : null;
}

/**
 * Get the "shape" of a px-based value by replacing numeric values with placeholders.
 * Used to ensure we're comparing structurally similar values.
 */
function pxValueShape(value: string): string {
  // Reset regex state
  PX_VALUE_REGEX.lastIndex = 0;
  return normalizeCssValue(value).replace(PX_VALUE_REGEX, '#px');
}

/**
 * Compare two matrix values with numeric tolerance.
 */
function compareMatrixWithEpsilon(expected: string, actual: string, epsilon: number): boolean {
  const expNums = extractMatrixNumbers(expected);
  const actNums = extractMatrixNumbers(actual);

  if (!expNums || !actNums) return false;
  if (expNums.length !== actNums.length) return false;

  // Ensure both are same type (matrix vs matrix3d)
  const expKind = expected.toLowerCase().startsWith('matrix3d(') ? 'matrix3d' : 'matrix';
  const actKind = actual.toLowerCase().startsWith('matrix3d(') ? 'matrix3d' : 'matrix';
  if (expKind !== actKind) return false;

  // Compare each component with epsilon
  for (let i = 0; i < expNums.length; i++) {
    if (!approximatelyEqual(expNums[i]!, actNums[i]!, epsilon)) return false;
  }

  return true;
}

/**
 * Compare two px-based values with numeric tolerance.
 */
function comparePxWithEpsilon(expected: string, actual: string, epsilon: number): boolean {
  const expNums = extractPxNumbers(expected);
  const actNums = extractPxNumbers(actual);

  if (!expNums || !actNums) return false;
  if (expNums.length !== actNums.length) return false;

  // Ensure values have same structure (e.g., "10px 20px" vs "10px 20px", not "10px" vs "10px solid")
  if (pxValueShape(expected) !== pxValueShape(actual)) return false;

  // Compare each px value with epsilon
  for (let i = 0; i < expNums.length; i++) {
    if (!approximatelyEqual(expNums[i]!, actNums[i]!, epsilon)) return false;
  }

  return true;
}

/**
 * Compare a single CSS value pair with all available strategies.
 */
function compareSingleValue(
  expected: string,
  actual: string,
  pxEpsilon: number,
  matrixEpsilon: number,
): { match: boolean; reason: ComputedDiffItem['reason'] } {
  // 1. Exact string match (fastest path)
  if (expected === actual) {
    return { match: true, reason: 'exact' };
  }

  // 2. Matrix tolerance comparison
  if (isMatrixValue(expected) && isMatrixValue(actual)) {
    if (compareMatrixWithEpsilon(expected, actual, matrixEpsilon)) {
      return { match: true, reason: 'matrix_epsilon' };
    }
  }

  // 3. Px tolerance comparison
  const expHasPx = PX_VALUE_REGEX.test(expected);
  PX_VALUE_REGEX.lastIndex = 0; // Reset after test
  const actHasPx = PX_VALUE_REGEX.test(actual);
  PX_VALUE_REGEX.lastIndex = 0; // Reset after test

  if (expHasPx && actHasPx) {
    if (comparePxWithEpsilon(expected, actual, pxEpsilon)) {
      return { match: true, reason: 'px_epsilon' };
    }
  }

  // 4. No match
  return { match: false, reason: 'string' };
}
