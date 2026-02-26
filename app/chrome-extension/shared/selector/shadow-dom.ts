/**
 * Shadow DOM Utilities - Chain traversal and scoped querying.
 *
 * This module provides utilities for traversing Shadow DOM boundaries
 * and querying elements within shadow roots.
 *
 * Design principles:
 * - This module only handles traversal and querying, NOT selector generation
 * - Selector generation for shadow hosts belongs in generator.ts to avoid circular deps
 * - All operations require unique selector matches for safety
 */

// =============================================================================
// Types
// =============================================================================

/** Possible failure reasons during shadow DOM traversal */
export type ShadowTraversalFailureReason =
  | 'empty_chain'
  | 'no_root'
  | 'invalid_selector'
  | 'no_match'
  | 'multiple_matches'
  | 'no_shadow_root';

/**
 * Result of shadow DOM traversal with detailed error information
 */
export interface ShadowTraversalResult {
  success: boolean;
  shadowRoot: ShadowRoot | null;
  /** Index of the first failing selector in the chain (-1 if no chain processing occurred) */
  failedAt: number;
  /** Reason for failure if not successful */
  reason?: ShadowTraversalFailureReason;
}

// =============================================================================
// Internal Helpers
// =============================================================================

function getDefaultRoot(): Document | null {
  if (typeof document !== 'undefined') {
    return document;
  }
  return null;
}

function safeQuerySelector(root: Document | ShadowRoot, selector: string): Element | null {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

function safeQuerySelectorAll(
  root: Document | ShadowRoot,
  selector: string,
): NodeListOf<Element> | null {
  try {
    return root.querySelectorAll(selector);
  } catch {
    return null;
  }
}

/**
 * Query result with match count for detailed error reporting
 */
interface QueryResult {
  element: Element | null;
  matchCount: number;
  isValid: boolean;
}

function queryWithDetails(root: Document | ShadowRoot, selector: string): QueryResult {
  const elements = safeQuerySelectorAll(root, selector);
  if (elements === null) {
    return { element: null, matchCount: 0, isValid: false };
  }
  return {
    element: elements.length > 0 ? elements[0] : null,
    matchCount: elements.length,
    isValid: true,
  };
}

function isUnique(root: Document | ShadowRoot, selector: string): boolean {
  const result = queryWithDetails(root, selector);
  return result.isValid && result.matchCount === 1;
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Traverse a Shadow DOM host selector chain and return detailed result.
 *
 * @param hostChain - Shadow host selectors ordered from outermost to innermost
 * @param root - Starting query root (defaults to document)
 * @returns Detailed traversal result with success status and error info
 *
 * @example
 * ```ts
 * const result = traverseShadowDomWithDetails(
 *   ['my-component', 'inner-component'],
 *   document
 * );
 * if (result.success) {
 *   // query within result.shadowRoot
 * }
 * ```
 */
export function traverseShadowDomWithDetails(
  hostChain: ReadonlyArray<string>,
  root?: Document | ShadowRoot,
): ShadowTraversalResult {
  // Empty chain means no shadow boundary
  if (!Array.isArray(hostChain) || hostChain.length === 0) {
    return { success: false, shadowRoot: null, failedAt: -1, reason: 'empty_chain' };
  }

  const initialRoot = root ?? getDefaultRoot();
  if (!initialRoot) {
    return { success: false, shadowRoot: null, failedAt: -1, reason: 'no_root' };
  }

  let queryRoot: Document | ShadowRoot = initialRoot;

  for (let i = 0; i < hostChain.length; i++) {
    const rawSelector = hostChain[i];
    const hostSelector = typeof rawSelector === 'string' ? rawSelector.trim() : '';

    if (!hostSelector) {
      return { success: false, shadowRoot: null, failedAt: i, reason: 'invalid_selector' };
    }

    // Use queryWithDetails for precise error reporting
    const queryResult = queryWithDetails(queryRoot, hostSelector);

    if (!queryResult.isValid) {
      return { success: false, shadowRoot: null, failedAt: i, reason: 'invalid_selector' };
    }

    if (queryResult.matchCount === 0) {
      return { success: false, shadowRoot: null, failedAt: i, reason: 'no_match' };
    }

    if (queryResult.matchCount > 1) {
      return { success: false, shadowRoot: null, failedAt: i, reason: 'multiple_matches' };
    }

    const host = queryResult.element;
    if (!host) {
      return { success: false, shadowRoot: null, failedAt: i, reason: 'no_match' };
    }

    // Only open shadow roots are accessible via .shadowRoot
    const shadowRoot = host.shadowRoot;
    if (!shadowRoot) {
      return { success: false, shadowRoot: null, failedAt: i, reason: 'no_shadow_root' };
    }

    queryRoot = shadowRoot;
  }

  if (queryRoot instanceof ShadowRoot) {
    return { success: true, shadowRoot: queryRoot, failedAt: -1 };
  }

  return {
    success: false,
    shadowRoot: null,
    failedAt: hostChain.length - 1,
    reason: 'no_shadow_root',
  };
}

/**
 * Traverse a Shadow DOM host selector chain and return the innermost ShadowRoot.
 *
 * This is the simplified version of traverseShadowDomWithDetails.
 *
 * @param hostChain - Shadow host selectors ordered from outermost to innermost
 * @param root - Starting query root (defaults to document)
 * @returns The innermost ShadowRoot, or null if traversal fails or chain is empty
 *
 * @example
 * ```ts
 * const shadowRoot = traverseShadowDom(['my-component', 'inner-component']);
 * if (shadowRoot) {
 *   const button = shadowRoot.querySelector('button');
 * }
 * ```
 */
export function traverseShadowDom(
  hostChain: ReadonlyArray<string>,
  root?: Document | ShadowRoot,
): ShadowRoot | null {
  const result = traverseShadowDomWithDetails(hostChain, root);
  return result.shadowRoot;
}

/**
 * Query an element within the innermost ShadowRoot resolved by a host chain.
 *
 * @param selector - CSS selector to query within the resolved ShadowRoot
 * @param hostChain - Shadow host selectors ordered from outermost to innermost
 * @param root - Starting query root (defaults to document)
 * @returns The first matched element, or null if traversal fails or no match
 *
 * @example
 * ```ts
 * const button = queryInShadowDom(
 *   'button.submit',
 *   ['my-component', 'form-wrapper']
 * );
 * ```
 */
export function queryInShadowDom(
  selector: string,
  hostChain: ReadonlyArray<string>,
  root?: Document | ShadowRoot,
): Element | null {
  const sel = typeof selector === 'string' ? selector.trim() : '';
  if (!sel) {
    return null;
  }

  const shadowRoot = traverseShadowDom(hostChain, root);
  if (!shadowRoot) {
    return null;
  }

  return safeQuerySelector(shadowRoot, sel);
}

/**
 * Query all matching elements within the innermost ShadowRoot resolved by a host chain.
 *
 * @param selector - CSS selector to query within the resolved ShadowRoot
 * @param hostChain - Shadow host selectors ordered from outermost to innermost
 * @param root - Starting query root (defaults to document)
 * @returns Array of matched elements, or empty array if traversal fails
 */
export function queryAllInShadowDom(
  selector: string,
  hostChain: ReadonlyArray<string>,
  root?: Document | ShadowRoot,
): Element[] {
  const sel = typeof selector === 'string' ? selector.trim() : '';
  if (!sel) {
    return [];
  }

  const shadowRoot = traverseShadowDom(hostChain, root);
  if (!shadowRoot) {
    return [];
  }

  const elements = safeQuerySelectorAll(shadowRoot, sel);
  return elements ? Array.from(elements) : [];
}

/**
 * Check if a selector uniquely matches an element within the shadow chain.
 *
 * @param selector - CSS selector to check
 * @param hostChain - Shadow host selectors ordered from outermost to innermost
 * @param root - Starting query root (defaults to document)
 * @returns true if selector matches exactly one element
 */
export function isUniqueInShadowDom(
  selector: string,
  hostChain: ReadonlyArray<string>,
  root?: Document | ShadowRoot,
): boolean {
  const sel = typeof selector === 'string' ? selector.trim() : '';
  if (!sel) {
    return false;
  }

  const shadowRoot = traverseShadowDom(hostChain, root);
  if (!shadowRoot) {
    return false;
  }

  return isUnique(shadowRoot, sel);
}
