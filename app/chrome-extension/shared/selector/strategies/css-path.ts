/**
 * CSS Path Strategy - DOM path-based selector strategy
 * Use nth-of-type to generate full CSS paths
 */

import type { SelectorCandidate, SelectorStrategy } from '../types';

export const cssPathStrategy: SelectorStrategy = {
  id: 'css-path',
  generate(ctx) {
    if (!ctx.options.includeCssPath) return [];

    const { element } = ctx;

    const segments: string[] = [];
    let current: Element | null = element;

    while (current) {
      const tag = current.tagName?.toLowerCase?.() ?? '';
      if (!tag) break;

      let segment = tag;
      const currentTagName = current.tagName;

      const parent: Element | null = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children) as Element[];
        const sameTagSiblings = siblings.filter((child: Element) => child.tagName === currentTagName);
        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(current) + 1;
          if (index > 0) segment += `:nth-of-type(${index})`;
        }
      }

      segments.unshift(segment);

      if (tag === 'body') break;
      current = parent;
    }

    const selector = segments.length ? segments.join(' > ') : 'body';

    const out: SelectorCandidate[] = [
      { type: 'css', value: selector, source: 'generated', strategy: 'css-path' },
    ];
    return out;
  },
};
