/**
 * Quick Panel Search Input
 *
 * A scope-aware search input component with:
 * - PRD-defined scope prefixes (t/b/h/c/>)
 * - Scope chip for visual indication and cycling
 * - XSS-safe rendering (textContent/value only)
 * - IME composition handling
 * - Disposer-based cleanup
 */

import { Disposer } from '@/entrypoints/web-editor-v2/utils/disposables';
import {
  DEFAULT_SCOPE,
  QUICK_PANEL_SCOPES,
  normalizeQuickPanelScope,
  parseScopePrefixedQuery,
  type QuickPanelScope,
} from '../core/types';

// ============================================================
// Types
// ============================================================

export interface SearchInputState {
  scope: QuickPanelScope;
  query: string;
}

export interface SearchInputOptions {
  /** Container to mount the search input */
  container: HTMLElement;
  /** Initial scope. Default: 'all' */
  initialScope?: QuickPanelScope;
  /** Initial query string */
  initialQuery?: string;
  /** Input placeholder. Default: 'Search...' */
  placeholder?: string;
  /** Auto-focus on mount. Default: true */
  autoFocus?: boolean;
  /**
   * Available scopes for cycling.
   * Default: all known scopes
   */
  availableScopes?: readonly QuickPanelScope[];

  /** Called when state changes (scope or query) */
  onChange?: (state: SearchInputState) => void;
  /** Called when scope changes */
  onScopeChange?: (scope: QuickPanelScope) => void;
  /** Called when query changes */
  onQueryChange?: (query: string) => void;
  /** Called when clear button is clicked */
  onClear?: () => void;
}

export interface SearchInputManager {
  /** Root DOM element */
  root: HTMLDivElement;
  /** Input element */
  input: HTMLInputElement;
  /** Get current state */
  getState: () => SearchInputState;
  /** Set scope programmatically */
  setScope: (scope: QuickPanelScope, options?: { emit?: boolean }) => void;
  /** Set query programmatically */
  setQuery: (query: string, options?: { emit?: boolean }) => void;
  /** Clear the input */
  clear: (options?: { emit?: boolean }) => void;
  /** Focus the input */
  focus: () => void;
  /** Clean up resources */
  dispose: () => void;
}

// ============================================================
// Helpers
// ============================================================

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeFocus(el: HTMLElement): void {
  try {
    el.focus();
  } catch {
    // Best-effort
  }
}

function buildScopeCycleList(input: readonly QuickPanelScope[] | undefined): QuickPanelScope[] {
  const defaultList: QuickPanelScope[] = [
    'all',
    'tabs',
    'bookmarks',
    'history',
    'content',
    'commands',
  ];
  const list = (input?.length ? [...input] : defaultList).map((s) => normalizeQuickPanelScope(s));

  // Ensure 'all' exists as a stable fallback
  if (!list.includes('all')) {
    list.unshift('all');
  }

  // De-duplicate while preserving order
  const seen = new Set<QuickPanelScope>();
  return list.filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}

// ============================================================
// Main Factory
// ============================================================

/**
 * Create a Quick Panel search input component.
 *
 * @example
 * ```typescript
 * const searchInput = createSearchInput({
 *   container: headerSearchMount,
 *   initialScope: 'all',
 *   onChange: ({ scope, query }) => {
 *     controller.search(scope, query);
 *   },
 * });
 *
 * // Programmatically set scope
 * searchInput.setScope('tabs');
 *
 * // Cleanup
 * searchInput.dispose();
 * ```
 */
export function createSearchInput(options: SearchInputOptions): SearchInputManager {
  const disposer = new Disposer();
  const scopes = buildScopeCycleList(options.availableScopes);

  let disposed = false;
  let isComposing = false;

  let state: SearchInputState = {
    scope: normalizeQuickPanelScope(options.initialScope, DEFAULT_SCOPE),
    query: (options.initialQuery ?? '').trim(),
  };

  // --------------------------------------------------------
  // DOM Construction
  // --------------------------------------------------------

  const root = document.createElement('div');
  root.className = 'qp-search';

  const brand = document.createElement('div');
  brand.className = 'qp-brand';
  brand.textContent = '\u2726'; // Star symbol

  const scopeBtn = document.createElement('button');
  scopeBtn.type = 'button';
  scopeBtn.className = 'qp-scope-chip ac-btn ac-focus-ring';
  scopeBtn.setAttribute('aria-label', 'Switch search scope');

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'qp-search-input ac-focus-ring';
  input.placeholder = options.placeholder?.trim() || 'Search\u2026';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('aria-label', 'Quick Panel search');

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'qp-icon-btn ac-btn ac-focus-ring';
  clearBtn.textContent = '\u00D7'; // ×
  clearBtn.setAttribute('aria-label', 'Clear search');

  root.append(brand, scopeBtn, input, clearBtn);
  options.container.append(root);
  disposer.add(() => root.remove());

  // --------------------------------------------------------
  // Rendering
  // --------------------------------------------------------

  function renderScopeChip(): void {
    const def = QUICK_PANEL_SCOPES[state.scope];
    const prefixHint = def.prefix ? def.prefix.trim() : '';

    scopeBtn.textContent = '';

    const iconEl = document.createElement('span');
    iconEl.className = 'qp-scope-chip__icon';
    iconEl.textContent = def.icon;

    const labelEl = document.createElement('span');
    labelEl.className = 'qp-scope-chip__label';
    labelEl.textContent = def.label;

    scopeBtn.append(iconEl, labelEl);

    if (prefixHint) {
      const prefixEl = document.createElement('span');
      prefixEl.className = 'qp-scope-chip__prefix';
      prefixEl.textContent = prefixHint;
      scopeBtn.append(prefixEl);
    }
  }

  function renderClearButton(): void {
    clearBtn.hidden = !isNonEmptyString(input.value);
  }

  function render(): void {
    renderScopeChip();
    renderClearButton();
  }

  // --------------------------------------------------------
  // State Change Emission
  // --------------------------------------------------------

  function emit(): void {
    try {
      options.onChange?.({ ...state });
    } catch {
      // Best-effort
    }
    try {
      options.onScopeChange?.(state.scope);
    } catch {
      // Best-effort
    }
    try {
      options.onQueryChange?.(state.query);
    } catch {
      // Best-effort
    }
  }

  // --------------------------------------------------------
  // State Mutators
  // --------------------------------------------------------

  function setScope(next: QuickPanelScope, opts: { emit?: boolean } = {}): void {
    if (disposed) return;

    const normalized = normalizeQuickPanelScope(next, DEFAULT_SCOPE);
    if (state.scope === normalized) return;

    // Only allow scopes in the cycle list
    if (!scopes.includes(normalized)) return;

    state = { ...state, scope: normalized };
    render();

    if (opts.emit !== false) emit();
  }

  function setQuery(nextQuery: string, opts: { emit?: boolean } = {}): void {
    if (disposed) return;

    const q = (nextQuery ?? '').trim();
    if (state.query === q && input.value === q) {
      render();
      return;
    }

    state = { ...state, query: q };
    input.value = q;
    render();

    if (opts.emit !== false) emit();
  }

  function clear(opts: { emit?: boolean } = {}): void {
    if (disposed) return;

    setQuery('', { emit: false });

    try {
      options.onClear?.();
    } catch {
      // Best-effort
    }

    if (opts.emit !== false) emit();
  }

  // --------------------------------------------------------
  // Prefix Parsing
  // --------------------------------------------------------

  function applyPrefixParsing(): void {
    if (disposed) return;
    if (isComposing) return;

    const parsed = parseScopePrefixedQuery(input.value, state.scope);

    if (parsed.consumedPrefix) {
      // Apply scope change if available
      if (scopes.includes(parsed.scope) && parsed.scope !== state.scope) {
        setScope(parsed.scope, { emit: false });
      }

      // Consume the prefix from the visible input
      if (input.value !== parsed.query) {
        input.value = parsed.query;
        // Move caret to end after rewrite for predictable UX
        try {
          input.setSelectionRange(input.value.length, input.value.length);
        } catch {
          // Ignore
        }
      }
    }

    // Always update query state from current input value
    setQuery(input.value, { emit: false });
    emit();
  }

  // --------------------------------------------------------
  // Event Handlers
  // --------------------------------------------------------

  disposer.listen(input, 'compositionstart', () => {
    isComposing = true;
  });

  disposer.listen(input, 'compositionend', () => {
    isComposing = false;
    applyPrefixParsing();
  });

  disposer.listen(input, 'input', () => {
    applyPrefixParsing();
  });

  disposer.listen(clearBtn, 'click', () => {
    clear();
    safeFocus(input);
  });

  disposer.listen(scopeBtn, 'click', () => {
    const idx = scopes.indexOf(state.scope);
    const next = scopes[(idx >= 0 ? idx + 1 : 0) % scopes.length] ?? 'all';
    setScope(next);
    safeFocus(input);
  });

  // --------------------------------------------------------
  // Initialization
  // --------------------------------------------------------

  input.value = state.query;
  render();

  if (options.autoFocus !== false) {
    safeFocus(input);
  }

  // --------------------------------------------------------
  // Public API
  // --------------------------------------------------------

  return {
    root,
    input,
    getState: () => ({ ...state }),
    setScope,
    setQuery,
    clear,
    focus: () => safeFocus(input),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      disposer.dispose();
    },
  };
}
