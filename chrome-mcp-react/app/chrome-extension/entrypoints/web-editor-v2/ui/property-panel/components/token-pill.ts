/**
 * Token Pill Component (Phase 5.3)
 *
 * A compact pill UI for displaying a CSS custom property (var()) reference.
 * Used in ColorField and potentially other inputs to show token-bound values.
 *
 * Features:
 * - Displays token name with optional color swatch preview
 * - Click pill to open Token Picker
 * - Hover to reveal clear (×) button for detaching token
 * - Supports external leading element injection (e.g., ColorField swatch)
 *
 * Design reference: token.png and attr-ui.html:699-727
 */

import { Disposer } from '../../../utils/disposables';

// =============================================================================
// Constants
// =============================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';

// Link icon path (rotated 45° via CSS to indicate "variable binding")
const LINK_ICON_PATH =
  'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m0-5.656' +
  'a4 4 0 015.656 0l4 4a4 4 0 11-5.656 5.656l-1.1-1.102';

// =============================================================================
// Types
// =============================================================================

export interface TokenPillOptions {
  /** Container element to mount the pill into */
  container: HTMLElement;
  /** Accessible label for the pill */
  ariaLabel: string;
  /** Token name to display (e.g., "--color-primary") */
  tokenName: string;
  /** Preview color for internal swatch (used when no leadingElement provided) */
  previewColor?: string | null;
  /** External leading element (e.g., ColorField swatch button) - overrides internal swatch */
  leadingElement?: HTMLElement | null;
  /** Whether the pill is disabled */
  disabled?: boolean;
  /** Callback when pill main area is clicked (typically opens Token Picker) */
  onClick?: () => void;
  /** Callback when clear button is clicked (detaches token) */
  onClear?: () => void;
}

export interface TokenPill {
  /** Root element of the pill */
  root: HTMLDivElement;
  /** Update the token name display */
  setTokenName(name: string): void;
  /** Update the preview color (for internal swatch) */
  setPreviewColor(color: string | null): void;
  /** Set external leading element (null to use internal swatch) */
  setLeadingElement(el: HTMLElement | null): void;
  /** Set disabled state */
  setDisabled(disabled: boolean): void;
  /** Focus the pill main button */
  focus(): void;
  /** Cleanup and remove the pill */
  dispose(): void;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a token pill component.
 */
export function createTokenPill(options: TokenPillOptions): TokenPill {
  const {
    container,
    ariaLabel,
    tokenName,
    previewColor = null,
    leadingElement = null,
    disabled = false,
    onClick,
    onClear,
  } = options;

  const disposer = new Disposer();

  // Internal state
  let isDisabled = Boolean(disabled);
  let currentTokenName = String(tokenName ?? '');
  let currentPreviewColor = typeof previewColor === 'string' ? previewColor : null;
  let currentLeadingElement: HTMLElement | null = leadingElement ?? null;

  // ===========================================================================
  // DOM Structure
  // ===========================================================================

  // Root container
  const root = document.createElement('div');
  root.className = 'we-token-pill';
  root.dataset.disabled = isDisabled ? 'true' : 'false';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', ariaLabel);

  // Leading slot (holds either external element or internal swatch)
  const leadingSlot = document.createElement('div');
  leadingSlot.className = 'we-token-pill__leading';

  // Internal swatch (used when no external leading element)
  const internalSwatch = document.createElement('div');
  internalSwatch.className = 'we-token-pill__swatch';
  internalSwatch.setAttribute('aria-hidden', 'true');

  // Main button (click to open picker)
  const mainBtn = document.createElement('button');
  mainBtn.type = 'button';
  mainBtn.className = 'we-token-pill__main';
  mainBtn.setAttribute('aria-label', ariaLabel);
  mainBtn.dataset.tooltip = 'Change token';

  // Token name text
  const nameEl = document.createElement('span');
  nameEl.className = 'we-token-pill__name';

  // Link icon (indicates variable binding)
  const linkIcon = document.createElementNS(SVG_NS, 'svg');
  linkIcon.setAttribute('viewBox', '0 0 24 24');
  linkIcon.setAttribute('fill', 'none');
  linkIcon.setAttribute('aria-hidden', 'true');
  linkIcon.classList.add('we-token-pill__icon');

  const iconPath = document.createElementNS(SVG_NS, 'path');
  iconPath.setAttribute('d', LINK_ICON_PATH);
  iconPath.setAttribute('stroke', 'currentColor');
  iconPath.setAttribute('stroke-width', '2');
  iconPath.setAttribute('stroke-linecap', 'round');
  iconPath.setAttribute('stroke-linejoin', 'round');
  linkIcon.append(iconPath);

  mainBtn.append(nameEl, linkIcon);

  // Clear button (detach token)
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'we-token-pill__clear';
  clearBtn.setAttribute('aria-label', 'Clear token');
  clearBtn.dataset.tooltip = 'Clear token';
  clearBtn.textContent = '×';

  // Assemble structure
  root.append(leadingSlot, mainBtn, clearBtn);
  container.append(root);
  disposer.add(() => root.remove());

  // ===========================================================================
  // Sync Functions
  // ===========================================================================

  /** Sync leading slot content (external element or internal swatch) */
  function syncLeading(): void {
    // Clear existing content
    while (leadingSlot.firstChild) {
      leadingSlot.removeChild(leadingSlot.firstChild);
    }

    if (currentLeadingElement) {
      // Use external leading element
      leadingSlot.append(currentLeadingElement);
    } else {
      // Use internal swatch with preview color
      internalSwatch.style.backgroundColor = currentPreviewColor ?? '';
      leadingSlot.append(internalSwatch);
    }
  }

  /** Sync token name display */
  function syncText(): void {
    nameEl.textContent = currentTokenName;
  }

  /** Sync disabled state */
  function syncDisabled(): void {
    root.dataset.disabled = isDisabled ? 'true' : 'false';
    mainBtn.disabled = isDisabled;
    clearBtn.disabled = isDisabled;

    // Also disable external leading element if it's a button
    if (currentLeadingElement instanceof HTMLButtonElement) {
      currentLeadingElement.disabled = isDisabled;
    }
  }

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  // Main button click -> open token picker
  disposer.listen(mainBtn, 'click', (e: MouseEvent) => {
    e.preventDefault();
    if (isDisabled) return;
    onClick?.();
  });

  // Clear button click -> detach token
  disposer.listen(clearBtn, 'click', (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isDisabled) return;
    onClear?.();
  });

  // Keyboard support on pill root
  disposer.listen(root, 'keydown', (e: KeyboardEvent) => {
    if (isDisabled) return;

    // Backspace/Delete on pill -> clear token
    if (e.key === 'Backspace' || e.key === 'Delete') {
      // Use composedPath for Shadow DOM compatibility
      const path = e.composedPath();
      if (path.includes(mainBtn) || path.includes(root)) {
        e.preventDefault();
        onClear?.();
      }
    }
  });

  // ===========================================================================
  // Initial Sync
  // ===========================================================================

  syncLeading();
  syncText();
  syncDisabled();

  // ===========================================================================
  // Public Interface
  // ===========================================================================

  return {
    root,

    setTokenName(name: string): void {
      currentTokenName = String(name ?? '');
      syncText();
    },

    setPreviewColor(color: string | null): void {
      currentPreviewColor = typeof color === 'string' ? color : null;
      // Only update if using internal swatch
      if (!currentLeadingElement) {
        internalSwatch.style.backgroundColor = currentPreviewColor ?? '';
      }
    },

    setLeadingElement(el: HTMLElement | null): void {
      currentLeadingElement = el ?? null;
      syncLeading();
      syncDisabled();
    },

    setDisabled(disabled: boolean): void {
      isDisabled = Boolean(disabled);
      syncDisabled();
    },

    focus(): void {
      try {
        mainBtn.focus();
      } catch {
        // Best-effort focus
      }
    },

    dispose(): void {
      disposer.dispose();
    },
  };
}
