/**
 * Element Key Utilities (Phase 1.2)
 *
 * Generates stable, per-page-lifecycle identifiers for DOM elements.
 *
 * Design goals:
 * - Stable within a single page lifetime (until refresh/reinjection)
 * - Insensitive to class list mutations
 * - Suitable for grouping transactions by element (AgentChat chips)
 * - Supports Shadow DOM context prefixing
 * - Reserves a frame context prefix for future iframe support
 */

import type { WebEditorElementKey } from '../../../common/web-editor-types';

// =============================================================================
// State
// =============================================================================

/** WeakMap cache for stable element keys */
const elementKeyCache = new WeakMap<Element, WebEditorElementKey>();

/** WeakMap cache for shadow host stable identifiers */
const shadowHostKeyCache = new WeakMap<Element, string>();

/** Auto-increment counter for elements without ID */
let autoKeyCounter = 0;

/** Auto-increment counter for shadow hosts without ID */
let shadowHostCounter = 0;

/** Cached frame context (computed once per execution context) */
let cachedFrameContext: string | undefined;

// =============================================================================
// Constants
// =============================================================================

/** Priority order for fallback label attributes */
const LABEL_ATTR_PRIORITY = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-qa',
  'data-cy',
  'name',
  'aria-label',
  'title',
  'alt',
] as const;

/** Maximum length for attribute values in labels */
const MAX_LABEL_ATTR_VALUE_LENGTH = 48;

/** Maximum length for text content in labels */
const MAX_TEXT_LABEL_LENGTH = 64;

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Normalize element tag name to lowercase
 */
function normalizeTagName(element: Element): string {
  const raw = element?.tagName ? String(element.tagName) : '';
  const tag = raw.toLowerCase().trim();
  return tag || 'unknown';
}

/**
 * Normalize attribute value to trimmed string
 */
function normalizeAttrValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalize text by collapsing whitespace
 */
function normalizeText(value: string): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Truncate string with ellipsis if exceeds max length
 */
function truncate(value: string, maxLength: number): string {
  const str = String(value ?? '');
  if (str.length <= maxLength) return str;
  return str.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…';
}

/**
 * Normalize shadow host chain array
 */
function normalizeShadowHostChain(shadowHostChain?: readonly string[]): string[] | undefined {
  if (!Array.isArray(shadowHostChain) || shadowHostChain.length === 0) {
    return undefined;
  }
  const normalized = shadowHostChain.map((s) => String(s ?? '').trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Get frame context prefix for iframe isolation.
 * Cached for performance.
 */
function getFrameContextPrefix(): string {
  if (cachedFrameContext !== undefined) return cachedFrameContext;

  let context = '';
  try {
    const frameEl = window.frameElement;
    if (frameEl instanceof HTMLIFrameElement) {
      const tag = normalizeTagName(frameEl);
      const id = normalizeAttrValue(frameEl.id || frameEl.getAttribute('id'));
      if (id) {
        context = `${tag}#${id}`;
      } else {
        const name = normalizeAttrValue(frameEl.name || frameEl.getAttribute('name'));
        if (name) {
          context = `${tag}[name="${truncate(name, MAX_LABEL_ATTR_VALUE_LENGTH)}"]`;
        } else {
          const src = normalizeAttrValue(frameEl.getAttribute('src') || frameEl.src);
          context = src ? `${tag}[src="${truncate(src, MAX_LABEL_ATTR_VALUE_LENGTH)}"]` : tag;
        }
      }
    }
  } catch {
    // Cross-origin frame access may throw
    context = '';
  }

  cachedFrameContext = context;
  return context;
}

/**
 * Generate a stable identifier for a shadow host element.
 * Uses WeakMap caching to ensure stability across class changes.
 */
function getStableShadowHostKey(host: Element): string {
  const cached = shadowHostKeyCache.get(host);
  if (cached) return cached;

  const tag = normalizeTagName(host);
  const id = normalizeAttrValue(host.id || host.getAttribute('id'));
  const key = id ? `${tag}#${id}` : `${tag}_h${++shadowHostCounter}`;

  shadowHostKeyCache.set(host, key);
  return key;
}

/**
 * Compute Shadow DOM context prefix by walking up the shadow host chain.
 * Uses stable host identifiers (not selectors) to avoid class sensitivity.
 *
 * Note: The provided shadowHostChain parameter is intentionally NOT used
 * for key generation because it may contain class-based selectors.
 * Instead, we derive stable host keys directly from the DOM.
 */
function computeShadowContextPrefix(
  element: Element,
  _shadowHostChain?: readonly string[],
): string {
  // Build stable host chain by walking up shadow roots
  // Each host gets a stable key via WeakMap (not selector-based)
  const hosts: string[] = [];
  let current: Element = element;

  while (true) {
    let root: unknown;
    try {
      root = current.getRootNode?.();
    } catch {
      root = null;
    }

    if (!(root instanceof ShadowRoot)) break;
    const host = root.host;
    if (!(host instanceof Element)) break;

    // Use stable host key (WeakMap cached, class-insensitive)
    hosts.unshift(getStableShadowHostKey(host));
    current = host;
  }

  return hosts.length > 0 ? hosts.join('>') : '';
}

/**
 * Find the best attribute for labeling an element
 */
function readBestLabelAttribute(element: Element): { attr: string; value: string } | null {
  for (const attr of LABEL_ATTR_PRIORITY) {
    const value = normalizeAttrValue(element.getAttribute(attr));
    if (value) return { attr, value };
  }
  return null;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Generate a stable element key within the current page lifecycle.
 *
 * Key strategy:
 * - Prefer deterministic `tag#id` when id exists
 * - Otherwise assign a stable incremental key via WeakMap caching
 * - Prefix with Shadow DOM host chain and (reserved) iframe context
 *
 * @param element - The target DOM element
 * @param shadowHostChain - Optional shadow host selector chain from outer to inner
 * @returns A stable, unique key for the element
 */
export function generateStableElementKey(
  element: Element,
  shadowHostChain?: readonly string[],
): WebEditorElementKey {
  // Return cached key if available
  const cached = elementKeyCache.get(element);
  if (cached) return cached;

  // Generate base key from tag and id
  const tag = normalizeTagName(element);
  const id = normalizeAttrValue(element.id || element.getAttribute('id'));
  const baseKey = id ? `${tag}#${id}` : `${tag}_${++autoKeyCounter}`;

  // Build full key with context prefixes
  const parts: string[] = [];

  const frame = getFrameContextPrefix();
  if (frame) parts.push(`frame:${frame}`);

  const shadow = computeShadowContextPrefix(element, shadowHostChain);
  if (shadow) parts.push(`shadow:${shadow}`);

  parts.push(baseKey);

  const fullKey = parts.join('|');
  elementKeyCache.set(element, fullKey);
  return fullKey;
}

/**
 * Generate a human-friendly label for UI rendering (Chips/tooltips).
 *
 * This label is best-effort and may change if element text/attrs change.
 * It should NOT be used for element identification - use generateStableElementKey instead.
 *
 * @param element - The target DOM element
 * @returns A human-readable label for the element
 */
export function generateElementLabel(element: Element): string {
  const tag = normalizeTagName(element);

  // Prefer ID if available
  const id = normalizeAttrValue(element.id || element.getAttribute('id'));
  if (id) return `${tag}#${id}`;

  // Try common labeling attributes
  const bestAttr = readBestLabelAttribute(element);
  if (bestAttr) {
    return `${tag}[${bestAttr.attr}="${truncate(bestAttr.value, MAX_LABEL_ATTR_VALUE_LENGTH)}"]`;
  }

  // Try role attribute
  const role = normalizeAttrValue(element.getAttribute('role'));
  if (role) {
    return `${tag}[role="${truncate(role, MAX_LABEL_ATTR_VALUE_LENGTH)}"]`;
  }

  // Special handling for input elements
  if (element instanceof HTMLInputElement) {
    const type = normalizeAttrValue(element.getAttribute('type') || element.type);
    if (type && type !== 'text') {
      return `${tag}[type="${truncate(type, MAX_LABEL_ATTR_VALUE_LENGTH)}"]`;
    }
    const placeholder = normalizeAttrValue(
      element.getAttribute('placeholder') || element.placeholder,
    );
    if (placeholder) {
      return `${tag}[placeholder="${truncate(placeholder, MAX_LABEL_ATTR_VALUE_LENGTH)}"]`;
    }
  }

  // Special handling for iframes
  if (element instanceof HTMLIFrameElement) {
    const src = normalizeAttrValue(element.getAttribute('src') || element.src);
    if (src) {
      return `${tag}[src="${truncate(src, MAX_LABEL_ATTR_VALUE_LENGTH)}"]`;
    }
  }

  // Fallback to text content
  const text = normalizeText(element.textContent ?? '');
  if (text) return `${tag}("${truncate(text, MAX_TEXT_LABEL_LENGTH)}")`;

  // Last resort: just the tag name
  return tag;
}

/**
 * Generate a full label including shadow context for tooltips.
 *
 * @param element - The target DOM element
 * @param shadowHostChain - Optional shadow host selector chain
 * @returns A full label with context for detailed display
 */
export function generateFullElementLabel(
  element: Element,
  shadowHostChain?: readonly string[],
): string {
  const baseLabel = generateElementLabel(element);
  const shadow = computeShadowContextPrefix(element, shadowHostChain);

  if (shadow) {
    return `${shadow} >> ${baseLabel}`;
  }

  return baseLabel;
}

/**
 * Check if an element key was generated from an element with a stable ID.
 * Elements with IDs are more reliably identifiable across page reloads.
 *
 * Key format: [frame:xxx|][shadow:xxx|]baseKey
 * - ID-based baseKey: "tag#id" (contains '#')
 * - Auto-generated baseKey: "tag_N" (contains '_' followed by number)
 *
 * @param key - The element key to check
 * @returns True if the key is based on an element ID
 */
export function isStableIdBasedKey(key: WebEditorElementKey): boolean {
  if (!key || typeof key !== 'string') return false;

  // Extract the base key (last part after all prefixes)
  const parts = key.split('|');
  const baseKey = parts[parts.length - 1];

  if (!baseKey) return false;

  // ID-based keys have format "tag#id" (contains '#')
  // Auto-generated keys have format "tag_N" (underscore followed by digit)
  // We check for '#' presence AND ensure it's not just in a prefix
  return baseKey.includes('#') && !baseKey.match(/_\d+$/);
}

/**
 * Reset the element key counters for testing purposes.
 *
 * Note: This only resets the auto-increment counters and frame context cache.
 * WeakMap caches cannot be cleared programmatically, but their entries
 * are automatically garbage collected when elements are removed from DOM.
 *
 * For testing, you should create new DOM elements after calling this
 * to ensure they get fresh keys.
 */
export function resetElementKeyState(): void {
  autoKeyCounter = 0;
  shadowHostCounter = 0;
  cachedFrameContext = undefined;
  // WeakMap entries are automatically cleaned up when elements are GC'd
  // For testing, create new elements to get fresh keys
}
