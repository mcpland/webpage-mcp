/**
 * Color Field (Phase 5.3 - Token Support)
 *
 * A reusable color field component for the Web Editor property panel.
 *
 * Features:
 * - Swatch button opens the native system color picker
 * - Hidden <input type="color"> provides native UX
 * - Text input accepts hex/rgb/var(...) formats
 * - Token Pill mode: displays var(--token) as a pill with swatch preview
 * - Integrated Token Picker for selecting design tokens
 *
 * Mode switching:
 * - When value is a standalone var(--xxx), displays as Token Pill
 * - When value is a literal color or complex expression, displays as text input
 */

import { Disposer } from '../../../utils/disposables';
import type { CssVarName, DesignTokensService } from '../../../core/design-tokens';
import { createTokenPicker, type TokenPicker } from './token-picker';
import { createTokenPill, type TokenPill } from '../components/token-pill';

// =============================================================================
// Types
// =============================================================================

export interface ColorFieldOptions {
  /** Container element to mount the field into */
  container: HTMLElement;
  /** Accessible label for the text input */
  ariaLabel: string;
  /** Called for live preview as the value changes */
  onInput?: (value: string) => void;
  /** Called when the user commits changes (blur/Enter or picker change) */
  onCommit?: () => void;
  /** Called when the user cancels editing (Escape) */
  onCancel?: () => void;

  // Token integration (Phase 5.3)
  /** Optional: Design tokens service for TokenPill/TokenPicker integration */
  tokensService?: DesignTokensService;
  /** Optional: Provides current element context for token filtering */
  getTokenTarget?: () => Element | null;
  /** Optional: Max visible rows in token picker dropdown */
  tokenPickerMaxVisible?: number;
}

export interface ColorField {
  /** Set the current value */
  setValue(value: string): void;
  /** Set placeholder (computed value) */
  setPlaceholder(value: string): void;
  /** Enable/disable the field */
  setDisabled(disabled: boolean): void;
  /** Check if the field is focused */
  isFocused(): boolean;
  /** Cleanup */
  dispose(): void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_COLOR_HEX = '#000000';

// Token button SVG icon (palette icon)
const TOKEN_BTN_ICON_SVG = `
  <svg class="we-token-btn-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 3a9 9 0 100 18h1a2 2 0 002-2v-1a2 2 0 012-2h1a3 3 0 003-3 10 10 0 00-9-10z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="7.5" cy="10.5" r="1" fill="currentColor"/>
    <circle cx="10.5" cy="7.5" r="1" fill="currentColor"/>
    <circle cx="13.5" cy="10.5" r="1" fill="currentColor"/>
  </svg>
`;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Clamp a byte value to 0-255
 */
function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * Convert a byte to 2-digit hex string
 */
function toHexByte(n: number): string {
  return clampByte(n).toString(16).padStart(2, '0');
}

/**
 * Convert rgb(r, g, b) or rgba(r, g, b, a) string to #RRGGBB hex
 */
function rgbToHex(rgb: string): string | null {
  const match = rgb.match(/rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i);
  if (!match) return null;

  const r = Number(match[1]);
  const g = Number(match[2]);
  const b = Number(match[3]);

  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    return null;
  }

  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}

/**
 * Normalize a hex color string to #RRGGBB format
 */
function normalizeHex(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (!v.startsWith('#')) return null;

  // Already #RRGGBB
  if (/^#[0-9a-f]{6}$/.test(v)) return v;

  // #RGB -> #RRGGBB
  if (/^#[0-9a-f]{3}$/.test(v)) {
    const r = v[1]!;
    const g = v[2]!;
    const b = v[3]!;
    return `#${r}${r}${g}${g}${b}${b}`;
  }

  // #RRGGBBAA -> #RRGGBB (ignore alpha)
  if (/^#[0-9a-f]{8}$/.test(v)) return v.slice(0, 7);

  // #RGBA -> #RRGGBB (ignore alpha)
  if (/^#[0-9a-f]{4}$/.test(v)) {
    const r = v[1]!;
    const g = v[2]!;
    const b = v[3]!;
    return `#${r}${r}${g}${g}${b}${b}`;
  }

  return null;
}

/**
 * Get active element from shadow DOM context
 */
function getActiveElement(root: HTMLElement): Element | null {
  try {
    const rootNode = root.getRootNode();
    if (rootNode instanceof ShadowRoot) {
      return rootNode.activeElement;
    }
  } catch {
    // Best-effort focus detection
  }
  return document.activeElement;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a color field component with optional token support.
 */
export function createColorField(options: ColorFieldOptions): ColorField {
  const {
    container,
    ariaLabel,
    onInput,
    onCommit,
    onCancel,
    tokensService,
    getTokenTarget,
    tokenPickerMaxVisible,
  } = options;

  const disposer = new Disposer();

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let currentValue = '';
  let currentPlaceholder = '';
  let lastResolvedHex = DEFAULT_COLOR_HEX;
  let isTokenMode = false;
  let isDisabled = false;

  // Token integration instances (created only when tokensService is provided)
  let tokenPill: TokenPill | null = null;
  let tokenBtn: HTMLButtonElement | null = null;
  let tokenPicker: TokenPicker | null = null;

  // ---------------------------------------------------------------------------
  // DOM Structure
  // ---------------------------------------------------------------------------

  // Root container (relative positioning for token picker dropdown)
  const root = document.createElement('div');
  root.className = 'we-color-field';
  root.style.position = 'relative';

  // Swatch button
  const swatchBtn = document.createElement('button');
  swatchBtn.type = 'button';
  swatchBtn.className = 'we-color-swatch';
  swatchBtn.dataset.tooltip = 'Pick color';
  swatchBtn.setAttribute('aria-label', `Pick ${ariaLabel}`);

  // Native color input (overlays swatch for direct click interaction)
  const nativeInput = document.createElement('input');
  nativeInput.type = 'color';
  nativeInput.className = 'we-color-native-input';
  nativeInput.value = lastResolvedHex;
  nativeInput.tabIndex = -1;

  // Text input for manual entry
  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.className = 'we-input we-color-text';
  textInput.autocomplete = 'off';
  textInput.spellcheck = false;
  textInput.setAttribute('aria-label', ariaLabel);

  // Hidden probe element for color resolution
  const probe = document.createElement('span');
  probe.style.cssText =
    'position:fixed;left:-9999px;top:0;width:1px;height:1px;pointer-events:none;opacity:0';
  probe.setAttribute('aria-hidden', 'true');

  // Place native input inside swatch
  swatchBtn.append(nativeInput);

  // Token button (opens token picker) - created only when tokensService provided
  if (tokensService) {
    tokenBtn = document.createElement('button');
    tokenBtn.type = 'button';
    tokenBtn.className = 'we-token-btn';
    tokenBtn.setAttribute('aria-label', 'Select design token');
    tokenBtn.dataset.tooltip = 'Select design token';
    tokenBtn.innerHTML = TOKEN_BTN_ICON_SVG;
  }

  // Assemble DOM structure
  root.append(swatchBtn, textInput);
  if (tokenBtn) {
    root.append(tokenBtn);
  }
  root.append(probe);
  container.append(root);
  disposer.add(() => root.remove());

  // ---------------------------------------------------------------------------
  // Token Pill (created when tokensService provided)
  // ---------------------------------------------------------------------------

  if (tokensService) {
    tokenPill = createTokenPill({
      container: root,
      ariaLabel: `${ariaLabel} token`,
      tokenName: '',
      disabled: false,
      onClick: () => toggleTokenPicker(),
      onClear: () => detachToken(),
    });
    tokenPill.root.hidden = true;
    disposer.add(() => tokenPill?.dispose());
  }

  // ---------------------------------------------------------------------------
  // Token Picker (created when tokensService provided)
  // ---------------------------------------------------------------------------

  if (tokensService) {
    tokenPicker = createTokenPicker({
      container: root,
      tokensService,
      tokenKind: 'color',
      maxVisible: tokenPickerMaxVisible,
      onSelect: handleTokenSelect,
    });
    disposer.add(() => tokenPicker?.dispose());

    // Close picker when clicking outside this field
    disposer.listen(document, 'click', (e: MouseEvent) => {
      if (!tokenPicker?.isVisible()) return;
      const target = e.target as Node;
      if (!root.contains(target)) {
        tokenPicker.hide();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Color Resolution
  // ---------------------------------------------------------------------------

  /**
   * Get the display value for color resolution.
   * When value contains var(), use placeholder (computed value) for resolution.
   */
  function getDisplayValue(): string {
    const value = currentValue.trim();
    const placeholder = currentPlaceholder.trim();

    if (value && /\bvar\s*\(/i.test(value) && placeholder) {
      return placeholder;
    }

    return value || placeholder;
  }

  /**
   * Resolve a color string to swatch display and hex for native picker
   */
  function resolveDisplayColor(raw: string): { swatch: string | null; hex: string | null } {
    const trimmed = raw.trim();
    if (!trimmed) return { swatch: null, hex: null };

    const hex = normalizeHex(trimmed);
    if (hex) return { swatch: hex, hex };

    try {
      probe.style.backgroundColor = '';
      probe.style.backgroundColor = trimmed;
      if (!probe.style.backgroundColor) return { swatch: null, hex: null };

      const computed = getComputedStyle(probe).backgroundColor;
      const computedHex = rgbToHex(computed);
      return { swatch: computed || null, hex: computedHex };
    } catch {
      return { swatch: null, hex: null };
    }
  }

  /**
   * Update the swatch button color
   */
  function updateSwatch(): void {
    const display = getDisplayValue();
    const resolved = resolveDisplayColor(display);

    if (resolved.swatch) {
      swatchBtn.style.backgroundColor = resolved.swatch;
    } else {
      swatchBtn.style.backgroundColor = '';
    }

    if (resolved.hex) {
      lastResolvedHex = resolved.hex;
      nativeInput.value = resolved.hex;
    }
  }

  /**
   * Open the native color picker
   */
  function openPicker(): void {
    if (nativeInput.disabled) return;

    const display = getDisplayValue();
    const resolved = resolveDisplayColor(display);
    if (resolved.hex) lastResolvedHex = resolved.hex;
    nativeInput.value = lastResolvedHex;

    const showPicker = (nativeInput as HTMLInputElement & { showPicker?: () => void }).showPicker;
    if (typeof showPicker === 'function') {
      try {
        showPicker.call(nativeInput);
        return;
      } catch {
        // showPicker may throw if not triggered by user gesture
      }
    }

    try {
      nativeInput.click();
    } catch {
      // Best-effort fallback
    }
  }

  // ---------------------------------------------------------------------------
  // Token Mode Management
  // ---------------------------------------------------------------------------

  /**
   * Parse token name from current value using tokensService.parseCssVar
   */
  function parseTokenName(): CssVarName | null {
    if (!tokensService) return null;
    const ref = tokensService.parseCssVar(currentValue.trim());
    return ref ? ref.name : null;
  }

  /**
   * Switch between token pill mode and text input mode
   */
  function setTokenMode(next: boolean, tokenName?: CssVarName): void {
    if (!tokensService || !tokenPill) return;
    if (next === isTokenMode) {
      // Already in correct mode, just update token name if provided
      if (next && tokenName) {
        tokenPill.setTokenName(tokenName);
      }
      return;
    }

    isTokenMode = next;

    if (next) {
      // Enter token pill mode
      const name = tokenName ?? parseTokenName() ?? '';
      tokenPill.setTokenName(name);
      tokenPill.setLeadingElement(swatchBtn);
      tokenPill.root.hidden = false;
      textInput.hidden = true;
      if (tokenBtn) tokenBtn.hidden = true;
    } else {
      // Exit token pill mode
      tokenPill.root.hidden = true;
      tokenPill.setLeadingElement(null);
      textInput.hidden = false;
      if (tokenBtn) tokenBtn.hidden = false;

      // Ensure swatch is positioned correctly
      if (swatchBtn.parentElement !== root) {
        root.insertBefore(swatchBtn, textInput);
      } else if (swatchBtn.nextSibling !== textInput) {
        root.insertBefore(swatchBtn, textInput);
      }
    }
  }

  /**
   * Sync token UI based on current value
   */
  function syncTokenUi(): void {
    if (!tokensService || !tokenPill) return;
    const name = parseTokenName();
    setTokenMode(Boolean(name), name ?? undefined);
  }

  /**
   * Toggle token picker visibility
   */
  function toggleTokenPicker(): void {
    if (!tokenPicker || !tokensService) return;
    if (isDisabled) return;

    tokenPicker.setTarget(getTokenTarget?.() ?? null);
    tokenPicker.toggle();
  }

  /**
   * Handle token selection from picker
   */
  function handleTokenSelect(tokenName: CssVarName, cssValue: string): void {
    // Clear stale placeholder
    currentPlaceholder = '';
    textInput.placeholder = '';

    // Update value
    currentValue = cssValue;
    textInput.value = currentValue;
    updateSwatch();

    // Notify listeners
    onInput?.(currentValue.trim());
    onCommit?.();

    // Switch to token mode
    setTokenMode(true, tokenName);
  }

  /**
   * Detach token (clear to literal color)
   */
  function detachToken(): void {
    if (!tokensService || !tokenPill) return;
    if (isDisabled) return;

    tokenPicker?.hide();

    // Replace with current resolved color as literal
    const literal = lastResolvedHex || DEFAULT_COLOR_HEX;
    currentPlaceholder = '';
    textInput.placeholder = '';

    currentValue = literal;
    textInput.value = currentValue;
    updateSwatch();

    // Notify listeners
    onInput?.(currentValue);
    onCommit?.();

    // Exit token mode
    setTokenMode(false);
  }

  // ---------------------------------------------------------------------------
  // Event Handlers
  // ---------------------------------------------------------------------------

  // Swatch button keyboard activation
  disposer.listen(swatchBtn, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  });

  // Text input change
  disposer.listen(textInput, 'input', () => {
    currentValue = textInput.value;
    updateSwatch();
    onInput?.(currentValue.trim());
  });

  // Text input blur -> commit and sync token UI
  disposer.listen(textInput, 'blur', () => {
    onCommit?.();
    syncTokenUi();
  });

  // Text input keyboard
  disposer.listen(textInput, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onCommit?.();
      textInput.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel?.();
    }
  });

  // Native picker input (live update)
  disposer.listen(nativeInput, 'input', () => {
    currentValue = nativeInput.value;
    textInput.value = currentValue;
    updateSwatch();
    onInput?.(currentValue);
  });

  // Native picker change (commit)
  disposer.listen(nativeInput, 'change', () => {
    onCommit?.();
    syncTokenUi();
  });

  // Token button click
  if (tokenBtn) {
    disposer.listen(tokenBtn, 'click', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      toggleTokenPicker();
    });
  }

  // Initial updates
  updateSwatch();
  syncTokenUi();

  // ---------------------------------------------------------------------------
  // Public Interface
  // ---------------------------------------------------------------------------

  return {
    setValue(value: string): void {
      currentValue = String(value ?? '');
      textInput.value = currentValue;
      updateSwatch();
      syncTokenUi();
    },

    setPlaceholder(value: string): void {
      currentPlaceholder = String(value ?? '');
      textInput.placeholder = currentPlaceholder;
      updateSwatch();
    },

    setDisabled(disabled: boolean): void {
      isDisabled = Boolean(disabled);
      swatchBtn.disabled = isDisabled;
      textInput.disabled = isDisabled;
      nativeInput.disabled = isDisabled;
      if (tokenBtn) tokenBtn.disabled = isDisabled;
      tokenPill?.setDisabled(isDisabled);
      if (isDisabled) tokenPicker?.hide();
    },

    isFocused(): boolean {
      const active = getActiveElement(root);
      return active instanceof HTMLElement ? root.contains(active) : false;
    },

    dispose(): void {
      disposer.dispose();
    },
  };
}
