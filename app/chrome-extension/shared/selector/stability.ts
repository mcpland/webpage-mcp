/**
 * Selector Stability - Selector stability assessment
 */

import type {
  SelectorCandidate,
  SelectorStability,
  SelectorStabilitySignals,
  SelectorType,
} from './types';
import { splitCompositeSelector } from './types';

const TESTID_ATTR_NAMES = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-qa',
  'data-cy',
] as const;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function mergeSignals(
  a: SelectorStabilitySignals,
  b: SelectorStabilitySignals,
): SelectorStabilitySignals {
  return {
    usesId: a.usesId || b.usesId || undefined,
    usesTestId: a.usesTestId || b.usesTestId || undefined,
    usesAria: a.usesAria || b.usesAria || undefined,
    usesText: a.usesText || b.usesText || undefined,
    usesNthOfType: a.usesNthOfType || b.usesNthOfType || undefined,
    usesAttributes: a.usesAttributes || b.usesAttributes || undefined,
    usesClass: a.usesClass || b.usesClass || undefined,
  };
}

function analyzeCssLike(selector: string): SelectorStabilitySignals {
  const s = String(selector || '');
  const usesNthOfType = /:nth-of-type\(/i.test(s);
  const usesAttributes = /\[[^\]]+\]/.test(s);
  const usesAria = /\[\s*aria-[^=]+\s*=|\[\s*role\s*=|\brole\s*=\s*/i.test(s);

  // Avoid counting `#` inside attribute values (e.g. href="#...") by requiring a token-ish pattern.
  const usesId = /(^|[\s>+~])#[^\s>+~.:#[]+/.test(s);
  const usesClass = /(^|[\s>+~])\.[^\s>+~.:#[]+/.test(s);

  const lower = s.toLowerCase();
  const usesTestId = TESTID_ATTR_NAMES.some((a) => lower.includes(`[${a}`));

  return {
    usesId: usesId || undefined,
    usesTestId: usesTestId || undefined,
    usesAria: usesAria || undefined,
    usesNthOfType: usesNthOfType || undefined,
    usesAttributes: usesAttributes || undefined,
    usesClass: usesClass || undefined,
  };
}

function baseScoreForCssSignals(signals: SelectorStabilitySignals): number {
  if (signals.usesTestId) return 0.95;
  if (signals.usesId) return 0.9;
  if (signals.usesAria) return 0.8;
  if (signals.usesAttributes) return 0.75;
  if (signals.usesClass) return 0.65;
  return 0.5;
}

function lengthPenalty(value: string): number {
  const len = value.length;
  if (len <= 60) return 0;
  if (len <= 120) return 0.05;
  if (len <= 200) return 0.1;
  return 0.18;
}

/**
 * Calculate selector stability score
 */
export function computeSelectorStability(candidate: SelectorCandidate): SelectorStability {
  if (candidate.type === 'css' || candidate.type === 'attr') {
    const composite = splitCompositeSelector(candidate.value);
    if (composite) {
      const a = analyzeCssLike(composite.frameSelector);
      const b = analyzeCssLike(composite.innerSelector);
      const merged = mergeSignals(a, b);

      let score = baseScoreForCssSignals(merged);
      score -= 0.05; // iframe coupling penalty
      if (merged.usesNthOfType) score -= 0.2;
      score -= lengthPenalty(candidate.value);

      return { score: clamp01(score), signals: merged, note: 'composite' };
    }

    const signals = analyzeCssLike(candidate.value);
    let score = baseScoreForCssSignals(signals);
    if (signals.usesNthOfType) score -= 0.2;
    score -= lengthPenalty(candidate.value);

    return { score: clamp01(score), signals };
  }

  if (candidate.type === 'xpath') {
    const s = String(candidate.value || '');
    const signals: SelectorStabilitySignals = {
      usesAttributes: /@[\w-]+\s*=/.test(s) || undefined,
      usesId: /@id\s*=/.test(s) || undefined,
      usesTestId: /@data-testid\s*=/.test(s) || undefined,
    };

    let score = 0.42;
    if (signals.usesTestId) score = 0.85;
    else if (signals.usesId) score = 0.75;
    else if (signals.usesAttributes) score = 0.55;

    score -= lengthPenalty(s);
    return { score: clamp01(score), signals };
  }

  if (candidate.type === 'aria') {
    const hasName = typeof candidate.name === 'string' && candidate.name.trim().length > 0;
    const hasRole = typeof candidate.role === 'string' && candidate.role.trim().length > 0;

    const signals: SelectorStabilitySignals = { usesAria: true };
    let score = hasName && hasRole ? 0.8 : hasName ? 0.72 : 0.6;
    score -= lengthPenalty(candidate.value);

    return { score: clamp01(score), signals };
  }

  // text
  const text = String(candidate.value || '').trim();
  const signals: SelectorStabilitySignals = { usesText: true };
  let score = 0.35;

  // Very short texts tend to be ambiguous; very long texts are unstable.
  if (text.length >= 6 && text.length <= 48) score = 0.45;
  if (text.length > 80) score = 0.3;

  return { score: clamp01(score), signals };
}

/**
 * Add stability score to selector candidates
 */
export function withStability(candidate: SelectorCandidate): SelectorCandidate {
  if (candidate.stability) return candidate;
  return { ...candidate, stability: computeSelectorStability(candidate) };
}

function typePriority(type: SelectorType): number {
  switch (type) {
    case 'attr':
      return 5;
    case 'css':
      return 4;
    case 'aria':
      return 3;
    case 'xpath':
      return 2;
    case 'text':
      return 1;
    default:
      return 0;
  }
}

/**
 * Compare priority of two selector candidates
 * Returns negative for a priority, positive for b priority
 */
export function compareSelectorCandidates(a: SelectorCandidate, b: SelectorCandidate): number {
  // 1. User-specified weight takes priority
  const aw = a.weight ?? 0;
  const bw = b.weight ?? 0;
  if (aw !== bw) return bw - aw;

  // 2. Stability score
  const as = a.stability?.score ?? computeSelectorStability(a).score;
  const bs = b.stability?.score ?? computeSelectorStability(b).score;
  if (as !== bs) return bs - as;

  // 3. Type priority
  const ap = typePriority(a.type);
  const bp = typePriority(b.type);
  if (ap !== bp) return bp - ap;

  // 4. Length (shorter is better)
  const alen = String(a.value || '').length;
  const blen = String(b.value || '').length;
  return alen - blen;
}
