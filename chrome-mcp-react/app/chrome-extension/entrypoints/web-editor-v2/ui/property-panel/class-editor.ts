/**
 * Class Editor (Phase 4.7)
 *
 * DevTools-like class chips editor for the CSS panel.
 * Displays element's class list as interactive chips with add/remove capability.
 *
 * Features:
 * - Chips display for each class token
 * - Input field for adding new classes
 * - Backspace to remove last chip when input is empty
 * - Enter/Space to commit input
 * - Paste support for multiple classes
 * - Optional autocomplete suggestions
 *
 * This component is UI-only: it does not mutate the DOM element directly.
 * Instead, it emits the next class list via `onClassChange` callback.
 */

import { Disposer } from '../../utils/disposables';

// =============================================================================
// Types
// =============================================================================

export interface ClassEditorOptions {
  /** Container element to mount the editor */
  container: HTMLElement;
  /** Called when the user requests a class list change */
  onClassChange: (classes: string[]) => void;
  /** Optional suggestion source (returns unescaped class tokens) */
  getSuggestions?: () => string[];
}

export interface ClassEditor {
  /** Set the target element (reads its current classes) */
  setTarget(element: Element | null): void;
  /** Manually set the class list (for external sync) */
  setClasses(classes: string[]): void;
  /** Refresh from current target element */
  refresh(): void;
  /** Cleanup resources */
  dispose(): void;
}

// =============================================================================
// Constants
// =============================================================================

const MAX_SUGGESTIONS = 8;
const MAX_SUGGESTION_CACHE = 400;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Normalize class list: deduplicate, trim, remove empty tokens
 */
function normalizeClassList(input: readonly string[]): string[] {
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
 * Check if two string arrays are equal (order-sensitive)
 */
function isSameStringList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Split input string into class tokens
 */
function splitTokens(raw: string): string[] {
  return String(raw ?? '')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Read class list from element (compatible with SVG elements)
 */
function readElementClasses(element: Element): string[] {
  try {
    const list = (element as HTMLElement).classList;
    if (list && typeof list[Symbol.iterator] === 'function') {
      return Array.from(list).filter(Boolean);
    }
  } catch {
    // Fall back to attribute parsing
  }

  try {
    const raw = element.getAttribute('class') ?? '';
    return raw
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a Class Editor component
 */
export function createClassEditor(options: ClassEditorOptions): ClassEditor {
  const { container, onClassChange, getSuggestions } = options;
  const disposer = new Disposer();

  // State
  let currentTarget: Element | null = null;
  let currentClasses: string[] = [];
  let isComposing = false;

  // ==========================================================================
  // DOM Structure
  // ==========================================================================

  const root = document.createElement('div');
  root.className = 'we-class-editor';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Class editor');

  const chipsContainer = document.createElement('div');
  chipsContainer.className = 'we-class-chips';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'we-input we-class-input';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Add class';
  input.setAttribute('aria-label', 'Add class');

  const suggestionsContainer = document.createElement('div');
  suggestionsContainer.className = 'we-class-suggestions';
  suggestionsContainer.hidden = true;

  root.append(chipsContainer, input, suggestionsContainer);
  container.append(root);
  disposer.add(() => root.remove());

  // ==========================================================================
  // Rendering
  // ==========================================================================

  /**
   * Render class chips
   */
  function renderChips(): void {
    chipsContainer.innerHTML = '';

    for (const cls of currentClasses) {
      const chip = document.createElement('span');
      chip.className = 'we-class-chip';

      const text = document.createElement('span');
      text.className = 'we-class-chip-text';
      text.textContent = cls;

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'we-class-chip-remove';
      removeBtn.textContent = '×';
      removeBtn.dataset.action = 'remove';
      removeBtn.dataset.value = cls;
      removeBtn.setAttribute('aria-label', `Remove class ${cls}`);

      chip.append(text, removeBtn);
      chipsContainer.append(chip);
    }
  }

  /**
   * Hide suggestions dropdown
   */
  function hideSuggestions(): void {
    suggestionsContainer.hidden = true;
    suggestionsContainer.innerHTML = '';
  }

  /**
   * Render suggestions dropdown based on current input prefix
   */
  function renderSuggestions(): void {
    if (input.disabled) {
      hideSuggestions();
      return;
    }

    const prefix = input.value.trim();
    if (!prefix) {
      hideSuggestions();
      return;
    }

    const allSuggestions = getSuggestions?.() ?? [];
    if (!Array.isArray(allSuggestions) || allSuggestions.length === 0) {
      hideSuggestions();
      return;
    }

    // Filter suggestions: not already in list, matches prefix
    const existingSet = new Set(currentClasses);
    const seenSet = new Set<string>();
    const filtered: string[] = [];

    for (const raw of allSuggestions) {
      const s = String(raw ?? '').trim();
      if (!s) continue;
      if (existingSet.has(s)) continue;
      if (!s.startsWith(prefix)) continue;
      if (seenSet.has(s)) continue;
      seenSet.add(s);
      filtered.push(s);
      if (filtered.length >= MAX_SUGGESTIONS) break;
    }

    if (filtered.length === 0) {
      hideSuggestions();
      return;
    }

    suggestionsContainer.hidden = false;
    suggestionsContainer.innerHTML = '';

    for (const suggestion of filtered) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'we-class-suggestion';
      btn.textContent = suggestion;
      btn.dataset.action = 'suggestion';
      btn.dataset.value = suggestion;
      suggestionsContainer.append(btn);
    }
  }

  /**
   * Internal setter for class list (updates UI only)
   */
  function setClassesInternal(classes: string[]): void {
    currentClasses = normalizeClassList(classes);
    renderChips();
    renderSuggestions();
  }

  // ==========================================================================
  // Mutations (emit onClassChange)
  // ==========================================================================

  /**
   * Commit a new class list
   */
  function commitClassList(next: string[]): void {
    if (!currentTarget || !currentTarget.isConnected) return;

    const normalized = normalizeClassList(next);
    if (isSameStringList(normalized, currentClasses)) {
      renderSuggestions();
      return;
    }

    currentClasses = normalized;
    renderChips();
    renderSuggestions();
    onClassChange(currentClasses.slice());
  }

  /**
   * Add one or more class tokens
   */
  function addTokens(tokens: string[]): void {
    if (!tokens.length) return;

    const next = currentClasses.slice();
    const seenSet = new Set(next);

    for (const raw of tokens) {
      const t = String(raw ?? '').trim();
      if (!t) continue;
      if (seenSet.has(t)) continue;
      seenSet.add(t);
      next.push(t);
    }

    commitClassList(next);
  }

  /**
   * Remove a specific class token
   */
  function removeToken(token: string): void {
    const t = String(token ?? '').trim();
    if (!t) return;
    const next = currentClasses.filter((c) => c !== t);
    commitClassList(next);
  }

  /**
   * Remove the last class token
   */
  function removeLastToken(): void {
    if (currentClasses.length === 0) return;
    commitClassList(currentClasses.slice(0, -1));
  }

  /**
   * Commit tokens from input field and clear it
   */
  function commitInputTokens(): void {
    const tokens = splitTokens(input.value);
    if (tokens.length === 0) return;
    addTokens(tokens);
    input.value = '';
    renderSuggestions();
  }

  // ==========================================================================
  // Event Handlers
  // ==========================================================================

  // Prevent blur when clicking suggestions (keeps input focused)
  disposer.listen(suggestionsContainer, 'mousedown', (e) => {
    e.preventDefault();
  });

  // Handle chip remove button clicks
  disposer.listen(chipsContainer, 'click', (e) => {
    const target = e.target as HTMLElement | null;
    const btn = target?.closest?.('button[data-action="remove"]') as HTMLButtonElement | null;
    const value = btn?.dataset?.value;
    if (!btn || !value) return;
    e.preventDefault();
    removeToken(value);
  });

  // Handle suggestion clicks
  disposer.listen(suggestionsContainer, 'click', (e) => {
    const target = e.target as HTMLElement | null;
    const btn = target?.closest?.('button[data-action="suggestion"]') as HTMLButtonElement | null;
    const value = btn?.dataset?.value;
    if (!btn || !value) return;
    e.preventDefault();
    addTokens([value]);
    input.value = '';
    renderSuggestions();
    input.focus();
  });

  // Track composition state (IME input)
  disposer.listen(input, 'compositionstart', () => {
    isComposing = true;
  });

  disposer.listen(input, 'compositionend', () => {
    isComposing = false;
    renderSuggestions();
  });

  // Update suggestions on input
  disposer.listen(input, 'input', () => {
    renderSuggestions();
  });

  // Hide suggestions on blur
  disposer.listen(input, 'blur', () => {
    hideSuggestions();
  });

  // Handle paste events (split multiple tokens)
  disposer.listen(input, 'paste', () => {
    // Allow the paste to update the input value first
    window.setTimeout(() => {
      if (disposer.isDisposed) return;
      const tokens = splitTokens(input.value);
      if (tokens.length > 1) {
        commitInputTokens();
      } else {
        renderSuggestions();
      }
    }, 0);
  });

  // Handle keyboard interactions
  disposer.listen(input, 'keydown', (e: KeyboardEvent) => {
    if (input.disabled) return;

    // Enter: commit current input
    if (e.key === 'Enter') {
      if (isComposing) return;
      e.preventDefault();
      commitInputTokens();
      return;
    }

    // Space: commit current input (if not empty)
    if (e.key === ' ') {
      if (isComposing) return;
      if (input.value.trim()) {
        e.preventDefault();
        commitInputTokens();
      }
      return;
    }

    // Backspace: remove last chip when input is empty
    if (e.key === 'Backspace') {
      if (!input.value && currentClasses.length > 0) {
        e.preventDefault();
        removeLastToken();
      }
      return;
    }

    // Escape: hide suggestions or clear input
    if (e.key === 'Escape') {
      if (!suggestionsContainer.hidden) {
        e.preventDefault();
        hideSuggestions();
      } else if (input.value) {
        e.preventDefault();
        input.value = '';
        renderSuggestions();
      }
    }
  });

  // ==========================================================================
  // Public API
  // ==========================================================================

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;

    currentTarget = element && element.isConnected ? element : null;
    input.value = '';
    hideSuggestions();
    input.disabled = !currentTarget;

    if (!currentTarget) {
      setClassesInternal([]);
      return;
    }

    setClassesInternal(readElementClasses(currentTarget));
  }

  function setClasses(classes: string[]): void {
    if (disposer.isDisposed) return;
    setClassesInternal(classes);
  }

  function refresh(): void {
    if (disposer.isDisposed) return;

    const target = currentTarget;
    if (!target || !target.isConnected) {
      setTarget(null);
      return;
    }

    setClassesInternal(readElementClasses(target));
  }

  function dispose(): void {
    currentTarget = null;
    currentClasses = [];
    disposer.dispose();
  }

  // Initial state
  setTarget(null);

  return {
    setTarget,
    setClasses,
    refresh,
    dispose,
  };
}

export { MAX_SUGGESTION_CACHE };
