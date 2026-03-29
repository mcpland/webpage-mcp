/**
 * Element Picker Tool
 *
 * Implements chrome_request_element_selection - a human-in-the-loop tool that allows
 * users to manually select elements on the page when AI cannot reliably locate them.
 */

import { createErrorResponse, type ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { BACKGROUND_MESSAGE_TYPES, TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { ERROR_MESSAGES } from '@/common/constants';
import { hasDisallowedPublicUrlScheme } from './common';
import {
  TOOL_NAMES,
  type ElementPickerRequest,
  type ElementPickerResult,
  type ElementPickerResultItem,
  type PickedElement,
} from 'webpage-mcp-shared';

// ============================================================
// Types
// ============================================================

interface NormalizedRequest {
  id: string;
  name: string;
  description?: string;
}

interface ElementPickerToolParams {
  requests: ElementPickerRequest[];
  timeoutMs?: number;
  tabId?: number;
  windowId?: number;
}

interface PickerUiEvent {
  type: string;
  sessionId: string;
  event: 'cancel' | 'confirm' | 'set_active_request' | 'clear_selection';
  requestId?: string;
}

interface PickerFrameEvent {
  type: string;
  sessionId: string;
  event: 'selected' | 'cancel';
  requestId?: string;
  element?: Omit<PickedElement, 'frameId'>;
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const MAX_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MIN_TIMEOUT_MS = 10 * 1000; // 10 seconds

// ============================================================
// Utility Functions
// ============================================================

function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTimeoutMs(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_TIMEOUT_MS;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(n), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function normalizeRequests(requests: ElementPickerRequest[]): NormalizedRequest[] {
  const out: NormalizedRequest[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < requests.length; i++) {
    const r = requests[i] || ({} as ElementPickerRequest);
    const name = toTrimmedString(r.name);
    if (!name) continue;

    // Generate or use provided ID, ensuring uniqueness
    const baseId = toTrimmedString(r.id) || `req_${i + 1}`;
    let id = baseId;
    let suffix = 2;
    while (seen.has(id)) {
      id = `${baseId}_${suffix++}`;
    }
    seen.add(id);

    const description = toTrimmedString(r.description);
    out.push({ id, name, description: description || undefined });
  }

  return out;
}

function buildResultItems(
  requests: NormalizedRequest[],
  pickedById: Map<string, PickedElement>,
): ElementPickerResultItem[] {
  return requests.map((r) => ({
    id: r.id,
    name: r.name,
    element: pickedById.get(r.id) || null,
  }));
}

function listMissingRequestIds(
  requests: NormalizedRequest[],
  pickedById: Map<string, PickedElement>,
): string[] {
  const missing: string[] = [];
  for (const r of requests) {
    if (!pickedById.has(r.id)) missing.push(r.id);
  }
  return missing;
}

// ============================================================
// Element Picker Tool
// ============================================================

class ElementPickerTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.REQUEST_ELEMENT_SELECTION;

  /**
   * Inject picker scripts into all frames of the tab.
   */
  private async injectPickerScripts(tabId: number): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['inject-scripts/element-picker.js'],
      world: 'ISOLATED',
      injectImmediately: false,
    } as any);
  }

  /**
   * Call the picker API in all frames via scripting.executeScript.
   */
  private async callPickerApi(
    tabId: number,
    method: 'startSession' | 'stopSession' | 'setActiveRequest',
    payload: Record<string, unknown>,
  ): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      injectImmediately: false,
      func: (methodName: string, data: Record<string, unknown>) => {
        try {
          const api = (
            globalThis as unknown as {
              __mcpElementPicker?: Record<string, (data: Record<string, unknown>) => void>;
            }
          ).__mcpElementPicker;
          const fn = api && api[methodName];
          if (typeof fn === 'function') {
            fn(data);
          }
        } catch {
          // Best-effort
        }
      },
      args: [method, payload],
    } as any);
  }

  async execute(args: ElementPickerToolParams): Promise<ToolResult> {
    // Validate requests
    const rawRequests = Array.isArray(args?.requests) ? args.requests : [];
    if (rawRequests.length === 0) {
      return createErrorResponse(`${ERROR_MESSAGES.INVALID_PARAMETERS}: requests[] is required`);
    }

    const requests = normalizeRequests(rawRequests);
    if (requests.length === 0) {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: requests[] must contain at least one non-empty name`,
      );
    }

    const timeoutMs = normalizeTimeoutMs(args?.timeoutMs);
    const sessionId = `ep_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const deadlineTs = Date.now() + timeoutMs;

    // Resolve tab
    let tab: chrome.tabs.Tab;
    try {
      const explicit = await this.tryGetTab(args?.tabId);
      tab = explicit || (await this.getActiveTabOrThrowInWindow(args?.windowId));
    } catch (error) {
      return createErrorResponse(
        `${ERROR_MESSAGES.TAB_NOT_FOUND}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!tab.id) {
      return createErrorResponse(`${ERROR_MESSAGES.TAB_NOT_FOUND}: Active tab has no ID`);
    }
    if (hasDisallowedPublicUrlScheme(String(tab.url || ''))) {
      return createErrorResponse(
        'Only http:// and https:// pages are supported by chrome_request_element_selection',
      );
    }
    const tabId = tab.id;

    // Focus the tab/window for user interaction
    try {
      await this.ensureFocus(tab, { activate: true, focusWindow: true });
    } catch {
      // Best-effort: some environments disallow focusing
    }

    // State tracking
    const pickedById = new Map<string, PickedElement>();
    let activeRequestId: string | null = requests[0]?.id || null;
    let uiErrorMessage: string | null = null;
    let uiAvailable = true;

    let finished = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let resolveResult: ((result: ElementPickerResult) => void) | null = null;

    // Send UI update to content script
    const sendUiUpdate = async (): Promise<void> => {
      if (!uiAvailable) return;
      try {
        const selections: Record<string, PickedElement | null> = {};
        for (const r of requests) {
          selections[r.id] = pickedById.get(r.id) || null;
        }
        await this.sendMessageToTab(
          tabId,
          {
            action: TOOL_MESSAGE_TYPES.ELEMENT_PICKER_UI_UPDATE,
            sessionId,
            activeRequestId,
            selections,
            deadlineTs,
            errorMessage: uiErrorMessage,
          },
          0, // Top frame only for UI
        );
      } catch {
        uiAvailable = false;
      }
    };

    // Set the active request and notify all frames + UI
    const setActiveRequest = async (requestId: string | null): Promise<void> => {
      activeRequestId = requestId;
      await this.callPickerApi(tabId, 'setActiveRequest', {
        sessionId,
        activeRequestId: requestId,
      });
      await sendUiUpdate();
    };

    // Finish the tool execution
    const finish = async (final: {
      success: boolean;
      cancelled?: boolean;
      timedOut?: boolean;
    }): Promise<void> => {
      if (finished) return;
      finished = true;

      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }

      chrome.runtime.onMessage.removeListener(onRuntimeMessage);

      // Cleanup: stop picker in all frames and hide UI
      await Promise.allSettled([
        this.callPickerApi(tabId, 'stopSession', { sessionId }),
        uiAvailable
          ? this.sendMessageToTab(
              tabId,
              { action: TOOL_MESSAGE_TYPES.ELEMENT_PICKER_UI_HIDE, sessionId },
              0,
            )
          : Promise.resolve(),
      ]);

      const missing = listMissingRequestIds(requests, pickedById);
      const result: ElementPickerResult = {
        success: final.success,
        sessionId,
        timeoutMs,
        cancelled: final.cancelled,
        timedOut: final.timedOut,
        missingRequestIds: missing.length > 0 ? missing : undefined,
        results: buildResultItems(requests, pickedById),
      };

      resolveResult?.(result);
    };

    // Handle messages from content scripts
    const onRuntimeMessage = (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): boolean | void => {
      const senderTabId = sender?.tab?.id;
      if (senderTabId !== tabId) return;

      const msg = message as Partial<PickerUiEvent & PickerFrameEvent> | undefined;
      if (!msg || msg.sessionId !== sessionId) return;

      // Handle frame events (element selection)
      if (msg.type === BACKGROUND_MESSAGE_TYPES.ELEMENT_PICKER_FRAME_EVENT) {
        if (msg.event === 'cancel') {
          void finish({ success: false, cancelled: true });
          sendResponse?.({ success: true });
          return true;
        }

        if (msg.event === 'selected') {
          const requestId = toTrimmedString(msg.requestId);
          const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;

          // Validate request ID
          const reqExists = requestId && requests.some((r) => r.id === requestId);
          if (!reqExists) {
            sendResponse?.({ success: false, error: 'Unknown requestId' });
            return true;
          }

          // Validate element data
          const raw = (msg.element || {}) as Partial<Omit<PickedElement, 'frameId'>>;
          const ref = toTrimmedString(raw.ref);
          if (!ref) {
            sendResponse?.({ success: false, error: 'Missing element.ref' });
            return true;
          }

          // Build picked element with frameId
          const selector = toTrimmedString(raw.selector);
          const rect = raw.rect as PickedElement['rect'] | undefined;
          const center = raw.center as PickedElement['center'] | undefined;
          const picked: PickedElement = {
            ref,
            selector,
            selectorType: 'css',
            rect: rect && typeof rect === 'object' ? rect : { x: 0, y: 0, width: 0, height: 0 },
            center: center && typeof center === 'object' ? center : { x: 0, y: 0 },
            text: typeof raw.text === 'string' ? raw.text : undefined,
            tagName: typeof raw.tagName === 'string' ? raw.tagName : undefined,
            frameId,
          };

          pickedById.set(requestId, picked);
          uiErrorMessage = null;

          // Auto-advance to next missing request
          const missing = listMissingRequestIds(requests, pickedById);
          const next = missing.length > 0 ? missing[0] : null;

          void (async () => {
            try {
              if (next) {
                await setActiveRequest(next);
              } else {
                // All selected: update UI (user still needs to confirm)
                await sendUiUpdate();
                // If UI is unavailable, auto-confirm
                if (!uiAvailable) {
                  await finish({ success: true });
                }
              }
            } catch {
              // Best-effort
            }
          })();

          sendResponse?.({ success: true });
          return true;
        }
      }

      // Handle UI events (cancel, confirm, etc.)
      if (msg.type === BACKGROUND_MESSAGE_TYPES.ELEMENT_PICKER_UI_EVENT) {
        if (msg.event === 'cancel') {
          void finish({ success: false, cancelled: true });
          sendResponse?.({ success: true });
          return true;
        }

        if (msg.event === 'confirm') {
          const missing = listMissingRequestIds(requests, pickedById);
          if (missing.length > 0) {
            uiErrorMessage = `Please select all elements: missing ${missing.join(', ')}`;
            void sendUiUpdate();
            sendResponse?.({ success: false, error: 'missing_selections', missing });
            return true;
          }
          void finish({ success: true });
          sendResponse?.({ success: true });
          return true;
        }

        if (msg.event === 'set_active_request') {
          const requestId = toTrimmedString(msg.requestId);
          if (!requestId || !requests.some((r) => r.id === requestId)) {
            sendResponse?.({ success: false, error: 'Unknown requestId' });
            return true;
          }
          void setActiveRequest(requestId);
          sendResponse?.({ success: true });
          return true;
        }

        if (msg.event === 'clear_selection') {
          const requestId = toTrimmedString(msg.requestId);
          if (!requestId || !requests.some((r) => r.id === requestId)) {
            sendResponse?.({ success: false, error: 'Unknown requestId' });
            return true;
          }
          pickedById.delete(requestId);
          uiErrorMessage = null;
          void setActiveRequest(requestId);
          sendResponse?.({ success: true });
          return true;
        }
      }

      return;
    };

    try {
      // Step 1: Ensure UI content script is ready (ping + inject fallback)
      const ensureUiReady = async (): Promise<boolean> => {
        // Try to ping UI content script with retries
        const pingWithTimeout = async (timeoutMs = 500): Promise<boolean> => {
          try {
            const resp = await Promise.race([
              this.sendMessageToTab(
                tabId,
                { action: TOOL_MESSAGE_TYPES.ELEMENT_PICKER_UI_PING },
                0,
              ),
              new Promise<null>((_, reject) =>
                setTimeout(() => reject(new Error('Ping timeout')), timeoutMs),
              ),
            ]);
            return resp?.success === true;
          } catch {
            return false;
          }
        };

        // First ping attempt (content script may already be loaded)
        if (await pingWithTimeout()) return true;

        // Try to inject UI content script as fallback
        // Try multiple possible paths (production vs dev builds)
        const possiblePaths = ['content-scripts/element-picker.js', 'element-picker.js'];

        for (const path of possiblePaths) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId, frameIds: [0] },
              files: [path],
              injectImmediately: true,
            } as any);
            // Wait a bit for script to initialize
            await new Promise((r) => setTimeout(r, 150));
            // Check if injection worked
            if (await pingWithTimeout(300)) return true;
          } catch (e) {
            // Try next path
            console.debug(`[ElementPicker] Path ${path} failed:`, e);
          }
        }

        // Final attempt with longer timeout (in case of slow page)
        return pingWithTimeout(1000);
      };

      const uiReady = await ensureUiReady();
      if (!uiReady) {
        console.error('[ElementPicker] UI not available after all attempts');
        return createErrorResponse(
          `${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: Element Picker UI is not available. This may happen if: (1) The page blocks content scripts, (2) You're using dev mode - try restarting the dev server or use production build, (3) The page needs to be refreshed.`,
        );
      }

      // Step 2: Show UI in top frame (must receive success:true)
      try {
        const showResp = await this.sendMessageToTab(
          tabId,
          {
            action: TOOL_MESSAGE_TYPES.ELEMENT_PICKER_UI_SHOW,
            sessionId,
            requests,
            activeRequestId,
            deadlineTs,
          },
          0,
        );
        if (showResp?.success !== true) {
          throw new Error('UI did not acknowledge show message');
        }
      } catch (e) {
        console.error('[ElementPicker] UI show failed:', e);
        return createErrorResponse(
          `${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: Failed to show Element Picker UI. Please refresh the page and try again.`,
        );
      }

      // Step 3: Inject picker scripts and start selection engine in all frames
      await this.injectPickerScripts(tabId);
      await this.callPickerApi(tabId, 'startSession', { sessionId, activeRequestId });

      // Register message listener
      chrome.runtime.onMessage.addListener(onRuntimeMessage);

      // Create result promise
      const resultPromise = new Promise<ElementPickerResult>((resolve) => {
        resolveResult = resolve;
      });

      // Set timeout
      timer = setTimeout(() => {
        void finish({ success: false, timedOut: true });
      }, timeoutMs);

      // Initial UI update
      void sendUiUpdate();

      // Wait for result
      const result = await resultPromise;
      return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
    } catch (error) {
      console.error('Error in element picker tool:', error);
      // Cleanup on error
      try {
        await Promise.allSettled([
          this.callPickerApi(tabId, 'stopSession', { sessionId }),
          this.sendMessageToTab(
            tabId,
            { action: TOOL_MESSAGE_TYPES.ELEMENT_PICKER_UI_HIDE, sessionId },
            0,
          ),
        ]);
      } catch {
        // Best-effort cleanup
      }
      return createErrorResponse(
        `${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const elementPickerTool = new ElementPickerTool();
