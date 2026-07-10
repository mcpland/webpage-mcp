import { afterEach, describe, expect, it } from 'vitest';

import {
  CSSOM_RESOURCE_LIMITS,
  collectCssPanelSnapshot,
  collectMatchedRules,
} from '@/entrypoints/web-editor/core/cssom-styles-collector';

const originalStyleSheets = Object.getOwnPropertyDescriptor(Document.prototype, 'styleSheets');

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  Reflect.deleteProperty(document, 'styleSheets');
  if (originalStyleSheets) {
    Object.defineProperty(Document.prototype, 'styleSheets', originalStyleSheets);
  }
});

function createTargetAndSheet(css: string): { target: HTMLElement; sheet: CSSStyleSheet } {
  const target = document.createElement('div');
  target.id = 'target';
  document.body.append(target);
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const sheet = style.sheet;
  if (!(sheet instanceof CSSStyleSheet)) throw new Error('Expected a CSSStyleSheet');
  return { target, sheet };
}

describe('CSSOM resource boundaries', () => {
  it('uses indexed CSSOM traversal and stops enormous rule lists', () => {
    const { target, sheet } = createTargetAndSheet('#target { color: red; }');
    const rule =
      typeof sheet.cssRules.item === 'function' ? sheet.cssRules.item(0) : sheet.cssRules[0];
    if (!rule) throw new Error('Expected a CSS rule');

    const hugeRules = {
      length: CSSOM_RESOURCE_LIMITS.maxRulesScanned * 10,
      item: () => rule,
      [Symbol.iterator]: () => {
        throw new Error('CSSRuleList must not be materialized');
      },
    } as unknown as CSSRuleList;
    Object.defineProperty(sheet, 'cssRules', { configurable: true, value: hugeRules });

    const indexedSheets = {
      length: 1,
      item: () => sheet,
      0: sheet,
      [Symbol.iterator]: () => {
        throw new Error('StyleSheetList must not be materialized');
      },
    } as unknown as StyleSheetList;
    Object.defineProperty(document, 'styleSheets', {
      configurable: true,
      value: indexedSheets,
    });

    const result = collectMatchedRules(target);

    expect(result.stats.rulesScanned).toBeLessThanOrEqual(
      CSSOM_RESOURCE_LIMITS.maxRulesScanned,
    );
    expect(result.matchedRules.length).toBeLessThanOrEqual(
      CSSOM_RESOURCE_LIMITS.maxMatchedRulesPerElement,
    );
    expect(result.candidates.length).toBeLessThanOrEqual(
      CSSOM_RESOURCE_LIMITS.maxDeclarationsPerElement,
    );
    expect(result.warnings.join('\n')).toContain('truncated');
  });

  it('bounds declarations and retained CSS values per rule', () => {
    const declarations = Array.from(
      { length: CSSOM_RESOURCE_LIMITS.maxDeclarationsPerRule + 32 },
      (_, index) => `--property-${index}: ${index === 0 ? `"${'x'.repeat(20_000)}"` : index}`,
    ).join(';');
    const { target } = createTargetAndSheet(`#target { ${declarations}; }`);

    const result = collectMatchedRules(target);
    const rule = result.matchedRules[0];

    expect(rule?.decls.length).toBeLessThanOrEqual(
      CSSOM_RESOURCE_LIMITS.maxDeclarationsPerRule,
    );
    expect(Math.max(...(rule?.decls.map((decl) => decl.value.length) ?? [0]))).toBeLessThanOrEqual(
      CSSOM_RESOURCE_LIMITS.maxTextCodeUnits,
    );
    expect(result.warnings.join('\n')).toContain('declarations truncated');
  });

  it('clamps inherited element collection depth', () => {
    let parent: HTMLElement = document.body;
    for (let index = 0; index < CSSOM_RESOURCE_LIMITS.maxInheritanceDepth + 20; index += 1) {
      const child = document.createElement('div');
      child.style.color = `rgb(${index % 255}, 0, 0)`;
      parent.append(child);
      parent = child;
    }

    const snapshot = collectCssPanelSnapshot(parent, { maxInheritanceDepth: 10_000 });
    const inherited = snapshot.sections.filter((section) => section.kind === 'inherited');

    expect(inherited.length).toBeLessThanOrEqual(CSSOM_RESOURCE_LIMITS.maxInheritanceDepth);
  });
});
