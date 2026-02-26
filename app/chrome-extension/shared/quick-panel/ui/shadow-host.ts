/**
 * Quick Panel Shadow Host
 *
 * Creates an isolated Shadow DOM container for the Quick Panel AI Chat UI.
 * This module runs in a content script context and provides:
 *
 * - Style isolation via Shadow DOM (no CSS bleed in/out)
 * - Event isolation (UI events don't bubble to the host page)
 * - Theme synchronization with AgentChat (via chrome.storage)
 *
 * Architecture:
 * - Host element attached to documentElement with highest z-index
 * - Shadow root contains styles + UI container
 * - Theme is synced from chrome.storage.local['agentTheme']
 */

import { Disposer } from '@/entrypoints/web-editor-v2/utils/disposables';
import { QUICK_PANEL_STYLES } from './styles';

// ============================================================
// Types
// ============================================================

/**
 * Elements exposed by the shadow host for UI mounting.
 */
export interface QuickPanelShadowHostElements {
  /** The host element attached to the document */
  host: HTMLElement;
  /** The shadow root */
  shadowRoot: ShadowRoot;
  /** Container for UI elements (pointer-events: none by default) */
  uiRoot: HTMLElement;
  /** Theme root element (class="agent-theme qp-root") */
  root: HTMLElement;
}

/**
 * Manager interface for the shadow host.
 */
export interface QuickPanelShadowHostManager {
  /** Get the current elements (null if disposed) */
  getElements: () => QuickPanelShadowHostElements | null;
  /** Check if a node belongs to this shadow host */
  isOverlayElement: (node: unknown) => boolean;
  /** Check if an event originated from within the shadow host */
  isEventFromUi: (event: Event) => boolean;
  /** Clean up and remove the shadow host */
  dispose: () => void;
}

/**
 * Options for mounting the shadow host.
 */
export interface QuickPanelShadowHostOptions {
  /** Custom host element ID (default: __mcp_quick_panel_host__) */
  hostId?: string;
  /** Custom z-index (default: 2147483647 - highest possible) */
  zIndex?: number;
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_HOST_ID = '__mcp_quick_panel_host__';
const UI_CONTAINER_ID = '__mcp_quick_panel_ui__';
const ROOT_ID = '__mcp_quick_panel_root__';

/** Highest possible z-index to ensure Quick Panel is on top */
const DEFAULT_Z_INDEX = 2147483647;

/** Storage key for AgentChat theme (owned by sidepanel) */
const THEME_STORAGE_KEY = 'agentTheme';

/** Default theme if none is set */
const DEFAULT_THEME_ID = 'warm-editorial';

/** Dark theme ID for dark mode */
const DARK_THEME_ID = 'dark-console';

/** Valid theme IDs (subset supported by Quick Panel) */
const VALID_THEME_IDS = new Set([
  'warm-editorial',
  'blueprint-architect',
  'zen-journal',
  'neo-pop',
  'dark-console',
  'swiss-grid',
]);

/** Light theme IDs that should switch to dark in dark mode */
const LIGHT_THEME_IDS = new Set([
  'warm-editorial',
  'blueprint-architect',
  'zen-journal',
  'neo-pop',
  'swiss-grid',
]);

/** Events to stop from propagating to the host page */
const BLOCKED_EVENT_TYPES = [
  // Pointer events
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointerenter',
  'pointerleave',
  'pointercancel',
  // Mouse events
  'mousedown',
  'mouseup',
  'mousemove',
  'mouseenter',
  'mouseleave',
  'click',
  'dblclick',
  'contextmenu',
  // Keyboard events
  'keydown',
  'keyup',
  'keypress',
  // Touch events
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',
  // Scroll events
  'wheel',
  // Form events
  'focus',
  'blur',
  'input',
  'change',
] as const;

// ============================================================
// Utility Functions
// ============================================================

/**
 * Set a CSS property with !important to override page styles.
 */
function setImportantStyle(element: HTMLElement, property: string, value: string): void {
  element.style.setProperty(property, value, 'important');
}

/**
 * Normalize and validate a theme ID.
 */
function normalizeThemeId(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_THEME_ID;
  const trimmed = value.trim();
  return VALID_THEME_IDS.has(trimmed) ? trimmed : DEFAULT_THEME_ID;
}

/**
 * Check if system prefers dark mode.
 */
function systemPrefersDark(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  } catch {
    return false;
  }
}

/**
 * Get effective theme ID considering system dark mode preference.
 * If system is in dark mode and the theme is a light theme, switch to dark-console.
 */
function getEffectiveThemeId(baseThemeId: string): string {
  if (systemPrefersDark() && LIGHT_THEME_IDS.has(baseThemeId)) {
    return DARK_THEME_ID;
  }
  return baseThemeId;
}

/**
 * Read the stored theme ID from chrome.storage.
 */
async function readStoredThemeId(): Promise<string> {
  try {
    if (!chrome?.storage?.local) return DEFAULT_THEME_ID;
    const result = await chrome.storage.local.get(THEME_STORAGE_KEY);
    return normalizeThemeId(result[THEME_STORAGE_KEY]);
  } catch {
    return DEFAULT_THEME_ID;
  }
}

/**
 * Apply a theme ID to the root element, considering system dark mode preference.
 */
function applyThemeId(root: HTMLElement, themeId: string): void {
  const normalizedTheme = normalizeThemeId(themeId);
  const effectiveTheme = getEffectiveThemeId(normalizedTheme);
  root.dataset.agentTheme = effectiveTheme;
}

// ============================================================
// Main Export
// ============================================================

/**
 * Mount the Quick Panel Shadow DOM host.
 *
 * @param options - Configuration options
 * @returns Manager interface for the shadow host
 *
 * @example
 * ```typescript
 * const shadowHost = mountQuickPanelShadowHost();
 * const elements = shadowHost.getElements();
 *
 * if (elements) {
 *   // Mount UI into elements.root
 *   mountQuickPanelAiChatPanel({
 *     mount: elements.root,
 *     agentBridge,
 *   });
 * }
 *
 * // Cleanup when done
 * shadowHost.dispose();
 * ```
 */
export function mountQuickPanelShadowHost(
  options: QuickPanelShadowHostOptions = {},
): QuickPanelShadowHostManager {
  const disposer = new Disposer();
  let elements: QuickPanelShadowHostElements | null = null;

  const hostId = options.hostId ?? DEFAULT_HOST_ID;
  const zIndex = options.zIndex ?? DEFAULT_Z_INDEX;

  // Clean up any existing host (from previous instance or crash recovery)
  const existing = document.getElementById(hostId);
  if (existing) {
    try {
      existing.remove();
    } catch {
      // Best-effort cleanup
    }
  }

  // Create host element
  const host = document.createElement('div');
  host.id = hostId;
  host.setAttribute('data-mcp-quick-panel', 'true');

  // Apply styles with !important to override page styles
  setImportantStyle(host, 'position', 'fixed');
  setImportantStyle(host, 'inset', '0');
  setImportantStyle(host, 'z-index', String(zIndex));
  setImportantStyle(host, 'pointer-events', 'none');
  setImportantStyle(host, 'contain', 'layout style paint');
  setImportantStyle(host, 'isolation', 'isolate');

  // Create shadow root
  const shadowRoot = host.attachShadow({ mode: 'open' });

  // Inject styles
  const styleEl = document.createElement('style');
  styleEl.textContent = QUICK_PANEL_STYLES;
  shadowRoot.append(styleEl);

  // Create UI container
  const uiRoot = document.createElement('div');
  uiRoot.id = UI_CONTAINER_ID;
  setImportantStyle(uiRoot, 'position', 'fixed');
  setImportantStyle(uiRoot, 'inset', '0');
  setImportantStyle(uiRoot, 'pointer-events', 'none');
  shadowRoot.append(uiRoot);

  // Create theme root (where UI components mount)
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.className = 'agent-theme qp-root';

  // Apply theme synchronously BEFORE mounting to avoid flash
  // Use system dark mode preference as initial hint
  const initialTheme = getEffectiveThemeId(DEFAULT_THEME_ID);
  root.dataset.agentTheme = initialTheme;

  uiRoot.append(root);

  // Mount to document
  const mountPoint = document.documentElement ?? document.body;
  mountPoint.append(host);
  disposer.add(() => host.remove());

  elements = { host, shadowRoot, uiRoot, root };

  // Event isolation: stop UI events from bubbling to the page
  const stopPropagation = (event: Event): void => {
    event.stopPropagation();
  };

  for (const eventType of BLOCKED_EVENT_TYPES) {
    disposer.listen(root, eventType, stopPropagation);
  }

  // Async update with stored theme (if different from initial)
  void (async () => {
    const themeId = await readStoredThemeId();
    applyThemeId(root, themeId);
  })();

  // System dark mode change listener
  // Re-apply theme when system color scheme changes
  let currentStoredThemeId = DEFAULT_THEME_ID;

  // Track the stored theme ID
  void (async () => {
    currentStoredThemeId = await readStoredThemeId();
  })();

  // Theme change listener
  const handleStorageChange = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return;
    const change = changes[THEME_STORAGE_KEY];
    if (!change) return;
    // Update tracked theme ID and apply
    currentStoredThemeId = normalizeThemeId(change.newValue);
    applyThemeId(root, currentStoredThemeId);
  };

  try {
    chrome?.storage?.onChanged?.addListener(handleStorageChange);
    disposer.add(() => chrome?.storage?.onChanged?.removeListener(handleStorageChange));
  } catch {
    // Best-effort: theme sync is optional
  }

  try {
    const darkModeMediaQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    if (darkModeMediaQuery) {
      const handleDarkModeChange = (): void => {
        applyThemeId(root, currentStoredThemeId);
      };

      // Use addEventListener for modern browsers
      if (typeof darkModeMediaQuery.addEventListener === 'function') {
        darkModeMediaQuery.addEventListener('change', handleDarkModeChange);
        disposer.add(() => darkModeMediaQuery.removeEventListener('change', handleDarkModeChange));
      }
    }
  } catch {
    // Best-effort: dark mode detection is optional
  }

  // Helper to check if a node belongs to this shadow host
  const isOverlayElement = (node: unknown): boolean => {
    if (!(node instanceof Node)) return false;
    if (node === host) return true;

    const rootNode = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
    return rootNode instanceof ShadowRoot && rootNode.host === host;
  };

  // Helper to check if an event originated from within the shadow host
  const isEventFromUi = (event: Event): boolean => {
    try {
      if (typeof event.composedPath === 'function') {
        return event.composedPath().some((el) => isOverlayElement(el));
      }
    } catch {
      // Fallback to checking target
    }
    return isOverlayElement(event.target);
  };

  return {
    getElements: () => elements,
    isOverlayElement,
    isEventFromUi,
    dispose: () => {
      elements = null;
      disposer.dispose();
    },
  };
}
