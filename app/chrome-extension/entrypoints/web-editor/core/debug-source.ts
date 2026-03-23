/**
 * Debug Source Extraction (Shared Module)
 *
 * Extracts source file location from React component debug info.
 * Used by both locator.ts (for Transaction recording) and payload-builder.ts (for single Apply).
 *
 * Design goals:
 * - Best-effort extraction (never throws)
 * - Walk up DOM tree to find nearest component with debug info
 * - Support React (_debugSource)
 */

import type { DebugSource } from '@/common/web-editor-types';

// =============================================================================
// Constants
// =============================================================================

/** Maximum depth to walk up the DOM tree for debug source */
const MAX_DOM_DEPTH = 15;

/** Maximum depth to walk up React fiber tree */
const MAX_FIBER_DEPTH = 40;

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
 * Read component name from function/object
 */
function readComponentName(value: unknown): string | undefined {
  if (!value) return undefined;

  if (typeof value === 'function') {
    const fn = value as { displayName?: unknown; name?: unknown };
    return readString(fn.displayName) ?? readString(fn.name);
  }

  const rec = asRecord(value);
  if (rec) {
    return readString(rec.displayName) ?? readString(rec.name);
  }

  return undefined;
}

// =============================================================================
// React Debug Source Extraction
// =============================================================================

/**
 * Extract debug source from React Fiber
 */
function extractReactDebugSource(fiber: unknown): DebugSource | null {
  let current = fiber;

  for (let i = 0; i < MAX_FIBER_DEPTH && current; i++) {
    const rec = asRecord(current);
    if (!rec) break;

    // Check _debugSource
    const src = asRecord(rec._debugSource);
    const file = readString(src?.fileName);
    if (file) {
      const componentName = readComponentName(rec.elementType) ?? readComponentName(rec.type);
      return {
        file,
        line: readNumber(src?.lineNumber),
        column: readNumber(src?.columnNumber),
        componentName,
      };
    }

    // Check owner's debug source
    const owner = asRecord(rec._debugOwner);
    const ownerSrc = asRecord(owner?._debugSource);
    const ownerFile = readString(ownerSrc?.fileName);
    if (ownerFile) {
      const componentName = readComponentName(owner?.elementType) ?? readComponentName(owner?.type);
      return {
        file: ownerFile,
        line: readNumber(ownerSrc?.lineNumber),
        column: readNumber(ownerSrc?.columnNumber),
        componentName,
      };
    }

    current = rec.return;
  }

  return null;
}

/**
 * Find React debug source from element
 */
export function findReactDebugSource(element: Element): DebugSource | null {
  try {
    let node: Element | null = element;

    for (let depth = 0; depth < MAX_DOM_DEPTH && node; depth++) {
      const rec = node as unknown as Record<string, unknown>;

      for (const key of Object.keys(rec)) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          const source = extractReactDebugSource(rec[key]);
          if (source) return source;
        }
      }

      node = node.parentElement;
    }
  } catch {
    // Best-effort only
  }

  return null;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Find debug source from element.
 * Returns null if no debug info is available.
 *
 * @param element - DOM element to extract debug source from
 * @returns Debug source with file path and optional line/column/component name
 */
export function findDebugSource(element: Element): DebugSource | null {
  return findReactDebugSource(element);
}
