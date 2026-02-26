/**
 * Quick Panel Shell
 *
 * A unified panel container that hosts multiple views:
 * - `search`: the launcher/search UI (Phase 1+)
 * - `chat`: AI Chat view (existing capability)
 *
 * The shell owns the overlay + glass panel layout and provides isolated
 * mount points per-view for header/content/footer sections.
 */

import { Disposer } from '@/entrypoints/web-editor-v2/utils/disposables';
import type { QuickPanelView } from '../core/types';

// SVG Icons
const ICON_CLOSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`;

// ============================================================
// Types
// ============================================================

export interface QuickPanelShellElements {
  /** Overlay backdrop */
  overlay: HTMLDivElement;
  /** Main panel container */
  panel: HTMLDivElement;

  /** Header section */
  header: HTMLDivElement;
  headerLeft: HTMLDivElement;
  headerRight: HTMLDivElement;
  closeBtn: HTMLButtonElement;

  /** View-specific header mounts */
  headerSearchMount: HTMLDivElement;
  headerChatMount: HTMLDivElement;
  headerRightSearchMount: HTMLDivElement;
  headerRightChatMount: HTMLDivElement;

  /** Content section */
  content: HTMLDivElement;
  contentSearchMount: HTMLDivElement;
  contentChatMount: HTMLDivElement;

  /** Footer section */
  footer: HTMLDivElement;
  footerSearchMount: HTMLDivElement;
  footerChatMount: HTMLDivElement;
}

export interface QuickPanelShellOptions {
  /** Shadow DOM mount point (typically `elements.root` from shadow-host.ts) */
  mount: HTMLElement;
  /** Default view on mount. Default: `search` */
  defaultView?: QuickPanelView;
  /** Accessible label for the dialog. Default: "Quick Panel" */
  ariaLabel?: string;
  /** Close when clicking the backdrop. Default: true */
  closeOnBackdropClick?: boolean;
  /** Called when close is requested (button/backdrop/api) */
  onRequestClose?: (reason: 'button' | 'backdrop' | 'api') => void;
  /** Called after view changes */
  onViewChange?: (view: QuickPanelView) => void;
}

export interface QuickPanelShellManager {
  /** Get shell elements (null if disposed) */
  getElements: () => QuickPanelShellElements | null;
  /** Get current view */
  getView: () => QuickPanelView;
  /** Switch to a different view */
  setView: (view: QuickPanelView) => void;
  /** Request panel close */
  requestClose: (reason?: 'button' | 'backdrop' | 'api') => void;
  /** Clean up resources */
  dispose: () => void;
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_ARIA_LABEL = 'Quick Panel';
const DEFAULT_VIEW: QuickPanelView = 'search';

// ============================================================
// Main Factory
// ============================================================

/**
 * Mount the Quick Panel shell.
 *
 * @example
 * ```typescript
 * const shell = mountQuickPanelShell({
 *   mount: shadowHostElements.root,
 *   defaultView: 'search',
 *   onRequestClose: () => quickPanel.hide(),
 * });
 *
 * // Get mount points for search view
 * const elements = shell.getElements();
 * if (elements) {
 *   // Mount search input to elements.headerSearchMount
 *   // Mount results to elements.contentSearchMount
 * }
 *
 * // Switch to chat view
 * shell.setView('chat');
 *
 * // Cleanup
 * shell.dispose();
 * ```
 */
export function mountQuickPanelShell(options: QuickPanelShellOptions): QuickPanelShellManager {
  const disposer = new Disposer();
  const mount = options.mount;
  const closeOnBackdropClick = options.closeOnBackdropClick ?? true;

  let disposed = false;
  let elements: QuickPanelShellElements | null = null;
  let currentView: QuickPanelView = options.defaultView ?? DEFAULT_VIEW;

  // Best-effort cleanup (crash recovery / duplicate mounts)
  try {
    const existing = mount.querySelector?.('[data-mcp-quick-panel-shell="true"]');
    if (existing instanceof HTMLElement) {
      existing.remove();
    }
  } catch {
    // Ignore cleanup errors
  }

  // --------------------------------------------------------
  // DOM Construction
  // --------------------------------------------------------

  const overlay = document.createElement('div');
  overlay.className = 'qp-overlay';
  overlay.setAttribute('data-mcp-quick-panel-shell', 'true');

  const panel = document.createElement('div');
  panel.className = 'qp-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', options.ariaLabel?.trim() || DEFAULT_ARIA_LABEL);
  panel.dataset.qpView = currentView;

  // Header
  const header = document.createElement('div');
  header.className = 'qp-header';

  const headerLeft = document.createElement('div');
  headerLeft.className = 'qp-header-left';

  const headerSearchMount = document.createElement('div');
  headerSearchMount.className = 'qp-header-mount qp-header-mount--search';

  const headerChatMount = document.createElement('div');
  headerChatMount.className = 'qp-header-mount qp-header-mount--chat';

  headerLeft.append(headerSearchMount, headerChatMount);

  const headerRight = document.createElement('div');
  headerRight.className = 'qp-header-right';

  const headerRightSearchMount = document.createElement('div');
  headerRightSearchMount.className = 'qp-header-right-mount qp-header-right-mount--search';

  const headerRightChatMount = document.createElement('div');
  headerRightChatMount.className = 'qp-header-right-mount qp-header-right-mount--chat';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'qp-icon-btn ac-focus-ring';
  closeBtn.innerHTML = ICON_CLOSE;
  closeBtn.setAttribute('aria-label', 'Close Quick Panel');

  headerRight.append(headerRightSearchMount, headerRightChatMount, closeBtn);
  header.append(headerLeft, headerRight);

  // Content
  const content = document.createElement('div');
  content.className = 'qp-content ac-scroll';

  const contentSearchMount = document.createElement('div');
  contentSearchMount.className = 'qp-content-mount qp-content-mount--search';

  const contentChatMount = document.createElement('div');
  contentChatMount.className = 'qp-content-mount qp-content-mount--chat';

  content.append(contentSearchMount, contentChatMount);

  // Footer (reuse `.qp-composer` for consistent glass divider/padding)
  const footer = document.createElement('div');
  footer.className = 'qp-composer';

  const footerSearchMount = document.createElement('div');
  footerSearchMount.className = 'qp-footer-mount qp-footer-mount--search';

  const footerChatMount = document.createElement('div');
  footerChatMount.className = 'qp-footer-mount qp-footer-mount--chat';

  footer.append(footerSearchMount, footerChatMount);

  // Assemble
  panel.append(header, content, footer);
  overlay.append(panel);
  mount.append(overlay);
  disposer.add(() => overlay.remove());

  elements = {
    overlay,
    panel,
    header,
    headerLeft,
    headerRight,
    closeBtn,
    headerSearchMount,
    headerChatMount,
    headerRightSearchMount,
    headerRightChatMount,
    content,
    contentSearchMount,
    contentChatMount,
    footer,
    footerSearchMount,
    footerChatMount,
  };

  // --------------------------------------------------------
  // View Switching
  // --------------------------------------------------------

  function renderView(view: QuickPanelView): void {
    if (!elements) return;

    elements.panel.dataset.qpView = view;

    // Search view visibility
    const isSearch = view === 'search';
    elements.headerSearchMount.hidden = !isSearch;
    elements.headerRightSearchMount.hidden = !isSearch;
    elements.contentSearchMount.hidden = !isSearch;
    elements.footerSearchMount.hidden = !isSearch;

    // Chat view visibility
    const isChat = view === 'chat';
    elements.headerChatMount.hidden = !isChat;
    elements.headerRightChatMount.hidden = !isChat;
    elements.contentChatMount.hidden = !isChat;
    elements.footerChatMount.hidden = !isChat;
  }

  function setView(view: QuickPanelView): void {
    if (disposed) return;
    if (view !== 'search' && view !== 'chat') return;
    if (view === currentView) return;

    currentView = view;
    renderView(currentView);

    try {
      options.onViewChange?.(currentView);
    } catch {
      // Best-effort callback
    }
  }

  // Apply initial visibility
  renderView(currentView);

  // --------------------------------------------------------
  // Close Handling
  // --------------------------------------------------------

  function requestClose(reason: 'button' | 'backdrop' | 'api' = 'api'): void {
    if (disposed) return;

    try {
      options.onRequestClose?.(reason);
    } catch {
      // Best-effort: caller owns lifecycle
    }
  }

  disposer.listen(closeBtn, 'click', () => requestClose('button'));

  if (closeOnBackdropClick) {
    disposer.listen(overlay, 'click', (ev: MouseEvent) => {
      if (disposed) return;
      if (ev.target === overlay) {
        requestClose('backdrop');
      }
    });
  }

  // --------------------------------------------------------
  // Public API
  // --------------------------------------------------------

  return {
    getElements: () => elements,
    getView: () => currentView,
    setView,
    requestClose,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      elements = null;
      disposer.dispose();
    },
  };
}
