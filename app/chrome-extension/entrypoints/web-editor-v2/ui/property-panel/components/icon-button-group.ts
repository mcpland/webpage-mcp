/**
 * Icon Button Group (Phase 4.1)
 *
 * A single-select grid of icon buttons (e.g. Flow controls for `flex-direction`).
 *
 * Design spec pattern (attr-ui.html:136-141):
 * ```html
 * <div class="grid grid-cols-4 gap-1">
 *   <button class="bg-[#F3F3F3] hover:bg-gray-200 rounded p-1 flex justify-center items-center">
 *     <svg>...</svg>
 *   </button>
 *   ...
 * </div>
 * ```
 *
 * Notes:
 * - `setValue()` updates UI without calling `onChange`.
 * - `onChange` fires only on user interaction.
 */

import { Disposer } from '../../../utils/disposables';

// =============================================================================
// Types
// =============================================================================

export interface IconButtonGroupItem<T extends string = string> {
  /** Value associated with this button */
  value: T;
  /** Accessible label for screen readers */
  ariaLabel: string;
  /** Tooltip text */
  title?: string;
  /** Icon node (SVG element) - will be cloned for each button */
  icon: Node;
  /** Disable this specific button */
  disabled?: boolean;
}

export interface IconButtonGroupOptions<T extends string = string> {
  /** Container element to mount the group */
  container: HTMLElement;
  /** Accessible label for the group */
  ariaLabel: string;
  /** Button items */
  items: readonly IconButtonGroupItem<T>[];
  /** Grid columns (default: items.length) */
  columns?: number;
  /** Initial selected value */
  value?: T | null;
  /** Disable the entire group */
  disabled?: boolean;
  /** Called when selection changes via user interaction */
  onChange?: (value: T) => void;
}

export interface IconButtonGroup<T extends string = string> {
  /** Root container element */
  root: HTMLDivElement;
  /** Get current selected value */
  getValue(): T | null;
  /** Set selected value (does not trigger onChange) */
  setValue(value: T | null): void;
  /** Enable/disable the entire group */
  setDisabled(disabled: boolean): void;
  /** Cleanup resources */
  dispose(): void;
}

// =============================================================================
// Helpers
// =============================================================================

function cloneForDom(node: Node): Node {
  try {
    return node.cloneNode(true);
  } catch {
    return node;
  }
}

function findSelectedIndex<T extends string>(
  items: readonly IconButtonGroupItem<T>[],
  value: T | null,
): number {
  if (value === null) return -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.value === value) return i;
  }
  return -1;
}

function findFirstEnabledIndex(buttons: readonly HTMLButtonElement[]): number {
  for (let i = 0; i < buttons.length; i++) {
    if (!buttons[i]!.disabled) return i;
  }
  return -1;
}

function findLastEnabledIndex(buttons: readonly HTMLButtonElement[]): number {
  for (let i = buttons.length - 1; i >= 0; i--) {
    if (!buttons[i]!.disabled) return i;
  }
  return -1;
}

// =============================================================================
// Factory
// =============================================================================

export function createIconButtonGroup<T extends string = string>(
  options: IconButtonGroupOptions<T>,
): IconButtonGroup<T> {
  const { container, ariaLabel, items, onChange } = options;
  const disposer = new Disposer();

  let isDisabled = Boolean(options.disabled);
  let currentValue: T | null = null;

  // Root container
  const root = document.createElement('div');
  root.className = 'we-icon-button-group';
  root.setAttribute('role', 'radiogroup');
  root.setAttribute('aria-label', ariaLabel);

  // Grid layout
  const columns = Math.max(1, options.columns ?? items.length);
  root.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;

  container.append(root);
  disposer.add(() => root.remove());

  const buttons: HTMLButtonElement[] = [];

  // ==========================================================================
  // Sync Functions
  // ==========================================================================

  function syncDisabled(): void {
    root.setAttribute('aria-disabled', String(isDisabled));
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i]!;
      const item = items[i]!;
      btn.disabled = isDisabled || Boolean(item.disabled);
    }
  }

  function syncSelection(): void {
    const selectedIndex = findSelectedIndex(items, currentValue);
    const tabIndex =
      selectedIndex >= 0 && !buttons[selectedIndex]!.disabled
        ? selectedIndex
        : findFirstEnabledIndex(buttons);

    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i]!;
      const item = items[i]!;
      const selected = currentValue !== null && item.value === currentValue;
      btn.setAttribute('aria-checked', selected ? 'true' : 'false');
      btn.dataset.selected = selected ? 'true' : 'false';
      btn.tabIndex = i === tabIndex ? 0 : -1;
    }
  }

  function setValueInternal(next: T | null, emit: boolean): void {
    const nextIndex = findSelectedIndex(items, next);
    if (next !== null && nextIndex < 0) next = null;

    const changed = next !== currentValue;
    currentValue = next;
    syncSelection();

    if (emit && changed && currentValue !== null) {
      onChange?.(currentValue);
    }
  }

  // ==========================================================================
  // Keyboard Navigation
  // ==========================================================================

  function getActiveIndex(): number {
    // Use getRootNode() for Shadow DOM compatibility
    const rootNode = root.getRootNode();
    const active = rootNode instanceof ShadowRoot ? rootNode.activeElement : document.activeElement;
    const focusIndex = buttons.findIndex((b) => b === active);
    if (focusIndex >= 0) return focusIndex;

    const selectedIndex = findSelectedIndex(items, currentValue);
    if (selectedIndex >= 0) return selectedIndex;

    const firstEnabled = findFirstEnabledIndex(buttons);
    return firstEnabled >= 0 ? firstEnabled : 0;
  }

  function findEnabledFrom(start: number, delta: number): number {
    if (delta === 0) return -1;
    for (let i = start; i >= 0 && i < buttons.length; i += delta) {
      if (!buttons[i]!.disabled) return i;
    }
    return -1;
  }

  function selectByIndex(nextIndex: number, emit: boolean): void {
    if (nextIndex < 0 || nextIndex >= items.length) return;
    const btn = buttons[nextIndex]!;
    if (btn.disabled) return;
    setValueInternal(items[nextIndex]!.value, emit);
    btn.focus();
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (isDisabled) return;
    if (buttons.length === 0) return;

    const active = getActiveIndex();
    let next: number | null = null;

    switch (e.key) {
      case 'ArrowLeft':
        next = findEnabledFrom(active - 1, -1);
        break;
      case 'ArrowRight':
        next = findEnabledFrom(active + 1, 1);
        break;
      case 'ArrowUp':
        next = findEnabledFrom(active - columns, -columns);
        break;
      case 'ArrowDown':
        next = findEnabledFrom(active + columns, columns);
        break;
      case 'Home':
        next = findFirstEnabledIndex(buttons);
        break;
      case 'End':
        next = findLastEnabledIndex(buttons);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        selectByIndex(active, true);
        return;
      default:
        return;
    }

    if (next !== null && next >= 0) {
      e.preventDefault();
      selectByIndex(next, true);
    }
  }

  // ==========================================================================
  // Build Buttons
  // ==========================================================================

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'we-icon-button-group__btn';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', item.ariaLabel);
    if (item.title) btn.dataset.tooltip = item.title;
    btn.dataset.value = item.value;
    btn.append(cloneForDom(item.icon));

    disposer.listen(btn, 'click', (ev: MouseEvent) => {
      ev.preventDefault();
      if (isDisabled || btn.disabled) return;
      setValueInternal(item.value, true);
      btn.focus();
    });

    disposer.listen(btn, 'keydown', handleKeyDown);

    buttons.push(btn);
    root.append(btn);
  }

  // Initial state
  syncDisabled();
  const initialValue = options.value ?? items[0]?.value ?? null;
  setValueInternal(initialValue, false);

  // ==========================================================================
  // Public Interface
  // ==========================================================================

  return {
    root,

    getValue(): T | null {
      return currentValue;
    },

    setValue(value: T | null): void {
      setValueInternal(value, false);
    },

    setDisabled(disabled: boolean): void {
      isDisabled = disabled;
      syncDisabled();
      syncSelection();
    },

    dispose(): void {
      disposer.dispose();
    },
  };
}
