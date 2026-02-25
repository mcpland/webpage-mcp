/**
 * Selector Generator - 选择器生成器
 * 为 DOM 元素生成多个候选选择器
 */

import type {
  NonEmptyArray,
  NormalizedSelectorGenerationOptions,
  SelectorCandidate,
  SelectorGenerationOptions,
  SelectorStrategy,
  SelectorStrategyContext,
  SelectorTarget,
  ExtendedSelectorTarget,
} from './types';
import { compareSelectorCandidates, withStability } from './stability';
import { DEFAULT_SELECTOR_STRATEGIES } from './strategies';
import { computeDomPath } from './dom-path';
import { computeFingerprint } from './fingerprint';

const DEFAULT_MAX_CANDIDATES = 8;
const DEFAULT_TEXT_MAX_LENGTH = 64;

const DEFAULT_TEXT_TAGS = ['button', 'a', 'summary'] as const;

const DEFAULT_TESTID_ATTRS = [
  'data-testid',
  'data-test-id',
  'data-testId',
  'data-test',
  'data-qa',
  'data-cy',
  'name',
  'title',
  'alt',
] as const;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * 标准化选择器生成选项
 */
export function normalizeSelectorGenerationOptions(
  options: SelectorGenerationOptions | undefined,
): NormalizedSelectorGenerationOptions {
  return {
    maxCandidates: clampInt(options?.maxCandidates ?? DEFAULT_MAX_CANDIDATES, 1, 50),
    includeText: options?.includeText ?? true,
    includeAria: options?.includeAria ?? true,
    includeCssUnique: options?.includeCssUnique ?? true,
    includeCssPath: options?.includeCssPath ?? true,
    testIdAttributes: options?.testIdAttributes ?? DEFAULT_TESTID_ATTRS,
    textMaxLength: clampInt(options?.textMaxLength ?? DEFAULT_TEXT_MAX_LENGTH, 1, 256),
    textTags: options?.textTags ?? DEFAULT_TEXT_TAGS,
  };
}

/**
 * CSS 字符串转义
 * Uses native CSS.escape when available; otherwise falls back to a spec-inspired polyfill.
 */
export function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);

  const str = String(value);
  const len = str.length;
  if (len === 0) return '';

  let result = '';
  const firstCodeUnit = str.charCodeAt(0);

  for (let i = 0; i < len; i++) {
    const codeUnit = str.charCodeAt(i);

    if (codeUnit === 0x0000) {
      result += '\uFFFD';
      continue;
    }

    if (
      (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
      codeUnit === 0x007f ||
      (i === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (i === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002d)
    ) {
      result += `\\${codeUnit.toString(16)} `;
      continue;
    }

    if (i === 0 && len === 1 && codeUnit === 0x002d) {
      result += `\\${str.charAt(i)}`;
      continue;
    }

    const isAsciiAlnum =
      (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
      (codeUnit >= 0x0061 && codeUnit <= 0x007a);

    const isSafe = isAsciiAlnum || codeUnit === 0x002d || codeUnit === 0x005f;

    if (isSafe) result += str.charAt(i);
    else result += `\\${str.charAt(i)}`;
  }

  return result;
}

function getQueryRoot(element: Element): ParentNode {
  const root = element.getRootNode?.();
  if (root instanceof ShadowRoot) return root;
  if (typeof document !== 'undefined') return document;
  throw new Error('Selector generator requires a DOM-like environment');
}

function safeQueryAll(root: ParentNode, selector: string): ReadonlyArray<Element> {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function isUnique(root: ParentNode, selector: string): boolean {
  try {
    return root.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function candidateKey(c: SelectorCandidate): string {
  switch (c.type) {
    case 'text':
      return `text:${c.value}:${c.tagNameHint ?? ''}:${c.match ?? ''}`;
    case 'aria':
      return `aria:${c.role ?? ''}:${c.name ?? ''}:${c.value}`;
    default:
      return `${c.type}:${c.value}`;
  }
}

export interface GenerateSelectorTargetOptions extends SelectorGenerationOptions {
  root?: ParentNode;
  strategies?: ReadonlyArray<SelectorStrategy>;
}

/**
 * 为 DOM 元素生成选择器目标
 */
export function generateSelectorTarget(
  element: Element,
  options: GenerateSelectorTargetOptions = {},
): SelectorTarget {
  const normalized = normalizeSelectorGenerationOptions(options);
  const root = options.root ?? getQueryRoot(element);

  const helpers = {
    cssEscape,
    isUnique: (selector: string) => isUnique(root, selector),
    safeQueryAll: (selector: string) => safeQueryAll(root, selector),
  };

  const ctx: SelectorStrategyContext = {
    element,
    root,
    options: normalized,
    helpers,
  };

  const strategies = options.strategies ?? DEFAULT_SELECTOR_STRATEGIES;

  const raw: SelectorCandidate[] = [];
  for (const strategy of strategies) {
    const produced = strategy.generate(ctx);
    for (const c0 of produced) {
      raw.push({
        ...c0,
        source: c0.source ?? 'generated',
        strategy: c0.strategy ?? strategy.id,
      });
    }
  }

  // Dedupe (keep first occurrence)
  const seen = new Set<string>();
  const deduped: SelectorCandidate[] = [];
  for (const c of raw) {
    const key = candidateKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(withStability(c));
  }

  // If strategies produced nothing (shouldn't happen), create a minimal fallback.
  if (deduped.length === 0) {
    const fallback: SelectorCandidate = withStability({
      type: 'css',
      value: 'body',
      source: 'generated',
      strategy: 'fallback',
    });
    const candidates: NonEmptyArray<SelectorCandidate> = [fallback];
    return {
      selector: fallback.value,
      candidates,
      tagName: element.tagName?.toLowerCase?.() ?? undefined,
    };
  }

  // Sort and truncate
  const sorted = [...deduped].sort(compareSelectorCandidates).slice(0, normalized.maxCandidates);

  // Primary selector should be directly usable by locator (prefer CSS/attr)
  const primary = sorted.find((c) => c.type === 'css' || c.type === 'attr') ?? sorted[0];

  const reordered = (() => {
    const idx = sorted.indexOf(primary);
    if (idx <= 0) return sorted;
    return [primary, ...sorted.slice(0, idx), ...sorted.slice(idx + 1)];
  })();

  const tagName = element.tagName?.toLowerCase?.() ?? undefined;

  return {
    selector: primary.value,
    candidates: reordered as NonEmptyArray<SelectorCandidate>,
    tagName,
  };
}

// =============================================================================
// Extended Selector Target (Phase 1.2)
// =============================================================================

function safeMatches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

/**
 * Pick the best selector for a shadow host element.
 * Prefers unique CSS/attr selectors from the generated candidates.
 */
function pickShadowHostSelector(
  host: Element,
  hostRoot: ParentNode,
  options: GenerateSelectorTargetOptions,
): string | null {
  const hostTarget = generateSelectorTarget(host, { ...options, root: hostRoot });

  let fallback: string | null = null;

  // Try to find a unique selector from candidates
  for (const candidate of hostTarget.candidates) {
    if (candidate.type !== 'css' && candidate.type !== 'attr') continue;

    const selector = String(candidate.value || '').trim();
    if (!selector) continue;

    // Verify the selector actually matches the host
    if (!safeMatches(host, selector)) continue;

    // Check uniqueness in the host's root
    if (isUnique(hostRoot, selector)) {
      return selector;
    }

    // Keep first matching selector as fallback
    if (!fallback) {
      fallback = selector;
    }
  }

  // Try the primary selector
  const primary = typeof hostTarget.selector === 'string' ? hostTarget.selector.trim() : '';
  if (primary && safeMatches(host, primary)) {
    return primary;
  }

  return fallback;
}

/**
 * Compute shadow host selector chain (outer -> inner).
 *
 * Returns an empty array when:
 * - Element is not inside Shadow DOM
 * - A host selector cannot be generated for any boundary
 */
function computeShadowHostChain(
  element: Element,
  options: GenerateSelectorTargetOptions,
): string[] {
  const chain: string[] = [];
  let current: Element = element;

  while (true) {
    const rootNode = current.getRootNode?.();
    if (!(rootNode instanceof ShadowRoot)) {
      break;
    }

    const host = rootNode.host;
    if (!(host instanceof Element)) {
      break;
    }

    const hostRoot = getQueryRoot(host);
    const hostSelector = pickShadowHostSelector(host, hostRoot, options);

    if (!hostSelector) {
      // Cannot generate selector for this host, return empty chain
      return [];
    }

    chain.unshift(hostSelector);
    current = host;
  }

  return chain;
}

/**
 * Generate selector target with additional metadata (Phase 1.2).
 *
 * This function generates a complete ElementLocator-like structure including:
 * - fingerprint: for fuzzy element matching
 * - domPath: for fast element recovery
 * - shadowHostChain: for Shadow DOM traversal
 *
 * @example
 * ```ts
 * const target = generateExtendedSelectorTarget(buttonElement);
 * // target.fingerprint = "button|id=submit|class=btn.primary"
 * // target.domPath = [0, 2, 1]
 * // target.shadowHostChain = ["my-component"] or []
 * ```
 */
export function generateExtendedSelectorTarget(
  element: Element,
  options: GenerateSelectorTargetOptions = {},
): ExtendedSelectorTarget {
  const base = generateSelectorTarget(element, options);

  return {
    ...base,
    fingerprint: computeFingerprint(element),
    domPath: computeDomPath(element),
    shadowHostChain: computeShadowHostChain(element, options),
  };
}
