/**
 * HMR Consistency Verifier (Phase 4.8)
 *
 * Verifies that visual edits remain consistent after HMR (Hot Module Replacement).
 *
 * Problem: User edits → Apply to Code → Agent modifies source → HMR → DOM may change
 * Solution: After execution completes, wait for DOM to stabilize, then verify:
 * - Target element still exists (or can be re-identified)
 * - Style/text values match expectations
 *
 * Design:
 * - Quiet-window strategy: Wait until DOM mutations settle before verifying
 * - Multi-tier element resolution: current → strict → relaxed → geometric
 * - Computed style comparison (format-agnostic)
 *
 * State machine phases:
 * - idle: No active verification
 * - executing: Apply sent, waiting for Agent completion
 * - settling: Agent completed, waiting for HMR to stabilize
 * - verifying: Running verification checks
 */

import type { ElementLocator, Transaction } from '@/common/web-editor-types';
import type { ExecutionState } from './execution-tracker';
import type { TransactionChangeEvent, TransactionManager } from './transaction-manager';
import type { ToolbarStatus } from '../ui/toolbar';
import type { SelectionEngine } from '../selection/selection-engine';
import { Disposer } from '../utils/disposables';
import { computeDomPath, computeFingerprint, locateElement } from './locator';
import {
  compareComputed,
  normalizeText,
  readComputedMap,
  type CompareComputedResult,
} from './css-compare';

// =============================================================================
// Types
// =============================================================================

/** Verification phase in the state machine */
export type HmrConsistencyPhase = 'idle' | 'executing' | 'settling' | 'verifying';

/** Final outcome of verification */
export type HmrConsistencyOutcome = 'verified' | 'mismatch' | 'lost' | 'uncertain' | 'skipped';

/** Confidence level for element resolution */
export type MatchConfidence = 'high' | 'medium' | 'low';

/** Source of element resolution */
export type ResolveSource = 'current' | 'strict' | 'relaxed' | 'geometric';

/** Resolved target element with metadata */
export interface HmrResolvedTarget {
  readonly element: Element;
  readonly source: ResolveSource;
  readonly confidence: MatchConfidence;
  readonly score?: number;
}

/** Text comparison diff */
export interface HmrTextDiff {
  readonly expected: string;
  readonly actual: string;
  readonly match: boolean;
}

/** Complete verification result */
export interface HmrConsistencyResult {
  readonly outcome: HmrConsistencyOutcome;
  readonly reason?: string;
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly txId: string;
  readonly txTimestamp: number;
  readonly txType: Transaction['type'];
  readonly resolved?: Omit<HmrResolvedTarget, 'element'>;
  readonly style?: CompareComputedResult;
  readonly text?: HmrTextDiff;
  readonly signals: {
    readonly hadRelevantMutation: boolean;
    readonly hadElementDisconnect: boolean;
  };
  readonly timing: {
    readonly startedAt: number;
    readonly executionCompletedAt?: number;
    readonly finalizedAt: number;
  };
}

/** Current state snapshot */
export interface HmrConsistencySnapshot {
  readonly phase: HmrConsistencyPhase;
  readonly activeRequestId?: string;
  readonly activeTxId?: string;
  readonly lastResult: HmrConsistencyResult | null;
}

/** Arguments for starting a verification session */
export interface StartHmrConsistencyArgs {
  /** The applied transaction (style or text) */
  readonly tx: Transaction;
  /** Request ID from Agent for correlation */
  readonly requestId?: string;
  /** Agent session ID */
  readonly sessionId?: string;
  /** Element at Apply time (current selection) */
  readonly element: Element | null;
}

/** Verifier configuration options */
export interface HmrConsistencyVerifierOptions {
  /** Transaction manager for checking tx stack state */
  readonly transactionManager: TransactionManager;

  /** Get current selected element */
  readonly getSelectedElement?: () => Element | null;
  /** Called when verifier wants to reselect a resolved element */
  readonly onReselect?: (element: Element) => void;
  /** Called when verifier wants to clear selection */
  readonly onDeselect?: () => void;

  /** Set toolbar status */
  readonly setToolbarStatus?: (status: ToolbarStatus, message?: string) => void;
  /** Called when verification completes */
  readonly onResult?: (result: HmrConsistencyResult) => void;

  /** Filter for editor overlay elements */
  readonly isOverlayElement?: (node: unknown) => boolean;
  /** Selection engine for geometric fallback */
  readonly selectionEngine?: SelectionEngine;

  /** Quiet window duration (ms) - wait for mutations to settle */
  readonly quietWindowMs?: number;
  /** Maximum time to wait for HMR (ms) */
  readonly settleDeadlineMs?: number;
  /** Time after which no HMR signal means uncertain (ms) */
  readonly noSignalDeadlineMs?: number;

  /** Max elements to scan in relaxed locate */
  readonly relaxedLocateMaxElements?: number;
  /** Max candidates for geometric fallback */
  readonly geometricMaxCandidates?: number;
}

/** Public verifier interface */
export interface HmrConsistencyVerifier {
  /** Start tracking a new Apply operation */
  start(args: StartHmrConsistencyArgs): void;
  /** Handle execution status update from ExecutionTracker */
  onExecutionStatus(state: ExecutionState): void;
  /** Handle transaction change (user edit/undo/redo) */
  onTransactionChange(event: TransactionChangeEvent): void;
  /** Handle selection change */
  onSelectionChange(element: Element | null): void;
  /** Get current state snapshot */
  getSnapshot(): HmrConsistencySnapshot;
  /** Cleanup */
  dispose(): void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_QUIET_WINDOW_MS = 300;
const DEFAULT_SETTLE_DEADLINE_MS = 8000;
const DEFAULT_NO_SIGNAL_DEADLINE_MS = 2000;
const DEFAULT_RELAXED_LOCATE_MAX_ELEMENTS = 200;
const DEFAULT_GEOMETRIC_MAX_CANDIDATES = 16;

/** MutationObserver options for head (CSS changes) */
const HEAD_MUTATION_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
};

/** MutationObserver options for DOM (structure, text, and relevant attribute changes) */
const DOM_MUTATION_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'style', 'id'],
  characterData: true, // Needed for text content changes
};

// Note: 'error' is included for compatibility with AgentStatusEvent from server
const TERMINAL_EXEC_STATUSES = new Set(['completed', 'failed', 'error', 'timeout', 'cancelled']);

// Scoring thresholds for resolution confidence
const RELAXED_CONFIDENCE_THRESHOLD = 8;
const GEOMETRIC_CONFIDENCE_THRESHOLD = 6;

// =============================================================================
// Internal Session State
// =============================================================================

interface SessionState {
  readonly key: string;
  phase: HmrConsistencyPhase;

  // Correlation
  readonly requestId?: string;
  readonly sessionId?: string;

  // Transaction info
  readonly txId: string;
  readonly txTimestamp: number;
  readonly txType: Transaction['type'];
  readonly locator: ElementLocator;

  // Original state
  originalElement: Element | null;
  readonly expectedStyle: { properties: string[]; computed: Record<string, string> } | null;
  readonly expectedText: string | null;
  readonly anchorRect: DOMRect | null;
  readonly anchorCenter: { x: number; y: number } | null;

  // Timing
  startedAt: number;
  executionCompletedAt: number | null;

  // Signals
  signals: {
    hadRelevantMutation: boolean;
    hadElementDisconnect: boolean;
  };

  // Flags
  flags: {
    verifying: boolean;
    selectionChanged: boolean;
    suppressNextSelectionChange: boolean;
  };

  // Timers
  timers: {
    quietTimer: number | null;
    deadlineTimer: number | null;
    noSignalTimer: number | null;
  };

  // Resources
  readonly disposer: Disposer;
}

// =============================================================================
// Helpers
// =============================================================================

function safeReadRect(element: Element): DOMRect | null {
  try {
    const r = element.getBoundingClientRect();
    if (!Number.isFinite(r.left) || !Number.isFinite(r.top)) return null;
    if (!Number.isFinite(r.width) || !Number.isFinite(r.height)) return null;
    return r;
  } catch {
    return null;
  }
}

function rectCenter(rect: DOMRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function safeElementsFromPoint(x: number, y: number): Element[] {
  try {
    const els = document.elementsFromPoint(x, y);
    return Array.isArray(els) ? els.filter((e): e is Element => e instanceof Element) : [];
  } catch {
    try {
      const el = document.elementFromPoint(x, y);
      return el ? [el] : [];
    } catch {
      return [];
    }
  }
}

function safeQuerySelectorAll(root: ParentNode, selector: string, maxCount: number): Element[] {
  try {
    const list = root.querySelectorAll(selector);
    const out: Element[] = [];
    const limit = Math.min(maxCount, list.length);
    for (let i = 0; i < limit; i++) out.push(list[i]!);
    return out;
  } catch {
    return [];
  }
}

function isHtmlOrBody(element: Element): boolean {
  const tag = element.tagName?.toUpperCase?.() ?? '';
  return tag === 'HTML' || tag === 'BODY';
}

function isValidCandidate(
  element: Element,
  isOverlayElement?: (node: unknown) => boolean,
): boolean {
  if (!element.isConnected) return false;
  if (isHtmlOrBody(element)) return false;
  if (isOverlayElement?.(element)) return false;
  return true;
}

/** Parsed fingerprint structure */
interface ParsedFingerprint {
  tag: string;
  id?: string;
  classes: string[];
  text?: string;
}

function parseFingerprint(raw: string): ParsedFingerprint {
  const parts = String(raw ?? '')
    .trim()
    .split('|')
    .filter(Boolean);
  const tag = parts[0] || 'unknown';

  let id: string | undefined;
  let classes: string[] = [];
  let text: string | undefined;

  for (const part of parts.slice(1)) {
    if (part.startsWith('id=')) id = part.slice(3) || undefined;
    else if (part.startsWith('class=')) classes = part.slice(6).split('.').filter(Boolean);
    else if (part.startsWith('text=')) text = part.slice(5) || undefined;
  }

  return { tag, id, classes, text };
}

function intersectCount(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const set = new Set(b);
  return a.filter((item) => set.has(item)).length;
}

function commonPrefixLength(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** Score an element candidate against expected fingerprint */
function scoreCandidate(params: {
  element: Element;
  expected: ParsedFingerprint;
  locator: ElementLocator;
  anchorCenter?: { x: number; y: number } | null;
}): number {
  const { element, expected, locator, anchorCenter } = params;
  const candidateFp = parseFingerprint(computeFingerprint(element));

  // Tag must match
  if (candidateFp.tag !== expected.tag) return -Infinity;

  // ID must match if expected has one
  if (expected.id && candidateFp.id !== expected.id) return -Infinity;

  let score = 0;

  // Strong ID anchor
  if (expected.id) score += 12;

  // Class overlap (soft match)
  score += Math.min(8, intersectCount(expected.classes, candidateFp.classes) * 2);

  // Text hint (soft match)
  if (expected.text) {
    const expectedText = normalizeText(expected.text);
    const actualText = normalizeText(element.textContent ?? '');
    if (actualText.includes(expectedText)) score += 4;
  }

  // DOM path similarity
  if (locator.path?.length) {
    const path = computeDomPath(element);
    const prefix = commonPrefixLength(locator.path, path);
    score += (prefix / locator.path.length) * 6;
    if (prefix === locator.path.length && path.length === locator.path.length) score += 2;
  }

  // Geometry similarity
  if (anchorCenter && Number.isFinite(anchorCenter.x)) {
    const rect = safeReadRect(element);
    if (rect) {
      const c = rectCenter(rect);
      const dist = Math.hypot(c.x - anchorCenter.x, c.y - anchorCenter.y);
      score += Math.max(0, 6 - dist / 50);
    }
  }

  return score;
}

/** Relaxed locate: scan selectors without uniqueness constraint, score candidates */
function relaxedLocate(params: {
  locator: ElementLocator;
  expected: ParsedFingerprint;
  isOverlayElement?: (node: unknown) => boolean;
  maxElements: number;
  anchorCenter?: { x: number; y: number } | null;
}): { element: Element; score: number } | null {
  const { locator, expected, isOverlayElement, maxElements, anchorCenter } = params;

  let best: { element: Element; score: number } | null = null;
  let scanned = 0;

  // Fast-path: ID anchor
  if (expected.id) {
    const byId = document.getElementById(expected.id);
    if (byId && isValidCandidate(byId, isOverlayElement)) {
      const score = scoreCandidate({ element: byId, expected, locator, anchorCenter });
      if (Number.isFinite(score)) best = { element: byId, score };
    }
  }

  // Try each selector (may return multiple matches)
  for (const selector of locator.selectors ?? []) {
    if (scanned >= maxElements) break;
    const remaining = maxElements - scanned;
    if (remaining <= 0) break;

    const elements = safeQuerySelectorAll(document, selector, remaining);
    for (const element of elements) {
      scanned++;
      if (!isValidCandidate(element, isOverlayElement)) continue;

      const score = scoreCandidate({ element, expected, locator, anchorCenter });
      if (!Number.isFinite(score)) continue;

      if (!best || score > best.score) {
        best = { element, score };
      }
    }
  }

  return best;
}

/** Geometric locate: find elements at anchor point and score them */
function geometricLocate(params: {
  expected: ParsedFingerprint;
  locator: ElementLocator;
  anchorCenter: { x: number; y: number };
  isOverlayElement?: (node: unknown) => boolean;
  selectionEngine?: SelectionEngine;
  maxCandidates: number;
}): { element: Element; score: number } | null {
  const { expected, locator, anchorCenter, isOverlayElement, selectionEngine, maxCandidates } =
    params;

  const candidates: Element[] = [];

  // Try selection engine first (has smarter candidate ranking)
  if (selectionEngine) {
    try {
      for (const c of selectionEngine.getCandidatesAtPoint(anchorCenter.x, anchorCenter.y)) {
        candidates.push(c.element);
        if (candidates.length >= maxCandidates) break;
      }
    } catch {
      // Fall through to elementsFromPoint
    }
  }

  // Fallback to elementsFromPoint
  if (candidates.length === 0) {
    for (const el of safeElementsFromPoint(anchorCenter.x, anchorCenter.y)) {
      candidates.push(el);
      if (candidates.length >= maxCandidates) break;
    }
  }

  let best: { element: Element; score: number } | null = null;
  const seen = new Set<Element>();

  for (const element of candidates) {
    if (seen.has(element)) continue;
    seen.add(element);

    if (!isValidCandidate(element, isOverlayElement)) continue;
    const score = scoreCandidate({ element, expected, locator, anchorCenter });
    if (!Number.isFinite(score)) continue;

    if (!best || score > best.score) best = { element, score };
  }

  return best;
}

/** Collect style properties from a transaction */
function collectStyleProperties(tx: Transaction): string[] {
  const set = new Set<string>();
  for (const key of Object.keys(tx.before.styles ?? {})) set.add(key);
  for (const key of Object.keys(tx.after.styles ?? {})) set.add(key);
  return Array.from(set).filter(Boolean);
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an HMR Consistency Verifier.
 *
 * Usage:
 * 1. Call `start()` when Apply succeeds
 * 2. Forward `ExecutionTracker.onStatusChange` to `onExecutionStatus()`
 * 3. Forward `TransactionManager.onChange` to `onTransactionChange()`
 * 4. Forward selection changes to `onSelectionChange()`
 * 5. Results are emitted via `options.onResult` callback
 */
export function createHmrConsistencyVerifier(
  options: HmrConsistencyVerifierOptions,
): HmrConsistencyVerifier {
  const disposer = new Disposer();
  const now = () => Date.now();

  // Configuration
  const quietWindowMs = Math.max(0, options.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS);
  const settleDeadlineMs = Math.max(0, options.settleDeadlineMs ?? DEFAULT_SETTLE_DEADLINE_MS);
  const noSignalDeadlineMs = Math.max(
    0,
    options.noSignalDeadlineMs ?? DEFAULT_NO_SIGNAL_DEADLINE_MS,
  );
  const relaxedLocateMaxElements = Math.max(
    1,
    options.relaxedLocateMaxElements ?? DEFAULT_RELAXED_LOCATE_MAX_ELEMENTS,
  );
  const geometricMaxCandidates = Math.max(
    1,
    options.geometricMaxCandidates ?? DEFAULT_GEOMETRIC_MAX_CANDIDATES,
  );

  // State
  let sessionSeq = 0;
  let active: SessionState | null = null;
  let lastResult: HmrConsistencyResult | null = null;

  // Cleanup on dispose
  disposer.add(() => finalizeActive('skipped', 'disposed'));

  // ==========================================================================
  // Utilities
  // ==========================================================================

  function setToolbar(status: ToolbarStatus, message?: string): void {
    options.setToolbarStatus?.(status, message);
  }

  function buildResult(
    session: SessionState | null,
    params: {
      outcome: HmrConsistencyOutcome;
      reason?: string;
      resolved?: Omit<HmrResolvedTarget, 'element'>;
      style?: CompareComputedResult;
      text?: HmrTextDiff;
    },
  ): HmrConsistencyResult {
    const finalizedAt = now();
    return {
      outcome: params.outcome,
      reason: params.reason,
      requestId: session?.requestId,
      sessionId: session?.sessionId,
      txId: session?.txId ?? '',
      txTimestamp: session?.txTimestamp ?? 0,
      txType: session?.txType ?? 'style',
      resolved: params.resolved,
      style: params.style,
      text: params.text,
      signals: {
        hadRelevantMutation: session?.signals.hadRelevantMutation ?? false,
        hadElementDisconnect: session?.signals.hadElementDisconnect ?? false,
      },
      timing: {
        startedAt: session?.startedAt ?? finalizedAt,
        executionCompletedAt: session?.executionCompletedAt ?? undefined,
        finalizedAt,
      },
    };
  }

  function emitAndStore(result: HmrConsistencyResult): void {
    lastResult = result;
    options.onResult?.(result);
  }

  function clearTimers(s: SessionState): void {
    if (s.timers.quietTimer !== null) {
      window.clearTimeout(s.timers.quietTimer);
      s.timers.quietTimer = null;
    }
    if (s.timers.deadlineTimer !== null) {
      window.clearTimeout(s.timers.deadlineTimer);
      s.timers.deadlineTimer = null;
    }
    if (s.timers.noSignalTimer !== null) {
      window.clearTimeout(s.timers.noSignalTimer);
      s.timers.noSignalTimer = null;
    }
  }

  function finalizeActive(
    outcome: HmrConsistencyOutcome,
    reason?: string,
    extra?: {
      resolved?: Omit<HmrResolvedTarget, 'element'>;
      style?: CompareComputedResult;
      text?: HmrTextDiff;
      toolbar?: { status: ToolbarStatus; message?: string } | null;
    },
  ): void {
    const s = active;
    if (!s) return;

    // Build result BEFORE clearing session state
    const result = buildResult(s, {
      outcome,
      reason,
      resolved: extra?.resolved,
      style: extra?.style,
      text: extra?.text,
    });

    clearTimers(s);
    s.disposer.dispose();
    active = null;

    // Only reset toolbar if verifier had taken control (settling/verifying phase)
    // Otherwise let the original status remain (e.g., failed/timeout from execution)
    const hadTakenControl = s.phase === 'settling' || s.phase === 'verifying';
    if (extra?.toolbar) {
      setToolbar(extra.toolbar.status, extra.toolbar.message);
    } else if (outcome === 'skipped' && hadTakenControl) {
      setToolbar('idle');
    }

    emitAndStore(result);
  }

  function isLatestTxStillSame(txId: string, txTimestamp: number): boolean {
    try {
      const undo = options.transactionManager.getUndoStack();
      if (undo.length === 0) return false;
      const latest = undo[undo.length - 1]!;
      return latest.id === txId && latest.timestamp === txTimestamp;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // DOM Observation
  // ==========================================================================

  function isMutationFromOverlay(record: MutationRecord): boolean {
    if (!options.isOverlayElement) return false;

    const t = record.target;
    if (t instanceof Element && options.isOverlayElement(t)) return true;

    if (record.type === 'childList') {
      const nodes = [...record.addedNodes, ...record.removedNodes];
      return nodes.some((n) => n instanceof Element && options.isOverlayElement?.(n));
    }

    return false;
  }

  function isDomMutationRelevant(record: MutationRecord, target: Element | null): boolean {
    if (!target) return false;
    if (isMutationFromOverlay(record)) return false;

    const recTarget = record.target;

    // Handle characterData mutations (text node changes)
    if (record.type === 'characterData') {
      if (recTarget instanceof Text) {
        const parent = recTarget.parentElement;
        if (parent && (parent === target || parent.contains(target) || target.contains(parent))) {
          return true;
        }
      }
      return false;
    }

    if (!(recTarget instanceof Element)) return false;

    if (record.type === 'attributes') {
      try {
        return recTarget === target || recTarget.contains(target) || target.contains(recTarget);
      } catch {
        return false;
      }
    }

    if (record.type === 'childList') {
      try {
        if (recTarget === target || recTarget.contains(target) || target.contains(recTarget))
          return true;
      } catch {
        // Fall through
      }

      // Check if target itself or any ancestor of target was removed
      for (const n of record.removedNodes) {
        if (n === target) return true;
        // Check if removed node contains target (ancestor removal)
        if (n instanceof Element) {
          try {
            if (n.contains(target)) return true;
          } catch {
            // Fall through
          }
        }
      }
    }

    return false;
  }

  function scheduleVerify(s: SessionState, reason: string): void {
    if (s.disposer.isDisposed) return;
    if (s.phase !== 'settling') return;

    if (s.timers.quietTimer !== null) {
      window.clearTimeout(s.timers.quietTimer);
      s.timers.quietTimer = null;
    }

    s.timers.quietTimer = window.setTimeout(() => {
      s.timers.quietTimer = null;
      void runVerify(`quiet:${reason}`);
    }, quietWindowMs);
  }

  function markMutationSignal(s: SessionState): void {
    s.signals.hadRelevantMutation = true;
    scheduleVerify(s, 'mutation');
  }

  function enterSettling(s: SessionState): void {
    if (s.disposer.isDisposed) return;
    if (s.phase === 'settling' || s.phase === 'verifying') return;

    s.phase = 'settling';
    s.executionCompletedAt = now();
    setToolbar('verifying', 'Waiting for HMR…');

    // Observe head for CSS injection
    const head = document.head;
    if (head) {
      s.disposer.observeMutation(
        head,
        () => {
          if (active?.key !== s.key || active.phase !== 'settling') return;
          markMutationSignal(active);
        },
        HEAD_MUTATION_OPTIONS,
      );
    }

    // Observe DOM for structure changes
    const targetRootNode = s.originalElement?.getRootNode?.();
    const domTarget =
      targetRootNode instanceof ShadowRoot
        ? targetRootNode
        : (document.body ?? document.documentElement);

    if (domTarget) {
      s.disposer.observeMutation(
        domTarget,
        (records) => {
          if (active?.key !== s.key || active.phase !== 'settling') return;

          // Mark disconnect signal
          const el = active.originalElement;
          if (el && !el.isConnected) active.signals.hadElementDisconnect = true;

          // Filter for relevant mutations
          if (records.some((r) => isDomMutationRelevant(r, el))) {
            markMutationSignal(active);
          }
        },
        DOM_MUTATION_OPTIONS,
      );
    }

    // Deadline timer
    s.timers.deadlineTimer = window.setTimeout(() => {
      if (active?.key !== s.key) return;
      finalizeActive('uncertain', 'timeout waiting for HMR', {
        toolbar: { status: 'uncertain', message: 'Uncertain (timeout)' },
      });
    }, settleDeadlineMs);

    // No-signal timer
    s.timers.noSignalTimer = window.setTimeout(() => {
      if (active?.key !== s.key || active.phase !== 'settling') return;
      void runVerify('no_signal');
    }, noSignalDeadlineMs);

    // Initial verification attempt
    scheduleVerify(s, 'initial');
  }

  // ==========================================================================
  // Element Resolution
  // ==========================================================================

  function resolveTarget(s: SessionState): HmrResolvedTarget | null {
    const isOvl = options.isOverlayElement;

    // 1. Current element (cheapest)
    const current = s.originalElement;
    if (current && isValidCandidate(current, isOvl)) {
      return { element: current, source: 'current', confidence: 'high' };
    }

    // 2. Strict locate (unique selector + fingerprint)
    const strict = locateElement(s.locator);
    if (strict && isValidCandidate(strict, isOvl)) {
      return { element: strict, source: 'strict', confidence: 'high' };
    }

    // 3. Relaxed locate (non-unique + scoring)
    const expected = parseFingerprint(s.locator.fingerprint);
    const relaxedBest = relaxedLocate({
      locator: s.locator,
      expected,
      isOverlayElement: isOvl,
      maxElements: relaxedLocateMaxElements,
      anchorCenter: s.anchorCenter,
    });

    if (relaxedBest && isValidCandidate(relaxedBest.element, isOvl)) {
      if (relaxedBest.score >= RELAXED_CONFIDENCE_THRESHOLD) {
        return {
          element: relaxedBest.element,
          source: 'relaxed',
          confidence: 'medium',
          score: relaxedBest.score,
        };
      }
    }

    // 4. Geometric fallback (point-based)
    if (s.anchorCenter) {
      const geoBest = geometricLocate({
        expected,
        locator: s.locator,
        anchorCenter: s.anchorCenter,
        isOverlayElement: isOvl,
        selectionEngine: options.selectionEngine,
        maxCandidates: geometricMaxCandidates,
      });

      if (geoBest && isValidCandidate(geoBest.element, isOvl)) {
        if (geoBest.score >= GEOMETRIC_CONFIDENCE_THRESHOLD) {
          return {
            element: geoBest.element,
            source: 'geometric',
            confidence: 'low',
            score: geoBest.score,
          };
        }
      }
    }

    return null;
  }

  function maybeReselect(s: SessionState, element: Element): void {
    if (!options.onReselect) return;
    const selected = options.getSelectedElement?.() ?? null;
    if (selected === element) return;

    s.flags.suppressNextSelectionChange = true;
    options.onReselect(element);
  }

  // ==========================================================================
  // Verification
  // ==========================================================================

  function verifyStyle(
    s: SessionState,
    element: Element,
  ): { ok: boolean; style?: CompareComputedResult } {
    const spec = s.expectedStyle;
    if (!spec?.computed) return { ok: false };

    const actual = readComputedMap(element, spec.properties);
    const result = compareComputed(spec.computed, actual);
    return { ok: true, style: result };
  }

  function verifyText(s: SessionState, element: Element): { ok: boolean; text?: HmrTextDiff } {
    const expected = s.expectedText;
    if (expected === null) return { ok: false };
    const actual = normalizeText(element.textContent ?? '');
    return { ok: true, text: { expected, actual, match: expected === actual } };
  }

  async function runVerify(trigger: string): Promise<void> {
    const s = active;
    if (!s || s.disposer.isDisposed || s.phase !== 'settling' || s.flags.verifying) return;

    s.flags.verifying = true;
    s.phase = 'verifying';
    setToolbar('verifying', 'Verifying…');

    try {
      // Check if tx still valid
      if (!isLatestTxStillSame(s.txId, s.txTimestamp)) {
        finalizeActive('skipped', 'skipped: new edits detected');
        return;
      }

      // Check if selection changed
      if (s.flags.selectionChanged) {
        finalizeActive('skipped', 'skipped: selection changed');
        return;
      }

      // Update disconnect signal
      if (s.originalElement && !s.originalElement.isConnected) {
        s.signals.hadElementDisconnect = true;
      }

      // Resolve target
      const resolved = resolveTarget(s);
      if (!resolved) {
        finalizeActive('lost', `lost: unable to locate target (${trigger})`, {
          toolbar: { status: 'lost', message: 'Target lost' },
        });
        return;
      }

      maybeReselect(s, resolved.element);

      const resolvedMeta = {
        source: resolved.source,
        confidence: resolved.confidence,
        score: resolved.score,
      };
      const hasHmrSignal = s.signals.hadRelevantMutation || s.signals.hadElementDisconnect;

      // Low confidence resolution (geometric) should only produce uncertain results
      // to avoid false positives/negatives from wrong element identification
      if (resolved.confidence === 'low') {
        finalizeActive('uncertain', `uncertain: low confidence resolution (${resolved.source})`, {
          resolved: resolvedMeta,
          toolbar: { status: 'uncertain', message: 'Uncertain (low confidence)' },
        });
        return;
      }

      // Verify based on transaction type
      if (s.txType === 'style') {
        const check = verifyStyle(s, resolved.element);
        if (!check.ok || !check.style) {
          finalizeActive('uncertain', 'uncertain: missing computed baseline', {
            resolved: resolvedMeta,
            toolbar: { status: 'uncertain', message: 'Uncertain (no baseline)' },
          });
          return;
        }

        const mismatches = check.style.diffs.filter((d) => !d.match);
        if (mismatches.length > 0) {
          finalizeActive('mismatch', `mismatch: ${mismatches.length} property mismatch`, {
            resolved: resolvedMeta,
            style: check.style,
            toolbar: { status: 'mismatch', message: `Mismatch (${mismatches.length})` },
          });
          return;
        }

        if (!hasHmrSignal) {
          finalizeActive('uncertain', 'uncertain: no HMR signal observed', {
            resolved: resolvedMeta,
            style: check.style,
            toolbar: { status: 'uncertain', message: 'Uncertain (no HMR signal)' },
          });
          return;
        }

        finalizeActive('verified', 'verified', {
          resolved: resolvedMeta,
          style: check.style,
          toolbar: { status: 'verified', message: 'Verified' },
        });
        return;
      }

      if (s.txType === 'text') {
        const check = verifyText(s, resolved.element);
        if (!check.ok || !check.text) {
          finalizeActive('uncertain', 'uncertain: missing text baseline', {
            resolved: resolvedMeta,
            toolbar: { status: 'uncertain', message: 'Uncertain (no baseline)' },
          });
          return;
        }

        if (!check.text.match) {
          finalizeActive('mismatch', 'mismatch: text differs from expected', {
            resolved: resolvedMeta,
            text: check.text,
            toolbar: { status: 'mismatch', message: 'Mismatch (text)' },
          });
          return;
        }

        if (!hasHmrSignal) {
          finalizeActive('uncertain', 'uncertain: no HMR signal observed', {
            resolved: resolvedMeta,
            text: check.text,
            toolbar: { status: 'uncertain', message: 'Uncertain (no HMR signal)' },
          });
          return;
        }

        finalizeActive('verified', 'verified', {
          resolved: resolvedMeta,
          text: check.text,
          toolbar: { status: 'verified', message: 'Verified' },
        });
        return;
      }

      // Unsupported tx type
      finalizeActive('skipped', `skipped: tx type "${s.txType}" not supported`);
    } finally {
      if (active?.key === s.key) {
        active.flags.verifying = false;
      }
    }
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  function start(args: StartHmrConsistencyArgs): void {
    const { tx, requestId, sessionId, element } = args;

    // Only verify style and text transactions
    if (tx.type !== 'style' && tx.type !== 'text') return;

    // Supersede existing session
    finalizeActive('skipped', 'skipped: superseded by new apply');

    const key = `hmr_${now().toString(36)}_${(++sessionSeq).toString(36)}`;
    const sessionDisposer = new Disposer();
    const el = element?.isConnected ? element : null;

    const anchorRect = el ? safeReadRect(el) : null;
    const anchorCenter = anchorRect ? rectCenter(anchorRect) : null;

    let expectedStyle: SessionState['expectedStyle'] = null;
    let expectedText: SessionState['expectedText'] = null;

    if (tx.type === 'style') {
      const properties = collectStyleProperties(tx);
      const computed = el ? readComputedMap(el, properties) : null;
      expectedStyle = computed ? { properties, computed } : null;
    } else if (tx.type === 'text') {
      const baseline = el ? (el.textContent ?? '') : (tx.after.text ?? '');
      expectedText = normalizeText(baseline);
    }

    active = {
      key,
      phase: 'executing',
      requestId: requestId?.trim() || undefined,
      sessionId: sessionId?.trim() || undefined,
      txId: tx.id,
      txTimestamp: tx.timestamp,
      txType: tx.type,
      locator: tx.targetLocator,
      originalElement: el,
      expectedStyle,
      expectedText,
      anchorRect,
      anchorCenter,
      startedAt: now(),
      executionCompletedAt: null,
      signals: { hadRelevantMutation: false, hadElementDisconnect: false },
      flags: { verifying: false, selectionChanged: false, suppressNextSelectionChange: false },
      timers: { quietTimer: null, deadlineTimer: null, noSignalTimer: null },
      disposer: sessionDisposer,
    };

    // If tx already changed, skip immediately
    if (!isLatestTxStillSame(tx.id, tx.timestamp)) {
      finalizeActive('skipped', 'skipped: transaction no longer latest');
    }
  }

  function onExecutionStatus(state: ExecutionState): void {
    const s = active;
    if (!s || s.disposer.isDisposed) return;

    // Correlate by requestId
    if (s.requestId && state.requestId !== s.requestId) return;

    if (!TERMINAL_EXEC_STATUSES.has(state.status)) return;

    if (state.status === 'completed') {
      enterSettling(s);
    } else {
      finalizeActive('skipped', `skipped: execution ${state.status}`);
    }
  }

  function onTransactionChange(_event: TransactionChangeEvent): void {
    const s = active;
    if (!s || s.disposer.isDisposed) return;

    if (!isLatestTxStillSame(s.txId, s.txTimestamp)) {
      finalizeActive('skipped', 'skipped: new edits detected');
    }
  }

  function onSelectionChange(element: Element | null): void {
    const s = active;
    if (!s || s.disposer.isDisposed) return;

    if (s.flags.suppressNextSelectionChange) {
      s.flags.suppressNextSelectionChange = false;
      return;
    }

    const expected = s.originalElement;

    // Handle deselection (null) - user cleared selection
    if (element === null && expected) {
      s.flags.selectionChanged = true;
      finalizeActive('skipped', 'skipped: selection cleared');
      return;
    }

    // Handle selection change to different element
    if (expected && element && element !== expected) {
      s.flags.selectionChanged = true;
      finalizeActive('skipped', 'skipped: selection changed');
    }
  }

  function getSnapshot(): HmrConsistencySnapshot {
    const s = active;
    return {
      phase: s?.phase ?? 'idle',
      activeRequestId: s?.requestId,
      activeTxId: s?.txId,
      lastResult,
    };
  }

  function dispose(): void {
    disposer.dispose();
    setToolbar('idle');
  }

  return {
    start,
    onExecutionStatus,
    onTransactionChange,
    onSelectionChange,
    getSnapshot,
    dispose,
  };
}
