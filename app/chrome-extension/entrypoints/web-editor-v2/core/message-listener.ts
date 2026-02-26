/**
 * Web Editor V2 Message Listener
 *
 * Handles chrome.runtime.onMessage communication with the background script.
 * Uses versioned action names (suffix _v2) to avoid conflicts with V1.
 */

import type {
  ElementLocator,
  WebEditorV2Api,
  WebEditorV2Request,
  WebEditorV2PingResponse,
  WebEditorV2ToggleResponse,
  WebEditorV2StartResponse,
  WebEditorV2StopResponse,
} from '@/common/web-editor-types';
import { WEB_EDITOR_V2_ACTIONS } from '@/common/web-editor-types';
import { locateElement } from './locator';

// =============================================================================
// Types
// =============================================================================

/** Function to remove the message listener */
export type RemoveMessageListener = () => void;

/** Highlight element request from sidepanel */
interface WebEditorV2HighlightRequest {
  action: typeof WEB_EDITOR_V2_ACTIONS.HIGHLIGHT_ELEMENT;
  mode: 'hover' | 'clear';
  /** Full locator for Shadow DOM/iframe support */
  locator?: ElementLocator;
  /** Fallback selector for backward compatibility */
  selector?: string;
  elementKey?: string;
}

/** Highlight element response */
interface WebEditorV2HighlightResponse {
  success: boolean;
  error?: string;
}

/** Revert element request from sidepanel (Phase 2) */
interface WebEditorV2RevertRequest {
  action: typeof WEB_EDITOR_V2_ACTIONS.REVERT_ELEMENT;
  elementKey: string;
}

/** Revert element response */
interface WebEditorV2RevertResponse {
  success: boolean;
  reverted?: {
    style?: boolean;
    text?: boolean;
    class?: boolean;
  };
  error?: string;
}

/** Clear selection request from sidepanel (after send) */
interface WebEditorV2ClearSelectionRequest {
  action: typeof WEB_EDITOR_V2_ACTIONS.CLEAR_SELECTION;
}

/** Clear selection response */
interface WebEditorV2ClearSelectionResponse {
  success: boolean;
}

/** All possible V2 response types */
type WebEditorV2Response =
  | WebEditorV2PingResponse
  | WebEditorV2ToggleResponse
  | WebEditorV2StartResponse
  | WebEditorV2StopResponse
  | WebEditorV2HighlightResponse
  | WebEditorV2RevertResponse
  | WebEditorV2ClearSelectionResponse;

// =============================================================================
// Implementation
// =============================================================================

/**
 * Type guard to check if a request is a V2 editor request
 */
function isV2Request(request: unknown): request is WebEditorV2Request {
  if (!request || typeof request !== 'object') return false;

  const action = (request as { action?: unknown }).action;
  return (
    action === WEB_EDITOR_V2_ACTIONS.PING ||
    action === WEB_EDITOR_V2_ACTIONS.TOGGLE ||
    action === WEB_EDITOR_V2_ACTIONS.START ||
    action === WEB_EDITOR_V2_ACTIONS.STOP
  );
}

/**
 * Type guard for highlight request
 */
function isHighlightRequest(request: unknown): request is WebEditorV2HighlightRequest {
  if (!request || typeof request !== 'object') return false;
  const r = request as Record<string, unknown>;

  if (r.action !== WEB_EDITOR_V2_ACTIONS.HIGHLIGHT_ELEMENT) return false;
  if (r.mode !== 'hover' && r.mode !== 'clear') return false;

  // Clear mode doesn't require locator/selector
  if (r.mode === 'clear') return true;

  // Hover mode requires either locator or selector
  const hasSelector = typeof r.selector === 'string' && r.selector.trim().length > 0;
  const hasLocator = r.locator !== null && typeof r.locator === 'object';
  return hasSelector || hasLocator;
}

/**
 * Type guard for revert element request (Phase 2)
 */
function isRevertRequest(request: unknown): request is WebEditorV2RevertRequest {
  if (!request || typeof request !== 'object') return false;
  const r = request as Record<string, unknown>;

  return (
    r.action === WEB_EDITOR_V2_ACTIONS.REVERT_ELEMENT &&
    typeof r.elementKey === 'string' &&
    r.elementKey.trim().length > 0
  );
}

/**
 * Type guard for clear selection request
 */
function isClearSelectionRequest(request: unknown): request is WebEditorV2ClearSelectionRequest {
  if (!request || typeof request !== 'object') return false;
  const r = request as Record<string, unknown>;
  return r.action === WEB_EDITOR_V2_ACTIONS.CLEAR_SELECTION;
}

// =============================================================================
// Highlight State Management
// =============================================================================

/** Currently highlighted element (for clearing on next hover or explicit clear) */
let currentHighlightElement: Element | null = null;
let currentHighlightOverlay: HTMLElement | null = null;

/**
 * Clear any existing highlight overlay
 */
function clearHighlight(): void {
  if (currentHighlightOverlay && currentHighlightOverlay.parentNode) {
    currentHighlightOverlay.parentNode.removeChild(currentHighlightOverlay);
  }
  currentHighlightOverlay = null;
  currentHighlightElement = null;
}

/**
 * Create and show highlight overlay for an element
 */
function showHighlight(element: Element): void {
  // Clear previous highlight
  clearHighlight();

  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    // Element is not visible
    return;
  }

  // Create overlay element
  const overlay = document.createElement('div');
  overlay.setAttribute('data-web-editor-highlight', 'true');
  overlay.style.cssText = `
    position: fixed;
    top: ${rect.top}px;
    left: ${rect.left}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    background-color: rgba(59, 130, 246, 0.15);
    border: 2px solid rgba(59, 130, 246, 0.8);
    border-radius: 4px;
    pointer-events: none;
    z-index: 2147483646;
    box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.1);
    transition: all 0.15s ease;
  `;

  document.body.appendChild(overlay);
  currentHighlightOverlay = overlay;
  currentHighlightElement = element;
}

/**
 * Find element by CSS selector (fallback when locator-based resolution fails)
 */
function findElementBySelector(selector: string): Element | null {
  try {
    return document.querySelector(selector);
  } catch {
    // Invalid selector
    return null;
  }
}

// =============================================================================
// Message Listener
// =============================================================================

/**
 * Install the message listener for background communication.
 * Returns a function to remove the listener.
 *
 * Handles:
 * - PING: Check if editor is active
 * - TOGGLE/START/STOP: Control editor state
 * - HIGHLIGHT_ELEMENT: Highlight element from sidepanel hover
 * - REVERT_ELEMENT: Revert element to original state
 * - CLEAR_SELECTION: Clear current selection (from sidepanel after send)
 *
 * @param api The WebEditorV2Api instance to delegate commands to
 * @returns Function to remove the listener
 */
export function installMessageListener(api: WebEditorV2Api): RemoveMessageListener {
  const listener = (
    request: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: WebEditorV2Response) => void,
  ): boolean => {
    // Handle highlight requests (can work even when editor is not active)
    if (isHighlightRequest(request)) {
      if (request.mode === 'clear') {
        clearHighlight();
        sendResponse({ success: true });
      } else {
        // mode === 'hover'
        let element: Element | null = null;

        // Prefer locator-based resolution (supports Shadow DOM host chain)
        if (request.locator) {
          try {
            element = locateElement(request.locator);
          } catch {
            element = null;
          }
        }

        // Fallback to selector (backward compatibility / degraded locators)
        if (!element && typeof request.selector === 'string') {
          element = findElementBySelector(request.selector);
        }

        if (element) {
          showHighlight(element);
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: 'Element not found' });
        }
      }
      return false; // Synchronous
    }

    // Handle revert element requests (Phase 2 - Selective Undo)
    if (isRevertRequest(request)) {
      // Revert is async, so we return true and call sendResponse later
      (async () => {
        try {
          const result = await api.revertElement(request.elementKey);
          sendResponse(result);
        } catch (error) {
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      return true; // Async response
    }

    // Handle clear selection requests (from sidepanel after send)
    if (isClearSelectionRequest(request)) {
      api.clearSelection();
      sendResponse({ success: true });
      return false; // Synchronous
    }

    // Only handle V2 requests for other actions
    if (!isV2Request(request)) {
      return false;
    }

    switch (request.action) {
      case WEB_EDITOR_V2_ACTIONS.PING: {
        const response: WebEditorV2PingResponse = {
          status: 'pong',
          active: api.getState().active,
          version: 2,
        };
        sendResponse(response);
        return false; // Synchronous response
      }

      case WEB_EDITOR_V2_ACTIONS.TOGGLE: {
        const response: WebEditorV2ToggleResponse = {
          active: api.toggle(),
        };
        sendResponse(response);
        return false;
      }

      case WEB_EDITOR_V2_ACTIONS.START: {
        api.start();
        const response: WebEditorV2StartResponse = {
          active: true,
        };
        sendResponse(response);
        return false;
      }

      case WEB_EDITOR_V2_ACTIONS.STOP: {
        api.stop();
        const response: WebEditorV2StopResponse = {
          active: false,
        };
        sendResponse(response);
        return false;
      }

      default:
        // Should never reach here due to type guard
        return false;
    }
  };

  chrome.runtime.onMessage.addListener(listener);

  return () => {
    chrome.runtime.onMessage.removeListener(listener);
    // Clean up any highlight when listener is removed
    clearHighlight();
  };
}
