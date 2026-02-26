/**
 * CSSOM Styles Collector (Phase 4.6)
 *
 * Provides CSS rule collection and cascade computation using CSSOM.
 * Used for the CSS panel's style source tracking feature.
 *
 * Design goals:
 * - Collect matched CSS rules for an element via CSSOM
 * - Compute cascade (specificity + source order + !important)
 * - Track inherited styles from ancestor elements
 * - Handle Shadow DOM stylesheets
 * - Produce UI-ready snapshot for rendering
 *
 * Limitations (CSSOM-only approach):
 * - No reliable file:line info (only href/label available)
 * - @container/@scope rules are not evaluated
 * - @layer ordering is approximated via source order
 */

// =============================================================================
// Public Types (UI-ready snapshot)
// =============================================================================

export type Specificity = readonly [inline: number, ids: number, classes: number, types: number];

export type DeclStatus = 'active' | 'overridden';

export interface CssRuleSource {
  url?: string;
  label: string;
}

export interface CssDeclView {
  id: string;
  name: string;
  value: string;
  important: boolean;
  affects: readonly string[];
  status: DeclStatus;
}

export interface CssRuleView {
  id: string;
  origin: 'inline' | 'rule';
  selector: string;
  matchedSelector?: string;
  specificity?: Specificity;
  source?: CssRuleSource;
  order: number;
  decls: CssDeclView[];
}

export interface CssSectionView {
  kind: 'inline' | 'matched' | 'inherited';
  title: string;
  inheritedFrom?: { label: string };
  rules: CssRuleView[];
}

export interface CssPanelSnapshot {
  target: {
    label: string;
    root: 'document' | 'shadow';
  };
  warnings: string[];
  stats: {
    roots: number;
    styleSheets: number;
    rulesScanned: number;
    matchedRules: number;
  };
  sections: CssSectionView[];
}

// =============================================================================
// Internal Types (cascade + collection)
// =============================================================================

interface DeclCandidate {
  id: string;
  important: boolean;
  specificity: Specificity;
  sourceOrder: readonly [sheetIndex: number, ruleOrder: number, declIndex: number];
  property: string;
  value: string;
  affects: readonly string[];
  ownerRuleId: string;
  ownerElementId: number;
}

interface FlatStyleRule {
  sheetIndex: number;
  order: number;
  selectorText: string;
  style: CSSStyleDeclaration;
  source: CssRuleSource;
}

interface RuleIndex {
  root: Document | ShadowRoot;
  rootId: number;
  flatRules: FlatStyleRule[];
  warnings: string[];
  stats: { styleSheets: number; rulesScanned: number };
}

interface CollectElementOptions {
  includeInline: boolean;
  declFilter: (decl: { property: string; affects: readonly string[] }) => boolean;
}

interface CollectedElementRules {
  element: Element;
  elementId: number;
  root: Document | ShadowRoot;
  rootType: 'document' | 'shadow';
  inlineRule: CssRuleView | null;
  matchedRules: CssRuleView[];
  candidates: DeclCandidate[];
  warnings: string[];
  stats: { matchedRules: number };
}

// =============================================================================
// Specificity (Selectors Level 4)
// =============================================================================

const ZERO_SPEC: Specificity = [0, 0, 0, 0] as const;

export function compareSpecificity(a: Specificity, b: Specificity): number {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function splitSelectorList(input: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depthParen = 0;
  let depthBrack = 0;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '\\') {
      i += 1;
      continue;
    }

    if (ch === '[') depthBrack += 1;
    else if (ch === ']' && depthBrack > 0) depthBrack -= 1;
    else if (ch === '(') depthParen += 1;
    else if (ch === ')' && depthParen > 0) depthParen -= 1;

    if (ch === ',' && depthParen === 0 && depthBrack === 0) {
      const part = input.slice(start, i).trim();
      if (part) out.push(part);
      start = i + 1;
    }
  }

  const tail = input.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function maxSpecificity(list: readonly Specificity[]): Specificity {
  let best: Specificity = ZERO_SPEC;
  for (const s of list) if (compareSpecificity(s, best) > 0) best = s;
  return best;
}

function computeSelectorSpecificity(selector: string): Specificity {
  let ids = 0;
  let classes = 0;
  let types = 0;

  let expectType = true;

  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];

    if (ch === '\\') {
      i += 1;
      continue;
    }

    if (ch === '[') {
      classes += 1;
      i = consumeBracket(selector, i);
      expectType = false;
      continue;
    }

    if (isCombinatorOrWhitespace(selector, i)) {
      i = consumeWhitespaceAndCombinators(selector, i);
      expectType = true;
      continue;
    }

    if (ch === '#') {
      ids += 1;
      i = consumeIdent(selector, i + 1) - 1;
      expectType = false;
      continue;
    }

    if (ch === '.') {
      classes += 1;
      i = consumeIdent(selector, i + 1) - 1;
      expectType = false;
      continue;
    }

    if (ch === ':') {
      const isPseudoEl = selector[i + 1] === ':';
      if (isPseudoEl) {
        types += 1;
        const nameStart = i + 2;
        const nameEnd = consumeIdent(selector, nameStart);
        const name = selector.slice(nameStart, nameEnd).toLowerCase();
        i = nameEnd - 1;

        if (selector[i + 1] === '(' && name === 'slotted') {
          const { content, endIndex } = consumeParenFunction(selector, i + 1);
          const maxArg = maxSpecificity(splitSelectorList(content).map(computeSelectorSpecificity));
          ids += maxArg[1];
          classes += maxArg[2];
          types += maxArg[3];
          i = endIndex;
        }

        expectType = false;
        continue;
      }

      const nameStart = i + 1;
      const nameEnd = consumeIdent(selector, nameStart);
      const name = selector.slice(nameStart, nameEnd).toLowerCase();

      if (LEGACY_PSEUDO_ELEMENTS.has(name)) {
        types += 1;
        i = nameEnd - 1;
        expectType = false;
        continue;
      }

      if (selector[nameEnd] === '(') {
        const { content, endIndex } = consumeParenFunction(selector, nameEnd);
        i = endIndex;

        if (name === 'where') {
          expectType = false;
          continue;
        }

        if (name === 'is' || name === 'not' || name === 'has') {
          const maxArg = maxSpecificity(splitSelectorList(content).map(computeSelectorSpecificity));
          ids += maxArg[1];
          classes += maxArg[2];
          types += maxArg[3];
          expectType = false;
          continue;
        }

        if (name === 'nth-child' || name === 'nth-last-child') {
          classes += 1;
          const ofSelectors = extractNthOfSelectorList(content);
          if (ofSelectors) {
            const maxArg = maxSpecificity(
              splitSelectorList(ofSelectors).map(computeSelectorSpecificity),
            );
            ids += maxArg[1];
            classes += maxArg[2];
            types += maxArg[3];
          }
          expectType = false;
          continue;
        }

        // Other functional pseudo-classes count as class specificity (+1).
        classes += 1;
        expectType = false;
        continue;
      }

      classes += 1;
      i = nameEnd - 1;
      expectType = false;
      continue;
    }

    if (expectType) {
      if (ch === '*') {
        expectType = false;
        continue;
      }
      if (isIdentStart(ch)) {
        types += 1;
        i = consumeIdent(selector, i + 1) - 1;
        expectType = false;
        continue;
      }
    }
  }

  return [0, ids, classes, types] as const;
}

/**
 * For a selector list, returns the matched selector with max specificity among matches.
 */
function computeMatchedRuleSpecificity(
  element: Element,
  selectorText: string,
): { matchedSelector: string; specificity: Specificity } | null {
  const selectors = splitSelectorList(selectorText);
  let bestSel: string | null = null;
  let bestSpec: Specificity = ZERO_SPEC;

  for (const sel of selectors) {
    try {
      if (!element.matches(sel)) continue;
      const spec = computeSelectorSpecificity(sel);
      if (!bestSel || compareSpecificity(spec, bestSpec) > 0) {
        bestSel = sel;
        bestSpec = spec;
      }
    } catch {
      // Invalid selector for matches() (e.g. pseudo-elements) => ignore.
    }
  }

  return bestSel ? { matchedSelector: bestSel, specificity: bestSpec } : null;
}

const LEGACY_PSEUDO_ELEMENTS = new Set([
  'before',
  'after',
  'first-line',
  'first-letter',
  'selection',
  'backdrop',
  'placeholder',
]);

function isIdentStart(ch: string): boolean {
  return /[a-zA-Z_]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

function consumeIdent(s: string, start: number): number {
  let i = start;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (/[a-zA-Z0-9_-]/.test(ch) || ch.charCodeAt(0) >= 0x80) continue;
    break;
  }
  return i;
}

function consumeBracket(s: string, openIndex: number): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;

  for (let i = openIndex + 1; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return s.length - 1;
}

function consumeParenFunction(
  s: string,
  openParenIndex: number,
): { content: string; endIndex: number } {
  let depth = 1;
  let quote: "'" | '"' | null = null;

  for (let i = openParenIndex + 1; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') i = consumeBracket(s, i);
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { content: s.slice(openParenIndex + 1, i), endIndex: i };
    }
  }
  return { content: s.slice(openParenIndex + 1), endIndex: s.length - 1 };
}

function isCombinatorOrWhitespace(s: string, i: number): boolean {
  const ch = s[i];
  return /\s/.test(ch) || ch === '>' || ch === '+' || ch === '~' || ch === '|';
}

function consumeWhitespaceAndCombinators(s: string, i: number): number {
  let j = i;
  while (j < s.length && /\s/.test(s[j])) j++;
  if (s[j] === '|' && s[j + 1] === '|') return j + 1;
  if (s[j] === '>' || s[j] === '+' || s[j] === '~' || s[j] === '|') return j;
  return j - 1;
}

function extractNthOfSelectorList(content: string): string | null {
  let depthParen = 0;
  let depthBrack = 0;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '\\') {
      i += 1;
      continue;
    }

    if (ch === '[') depthBrack += 1;
    else if (ch === ']' && depthBrack > 0) depthBrack -= 1;
    else if (ch === '(') depthParen += 1;
    else if (ch === ')' && depthParen > 0) depthParen -= 1;

    if (depthParen === 0 && depthBrack === 0) {
      if (isOfTokenAt(content, i)) return content.slice(i + 2).trimStart();
    }
  }

  return null;
}

function isOfTokenAt(s: string, i: number): boolean {
  if (s[i] !== 'o' || s[i + 1] !== 'f') return false;
  const prev = s[i - 1];
  const next = s[i + 2];
  const prevOk = prev === undefined || /\s/.test(prev);
  const nextOk = next === undefined || /\s/.test(next);
  return prevOk && nextOk;
}

// =============================================================================
// Inherited properties
// =============================================================================

export const INHERITED_PROPERTIES = new Set<string>([
  // Color & appearance
  'color',
  'color-scheme',
  'caret-color',
  'accent-color',

  // Typography / fonts
  'font',
  'font-family',
  'font-feature-settings',
  'font-kerning',
  'font-language-override',
  'font-optical-sizing',
  'font-palette',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-synthesis',
  'font-synthesis-small-caps',
  'font-synthesis-style',
  'font-synthesis-weight',
  'font-variant',
  'font-variant-alternates',
  'font-variant-caps',
  'font-variant-east-asian',
  'font-variant-emoji',
  'font-variant-ligatures',
  'font-variant-numeric',
  'font-variant-position',
  'font-variation-settings',
  'font-weight',
  'letter-spacing',
  'line-height',
  'text-rendering',
  'text-size-adjust',
  'text-transform',
  'text-indent',
  'text-align',
  'text-align-last',
  'text-justify',
  'text-shadow',
  'text-emphasis-color',
  'text-emphasis-position',
  'text-emphasis-style',
  'text-underline-position',
  'tab-size',
  'white-space',
  'word-break',
  'overflow-wrap',
  'word-spacing',
  'hyphens',
  'line-break',

  // Writing / bidi
  'direction',
  'unicode-bidi',
  'writing-mode',
  'text-orientation',
  'text-combine-upright',

  // Lists
  'list-style',
  'list-style-image',
  'list-style-position',
  'list-style-type',

  // Tables
  'border-collapse',
  'border-spacing',
  'caption-side',
  'empty-cells',

  // Visibility / interaction
  'cursor',
  'visibility',
  'pointer-events',
  'user-select',

  // Quotes & pagination
  'quotes',
  'orphans',
  'widows',

  // SVG
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'paint-order',
  'shape-rendering',
  'image-rendering',
  'color-interpolation',
  'color-interpolation-filters',
  'color-rendering',
  'dominant-baseline',
  'alignment-baseline',
  'baseline-shift',
  'text-anchor',
  'stop-color',
  'stop-opacity',
  'flood-color',
  'flood-opacity',
  'lighting-color',
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
]);

export function isInheritableProperty(property: string): boolean {
  const p = String(property || '').trim();
  if (!p) return false;
  if (p.startsWith('--')) return true;
  return INHERITED_PROPERTIES.has(p.toLowerCase());
}

// =============================================================================
// Shorthand expansion
// =============================================================================

export const SHORTHAND_TO_LONGHANDS: Record<string, readonly string[]> = {
  // Spacing
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  inset: ['top', 'right', 'bottom', 'left'],

  // Border
  border: [
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
    'border-top-style',
    'border-right-style',
    'border-bottom-style',
    'border-left-style',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
  ],
  'border-width': [
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
  ],
  'border-style': [
    'border-top-style',
    'border-right-style',
    'border-bottom-style',
    'border-left-style',
  ],
  'border-color': [
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
  ],

  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'],
  'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'],
  'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],

  'border-radius': [
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-right-radius',
    'border-bottom-left-radius',
  ],

  outline: ['outline-color', 'outline-style', 'outline-width'],

  // Background
  background: [
    'background-attachment',
    'background-clip',
    'background-color',
    'background-image',
    'background-origin',
    'background-position',
    'background-repeat',
    'background-size',
  ],

  // Font
  font: [
    'font-style',
    'font-variant',
    'font-weight',
    'font-stretch',
    'font-size',
    'line-height',
    'font-family',
  ],

  // Flexbox
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  'flex-flow': ['flex-direction', 'flex-wrap'],

  // Alignment
  'place-content': ['align-content', 'justify-content'],
  'place-items': ['align-items', 'justify-items'],
  'place-self': ['align-self', 'justify-self'],

  // Gaps
  gap: ['row-gap', 'column-gap'],
  'grid-gap': ['row-gap', 'column-gap'],

  // Overflow
  overflow: ['overflow-x', 'overflow-y'],

  // Grid
  'grid-area': ['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end'],
  'grid-row': ['grid-row-start', 'grid-row-end'],
  'grid-column': ['grid-column-start', 'grid-column-end'],
  'grid-template': ['grid-template-rows', 'grid-template-columns', 'grid-template-areas'],

  // Text
  'text-emphasis': ['text-emphasis-style', 'text-emphasis-color'],
  'text-decoration': [
    'text-decoration-line',
    'text-decoration-style',
    'text-decoration-color',
    'text-decoration-thickness',
  ],

  // Animations / transitions
  transition: [
    'transition-property',
    'transition-duration',
    'transition-timing-function',
    'transition-delay',
  ],
  animation: [
    'animation-name',
    'animation-duration',
    'animation-timing-function',
    'animation-delay',
    'animation-iteration-count',
    'animation-direction',
    'animation-fill-mode',
    'animation-play-state',
  ],

  // Multi-column
  columns: ['column-width', 'column-count'],
  'column-rule': ['column-rule-width', 'column-rule-style', 'column-rule-color'],

  // Lists
  'list-style': ['list-style-position', 'list-style-image', 'list-style-type'],
};

export function expandToLonghands(property: string): readonly string[] {
  const raw = String(property || '').trim();
  if (!raw) return [];
  if (raw.startsWith('--')) return [raw];
  const p = raw.toLowerCase();
  return SHORTHAND_TO_LONGHANDS[p] ?? [p];
}

function normalizePropertyName(property: string): string {
  const raw = String(property || '').trim();
  if (!raw) return '';
  if (raw.startsWith('--')) return raw;
  return raw.toLowerCase();
}

// =============================================================================
// Cascade / override
// =============================================================================

function compareSourceOrder(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  if (a[0] !== b[0]) return a[0] > b[0] ? 1 : -1;
  if (a[1] !== b[1]) return a[1] > b[1] ? 1 : -1;
  if (a[2] !== b[2]) return a[2] > b[2] ? 1 : -1;
  return 0;
}

function compareCascade(a: DeclCandidate, b: DeclCandidate): number {
  if (a.important !== b.important) return a.important ? 1 : -1;
  const spec = compareSpecificity(a.specificity, b.specificity);
  if (spec !== 0) return spec;
  return compareSourceOrder(a.sourceOrder, b.sourceOrder);
}

function computeOverrides(candidates: readonly DeclCandidate[]): {
  winners: Map<string, DeclCandidate>;
  declStatus: Map<string, DeclStatus>;
} {
  const winners = new Map<string, DeclCandidate>();

  for (const cand of candidates) {
    for (const longhand of cand.affects) {
      const cur = winners.get(longhand);
      if (!cur || compareCascade(cand, cur) > 0) winners.set(longhand, cand);
    }
  }

  const declStatus = new Map<string, DeclStatus>();
  for (const cand of candidates) declStatus.set(cand.id, 'overridden');
  for (const [, winner] of winners) declStatus.set(winner.id, 'active');

  return { winners, declStatus };
}

// =============================================================================
// CSSOM Rule Index
// =============================================================================

const CONTAINER_RULE = (globalThis as unknown as { CSSRule?: { CONTAINER_RULE?: number } }).CSSRule
  ?.CONTAINER_RULE;
const SCOPE_RULE = (globalThis as unknown as { CSSRule?: { SCOPE_RULE?: number } }).CSSRule
  ?.SCOPE_RULE;

function isSheetApplicable(sheet: CSSStyleSheet): boolean {
  if ((sheet as { disabled?: boolean }).disabled) return false;

  try {
    const mediaText = sheet.media?.mediaText?.trim() ?? '';
    if (!mediaText || mediaText.toLowerCase() === 'all') return true;
    return window.matchMedia(mediaText).matches;
  } catch {
    return true;
  }
}

function describeStyleSheet(sheet: CSSStyleSheet, fallbackIndex: number): CssRuleSource {
  const href = typeof sheet.href === 'string' ? sheet.href : undefined;

  if (href) {
    const file = href.split('/').pop()?.split('?')[0] ?? href;
    return { url: href, label: file };
  }

  const ownerNode = sheet.ownerNode as Node | null | undefined;
  if (ownerNode && ownerNode.nodeType === Node.ELEMENT_NODE) {
    const el = ownerNode as Element;
    if (el.tagName === 'STYLE') return { label: `<style #${fallbackIndex}>` };
    if (el.tagName === 'LINK') return { label: `<link #${fallbackIndex}>` };
  }

  return { label: `<constructed #${fallbackIndex}>` };
}

function safeReadCssRules(sheet: CSSStyleSheet): CSSRuleList | null {
  try {
    return sheet.cssRules;
  } catch {
    return null;
  }
}

function evalMediaRule(rule: CSSMediaRule, warnings: string[]): boolean {
  try {
    const mediaText = rule.media?.mediaText?.trim() ?? '';
    if (!mediaText || mediaText.toLowerCase() === 'all') return true;
    return window.matchMedia(mediaText).matches;
  } catch (e) {
    warnings.push(`Failed to evaluate @media rule: ${String(e)}`);
    return false;
  }
}

function evalSupportsRule(rule: CSSSupportsRule, warnings: string[]): boolean {
  try {
    const cond = rule.conditionText?.trim() ?? '';
    if (!cond) return true;
    if (typeof CSS?.supports !== 'function') return true;
    return CSS.supports(cond);
  } catch (e) {
    warnings.push(`Failed to evaluate @supports rule: ${String(e)}`);
    return false;
  }
}

function createRuleIndexForRoot(root: Document | ShadowRoot, rootId: number): RuleIndex {
  const warnings: string[] = [];
  const flatRules: FlatStyleRule[] = [];
  let rulesScanned = 0;

  const docOrShadow = root as DocumentOrShadowRoot;
  const styleSheets: CSSStyleSheet[] = [];

  try {
    for (const s of Array.from(docOrShadow.styleSheets ?? [])) {
      if (s && s instanceof CSSStyleSheet) styleSheets.push(s);
    }
  } catch {
    // ignore
  }

  try {
    const adopted = Array.from(docOrShadow.adoptedStyleSheets ?? []) as CSSStyleSheet[];
    for (const s of adopted) if (s && s instanceof CSSStyleSheet) styleSheets.push(s);
  } catch {
    // ignore
  }

  let order = 0;

  function walkRuleList(
    list: CSSRuleList,
    ctx: {
      sheetIndex: number;
      sourceForRules: CssRuleSource;
      topSheet: CSSStyleSheet;
      stack: Set<CSSStyleSheet>;
    },
  ): void {
    for (const rule of Array.from(list)) {
      rulesScanned += 1;

      if (CONTAINER_RULE && rule.type === CONTAINER_RULE) {
        warnings.push('Skipped @container rules (not evaluated in CSSOM collector)');
        continue;
      }

      if (SCOPE_RULE && rule.type === SCOPE_RULE) {
        warnings.push('Skipped @scope rules (not evaluated in CSSOM collector)');
        continue;
      }

      if (rule.type === CSSRule.IMPORT_RULE) {
        const importRule = rule as CSSImportRule;

        try {
          const mediaText = importRule.media?.mediaText?.trim() ?? '';
          if (
            mediaText &&
            mediaText.toLowerCase() !== 'all' &&
            !window.matchMedia(mediaText).matches
          ) {
            continue;
          }
        } catch {
          // ignore
        }

        const imported = importRule.styleSheet;
        if (imported) {
          // Check for cycle BEFORE adding to stack
          if (ctx.stack.has(imported)) {
            const src = describeStyleSheet(imported, ctx.sheetIndex);
            warnings.push(`Detected @import cycle, skipping: ${src.url ?? src.label}`);
            continue;
          }

          // Add to stack, process, then remove
          ctx.stack.add(imported);
          try {
            // Recursively walk the imported stylesheet
            if (!isSheetApplicable(imported)) {
              continue;
            }

            const cssRules = safeReadCssRules(imported);
            const src = describeStyleSheet(imported, ctx.sheetIndex);

            if (!cssRules) {
              warnings.push(
                `Skipped @import stylesheet (cannot access cssRules, likely cross-origin): ${src.url ?? src.label}`,
              );
              continue;
            }

            walkRuleList(cssRules, {
              sheetIndex: ctx.sheetIndex,
              sourceForRules: src,
              topSheet: imported,
              stack: ctx.stack,
            });
          } finally {
            ctx.stack.delete(imported);
          }
        }
        continue;
      }

      if (rule.type === CSSRule.MEDIA_RULE) {
        if (evalMediaRule(rule as CSSMediaRule, warnings)) {
          walkRuleList((rule as CSSMediaRule).cssRules, ctx);
        }
        continue;
      }

      if (rule.type === CSSRule.SUPPORTS_RULE) {
        if (evalSupportsRule(rule as CSSSupportsRule, warnings)) {
          walkRuleList((rule as CSSSupportsRule).cssRules, ctx);
        }
        continue;
      }

      if (rule.type === CSSRule.STYLE_RULE) {
        const styleRule = rule as CSSStyleRule;
        flatRules.push({
          sheetIndex: ctx.sheetIndex,
          order: order++,
          selectorText: styleRule.selectorText ?? '',
          style: styleRule.style,
          source: ctx.sourceForRules,
        });
        continue;
      }

      // Best-effort: traverse grouping rules we don't explicitly model (e.g. @layer blocks).
      const anyRule = rule as { cssRules?: CSSRuleList };
      if (anyRule.cssRules && typeof anyRule.cssRules.length === 'number') {
        try {
          walkRuleList(anyRule.cssRules, ctx);
        } catch {
          // ignore
        }
      }
    }
  }

  for (let sheetIndex = 0; sheetIndex < styleSheets.length; sheetIndex++) {
    const sheet = styleSheets[sheetIndex]!;
    if (!isSheetApplicable(sheet)) continue;

    const sheetSource = describeStyleSheet(sheet, sheetIndex);
    const cssRules = safeReadCssRules(sheet);
    if (!cssRules) {
      warnings.push(
        `Skipped stylesheet (cannot access cssRules, likely cross-origin): ${sheetSource.url ?? sheetSource.label}`,
      );
      continue;
    }

    // Create a fresh recursion stack for each top-level stylesheet
    const recursionStack = new Set<CSSStyleSheet>();
    recursionStack.add(sheet); // Add self to prevent self-import cycles
    walkRuleList(cssRules, {
      sheetIndex,
      sourceForRules: sheetSource,
      topSheet: sheet,
      stack: recursionStack,
    });
  }

  return {
    root,
    rootId,
    flatRules,
    warnings,
    stats: { styleSheets: styleSheets.length, rulesScanned },
  };
}

// =============================================================================
// Per-element collection
// =============================================================================

function readStyleDecls(style: CSSStyleDeclaration): Array<{
  property: string;
  value: string;
  important: boolean;
  declIndex: number;
}> {
  const out: Array<{ property: string; value: string; important: boolean; declIndex: number }> = [];

  const len = Number(style?.length ?? 0);
  for (let i = 0; i < len; i++) {
    let prop = '';
    try {
      prop = style.item(i);
    } catch {
      prop = '';
    }
    prop = normalizePropertyName(prop);
    if (!prop) continue;

    let value = '';
    let important = false;
    try {
      value = style.getPropertyValue(prop) ?? '';
      important = String(style.getPropertyPriority(prop) ?? '') === 'important';
    } catch {
      value = '';
      important = false;
    }

    out.push({ property: prop, value: String(value).trim(), important, declIndex: i });
  }

  return out;
}

function canReadInlineStyle(element: Element): element is Element & { style: CSSStyleDeclaration } {
  const anyEl = element as { style?: CSSStyleDeclaration };
  return (
    !!anyEl.style &&
    typeof anyEl.style.getPropertyValue === 'function' &&
    typeof anyEl.style.getPropertyPriority === 'function'
  );
}

function formatElementLabel(element: Element, maxClasses = 2): string {
  const tag = element.tagName.toLowerCase();
  const id = (element as HTMLElement).id?.trim();
  if (id) return `${tag}#${id}`;

  const classes = Array.from(element.classList ?? [])
    .slice(0, maxClasses)
    .filter(Boolean);
  if (classes.length) return `${tag}.${classes.join('.')}`;

  return tag;
}

function getElementRoot(element: Element): Document | ShadowRoot {
  try {
    const root = element.getRootNode?.();
    return root instanceof ShadowRoot ? root : (element.ownerDocument ?? document);
  } catch {
    return element.ownerDocument ?? document;
  }
}

function getParentElementOrHost(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;

  try {
    const root = element.getRootNode?.();
    if (root instanceof ShadowRoot) return root.host;
  } catch {
    // ignore
  }

  return null;
}

function collectForElement(
  element: Element,
  index: RuleIndex,
  elementId: number,
  options: CollectElementOptions,
): CollectedElementRules {
  const warnings: string[] = [];
  const matchedRules: CssRuleView[] = [];
  const candidates: DeclCandidate[] = [];

  const rootType: 'document' | 'shadow' = index.root instanceof ShadowRoot ? 'shadow' : 'document';

  let inlineRule: CssRuleView | null = null;

  if (options.includeInline && canReadInlineStyle(element)) {
    const declsRaw = readStyleDecls(element.style);
    const decls: CssDeclView[] = [];

    for (const d of declsRaw) {
      const affects = expandToLonghands(d.property);
      if (!options.declFilter({ property: d.property, affects })) continue;

      const declId = `inline:${elementId}:${d.declIndex}`;

      decls.push({
        id: declId,
        name: d.property,
        value: d.value,
        important: d.important,
        affects,
        status: 'overridden',
      });

      candidates.push({
        id: declId,
        important: d.important,
        specificity: [1, 0, 0, 0] as const,
        sourceOrder: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, d.declIndex],
        property: d.property,
        value: d.value,
        affects,
        ownerRuleId: `inline:${elementId}`,
        ownerElementId: elementId,
      });
    }

    inlineRule = {
      id: `inline:${elementId}`,
      origin: 'inline',
      selector: 'element.style',
      matchedSelector: 'element.style',
      specificity: [1, 0, 0, 0] as const,
      source: { label: 'element.style' },
      order: Number.MAX_SAFE_INTEGER,
      decls,
    };
  }

  for (const flat of index.flatRules) {
    const match = computeMatchedRuleSpecificity(element, flat.selectorText);
    if (!match) continue;

    const declsRaw = readStyleDecls(flat.style);
    const decls: CssDeclView[] = [];
    const ruleId = `rule:${index.rootId}:${flat.sheetIndex}:${flat.order}`;

    for (const d of declsRaw) {
      const affects = expandToLonghands(d.property);
      if (!options.declFilter({ property: d.property, affects })) continue;

      const declId = `${ruleId}:${d.declIndex}`;

      decls.push({
        id: declId,
        name: d.property,
        value: d.value,
        important: d.important,
        affects,
        status: 'overridden',
      });

      candidates.push({
        id: declId,
        important: d.important,
        specificity: match.specificity,
        sourceOrder: [flat.sheetIndex, flat.order, d.declIndex],
        property: d.property,
        value: d.value,
        affects,
        ownerRuleId: ruleId,
        ownerElementId: elementId,
      });
    }

    if (decls.length === 0) continue;

    matchedRules.push({
      id: ruleId,
      origin: 'rule',
      selector: flat.selectorText,
      matchedSelector: match.matchedSelector,
      specificity: match.specificity,
      source: flat.source,
      order: flat.order,
      decls,
    });
  }

  // Sort matched rules in a DevTools-like way (best-effort).
  matchedRules.sort((a, b) => {
    const sa = a.specificity ?? ZERO_SPEC;
    const sb = b.specificity ?? ZERO_SPEC;
    const spec = compareSpecificity(sb, sa); // desc
    if (spec !== 0) return spec;
    return b.order - a.order; // later first
  });

  return {
    element,
    elementId,
    root: index.root,
    rootType,
    inlineRule,
    matchedRules,
    candidates,
    warnings,
    stats: { matchedRules: matchedRules.length },
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Collect matched rules for ONE element (no inheritance), plus DeclCandidate[] used for cascade.
 */
export function collectMatchedRules(element: Element): {
  inlineRule: CssRuleView | null;
  matchedRules: CssRuleView[];
  candidates: DeclCandidate[];
  warnings: string[];
  stats: { styleSheets: number; rulesScanned: number; matchedRules: number };
} {
  const root = getElementRoot(element);

  const index = createRuleIndexForRoot(root, 1);
  const res = collectForElement(element, index, 1, {
    includeInline: true,
    declFilter: () => true,
  });

  return {
    inlineRule: res.inlineRule,
    matchedRules: res.matchedRules,
    candidates: res.candidates,
    warnings: [...index.warnings, ...res.warnings],
    stats: {
      styleSheets: index.stats.styleSheets,
      rulesScanned: index.stats.rulesScanned,
      matchedRules: res.stats.matchedRules,
    },
  };
}

/**
 * Collect full snapshot: inline + matched + inherited chain (ancestor traversal).
 */
export function collectCssPanelSnapshot(
  element: Element,
  options: { maxInheritanceDepth?: number } = {},
): CssPanelSnapshot {
  const warnings: string[] = [];
  const maxDepth = Number.isFinite(options.maxInheritanceDepth)
    ? Math.max(0, options.maxInheritanceDepth!)
    : 10;

  const elementIds = new WeakMap<Element, number>();
  let nextElementId = 1;
  const rootIds = new WeakMap<Document | ShadowRoot, number>();
  let nextRootId = 1;
  // Use WeakMap for caching, but also maintain a list for stats aggregation
  const indexCache = new WeakMap<Document | ShadowRoot, RuleIndex>();
  const indexList: RuleIndex[] = [];

  function getElementId(el: Element): number {
    const existing = elementIds.get(el);
    if (existing) return existing;
    const id = nextElementId++;
    elementIds.set(el, id);
    return id;
  }

  function getIndex(root: Document | ShadowRoot): RuleIndex {
    const cached = indexCache.get(root);
    if (cached) return cached;
    const rootId =
      rootIds.get(root) ??
      (() => {
        const v = nextRootId++;
        rootIds.set(root, v);
        return v;
      })();
    const idx = createRuleIndexForRoot(root, rootId);
    indexCache.set(root, idx);
    indexList.push(idx); // Also add to list for stats aggregation
    return idx;
  }

  if (!element || !element.isConnected) {
    return {
      target: { label: formatElementLabel(element), root: 'document' },
      warnings: ['Target element is not connected; snapshot may be incomplete.'],
      stats: { roots: 0, styleSheets: 0, rulesScanned: 0, matchedRules: 0 },
      sections: [],
    };
  }

  // ---- Target (direct rules) ----
  const targetRoot = getElementRoot(element);
  const targetIndex = getIndex(targetRoot);
  warnings.push(...targetIndex.warnings);

  const targetCollected = collectForElement(element, targetIndex, getElementId(element), {
    includeInline: true,
    declFilter: () => true,
  });

  // Compute overrides on target itself.
  const targetOverrides = computeOverrides(targetCollected.candidates);
  const targetDeclStatus = targetOverrides.declStatus;

  if (targetCollected.inlineRule) {
    for (const d of targetCollected.inlineRule.decls) {
      d.status = targetDeclStatus.get(d.id) ?? 'overridden';
    }
  }
  for (const rule of targetCollected.matchedRules) {
    for (const d of rule.decls) d.status = targetDeclStatus.get(d.id) ?? 'overridden';
  }

  // ---- Ancestor chain (inherited props only) ----
  const ancestors: Element[] = [];
  let cur: Element | null = getParentElementOrHost(element);
  while (cur && ancestors.length < maxDepth) {
    ancestors.push(cur);
    cur = getParentElementOrHost(cur);
  }

  const inheritableLonghands = new Set<string>();

  // Only consider inheritable longhands that appear in collected declarations (keeps work bounded).
  for (const cand of targetCollected.candidates) {
    for (const lh of cand.affects) if (isInheritableProperty(lh)) inheritableLonghands.add(lh);
  }

  const ancestorData: Array<{
    ancestor: Element;
    label: string;
    collected: CollectedElementRules;
    overrides: ReturnType<typeof computeOverrides>;
  }> = [];

  for (const a of ancestors) {
    const aRoot = getElementRoot(a);
    const aIndex = getIndex(aRoot);
    warnings.push(...aIndex.warnings);

    const aCollected = collectForElement(a, aIndex, getElementId(a), {
      includeInline: true,
      declFilter: ({ affects }) => affects.some(isInheritableProperty),
    });

    // Filter candidates to inheritable longhands only (affects subset).
    const filteredCandidates: DeclCandidate[] = [];

    for (const cand of aCollected.candidates) {
      const affects = cand.affects.filter(isInheritableProperty);
      if (affects.length === 0) continue;
      const next: DeclCandidate = { ...cand, affects };
      filteredCandidates.push(next);
      for (const lh of affects) inheritableLonghands.add(lh);
    }

    const aOverrides = computeOverrides(filteredCandidates);

    // Keep only inheritable decls in rule views (already filtered by declFilter), but ensure affects trimmed.
    if (aCollected.inlineRule) {
      aCollected.inlineRule.decls = aCollected.inlineRule.decls
        .map((d) => ({ ...d, affects: d.affects.filter(isInheritableProperty) }))
        .filter((d) => d.affects.length > 0);
      if (aCollected.inlineRule.decls.length === 0) aCollected.inlineRule = null;
    }
    aCollected.matchedRules = aCollected.matchedRules
      .map((r) => ({
        ...r,
        decls: r.decls
          .map((d) => ({ ...d, affects: d.affects.filter(isInheritableProperty) }))
          .filter((d) => d.affects.length > 0),
      }))
      .filter((r) => r.decls.length > 0);

    if (!aCollected.inlineRule && aCollected.matchedRules.length === 0) continue;

    ancestorData.push({
      ancestor: a,
      label: formatElementLabel(a),
      collected: { ...aCollected, candidates: filteredCandidates },
      overrides: aOverrides,
    });
  }

  // Determine which inherited declaration IDs actually provide the final inherited value for target.
  const finalInheritedDeclIds = new Set<string>();

  for (const longhand of inheritableLonghands) {
    if (targetOverrides.winners.has(longhand)) continue;

    for (const a of ancestorData) {
      const win = a.overrides.winners.get(longhand);
      if (win) {
        finalInheritedDeclIds.add(win.id);
        break;
      }
    }
  }

  // Apply inherited statuses: active only if it is the chosen inherited source for any longhand.
  for (const a of ancestorData) {
    if (a.collected.inlineRule) {
      for (const d of a.collected.inlineRule.decls) {
        d.status = finalInheritedDeclIds.has(d.id) ? 'active' : 'overridden';
      }
    }
    for (const r of a.collected.matchedRules) {
      for (const d of r.decls) d.status = finalInheritedDeclIds.has(d.id) ? 'active' : 'overridden';
    }
  }

  // ---- Build sections ----
  const sections: CssSectionView[] = [];

  sections.push({
    kind: 'inline',
    title: 'element.style',
    rules: targetCollected.inlineRule ? [targetCollected.inlineRule] : [],
  });

  sections.push({
    kind: 'matched',
    title: 'Matched CSS Rules',
    rules: targetCollected.matchedRules,
  });

  for (const a of ancestorData) {
    const rules: CssRuleView[] = [];
    if (a.collected.inlineRule) rules.push(a.collected.inlineRule);
    rules.push(...a.collected.matchedRules);

    sections.push({
      kind: 'inherited',
      title: `Inherited from ${a.label}`,
      inheritedFrom: { label: a.label },
      rules,
    });
  }

  // ---- Aggregate stats ----
  let totalStyleSheets = 0;
  let totalRulesScanned = 0;
  const rootsSeen = new Set<number>();
  for (const idx of indexList) {
    rootsSeen.add(idx.rootId);
    totalStyleSheets += idx.stats.styleSheets;
    totalRulesScanned += idx.stats.rulesScanned;
  }

  const dedupWarnings = Array.from(new Set([...warnings, ...targetCollected.warnings]));

  return {
    target: {
      label: formatElementLabel(element),
      root: targetRoot instanceof ShadowRoot ? 'shadow' : 'document',
    },
    warnings: dedupWarnings,
    stats: {
      roots: rootsSeen.size,
      styleSheets: totalStyleSheets,
      rulesScanned: totalRulesScanned,
      matchedRules: targetCollected.stats.matchedRules,
    },
    sections,
  };
}
