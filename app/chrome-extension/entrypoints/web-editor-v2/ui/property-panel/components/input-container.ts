/**
 * Input Container Component
 *
 * A reusable wrapper for inputs aligned with the attr-ui.html design spec.
 * Provides container-level hover/focus-within styling with optional prefix/suffix.
 *
 * Design spec pattern:
 * ```html
 * <div class="input-bg rounded h-[28px] flex items-center px-2">
 *   <span class="text-gray-400 mr-2">X</span>  <!-- prefix -->
 *   <input type="text" class="bg-transparent w-full outline-none">
 *   <span class="text-gray-400 text-[10px]">px</span>  <!-- suffix -->
 * </div>
 * ```
 *
 * CSS classes (defined in shadow-host.ts):
 * - `.we-input-container` - wrapper with hover/focus-within styles
 * - `.we-input-container__input` - transparent input
 * - `.we-input-container__prefix` - prefix element
 * - `.we-input-container__suffix` - suffix element (typically unit)
 */

// =============================================================================
// Types
// =============================================================================

/** Content for prefix/suffix: text string or DOM node (e.g., SVG icon) */
export type InputAffix = string | Node;

export interface InputContainerOptions {
  /** Accessible label for the input element */
  ariaLabel: string;
  /** Input type (default: "text") */
  type?: string;
  /** Input mode for virtual keyboard (e.g., "decimal", "numeric") */
  inputMode?: string;
  /** Optional prefix content (text label or icon) */
  prefix?: InputAffix | null;
  /** Optional suffix content (unit text or icon) */
  suffix?: InputAffix | null;
  /** Additional class name(s) for root container */
  rootClassName?: string;
  /** Additional class name(s) for input element */
  inputClassName?: string;
  /** Input autocomplete attribute (default: "off") */
  autocomplete?: string;
  /** Input spellcheck attribute (default: false) */
  spellcheck?: boolean;
  /** Initial placeholder text */
  placeholder?: string;
}

export interface InputContainer {
  /** Root container element */
  root: HTMLDivElement;
  /** Input element for wiring events */
  input: HTMLInputElement;
  /** Update prefix content */
  setPrefix(content: InputAffix | null): void;
  /** Update suffix content */
  setSuffix(content: InputAffix | null): void;
  /** Get current suffix text (null if no suffix or if suffix is a Node) */
  getSuffixText(): string | null;
}

// =============================================================================
// Helpers
// =============================================================================

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasAffix(value: InputAffix | null | undefined): value is InputAffix {
  if (value === null || value === undefined) return false;
  return typeof value === 'string' ? value.trim().length > 0 : true;
}

function joinClassNames(...parts: Array<string | null | undefined | false>): string {
  return parts.filter(isNonEmptyString).join(' ');
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an input container with optional prefix/suffix
 */
export function createInputContainer(options: InputContainerOptions): InputContainer {
  const {
    ariaLabel,
    type = 'text',
    inputMode,
    prefix,
    suffix,
    rootClassName,
    inputClassName,
    autocomplete = 'off',
    spellcheck = false,
    placeholder,
  } = options;

  // Root container
  const root = document.createElement('div');
  root.className = joinClassNames('we-input-container', rootClassName);

  // Prefix element (created lazily)
  let prefixEl: HTMLSpanElement | null = null;

  // Input element
  const input = document.createElement('input');
  input.type = type;
  input.className = joinClassNames('we-input-container__input', inputClassName);
  input.setAttribute('autocomplete', autocomplete);
  input.spellcheck = spellcheck;
  input.setAttribute('aria-label', ariaLabel);
  if (inputMode) {
    input.inputMode = inputMode;
  }
  if (placeholder !== undefined) {
    input.placeholder = placeholder;
  }

  // Suffix element (created lazily)
  let suffixEl: HTMLSpanElement | null = null;

  // Helper: create/update affix element
  function updateAffix(
    kind: 'prefix' | 'suffix',
    content: InputAffix | null,
    existingEl: HTMLSpanElement | null,
  ): HTMLSpanElement | null {
    if (!hasAffix(content)) {
      // Remove existing element if present
      if (existingEl) {
        existingEl.remove();
      }
      return null;
    }

    // Create element if needed
    const el = existingEl ?? document.createElement('span');
    el.className = `we-input-container__${kind}`;

    // Clear and set content
    el.textContent = '';
    if (typeof content === 'string') {
      el.textContent = content;
    } else {
      el.append(content);
    }

    return el;
  }

  // Initial prefix
  if (hasAffix(prefix)) {
    prefixEl = updateAffix('prefix', prefix, null);
    if (prefixEl) root.append(prefixEl);
  }

  // Append input
  root.append(input);

  // Initial suffix
  if (hasAffix(suffix)) {
    suffixEl = updateAffix('suffix', suffix, null);
    if (suffixEl) root.append(suffixEl);
  }

  // Public interface
  return {
    root,
    input,

    setPrefix(content: InputAffix | null): void {
      const newEl = updateAffix('prefix', content, prefixEl);
      if (newEl && !prefixEl) {
        // Insert before input
        root.insertBefore(newEl, input);
      }
      prefixEl = newEl;
    },

    setSuffix(content: InputAffix | null): void {
      const newEl = updateAffix('suffix', content, suffixEl);
      if (newEl && !suffixEl) {
        // Append after input
        root.append(newEl);
      }
      suffixEl = newEl;
    },

    getSuffixText(): string | null {
      if (!suffixEl) return null;
      // Only return text content, not Node content
      const text = suffixEl.textContent?.trim();
      return text || null;
    },
  };
}
