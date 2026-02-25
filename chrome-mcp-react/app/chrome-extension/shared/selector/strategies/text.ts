/**
 * Text Strategy - Text content based selector strategy
 *
 * This is the lowest priority fallback strategy. Text selectors are less
 * stable than attribute-based or structural selectors because text content
 * is more likely to change (i18n, dynamic content, etc.).
 */

import type { SelectorCandidate, SelectorStrategy } from '../types';

/**
 * Weight penalty for text selectors.
 * This ensures text selectors rank after all other strategies including anchor-relpath.
 * anchor-relpath uses -10, so text uses -20 to rank lower.
 */
const TEXT_STRATEGY_WEIGHT = -20;

function normalizeText(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const textStrategy: SelectorStrategy = {
  id: 'text',

  generate(ctx) {
    if (!ctx.options.includeText) return [];

    const { element, options } = ctx;
    const tag = element.tagName?.toLowerCase?.() ?? '';
    if (!tag || !options.textTags.includes(tag)) return [];

    const raw = element.textContent || '';
    const text = normalizeText(raw).slice(0, options.textMaxLength);
    if (!text) return [];

    return [
      {
        type: 'text',
        value: text,
        match: 'contains',
        tagNameHint: tag,
        weight: TEXT_STRATEGY_WEIGHT,
        source: 'generated',
        strategy: 'text',
      },
    ];
  },
};
