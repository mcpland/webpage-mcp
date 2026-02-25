/**
 * CSS Unique Strategy - 基于唯一 ID 或 class 组合的选择器策略
 */

import type { SelectorCandidate, SelectorStrategy } from '../types';

const MAX_CLASS_COUNT = 24;
const MAX_COMBO_CLASSES = 8;
const MAX_CANDIDATES = 6;

function isValidClassToken(token: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(token);
}

export const cssUniqueStrategy: SelectorStrategy = {
  id: 'css-unique',
  generate(ctx) {
    if (!ctx.options.includeCssUnique) return [];

    const { element, helpers } = ctx;
    const out: SelectorCandidate[] = [];

    const tag = element.tagName?.toLowerCase?.() ?? '';

    // 1) Unique ID selector
    const id = element.id?.trim();
    if (id) {
      const sel = `#${helpers.cssEscape(id)}`;
      if (helpers.isUnique(sel)) {
        out.push({ type: 'css', value: sel, source: 'generated', strategy: 'css-unique' });
      }
    }

    if (out.length >= MAX_CANDIDATES) return out;

    // 2) Unique class selectors
    const classList = Array.from(element.classList || [])
      .map((c) => String(c).trim())
      .filter((c) => c.length > 0 && isValidClassToken(c))
      .slice(0, MAX_CLASS_COUNT);

    for (const cls of classList) {
      if (out.length >= MAX_CANDIDATES) break;
      const sel = `.${helpers.cssEscape(cls)}`;
      if (helpers.isUnique(sel)) {
        out.push({ type: 'css', value: sel, source: 'generated', strategy: 'css-unique' });
      }
    }

    if (tag) {
      for (const cls of classList) {
        if (out.length >= MAX_CANDIDATES) break;
        const sel = `${tag}.${helpers.cssEscape(cls)}`;
        if (helpers.isUnique(sel)) {
          out.push({ type: 'css', value: sel, source: 'generated', strategy: 'css-unique' });
        }
      }
    }

    if (out.length >= MAX_CANDIDATES) return out;

    // 3) Class combinations (depth 2/3), limited to avoid heavy queries.
    const comboSource = classList.slice(0, MAX_COMBO_CLASSES).map((c) => helpers.cssEscape(c));

    const tryPush = (selector: string): void => {
      if (out.length >= MAX_CANDIDATES) return;
      if (!helpers.isUnique(selector)) return;
      out.push({ type: 'css', value: selector, source: 'generated', strategy: 'css-unique' });
    };

    const tryPushWithTag = (selector: string): void => {
      tryPush(selector);
      if (tag) tryPush(`${tag}${selector}`);
    };

    // Depth 2
    for (let i = 0; i < comboSource.length && out.length < MAX_CANDIDATES; i++) {
      for (let j = i + 1; j < comboSource.length && out.length < MAX_CANDIDATES; j++) {
        tryPushWithTag(`.${comboSource[i]}.${comboSource[j]}`);
      }
    }

    // Depth 3
    for (let i = 0; i < comboSource.length && out.length < MAX_CANDIDATES; i++) {
      for (let j = i + 1; j < comboSource.length && out.length < MAX_CANDIDATES; j++) {
        for (let k = j + 1; k < comboSource.length && out.length < MAX_CANDIDATES; k++) {
          tryPushWithTag(`.${comboSource[i]}.${comboSource[j]}.${comboSource[k]}`);
        }
      }
    }

    return out;
  },
};
