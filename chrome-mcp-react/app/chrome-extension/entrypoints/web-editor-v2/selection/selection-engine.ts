/**
 * Selection Engine (Phase 1.6 - Basic)
 *
 * Heuristic-based target picking to reduce noisy selections.
 *
 * Goals:
 * - Skip invisible/transparent elements
 * - De-prioritize "wrapper-only" elements (single-child, no visual boundary)
 * - Prefer interactive elements (button/link/input/etc.)
 * - Prefer elements with visual boundaries (border/background/shadow)
 * - Support basic parent drilling via Alt modifier
 *
 * Scoring system:
 * - Positive scores: interactive elements, visual boundaries, appropriate size
 * - Negative scores: wrapper-only, too small/large, SVG internals
 * - Candidates sorted by score descending, then by DOM order
 */

import { Disposer } from '../utils/disposables';

// =============================================================================
// Types
// =============================================================================

/** Options for creating the selection engine */
export interface SelectionEngineOptions {
  /** Check if a DOM node belongs to the editor overlay */
  isOverlayElement: (node: unknown) => boolean;
}

/** A scored selection candidate */
export interface SelectionCandidate {
  /** The candidate element */
  element: Element;
  /** Heuristic score (higher = better target) */
  score: number;
  /** Debug reasons explaining the score */
  reasons: string[];
  /** Whether this element is a wrapper-only container (no visual meaning) */
  wrapperOnly?: boolean;
}

/** Keyboard modifiers for selection behavior */
export interface Modifiers {
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
}

/** Selection engine public interface */
export interface SelectionEngine {
  /** Find the best target at a viewport point with modifier support */
  findBestTarget(x: number, y: number, modifiers: Modifiers): Element | null;
  /**
   * Find the best target from an Event (Shadow DOM aware via composedPath).
   * Intended for click/selection only; hover should stay coordinate-based for performance.
   *
   * - Uses composedPath() to access elements inside Shadow DOM
   * - Ctrl/Cmd + Click: selects innermost visible element (drill-in)
   * - Alt + Click: selects parent element (drill-up)
   */
  findBestTargetFromEvent(event: Event, modifiers: Modifiers): Element | null;
  /** Get scored candidates at a point (for debugging or drill-up UI) */
  getCandidatesAtPoint(x: number, y: number): SelectionCandidate[];
  /** Get a meaningful parent candidate (for Alt drill-up) */
  getParentCandidate(current: Element): Element | null;
  /** Cleanup */
  dispose(): void;
}

// =============================================================================
// Constants
// =============================================================================

/** Max elements from elementsFromPoint to process */
const MAX_HIT_ELEMENTS = 8;

/** Max ancestor depth to traverse */
const MAX_ANCESTOR_DEPTH = 6;

/** Max total candidates to consider */
const MAX_CANDIDATES = 60;

/** Epsilon for rect comparisons */
const RECT_EPSILON = 0.5;

/** Tags that are inherently interactive */
const INTERACTIVE_TAGS = new Set([
  'A',
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'LABEL',
  'SUMMARY',
  'DETAILS',
]);

/** ARIA roles that indicate interactivity */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'option',
  'combobox',
  'textbox',
]);

/** Tags commonly used as layout wrappers */
const WRAPPER_TAGS = new Set([
  'DIV',
  'SPAN',
  'SECTION',
  'ARTICLE',
  'MAIN',
  'HEADER',
  'FOOTER',
  'NAV',
  'ASIDE',
]);

// =============================================================================
// Helpers
// =============================================================================

/**
 * Parse a CSS numeric value
 */
function parseNumber(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Check if a color is effectively transparent
 */
function isTransparentColor(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === 'transparent') return true;

  // Check rgba() with alpha <= 0.01
  const rgba = v.match(/^rgba?\((.+)\)$/);
  if (rgba) {
    const parts = rgba[1].split(',').map((p) => p.trim());
    if (parts.length >= 4) {
      const alpha = Number.parseFloat(parts[3]);
      return Number.isFinite(alpha) && alpha <= 0.01;
    }
    // rgb() without alpha is opaque
    return false;
  }

  // Check hsla() with alpha <= 0.01
  const hsla = v.match(/^hsla?\((.+)\)$/);
  if (hsla) {
    const parts = hsla[1].split(',').map((p) => p.trim());
    if (parts.length >= 4) {
      const alpha = Number.parseFloat(parts[3]);
      return Number.isFinite(alpha) && alpha <= 0.01;
    }
    return false;
  }

  // hex and other formats are opaque
  return false;
}

/**
 * Check if element has direct text content (not just whitespace)
 */
function hasDirectNonWhitespaceText(element: Element): boolean {
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
      return true;
    }
  }
  return false;
}

/**
 * Get parent element, crossing Shadow DOM boundaries
 */
function getParentElementOrHost(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;

  try {
    const root = element.getRootNode?.();
    if (root instanceof ShadowRoot) {
      return root.host;
    }
  } catch {
    // Ignore and fall back to null
  }

  return null;
}

/**
 * Get elements at a viewport point
 */
function getHitElementsAtPoint(x: number, y: number): Element[] {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [];

  try {
    if (typeof document.elementsFromPoint === 'function') {
      return document.elementsFromPoint(x, y);
    }
  } catch {
    // Fall back to elementFromPoint
  }

  const el = document.elementFromPoint(x, y);
  return el ? [el] : [];
}

/**
 * Get viewport area for size ratio calculations
 */
function getViewportArea(): number {
  const w = Math.max(1, window.innerWidth || 1);
  const h = Math.max(1, window.innerHeight || 1);
  return w * h;
}

/**
 * Safely read element rect
 */
function readRect(element: Element): DOMRectReadOnly | null {
  try {
    const rect = element.getBoundingClientRect();
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return null;
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
    return rect;
  } catch {
    return null;
  }
}

/**
 * Check if element is effectively invisible
 */
function isEffectivelyInvisible(style: CSSStyleDeclaration, rect: DOMRectReadOnly): boolean {
  if (style.display === 'none') return true;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
  if (parseNumber(style.opacity) <= 0.01) return true;

  // Check contentVisibility (non-standard property)
  const contentVisibility = (style as unknown as Record<string, unknown>).contentVisibility;
  if (contentVisibility === 'hidden') return true;

  // Zero-dimension elements
  if (rect.width <= RECT_EPSILON || rect.height <= RECT_EPSILON) return true;

  return false;
}

/**
 * Score element based on visual boundary presence
 */
function getVisualBoundaryScore(
  element: Element,
  style: CSSStyleDeclaration,
): { points: number; reasons: string[] } {
  let points = 0;
  const reasons: string[] = [];

  // Background color or image
  if (!isTransparentColor(style.backgroundColor) || style.backgroundImage !== 'none') {
    points += 2;
    reasons.push('visual:background:+2');
  }

  // Border
  const borderWidths = [
    parseNumber(style.borderTopWidth),
    parseNumber(style.borderRightWidth),
    parseNumber(style.borderBottomWidth),
    parseNumber(style.borderLeftWidth),
  ];
  const hasBorder =
    borderWidths.some((w) => w > RECT_EPSILON) &&
    (style.borderTopStyle !== 'none' ||
      style.borderRightStyle !== 'none' ||
      style.borderBottomStyle !== 'none' ||
      style.borderLeftStyle !== 'none');
  if (hasBorder) {
    points += 3;
    reasons.push('visual:border:+3');
  }

  // Box shadow
  if (style.boxShadow && style.boxShadow !== 'none') {
    points += 2;
    reasons.push('visual:shadow:+2');
  }

  // Outline
  if (style.outlineStyle !== 'none' && parseNumber(style.outlineWidth) > RECT_EPSILON) {
    points += 1;
    reasons.push('visual:outline:+1');
  }

  // Media elements are visually meaningful
  const tag = element.tagName.toUpperCase();
  if (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'SVG') {
    points += 2;
    reasons.push('visual:media:+2');
  }

  // SVG sub-elements usually aren't meaningful targets
  if (element instanceof SVGElement && tag !== 'SVG') {
    points -= 1;
    reasons.push('visual:svg-sub:-1');
  }

  return { points, reasons };
}

/**
 * Score element based on interactivity
 */
function getInteractivityScore(
  element: Element,
  style: CSSStyleDeclaration,
): { points: number; reasons: string[] } {
  let points = 0;
  const reasons: string[] = [];

  const tag = element.tagName.toUpperCase();

  // Interactive tags
  if (INTERACTIVE_TAGS.has(tag)) {
    points += 6;
    reasons.push(`type:${tag.toLowerCase()}:+6`);
  }

  // Interactive roles
  const role = element.getAttribute('role')?.toLowerCase() ?? '';
  if (role && INTERACTIVE_ROLES.has(role)) {
    points += 4;
    reasons.push(`role:${role}:+4`);
  }

  // Anchor with href
  if (element instanceof HTMLAnchorElement && element.href) {
    points += 2;
    reasons.push('attr:href:+2');
  }

  // Content editable
  if (element instanceof HTMLElement) {
    if (element.isContentEditable) {
      points += 5;
      reasons.push('attr:contenteditable:+5');
    }

    // Focusable
    if (element.tabIndex >= 0) {
      points += 2;
      reasons.push('focusable:+2');
    }
  }

  // Pointer cursor often indicates clickability
  if (style.cursor === 'pointer') {
    points += 2;
    reasons.push('cursor:pointer:+2');
  }

  return { points, reasons };
}

/**
 * Score element based on size
 */
function getSizeScore(
  rect: DOMRectReadOnly,
  viewportArea: number,
): { points: number; reasons: string[] } {
  let points = 0;
  const reasons: string[] = [];

  const area = rect.width * rect.height;
  if (!Number.isFinite(area) || area <= 0) {
    points -= 6;
    reasons.push('size:invalid:-6');
    return { points, reasons };
  }

  // Too small: hard to interact with
  if (rect.width < 4 || rect.height < 4) {
    points -= 6;
    reasons.push('size:tiny:-6');
  } else if (area < 16 * 16) {
    points -= 4;
    reasons.push('size:small:-4');
  } else if (area < 44 * 44) {
    // Below recommended tap target size
    points -= 1;
    reasons.push('size:below-tap-target:-1');
  }

  // Too large: likely a layout container
  const ratio = viewportArea > 0 ? area / viewportArea : 0;
  if (ratio > 0.85) {
    points -= 8;
    reasons.push('size:huge:-8');
  } else if (ratio > 0.6) {
    points -= 4;
    reasons.push('size:very-large:-4');
  }

  return { points, reasons };
}

/**
 * Check if element has meaningful padding
 */
function hasMeaningfulPadding(style: CSSStyleDeclaration): boolean {
  return (
    parseNumber(style.paddingTop) > RECT_EPSILON ||
    parseNumber(style.paddingRight) > RECT_EPSILON ||
    parseNumber(style.paddingBottom) > RECT_EPSILON ||
    parseNumber(style.paddingLeft) > RECT_EPSILON
  );
}

/**
 * Check if element is a wrapper-only container
 */
function isWrapperOnly(
  element: Element,
  style: CSSStyleDeclaration,
  visualScore: number,
  interactivityScore: number,
): boolean {
  // display: contents has no box
  if (style.display === 'contents') return true;

  // Interactive elements are never pure wrappers
  if (interactivityScore > 0) return false;

  // Only check common wrapper tags
  const tag = element.tagName.toUpperCase();
  if (!WRAPPER_TAGS.has(tag)) return false;

  // Must have exactly one child element
  if (element.children.length !== 1) return false;

  // Has direct text content = meaningful
  if (hasDirectNonWhitespaceText(element)) return false;

  // Has visual boundary = meaningful
  if (visualScore > 0) return false;

  // Has padding = meaningful
  if (hasMeaningfulPadding(style)) return false;

  return true;
}

/** Metadata for candidate ordering */
interface CandidateMeta {
  hitOrder: number;
  depthFromHit: number;
}

/**
 * Compare candidate metadata for ordering
 */
function compareMeta(a: CandidateMeta, b: CandidateMeta): number {
  if (a.hitOrder !== b.hitOrder) return a.hitOrder - b.hitOrder;
  return a.depthFromHit - b.depthFromHit;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a selection engine for intelligent element picking.
 */
export function createSelectionEngine(options: SelectionEngineOptions): SelectionEngine {
  const disposer = new Disposer();
  const { isOverlayElement } = options;

  /**
   * Score a single element
   */
  function scoreElement(
    element: Element,
    styleCache: Map<Element, CSSStyleDeclaration>,
    viewportArea: number,
  ): SelectionCandidate | null {
    // Basic filters
    if (!element.isConnected) return null;
    if (isOverlayElement(element)) return null;

    const tag = element.tagName.toUpperCase();
    if (tag === 'HTML' || tag === 'BODY') return null;

    const rect = readRect(element);
    if (!rect) return null;

    // Get or cache computed style
    let style = styleCache.get(element);
    if (!style) {
      style = window.getComputedStyle(element);
      styleCache.set(element, style);
    }

    if (isEffectivelyInvisible(style, rect)) return null;

    // Calculate scores
    const reasons: string[] = [];
    let score = 0;

    const interactivity = getInteractivityScore(element, style);
    score += interactivity.points;
    reasons.push(...interactivity.reasons);

    const visual = getVisualBoundaryScore(element, style);
    score += visual.points;
    reasons.push(...visual.reasons);

    const size = getSizeScore(rect, viewportArea);
    score += size.points;
    reasons.push(...size.reasons);

    // Check wrapper-only status and penalize
    const wrapperOnly = isWrapperOnly(element, style, visual.points, interactivity.points);
    if (wrapperOnly) {
      score -= 8;
      reasons.push('wrapperOnly:-8');
    }

    // De-prioritize generic inline spans
    if (tag === 'SPAN' && interactivity.points === 0 && visual.points === 0) {
      score -= 2;
      reasons.push('inline:span:-2');
    }

    // Large fixed elements are often overlays/headers
    const area = rect.width * rect.height;
    const ratio = viewportArea > 0 ? area / viewportArea : 0;
    if (style.position === 'fixed' && ratio > 0.3) {
      score -= 2;
      reasons.push('position:fixed-large:-2');
    }

    return { element, score, reasons, wrapperOnly };
  }

  /**
   * Get all scored candidates at a point
   */
  function getCandidatesAtPoint(x: number, y: number): SelectionCandidate[] {
    const hit = getHitElementsAtPoint(x, y);
    if (hit.length === 0) return [];

    // Collect candidates with metadata
    const map = new Map<Element, CandidateMeta>();

    function addCandidate(element: Element, meta: CandidateMeta): void {
      if (isOverlayElement(element)) return;
      if (map.size >= MAX_CANDIDATES && !map.has(element)) return;

      const prev = map.get(element);
      if (!prev || compareMeta(meta, prev) < 0) {
        map.set(element, meta);
      }
    }

    // Process hit elements and their ancestors
    const limit = Math.min(hit.length, MAX_HIT_ELEMENTS);
    for (let i = 0; i < limit; i++) {
      const el = hit[i];
      addCandidate(el, { hitOrder: i, depthFromHit: 0 });

      // Traverse ancestors
      let current: Element | null = el;
      for (let depth = 1; depth <= MAX_ANCESTOR_DEPTH; depth++) {
        current = current ? getParentElementOrHost(current) : null;
        if (!current) break;
        addCandidate(current, { hitOrder: i, depthFromHit: depth });
      }
    }

    // Score all candidates
    const viewportArea = getViewportArea();
    const styleCache = new Map<Element, CSSStyleDeclaration>();

    const scored: Array<SelectionCandidate & CandidateMeta> = [];
    for (const [element, meta] of map) {
      const candidate = scoreElement(element, styleCache, viewportArea);
      if (!candidate) continue;
      scored.push({ ...candidate, ...meta });
    }

    // Sort by score (descending), then by DOM order
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return compareMeta(a, b);
    });

    // Strip metadata from result
    return scored.map(({ hitOrder: _, depthFromHit: __, ...c }) => c);
  }

  /**
   * Get a meaningful parent candidate for drill-up
   */
  function getParentCandidate(current: Element): Element | null {
    let parent = getParentElementOrHost(current);
    if (!parent) return null;

    const viewportArea = getViewportArea();
    const styleCache = new Map<Element, CSSStyleDeclaration>();

    while (parent) {
      if (isOverlayElement(parent)) return null;

      const tag = parent.tagName.toUpperCase();
      if (tag === 'HTML' || tag === 'BODY') return null;

      const rect = readRect(parent);
      if (!rect) {
        parent = getParentElementOrHost(parent);
        continue;
      }

      let style = styleCache.get(parent);
      if (!style) {
        style = window.getComputedStyle(parent);
        styleCache.set(parent, style);
      }

      if (isEffectivelyInvisible(style, rect)) {
        parent = getParentElementOrHost(parent);
        continue;
      }

      const interactivity = getInteractivityScore(parent, style);
      const visual = getVisualBoundaryScore(parent, style);

      // Return first non-wrapper parent
      if (!isWrapperOnly(parent, style, visual.points, interactivity.points)) {
        return parent;
      }

      parent = getParentElementOrHost(parent);
    }

    return null;
  }

  /**
   * Find the best target at a point with modifier support
   */
  function findBestTarget(x: number, y: number, modifiers: Modifiers): Element | null {
    const candidates = getCandidatesAtPoint(x, y);
    const best = candidates[0]?.element ?? null;
    if (!best) return null;

    // Alt modifier: drill up to parent
    if (modifiers.alt) {
      return getParentCandidate(best) ?? best;
    }

    return best;
  }

  // ===========================================================================
  // Shadow DOM (composedPath) Support - Phase 2.1
  // ===========================================================================

  /**
   * Extract Element nodes from an event's composedPath(), filtering overlay elements.
   * Returns elements ordered from innermost to outermost.
   *
   * Why composedPath?
   * - When events bubble from inside Shadow DOM, they get "retargeted" at shadow boundaries
   * - By the time a document-level listener receives the event, event.target points to the shadow host
   * - composedPath() exposes the original event path before retargeting
   */
  function getComposedPathElements(event: Event): Element[] {
    try {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
      if (!Array.isArray(path) || path.length === 0) return [];

      const elements: Element[] = [];
      for (const node of path) {
        // Skip non-Element nodes (Text, Document, Window, etc.)
        if (!(node instanceof Element)) continue;
        // Skip overlay UI elements
        if (isOverlayElement(node)) continue;
        // Skip HTML and BODY
        const tag = node.tagName.toUpperCase();
        if (tag === 'HTML' || tag === 'BODY') continue;

        elements.push(node);
      }
      return elements;
    } catch {
      // composedPath() may throw in edge cases (e.g., detached nodes)
      return [];
    }
  }

  /**
   * Extract viewport coordinates from a MouseEvent/PointerEvent.
   */
  function extractClientPoint(event: Event): { x: number; y: number } | null {
    const e = event as unknown as { clientX?: unknown; clientY?: unknown };
    const x = typeof e.clientX === 'number' ? e.clientX : Number.NaN;
    const y = typeof e.clientY === 'number' ? e.clientY : Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  /** Max elements to scan for innermost visible (performance guard) */
  const MAX_INNERMOST_SCAN = 32;

  /**
   * Find innermost visible element from composedPath (for Ctrl/Cmd + Click drill-in).
   * Returns the first element that passes visibility checks.
   * Limited to MAX_INNERMOST_SCAN elements to prevent performance issues in deep DOMs.
   */
  function findInnermostVisible(pathElements: Element[]): Element | null {
    const viewportArea = getViewportArea();
    const styleCache = new Map<Element, CSSStyleDeclaration>();
    const limit = Math.min(pathElements.length, MAX_INNERMOST_SCAN);

    for (let i = 0; i < limit; i++) {
      const element = pathElements[i];
      // scoreElement returns null for invisible/invalid elements
      const candidate = scoreElement(element, styleCache, viewportArea);
      if (candidate) return candidate.element;
    }
    return null;
  }

  /**
   * Get candidates from composedPath elements using the same scoring logic.
   * Merges with point-based candidates for comprehensive selection.
   */
  function getCandidatesFromPath(
    pathElements: Element[],
    point: { x: number; y: number } | null,
  ): SelectionCandidate[] {
    if (pathElements.length === 0 && !point) return [];

    const map = new Map<Element, CandidateMeta>();

    function addCandidate(element: Element, meta: CandidateMeta): void {
      if (isOverlayElement(element)) return;
      if (map.size >= MAX_CANDIDATES && !map.has(element)) return;

      const prev = map.get(element);
      if (!prev || compareMeta(meta, prev) < 0) {
        map.set(element, meta);
      }
    }

    // Add composedPath elements with high priority (hitOrder = 0)
    // These are the "seeds" from the actual event path
    for (let i = 0; i < pathElements.length && i < MAX_HIT_ELEMENTS; i++) {
      const el = pathElements[i];
      addCandidate(el, { hitOrder: 0, depthFromHit: i });

      // Also traverse ancestors (cross Shadow DOM boundaries)
      let current: Element | null = el;
      for (let depth = 1; depth <= MAX_ANCESTOR_DEPTH; depth++) {
        current = current ? getParentElementOrHost(current) : null;
        if (!current) break;
        addCandidate(current, { hitOrder: 0, depthFromHit: i + depth });
      }
    }

    // Merge with point-based candidates if available (for better coverage)
    if (point) {
      const hitElements = getHitElementsAtPoint(point.x, point.y);
      const limit = Math.min(hitElements.length, MAX_HIT_ELEMENTS);
      for (let i = 0; i < limit; i++) {
        const el = hitElements[i];
        // hitOrder = 1 to give composedPath elements priority in tie-breaking
        addCandidate(el, { hitOrder: 1, depthFromHit: 0 });

        let current: Element | null = el;
        for (let depth = 1; depth <= MAX_ANCESTOR_DEPTH; depth++) {
          current = current ? getParentElementOrHost(current) : null;
          if (!current) break;
          addCandidate(current, { hitOrder: 1, depthFromHit: depth });
        }
      }
    }

    // Score all candidates
    const viewportArea = getViewportArea();
    const styleCache = new Map<Element, CSSStyleDeclaration>();

    const scored: Array<SelectionCandidate & CandidateMeta> = [];
    for (const [element, meta] of map) {
      const candidate = scoreElement(element, styleCache, viewportArea);
      if (!candidate) continue;
      scored.push({ ...candidate, ...meta });
    }

    // Sort by score (descending), then by DOM order
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return compareMeta(a, b);
    });

    return scored.map(({ hitOrder: _, depthFromHit: __, ...c }) => c);
  }

  /**
   * Event-aware selection entry point (Shadow DOM support).
   *
   * Uses composedPath() to access elements inside Shadow DOM that would
   * otherwise be inaccessible due to event retargeting.
   *
   * Strategy: "Hit-first, climb-if-meaningless"
   * - Default: Select the direct hit element (what user clicked)
   * - If direct hit is wrapper-only (no visual meaning), climb to first meaningful parent
   * - This ensures clicking on boxC selects boxC, not boxA
   *
   * Modifier behavior:
   * - Ctrl/Cmd + Click: Select innermost visible element (drill-in)
   * - Alt + Click: Select parent of best target (drill-up)
   */
  function findBestTargetFromEvent(event: Event, modifiers: Modifiers): Element | null {
    const pathElements = getComposedPathElements(event);
    const point = extractClientPoint(event);

    // Ctrl/Cmd + Click: drill-in to innermost visible element
    // Takes precedence over Alt (if both pressed, drill-in wins)
    if (modifiers.ctrl || modifiers.meta) {
      const innermost = findInnermostVisible(pathElements);
      if (innermost) return innermost;
      // Fallback to point-based selection
      return point ? findBestTarget(point.x, point.y, modifiers) : null;
    }

    // Get the direct hit element (what user actually clicked)
    // Priority: composedPath[0] > elementsFromPoint[0]
    const directHit =
      pathElements[0] ?? (point ? getHitElementsAtPoint(point.x, point.y)[0] : null);

    if (!directHit) {
      // No hit at all, fallback to old scoring-based approach
      return point ? findBestTarget(point.x, point.y, modifiers) : null;
    }

    // Score the direct hit to check if it's meaningful
    const viewportArea = getViewportArea();
    const styleCache = new Map<Element, CSSStyleDeclaration>();
    const directCandidate = scoreElement(directHit, styleCache, viewportArea);

    // Determine the base target:
    // - If direct hit is valid and not a wrapper-only, use it
    // - Otherwise, climb to the first meaningful parent
    let base: Element;
    if (directCandidate && !directCandidate.wrapperOnly) {
      base = directHit;
    } else {
      // Direct hit is invalid or wrapper-only, climb to meaningful parent
      base = getParentCandidate(directHit) ?? directHit;
    }

    // Alt + Click: drill-up to parent
    if (modifiers.alt) {
      return getParentCandidate(base) ?? base;
    }

    return base;
  }

  return {
    findBestTarget,
    findBestTargetFromEvent,
    getCandidatesAtPoint,
    getParentCandidate,
    dispose: () => disposer.dispose(),
  };
}
