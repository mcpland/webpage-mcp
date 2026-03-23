/**
 * Transaction Aggregator (Phase 1.3)
 *
 * Aggregates undo-stack transactions by element for AgentChat integration.
 *
 * Responsibilities:
 * - Group transactions by stable elementKey (fallback: locatorKey for legacy txs)
 * - Compute net effect (first before -> last after) for style/text/class operations
 * - Produce ElementChangeSummary for UI chips + batch Apply prompt building
 */

import type {
  ElementChangeSummary,
  ElementChangeType,
  ElementLocator,
  NetEffectPayload,
  Transaction,
  WebEditorElementKey,
} from '../../../common/web-editor-types';

import { generateElementLabel, generateFullElementLabel } from './element-key';
import { locateElement, locatorKey } from './locator';

// =============================================================================
// Constants
// =============================================================================

/** Maximum length for text preview in UI */
const TEXT_PREVIEW_MAX_LENGTH = 96;

/** Maximum length for fallback labels */
const FALLBACK_LABEL_MAX_LENGTH = 64;

/** Transaction types that can be applied to Agent */
const APPLICABLE_TX_TYPES = new Set(['style', 'text', 'class']);

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Normalize a key string value
 */
function normalizeKey(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Normalize a style property value
 */
function normalizeStyleValue(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Normalize text for preview display
 */
function normalizePreviewText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Truncate string with ellipsis
 */
function truncate(value: unknown, maxLength: number): string {
  const str = String(value ?? '');
  if (str.length <= maxLength) return str;
  return str.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…';
}

/**
 * Normalize and dedupe a class list
 */
function normalizeClassList(input: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of input ?? []) {
    const token = String(raw ?? '').trim();
    if (!token) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }

  return out;
}

/**
 * Safely locate an element from a locator
 */
function safeLocateElement(locator: ElementLocator): Element | null {
  if (typeof document === 'undefined') return null;
  try {
    return locateElement(locator);
  } catch {
    return null;
  }
}

/**
 * Build fallback labels when element cannot be located
 */
function buildFallbackLabels(
  locator: ElementLocator,
  elementKey: WebEditorElementKey,
): { label: string; fullLabel: string } {
  let label = '';

  // Try to extract label from fingerprint
  const fingerprint = normalizeKey(locator.fingerprint);
  if (fingerprint) {
    const parts = fingerprint
      .split('|')
      .map((p) => p.trim())
      .filter(Boolean);
    const tag = parts[0] ?? 'element';
    const idPart = parts.find((p) => p.startsWith('id='));
    const id = idPart ? idPart.slice('id='.length).trim() : '';
    label = id ? `${tag}#${id}` : tag;
  } else if (Array.isArray(locator.selectors) && locator.selectors.length > 0) {
    // Fallback to first selector
    label = truncate(normalizeKey(locator.selectors[0]), FALLBACK_LABEL_MAX_LENGTH) || 'element';
  } else {
    // Last resort: use element key
    label = truncate(elementKey, FALLBACK_LABEL_MAX_LENGTH) || 'element';
  }

  // Build full label with context
  const prefixParts: string[] = [];
  const frame = (locator.frameChain ?? []).join('>').trim();
  const shadow = (locator.shadowHostChain ?? []).join('>').trim();
  if (frame) prefixParts.push(frame);
  if (shadow) prefixParts.push(shadow);

  const fullLabel = prefixParts.length ? `${prefixParts.join('>')} >> ${label}` : label;

  return { label, fullLabel };
}

/**
 * Resolve labels for an element (live DOM lookup with fallback)
 */
function resolveLabels(
  locator: ElementLocator,
  elementKey: WebEditorElementKey,
): { label: string; fullLabel: string } {
  const element = safeLocateElement(locator);
  if (!element) return buildFallbackLabels(locator, elementKey);

  return {
    label: generateElementLabel(element),
    fullLabel: generateFullElementLabel(element, locator.shadowHostChain),
  };
}

/**
 * Infer the change type from what operations are present
 */
function inferChangeType(
  hasStyle: boolean,
  hasText: boolean,
  hasClass: boolean,
): ElementChangeType {
  const count = Number(hasStyle) + Number(hasText) + Number(hasClass);
  if (count > 1) return 'mixed';
  if (hasStyle) return 'style';
  if (hasText) return 'text';
  if (hasClass) return 'class';
  return 'mixed';
}

// =============================================================================
// Net Effect Computation
// =============================================================================

interface StyleNetEffect {
  before: Record<string, string>;
  after: Record<string, string>;
  added: number;
  removed: number;
  modified: number;
  details: string[];
}

/**
 * Compute net style effect from multiple style transactions
 */
function computeStyleNetEffect(txs: readonly Transaction[]): StyleNetEffect | null {
  // Track first "before" and last "after" for each property
  const firstBeforeByProp = new Map<string, string>();
  const lastAfterByProp = new Map<string, string>();

  for (const tx of txs) {
    if (tx.type !== 'style') continue;

    const beforeRaw = tx.before.styles ?? {};
    const afterRaw = tx.after.styles ?? {};

    const keys = new Set([...Object.keys(beforeRaw), ...Object.keys(afterRaw)]);
    for (const rawProp of keys) {
      const prop = String(rawProp ?? '').trim();
      if (!prop) continue;

      const b = normalizeStyleValue(beforeRaw[prop]);
      const a = normalizeStyleValue(afterRaw[prop]);

      // Record first seen "before" value
      if (!firstBeforeByProp.has(prop)) {
        firstBeforeByProp.set(prop, b);
      }
      // Always update to latest "after" value
      lastAfterByProp.set(prop, a);
    }
  }

  if (firstBeforeByProp.size === 0 && lastAfterByProp.size === 0) {
    return null;
  }

  // Build net effect (only include properties that actually changed)
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};

  const allProps = new Set([...firstBeforeByProp.keys(), ...lastAfterByProp.keys()]);

  for (const prop of allProps) {
    const b = firstBeforeByProp.get(prop) ?? '';
    const a = lastAfterByProp.get(prop) ?? '';
    if (b === a) continue; // No net change
    before[prop] = b;
    after[prop] = a;
  }

  const changedProps = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();

  if (changedProps.length === 0) return null;

  // Compute statistics
  let added = 0;
  let removed = 0;
  let modified = 0;

  for (const prop of changedProps) {
    const b = normalizeStyleValue(before[prop]);
    const a = normalizeStyleValue(after[prop]);

    if (!b && a) added += 1;
    else if (b && !a) removed += 1;
    else modified += 1;
  }

  return { before, after, added, removed, modified, details: changedProps };
}

interface TextNetEffect {
  before: string;
  after: string;
  beforePreview: string;
  afterPreview: string;
}

/**
 * Compute net text effect from multiple text transactions
 */
function computeTextNetEffect(txs: readonly Transaction[]): TextNetEffect | null {
  let before: string | undefined;
  let after: string | undefined;

  for (const tx of txs) {
    if (tx.type !== 'text') continue;
    if (before === undefined) {
      before = String(tx.before.text ?? '');
    }
    after = String(tx.after.text ?? '');
  }

  if (before === undefined || after === undefined) return null;
  if (before === after) return null;

  const beforePreview = truncate(normalizePreviewText(before), TEXT_PREVIEW_MAX_LENGTH);
  const afterPreview = truncate(normalizePreviewText(after), TEXT_PREVIEW_MAX_LENGTH);

  return { before, after, beforePreview, afterPreview };
}

interface ClassNetEffect {
  before: string[];
  after: string[];
  added: string[];
  removed: string[];
}

/**
 * Compute net class effect from multiple class transactions
 */
function computeClassNetEffect(txs: readonly Transaction[]): ClassNetEffect | null {
  let beforeRaw: string[] | undefined;
  let afterRaw: string[] | undefined;

  for (const tx of txs) {
    if (tx.type !== 'class') continue;
    if (!beforeRaw) {
      beforeRaw = normalizeClassList(tx.before.classes);
    }
    afterRaw = normalizeClassList(tx.after.classes);
  }

  if (!beforeRaw || !afterRaw) return null;

  const beforeSet = new Set(beforeRaw);
  const afterSet = new Set(afterRaw);

  const added = Array.from(afterSet)
    .filter((c) => !beforeSet.has(c))
    .sort();
  const removed = Array.from(beforeSet)
    .filter((c) => !afterSet.has(c))
    .sort();

  if (added.length === 0 && removed.length === 0) return null;

  const before = Array.from(beforeSet).sort();
  const after = Array.from(afterSet).sort();

  return { before, after, added, removed };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Aggregate transactions by element key and compute net effect summaries.
 *
 * @param transactions - Array of transactions (typically the undo stack)
 * @returns Array of element change summaries, sorted by most recent first
 *
 * Notes:
 * - Input is expected to be an undo stack (chronological), but this function
 *   sorts by timestamp to ensure deterministic results.
 * - For legacy transactions without elementKey, locatorKey(targetLocator) is
 *   used as a fallback. This may cause grouping issues when selectors change.
 * - Only applicable transaction types (style/text/class) are included in output.
 * - Elements with no net effect (changes that cancel out) are filtered.
 */
export function aggregateTransactionsByElement(
  transactions: readonly Transaction[],
): ElementChangeSummary[] {
  // Sort by timestamp for deterministic results
  const indexed = transactions.map((tx, index) => ({ tx, index }));
  indexed.sort((a, b) => {
    const at = Number(a.tx.timestamp ?? 0);
    const bt = Number(b.tx.timestamp ?? 0);
    if (at !== bt) return at - bt;
    return a.index - b.index; // Preserve original order for same timestamp
  });

  // Group transactions by element key
  const groups = new Map<WebEditorElementKey, Transaction[]>();

  for (const { tx } of indexed) {
    // Skip non-applicable transaction types
    if (!APPLICABLE_TX_TYPES.has(tx.type)) continue;

    const rawElementKey = normalizeKey(tx.elementKey);

    let key: WebEditorElementKey;
    if (rawElementKey) {
      key = rawElementKey;
    } else {
      // Fallback to locatorKey for legacy transactions
      try {
        key = locatorKey(tx.targetLocator);
      } catch {
        // Use transaction ID to avoid cross-element grouping
        key = `unknown:${tx.id}`;
      }
    }

    const list = groups.get(key);
    if (list) {
      list.push(tx);
    } else {
      groups.set(key, [tx]);
    }
  }

  // Build summaries for each element
  const summaries: ElementChangeSummary[] = [];

  for (const [elementKey, txs] of groups.entries()) {
    if (txs.length === 0) continue;

    // Use the latest transaction's locator for element lookup
    const lastTx = txs[txs.length - 1];
    const locator = lastTx.after?.locator ?? lastTx.targetLocator;

    // Compute net effects
    const style = computeStyleNetEffect(txs);
    const text = computeTextNetEffect(txs);
    const cls = computeClassNetEffect(txs);

    const hasStyle = style !== null;
    const hasText = text !== null;
    const hasClass = cls !== null;

    // Filter elements with no net effect
    if (!hasStyle && !hasText && !hasClass) continue;

    // Resolve labels (try live DOM, fallback to locator data)
    const { label, fullLabel } = resolveLabels(locator, elementKey);

    // Build net effect payload for batch Apply
    const netEffect: NetEffectPayload = {
      elementKey,
      locator,
    };
    if (style) {
      netEffect.styleChanges = { before: style.before, after: style.after };
    }
    if (text) {
      netEffect.textChange = { before: text.before, after: text.after };
    }
    if (cls) {
      netEffect.classChanges = { before: cls.before, after: cls.after };
    }

    // Build changes statistics for UI
    const changes: ElementChangeSummary['changes'] = {};
    if (style) {
      changes.style = {
        added: style.added,
        removed: style.removed,
        modified: style.modified,
        details: style.details,
      };
    }
    if (text) {
      changes.text = {
        beforePreview: text.beforePreview,
        afterPreview: text.afterPreview,
      };
    }
    if (cls) {
      changes.class = {
        added: cls.added,
        removed: cls.removed,
      };
    }

    // Compute metadata (use safe number conversion)
    const updatedAt = txs.reduce((max, tx) => {
      const ts = Number(tx.timestamp ?? 0);
      return Number.isFinite(ts) ? Math.max(max, ts) : max;
    }, 0);
    const type = inferChangeType(hasStyle, hasText, hasClass);

    summaries.push({
      elementKey,
      label,
      fullLabel,
      locator,
      type,
      changes,
      transactionIds: txs.map((tx) => tx.id),
      netEffect,
      updatedAt,
      debugSource: locator.debugSource,
    });
  }

  // Sort by most recently changed first, then by label for consistency
  summaries.sort((a, b) => b.updatedAt - a.updatedAt || a.label.localeCompare(b.label));

  return summaries;
}

/**
 * Check if there are any applicable changes in the transaction list.
 * Useful for determining if the "Apply" button should be enabled.
 *
 * @param transactions - Array of transactions to check
 * @returns True if there are applicable style/text/class changes
 */
export function hasApplicableChanges(transactions: readonly Transaction[]): boolean {
  const summaries = aggregateTransactionsByElement(transactions);
  return summaries.length > 0;
}

/**
 * Get element keys that have applicable changes.
 *
 * @param transactions - Array of transactions to analyze
 * @returns Set of element keys with applicable changes
 */
export function getChangedElementKeys(
  transactions: readonly Transaction[],
): Set<WebEditorElementKey> {
  const summaries = aggregateTransactionsByElement(transactions);
  return new Set(summaries.map((s) => s.elementKey));
}
