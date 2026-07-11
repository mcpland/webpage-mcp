/**
 * Web Editor message listener.
 *
 * Handles chrome.runtime.onMessage communication with the background script.
 */

import type {
  ElementLocator,
  WebEditorApi,
  WebEditorRequest,
  WebEditorPingResponse,
  WebEditorToggleResponse,
  WebEditorStartResponse,
  WebEditorStopResponse,
} from "@/common/web-editor-types";
import { WEB_EDITOR_ACTIONS } from "@/common/web-editor-types";
import {
  WEB_EDITOR_RUNTIME_COMMAND_GLOBAL,
  type WebEditorRuntimeCommandHandler,
} from "@/common/web-editor-runtime";
import { PRIVILEGED_UI_SURFACES } from "@/common/message-types";
import {
  clearPrivilegedUiSurfaceSession,
  closePrivilegedUiSurfaceSession,
  configurePrivilegedUiSurfaceSession,
  matchesPrivilegedUiSurfaceSession,
} from "@/utils/privileged-ui-authorization";
import { locateElement } from "./locator";

// =============================================================================
// Types
// =============================================================================

/** Function to remove the command handler from the dedicated runtime world. */
export type RemoveWebEditorCommandHandler = () => void;

/** Highlight element request from sidepanel */
interface WebEditorHighlightRequest {
  action: typeof WEB_EDITOR_ACTIONS.HIGHLIGHT_ELEMENT;
  mode: "hover" | "clear";
  /** Full locator for Shadow DOM/iframe support */
  locator?: ElementLocator;
  /** Fallback selector for backward compatibility */
  selector?: string;
  elementKey?: string;
}

/** Highlight element response */
interface WebEditorHighlightResponse {
  success: boolean;
  error?: string;
}

/** Revert element request from sidepanel (Phase 2) */
interface WebEditorRevertRequest {
  action: typeof WEB_EDITOR_ACTIONS.REVERT_ELEMENT;
  elementKey: string;
}

/** Revert element response */
interface WebEditorRevertResponse {
  success: boolean;
  reverted?: {
    style?: boolean;
    text?: boolean;
    class?: boolean;
  };
  error?: string;
}

/** Clear selection request from sidepanel (after send) */
interface WebEditorClearSelectionRequest {
  action: typeof WEB_EDITOR_ACTIONS.CLEAR_SELECTION;
}

/** Clear selection response */
interface WebEditorClearSelectionResponse {
  success: boolean;
}

/** All possible editor response types */
type WebEditorResponse =
  | WebEditorPingResponse
  | WebEditorToggleResponse
  | WebEditorStartResponse
  | WebEditorStopResponse
  | WebEditorHighlightResponse
  | WebEditorRevertResponse
  | WebEditorClearSelectionResponse;

// =============================================================================
// Implementation
// =============================================================================

/**
 * Type guard to check if a request is a web editor request.
 */
function isEditorRequest(request: unknown): request is WebEditorRequest {
  if (!request || typeof request !== "object") return false;

  const action = (request as { action?: unknown }).action;
  return (
    action === WEB_EDITOR_ACTIONS.PING ||
    action === WEB_EDITOR_ACTIONS.TOGGLE ||
    action === WEB_EDITOR_ACTIONS.START ||
    action === WEB_EDITOR_ACTIONS.STOP
  );
}

function readPrivilegedSurfaceSessionId(request: unknown): string | null {
  if (!request || typeof request !== "object") return null;
  const value = (request as { privilegedSurfaceSessionId?: unknown })
    .privilegedSurfaceSessionId;
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? value
    : null;
}

/**
 * Type guard for highlight request
 */
function isHighlightRequest(
  request: unknown,
): request is WebEditorHighlightRequest {
  if (!request || typeof request !== "object") return false;
  const r = request as Record<string, unknown>;

  if (r.action !== WEB_EDITOR_ACTIONS.HIGHLIGHT_ELEMENT) return false;
  if (r.mode !== "hover" && r.mode !== "clear") return false;

  // Clear mode doesn't require locator/selector
  if (r.mode === "clear") return true;

  // Hover mode requires either locator or selector
  const hasSelector =
    typeof r.selector === "string" && r.selector.trim().length > 0;
  const hasLocator = r.locator !== null && typeof r.locator === "object";
  return hasSelector || hasLocator;
}

/**
 * Type guard for revert element request (Phase 2)
 */
function isRevertRequest(request: unknown): request is WebEditorRevertRequest {
  if (!request || typeof request !== "object") return false;
  const r = request as Record<string, unknown>;

  return (
    r.action === WEB_EDITOR_ACTIONS.REVERT_ELEMENT &&
    typeof r.elementKey === "string" &&
    r.elementKey.trim().length > 0
  );
}

/**
 * Type guard for clear selection request
 */
function isClearSelectionRequest(
  request: unknown,
): request is WebEditorClearSelectionRequest {
  if (!request || typeof request !== "object") return false;
  const r = request as Record<string, unknown>;
  return r.action === WEB_EDITOR_ACTIONS.CLEAR_SELECTION;
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
  const overlay = document.createElement("div");
  overlay.setAttribute("data-web-editor-highlight", "true");
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
// Dedicated runtime command handler
// =============================================================================

/**
 * Execute one background-owned command inside the dedicated USER_SCRIPT world.
 *
 * Handles:
 * - PING: Check if editor is active
 * - TOGGLE/START/STOP: Control editor state
 * - HIGHLIGHT_ELEMENT: Highlight element from sidepanel hover
 * - REVERT_ELEMENT: Revert element to original state
 * - CLEAR_SELECTION: Clear current selection (from sidepanel after send)
 *
 * @param api The WebEditorApi instance to delegate commands to
 * @returns A bounded command response, or null for an unknown command
 */
export async function handleWebEditorCommand(
  api: WebEditorApi,
  request: unknown,
): Promise<WebEditorResponse | null> {
  if (isHighlightRequest(request)) {
    if (request.mode === "clear") {
      clearHighlight();
      return { success: true };
    }

    let element: Element | null = null;
    if (request.locator) {
      try {
        element = locateElement(request.locator);
      } catch {
        element = null;
      }
    }
    if (!element && typeof request.selector === "string") {
      element = findElementBySelector(request.selector);
    }
    if (element) {
      showHighlight(element);
      return { success: true };
    }
    return { success: false, error: "Element not found" };
  }

  if (isRevertRequest(request)) {
    try {
      return await api.revertElement(request.elementKey);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (isClearSelectionRequest(request)) {
    api.clearSelection();
    return { success: true };
  }

  if (!isEditorRequest(request)) return null;

  switch (request.action) {
    case WEB_EDITOR_ACTIONS.PING: {
      return {
        status: "pong",
        active: api.getState().active || api.getState().stopping === true,
        version: api.getState().version,
      } satisfies WebEditorPingResponse;
    }

    case WEB_EDITOR_ACTIONS.TOGGLE: {
      const surfaceSessionId = readPrivilegedSurfaceSessionId(request);
      const editorState = api.getState();
      if (editorState.stopping) {
        return { active: false, error: "Web Editor is still stopping" };
      }
      if (editorState.active) {
        try {
          await api.stop();
        } catch {
          // The background still receives an inactive response and revokes the
          // surface session independently.
        }
        return { active: false } satisfies WebEditorToggleResponse;
      }
      clearPrivilegedUiSurfaceSession(PRIVILEGED_UI_SURFACES.WEB_EDITOR);
      if (
        !surfaceSessionId ||
        !configurePrivilegedUiSurfaceSession(
          PRIVILEGED_UI_SURFACES.WEB_EDITOR,
          surfaceSessionId,
        )
      ) {
        return {
          active: false,
          error: "Privileged Web Editor session is required",
        };
      }
      api.start(surfaceSessionId);
      const response: WebEditorToggleResponse = {
        active: api.getState().active,
      };
      if (!response.active) {
        void closePrivilegedUiSurfaceSession(
          PRIVILEGED_UI_SURFACES.WEB_EDITOR,
          surfaceSessionId,
        );
      }
      return response;
    }

    case WEB_EDITOR_ACTIONS.START: {
      const surfaceSessionId = readPrivilegedSurfaceSessionId(request);
      const editorState = api.getState();
      if (editorState.stopping) {
        return { active: false, error: "Web Editor is still stopping" };
      }
      if (editorState.active) {
        const sameSession =
          Boolean(surfaceSessionId) &&
          matchesPrivilegedUiSurfaceSession(
            PRIVILEGED_UI_SURFACES.WEB_EDITOR,
            surfaceSessionId as string,
          );
        return {
          active: sameSession,
          ...(sameSession
            ? {}
            : { error: "A different Web Editor session is already active" }),
        };
      }
      if (
        !surfaceSessionId ||
        !configurePrivilegedUiSurfaceSession(
          PRIVILEGED_UI_SURFACES.WEB_EDITOR,
          surfaceSessionId,
        )
      ) {
        return {
          active: false,
          error: "Privileged Web Editor session is required",
        };
      }
      api.start(surfaceSessionId);
      const active = api.getState().active;
      if (!active) {
        void closePrivilegedUiSurfaceSession(
          PRIVILEGED_UI_SURFACES.WEB_EDITOR,
          surfaceSessionId,
        );
      }
      return { active } satisfies WebEditorStartResponse;
    }

    case WEB_EDITOR_ACTIONS.STOP: {
      try {
        await api.stop();
      } catch {
        // Stop is idempotent from the background's point of view.
      }
      return { active: false } satisfies WebEditorStopResponse;
    }

    default:
      return null;
  }
}

/** Install the only command entrypoint in the dedicated USER_SCRIPT world. */
export function installWebEditorCommandHandler(
  api: WebEditorApi,
): RemoveWebEditorCommandHandler {
  const command: WebEditorRuntimeCommandHandler = (request) =>
    handleWebEditorCommand(api, request);
  const runtimeGlobal = globalThis as typeof globalThis &
    Record<string, unknown>;
  runtimeGlobal[WEB_EDITOR_RUNTIME_COMMAND_GLOBAL] = command;

  return () => {
    if (runtimeGlobal[WEB_EDITOR_RUNTIME_COMMAND_GLOBAL] === command) {
      delete runtimeGlobal[WEB_EDITOR_RUNTIME_COMMAND_GLOBAL];
    }
    clearHighlight();
  };
}
