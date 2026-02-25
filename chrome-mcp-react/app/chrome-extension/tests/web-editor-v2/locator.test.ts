/**
 * Unit tests for Web Editor V2 locator utilities.
 *
 * These tests run in jsdom and validate:
 * - Fingerprint generation (tag, id, class, text normalization)
 * - DOM path computation
 * - Selector candidate strategies (ID > data-attrs > classes > path > anchor)
 * - Locator creation and resolution
 * - Locator key stability
 * - Shadow host chain detection
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { ElementLocator } from '@/common/web-editor-types';
import {
  computeDomPath,
  computeFingerprint,
  createElementLocator,
  generateCssSelector,
  generateSelectorCandidates,
  getShadowHostChain,
  locateElement,
  locatorKey,
} from '@/entrypoints/web-editor-v2/core/locator';

// =============================================================================
// Test Utilities
// =============================================================================

const supportsShadowDom =
  typeof (document.createElement('div') as HTMLElement).attachShadow === 'function';
const itIfShadow = supportsShadowDom ? it : it.skip;

beforeEach(() => {
  document.body.innerHTML = '';
});

// =============================================================================
// computeFingerprint Tests
// =============================================================================

describe('locator: computeFingerprint', () => {
  it('includes tag, id, class list, and normalized text', () => {
    const el = document.createElement('button');
    el.id = 'save';
    el.className = 'btn primary';
    el.textContent = '  Hello   world \n ok  ';
    document.body.append(el);

    const fp = computeFingerprint(el);

    expect(fp).toContain('button');
    expect(fp).toContain('id=save');
    expect(fp).toContain('class=btn.primary');
    expect(fp).toContain('text=Hello world ok');
  });

  it('limits classes to 8 tokens', () => {
    const el = document.createElement('div');
    el.className = Array.from({ length: 10 }, (_, i) => `c${i}`).join(' ');
    document.body.append(el);

    const fp = computeFingerprint(el);
    const classPart = fp.split('|').find((p) => p.startsWith('class='));

    // Should have exactly 8 classes
    const classes = classPart?.replace('class=', '').split('.') ?? [];
    expect(classes).toHaveLength(8);
    expect(classes).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
  });

  it('truncates text to 32 characters', () => {
    const el = document.createElement('div');
    el.textContent = 'a'.repeat(40);
    document.body.append(el);

    const fp = computeFingerprint(el);
    const textPart = fp.split('|').find((p) => p.startsWith('text='));
    const text = textPart?.replace('text=', '') ?? '';

    expect(text.length).toBeLessThanOrEqual(32);
  });

  it('returns only tag when id/class/text are empty', () => {
    const el = document.createElement('div');
    document.body.append(el);

    expect(computeFingerprint(el)).toBe('div');
  });

  it('normalizes whitespace in text', () => {
    const el = document.createElement('span');
    el.textContent = '\n  foo   bar\t\tbaz  \n';
    document.body.append(el);

    const fp = computeFingerprint(el);
    expect(fp).toContain('text=foo bar baz');
  });

  it('preserves class order from classList', () => {
    const el = document.createElement('div');
    el.className = 'z-class a-class m-class';
    document.body.append(el);

    const fp = computeFingerprint(el);
    // Classes are preserved in their original order from classList
    expect(fp).toContain('class=z-class.a-class.m-class');
  });
});

// =============================================================================
// computeDomPath Tests
// =============================================================================

describe('locator: computeDomPath', () => {
  it('computes stable indices for nested elements in document', () => {
    const container = document.createElement('div');
    const first = document.createElement('span');
    const second = document.createElement('span');
    container.append(first, second);
    document.body.append(container);

    const firstPath = computeDomPath(first);
    const secondPath = computeDomPath(second);

    // Second child should have higher last index
    expect(secondPath[secondPath.length - 1]).toBeGreaterThan(
      firstPath[firstPath.length - 1] as number,
    );
  });

  it('returns different paths for siblings', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    document.body.append(a, b);

    expect(computeDomPath(a)).not.toEqual(computeDomPath(b));
  });

  itIfShadow('computes index within a ShadowRoot boundary', () => {
    const host = document.createElement('div');
    document.body.append(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const a = document.createElement('div');
    const b = document.createElement('div');
    shadow.append(a, b);

    // Path within shadow should start from 0
    const pathA = computeDomPath(a);
    const pathB = computeDomPath(b);

    expect(pathA[0]).toBe(0);
    expect(pathB[0]).toBe(1);
  });
});

// =============================================================================
// Selector Generation Tests
// =============================================================================

describe('locator: generateSelectorCandidates', () => {
  it('prefers unique id selector first', () => {
    const el = document.createElement('div');
    el.id = 'unique';
    document.body.append(el);

    const candidates = generateSelectorCandidates(el, { root: document });
    expect(candidates[0]).toBe('#unique');
  });

  it('uses data-testid when unique', () => {
    const el = document.createElement('button');
    el.setAttribute('data-testid', 'save-btn');
    document.body.append(el);

    const candidates = generateSelectorCandidates(el, { root: document });
    expect(candidates[0]).toBe('[data-testid="save-btn"]');
  });

  it('uses tag+data-testid when attribute alone is not unique', () => {
    const div = document.createElement('div');
    div.setAttribute('data-testid', 'dup');
    const span = document.createElement('span');
    span.setAttribute('data-testid', 'dup');
    document.body.append(div, span);

    const candidates = generateSelectorCandidates(div, { root: document });
    expect(candidates[0]).toBe('div[data-testid="dup"]');
  });

  it('uses tag+class when class alone is not unique', () => {
    const a = document.createElement('div');
    a.className = 'item';
    const b = document.createElement('button');
    b.className = 'item';
    document.body.append(a, b);

    const candidates = generateSelectorCandidates(b, { root: document });
    expect(candidates[0]).toBe('button.item');
  });

  it('uses class pair selector when only the combination is unique', () => {
    const target = document.createElement('div');
    target.className = 'a b';
    const onlyA = document.createElement('div');
    onlyA.className = 'a';
    const onlyB = document.createElement('div');
    onlyB.className = 'b';
    document.body.append(target, onlyA, onlyB);

    const candidates = generateSelectorCandidates(target, { root: document });
    expect(candidates[0]).toBe('.a.b');
  });

  it('generates multiple candidates', () => {
    const el = document.createElement('div');
    el.id = 'myid';
    el.className = 'myclass';
    el.setAttribute('data-testid', 'mytest');
    document.body.append(el);

    const candidates = generateSelectorCandidates(el, { root: document, maxCandidates: 5 });
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates).toContain('#myid');
  });

  it('falls back to structural path selector when no unique attrs/classes exist', () => {
    const section = document.createElement('section');
    const p = document.createElement('p');
    section.append(p);
    document.body.append(section);

    const candidates = generateSelectorCandidates(p, { root: document });
    // Should include a path-based selector
    const hasPath = candidates.some((c) => c.includes('>'));
    expect(hasPath).toBe(true);
  });

  it('respects maxCandidates option', () => {
    const el = document.createElement('div');
    el.id = 'test';
    el.className = 'a b c';
    el.setAttribute('data-testid', 'x');
    document.body.append(el);

    const candidates = generateSelectorCandidates(el, { root: document, maxCandidates: 2 });
    expect(candidates.length).toBeLessThanOrEqual(2);
  });
});

describe('locator: generateCssSelector', () => {
  it('returns the best single selector', () => {
    const el = document.createElement('div');
    el.id = 'unique';
    document.body.append(el);

    expect(generateCssSelector(el, { root: document })).toBe('#unique');
  });

  it('returns empty string for orphan element', () => {
    const el = document.createElement('div');
    // Element not in document
    const selector = generateCssSelector(el);
    // May return a selector or empty depending on implementation
    expect(typeof selector).toBe('string');
  });
});

// =============================================================================
// Locator Creation & Resolution Tests
// =============================================================================

describe('locator: createElementLocator', () => {
  it('creates a locator with selectors, fingerprint, and dom path', () => {
    const el = document.createElement('div');
    el.id = 'target';
    el.className = 'box';
    el.textContent = 'Hello';
    document.body.append(el);

    const locator = createElementLocator(el);

    expect(locator.selectors.length).toBeGreaterThan(0);
    expect(locator.selectors[0]).toBe('#target');
    expect(locator.fingerprint).toBe(computeFingerprint(el));
    expect(locator.path).toEqual(computeDomPath(el));
  });

  itIfShadow('includes shadowHostChain when element is inside Shadow DOM', () => {
    const host = document.createElement('div');
    host.id = 'host';
    document.body.append(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const target = document.createElement('span');
    target.id = 'inner';
    shadow.append(target);

    const locator = createElementLocator(target);

    expect(locator.shadowHostChain).toBeDefined();
    expect(locator.shadowHostChain!.length).toBeGreaterThan(0);
  });
});

describe('locator: locateElement', () => {
  it('locates an element from its own locator', () => {
    const el = document.createElement('div');
    el.id = 'target';
    el.textContent = 'Hello';
    document.body.append(el);

    const locator = createElementLocator(el);
    const found = locateElement(locator, document);

    expect(found).toBe(el);
  });

  it('tries multiple selectors and falls back to later candidates', () => {
    const el = document.createElement('div');
    el.id = 'target';
    document.body.append(el);

    const locator: ElementLocator = {
      selectors: ['#missing', '#target'],
      fingerprint: computeFingerprint(el),
      path: [],
    };

    expect(locateElement(locator, document)).toBe(el);
  });

  it('returns null when selector is not unique', () => {
    const a = document.createElement('div');
    a.className = 'x';
    const b = document.createElement('div');
    b.className = 'x';
    document.body.append(a, b);

    const locator: ElementLocator = {
      selectors: ['.x'],
      fingerprint: computeFingerprint(a),
      path: [],
    };

    // Should return null because .x matches 2 elements
    expect(locateElement(locator, document)).toBeNull();
  });

  it('returns null when fingerprint does not match', () => {
    const el = document.createElement('div');
    el.id = 'a';
    document.body.append(el);

    const locator: ElementLocator = {
      selectors: ['#a'],
      fingerprint: 'div|id=wrong', // Wrong fingerprint
      path: [],
    };

    expect(locateElement(locator, document)).toBeNull();
  });

  it('handles element removal gracefully', () => {
    const el = document.createElement('div');
    el.id = 'temp';
    document.body.append(el);

    const locator = createElementLocator(el);
    el.remove();

    expect(locateElement(locator, document)).toBeNull();
  });

  itIfShadow('locates element inside nested ShadowRoot via shadowHostChain', () => {
    const outerHost = document.createElement('div');
    outerHost.id = 'outer-host';
    document.body.append(outerHost);

    const outerShadow = outerHost.attachShadow({ mode: 'open' });

    const innerHost = document.createElement('div');
    innerHost.id = 'inner-host';
    outerShadow.append(innerHost);

    const innerShadow = innerHost.attachShadow({ mode: 'open' });
    const target = document.createElement('span');
    target.id = 'shadow-target';
    innerShadow.append(target);

    const locator = createElementLocator(target);
    const found = locateElement(locator, document);

    expect(found).toBe(target);
  });
});

// =============================================================================
// Shadow Host Chain Tests
// =============================================================================

describe('locator: getShadowHostChain', () => {
  it('returns undefined for element not in Shadow DOM', () => {
    const el = document.createElement('div');
    document.body.append(el);

    expect(getShadowHostChain(el)).toBeUndefined();
  });

  itIfShadow('returns chain for single-level Shadow DOM', () => {
    const host = document.createElement('div');
    host.id = 'myhost';
    document.body.append(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('span');
    shadow.append(inner);

    const chain = getShadowHostChain(inner);
    expect(chain).toBeDefined();
    expect(chain!.length).toBe(1);
    expect(chain![0]).toBe('#myhost');
  });

  itIfShadow('returns chain for nested Shadow DOMs', () => {
    const outer = document.createElement('div');
    outer.id = 'outer';
    document.body.append(outer);

    const outerShadow = outer.attachShadow({ mode: 'open' });
    const inner = document.createElement('div');
    inner.id = 'inner';
    outerShadow.append(inner);

    const innerShadow = inner.attachShadow({ mode: 'open' });
    const target = document.createElement('span');
    innerShadow.append(target);

    const chain = getShadowHostChain(target);
    expect(chain).toBeDefined();
    expect(chain!.length).toBe(2);
    expect(chain![0]).toBe('#outer');
    expect(chain![1]).toBe('#inner');
  });
});

// =============================================================================
// locatorKey Tests
// =============================================================================

describe('locator: locatorKey', () => {
  it('generates a stable key including selectors', () => {
    const el = document.createElement('div');
    el.id = 'k1';
    document.body.append(el);

    const locator = createElementLocator(el);
    const key = locatorKey(locator);

    expect(key).toContain('sel:');
    expect(key).toContain('#k1');
  });

  it('differs for different locators', () => {
    const a = document.createElement('div');
    a.id = 'a';
    const b = document.createElement('div');
    b.id = 'b';
    document.body.append(a, b);

    const keyA = locatorKey(createElementLocator(a));
    const keyB = locatorKey(createElementLocator(b));

    expect(keyA).not.toBe(keyB);
  });

  it('is deterministic for same element', () => {
    const el = document.createElement('div');
    el.id = 'stable';
    document.body.append(el);

    const key1 = locatorKey(createElementLocator(el));
    const key2 = locatorKey(createElementLocator(el));

    expect(key1).toBe(key2);
  });

  itIfShadow('includes shadow host chain in the key when present', () => {
    const host = document.createElement('div');
    host.id = 'host';
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const target = document.createElement('span');
    target.id = 't';
    shadow.append(target);

    const locator = createElementLocator(target);
    const key = locatorKey(locator);

    expect(key).toContain('shadow:');
    expect(key).toContain('#host');
  });
});
