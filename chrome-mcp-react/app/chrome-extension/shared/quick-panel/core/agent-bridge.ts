/**
 * Quick Panel Agent Bridge
 *
 * Client-side bridge for Quick Panel (content script) to communicate with
 * the background agent handler. Provides a clean API for sending messages
 * to AI and receiving streaming responses.
 *
 * Features:
 * - Event buffering for handling race conditions
 * - Request lifecycle management
 * - Memory-bounded event storage
 * - Automatic cleanup on terminal events
 *
 * @example
 * ```typescript
 * const bridge = new QuickPanelAgentBridge();
 *
 * // Send a message and subscribe to events
 * const result = await bridge.sendToAI({ instruction: 'Hello' });
 * if (result.success) {
 *   const unsubscribe = bridge.onRequestEvent(result.requestId, (event) => {
 *     console.log('Received event:', event);
 *   });
 * }
 *
 * // Cleanup when done
 * bridge.dispose();
 * ```
 */

import type { RealtimeEvent } from 'webpage-mcp-shared';

import {
  BACKGROUND_MESSAGE_TYPES,
  TOOL_MESSAGE_TYPES,
  type QuickPanelAIEventMessage,
  type QuickPanelCancelAIResponse,
  type QuickPanelSendToAIPayload,
  type QuickPanelSendToAIResponse,
} from '@/common/message-types';

// ============================================================
// Types
// ============================================================

/**
 * Callback function for receiving RealtimeEvents.
 */
export type RequestEventListener = (event: RealtimeEvent) => void;

/**
 * Configuration options for the agent bridge.
 */
export interface AgentBridgeOptions {
  /** Maximum number of events to buffer per request (default: 200) */
  maxBufferedEvents?: number;
}

// ============================================================
// Constants
// ============================================================

const LOG_PREFIX = '[QuickPanelAgentBridge]';
const DEFAULT_MAX_BUFFERED_EVENTS = 200;

/** Delay before cleaning up request state after terminal event (allows late subscribers) */
const TERMINAL_CLEANUP_DELAY_MS = 30000;

// ============================================================
// Implementation
// ============================================================

/**
 * Bridge for Quick Panel to communicate with the background agent handler.
 *
 * Responsibilities:
 * 1. Send instructions to AI via background
 * 2. Receive and dispatch streaming events
 * 3. Buffer events for late-subscribing listeners
 * 4. Manage request lifecycle and cleanup
 */
export class QuickPanelAgentBridge {
  /** Listeners organized by requestId */
  private readonly listenersByRequestId = new Map<string, Set<RequestEventListener>>();

  /** Event buffer for handling race conditions where events arrive before listeners */
  private readonly bufferByRequestId = new Map<string, RealtimeEvent[]>();

  /** Pending cleanup timers for delayed terminal cleanup */
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Maximum events to buffer per request */
  private readonly maxBufferedEvents: number;

  /** Message handler bound to this instance */
  private readonly boundMessageHandler: (message: unknown) => void;

  /** Disposed state flag */
  private disposed = false;

  constructor(options?: AgentBridgeOptions) {
    this.maxBufferedEvents = options?.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS;
    this.boundMessageHandler = this.handleMessage.bind(this);

    // Register message listener
    chrome.runtime.onMessage.addListener(this.boundMessageHandler);
  }

  /**
   * Clean up all resources and unregister listeners.
   * Should be called when Quick Panel is closing.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    chrome.runtime.onMessage.removeListener(this.boundMessageHandler);
    this.listenersByRequestId.clear();
    this.bufferByRequestId.clear();

    // Clear all pending cleanup timers
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
  }

  /**
   * Check if the bridge has been disposed.
   */
  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Subscribe to RealtimeEvents for a specific requestId.
   *
   * @param requestId - The request ID to subscribe to
   * @param listener - Callback function for events
   * @returns Unsubscribe function
   *
   * @remarks
   * Events that arrived before subscription are flushed immediately.
   * This handles the race condition where background sends events
   * before the UI has finished setting up listeners.
   */
  onRequestEvent(requestId: string, listener: RequestEventListener): () => void {
    if (this.disposed) {
      console.warn(`${LOG_PREFIX} Cannot subscribe - bridge is disposed`);
      return () => {};
    }

    const id = requestId.trim();
    if (!id) {
      console.warn(`${LOG_PREFIX} Invalid requestId`);
      return () => {};
    }

    // Add listener to set
    let listeners = this.listenersByRequestId.get(id);
    if (!listeners) {
      listeners = new Set<RequestEventListener>();
      this.listenersByRequestId.set(id, listeners);
    }
    listeners.add(listener);

    // Flush any buffered events to this listener
    const buffer = this.bufferByRequestId.get(id);
    if (buffer && buffer.length > 0) {
      for (const event of buffer) {
        this.safeInvokeListener(listener, event);
      }
      // Clear buffer after flushing
      this.bufferByRequestId.delete(id);
    }

    // Return unsubscribe function
    return () => {
      const set = this.listenersByRequestId.get(id);
      if (!set) return;

      set.delete(listener);
      if (set.size === 0) {
        this.listenersByRequestId.delete(id);
      }
    };
  }

  /**
   * Send a new instruction to the selected AgentChat session.
   *
   * The background layer will:
   * 1. Read the selected session ID
   * 2. Open SSE subscription
   * 3. POST /act to start the request
   * 4. Stream events back via QUICK_PANEL_AI_EVENT
   *
   * @param payload - The instruction and optional context
   * @returns Promise resolving to success with requestId/sessionId, or failure with error
   */
  async sendToAI(payload: QuickPanelSendToAIPayload): Promise<QuickPanelSendToAIResponse> {
    if (this.disposed) {
      return { success: false, error: 'Bridge is disposed' };
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_SEND_TO_AI,
        payload,
      });

      return response as QuickPanelSendToAIResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg || 'Failed to send message' };
    }
  }

  /**
   * Cancel an active AI request.
   *
   * @param requestId - The request ID to cancel
   * @param sessionId - Optional session ID for fallback (useful if background state was lost)
   * @returns Promise resolving to success or failure
   *
   * @remarks
   * Prefer passing sessionId when available for resilience against
   * MV3 Service Worker restarts that may clear background state.
   */
  async cancelRequest(requestId: string, sessionId?: string): Promise<QuickPanelCancelAIResponse> {
    if (this.disposed) {
      return { success: false, error: 'Bridge is disposed' };
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_CANCEL_AI,
        payload: { requestId, sessionId },
      });

      return response as QuickPanelCancelAIResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg || 'Failed to cancel request' };
    }
  }

  /**
   * Check if there are active listeners for a request.
   * Useful for determining if UI is still interested in events.
   */
  hasListeners(requestId: string): boolean {
    const listeners = this.listenersByRequestId.get(requestId);
    return listeners !== undefined && listeners.size > 0;
  }

  /**
   * Get the number of active requests being tracked.
   * Useful for debugging and monitoring.
   */
  getActiveRequestCount(): number {
    return this.listenersByRequestId.size + this.bufferByRequestId.size;
  }

  // ============================================================
  // Private Methods
  // ============================================================

  /**
   * Handle incoming messages from background.
   */
  private handleMessage(message: unknown): void {
    if (this.disposed) return;

    const msg = message as Partial<QuickPanelAIEventMessage> | undefined;
    if (!msg || msg.action !== TOOL_MESSAGE_TYPES.QUICK_PANEL_AI_EVENT) {
      return;
    }

    const requestId = typeof msg.requestId === 'string' ? msg.requestId : '';
    const event = msg.event as RealtimeEvent | undefined;

    if (!requestId || !event) return;

    // Dispatch to listeners or buffer
    const listeners = this.listenersByRequestId.get(requestId);
    if (listeners && listeners.size > 0) {
      for (const listener of listeners) {
        this.safeInvokeListener(listener, event);
      }
    } else {
      // No listeners yet - buffer the event
      this.bufferEvent(requestId, event);
    }

    // Schedule delayed cleanup on terminal status
    // This allows late subscribers to still receive the final state
    if (this.isTerminalEvent(event, requestId)) {
      this.scheduleDelayedCleanup(requestId);
    }
  }

  /**
   * Safely invoke a listener, catching and logging any errors.
   */
  private safeInvokeListener(listener: RequestEventListener, event: RealtimeEvent): void {
    try {
      listener(event);
    } catch (err) {
      console.warn(`${LOG_PREFIX} Listener error:`, err);
    }
  }

  /**
   * Buffer an event for a request that doesn't have listeners yet.
   */
  private bufferEvent(requestId: string, event: RealtimeEvent): void {
    let buffer = this.bufferByRequestId.get(requestId);
    if (!buffer) {
      buffer = [];
      this.bufferByRequestId.set(requestId, buffer);
    }

    buffer.push(event);

    // Bound memory by removing oldest events
    if (buffer.length > this.maxBufferedEvents) {
      buffer.splice(0, buffer.length - this.maxBufferedEvents);
    }
  }

  /**
   * Check if an event represents a terminal state for the request.
   *
   * Terminal events include:
   * - status events with terminal status (completed, error, cancelled)
   * - error events (type: 'error')
   */
  private isTerminalEvent(event: RealtimeEvent, requestId: string): boolean {
    // Error events are always terminal
    if (event.type === 'error') {
      return true;
    }

    // Status events with terminal status
    if (event.type === 'status') {
      const data = event.data;
      if (data?.requestId !== requestId) return false;

      const status = data.status;
      return status === 'completed' || status === 'error' || status === 'cancelled';
    }

    return false;
  }

  /**
   * Clean up all state associated with a request.
   * Called after delay to allow late subscribers to receive terminal events.
   */
  private cleanupRequest(requestId: string): void {
    // Clear any pending timer first
    const existingTimer = this.cleanupTimers.get(requestId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.cleanupTimers.delete(requestId);
    }

    this.bufferByRequestId.delete(requestId);
    this.listenersByRequestId.delete(requestId);
  }

  /**
   * Schedule delayed cleanup for a request after terminal event.
   * This allows late subscribers to still receive the terminal event.
   */
  private scheduleDelayedCleanup(requestId: string): void {
    // Don't schedule if already scheduled
    if (this.cleanupTimers.has(requestId)) return;

    const timer = setTimeout(() => {
      this.cleanupTimers.delete(requestId);
      this.cleanupRequest(requestId);
    }, TERMINAL_CLEANUP_DELAY_MS);

    this.cleanupTimers.set(requestId, timer);
  }
}

// ============================================================
// Singleton Export (Optional)
// ============================================================

/**
 * Create a new agent bridge instance.
 * Prefer creating a single instance per Quick Panel lifecycle.
 */
export function createAgentBridge(options?: AgentBridgeOptions): QuickPanelAgentBridge {
  return new QuickPanelAgentBridge(options);
}
