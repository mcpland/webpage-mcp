/**
 * Quick Panel Agent Handler
 *
 * Background service that bridges Quick Panel (content script) with the native-server Agent.
 * Handles message routing, SSE streaming, and lifecycle management for AI chat requests.
 *
 * Architecture:
 * - Quick Panel sends QUICK_PANEL_SEND_TO_AI via chrome.runtime.sendMessage
 * - This handler subscribes to SSE first, then fires POST /act
 * - Incoming RealtimeEvents are filtered by requestId and forwarded to the originating tab
 * - Keepalive is explicitly managed to prevent MV3 Service Worker suspension during streaming
 *
 * @see https://developer.chrome.com/docs/extensions/mv3/service_workers/
 */

import type { AgentActRequest, RealtimeEvent } from 'webpage-mcp-shared';
import { NativeMessageType } from 'webpage-mcp-shared';

import { NATIVE_HOST, STORAGE_KEYS } from '@/common/constants';
import {
  BACKGROUND_MESSAGE_TYPES,
  TOOL_MESSAGE_TYPES,
  type QuickPanelAIEventMessage,
  type QuickPanelCancelAIMessage,
  type QuickPanelCancelAIResponse,
  type QuickPanelSendToAIMessage,
  type QuickPanelSendToAIResponse,
} from '@/common/message-types';
import { acquireKeepalive } from '../keepalive-manager';
import { openAgentChatSidepanel } from '../utils/sidepanel';

// ============================================================
// Constants
// ============================================================

const LOG_PREFIX = '[QuickPanelAgent]';
const KEEPALIVE_TAG = 'quick-panel-ai';

/** Storage key for AgentChat selected session ID (owned by sidepanel composables) */
const STORAGE_KEY_SELECTED_SESSION = 'agent-selected-session-id';

/** Timeout for initial SSE connection establishment */
const SSE_CONNECT_TIMEOUT_MS = 3000;

/** Safety timeout for entire request lifecycle (15 minutes) */
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

/** Flag indicating SSE connection was successful */
const SSE_CONNECTED = Symbol('SSE_CONNECTED');

/** Flag indicating SSE connection timed out but we should continue */
const SSE_TIMEOUT = Symbol('SSE_TIMEOUT');

// ============================================================
// Types
// ============================================================

/**
 * Represents an active streaming request from Quick Panel.
 *
 * Background maintains this state to:
 * 1. Route SSE events to the correct tab
 * 2. Manage keepalive lifecycle
 * 3. Handle cancellation and cleanup
 */
interface ActiveRequest {
  readonly requestId: string;
  readonly sessionId: string;
  readonly instruction: string;
  readonly tabId: number;
  readonly windowId?: number;
  readonly frameId?: number;
  readonly port: number;
  readonly createdAt: number;
  readonly abortController: AbortController;
  readonly releaseKeepalive: () => void;
  readonly timeoutId: ReturnType<typeof setTimeout>;
}

// ============================================================
// State
// ============================================================

/** Active streaming requests indexed by requestId */
const activeRequests = new Map<string, ActiveRequest>();

/** Initialization flag to prevent duplicate listeners */
let initialized = false;

// ============================================================
// Utility Functions
// ============================================================

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizePort(value: unknown): number | null {
  const num =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;

  if (!Number.isFinite(num)) return null;

  const port = Math.floor(num);
  if (port <= 0 || port > 65535) return null;

  return port;
}

function createRequestId(): string {
  // Prefer crypto.randomUUID for proper UUID format
  try {
    const id = crypto?.randomUUID?.();
    if (id) return id;
  } catch {
    // Fallback for environments without crypto.randomUUID
  }
  return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'error' || status === 'cancelled';
}

// ============================================================
// Event Factories
// ============================================================

function createErrorEvent(sessionId: string, requestId: string, error: string): RealtimeEvent {
  return {
    type: 'error',
    error: error || 'Unknown error',
    data: { sessionId, requestId },
  };
}

function createCancelledStatusEvent(
  sessionId: string,
  requestId: string,
  message?: string,
): RealtimeEvent {
  return {
    type: 'status',
    data: {
      sessionId,
      status: 'cancelled',
      requestId,
      message: message || 'Cancelled by user',
    },
  };
}

// ============================================================
// Event Forwarding
// ============================================================

/**
 * Forward a RealtimeEvent to the Quick Panel in the originating tab.
 * Handles receiver unavailability gracefully by cleaning up the request.
 */
function forwardEventToQuickPanel(request: ActiveRequest, event: RealtimeEvent): void {
  const message: QuickPanelAIEventMessage = {
    action: TOOL_MESSAGE_TYPES.QUICK_PANEL_AI_EVENT,
    requestId: request.requestId,
    sessionId: request.sessionId,
    event,
  };

  const sendOptions =
    typeof request.frameId === 'number' ? { frameId: request.frameId } : undefined;

  const sendPromise = sendOptions
    ? chrome.tabs.sendMessage(request.tabId, message, sendOptions)
    : chrome.tabs.sendMessage(request.tabId, message);

  sendPromise.catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);

    // Detect receiver unavailability (tab closed, navigated, Quick Panel closed)
    const receiverGone =
      msg.includes('Receiving end does not exist') ||
      msg.includes('No tab with id') ||
      msg.includes('The message port closed');

    if (receiverGone) {
      cleanupRequest(request.requestId, 'receiver_unavailable');
    }
  });
}

// ============================================================
// Request Lifecycle Management
// ============================================================

/**
 * Clean up an active request and release all associated resources.
 * Idempotent - safe to call multiple times.
 */
function cleanupRequest(requestId: string, reason: string): void {
  const request = activeRequests.get(requestId);
  if (!request) return;

  activeRequests.delete(requestId);

  // Clear timeout
  try {
    clearTimeout(request.timeoutId);
  } catch {
    // Ignore
  }

  // Abort SSE connection
  try {
    request.abortController.abort();
  } catch {
    // Ignore
  }

  // Release keepalive
  try {
    request.releaseKeepalive();
  } catch {
    // Ignore
  }

  console.debug(`${LOG_PREFIX} Cleaned up request ${requestId} (${reason})`);
}

// ============================================================
// Session Validation
// ============================================================

/**
 * Validate that the selected session exists on the native server.
 * Returns false if the session is invalid or server is unreachable.
 */
async function validateSession(port: number, sessionId: string): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/agent/sessions/${encodeURIComponent(sessionId)}`;
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

// ============================================================
// SSE Event Filtering
// ============================================================

/**
 * Determine if a RealtimeEvent should be forwarded for a specific requestId.
 *
 * Events without requestId (connected, heartbeat) are session-level signals
 * and are not forwarded to avoid confusion with request-specific events.
 */
function shouldForwardEvent(event: RealtimeEvent, requestId: string): boolean {
  switch (event.type) {
    case 'message':
      return event.data?.requestId === requestId;
    case 'status':
      return event.data?.requestId === requestId;
    case 'usage':
      return event.data?.requestId === requestId;
    case 'error':
      return event.data?.requestId === requestId;
    case 'connected':
    case 'heartbeat':
      // Session-level signals, not request-scoped
      return false;
    default:
      return false;
  }
}

// ============================================================
// SSE Subscription
// ============================================================

interface SseSubscription {
  /**
   * Resolves with true when SSE connection is established.
   * Resolves with false if connection failed (request was cleaned up).
   */
  ready: Promise<boolean>;
  /** Resolves when SSE stream ends (normally or due to error/abort) */
  done: Promise<void>;
}

/**
 * Create an SSE subscription for the request's session.
 *
 * The subscription:
 * 1. Connects to the session's /stream endpoint
 * 2. Filters events by requestId
 * 3. Forwards matching events to Quick Panel
 * 4. Triggers cleanup on terminal status
 *
 * @returns SseSubscription with ready promise that resolves to:
 *   - true: SSE connected successfully
 *   - false: SSE failed (request was cleaned up, don't send /act)
 */
function createSseSubscription(request: ActiveRequest): SseSubscription {
  // Track whether ready has been resolved
  let readySettled = false;
  let readyResolve: (connected: boolean) => void;

  const ready = new Promise<boolean>((resolve) => {
    readyResolve = resolve;
  });

  // Helper to resolve ready exactly once
  const settleReady = (connected: boolean): void => {
    if (readySettled) return;
    readySettled = true;
    readyResolve(connected);
  };

  const done = (async () => {
    const sseUrl = `http://127.0.0.1:${request.port}/agent/chat/${encodeURIComponent(request.sessionId)}/stream`;

    try {
      const response = await fetch(sseUrl, {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        signal: request.abortController.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`SSE stream unavailable (HTTP ${response.status})`);
      }

      // Signal that SSE is connected successfully
      settleReady(true);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Read and parse SSE stream
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;

          try {
            const event = JSON.parse(raw) as RealtimeEvent;

            // Filter by requestId to prevent cross-request leakage
            if (!shouldForwardEvent(event, request.requestId)) {
              continue;
            }

            forwardEventToQuickPanel(request, event);

            // Cleanup on terminal status
            if (event.type === 'status' && event.data?.requestId === request.requestId) {
              if (isTerminalStatus(event.data.status)) {
                cleanupRequest(request.requestId, `terminal_status:${event.data.status}`);
                return;
              }
            }
          } catch {
            // Ignore parse errors (best-effort stream processing)
          }
        }
      }
    } catch (err) {
      // AbortError is intentional (cancellation or cleanup)
      if (err instanceof Error && err.name === 'AbortError') {
        // Signal not connected if aborted before connecting
        settleReady(false);
        return;
      }

      // Surface error to UI and cleanup if request is still active
      if (activeRequests.has(request.requestId)) {
        const msg = err instanceof Error ? err.message : String(err);
        forwardEventToQuickPanel(
          request,
          createErrorEvent(request.sessionId, request.requestId, msg),
        );
        cleanupRequest(request.requestId, 'sse_error');
      }

      // Signal failed connection
      settleReady(false);
    }
  })();

  return { ready, done };
}

// ============================================================
// Agent API
// ============================================================

/**
 * Send the act request to native-server.
 * The server will emit events via SSE which are already being subscribed.
 *
 * @param request - Active request context
 * @throws Error if request was cancelled/aborted or HTTP request fails
 */
async function postActRequest(request: ActiveRequest): Promise<void> {
  // Check if request was cancelled before sending
  if (request.abortController.signal.aborted) {
    throw new Error('Request was cancelled');
  }

  const url = `http://127.0.0.1:${request.port}/agent/chat/${encodeURIComponent(request.sessionId)}/act`;

  const payload: AgentActRequest = {
    instruction: request.instruction,
    // Ensures session-level config is loaded (engine, model, options, project binding)
    dbSessionId: request.sessionId,
    // Enables SSE-first flow and requestId filtering on session-scoped streams
    requestId: request.requestId,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: request.abortController.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `HTTP ${response.status}`);
  }
}

/**
 * Cancel an active request on the native-server.
 */
async function cancelRequestOnServer(
  port: number,
  sessionId: string,
  requestId: string,
): Promise<void> {
  const url = `http://127.0.0.1:${port}/agent/chat/${encodeURIComponent(sessionId)}/cancel/${encodeURIComponent(requestId)}`;
  try {
    await fetch(url, { method: 'DELETE' });
  } catch {
    // Best-effort: cancellation might still succeed if request already ended
  }
}

// ============================================================
// Request Orchestration
// ============================================================

/**
 * Check if the request is still active and not cancelled.
 * Used as a guard before each async operation to handle race conditions.
 */
function isRequestStillActive(request: ActiveRequest): boolean {
  return activeRequests.has(request.requestId) && !request.abortController.signal.aborted;
}

/**
 * Main orchestration function for starting a Quick Panel AI request.
 *
 * Flow:
 * 1. Ensure native server is running
 * 2. Validate session exists
 * 3. Open sidepanel (best-effort)
 * 4. Start SSE subscription (wait for connection)
 * 5. Fire act request
 * 6. Let SSE handle event forwarding and cleanup
 *
 * @remarks
 * Guards are placed after each async operation to handle cancellation races.
 */
async function startRequest(request: ActiveRequest): Promise<void> {
  try {
    // Best-effort: ensure native server is running
    await chrome.runtime.sendMessage({ type: NativeMessageType.ENSURE_NATIVE }).catch(() => null);

    // Guard: check if cancelled during ENSURE_NATIVE
    if (!isRequestStillActive(request)) return;

    // Validate session still exists
    const sessionValid = await validateSession(request.port, request.sessionId);

    // Guard: check if cancelled during validation
    if (!isRequestStillActive(request)) return;

    if (!sessionValid) {
      forwardEventToQuickPanel(
        request,
        createErrorEvent(
          request.sessionId,
          request.requestId,
          'Selected Agent session is not available. Please open AgentChat and select a valid session.',
        ),
      );
      // Open sidepanel without deep-linking to invalid session
      openAgentChatSidepanel(request.tabId, request.windowId).catch(() => {});
      cleanupRequest(request.requestId, 'session_invalid');
      return;
    }

    // Best-effort: open sidepanel deep-linked to current session
    openAgentChatSidepanel(request.tabId, request.windowId, request.sessionId).catch(() => {});

    // Start SSE subscription BEFORE sending act request to avoid missing early events
    const sse = createSseSubscription(request);

    // Wait for SSE connection with timeout
    // The race returns either:
    // - boolean from sse.ready (true=connected, false=failed)
    // - undefined from timeout (treat as "proceed with caution")
    const sseResult = await Promise.race([
      sse.ready,
      sleep(SSE_CONNECT_TIMEOUT_MS).then(() => SSE_TIMEOUT),
    ]);

    // Guard: check if cancelled during SSE connection
    if (!isRequestStillActive(request)) return;

    // If SSE explicitly failed (returned false), don't send /act
    // The SSE subscription already cleaned up and sent error to UI
    if (sseResult === false) {
      console.debug(`${LOG_PREFIX} SSE failed for ${request.requestId}, not sending /act`);
      return;
    }

    // If SSE timed out, log warning but continue (degraded experience)
    if (sseResult === SSE_TIMEOUT) {
      console.warn(
        `${LOG_PREFIX} SSE connection timed out for ${request.requestId}, proceeding anyway`,
      );
    }

    // Fire the act request
    await postActRequest(request);

    // SSE subscription continues running and will handle cleanup on terminal status
    void sse.done;
  } catch (err) {
    // Abort errors are expected during cancellation
    if (err instanceof Error && err.name === 'AbortError') {
      return;
    }

    // Request may have been cleaned up already
    if (!activeRequests.has(request.requestId)) return;

    const msg = err instanceof Error ? err.message : String(err);
    forwardEventToQuickPanel(request, createErrorEvent(request.sessionId, request.requestId, msg));
    cleanupRequest(request.requestId, 'start_failed');
  }
}

// ============================================================
// Message Handlers
// ============================================================

/**
 * Handle QUICK_PANEL_SEND_TO_AI message.
 * Creates a new streaming request and starts the orchestration flow.
 */
async function handleSendToAI(
  message: QuickPanelSendToAIMessage,
  sender: chrome.runtime.MessageSender,
): Promise<QuickPanelSendToAIResponse> {
  const tabId = sender?.tab?.id;
  const windowId = sender?.tab?.windowId;
  const frameId = typeof sender?.frameId === 'number' ? sender.frameId : undefined;

  if (typeof tabId !== 'number') {
    return { success: false, error: 'Quick Panel request must originate from a tab.' };
  }

  const instruction = normalizeString(message?.payload?.instruction).trim();
  if (!instruction) {
    return { success: false, error: 'instruction is required' };
  }

  // Read server port and selected session from storage
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.NATIVE_SERVER_PORT,
    STORAGE_KEY_SELECTED_SESSION,
  ]);

  const port = normalizePort(stored?.[STORAGE_KEYS.NATIVE_SERVER_PORT]) ?? NATIVE_HOST.DEFAULT_PORT;
  const sessionId = normalizeString(stored?.[STORAGE_KEY_SELECTED_SESSION]).trim();

  if (!sessionId) {
    // No session selected: open sidepanel for user to select/create one
    openAgentChatSidepanel(tabId, windowId).catch(() => {});
    return {
      success: false,
      error:
        'No Agent session selected. Please open AgentChat, select or create a session, then try again.',
    };
  }

  // Create request state
  const requestId = createRequestId();
  const releaseKeepalive = acquireKeepalive(KEEPALIVE_TAG);
  const abortController = new AbortController();

  // Safety timeout to prevent infinite streaming
  const timeoutId = setTimeout(() => {
    const activeRequest = activeRequests.get(requestId);
    if (!activeRequest) return;

    forwardEventToQuickPanel(
      activeRequest,
      createErrorEvent(
        activeRequest.sessionId,
        activeRequest.requestId,
        'Quick Panel stream timed out. Please continue in AgentChat sidepanel.',
      ),
    );
    cleanupRequest(requestId, 'timeout');
  }, REQUEST_TIMEOUT_MS);

  const request: ActiveRequest = {
    requestId,
    sessionId,
    instruction,
    tabId,
    windowId: typeof windowId === 'number' ? windowId : undefined,
    frameId,
    port,
    createdAt: Date.now(),
    abortController,
    releaseKeepalive,
    timeoutId,
  };

  activeRequests.set(requestId, request);

  // Start the request asynchronously (don't await)
  void startRequest(request);

  return { success: true, requestId, sessionId };
}

/**
 * Handle QUICK_PANEL_CANCEL_AI message.
 * Cancels an active request both locally and on the server.
 */
async function handleCancelAI(
  message: QuickPanelCancelAIMessage,
  sender: chrome.runtime.MessageSender,
): Promise<QuickPanelCancelAIResponse> {
  const tabId = sender?.tab?.id;
  const frameId = typeof sender?.frameId === 'number' ? sender.frameId : undefined;

  if (typeof tabId !== 'number') {
    return { success: false, error: 'Cancel request must originate from a tab.' };
  }

  const requestId = normalizeString(message?.payload?.requestId).trim();
  const fallbackSessionId = normalizeString(message?.payload?.sessionId).trim();

  if (!requestId) {
    return { success: false, error: 'requestId is required' };
  }

  const activeRequest = activeRequests.get(requestId);
  const sessionId = activeRequest?.sessionId || fallbackSessionId;

  if (!sessionId) {
    return {
      success: false,
      error: 'Unknown sessionId for this request. Please cancel from AgentChat sidepanel.',
    };
  }

  // Abort SSE immediately for responsive UX
  if (activeRequest) {
    try {
      activeRequest.abortController.abort();
    } catch {
      // Ignore
    }
  }

  // Determine port
  let port = activeRequest?.port;
  if (!port) {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.NATIVE_SERVER_PORT]);
    port = normalizePort(stored?.[STORAGE_KEYS.NATIVE_SERVER_PORT]) ?? NATIVE_HOST.DEFAULT_PORT;
  }

  // Cancel on server (async, don't await)
  void cancelRequestOnServer(port, sessionId, requestId);

  // Send synthetic cancelled status to UI
  const cancelledEvent = createCancelledStatusEvent(sessionId, requestId);
  const eventMessage: QuickPanelAIEventMessage = {
    action: TOOL_MESSAGE_TYPES.QUICK_PANEL_AI_EVENT,
    requestId,
    sessionId,
    event: cancelledEvent,
  };

  const sendOptions = typeof frameId === 'number' ? { frameId } : undefined;
  const sendPromise = sendOptions
    ? chrome.tabs.sendMessage(tabId, eventMessage, sendOptions)
    : chrome.tabs.sendMessage(tabId, eventMessage);

  sendPromise
    .catch(() => {})
    .finally(() => {
      cleanupRequest(requestId, 'cancelled_by_user');
    });

  return { success: true };
}

// ============================================================
// Initialization
// ============================================================

/**
 * Initialize the Quick Panel Agent Handler.
 * Sets up message listeners and tab cleanup handlers.
 */
export function initQuickPanelAgentHandler(): void {
  if (initialized) return;
  initialized = true;

  // Message listener for Quick Panel messages
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Handle QUICK_PANEL_SEND_TO_AI
    if (message?.type === BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_SEND_TO_AI) {
      handleSendToAI(message as QuickPanelSendToAIMessage, sender)
        .then(sendResponse)
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          sendResponse({ success: false, error: msg || 'Unknown error' });
        });
      return true; // Async response
    }

    // Handle QUICK_PANEL_CANCEL_AI
    if (message?.type === BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_CANCEL_AI) {
      handleCancelAI(message as QuickPanelCancelAIMessage, sender)
        .then(sendResponse)
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          sendResponse({ success: false, error: msg || 'Unknown error' });
        });
      return true; // Async response
    }

    return false;
  });

  // Clean up requests when their tab is closed
  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const [requestId, request] of activeRequests) {
      if (request.tabId === tabId) {
        cleanupRequest(requestId, 'tab_removed');
      }
    }
  });

  console.debug(`${LOG_PREFIX} Initialized`);
}
