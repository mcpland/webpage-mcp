/**
 * Design Tokens Types (Phase 5.4)
 *
 * Type definitions for runtime CSS custom properties (design tokens).
 *
 * Scope:
 * - Phase 5.4: Runtime CSS variables only (no server-side token scanning)
 * - Future phases may extend to support project-level tokens from config files
 */

// =============================================================================
// Core Identifiers
// =============================================================================

/**
 * CSS custom property name (must start with `--`).
 * Example: '--color-primary', '--spacing-md'
 */
export type CssVarName = `--${string}`;

/**
 * Root key for caching token indices.
 * Uses Document or ShadowRoot as WeakMap keys.
 */
export type RootCacheKey = Document | ShadowRoot;

/** Type of root context */
export type RootType = 'document' | 'shadow';

// =============================================================================
// Token Classification
// =============================================================================

/**
 * Token value type classification.
 * Used for filtering and UI grouping.
 */
export type TokenKind =
  | 'color' // Color values (hex, rgb, hsl, etc.)
  | 'length' // Length values (px, rem, em, %, etc.)
  | 'number' // Unitless numbers
  | 'shadow' // Box/text shadow values
  | 'font' // Font family or font-related values
  | 'unknown'; // Unable to classify

// =============================================================================
// Declaration Source
// =============================================================================

/** Reference to a stylesheet */
export interface StyleSheetRef {
  /** Full URL if available */
  url?: string;
  /** Human-readable label (filename or element description) */
  label: string;
}

/** Where the token declaration originated */
export type TokenDeclarationOrigin = 'rule' | 'inline';

/**
 * A single declaration site for a token.
 * One token name can have multiple declarations across stylesheets/rules.
 */
export interface TokenDeclaration {
  /** Token name (e.g., '--color-primary') */
  name: CssVarName;
  /** Raw declared value */
  value: string;
  /** Whether declared with !important */
  important: boolean;
  /** Origin type */
  origin: TokenDeclarationOrigin;
  /** Root type where declared */
  rootType: RootType;
  /** Source stylesheet reference */
  styleSheet?: StyleSheetRef;
  /** CSS selector for rule-based declarations */
  selectorText?: string;
  /** Source order within collection pass (ascending) */
  order: number;
}

// =============================================================================
// Token Model
// =============================================================================

/**
 * Design token with all known declarations.
 * Aggregates declaration sites for a single token name.
 */
export interface DesignToken {
  /** Token name */
  name: CssVarName;
  /** Best-effort value type classification */
  kind: TokenKind;
  /** All declaration sites in source order */
  declarations: readonly TokenDeclaration[];
}

// =============================================================================
// Index and Query Results
// =============================================================================

/** Statistics from a token collection pass */
export interface TokenIndexStats {
  /** Number of stylesheets scanned */
  styleSheets: number;
  /** Number of CSS rules processed */
  rulesScanned: number;
  /** Number of unique token names found */
  tokens: number;
  /** Total number of declaration sites */
  declarations: number;
}

/**
 * Root-level token index.
 * Contains all token declarations found in a root's stylesheets.
 */
export interface TokenIndex {
  /** Root type */
  rootType: RootType;
  /** Map of token name to declaration sites */
  tokens: Map<CssVarName, TokenDeclaration[]>;
  /** Warnings encountered during scanning */
  warnings: string[];
  /** Collection statistics */
  stats: TokenIndexStats;
}

/**
 * Token with its computed value in a specific element context.
 * Used for showing available tokens when editing an element.
 */
export interface ContextToken {
  /** Token definition */
  token: DesignToken;
  /** Computed value via getComputedStyle(element).getPropertyValue(name) */
  computedValue: string;
}

/** Generic query result wrapper */
export interface TokenQueryResult<T> {
  /** Result items */
  tokens: readonly T[];
  /** Warnings from the operation */
  warnings: readonly string[];
  /** Statistics */
  stats: TokenIndexStats;
}

// =============================================================================
// Resolution Types
// =============================================================================

/** Parsed var() reference */
export interface CssVarReference {
  /** Token name */
  name: CssVarName;
  /** Optional fallback value */
  fallback?: string;
}

/** Token availability status */
export type TokenAvailability = 'available' | 'unset';

/** Method used to resolve token value */
export type TokenResolutionMethod =
  | 'computed' // getComputedStyle().getPropertyValue()
  | 'probe' // DOM probe element
  | 'none'; // Not resolved

/** Token resolution result */
export interface TokenResolution {
  /** Token name */
  token: CssVarName;
  /** Computed custom property value (may be empty if unset) */
  computedValue: string;
  /** Availability status */
  availability: TokenAvailability;
}

/** Resolved token ready to apply to a CSS property */
export interface TokenResolvedForProperty {
  /** Token name */
  token: CssVarName;
  /** Target CSS property */
  cssProperty: string;
  /** CSS value to apply (e.g., 'var(--token)' or 'var(--token, fallback)') */
  cssValue: string;
  /** Best-effort resolved preview value */
  resolvedValue?: string;
  /** Resolution method used */
  method: TokenResolutionMethod;
}

// =============================================================================
// Cache Invalidation
// =============================================================================

/** Reason for cache invalidation */
export type TokenInvalidationReason =
  | 'manual' // Explicitly invalidated via API
  | 'head_mutation' // Document head changed (style/link added/removed)
  | 'shadow_mutation' // ShadowRoot content changed
  | 'ttl' // Time-to-live expired
  | 'unknown';

/** Event emitted when token cache is invalidated */
export interface TokenInvalidationEvent {
  /** Affected root */
  root: RootCacheKey;
  /** Root type */
  rootType: RootType;
  /** Invalidation reason */
  reason: TokenInvalidationReason;
  /** Timestamp */
  timestamp: number;
}

/** Unsubscribe function for event listeners */
export type Unsubscribe = () => void;
