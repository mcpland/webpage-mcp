/**
 * Debug Source Extraction (Shared Module)
 *
 * Extracts source file location from React/Vue component debug info.
 * Used by both locator.ts (for Transaction recording) and payload-builder.ts (for single Apply).
 *
 * Design goals:
 * - Best-effort extraction (never throws)
 * - Walk up DOM tree to find nearest component with debug info
 * - Support both React (_debugSource) and Vue (__file)
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
// Vue Debug Source Extraction
// =============================================================================

/**
 * Parse Vue inspector location attribute value.
 * Format: "src/components/Foo.vue:23:7" or "C:\path\file.vue:10:5" (Windows)
 *
 * Uses trailing regex to safely handle Windows paths with drive letters.
 */
function parseVInspector(value: unknown): DebugSource | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  // Match only trailing :line or :line:column to avoid Windows drive letter issues
  const match = raw.match(/:(\d+)(?::(\d+))?$/);
  if (!match) {
    // No line info, return file only
    return { file: raw };
  }

  const file = raw.slice(0, match.index).trim();
  if (!file) return null;

  const line = Number.parseInt(match[1], 10);
  const columnRaw = match[2] ? Number.parseInt(match[2], 10) : undefined;

  return {
    file,
    line: Number.isFinite(line) && line > 0 ? line : undefined,
    column:
      columnRaw !== undefined && Number.isFinite(columnRaw) && columnRaw > 0
        ? columnRaw
        : undefined,
  };
}

/**
 * Walk up DOM tree to find data-v-inspector attribute.
 * This attribute is injected by @vitejs/plugin-vue-inspector.
 */
function findInspectorLocation(element: Element): DebugSource | null {
  try {
    let node: Element | null = element;
    for (let depth = 0; depth < MAX_DOM_DEPTH && node; depth++) {
      if (typeof node.getAttribute === 'function') {
        const attr = node.getAttribute('data-v-inspector');
        if (attr) {
          const parsed = parseVInspector(attr);
          if (parsed?.file) return parsed;
        }
      }
      node = node.parentElement;
    }
  } catch {
    // Best-effort extraction
  }
  return null;
}

/**
 * Find Vue debug source from element.
 * Priority: data-v-inspector (has line/column) > type.__file (file only)
 */
export function findVueDebugSource(element: Element): DebugSource | null {
  try {
    // Priority 1: data-v-inspector attribute (has precise line/column)
    const inspector = findInspectorLocation(element);
    if (inspector?.file) {
      // Try to get component name from Vue instance
      let componentName: string | undefined;
      let node: Element | null = element;
      for (let depth = 0; depth < MAX_DOM_DEPTH && node; depth++) {
        const rec = node as unknown as Record<string, unknown>;
        const inst = asRecord(rec.__vueParentComponent);
        const typeRec = asRecord(inst?.type);
        componentName = readString(typeRec?.name);
        if (componentName) break;
        node = node.parentElement;
      }
      return {
        ...inspector,
        componentName,
      };
    }

    // Priority 2: type.__file (file only, no line/column)
    let node: Element | null = element;
    for (let depth = 0; depth < MAX_DOM_DEPTH && node; depth++) {
      const rec = node as unknown as Record<string, unknown>;
      const inst = asRecord(rec.__vueParentComponent);
      const typeRec = asRecord(inst?.type);
      const file = readString(typeRec?.__file);

      if (file) {
        return {
          file,
          componentName: readString(typeRec?.name),
        };
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
 * Find debug source from element (tries React first, then Vue).
 * Returns null if no debug info is available.
 *
 * @param element - DOM element to extract debug source from
 * @returns Debug source with file path and optional line/column/component name
 */
export function findDebugSource(element: Element): DebugSource | null {
  // Try React first
  const react = findReactDebugSource(element);
  if (react) return react;

  // Try Vue
  const vue = findVueDebugSource(element);
  if (vue) return vue;

  return null;
}
