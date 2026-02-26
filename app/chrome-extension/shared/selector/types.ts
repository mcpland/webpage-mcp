/**
 * Shared selector engine types.
 *
 * Goals:
 * - JSON-serializable (store in flows / send across message boundary)
 * - Reusable from both content scripts and background
 *
 * Composite selector format:
 *   "<frameSelector> |> <innerSelector>"
 * This is kept for backward compatibility with the existing recorder and
 * accessibility-tree helper.
 */

export type NonEmptyArray<T> = [T, ...T[]];

export interface Point {
  x: number;
  y: number;
}

export type SelectorType = 'css' | 'xpath' | 'attr' | 'aria' | 'text';
export type SelectorCandidateSource = 'recorded' | 'user' | 'generated';

export interface SelectorStabilitySignals {
  usesId?: boolean;
  usesTestId?: boolean;
  usesAria?: boolean;
  usesText?: boolean;
  usesNthOfType?: boolean;
  usesAttributes?: boolean;
  usesClass?: boolean;
}

export interface SelectorStability {
  /** Stability score in range [0, 1]. Higher is more stable. */
  score: number;
  signals?: SelectorStabilitySignals;
  note?: string;
}

export interface SelectorCandidateBase {
  type: SelectorType;
  /**
   * Primary representation:
   * - css/attr: CSS selector string
   * - xpath: XPath expression string
   * - text: visible text query string
   * - aria: human-readable expression for debugging/UI
   */
  value: string;
  /** Optional user-adjustable priority. Higher wins when ordering candidates. */
  weight?: number;
  /** Where this candidate came from. */
  source?: SelectorCandidateSource;
  /** Strategy identifier that produced this candidate. */
  strategy?: string;
  /** Optional computed stability. */
  stability?: SelectorStability;
}

export type TextMatchMode = 'exact' | 'contains';

export type SelectorCandidate =
  | (SelectorCandidateBase & { type: 'css' | 'attr' })
  | (SelectorCandidateBase & { type: 'xpath' })
  | (SelectorCandidateBase & { type: 'text'; match?: TextMatchMode; tagNameHint?: string })
  | (SelectorCandidateBase & { type: 'aria'; role?: string; name?: string });

export interface SelectorTarget {
  /**
   * Optional primary selector string.
   * This is the fast path for locating (usually CSS). May be composite.
   */
  selector?: string;
  /** Ordered candidates; must be non-empty. */
  candidates: NonEmptyArray<SelectorCandidate>;
  /** Optional tag name hint used for text search. */
  tagName?: string;
  /** Optional ephemeral element ref, when available. */
  ref?: string;

  // --------------------------------
  // Extended Locator Metadata (Phase 1.2)
  // --------------------------------
  // These fields are generated and carried across message/storage boundaries,
  // but the background-side SelectorLocator may not fully use them until
  // Phase 2 wires the DOM-side protocol (fingerprint verification, shadow traversal).

  /**
   * Structural fingerprint for fuzzy element matching.
   * Format: "tag|id=xxx|class=a.b.c|text=xxx"
   */
  fingerprint?: string;

  /**
   * Child-index path relative to the current root (Document/ShadowRoot).
   * Used for fast element recovery when selectors fail.
   */
  domPath?: number[];

  /**
   * Shadow host selector chain (outer -> inner).
   * When present, selectors/domPath are relative to the innermost ShadowRoot.
   */
  shadowHostChain?: string[];
}

/**
 * SelectorTarget with required extended locator metadata.
 *
 * Use this type when all extended fields must be present (e.g., for reliable
 * cross-session persistence or HMR recovery).
 *
 * Note: Phase 1.2 only guarantees generation/transport; behavioral enforcement
 * (fingerprint verification, shadow traversal) depends on Phase 2 integration.
 */
export interface ExtendedSelectorTarget extends SelectorTarget {
  fingerprint: string;
  domPath: number[];
  /** May be empty array if element is not inside Shadow DOM */
  shadowHostChain: string[];
}

export interface LocatedElement {
  ref: string;
  center: Point;
  /** Resolved frameId in the tab (when inside an iframe). */
  frameId?: number;
  resolvedBy: 'ref' | SelectorType;
  selectorUsed?: string;
}

export interface SelectorLocateOptions {
  /** Frame context for non-composite selectors (default: top frame). */
  frameId?: number;
  /** Whether to try resolving `target.ref` before selectors. */
  preferRef?: boolean;
  /** Forwarded to helper uniqueness checks. */
  allowMultiple?: boolean;
  /**
   * Whether to verify target.fingerprint when available.
   *
   * Note: Phase 1.2 exposes this option but may not fully enforce it until
   * the DOM-side protocol is wired (Phase 2).
   */
  verifyFingerprint?: boolean;
}

// ================================
// Composite Selector Utilities
// ================================

export const COMPOSITE_SELECTOR_SEPARATOR = '|>' as const;

export interface CompositeSelectorParts {
  frameSelector: string;
  innerSelector: string;
}

export function splitCompositeSelector(selector: string): CompositeSelectorParts | null {
  if (typeof selector !== 'string') return null;

  const parts = selector
    .split(COMPOSITE_SELECTOR_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length < 2) return null;

  return {
    frameSelector: parts[0],
    innerSelector: parts.slice(1).join(` ${COMPOSITE_SELECTOR_SEPARATOR} `),
  };
}

export function isCompositeSelector(selector: string): boolean {
  return splitCompositeSelector(selector) !== null;
}

export function composeCompositeSelector(frameSelector: string, innerSelector: string): string {
  return `${String(frameSelector).trim()} ${COMPOSITE_SELECTOR_SEPARATOR} ${String(innerSelector).trim()}`.trim();
}

// ================================
// Strategy Pattern Types
// ================================

export interface NormalizedSelectorGenerationOptions {
  maxCandidates: number;
  includeText: boolean;
  includeAria: boolean;
  includeCssUnique: boolean;
  includeCssPath: boolean;
  testIdAttributes: ReadonlyArray<string>;
  textMaxLength: number;
  textTags: ReadonlyArray<string>;
}

export interface SelectorGenerationOptions {
  maxCandidates?: number;
  includeText?: boolean;
  includeAria?: boolean;
  includeCssUnique?: boolean;
  includeCssPath?: boolean;
  testIdAttributes?: ReadonlyArray<string>;
  textMaxLength?: number;
  textTags?: ReadonlyArray<string>;
}

export interface SelectorStrategyHelpers {
  cssEscape: (value: string) => string;
  isUnique: (selector: string) => boolean;
  safeQueryAll: (selector: string) => ReadonlyArray<Element>;
}

export interface SelectorStrategyContext {
  element: Element;
  root: ParentNode;
  options: NormalizedSelectorGenerationOptions;
  helpers: SelectorStrategyHelpers;
}

export interface SelectorStrategy {
  /** Stable id used for debugging/analytics. */
  id: string;
  generate: (ctx: SelectorStrategyContext) => ReadonlyArray<SelectorCandidate>;
}
