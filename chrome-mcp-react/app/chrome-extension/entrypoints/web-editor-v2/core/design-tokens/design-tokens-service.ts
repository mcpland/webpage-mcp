/**
 * Design Tokens Service (Phase 5.4)
 *
 * Central orchestrator for design token functionality.
 *
 * Responsibilities:
 * - Token index caching per root (Document/ShadowRoot)
 * - Cache invalidation on stylesheet changes
 * - Unified query interface for UI components
 * - Integration with TransactionManager for applying tokens
 *
 * Cache strategy:
 * - Root-level WeakMap cache (auto-GC when roots are removed)
 * - Optional TTL for handling adoptedStyleSheets changes (no native events)
 * - MutationObserver on document.head for stylesheet injection detection
 */

import { Disposer } from '../../utils/disposables';
import {
  createTokenDetector,
  type TokenDetector,
  type TokenDetectorOptions,
} from './token-detector';
import {
  createTokenResolver,
  type TokenResolver,
  type TokenResolverOptions,
} from './token-resolver';
import type {
  ContextToken,
  CssVarName,
  CssVarReference,
  DesignToken,
  RootCacheKey,
  RootType,
  TokenDeclaration,
  TokenInvalidationEvent,
  TokenInvalidationReason,
  TokenIndex,
  TokenQueryResult,
  TokenResolution,
  TokenResolvedForProperty,
  Unsubscribe,
} from './types';
import type { TransactionManager } from '../transaction-manager';

// =============================================================================
// Types
// =============================================================================

/** Options for getRootTokens query */
export interface GetRootTokensOptions {
  /** Sort tokens alphabetically by name (default: true) */
  sortByName?: boolean;
}

/** Options for getContextTokens query */
export interface GetContextTokensOptions {
  /** Include tokens from inline styles on ancestors (default: true) */
  includeInlineAncestors?: boolean;
  /** Maximum ancestor depth for inline scanning */
  inlineMaxDepth?: number;
  /** Sort tokens alphabetically by name (default: true) */
  sortByName?: boolean;
}

/** Options for creating the design tokens service */
export interface DesignTokensServiceOptions {
  /**
   * Cache TTL in milliseconds. When expired, index is recomputed.
   * Set to 0 to disable TTL (default).
   * @default 0
   */
  cacheMaxAgeMs?: number;

  /**
   * Watch document.head for stylesheet changes.
   * @default true
   */
  observeHead?: boolean;

  /**
   * Watch ShadowRoot for changes.
   * @default false (performance consideration)
   */
  observeShadowRoots?: boolean;

  /**
   * Default max depth for inline ancestor scanning.
   * @default 8
   */
  maxInlineDepth?: number;

  /** Time source override (for testing) */
  now?: () => number;

  /** Injected detector (for testing) */
  detector?: TokenDetector;

  /** Injected resolver (for testing) */
  resolver?: TokenResolver;

  /** Options for default detector */
  detectorOptions?: TokenDetectorOptions;

  /** Options for default resolver */
  resolverOptions?: TokenResolverOptions;
}

/** Design tokens service public interface */
export interface DesignTokensService {
  // --- Query Methods ---

  /**
   * Get all tokens declared in a root's stylesheets.
   * Results are cached per root.
   */
  getRootTokens(root: RootCacheKey, options?: GetRootTokensOptions): TokenQueryResult<DesignToken>;

  /**
   * Get tokens available in an element's context.
   * Only includes tokens that resolve to a value.
   */
  getContextTokens(
    element: Element,
    options?: GetContextTokensOptions,
  ): TokenQueryResult<ContextToken>;

  // --- Resolution Methods ---

  /** Resolve a token's value in an element's context */
  resolveToken(element: Element, name: CssVarName): TokenResolution;

  /** Build CSS value for applying a token to a property */
  resolveTokenForProperty(
    element: Element,
    name: CssVarName,
    cssProperty: string,
    options?: { fallback?: string; preview?: boolean },
  ): TokenResolvedForProperty;

  // --- Utility Methods ---

  /** Format a CSS var() expression */
  formatCssVar(name: CssVarName, fallback?: string): string;

  /** Parse a var() expression */
  parseCssVar(value: string): CssVarReference | null;

  /** Extract var() references from a CSS value */
  extractCssVarNames(value: string): CssVarName[];

  // --- Cache Management ---

  /** Manually invalidate a root's cache */
  invalidateRoot(root: RootCacheKey, reason?: TokenInvalidationReason): void;

  /** Subscribe to cache invalidation events */
  onInvalidation(handler: (event: TokenInvalidationEvent) => void): Unsubscribe;

  // --- TransactionManager Integration ---

  /**
   * Apply a token to an element's style via TransactionManager.
   * Convenience method that formats var() and calls applyStyle.
   */
  applyTokenToStyle(
    transactionManager: TransactionManager,
    target: Element,
    cssProperty: string,
    tokenName: CssVarName,
    options?: { fallback?: string; merge?: boolean },
  ): ReturnType<TransactionManager['applyStyle']>;

  /** Cleanup resources */
  dispose(): void;
}

// =============================================================================
// Implementation
// =============================================================================

/** Cache entry for a root's token index */
interface RootCacheEntry {
  index: TokenIndex;
  collectedAt: number;
}

/**
 * Create a design tokens service instance.
 */
export function createDesignTokensService(
  options: DesignTokensServiceOptions = {},
): DesignTokensService {
  const disposer = new Disposer();

  // Configuration
  const getNow = options.now ?? (() => performance.now());
  const cacheMaxAgeMs = Math.max(0, Math.floor(options.cacheMaxAgeMs ?? 0));
  const observeHead = options.observeHead !== false;
  const observeShadowRoots = Boolean(options.observeShadowRoots);
  const maxInlineDepth = Math.max(0, Math.floor(options.maxInlineDepth ?? 8));

  // Dependencies
  const detector = options.detector ?? createTokenDetector(options.detectorOptions);
  const resolver = options.resolver ?? createTokenResolver(options.resolverOptions);

  // State
  const rootCache = new WeakMap<RootCacheKey, RootCacheEntry>();
  const observedRoots = new WeakSet<RootCacheKey>();
  const invalidationListeners = new Set<(event: TokenInvalidationEvent) => void>();

  // ===========================================================================
  // Helpers
  // ===========================================================================

  function getRootType(root: RootCacheKey): RootType {
    return root instanceof ShadowRoot ? 'shadow' : 'document';
  }

  function emitInvalidation(root: RootCacheKey, reason: TokenInvalidationReason): void {
    const event: TokenInvalidationEvent = {
      root,
      rootType: getRootType(root),
      reason,
      timestamp: getNow(),
    };

    for (const handler of invalidationListeners) {
      try {
        handler(event);
      } catch {
        // Best-effort notification
      }
    }
  }

  function getElementRoot(element: Element): RootCacheKey {
    try {
      const root = element.getRootNode?.();
      if (root instanceof ShadowRoot) return root;
      return element.ownerDocument ?? document;
    } catch {
      return element.ownerDocument ?? document;
    }
  }

  // ===========================================================================
  // Cache Management
  // ===========================================================================

  function ensureObserved(root: RootCacheKey): void {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);

    if (root instanceof ShadowRoot) {
      if (!observeShadowRoots) return;

      disposer.observeMutation(root, () => invalidateRoot(root, 'shadow_mutation'), {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      return;
    }

    // Document root - observe head for stylesheet changes
    if (!observeHead) return;

    const head = root.head;
    if (!head) return;

    disposer.observeMutation(head, () => invalidateRoot(root, 'head_mutation'), {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
  }

  function getOrCollectIndex(root: RootCacheKey): TokenIndex {
    const cached = rootCache.get(root);

    if (cached) {
      // Check TTL
      if (cacheMaxAgeMs > 0) {
        const age = getNow() - cached.collectedAt;
        if (age >= cacheMaxAgeMs) {
          invalidateRoot(root, 'ttl');
        } else {
          return cached.index;
        }
      } else {
        return cached.index;
      }
    }

    // Collect fresh index
    const index = detector.collectRootIndex(root);
    rootCache.set(root, { index, collectedAt: getNow() });
    return index;
  }

  function invalidateRoot(root: RootCacheKey, reason: TokenInvalidationReason = 'manual'): void {
    rootCache.delete(root);
    emitInvalidation(root, reason);
  }

  // ===========================================================================
  // Token Model Conversion
  // ===========================================================================

  function toDesignToken(name: CssVarName, declarations: readonly TokenDeclaration[]): DesignToken {
    // Sort by source order
    const sorted = [...declarations].sort((a, b) => a.order - b.order);
    return { name, kind: 'unknown', declarations: sorted };
  }

  // ===========================================================================
  // Query Methods
  // ===========================================================================

  function getRootTokens(
    root: RootCacheKey,
    options: GetRootTokensOptions = {},
  ): TokenQueryResult<DesignToken> {
    ensureObserved(root);
    const index = getOrCollectIndex(root);

    const tokens: DesignToken[] = [];
    for (const [name, declarations] of index.tokens) {
      tokens.push(toDesignToken(name, declarations));
    }

    // Sort by name (default: true)
    if (options.sortByName !== false) {
      tokens.sort((a, b) => a.name.localeCompare(b.name));
    }

    return {
      tokens,
      warnings: index.warnings,
      stats: index.stats,
    };
  }

  function getContextTokens(
    element: Element,
    options: GetContextTokensOptions = {},
  ): TokenQueryResult<ContextToken> {
    const root = getElementRoot(element);
    ensureObserved(root);
    const index = getOrCollectIndex(root);

    // Collect candidate token names
    const candidateNames = new Set<CssVarName>();

    // Add all tokens from stylesheets
    for (const name of index.tokens.keys()) {
      candidateNames.add(name);
    }

    // Add inline tokens from ancestors
    const includeInline = options.includeInlineAncestors !== false;
    if (includeInline) {
      const inlineDepth = options.inlineMaxDepth ?? maxInlineDepth;
      const inlineNames = detector.collectInlineTokenNames(element, {
        maxDepth: inlineDepth,
      });
      for (const name of inlineNames) {
        candidateNames.add(name);
      }
    }

    // Filter to tokens that resolve in this context
    // PERF: Get computed style once, then read multiple properties
    const results: ContextToken[] = [];
    let computedStyle: CSSStyleDeclaration | null = null;

    try {
      computedStyle = window.getComputedStyle(element);
    } catch {
      // Element may be disconnected or invalid
    }

    if (computedStyle) {
      for (const name of candidateNames) {
        let computedValue = '';
        try {
          computedValue = computedStyle.getPropertyValue(name).trim();
        } catch {
          // Ignore property read errors
        }

        // Only include tokens that have a value in this context
        if (!computedValue) continue;

        const declarations = index.tokens.get(name) ?? [];
        results.push({
          token: toDesignToken(name, declarations),
          computedValue,
        });
      }
    }

    // Sort by name (default: true)
    if (options.sortByName !== false) {
      results.sort((a, b) => a.token.name.localeCompare(b.token.name));
    }

    return {
      tokens: results,
      warnings: index.warnings,
      stats: index.stats,
    };
  }

  // ===========================================================================
  // Resolution Methods
  // ===========================================================================

  function resolveToken(element: Element, name: CssVarName): TokenResolution {
    return resolver.resolveToken(element, name);
  }

  function resolveTokenForProperty(
    element: Element,
    name: CssVarName,
    cssProperty: string,
    options?: { fallback?: string; preview?: boolean },
  ): TokenResolvedForProperty {
    return resolver.resolveTokenForProperty(element, name, cssProperty, options);
  }

  // ===========================================================================
  // Utility Passthrough
  // ===========================================================================

  function formatCssVar(name: CssVarName, fallback?: string): string {
    return resolver.formatCssVar(name, fallback);
  }

  function parseCssVar(value: string): CssVarReference | null {
    return resolver.parseCssVar(value);
  }

  function extractCssVarNames(value: string): CssVarName[] {
    return resolver.extractCssVarNames(value);
  }

  // ===========================================================================
  // TransactionManager Integration
  // ===========================================================================

  function applyTokenToStyle(
    transactionManager: TransactionManager,
    target: Element,
    cssProperty: string,
    tokenName: CssVarName,
    options?: { fallback?: string; merge?: boolean },
  ): ReturnType<TransactionManager['applyStyle']> {
    const value = formatCssVar(tokenName, options?.fallback);
    return transactionManager.applyStyle(target, cssProperty, value, {
      merge: options?.merge,
    });
  }

  // ===========================================================================
  // Event Subscription
  // ===========================================================================

  function onInvalidation(handler: (event: TokenInvalidationEvent) => void): Unsubscribe {
    invalidationListeners.add(handler);
    return () => invalidationListeners.delete(handler);
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  function dispose(): void {
    invalidationListeners.clear();
    disposer.dispose();
  }

  return {
    getRootTokens,
    getContextTokens,
    resolveToken,
    resolveTokenForProperty,
    formatCssVar,
    parseCssVar,
    extractCssVarNames,
    invalidateRoot,
    onInvalidation,
    applyTokenToStyle,
    dispose,
  };
}
