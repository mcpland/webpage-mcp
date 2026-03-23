/**
 * Token Resolver (Phase 5.4)
 *
 * Resolves CSS custom property values for specific element contexts.
 *
 * Key features:
 * - Parse and format var() expressions
 * - Read computed custom property values
 * - Check token availability in element context
 *
 * Design decisions:
 * - Primarily uses getComputedStyle() for resolution (safe, no DOM mutation)
 * - Avoids probe element insertion by default (prevents layout/selector side effects)
 * - Probe-based resolution reserved for future phases if needed
 */

import type {
  CssVarName,
  CssVarReference,
  TokenResolution,
  TokenResolvedForProperty,
  TokenResolutionMethod,
} from './types';

// =============================================================================
// Types
// =============================================================================

/** Options for creating a token resolver */
export interface TokenResolverOptions {
  /**
   * Enable probe-based resolution for property previews.
   * @default false (Phase 5.4 recommendation)
   */
  enableProbe?: boolean;
}

/** Options for resolving a token for a specific property */
export interface ResolveForPropertyOptions {
  /** Optional fallback value for var() expression */
  fallback?: string;
  /** Attempt to compute a preview value */
  preview?: boolean;
}

/** Token resolver public interface */
export interface TokenResolver {
  /**
   * Format a CSS var() expression.
   * @example formatCssVar('--color-primary') => 'var(--color-primary)'
   * @example formatCssVar('--color-primary', 'blue') => 'var(--color-primary, blue)'
   */
  formatCssVar(name: CssVarName, fallback?: string): string;

  /**
   * Parse a var() expression.
   * @example parseCssVar('var(--color)') => { name: '--color' }
   * @example parseCssVar('var(--color, blue)') => { name: '--color', fallback: 'blue' }
   * @returns null if not a valid var() expression
   */
  parseCssVar(value: string): CssVarReference | null;

  /**
   * Extract all CSS variable names from an arbitrary value.
   * @example extractCssVarNames('calc(var(--a) + var(--b))') => ['--a', '--b']
   */
  extractCssVarNames(value: string): CssVarName[];

  /**
   * Read the computed value of a custom property for an element.
   * Uses getComputedStyle().getPropertyValue().
   */
  readComputedValue(element: Element, name: CssVarName): string;

  /**
   * Resolve a token's availability and value in an element's context.
   */
  resolveToken(element: Element, name: CssVarName): TokenResolution;

  /**
   * Build the CSS value to apply a token to a specific property.
   * Returns metadata useful for UI display and preview.
   */
  resolveTokenForProperty(
    element: Element,
    name: CssVarName,
    cssProperty: string,
    options?: ResolveForPropertyOptions,
  ): TokenResolvedForProperty;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a token resolver instance.
 */
export function createTokenResolver(options: TokenResolverOptions = {}): TokenResolver {
  const enableProbe = Boolean(options.enableProbe);

  // ===========================================================================
  // var() Formatting and Parsing
  // ===========================================================================

  function formatCssVar(name: CssVarName, fallback?: string): string {
    const fb = typeof fallback === 'string' ? fallback.trim() : '';
    return fb ? `var(${name}, ${fb})` : `var(${name})`;
  }

  function parseCssVar(value: string): CssVarReference | null {
    const raw = String(value ?? '').trim();
    // Case-insensitive var() prefix check
    if (!raw.toLowerCase().startsWith('var(')) return null;

    // Find matching closing parenthesis
    let depth = 0;
    let endIndex = -1;

    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!;
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) {
          endIndex = i;
          break;
        }
      }
    }

    // Strict mode: closing paren must be the last character (standalone var() expression)
    // This rejects values like "var(--x))" or "var(--x) foo"
    if (endIndex < 0 || endIndex !== raw.length - 1) return null;

    // Extract content between var( and )
    const inner = raw.slice(4, endIndex).trim();
    if (!inner) return null;

    // Find top-level comma (not inside nested parentheses)
    let commaIndex = -1;
    depth = 0;

    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]!;
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth = Math.max(0, depth - 1);
      } else if (ch === ',' && depth === 0) {
        commaIndex = i;
        break;
      }
    }

    const nameStr = (commaIndex >= 0 ? inner.slice(0, commaIndex) : inner).trim();
    const fallbackStr = commaIndex >= 0 ? inner.slice(commaIndex + 1).trim() : '';

    if (!nameStr.startsWith('--')) return null;

    const name = nameStr as CssVarName;
    return fallbackStr ? { name, fallback: fallbackStr } : { name };
  }

  function extractCssVarNames(value: string): CssVarName[] {
    const results: CssVarName[] = [];
    const str = String(value ?? '');

    // Match var(--name patterns
    // Note: This regex extracts the name up to the first comma, closing paren, or whitespace
    const regex = /var\(\s*(--[\w-]+)/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(str))) {
      const name = match[1]?.trim();
      if (name?.startsWith('--')) {
        results.push(name as CssVarName);
      }
    }

    return results;
  }

  // ===========================================================================
  // Computed Value Reading
  // ===========================================================================

  function readComputedValue(element: Element, name: CssVarName): string {
    try {
      const computed = window.getComputedStyle(element);
      return computed.getPropertyValue(name).trim();
    } catch {
      return '';
    }
  }

  // ===========================================================================
  // Token Resolution
  // ===========================================================================

  function resolveToken(element: Element, name: CssVarName): TokenResolution {
    const computedValue = readComputedValue(element, name);

    return {
      token: name,
      computedValue,
      availability: computedValue ? 'available' : 'unset',
    };
  }

  function resolveTokenForProperty(
    element: Element,
    name: CssVarName,
    cssProperty: string,
    options: ResolveForPropertyOptions = {},
  ): TokenResolvedForProperty {
    const cssValue = formatCssVar(name, options.fallback);

    // Determine resolution method
    // Phase 5.4: Avoid probe by default, use computed custom property
    const method: TokenResolutionMethod = enableProbe && options.preview ? 'probe' : 'computed';

    // For 'computed' method, we can provide the custom property value
    // but NOT the resolved value for a specific CSS property
    // (that would require a probe element)
    let resolvedValue: string | undefined;

    if (method === 'computed' && options.preview) {
      // Best-effort: return the custom property value itself
      resolvedValue = readComputedValue(element, name) || undefined;
    }

    return {
      token: name,
      cssProperty,
      cssValue,
      resolvedValue,
      method,
    };
  }

  return {
    formatCssVar,
    parseCssVar,
    extractCssVarNames,
    readComputedValue,
    resolveToken,
    resolveTokenForProperty,
  };
}
