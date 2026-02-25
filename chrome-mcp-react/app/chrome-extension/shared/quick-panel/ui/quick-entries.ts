/**
 * Quick Panel Quick Entries
 *
 * Four-grid shortcuts for quickly switching scopes:
 * - Tabs / Bookmarks / History / Commands
 *
 * Following PRD spec for Quick Panel entry UI.
 */

import { Disposer } from '@/entrypoints/web-editor-v2/utils/disposables';
import { QUICK_PANEL_SCOPES, normalizeQuickPanelScope, type QuickPanelScope } from '../core/types';

// ============================================================
// Types
// ============================================================

export interface QuickEntriesOptions {
  /** Container to mount quick entries */
  container: HTMLElement;
  /**
   * Scopes to render as quick entries.
   * Default: tabs/bookmarks/history/commands
   */
  scopes?: readonly QuickPanelScope[];
  /** Called when an entry is selected */
  onSelect: (scope: QuickPanelScope) => void;
}

export interface QuickEntriesManager {
  /** Root DOM element */
  root: HTMLDivElement;
  /** Set the active (highlighted) scope */
  setActiveScope: (scope: QuickPanelScope | null) => void;
  /** Enable/disable a specific entry */
  setDisabled: (scope: QuickPanelScope, disabled: boolean) => void;
  /** Show/hide the quick entries grid */
  setVisible: (visible: boolean) => void;
  /** Clean up resources */
  dispose: () => void;
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_SCOPES: QuickPanelScope[] = ['tabs', 'bookmarks', 'history', 'commands'];

// ============================================================
// Main Factory
// ============================================================

/**
 * Create Quick Panel quick entries component.
 *
 * @example
 * ```typescript
 * const quickEntries = createQuickEntries({
 *   container: contentSearchMount,
 *   onSelect: (scope) => {
 *     searchInput.setScope(scope);
 *     controller.search(scope, '');
 *   },
 * });
 *
 * // Highlight active scope
 * quickEntries.setActiveScope('tabs');
 *
 * // Cleanup
 * quickEntries.dispose();
 * ```
 */
export function createQuickEntries(options: QuickEntriesOptions): QuickEntriesManager {
  const disposer = new Disposer();
  let disposed = false;

  const scopes = (options.scopes?.length ? [...options.scopes] : DEFAULT_SCOPES).map((s) =>
    normalizeQuickPanelScope(s),
  );

  // --------------------------------------------------------
  // DOM Construction
  // --------------------------------------------------------

  const root = document.createElement('div');
  root.className = 'qp-entries';
  options.container.append(root);
  disposer.add(() => root.remove());

  const buttonsByScope = new Map<QuickPanelScope, HTMLButtonElement>();

  function createEntry(scope: QuickPanelScope): HTMLButtonElement {
    const def = QUICK_PANEL_SCOPES[scope];

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qp-entry ac-btn ac-focus-ring';
    btn.dataset.scope = scope;
    btn.dataset.active = 'false';
    btn.setAttribute('aria-label', `Switch scope to ${def.label}`);

    const icon = document.createElement('div');
    icon.className = 'qp-entry__icon';
    icon.textContent = def.icon;

    const label = document.createElement('div');
    label.className = 'qp-entry__label';
    label.textContent = def.label;

    const prefix = document.createElement('div');
    prefix.className = 'qp-entry__prefix';
    prefix.textContent = def.prefix ? def.prefix.trim() : '';
    prefix.hidden = !def.prefix;

    btn.append(icon, label, prefix);

    disposer.listen(btn, 'click', () => {
      if (disposed) return;
      options.onSelect(scope);
    });

    return btn;
  }

  // Build entries
  for (const scope of scopes) {
    // Only render known scopes and avoid 'all' in quick entries
    if (!(scope in QUICK_PANEL_SCOPES) || scope === 'all') continue;

    const btn = createEntry(scope);
    buttonsByScope.set(scope, btn);
    root.append(btn);
  }

  // --------------------------------------------------------
  // State Management
  // --------------------------------------------------------

  function setActiveScope(scope: QuickPanelScope | null): void {
    if (disposed) return;

    const active = scope ? normalizeQuickPanelScope(scope) : null;
    for (const [id, btn] of buttonsByScope) {
      btn.dataset.active = active === id ? 'true' : 'false';
    }
  }

  function setDisabled(scope: QuickPanelScope, disabled: boolean): void {
    if (disposed) return;

    const id = normalizeQuickPanelScope(scope);
    const btn = buttonsByScope.get(id);
    if (!btn) return;

    btn.disabled = disabled;
  }

  function setVisible(visible: boolean): void {
    if (disposed) return;
    root.hidden = !visible;
  }

  // --------------------------------------------------------
  // Public API
  // --------------------------------------------------------

  return {
    root,
    setActiveScope,
    setDisabled,
    setVisible,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      buttonsByScope.clear();
      disposer.dispose();
    },
  };
}
