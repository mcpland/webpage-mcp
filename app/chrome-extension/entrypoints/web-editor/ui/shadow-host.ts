/**
 * Shadow DOM Host
 *
 * Creates an isolated container for the Web Editor UI using Shadow DOM.
 * Provides:
 * - Style isolation (no CSS bleed in/out)
 * - Event isolation (UI events don't bubble to page)
 * - Overlay container for Canvas/visual feedback
 * - UI container for panels/controls
 */

import {
  WEB_EDITOR_HOST_ID,
  WEB_EDITOR_OVERLAY_ID,
  WEB_EDITOR_UI_ID,
  WEB_EDITOR_Z_INDEX,
} from '../constants';
import { Disposer } from '../utils/disposables';
import { SHADOW_HOST_STYLES } from './shadow-host-styles';

// =============================================================================
// Types
// =============================================================================

/** Elements exposed by the shadow host */
export interface ShadowHostElements {
  /** The host element attached to the document */
  host: HTMLDivElement;
  /** The shadow root */
  shadowRoot: ShadowRoot;
  /** Container for overlay elements (Canvas, guides, etc.) */
  overlayRoot: HTMLDivElement;
  /** Container for UI elements (panels, toolbar, etc.) */
  uiRoot: HTMLDivElement;
}

/** Options for mounting the shadow host (placeholder for future extension) */
export type ShadowHostOptions = Record<string, never>;

/** Interface for the shadow host manager */
export interface ShadowHostManager {
  /** Get the shadow host elements (null if not mounted) */
  getElements(): ShadowHostElements | null;
  /** Check if a node is part of the editor overlay */
  isOverlayElement(node: unknown): boolean;
  /** Check if an event originated from the editor UI */
  isEventFromUi(event: Event): boolean;
  /** Dispose and unmount the shadow host */
  dispose(): void;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Set a CSS property with !important flag
 */
function setImportantStyle(element: HTMLElement, property: string, value: string): void {
  element.style.setProperty(property, value, 'important');
}

// Note: The legacy createPanelContent has been replaced by createPropertyPanel (Phase 3)

/**
 * Mount the Shadow DOM host and return a manager interface
 */
export function mountShadowHost(options: ShadowHostOptions = {}): ShadowHostManager {
  const disposer = new Disposer();
  let elements: ShadowHostElements | null = null;

  // Clean up any existing host (from crash/reload)
  const existing = document.getElementById(WEB_EDITOR_HOST_ID);
  if (existing) {
    try {
      existing.remove();
    } catch {
      // Best-effort cleanup
    }
  }

  // Create host element
  const host = document.createElement('div');
  host.id = WEB_EDITOR_HOST_ID;
  host.setAttribute('data-mcp-web-editor', 'v2');

  // Apply host styles with !important to resist page CSS
  setImportantStyle(host, 'position', 'fixed');
  setImportantStyle(host, 'inset', '0');
  setImportantStyle(host, 'z-index', String(WEB_EDITOR_Z_INDEX));
  setImportantStyle(host, 'pointer-events', 'none');
  setImportantStyle(host, 'contain', 'layout style paint');
  setImportantStyle(host, 'isolation', 'isolate');

  // Create shadow root
  // Agent replies and privileged controls must not be inspectable or callable
  // through the host page's DOM APIs.
  const shadowRoot = host.attachShadow({ mode: 'closed' });

  // Add styles
  const styleEl = document.createElement('style');
  styleEl.textContent = SHADOW_HOST_STYLES;
  shadowRoot.append(styleEl);

  // Create overlay container (for Canvas)
  const overlayRoot = document.createElement('div');
  overlayRoot.id = WEB_EDITOR_OVERLAY_ID;

  // Create UI container (for panels)
  // Note: Property Panel is now created separately by editor.ts (Phase 3)
  const uiRoot = document.createElement('div');
  uiRoot.id = WEB_EDITOR_UI_ID;

  shadowRoot.append(overlayRoot, uiRoot);

  // Mount to document
  const mountPoint = document.documentElement ?? document.body;
  mountPoint.append(host);
  disposer.add(() => host.remove());

  elements = { host, shadowRoot, overlayRoot, uiRoot };

  // Event isolation: prevent UI events from bubbling to page
  const blockedEvents = [
    'pointerdown',
    'pointerup',
    'pointermove',
    'pointerenter',
    'pointerleave',
    'mousedown',
    'mouseup',
    'mousemove',
    'mouseenter',
    'mouseleave',
    'click',
    'dblclick',
    'contextmenu',
    'keydown',
    'keyup',
    'keypress',
    'wheel',
    'touchstart',
    'touchmove',
    'touchend',
    'touchcancel',
    'focus',
    'blur',
    'input',
    'change',
  ];

  const stopPropagation = (event: Event) => {
    event.stopPropagation();
  };

  for (const eventType of blockedEvents) {
    disposer.listen(uiRoot, eventType, stopPropagation);
    // Also block overlay interactions (handles, guides) from bubbling to page
    // Note: capture-phase listeners on the page cannot be fully prevented
    disposer.listen(overlayRoot, eventType, stopPropagation);
  }

  // Helper: check if a node is part of the editor
  const isOverlayElement = (node: unknown): boolean => {
    if (!(node instanceof Node)) return false;
    if (node === host) return true;

    const root = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
    return root instanceof ShadowRoot && root.host === host;
  };

  // Helper: check if an event came from the editor UI
  const isEventFromUi = (event: Event): boolean => {
    try {
      if (typeof event.composedPath === 'function') {
        return event.composedPath().some((el) => isOverlayElement(el));
      }
    } catch {
      // Fallback to target
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
