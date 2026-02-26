/**
 * ARIA Strategy - Selector strategy based on accessibility attributes
 * Generate selectors using aria-label, role and other attributes
 */

import type { SelectorCandidate, SelectorStrategy } from '../types';

function guessRoleByTag(tag: string): string | undefined {
  if (tag === 'input' || tag === 'textarea') return 'textbox';
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  return undefined;
}

function uniqStrings(items: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of items) {
    const v = s.trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export const ariaStrategy: SelectorStrategy = {
  id: 'aria',
  generate(ctx) {
    if (!ctx.options.includeAria) return [];

    const { element, helpers } = ctx;
    const out: SelectorCandidate[] = [];

    const name = element.getAttribute('aria-label')?.trim();
    if (!name) return out;

    const tag = element.tagName?.toLowerCase?.() ?? '';
    const role = element.getAttribute('role')?.trim() || guessRoleByTag(tag);

    const qName = JSON.stringify(name);
    const selectors: string[] = [];

    if (role) selectors.push(`[role=${JSON.stringify(role)}][aria-label=${qName}]`);
    selectors.push(`[aria-label=${qName}]`);

    if (role === 'textbox') {
      selectors.unshift(
        `input[aria-label=${qName}]`,
        `textarea[aria-label=${qName}]`,
        `[role="textbox"][aria-label=${qName}]`,
      );
    } else if (role === 'button') {
      selectors.unshift(`button[aria-label=${qName}]`, `[role="button"][aria-label=${qName}]`);
    } else if (role === 'link') {
      selectors.unshift(`a[aria-label=${qName}]`, `[role="link"][aria-label=${qName}]`);
    }

    for (const sel of uniqStrings(selectors)) {
      if (helpers.isUnique(sel)) {
        out.push({ type: 'attr', value: sel, source: 'generated', strategy: 'aria' });
      }
    }

    // Structured aria candidate for UI/debugging (locator can translate it too).
    out.push({
      type: 'aria',
      value: `${role ?? 'element'}[name=${JSON.stringify(name)}]`,
      role,
      name,
      source: 'generated',
      strategy: 'aria',
    });

    return out;
  },
};
