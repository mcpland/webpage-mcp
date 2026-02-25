/**
 * Anchor + Relative Path Strategy
 *
 * This strategy generates selectors by finding a stable ancestor "anchor"
 * (element with unique id or data-testid/data-qa/etc.) and building a
 * relative path from that anchor to the target element.
 *
 * Use case: When the target element itself has no unique identifiers,
 * but a nearby ancestor does.
 *
 * Example output: '[data-testid="card"] div > span:nth-of-type(2) > button'
 * (anchor selector + descendant combinator + relative path with child combinators)
 */

import type { SelectorCandidate, SelectorStrategy, SelectorStrategyContext } from '../types';

// =============================================================================
// Constants
// =============================================================================

/** Maximum ancestor depth to search for an anchor */
const MAX_ANCHOR_DEPTH = 20;

/** Data attributes eligible for anchor selection (stable, test-friendly) */
const ANCHOR_DATA_ATTRS = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-qa',
  'data-cy',
] as const;

/**
 * Weight penalty for anchor-relpath candidates.
 * This ensures they rank lower than direct selectors (id, testid, class)
 * but higher than pure text selectors.
 */
const ANCHOR_RELPATH_WEIGHT = -10;

// =============================================================================
// Internal Helpers
// =============================================================================

function safeQuerySelector(root: ParentNode, selector: string): Element | null {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

/**
 * Get siblings from the appropriate parent context
 */
function getSiblings(element: Element): Element[] {
  const parent = element.parentElement;
  if (parent) {
    return Array.from(parent.children);
  }

  const parentNode = element.parentNode;
  if (parentNode instanceof ShadowRoot || parentNode instanceof Document) {
    return Array.from(parentNode.children);
  }

  return [];
}

/**
 * Try to build a unique anchor selector for an element.
 * Only uses stable identifiers: id or ANCHOR_DATA_ATTRS.
 */
function tryAnchorSelector(element: Element, ctx: SelectorStrategyContext): string | null {
  const { helpers } = ctx;
  const tag = element.tagName.toLowerCase();

  // Try ID first (highest priority)
  const id = element.id?.trim();
  if (id) {
    const idSelector = `#${helpers.cssEscape(id)}`;
    if (helpers.isUnique(idSelector)) {
      return idSelector;
    }
  }

  // Try stable data attributes
  for (const attr of ANCHOR_DATA_ATTRS) {
    const value = element.getAttribute(attr)?.trim();
    if (!value) continue;

    const escaped = helpers.cssEscape(value);

    // Try attribute-only selector
    const attrOnly = `[${attr}="${escaped}"]`;
    if (helpers.isUnique(attrOnly)) {
      return attrOnly;
    }

    // Try with tag prefix for disambiguation
    const withTag = `${tag}${attrOnly}`;
    if (helpers.isUnique(withTag)) {
      return withTag;
    }
  }

  return null;
}

/**
 * Build a relative path selector from an ancestor to a target element.
 * Uses tag names with :nth-of-type() for disambiguation.
 *
 * @returns Selector string like "div > span:nth-of-type(2) > button", or null if failed
 */
function buildRelativePathSelector(
  ancestor: Element,
  target: Element,
  root: Document | ShadowRoot,
): string | null {
  const segments: string[] = [];
  let current: Element | null = target;

  for (let depth = 0; current && current !== ancestor && depth < MAX_ANCHOR_DEPTH; depth++) {
    const tag = current.tagName.toLowerCase();
    let segment = tag;

    // Calculate nth-of-type index if there are siblings with same tag
    const siblings = getSiblings(current);
    const sameTagSiblings = siblings.filter((s) => s.tagName === current!.tagName);

    if (sameTagSiblings.length > 1) {
      const index = sameTagSiblings.indexOf(current) + 1;
      segment += `:nth-of-type(${index})`;
    }

    segments.unshift(segment);

    // Move to parent
    const parentEl: Element | null = current.parentElement;
    if (!parentEl) {
      // Check if we've reached the root boundary
      const parentNode = current.parentNode;
      if (parentNode === root) break;
      break;
    }

    current = parentEl;
  }

  // Verify we reached the ancestor
  if (current !== ancestor) {
    return null;
  }

  return segments.length > 0 ? segments.join(' > ') : null;
}

/**
 * Build an "anchor + relative path" selector for an element.
 *
 * Algorithm:
 * 1. Walk up from target's parent, looking for an anchor
 * 2. For each potential anchor, build the relative path
 * 3. Verify the composed selector uniquely matches the target
 */
function buildAnchorRelPathSelector(element: Element, ctx: SelectorStrategyContext): string | null {
  const { root } = ctx;

  // Ensure root is a valid query context
  if (!(root instanceof Document || root instanceof ShadowRoot)) {
    return null;
  }

  let current: Element | null = element.parentElement;

  for (let depth = 0; current && depth < MAX_ANCHOR_DEPTH; depth++) {
    // Skip document root elements
    const tagUpper = current.tagName.toUpperCase();
    if (tagUpper === 'HTML' || tagUpper === 'BODY') {
      break;
    }

    // Try to use this element as an anchor
    const anchor = tryAnchorSelector(current, ctx);
    if (!anchor) {
      current = current.parentElement;
      continue;
    }

    // Build relative path from anchor to target
    const relativePath = buildRelativePathSelector(current, element, root);
    if (!relativePath) {
      current = current.parentElement;
      continue;
    }

    // Compose the full selector
    const composed = `${anchor} ${relativePath}`;

    // Verify uniqueness
    if (!ctx.helpers.isUnique(composed)) {
      current = current.parentElement;
      continue;
    }

    // Final verification: ensure we match the exact element
    const found = safeQuerySelector(root, composed);
    if (found === element) {
      return composed;
    }

    current = current.parentElement;
  }

  return null;
}

// =============================================================================
// Strategy Export
// =============================================================================

export const anchorRelpathStrategy: SelectorStrategy = {
  id: 'anchor-relpath',

  generate(ctx: SelectorStrategyContext): ReadonlyArray<SelectorCandidate> {
    const selector = buildAnchorRelPathSelector(ctx.element, ctx);

    if (!selector) {
      return [];
    }

    return [
      {
        type: 'css',
        value: selector,
        weight: ANCHOR_RELPATH_WEIGHT,
        source: 'generated',
        strategy: 'anchor-relpath',
      },
    ];
  },
};
