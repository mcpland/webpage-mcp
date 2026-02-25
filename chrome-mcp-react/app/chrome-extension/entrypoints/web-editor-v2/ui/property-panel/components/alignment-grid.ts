/**
 * Alignment Grid (Phase 4.2)
 *
 * 3×3 single-select grid that maps:
 * - columns -> `justify-content` (flex-start, center, flex-end)
 * - rows    -> `align-items` (flex-start, center, flex-end)
 *
 * Design spec pattern (attr-ui.html:166-176):
 * ```html
 * <div class="p-2 bg-[#F9F9F9] border border-gray-100 rounded grid grid-cols-3 gap-3">
 *   <div class="w-0.5 h-0.5 bg-gray-400 rounded-full"></div>  <!-- inactive dot -->
 *   <div class="w-3 h-3 flex flex-col justify-between ...">   <!-- active marker -->
 *     <div class="w-2 h-0.5 bg-blue-500"></div>
 *     ...
 *   </div>
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

export interface AlignmentGridValue {
  justifyContent: string;
  alignItems: string;
}

export interface AlignmentGridOptions {
  /** Container element to mount the grid */
  container: HTMLElement;
  /** Accessible label for the grid */
  ariaLabel: string;
  /** Left/center/right values for `justify-content` (default: flex-start/center/flex-end) */
  justifyValues?: readonly [string, string, string];
  /** Top/center/bottom values for `align-items` (default: flex-start/center/flex-end) */
  alignValues?: readonly [string, string, string];
  /** Initial value */
  value?: AlignmentGridValue | null;
  /** Disable the grid */
  disabled?: boolean;
  /** Called when selection changes via user interaction */
  onChange?: (value: AlignmentGridValue) => void;
}

export interface AlignmentGrid {
  /** Root container element */
  root: HTMLDivElement;
  /** Get current selected value */
  getValue(): AlignmentGridValue | null;
  /** Set selected value (does not trigger onChange) */
  setValue(value: AlignmentGridValue | null): void;
  /** Enable/disable the grid */
  setDisabled(disabled: boolean): void;
  /** Cleanup resources */
  dispose(): void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_AXIS_VALUES: readonly [string, string, string] = ['flex-start', 'center', 'flex-end'];

// =============================================================================
// Helpers
// =============================================================================

function indexOf3(values: readonly [string, string, string], v: string): number {
  for (let i = 0; i < 3; i++) {
    if (values[i] === v) return i;
  }
  return -1;
}

function copyValue(v: AlignmentGridValue): AlignmentGridValue {
  return { justifyContent: String(v.justifyContent), alignItems: String(v.alignItems) };
}

/** Build the visual marker (3 bars representing alignment) */
function buildMarker(): HTMLElement {
  const marker = document.createElement('span');
  marker.className = 'we-alignment-grid__marker';
  marker.setAttribute('aria-hidden', 'true');

  // Three bars of different widths to show alignment direction
  const bar1 = document.createElement('span');
  bar1.className = 'we-alignment-grid__bar we-alignment-grid__bar--1';
  const bar2 = document.createElement('span');
  bar2.className = 'we-alignment-grid__bar we-alignment-grid__bar--2';
  const bar3 = document.createElement('span');
  bar3.className = 'we-alignment-grid__bar we-alignment-grid__bar--3';

  marker.append(bar1, bar2, bar3);
  return marker;
}

// =============================================================================
// Factory
// =============================================================================

export function createAlignmentGrid(options: AlignmentGridOptions): AlignmentGrid {
  const { container, ariaLabel, onChange } = options;
  const disposer = new Disposer();

  const justifyValues = options.justifyValues ?? DEFAULT_AXIS_VALUES;
  const alignValues = options.alignValues ?? DEFAULT_AXIS_VALUES;

  let isDisabled = Boolean(options.disabled);
  let currentValue: AlignmentGridValue | null = null;

  // Root container
  const root = document.createElement('div');
  root.className = 'we-alignment-grid';
  root.setAttribute('role', 'grid');
  root.setAttribute('aria-label', ariaLabel);

  container.append(root);
  disposer.add(() => root.remove());

  // Cell data structure
  interface CellData {
    button: HTMLButtonElement;
    dot: HTMLElement;
    marker: HTMLElement;
    value: AlignmentGridValue;
    index: number;
  }
  const cells: CellData[] = [];

  // ==========================================================================
  // Sync Functions
  // ==========================================================================

  function syncDisabled(): void {
    root.setAttribute('aria-disabled', String(isDisabled));
    for (const c of cells) {
      c.button.disabled = isDisabled;
    }
  }

  function syncSelection(): void {
    const selectedKey = currentValue
      ? `${currentValue.justifyContent}|||${currentValue.alignItems}`
      : null;

    let tabIndex = -1;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i]!;
      const key = `${c.value.justifyContent}|||${c.value.alignItems}`;
      const selected = selectedKey !== null && key === selectedKey;

      c.button.dataset.selected = selected ? 'true' : 'false';
      c.button.setAttribute('aria-selected', selected ? 'true' : 'false');
      c.dot.hidden = selected;
      c.marker.hidden = !selected;

      if (selected && !c.button.disabled) tabIndex = i;
    }

    // Default to first cell if nothing selected
    if (tabIndex < 0) {
      tabIndex = isDisabled ? -1 : 0;
    }

    for (let i = 0; i < cells.length; i++) {
      cells[i]!.button.tabIndex = i === tabIndex ? 0 : -1;
    }
  }

  function setValueInternal(next: AlignmentGridValue | null, emit: boolean): void {
    const nextKey = next ? `${next.justifyContent}|||${next.alignItems}` : null;
    const prevKey = currentValue
      ? `${currentValue.justifyContent}|||${currentValue.alignItems}`
      : null;

    currentValue = next ? copyValue(next) : null;
    syncSelection();

    if (emit && nextKey !== null && nextKey !== prevKey) {
      onChange?.(copyValue(currentValue!));
    }
  }

  // ==========================================================================
  // Keyboard Navigation
  // ==========================================================================

  function getActiveIndex(): number {
    // Use getRootNode() for Shadow DOM compatibility
    const rootNode = root.getRootNode();
    const active = rootNode instanceof ShadowRoot ? rootNode.activeElement : document.activeElement;
    const focusIndex = cells.findIndex((c) => c.button === active);
    if (focusIndex >= 0) return focusIndex;

    if (currentValue) {
      const key = `${currentValue.justifyContent}|||${currentValue.alignItems}`;
      const selectedIndex = cells.findIndex(
        (c) => `${c.value.justifyContent}|||${c.value.alignItems}` === key,
      );
      if (selectedIndex >= 0) return selectedIndex;
    }

    return 0;
  }

  function focusAndSelect(index: number, emit: boolean): void {
    const c = cells[index];
    if (!c) return;
    if (c.button.disabled) return;
    setValueInternal(c.value, emit);
    c.button.focus();
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (isDisabled) return;
    if (cells.length !== 9) return;

    const active = getActiveIndex();
    const row = Math.floor(active / 3);
    const col = active % 3;

    let nextIndex: number | null = null;

    switch (e.key) {
      case 'ArrowLeft':
        nextIndex = row * 3 + Math.max(0, col - 1);
        break;
      case 'ArrowRight':
        nextIndex = row * 3 + Math.min(2, col + 1);
        break;
      case 'ArrowUp':
        nextIndex = Math.max(0, row - 1) * 3 + col;
        break;
      case 'ArrowDown':
        nextIndex = Math.min(2, row + 1) * 3 + col;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = 8;
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        focusAndSelect(active, true);
        return;
      default:
        return;
    }

    if (nextIndex !== null) {
      e.preventDefault();
      focusAndSelect(nextIndex, true);
    }
  }

  // ==========================================================================
  // Build 3×3 Grid (row-major order)
  // ==========================================================================

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const justifyContent = justifyValues[c]!;
      const alignItems = alignValues[r]!;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'we-alignment-grid__cell';
      button.setAttribute('role', 'gridcell');
      button.setAttribute(
        'aria-label',
        `justify-content: ${justifyContent}; align-items: ${alignItems}`,
      );
      button.dataset.row = String(r);
      button.dataset.col = String(c);

      // Inactive state: small dot
      const dot = document.createElement('span');
      dot.className = 'we-alignment-grid__dot';
      dot.setAttribute('aria-hidden', 'true');

      // Active state: alignment marker (3 bars)
      const marker = buildMarker();
      marker.hidden = true;

      button.append(dot, marker);

      const index = r * 3 + c;
      const value: AlignmentGridValue = { justifyContent, alignItems };
      cells.push({ button, dot, marker, value, index });

      disposer.listen(button, 'click', (ev: MouseEvent) => {
        ev.preventDefault();
        if (isDisabled) return;
        focusAndSelect(index, true);
      });
      disposer.listen(button, 'keydown', handleKeyDown);

      root.append(button);
    }
  }

  // ==========================================================================
  // Initial State
  // ==========================================================================

  syncDisabled();
  if (options.value) {
    const j = indexOf3(justifyValues, options.value.justifyContent);
    const a = indexOf3(alignValues, options.value.alignItems);
    if (j >= 0 && a >= 0) {
      setValueInternal({ justifyContent: justifyValues[j]!, alignItems: alignValues[a]! }, false);
    } else {
      setValueInternal(null, false);
    }
  } else {
    setValueInternal(null, false);
  }

  // ==========================================================================
  // Public Interface
  // ==========================================================================

  return {
    root,

    getValue(): AlignmentGridValue | null {
      return currentValue ? copyValue(currentValue) : null;
    },

    setValue(value: AlignmentGridValue | null): void {
      if (!value) {
        setValueInternal(null, false);
        return;
      }
      const j = indexOf3(justifyValues, String(value.justifyContent));
      const a = indexOf3(alignValues, String(value.alignItems));
      if (j < 0 || a < 0) {
        setValueInternal(null, false);
        return;
      }
      setValueInternal({ justifyContent: justifyValues[j]!, alignItems: alignValues[a]! }, false);
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
