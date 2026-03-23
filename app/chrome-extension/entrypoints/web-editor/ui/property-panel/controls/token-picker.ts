/**
 * Token Picker Control (Phase 5.4)
 *
 * A dropdown picker for selecting CSS design tokens (custom properties).
 * Integrates with DesignTokensService for token discovery and resolution.
 *
 * Features:
 * - Shows available tokens for the current element context
 * - Filter tokens by typing
 * - Preview token computed value
 * - Select token to apply var(--token) to a CSS property
 * - "Show all" toggle for full root token list vs context tokens
 *
 * Usage pattern:
 * - Attach to an input field as an "enhancement"
 * - When user clicks the token button, show dropdown
 * - On selection, callback returns the var(--token) value
 */

import { Disposer } from '../../../utils/disposables';
import type { ContextToken, CssVarName, DesignTokensService } from '../../../core/design-tokens';

// =============================================================================
// Types
// =============================================================================

/** Options for creating a token picker */
export interface TokenPickerOptions {
  /** Container element (should be positioned relative) */
  container: HTMLElement;
  /** Design tokens service instance */
  tokensService: DesignTokensService;
  /** Called when user selects a token */
  onSelect: (tokenName: CssVarName, cssValue: string) => void;
  /** Optional filter by token kind (future use) */
  tokenKind?: 'color' | 'length' | 'all';
  /** Max items to show before scrolling */
  maxVisible?: number;
}

/** Token picker public interface */
export interface TokenPicker {
  /** Set the target element (tokens are filtered by context) */
  setTarget(element: Element | null): void;
  /** Show the picker dropdown */
  show(): void;
  /** Hide the picker dropdown */
  hide(): void;
  /** Toggle dropdown visibility */
  toggle(): boolean;
  /** Check if dropdown is visible */
  isVisible(): boolean;
  /** Refresh token list */
  refresh(): void;
  /** Cleanup */
  dispose(): void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MAX_VISIBLE = 8;
const FILTER_DEBOUNCE_MS = 100;

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a token picker component.
 */
export function createTokenPicker(options: TokenPickerOptions): TokenPicker {
  const { container, tokensService, onSelect, maxVisible = DEFAULT_MAX_VISIBLE } = options;

  const disposer = new Disposer();

  // State
  let currentTarget: Element | null = null;
  let contextTokens: ContextToken[] = [];
  let filteredTokens: ContextToken[] = [];
  let showAllTokens = false;
  let filterText = '';
  let filterTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let selectedIndex = -1;

  // ===========================================================================
  // DOM Structure
  // ===========================================================================

  const root = document.createElement('div');
  root.className = 'we-token-picker';
  root.hidden = true;

  // Filter input
  const filterInput = document.createElement('input');
  filterInput.type = 'text';
  filterInput.className = 'we-token-filter';
  filterInput.placeholder = 'Filter tokens...';
  filterInput.autocomplete = 'off';
  filterInput.spellcheck = false;

  // Toggle for "show all"
  const toggleRow = document.createElement('div');
  toggleRow.className = 'we-token-toggle-row';

  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'we-token-toggle-label';

  const toggleCheckbox = document.createElement('input');
  toggleCheckbox.type = 'checkbox';
  toggleCheckbox.className = 'we-token-toggle-checkbox';

  const toggleText = document.createElement('span');
  toggleText.textContent = 'Show all root tokens';

  toggleLabel.append(toggleCheckbox, toggleText);
  toggleRow.append(toggleLabel);

  // Token list
  const listContainer = document.createElement('div');
  listContainer.className = 'we-token-list';
  listContainer.style.maxHeight = `${maxVisible * 36}px`;

  // Empty state
  const emptyState = document.createElement('div');
  emptyState.className = 'we-token-empty';
  emptyState.textContent = 'No tokens found';
  emptyState.hidden = true;

  root.append(filterInput, toggleRow, listContainer, emptyState);
  container.append(root);
  disposer.add(() => root.remove());

  // ===========================================================================
  // Token Loading
  // ===========================================================================

  function loadTokens(): void {
    if (!currentTarget || !currentTarget.isConnected) {
      contextTokens = [];
      filteredTokens = [];
      return;
    }

    if (showAllTokens) {
      // Get all root tokens
      const root = currentTarget.getRootNode() as Document | ShadowRoot;
      const result = tokensService.getRootTokens(root);
      // Convert to ContextToken format with computed values
      contextTokens = result.tokens.map((token) => {
        const resolution = tokensService.resolveToken(currentTarget!, token.name);
        return {
          token,
          computedValue: resolution.computedValue,
        };
      });
    } else {
      // Get only context-available tokens
      const result = tokensService.getContextTokens(currentTarget);
      contextTokens = [...result.tokens];
    }

    applyFilter();
  }

  function applyFilter(): void {
    const query = filterText.toLowerCase().trim();

    if (!query) {
      filteredTokens = contextTokens;
    } else {
      filteredTokens = contextTokens.filter((ct) => {
        const name = ct.token.name.toLowerCase();
        const value = ct.computedValue.toLowerCase();
        return name.includes(query) || value.includes(query);
      });
    }

    selectedIndex = filteredTokens.length > 0 ? 0 : -1;
    renderList();
  }

  // ===========================================================================
  // Rendering
  // ===========================================================================

  function renderList(): void {
    listContainer.innerHTML = '';

    if (filteredTokens.length === 0) {
      emptyState.hidden = false;
      listContainer.hidden = true;
      return;
    }

    emptyState.hidden = true;
    listContainer.hidden = false;

    for (let i = 0; i < filteredTokens.length; i++) {
      const ct = filteredTokens[i]!;
      const item = createTokenItem(ct, i);
      listContainer.append(item);
    }

    updateSelectedHighlight();
  }

  function createTokenItem(ct: ContextToken, index: number): HTMLElement {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'we-token-item';
    item.dataset.index = String(index);
    item.dataset.name = ct.token.name;

    // Token name
    const nameEl = document.createElement('span');
    nameEl.className = 'we-token-name';
    nameEl.textContent = ct.token.name;

    // Computed value preview
    const valueEl = document.createElement('span');
    valueEl.className = 'we-token-value';
    valueEl.textContent = ct.computedValue || '(unset)';

    // Color swatch for color-like values
    const computedLower = ct.computedValue.toLowerCase();
    const isColor =
      computedLower.startsWith('#') ||
      computedLower.startsWith('rgb') ||
      computedLower.startsWith('hsl') ||
      /^[a-z]+$/.test(computedLower); // Named colors

    if (isColor && ct.computedValue) {
      const swatch = document.createElement('span');
      swatch.className = 'we-token-swatch';
      swatch.style.backgroundColor = ct.computedValue;
      item.append(swatch);
    }

    item.append(nameEl, valueEl);
    return item;
  }

  function updateSelectedHighlight(): void {
    const items = listContainer.querySelectorAll('.we-token-item');
    items.forEach((item, i) => {
      item.classList.toggle('we-token-item--selected', i === selectedIndex);
    });

    // Scroll selected item into view
    if (selectedIndex >= 0 && selectedIndex < items.length) {
      const selectedItem = items[selectedIndex] as HTMLElement;
      selectedItem.scrollIntoView({ block: 'nearest' });
    }
  }

  // ===========================================================================
  // Selection
  // ===========================================================================

  function selectToken(index: number): void {
    if (index < 0 || index >= filteredTokens.length) return;

    const ct = filteredTokens[index]!;
    const cssValue = tokensService.formatCssVar(ct.token.name);

    hide();
    onSelect(ct.token.name, cssValue);
  }

  function selectCurrent(): void {
    if (selectedIndex >= 0) {
      selectToken(selectedIndex);
    }
  }

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  // Filter input
  disposer.listen(filterInput, 'input', () => {
    filterText = filterInput.value;

    // Debounce filter
    if (filterTimeoutId) {
      clearTimeout(filterTimeoutId);
    }
    filterTimeoutId = setTimeout(() => {
      filterTimeoutId = null;
      applyFilter();
    }, FILTER_DEBOUNCE_MS);
  });

  // Keyboard navigation
  disposer.listen(filterInput, 'keydown', (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (filteredTokens.length > 0) {
          selectedIndex = Math.min(selectedIndex + 1, filteredTokens.length - 1);
          updateSelectedHighlight();
        }
        break;

      case 'ArrowUp':
        e.preventDefault();
        if (filteredTokens.length > 0) {
          selectedIndex = Math.max(selectedIndex - 1, 0);
          updateSelectedHighlight();
        }
        break;

      case 'Enter':
        e.preventDefault();
        selectCurrent();
        break;

      case 'Escape':
        e.preventDefault();
        hide();
        break;
    }
  });

  // Toggle checkbox
  disposer.listen(toggleCheckbox, 'change', () => {
    showAllTokens = toggleCheckbox.checked;
    loadTokens();
  });

  // Item clicks
  disposer.listen(listContainer, 'click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const item = target.closest('.we-token-item') as HTMLElement | null;
    if (!item) return;

    const index = parseInt(item.dataset.index ?? '-1', 10);
    if (index >= 0) {
      selectToken(index);
    }
  });

  // Prevent blur when clicking inside picker
  disposer.listen(root, 'mousedown', (e: MouseEvent) => {
    e.preventDefault();
  });

  // ===========================================================================
  // Public API
  // ===========================================================================

  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;

    currentTarget = element && element.isConnected ? element : null;
    filterText = '';
    filterInput.value = '';

    if (root.hidden) return; // Only load if visible
    loadTokens();
  }

  function show(): void {
    if (disposer.isDisposed) return;
    if (!root.hidden) return;

    root.hidden = false;
    loadTokens();
    filterInput.focus();
  }

  function hide(): void {
    if (disposer.isDisposed) return;
    root.hidden = true;
    filterText = '';
    filterInput.value = '';
    selectedIndex = -1;
  }

  function toggle(): boolean {
    if (root.hidden) {
      show();
      return true;
    } else {
      hide();
      return false;
    }
  }

  function isVisible(): boolean {
    return !root.hidden;
  }

  function refresh(): void {
    if (disposer.isDisposed) return;
    if (root.hidden) return;
    loadTokens();
  }

  function dispose(): void {
    if (filterTimeoutId) {
      clearTimeout(filterTimeoutId);
      filterTimeoutId = null;
    }
    currentTarget = null;
    contextTokens = [];
    filteredTokens = [];
    disposer.dispose();
  }

  return {
    setTarget,
    show,
    hide,
    toggle,
    isVisible,
    refresh,
    dispose,
  };
}
