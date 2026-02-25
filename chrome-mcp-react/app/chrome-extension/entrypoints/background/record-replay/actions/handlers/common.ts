/**
 * Common utilities for Action handlers
 *
 * Shared helpers for:
 * - Variable resolution and template interpolation
 * - Selector target conversion
 * - Element visibility verification
 * - Logging utilities
 */

import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import {
  createChromeSelectorLocator,
  type SelectorCandidate as SharedSelectorCandidate,
  type SelectorCandidateSource,
  type SelectorStability,
  type SelectorTarget,
} from '@/shared/selector';
import { tryResolveString } from '../registry';
import type { ActionExecutionContext, ElementTarget, Resolvable, VariableStore } from '../types';

// ================================
// Selector Locator Instance
// ================================

export const selectorLocator = createChromeSelectorLocator();

// ================================
// String Resolution Utilities
// ================================

/**
 * Interpolate {varName} placeholders in a string using variable store
 */
export function interpolateBraces(template: string, vars: VariableStore): string {
  return String(template || '').replace(/\{([^}]+)\}/g, (_match, key) => {
    const value = (vars as Record<string, unknown>)[key];
    return value == null ? '' : String(value);
  });
}

/**
 * Resolve a Resolvable<string> value with template interpolation
 */
export function resolveString(
  value: Resolvable<string>,
  vars: VariableStore,
): { ok: true; value: string } | { ok: false; error: string } {
  const resolved = tryResolveString(value, vars);
  if (!resolved.ok) return resolved;
  return { ok: true, value: interpolateBraces(resolved.value, vars) };
}

/**
 * Resolve an optional Resolvable<string> value
 */
export function resolveOptionalString(
  value: Resolvable<string> | undefined,
  vars: VariableStore,
): string | undefined {
  if (value === undefined) return undefined;
  const resolved = resolveString(value, vars);
  if (!resolved.ok) return undefined;
  const out = resolved.value.trim();
  return out.length > 0 ? out : undefined;
}

// ================================
// Number Utilities
// ================================

/**
 * Clamp a number to a range with integer conversion
 */
export function clampInt(value: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// ================================
// Selector Target Conversion
// ================================

export interface ConvertedSelectorTarget {
  selectorTarget: SelectorTarget;
  /** Type of the first candidate (for fallback logging) */
  firstCandidateType?: string;
  /** First CSS or attr selector value (for tool fallback) */
  firstCssOrAttr?: string;
}

/**
 * Convert Action ElementTarget to shared SelectorTarget
 *
 * Handles:
 * - Resolvable candidate values
 * - Template interpolation
 * - Weight assignment for locator priority
 */
export function toSelectorTarget(
  target: ElementTarget,
  vars: VariableStore,
): ConvertedSelectorTarget {
  const srcCandidates = Array.isArray(target.candidates) ? target.candidates : [];
  const firstCandidateType =
    srcCandidates.length > 0
      ? String((srcCandidates[0] as { type?: string })?.type || '') || undefined
      : undefined;

  // Find first CSS/attr selector for tool fallback
  let firstCssOrAttr: string | undefined;
  for (const c of srcCandidates) {
    if (c.type !== 'css' && c.type !== 'attr') continue;
    const resolved = resolveString(c.selector, vars);
    if (resolved.ok && resolved.value.trim()) {
      firstCssOrAttr = resolved.value;
      break;
    }
  }

  // Extract selector from target if present
  const primaryRaw =
    typeof (target as { selector?: string }).selector === 'string'
      ? String((target as { selector?: string }).selector).trim()
      : '';
  const selectorInterpolated = primaryRaw ? interpolateBraces(primaryRaw, vars).trim() : '';
  const selector = selectorInterpolated || undefined;

  // Extract tagName hint
  const tagName =
    typeof (target as { tag?: string }).tag === 'string'
      ? String((target as { tag?: string }).tag)
      : typeof (target as { hint?: { tagName?: string } }).hint?.tagName === 'string'
        ? String((target as { hint?: { tagName?: string } }).hint!.tagName)
        : undefined;

  // Convert candidates with weight assignment
  // Preserve user-defined weights while keeping text candidates as last resort
  let nonTextIndex = 0;
  let textIndex = 0;
  const candidates: SharedSelectorCandidate[] = [];

  for (const c of srcCandidates) {
    const idx = c.type === 'text' ? textIndex++ : nonTextIndex++;
    // Respect user-defined weight if present, otherwise use position-based weight
    const userWeight =
      typeof (c as { weight?: number }).weight === 'number' &&
      Number.isFinite((c as { weight?: number }).weight)
        ? (c as { weight: number }).weight
        : 0;
    // Non-text candidates get higher base weight
    const weightBase = c.type === 'text' ? 0 : 1000;
    const weight = weightBase + userWeight - idx;

    // Preserve source and stability metadata from original candidate
    // Type-safely extract optional source and stability fields
    const rawSource = (c as { source?: SelectorCandidateSource }).source;
    const rawStability = (c as { stability?: SelectorStability }).stability;
    const meta: Pick<SharedSelectorCandidate, 'weight' | 'source' | 'stability'> = {
      weight,
      ...(rawSource && { source: rawSource }),
      ...(rawStability && { stability: rawStability }),
    };

    switch (c.type) {
      case 'css': {
        const resolved = resolveString(c.selector, vars);
        if (!resolved.ok) continue;
        candidates.push({ type: 'css', value: resolved.value, ...meta });
        break;
      }
      case 'attr': {
        const resolved = resolveString(c.selector, vars);
        if (!resolved.ok) continue;
        candidates.push({ type: 'attr', value: resolved.value, ...meta });
        break;
      }
      case 'xpath': {
        const resolved = resolveString(c.xpath, vars);
        if (!resolved.ok) continue;
        candidates.push({ type: 'xpath', value: resolved.value, ...meta });
        break;
      }
      case 'text': {
        const resolved = resolveString(c.text, vars);
        if (!resolved.ok) continue;
        candidates.push({
          type: 'text',
          value: resolved.value,
          ...meta,
          match: c.match,
          tagNameHint: c.tagNameHint ?? tagName,
        });
        break;
      }
      case 'aria': {
        const role = resolveOptionalString(c.role, vars);
        const name = resolveOptionalString(c.name, vars);
        // Skip aria candidate if no name provided (would produce useless selector)
        if (!name) break;
        // Avoid injecting fake role; use aria-label format when role is not specified
        const value = role
          ? `${role}[name=${JSON.stringify(name)}]`
          : `aria-label=${JSON.stringify(name)}`;
        candidates.push({ type: 'aria', value, ...meta, role, name });
        break;
      }
    }
  }

  // Ensure at least one candidate
  const ensuredCandidates: [SharedSelectorCandidate, ...SharedSelectorCandidate[]] =
    candidates.length > 0
      ? (candidates as [SharedSelectorCandidate, ...SharedSelectorCandidate[]])
      : [{ type: 'css', value: '' }];

  return {
    selectorTarget: {
      selector,
      candidates: ensuredCandidates,
      tagName,
      ref:
        typeof (target as { ref?: string }).ref === 'string'
          ? String((target as { ref?: string }).ref)
          : undefined,
    },
    firstCandidateType,
    firstCssOrAttr,
  };
}

// ================================
// Chrome Message Utilities
// ================================

/**
 * Result type for sendMessageToTab
 */
export type SendMessageResult<T = unknown> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Send message to tab with optional frameId
 * Returns structured result to avoid silent failures
 */
export async function sendMessageToTab<T = unknown>(
  tabId: number,
  message: unknown,
  frameId?: number,
): Promise<SendMessageResult<T>> {
  try {
    let response: T;
    if (typeof frameId === 'number') {
      response = await chrome.tabs.sendMessage(tabId, message, { frameId });
    } else {
      response = await chrome.tabs.sendMessage(tabId, message);
    }
    return { ok: true, value: response };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ================================
// Element Verification
// ================================

/**
 * Verify element is visible by checking its bounding rect
 */
export async function ensureElementVisible(
  tabId: number,
  ref: string,
  frameId: number | undefined,
): Promise<boolean> {
  const result = await sendMessageToTab<{ rect?: { width: number; height: number } }>(
    tabId,
    { action: TOOL_MESSAGE_TYPES.RESOLVE_REF, ref },
    frameId,
  );
  if (!result.ok) return false;
  const rect = result.value?.rect;
  return !!rect && rect.width > 0 && rect.height > 0;
}

/**
 * Get current tab URL
 */
export async function readTabUrl(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url || '';
  } catch {
    return '';
  }
}

// ================================
// Logging Utilities
// ================================

export interface FallbackLogEntry {
  stepId: string;
  status: 'success';
  message: string;
  fallbackUsed: boolean;
  fallbackFrom: string;
  fallbackTo: string;
}

/**
 * Log selector fallback usage for debugging
 */
export function logSelectorFallback(
  ctx: Pick<ActionExecutionContext, 'pushLog'>,
  actionId: string,
  from: string,
  to: string,
): void {
  try {
    ctx.pushLog?.({
      stepId: actionId,
      status: 'success',
      message: `Selector fallback used (${from} -> ${to})`,
      fallbackUsed: true,
      fallbackFrom: from,
      fallbackTo: to,
    });
  } catch {
    // Ignore logging errors
  }
}
