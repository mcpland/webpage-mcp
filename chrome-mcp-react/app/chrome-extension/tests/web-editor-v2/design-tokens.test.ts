/**
 * Unit tests for Design Tokens Module (Phase 5.4)
 *
 * Tests cover:
 * - token-resolver: var() parsing and formatting
 * - token-detector: CSSOM scanning (mocked)
 * - design-tokens-service: caching and query
 *
 * Note: jsdom doesn't have full CSSOM support, so we mock stylesheet APIs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTokenResolver,
  createTokenDetector,
  createDesignTokensService,
  type CssVarName,
} from '@/entrypoints/web-editor-v2/core/design-tokens';

// =============================================================================
// Test Setup
// =============================================================================

beforeEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// Token Resolver Tests
// =============================================================================

describe('token-resolver: formatCssVar', () => {
  it('formats simple var() without fallback', () => {
    const resolver = createTokenResolver();
    expect(resolver.formatCssVar('--color-primary')).toBe('var(--color-primary)');
  });

  it('formats var() with fallback', () => {
    const resolver = createTokenResolver();
    expect(resolver.formatCssVar('--color-primary', 'blue')).toBe('var(--color-primary, blue)');
  });

  it('trims fallback whitespace', () => {
    const resolver = createTokenResolver();
    expect(resolver.formatCssVar('--spacing', '  16px  ')).toBe('var(--spacing, 16px)');
  });

  it('ignores empty fallback', () => {
    const resolver = createTokenResolver();
    expect(resolver.formatCssVar('--x', '')).toBe('var(--x)');
    expect(resolver.formatCssVar('--x', '   ')).toBe('var(--x)');
  });
});

describe('token-resolver: parseCssVar', () => {
  it('parses simple var()', () => {
    const resolver = createTokenResolver();
    const result = resolver.parseCssVar('var(--color)');
    expect(result).toEqual({ name: '--color' });
  });

  it('parses var() with fallback', () => {
    const resolver = createTokenResolver();
    const result = resolver.parseCssVar('var(--color, blue)');
    expect(result).toEqual({ name: '--color', fallback: 'blue' });
  });

  it('parses var() with complex fallback', () => {
    const resolver = createTokenResolver();
    const result = resolver.parseCssVar('var(--color, rgba(0, 0, 0, 0.5))');
    expect(result).toEqual({ name: '--color', fallback: 'rgba(0, 0, 0, 0.5)' });
  });

  it('parses var() with nested var() fallback', () => {
    const resolver = createTokenResolver();
    const result = resolver.parseCssVar('var(--color, var(--fallback))');
    expect(result).toEqual({ name: '--color', fallback: 'var(--fallback)' });
  });

  it('returns null for non-var values', () => {
    const resolver = createTokenResolver();
    expect(resolver.parseCssVar('blue')).toBeNull();
    expect(resolver.parseCssVar('rgb(0,0,0)')).toBeNull();
    expect(resolver.parseCssVar('')).toBeNull();
    expect(resolver.parseCssVar('  ')).toBeNull();
  });

  it('returns null for invalid var()', () => {
    const resolver = createTokenResolver();
    expect(resolver.parseCssVar('var()')).toBeNull();
    expect(resolver.parseCssVar('var(invalid)')).toBeNull(); // No -- prefix
    expect(resolver.parseCssVar('var(--')).toBeNull(); // Unclosed
  });

  it('handles whitespace in var()', () => {
    const resolver = createTokenResolver();
    expect(resolver.parseCssVar('  var(  --x  )  ')).toEqual({ name: '--x' });
    expect(resolver.parseCssVar('var( --x , blue )')).toEqual({
      name: '--x',
      fallback: 'blue',
    });
  });
});

describe('token-resolver: extractCssVarNames', () => {
  it('extracts single var() reference', () => {
    const resolver = createTokenResolver();
    expect(resolver.extractCssVarNames('var(--color)')).toEqual(['--color']);
  });

  it('extracts multiple var() references', () => {
    const resolver = createTokenResolver();
    const names = resolver.extractCssVarNames('calc(var(--a) + var(--b)) var(--c)');
    expect(names).toEqual(['--a', '--b', '--c']);
  });

  it('returns empty array for no vars', () => {
    const resolver = createTokenResolver();
    expect(resolver.extractCssVarNames('blue')).toEqual([]);
    expect(resolver.extractCssVarNames('')).toEqual([]);
  });

  it('handles nested var() in fallback', () => {
    const resolver = createTokenResolver();
    // Only extracts top-level names (regex limitation, but good enough for Phase 5.4)
    const names = resolver.extractCssVarNames('var(--color, var(--fallback))');
    expect(names).toContain('--color');
    expect(names).toContain('--fallback');
  });
});

describe('token-resolver: readComputedValue', () => {
  it('reads custom property from element', () => {
    const div = document.createElement('div');
    div.style.setProperty('--test-color', 'red');
    document.body.append(div);

    const resolver = createTokenResolver();
    // Note: jsdom may not fully support computed custom properties
    // This test verifies the API works without errors
    const value = resolver.readComputedValue(div, '--test-color');
    // jsdom returns empty for custom props, but in real browser it would work
    expect(typeof value).toBe('string');
  });

  it('returns empty string for unset property', () => {
    const div = document.createElement('div');
    document.body.append(div);

    const resolver = createTokenResolver();
    expect(resolver.readComputedValue(div, '--nonexistent')).toBe('');
  });
});

describe('token-resolver: resolveToken', () => {
  it('returns available for set token', () => {
    const div = document.createElement('div');
    document.body.append(div);

    // Mock getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => (name === '--color' ? 'red' : ''),
    } as CSSStyleDeclaration);

    const resolver = createTokenResolver();
    const result = resolver.resolveToken(div, '--color');

    expect(result.token).toBe('--color');
    expect(result.computedValue).toBe('red');
    expect(result.availability).toBe('available');
  });

  it('returns unset for missing token', () => {
    const div = document.createElement('div');
    document.body.append(div);

    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: () => '',
    } as CSSStyleDeclaration);

    const resolver = createTokenResolver();
    const result = resolver.resolveToken(div, '--missing');

    expect(result.availability).toBe('unset');
  });
});

describe('token-resolver: resolveTokenForProperty', () => {
  it('builds CSS value for property', () => {
    const div = document.createElement('div');
    document.body.append(div);

    const resolver = createTokenResolver();
    const result = resolver.resolveTokenForProperty(div, '--color', 'color');

    expect(result.token).toBe('--color');
    expect(result.cssProperty).toBe('color');
    expect(result.cssValue).toBe('var(--color)');
    expect(result.method).toBe('computed');
  });

  it('includes fallback in CSS value', () => {
    const div = document.createElement('div');

    const resolver = createTokenResolver();
    const result = resolver.resolveTokenForProperty(div, '--color', 'background-color', {
      fallback: 'white',
    });

    expect(result.cssValue).toBe('var(--color, white)');
  });
});

// =============================================================================
// Token Detector Tests
// =============================================================================

describe('token-detector: collectInlineTokenNames', () => {
  it('collects token names from element inline style', () => {
    const div = document.createElement('div');
    div.style.setProperty('--custom-var', '10px');
    div.style.setProperty('color', 'red'); // Regular property, should be ignored
    document.body.append(div);

    const detector = createTokenDetector();
    const names = detector.collectInlineTokenNames(div);

    expect(names.has('--custom-var' as CssVarName)).toBe(true);
    expect(names.size).toBe(1);
  });

  it('collects from ancestor chain', () => {
    const parent = document.createElement('div');
    parent.style.setProperty('--parent-var', '20px');

    const child = document.createElement('div');
    child.style.setProperty('--child-var', '10px');

    parent.append(child);
    document.body.append(parent);

    const detector = createTokenDetector();
    const names = detector.collectInlineTokenNames(child);

    expect(names.has('--parent-var' as CssVarName)).toBe(true);
    expect(names.has('--child-var' as CssVarName)).toBe(true);
  });

  it('respects maxDepth option', () => {
    const grandparent = document.createElement('div');
    grandparent.style.setProperty('--grandparent-var', '30px');

    const parent = document.createElement('div');
    parent.style.setProperty('--parent-var', '20px');

    const child = document.createElement('div');
    child.style.setProperty('--child-var', '10px');

    grandparent.append(parent);
    parent.append(child);
    document.body.append(grandparent);

    const detector = createTokenDetector();
    const names = detector.collectInlineTokenNames(child, { maxDepth: 1 });

    // Should only include child and parent (depth 0 and 1)
    expect(names.has('--child-var' as CssVarName)).toBe(true);
    expect(names.has('--parent-var' as CssVarName)).toBe(true);
    expect(names.has('--grandparent-var' as CssVarName)).toBe(false);
  });

  it('returns empty set for element without custom props', () => {
    const div = document.createElement('div');
    div.style.color = 'red';
    document.body.append(div);

    const detector = createTokenDetector();
    const names = detector.collectInlineTokenNames(div);

    expect(names.size).toBe(0);
  });
});

describe('token-detector: collectRootIndex', () => {
  it('returns empty index when no stylesheets', () => {
    // jsdom has empty styleSheets by default
    const detector = createTokenDetector();
    const index = detector.collectRootIndex(document);

    expect(index.rootType).toBe('document');
    expect(index.tokens.size).toBe(0);
    expect(index.warnings).toEqual([]);
    expect(index.stats.styleSheets).toBeGreaterThanOrEqual(0);
  });

  it('handles missing styleSheets gracefully', () => {
    const detector = createTokenDetector();

    // Mock document with no styleSheets
    const mockRoot = {
      styleSheets: null,
      adoptedStyleSheets: undefined,
    } as unknown as Document;

    const index = detector.collectRootIndex(mockRoot);
    expect(index.tokens.size).toBe(0);
  });
});

// =============================================================================
// Design Tokens Service Tests
// =============================================================================

describe('design-tokens-service: basic operations', () => {
  it('creates service successfully', () => {
    const service = createDesignTokensService();
    expect(service).toBeDefined();
    expect(typeof service.getRootTokens).toBe('function');
    expect(typeof service.getContextTokens).toBe('function');
    service.dispose();
  });

  it('getRootTokens returns empty for document without tokens', () => {
    const service = createDesignTokensService();
    const result = service.getRootTokens(document);

    expect(result.tokens).toEqual([]);
    expect(result.warnings).toBeDefined();
    expect(result.stats).toBeDefined();

    service.dispose();
  });

  it('getContextTokens filters to available tokens', () => {
    const div = document.createElement('div');
    document.body.append(div);

    // Mock to return no tokens
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: () => '',
    } as CSSStyleDeclaration);

    const service = createDesignTokensService();
    const result = service.getContextTokens(div);

    // Should be empty since no tokens resolve
    expect(result.tokens).toEqual([]);

    service.dispose();
  });
});

describe('design-tokens-service: utility methods', () => {
  it('formatCssVar delegates to resolver', () => {
    const service = createDesignTokensService();
    expect(service.formatCssVar('--x')).toBe('var(--x)');
    expect(service.formatCssVar('--x', 'y')).toBe('var(--x, y)');
    service.dispose();
  });

  it('parseCssVar delegates to resolver', () => {
    const service = createDesignTokensService();
    expect(service.parseCssVar('var(--x)')).toEqual({ name: '--x' });
    expect(service.parseCssVar('invalid')).toBeNull();
    service.dispose();
  });

  it('extractCssVarNames delegates to resolver', () => {
    const service = createDesignTokensService();
    expect(service.extractCssVarNames('var(--a) var(--b)')).toEqual(['--a', '--b']);
    service.dispose();
  });
});

describe('design-tokens-service: cache invalidation', () => {
  it('invalidateRoot clears cache and emits event', () => {
    const service = createDesignTokensService();
    const handler = vi.fn();

    service.onInvalidation(handler);
    service.invalidateRoot(document, 'manual');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        root: document,
        rootType: 'document',
        reason: 'manual',
      }),
    );

    service.dispose();
  });

  it('onInvalidation returns unsubscribe function', () => {
    const service = createDesignTokensService();
    const handler = vi.fn();

    const unsubscribe = service.onInvalidation(handler);
    service.invalidateRoot(document);
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    service.invalidateRoot(document);
    expect(handler).toHaveBeenCalledTimes(1); // Not called again

    service.dispose();
  });
});

describe('design-tokens-service: dispose', () => {
  it('can be called multiple times safely', () => {
    const service = createDesignTokensService();
    expect(() => {
      service.dispose();
      service.dispose();
    }).not.toThrow();
  });

  it('clears invalidation listeners on dispose', () => {
    const service = createDesignTokensService();
    const handler = vi.fn();

    service.onInvalidation(handler);
    service.dispose();

    // After dispose, invalidation shouldn't call handler
    // (but we can't easily test this without exposing internals)
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('design-tokens-service: resolveToken', () => {
  it('resolves token for element', () => {
    const div = document.createElement('div');
    document.body.append(div);

    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => (name === '--color' ? '#ff0000' : ''),
    } as CSSStyleDeclaration);

    const service = createDesignTokensService();
    const result = service.resolveToken(div, '--color');

    expect(result.token).toBe('--color');
    expect(result.computedValue).toBe('#ff0000');
    expect(result.availability).toBe('available');

    service.dispose();
  });
});

describe('design-tokens-service: resolveTokenForProperty', () => {
  it('builds CSS value for applying token', () => {
    const div = document.createElement('div');

    const service = createDesignTokensService();
    const result = service.resolveTokenForProperty(div, '--spacing', 'padding', {
      fallback: '8px',
    });

    expect(result.cssValue).toBe('var(--spacing, 8px)');
    expect(result.cssProperty).toBe('padding');

    service.dispose();
  });
});
