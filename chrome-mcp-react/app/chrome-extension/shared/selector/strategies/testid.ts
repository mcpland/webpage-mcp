/**
 * TestID Strategy - Attribute-based selector strategy
 *
 * Generates selectors based on stable attributes like data-testid, data-cy,
 * as well as semantic attributes like name, title, and alt.
 */

import type { SelectorCandidate, SelectorStrategy } from '../types';

// =============================================================================
// Constants
// =============================================================================

/** Tags that commonly use form-related attributes */
const FORM_ELEMENT_TAGS = new Set(['input', 'textarea', 'select', 'button']);

/** Tags that commonly use the 'alt' attribute */
const ALT_ATTRIBUTE_TAGS = new Set(['img', 'area']);

/** Tags that commonly use the 'title' attribute (most elements can have it) */
const TITLE_ATTRIBUTE_TAGS = new Set(['img', 'a', 'abbr', 'iframe', 'link']);

/**
 * Mapping of attributes to their preferred tag prefixes.
 * When an attribute-only selector is not unique, we try tag-prefixed form
 * only for elements where that attribute is semantically meaningful.
 */
const ATTR_TAG_PREFERENCES: Record<string, Set<string>> = {
  name: FORM_ELEMENT_TAGS,
  alt: ALT_ATTRIBUTE_TAGS,
  title: TITLE_ATTRIBUTE_TAGS,
};

// =============================================================================
// Helpers
// =============================================================================

function makeAttrSelector(attr: string, value: string, cssEscape: (v: string) => string): string {
  return `[${attr}="${cssEscape(value)}"]`;
}

/**
 * Determine if tag prefix should be tried for disambiguation.
 *
 * Rules:
 * - data-* attributes: try for form elements only
 * - name: try for form elements (input, textarea, select, button)
 * - alt: try for img, area, input[type=image]
 * - title: try for common elements that use title semantically
 * - Default: try for any tag
 */
function shouldTryTagPrefix(attr: string, tag: string, element: Element): boolean {
  if (!tag) return false;

  // For data-* test attributes, use form element heuristic
  if (attr.startsWith('data-')) {
    return FORM_ELEMENT_TAGS.has(tag);
  }

  // For semantic attributes, check the preference mapping
  const preferredTags = ATTR_TAG_PREFERENCES[attr];
  if (preferredTags) {
    if (preferredTags.has(tag)) return true;

    // Special case: input[type=image] also uses alt
    if (attr === 'alt' && tag === 'input') {
      const type = element.getAttribute('type');
      return type === 'image';
    }

    return false;
  }

  // Default: try tag prefix for any element
  return true;
}

// =============================================================================
// Strategy Export
// =============================================================================

export const testIdStrategy: SelectorStrategy = {
  id: 'testid',

  generate(ctx) {
    const { element, options, helpers } = ctx;
    const out: SelectorCandidate[] = [];
    const tag = element.tagName?.toLowerCase?.() ?? '';

    for (const attr of options.testIdAttributes) {
      const raw = element.getAttribute(attr);
      const value = raw?.trim();
      if (!value) continue;

      const attrOnly = makeAttrSelector(attr, value, helpers.cssEscape);

      // Try attribute-only selector first
      if (helpers.isUnique(attrOnly)) {
        out.push({
          type: 'attr',
          value: attrOnly,
          source: 'generated',
          strategy: 'testid',
        });
        continue;
      }

      // Try tag-prefixed form if appropriate for this attribute/element combo
      if (shouldTryTagPrefix(attr, tag, element)) {
        const withTag = `${tag}${attrOnly}`;
        if (helpers.isUnique(withTag)) {
          out.push({
            type: 'attr',
            value: withTag,
            source: 'generated',
            strategy: 'testid',
          });
        }
      }
    }

    return out;
  },
};
