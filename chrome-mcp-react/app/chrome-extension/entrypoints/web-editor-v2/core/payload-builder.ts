/**
 * Payload Builder (Phase 1.8)
 *
 * Builds "Apply to Code" payload from Transactions for sending to the Agent.
 *
 * Design goals:
 * - Reuse existing BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_APPLY pipeline
 * - Extract React/Vue component debug info when available
 * - Build comprehensive style diff descriptions
 * - Detect tech stack (Tailwind, React, Vue) from DOM hints
 */

import type { DebugSource, ElementLocator, Transaction } from '@/common/web-editor-types';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { locateElement } from './locator';
import { findReactDebugSource, findVueDebugSource } from './debug-source';

// =============================================================================
// Types
// =============================================================================

/** Instruction type for Apply payload */
export type ApplyInstructionType = 'update_text' | 'update_style';

/** Element fingerprint for identification */
export interface ElementFingerprint {
  tag: string;
  id?: string;
  classes: string[];
  text?: string;
}

/** Style change instruction */
export interface ApplyInstruction {
  type: ApplyInstructionType;
  description: string;
  text?: string;
  style?: Record<string, string>;
}

/** Complete payload sent to background/Agent */
export interface ApplyPayload {
  pageUrl: string;
  targetFile?: string;
  fingerprint: ElementFingerprint;
  techStackHint?: string[];
  instruction: ApplyInstruction;

  // V2 extended fields (best-effort, optional)
  locator?: ElementLocator;
  selectorCandidates?: string[];
  debugSource?: DebugSource;
  operation?: {
    type: 'update_style';
    before: Record<string, string>;
    after: Record<string, string>;
    removed: string[];
  };
}

/** Options for building payload */
export interface BuildPayloadOptions {
  pageUrl?: string;
  /** Pre-resolved element to avoid re-locating */
  element?: Element | null;
  /** Max selectors to include in description */
  maxSelectorsInDescription?: number;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Safely access object as record
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Read optional string value
 */
function readString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return undefined;
}

/**
 * Read optional number value
 */
function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Normalize text snippet for display
 */
function normalizeText(text: string, maxLength: number): string {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

// =============================================================================
// Fingerprint Generation
// =============================================================================

/**
 * Build fingerprint from DOM element
 */
function buildFingerprintFromElement(element: Element): ElementFingerprint {
  const tag = element.tagName?.toLowerCase() ?? 'unknown';
  const id = readString((element as HTMLElement).id);
  const classes = Array.from(element.classList ?? []).slice(0, 24);
  const text = readString(normalizeText(element.textContent ?? '', 96));

  return { tag, id, classes, text };
}

/**
 * Build fingerprint from locator (fallback when element not available)
 */
function buildFingerprintFromLocator(locator: ElementLocator): ElementFingerprint {
  const raw = readString(locator.fingerprint) ?? '';
  const parts = raw.split('|').filter(Boolean);

  const tag = parts[0] || 'unknown';
  let id: string | undefined;
  let classes: string[] = [];
  let text: string | undefined;

  for (const part of parts.slice(1)) {
    if (part.startsWith('id=')) {
      id = readString(part.slice(3));
    } else if (part.startsWith('class=')) {
      classes = part.slice(6).split('.').filter(Boolean);
    } else if (part.startsWith('text=')) {
      text = readString(part.slice(5));
    }
  }

  return { tag, id, classes, text };
}

// =============================================================================
// Tech Stack Detection
// =============================================================================

/** Tailwind class patterns */
const TAILWIND_PATTERNS = [
  /^bg-/,
  /^text-/,
  /^p[trblxy]?-/,
  /^m[trblxy]?-/,
  /^flex$/,
  /^grid$/,
  /^items-/,
  /^justify-/,
  /^gap-/,
  /^rounded/,
  /^shadow/,
  /^border/,
  /^w-/,
  /^h-/,
];

/**
 * Detect if element uses Tailwind CSS
 */
function detectTailwind(classes: string[]): boolean {
  return classes.some((cls) => TAILWIND_PATTERNS.some((p) => p.test(cls)));
}

// =============================================================================
// Component Hints Resolution
// =============================================================================

interface ComponentHints {
  targetFile?: string;
  debugSource?: DebugSource;
  techStackHint?: string[];
}

/**
 * Resolve component hints from element
 */
function resolveComponentHints(element: Element): ComponentHints {
  let targetFile: string | undefined;
  let debugSource: DebugSource | undefined;
  const hints = new Set<string>();

  let node: Element | null = element;

  for (let depth = 0; depth < 20 && node; depth++) {
    // Try React
    const react = findReactDebugSource(node);
    if (react?.file) {
      hints.add('React');
      if (!targetFile && !react.file.includes('node_modules')) {
        targetFile = react.file;
        debugSource = react;
        break;
      }
    }

    // Try Vue
    const vue = findVueDebugSource(node);
    if (vue?.file) {
      hints.add('Vue');
      if (!targetFile && !vue.file.includes('node_modules')) {
        targetFile = vue.file;
        debugSource = vue;
        break;
      }
    }

    node = node.parentElement;
  }

  // Check for Tailwind
  const classes = Array.from(element.classList ?? []).slice(0, 128);
  if (detectTailwind(classes)) {
    hints.add('Tailwind');
  }

  return {
    targetFile,
    debugSource,
    techStackHint: hints.size > 0 ? Array.from(hints) : undefined,
  };
}

// =============================================================================
// Style Diff Computation
// =============================================================================

interface StyleDiff {
  before: Record<string, string>;
  after: Record<string, string>;
  set: Record<string, string>;
  removed: string[];
}

/**
 * Compute style diff from transaction
 */
function computeStyleDiff(tx: Transaction): StyleDiff | null {
  const beforeRaw = tx.before.styles ?? {};
  const afterRaw = tx.after.styles ?? {};

  const keys = new Set([...Object.keys(beforeRaw), ...Object.keys(afterRaw)]);
  if (keys.size === 0) return null;

  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  const set: Record<string, string> = {};
  const removed: string[] = [];

  for (const key of keys) {
    const b = String(beforeRaw[key] ?? '').trim();
    const a = String(afterRaw[key] ?? '').trim();

    if (b === a) continue;

    before[key] = b;
    after[key] = a;

    if (a) {
      set[key] = a;
    } else {
      removed.push(key);
    }
  }

  if (Object.keys(before).length === 0 && Object.keys(after).length === 0) {
    return null;
  }

  return { before, after, set, removed };
}

/**
 * Build human-readable style description
 */
function buildStyleDescription(
  locator: ElementLocator,
  diff: StyleDiff,
  maxSelectors: number,
): string {
  const selectors = (locator.selectors ?? []).filter(Boolean);
  const selectorPreview = selectors.slice(0, maxSelectors).join(' | ');

  const changes: string[] = [];
  for (const [prop, nextVal] of Object.entries(diff.after)) {
    const prevVal = diff.before[prop] ?? '';
    if (nextVal) {
      changes.push(`${prop}: "${prevVal}" -> "${nextVal}"`);
    } else {
      changes.push(`${prop}: remove (was "${prevVal}")`);
    }
  }

  const selPart = selectorPreview ? `selectors: ${selectorPreview}` : 'selectors: (unavailable)';
  return `Update element styles (${selPart}). ${changes.join('; ')}`;
}

/**
 * Build human-readable text update description (Phase 2.7)
 */
function buildTextDescription(
  locator: ElementLocator,
  beforeText: string,
  afterText: string,
  maxSelectors: number,
): string {
  const selectors = (locator.selectors ?? []).filter(Boolean);
  const selectorPreview = selectors.slice(0, maxSelectors).join(' | ');
  const selPart = selectorPreview ? `selectors: ${selectorPreview}` : 'selectors: (unavailable)';

  // Truncate text for preview
  const beforePreview = beforeText.length > 96 ? beforeText.slice(0, 93) + '...' : beforeText;
  const afterPreview = afterText.length > 96 ? afterText.slice(0, 93) + '...' : afterText;

  return `Update element text (${selPart}). "${beforePreview}" -> "${afterPreview}"`;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Build Apply payload from a Transaction
 * Supports style and text transactions (Phase 2.7)
 */
export function buildApplyPayload(
  tx: Transaction,
  options: BuildPayloadOptions = {},
): ApplyPayload | null {
  const pageUrl = readString(options.pageUrl ?? globalThis.location?.href) ?? '';
  if (!pageUrl) return null;

  const locator = tx.targetLocator;

  // Resolve element
  const element =
    options.element !== undefined ? options.element : locateElement(locator, document);

  // Build fingerprint
  const fingerprint = element
    ? buildFingerprintFromElement(element)
    : buildFingerprintFromLocator(locator);

  // Resolve component hints
  const hints = element ? resolveComponentHints(element) : {};

  const maxSelectors = Math.max(0, options.maxSelectorsInDescription ?? 3);

  // Handle style transactions
  if (tx.type === 'style') {
    const diff = computeStyleDiff(tx);
    if (!diff) return null;

    const description = buildStyleDescription(locator, diff, maxSelectors);

    const payload: ApplyPayload = {
      pageUrl,
      targetFile: hints.targetFile,
      fingerprint,
      techStackHint: hints.techStackHint,
      instruction: {
        type: 'update_style',
        description,
        style: Object.keys(diff.set).length > 0 ? diff.set : undefined,
      },

      // V2 extended fields
      locator: hints.debugSource ? { ...locator, debugSource: hints.debugSource } : locator,
      selectorCandidates: locator.selectors?.slice(0, 8),
      debugSource: hints.debugSource,
      operation: {
        type: 'update_style',
        before: diff.before,
        after: diff.after,
        removed: diff.removed,
      },
    };

    return payload;
  }

  // Handle text transactions (Phase 2.7)
  if (tx.type === 'text') {
    const beforeText = String(tx.before.text ?? '');
    const afterText = String(tx.after.text ?? '');
    if (beforeText === afterText) return null;

    const description = buildTextDescription(locator, beforeText, afterText, maxSelectors);

    const payload: ApplyPayload = {
      pageUrl,
      targetFile: hints.targetFile,
      fingerprint,
      techStackHint: hints.techStackHint,
      instruction: {
        type: 'update_text',
        description,
        text: afterText,
      },

      // V2 extended fields
      locator: hints.debugSource ? { ...locator, debugSource: hints.debugSource } : locator,
      selectorCandidates: locator.selectors?.slice(0, 8),
      debugSource: hints.debugSource,
    };

    return payload;
  }

  return null;
}

/**
 * Send Apply payload to background script
 */
export async function sendApplyPayload(payload: ApplyPayload): Promise<unknown> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    throw new Error('Chrome runtime API not available');
  }

  return chrome.runtime.sendMessage({
    type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_APPLY,
    payload,
  });
}

/**
 * Build and send Transaction to Agent in one call
 */
export async function sendTransactionToAgent(
  tx: Transaction,
  options: BuildPayloadOptions = {},
): Promise<unknown> {
  const payload = buildApplyPayload(tx, options);
  if (!payload) {
    throw new Error('Unable to build payload from transaction');
  }
  return sendApplyPayload(payload);
}
