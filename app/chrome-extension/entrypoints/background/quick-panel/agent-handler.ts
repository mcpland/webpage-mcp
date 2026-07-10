/**
 * Quick Panel Agent Handler
 *
 * Background service that bridges Quick Panel (content script) with the mcp-server Agent.
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

import {
  BACKGROUND_MESSAGE_TYPES,
  PRIVILEGED_UI_ACTIONS,
  TOOL_MESSAGE_TYPES,
  type QuickPanelAIEventMessage,
  type QuickPanelCancelAIMessage,
  type QuickPanelCancelAIResponse,
  type QuickPanelSendToAIMessage,
  type QuickPanelSendToAIResponse,
} from '@/common/message-types';
import { consumePrivilegedUiAuthorization } from '../privileged-ui-authorization';
import { acquireKeepalive } from '../keepalive-manager';
import { openAgentSetupSidepanel } from '../utils/sidepanel';
import { isExtensionRuntimeSender } from '@/common/runtime-sender-auth';
import {
  AGENT_STREAM_LIMITS,
  agentStreamUtf8Bytes,
  sanitizeAgentStreamRelayPayload,
} from '@/common/agent-stream-boundaries';
import {
  requestAgentRpcFetch,
  subscribeAgentStream,
  unsubscribeAgentStream,
} from '../native-host';

// ============================================================
// Constants
// ============================================================

const LOG_PREFIX = '[QuickPanelAgent]';
const KEEPALIVE_TAG = 'quick-panel-ai';

/** Storage key for the session selected in Agent Setup. */
const STORAGE_KEY_SELECTED_SESSION = 'agent-selected-session-id';

/** Timeout for initial SSE connection establishment */
const SSE_CONNECT_TIMEOUT_MS = 3000;

/** Safety timeout for entire request lifecycle (15 minutes) */
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

/** One panel document can own only one long-lived request at a time. */
const MAX_ACTIVE_REQUESTS_PER_DOCUMENT = 1;

/** Global safety bound for MV3 timers, keepalives, listeners, and subscriptions. */
const MAX_ACTIVE_REQUESTS = 32;

export const QUICK_PANEL_AGENT_LIMITS = Object.freeze({
  maxInstructionBytes: 32 * 1_024,
  maxPageUrlBytes: 4 * 1_024,
  maxSelectedTextBytes: 16 * 1_024,
  maxElementInfoBytes: 32 * 1_024,
  maxContextBytes: 64 * 1_024,
  maxContextDepth: 12,
  maxContextValues: 512,
  maxContainerEntries: 128,
  maxContextKeyBytes: 128,
  maxContextStringBytes: 16 * 1_024,
  maxIdentifierBytes: 256,
  maxErrorBytes: 4 * 1_024,
});

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
  readonly context?: AgentActRequest['context'];
  readonly tabId: number;
  readonly windowId?: number;
  readonly frameId: number;
  readonly documentId: string;
  readonly createdAt: number;
  readonly abortController: AbortController;
  readonly releaseKeepalive: () => void;
  readonly timeoutId: ReturnType<typeof setTimeout>;
  streamSubscriptionId?: string;
  streamListener?: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ) => void;
  forwardedEventCount: number;
  forwardedEventBytes: number;
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

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function readBoundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string') return '';
  if (value.length > maxBytes || utf8Length(value) > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  }
  return value.trim();
}

function truncateOutputString(value: unknown, maxBytes: number): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= maxBytes && utf8Length(text) <= maxBytes) return text;
  const encoded = new TextEncoder().encode(text.slice(0, maxBytes));
  return new TextDecoder().decode(encoded.slice(0, maxBytes));
}

interface JsonCloneBudget {
  values: number;
  bytes: number;
  seen: WeakSet<object>;
}

function cloneBoundedContextValue(
  value: unknown,
  label: string,
  budget: JsonCloneBudget,
  depth = 0,
): unknown {
  budget.values += 1;
  if (budget.values > QUICK_PANEL_AGENT_LIMITS.maxContextValues) {
    throw new Error(`${label} contains too many values`);
  }
  if (depth > QUICK_PANEL_AGENT_LIMITS.maxContextDepth) {
    throw new Error(`${label} exceeds the nesting depth limit`);
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value === 'string') {
    if (
      value.length > QUICK_PANEL_AGENT_LIMITS.maxContextStringBytes ||
      utf8Length(value) > QUICK_PANEL_AGENT_LIMITS.maxContextStringBytes
    ) {
      throw new Error(`${label} contains an oversized string`);
    }
    budget.bytes += utf8Length(value);
    if (budget.bytes > QUICK_PANEL_AGENT_LIMITS.maxElementInfoBytes) {
      throw new Error(`${label} exceeds the byte limit`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new Error(`${label} must contain only JSON values`);
  }
  if (budget.seen.has(value)) throw new Error(`${label} must not contain cycles`);
  budget.seen.add(value);

  if (Array.isArray(value)) {
    if (value.length > QUICK_PANEL_AGENT_LIMITS.maxContainerEntries) {
      throw new Error(`${label} array exceeds the entry limit`);
    }
    const result = value.map((item) => cloneBoundedContextValue(item, label, budget, depth + 1));
    budget.seen.delete(value);
    return result;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must contain only plain objects`);
  }
  const entries = Object.entries(value);
  if (entries.length > QUICK_PANEL_AGENT_LIMITS.maxContainerEntries) {
    throw new Error(`${label} object exceeds the property limit`);
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new Error(`${label} contains a forbidden property`);
    }
    if (
      key.length > QUICK_PANEL_AGENT_LIMITS.maxContextKeyBytes ||
      utf8Length(key) > QUICK_PANEL_AGENT_LIMITS.maxContextKeyBytes
    ) {
      throw new Error(`${label} contains an oversized property name`);
    }
    budget.bytes += utf8Length(key);
    if (budget.bytes > QUICK_PANEL_AGENT_LIMITS.maxElementInfoBytes) {
      throw new Error(`${label} exceeds the byte limit`);
    }
    result[key] = cloneBoundedContextValue(item, label, budget, depth + 1);
  }
  budget.seen.delete(value);
  return result;
}

function normalizeQuickPanelContext(value: unknown): AgentActRequest['context'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const pageUrl = readBoundedString(
    raw.pageUrl,
    'Quick Panel pageUrl',
    QUICK_PANEL_AGENT_LIMITS.maxPageUrlBytes,
  );
  const selectedText = readBoundedString(
    raw.selectedText,
    'Quick Panel selectedText',
    QUICK_PANEL_AGENT_LIMITS.maxSelectedTextBytes,
  );
  const elementInfo =
    raw.elementInfo === undefined
      ? undefined
      : cloneBoundedContextValue(
          raw.elementInfo,
          'Quick Panel elementInfo',
          { values: 0, bytes: 0, seen: new WeakSet() },
        );

  if (!pageUrl && !selectedText && elementInfo === undefined) {
    return undefined;
  }

  const context = {
    ...(pageUrl ? { pageUrl } : {}),
    ...(selectedText ? { selectedText } : {}),
    ...(elementInfo !== undefined ? { elementInfo } : {}),
  } as AgentActRequest['context'];
  const encoded = JSON.stringify(context);
  if (
    encoded.length > QUICK_PANEL_AGENT_LIMITS.maxContextBytes ||
    utf8Length(encoded) > QUICK_PANEL_AGENT_LIMITS.maxContextBytes
  ) {
    throw new Error('Quick Panel context exceeds the byte limit');
  }
  return context;
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

function toPromise<T>(value: Promise<T> | T): Promise<T> {
  return Promise.resolve(value);
}

// ============================================================
// Event Factories
// ============================================================

function createErrorEvent(sessionId: string, requestId: string, error: string): RealtimeEvent {
  return {
    type: 'error',
    error: truncateOutputString(error || 'Unknown error', QUICK_PANEL_AGENT_LIMITS.maxErrorBytes),
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

  if (request.streamListener) {
    try {
      chrome.runtime.onMessage.removeListener(request.streamListener);
    } catch {
      // Ignore
    }
  }

  if (request.streamSubscriptionId) {
    void unsubscribeAgentStream(request.streamSubscriptionId).catch(() => {
      // Ignore
    });
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
 * Validate that the selected session exists on the MCP server.
 * Returns false if the session is invalid or server is unreachable.
 */
async function validateSession(sessionId: string): Promise<boolean> {
  try {
    const response = await requestAgentRpcFetch({
      operation: 'agent.sessions.get',
      params: { sessionId },
    });
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
  let readySettled = false;
  let readyResolve: (connected: boolean) => void;
  let doneResolve: () => void;

  const ready = new Promise<boolean>((resolve) => {
    readyResolve = resolve;
  });
  const done = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });

  const settleReady = (connected: boolean): void => {
    if (readySettled) return;
    readySettled = true;
    readyResolve(connected);
  };

  const subscriptionId = `quick-panel-${request.requestId}`;

  void subscribeAgentStream(request.sessionId, { subscriptionId })
    .then(({ subscriptionId: actualSubscriptionId }) => {
      if (
        activeRequests.get(request.requestId) !== request ||
        request.abortController.signal.aborted
      ) {
        void unsubscribeAgentStream(actualSubscriptionId).catch(() => {
          // Best-effort cleanup for a subscription that completed after cancellation.
        });
        settleReady(false);
        doneResolve();
        return;
      }

      request.streamSubscriptionId = actualSubscriptionId;

      const onMessage = (
        message: unknown,
        sender: chrome.runtime.MessageSender,
      ): void => {
        if (!isExtensionRuntimeSender(sender)) return;
        const msg = message as {
          type?: string;
          payload?: {
            subscriptionId?: string;
            event?: RealtimeEvent;
          };
        };
        if (msg?.type !== BACKGROUND_MESSAGE_TYPES.AGENT_STREAM_EVENT) {
          return;
        }
        const relay = sanitizeAgentStreamRelayPayload(msg.payload);
        if (relay?.subscriptionId !== actualSubscriptionId) {
          return;
        }

        const event = relay.event;
        if (!shouldForwardEvent(event, request.requestId)) {
          return;
        }

        const eventBytes = agentStreamUtf8Bytes(JSON.stringify(event));
        if (
          request.forwardedEventCount >= AGENT_STREAM_LIMITS.maxEventsPerRequest ||
          request.forwardedEventBytes + eventBytes > AGENT_STREAM_LIMITS.maxBytesPerRequest
        ) {
          forwardEventToQuickPanel(
            request,
            createErrorEvent(
              request.sessionId,
              request.requestId,
              'Quick Panel stream exceeded its resource budget.',
            ),
          );
          cleanupRequest(request.requestId, 'stream_resource_limit');
          return;
        }
        request.forwardedEventCount += 1;
        request.forwardedEventBytes += eventBytes;

        forwardEventToQuickPanel(request, event);
        if (event.type === 'status' && event.data?.requestId === request.requestId) {
          if (isTerminalStatus(event.data.status)) {
            cleanupRequest(request.requestId, `terminal_status:${event.data.status}`);
          }
        }
      };

      request.streamListener = onMessage;
      chrome.runtime.onMessage.addListener(request.streamListener);

      request.abortController.signal.addEventListener(
        'abort',
        () => {
          doneResolve();
        },
        { once: true },
      );

      settleReady(true);
    })
    .catch((error) => {
      settleReady(false);
      const message = error instanceof Error ? error.message : String(error);
      if (activeRequests.has(request.requestId)) {
        forwardEventToQuickPanel(
          request,
          createErrorEvent(request.sessionId, request.requestId, message),
        );
        cleanupRequest(request.requestId, 'stream_subscribe_failed');
      }
      doneResolve();
    });

  return { ready, done };
}

// ============================================================
// Agent API
// ============================================================

/**
 * Send the act request to mcp-server.
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

  const payload: AgentActRequest = {
    instruction: request.instruction,
    // Ensures session-level config is loaded (engine, model, options, project binding)
    dbSessionId: request.sessionId,
    // Enables SSE-first flow and requestId filtering on session-scoped streams
    requestId: request.requestId,
    ...(request.context ? { context: request.context } : {}),
  };

  const response = await requestAgentRpcFetch({
    operation: 'agent.chat.act',
    params: { sessionId: request.sessionId },
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = response.body || '';
    throw new Error(text || `HTTP ${response.statusCode}`);
  }
}

/**
 * Cancel an active request on the mcp-server.
 */
async function cancelRequestOnServer(
  sessionId: string,
  requestId: string,
): Promise<void> {
  try {
    await requestAgentRpcFetch({
      operation: 'agent.chat.cancelRequest',
      params: {
        sessionId,
        requestId,
      },
    });
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

function hasDocumentRequest(tabId: number, frameId: number, documentId: string): boolean {
  let count = 0;
  for (const request of activeRequests.values()) {
    if (
      request.tabId === tabId &&
      request.frameId === frameId &&
      request.documentId === documentId
    ) {
      count += 1;
      if (count >= MAX_ACTIVE_REQUESTS_PER_DOCUMENT) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Main orchestration function for starting a Quick Panel AI request.
 *
 * Flow:
 * 1. Ensure MCP server is running
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
    // Best-effort: ensure MCP server is running
    await toPromise(chrome.runtime.sendMessage({ type: NativeMessageType.ENSURE_NATIVE })).catch(
      () => null,
    );

    // Guard: check if cancelled during ENSURE_NATIVE
    if (!isRequestStillActive(request)) return;

    // Validate session still exists
    const sessionValid = await validateSession(request.sessionId);

    // Guard: check if cancelled during validation
    if (!isRequestStillActive(request)) return;

    if (!sessionValid) {
      forwardEventToQuickPanel(
        request,
        createErrorEvent(
          request.sessionId,
          request.requestId,
          'Selected Agent session is not available. Open Agent Setup and select a valid session.',
        ),
      );
      // Open sidepanel without deep-linking to invalid session
      void toPromise(openAgentSetupSidepanel(request.tabId, request.windowId)).catch(() => {});
      cleanupRequest(request.requestId, 'session_invalid');
      return;
    }

    // Best-effort: open sidepanel deep-linked to current session
    void toPromise(
      openAgentSetupSidepanel(request.tabId, request.windowId, request.sessionId),
    ).catch(() => {});

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
  const frameId = typeof sender?.frameId === 'number' ? sender.frameId : 0;
  const documentId = typeof sender?.documentId === 'string' ? sender.documentId : '';

  if (typeof tabId !== 'number') {
    return { success: false, error: 'Quick Panel request must originate from a tab.' };
  }

  if (
    !consumePrivilegedUiAuthorization(
      message?.authorizationToken,
      PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND,
      sender,
    )
  ) {
    return { success: false, error: 'Quick Panel authorization is missing or expired.' };
  }

  const instruction = readBoundedString(
    message?.payload?.instruction,
    'Quick Panel instruction',
    QUICK_PANEL_AGENT_LIMITS.maxInstructionBytes,
  );
  if (!instruction) {
    return { success: false, error: 'instruction is required' };
  }
  const context = normalizeQuickPanelContext(message?.payload?.context);

  const stored = await chrome.storage.local.get([STORAGE_KEY_SELECTED_SESSION]);
  const sessionId = readBoundedString(
    stored?.[STORAGE_KEY_SELECTED_SESSION],
    'Quick Panel sessionId',
    QUICK_PANEL_AGENT_LIMITS.maxIdentifierBytes,
  );

  if (!sessionId) {
    // No session selected: open sidepanel for user to select/create one
    void toPromise(openAgentSetupSidepanel(tabId, windowId)).catch(() => {});
    return {
      success: false,
      error:
        'No Agent session selected. Open Agent Setup, select or create a session, then try again.',
    };
  }

  // Check immediately before allocating a timer, keepalive, and native
  // subscription. The UI is single-flight by design; duplicate sends from the
  // same document are rejected instead of accumulating 15-minute resources.
  if (hasDocumentRequest(tabId, frameId, documentId)) {
    return {
      success: false,
      error: 'Quick Panel already has an active request for this document.',
    };
  }
  if (activeRequests.size >= MAX_ACTIVE_REQUESTS) {
    return {
      success: false,
      error: 'Quick Panel has reached the active request limit. Cancel a request and try again.',
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
        'Quick Panel stream timed out. Review Agent Setup and try again.',
      ),
    );
    cleanupRequest(requestId, 'timeout');
  }, REQUEST_TIMEOUT_MS);

  const request: ActiveRequest = {
    requestId,
    sessionId,
    instruction,
    context,
    tabId,
    windowId: typeof windowId === 'number' ? windowId : undefined,
    frameId,
    documentId,
    createdAt: Date.now(),
    abortController,
    releaseKeepalive,
    timeoutId,
    forwardedEventCount: 0,
    forwardedEventBytes: 0,
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
  const frameId = typeof sender?.frameId === 'number' ? sender.frameId : 0;
  const documentId = typeof sender?.documentId === 'string' ? sender.documentId : '';

  if (typeof tabId !== 'number') {
    return { success: false, error: 'Cancel request must originate from a tab.' };
  }

  if (
    !consumePrivilegedUiAuthorization(
      message?.authorizationToken,
      PRIVILEGED_UI_ACTIONS.QUICK_PANEL_CANCEL,
      sender,
    )
  ) {
    return {
      success: false,
      error: 'Quick Panel cancellation authorization is missing or expired.',
    };
  }

  const requestId = readBoundedString(
    message?.payload?.requestId,
    'Quick Panel requestId',
    QUICK_PANEL_AGENT_LIMITS.maxIdentifierBytes,
  );
  const fallbackSessionId = readBoundedString(
    message?.payload?.sessionId,
    'Quick Panel sessionId',
    QUICK_PANEL_AGENT_LIMITS.maxIdentifierBytes,
  );

  if (!requestId) {
    return { success: false, error: 'requestId is required' };
  }

  const activeRequest = activeRequests.get(requestId);
  if (
    activeRequest &&
    (activeRequest.tabId !== tabId ||
      activeRequest.frameId !== frameId ||
      activeRequest.documentId !== documentId)
  ) {
    return { success: false, error: 'Quick Panel request belongs to a different document.' };
  }
  const sessionId = activeRequest?.sessionId || fallbackSessionId;

  if (!sessionId) {
    return {
      success: false,
      error: 'Unknown sessionId for this request.',
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

  // Cancel on server (async, don't await)
  void cancelRequestOnServer(sessionId, requestId);

  // Send synthetic cancelled status to UI
  const cancelledEvent = createCancelledStatusEvent(sessionId, requestId);
  const eventMessage: QuickPanelAIEventMessage = {
    action: TOOL_MESSAGE_TYPES.QUICK_PANEL_AI_EVENT,
    requestId,
    sessionId,
    event: cancelledEvent,
  };

  const sendPromise = chrome.tabs.sendMessage(tabId, eventMessage, { frameId });

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
          const msg = truncateOutputString(
            err instanceof Error ? err.message : err,
            QUICK_PANEL_AGENT_LIMITS.maxErrorBytes,
          );
          sendResponse({ success: false, error: msg || 'Unknown error' });
        });
      return true; // Async response
    }

    // Handle QUICK_PANEL_CANCEL_AI
    if (message?.type === BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_CANCEL_AI) {
      handleCancelAI(message as QuickPanelCancelAIMessage, sender)
        .then(sendResponse)
        .catch((err) => {
          const msg = truncateOutputString(
            err instanceof Error ? err.message : err,
            QUICK_PANEL_AGENT_LIMITS.maxErrorBytes,
          );
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
