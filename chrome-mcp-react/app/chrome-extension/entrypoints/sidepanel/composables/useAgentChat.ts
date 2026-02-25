/**
 * Composable for managing Agent Chat state and messages.
 * Handles message sending, receiving, and cancellation.
 */
import { ref, computed } from 'vue';
import type {
  AgentMessage,
  AgentActRequest,
  AgentActRequestClientMeta,
  AgentAttachment,
  RealtimeEvent,
  AgentStatusEvent,
  AgentCliPreference,
  AgentUsageStats,
} from 'webpage-mcp-shared';

/**
 * Request lifecycle state.
 * - 'idle': No active request
 * - 'starting': Request accepted, waiting for engine initialization
 * - 'ready': Engine initialized, preparing to run
 * - 'running': Engine actively processing (may emit tool_use/tool_result)
 * - 'completed': Request finished successfully
 * - 'cancelled': Request was cancelled by user
 * - 'error': Request failed with error
 */
export type RequestState = 'idle' | AgentStatusEvent['status'];

export interface UseAgentChatOptions {
  getServerPort: () => number | null;
  getSessionId: () => string;
  ensureServer: () => Promise<boolean>;
  openEventSource: () => void;
}

export function useAgentChat(options: UseAgentChatOptions) {
  // State
  const messages = ref<AgentMessage[]>([]);
  const input = ref('');
  const sending = ref(false);
  /**
   * Message-level streaming state.
   * True when receiving delta updates for assistant/tool messages.
   * Note: This is separate from requestState - a request can be 'running'
   * even when isStreaming is false (e.g., during tool execution).
   */
  const isStreaming = ref(false);
  /**
   * Request lifecycle state driven by status events.
   * Use this (via isRequestActive) for UI elements like stop button,
   * loading indicators, and running badges.
   */
  const requestState = ref<RequestState>('idle');
  const errorMessage = ref<string | null>(null);
  const currentRequestId = ref<string | null>(null);
  const cancelling = ref(false);
  const attachments = ref<AgentAttachment[]>([]);
  const lastUsage = ref<AgentUsageStats | null>(null);

  // Computed
  const canSend = computed(() => {
    return input.value.trim().length > 0 && !sending.value;
  });

  /**
   * Whether there is an active request in progress.
   * Use this for UI elements like stop button, loading indicators, and running badges.
   */
  const isRequestActive = computed(() => {
    return (
      requestState.value === 'starting' ||
      requestState.value === 'ready' ||
      requestState.value === 'running'
    );
  });

  /**
   * Check if an incoming event belongs to a different active request.
   * Used to filter out stale events from previous requests.
   */
  function isDifferentActiveRequest(incomingRequestId?: string): boolean {
    const incoming = incomingRequestId?.trim();
    const current = currentRequestId.value?.trim();
    // No incoming ID or no current ID means we can't determine - don't filter
    if (!incoming || !current) return false;
    // Same request ID - don't filter
    if (incoming === current) return false;
    // Different request ID while we have an active request - filter it out
    return isRequestActive.value;
  }

  /**
   * Handle incoming realtime events.
   * Events are filtered by sessionId to prevent cross-session state pollution
   * when user switches sessions while SSE connection is still active.
   */
  function handleRealtimeEvent(event: RealtimeEvent): void {
    const currentSessionId = options.getSessionId();

    switch (event.type) {
      case 'message':
        // Guard: only handle messages for the current session
        if (event.data.sessionId !== currentSessionId) {
          return;
        }
        handleMessageEvent(event.data);
        break;
      case 'status':
        // Guard: only handle status for the current session
        if (event.data.sessionId !== currentSessionId) {
          return;
        }
        handleStatusEvent(event.data);
        break;
      case 'error':
        // Error events may not have sessionId, but if they do, filter
        if (event.data?.sessionId && event.data.sessionId !== currentSessionId) {
          return;
        }
        // Filter out errors from different active requests
        if (isDifferentActiveRequest(event.data?.requestId)) {
          return;
        }
        errorMessage.value = event.error;
        isStreaming.value = false;
        requestState.value = 'error';
        // Clear requestId if it matches the error event's requestId (or unconditionally if no requestId in error)
        if (!event.data?.requestId || event.data.requestId === currentRequestId.value) {
          currentRequestId.value = null;
        }
        break;
      case 'connected':
        console.log('[AgentChat] Connected to session:', event.data.sessionId);
        break;
      case 'heartbeat':
        // Heartbeat received, connection is alive
        break;
      case 'usage':
        // Guard: only accept usage for the current session
        if (event.data?.sessionId && event.data.sessionId !== currentSessionId) {
          return;
        }
        lastUsage.value = event.data;
        break;
    }
  }

  // Handle message events
  function handleMessageEvent(msg: AgentMessage): void {
    // For user messages from server, replace local optimistic message
    // Server echoes user message with real id/metadata, but we want to keep our display text
    // (which doesn't include injected context like web editor selection)
    if (msg.role === 'user' && msg.requestId) {
      const optimisticIndex = messages.value.findIndex(
        (m) => m.role === 'user' && m.requestId === msg.requestId && m.id.startsWith('temp-'),
      );
      if (optimisticIndex >= 0) {
        // Replace optimistic message: keep display content, update id and metadata
        const optimistic = messages.value[optimisticIndex];
        messages.value[optimisticIndex] = {
          ...msg,
          // Preserve the display content (user's raw input without injected context)
          content: optimistic.content,
          // Prefer server metadata, fallback to optimistic metadata (for chip rendering)
          metadata: msg.metadata ?? optimistic.metadata,
        };
        return;
      }
    }

    // Check if this message belongs to a different active request
    // Note: We still save the message to messages array (for auditing/replay),
    // but skip state updates if it's from a stale request
    const msgRequestId = msg.requestId?.trim() || undefined;
    const isStaleForState = isDifferentActiveRequest(msgRequestId);

    const existingIndex = messages.value.findIndex((m) => m.id === msg.id);

    if (existingIndex >= 0) {
      // Update existing message (streaming update)
      messages.value[existingIndex] = msg;
    } else {
      // Add new message - always save, even if stale for state
      messages.value.push(msg);
    }

    // Skip state updates for messages from different active requests
    if (isStaleForState) {
      return;
    }

    // Track requestId from messages (handles cases where status events were missed)
    if (msgRequestId && msgRequestId !== currentRequestId.value) {
      currentRequestId.value = msgRequestId;
    }

    // Update message-level streaming state (delta updates)
    // Note: This does NOT affect requestState - tool_use with isStreaming=false
    // should not stop the overall request, only indicate this message is complete
    if (msg.role === 'assistant' || msg.role === 'tool') {
      isStreaming.value = msg.isStreaming === true && !msg.isFinal;

      // If we're receiving model/tool output but requestState hasn't progressed to 'running',
      // update it. This handles:
      // 1. Edge case where status events were missed due to SSE timing
      // 2. User enters AgentChat mid-request (e.g., from Quick Panel/toolbar trigger)
      // 3. SSE reconnection after temporary disconnect
      if (
        requestState.value === 'idle' ||
        requestState.value === 'starting' ||
        requestState.value === 'ready'
      ) {
        requestState.value = 'running';
      }
    }
  }

  // Handle status events
  function handleStatusEvent(status: AgentStatusEvent): void {
    const statusRequestId = status.requestId?.trim() || undefined;

    // Filter out status events from different active requests
    if (isDifferentActiveRequest(statusRequestId)) {
      return;
    }

    // Track requestId from status events
    if (statusRequestId && statusRequestId !== currentRequestId.value) {
      currentRequestId.value = statusRequestId;
    }

    // Update request lifecycle state (driven by status events only)
    requestState.value = status.status;

    switch (status.status) {
      case 'starting':
      case 'ready':
      case 'running':
        // Request is active - no additional state changes needed
        break;
      case 'completed':
      case 'error':
      case 'cancelled':
        // Request finished - clear message streaming and requestId
        isStreaming.value = false;
        // Reset cancelling state (in case we were waiting for SSE confirmation)
        cancelling.value = false;
        if (!statusRequestId || statusRequestId === currentRequestId.value) {
          currentRequestId.value = null;
        }
        break;
    }
  }

  // Send message
  async function send(
    chatOptions: {
      cliPreference?: string;
      model?: string;
      projectId?: string;
      projectRoot?: string;
      dbSessionId?: string;
      /**
       * Optional instruction to send instead of input.value.
       * When provided, this is used as the actual instruction sent to the server,
       * while input.value is still used for UI display in the optimistic message.
       * This is useful for injecting context (e.g., web editor selection) into the prompt
       * without showing it in the chat UI.
       */
      instruction?: string;
      /**
       * Optional compact display text stored in the user message metadata.
       * When provided, the UI can render a special header (e.g., a chip) instead
       * of the raw prompt content.
       */
      displayText?: string;
      /**
       * Optional client metadata to persist with the user message.
       * Used for special UI rendering (e.g., web editor apply/selection chips).
       */
      clientMeta?: AgentActRequestClientMeta;
    } = {},
  ): Promise<void> {
    // User-visible content is always the user's raw input
    const userText = input.value.trim();
    // Actual instruction sent to server can be overridden (e.g., with context prepended)
    const instructionText = chatOptions.instruction?.trim() || userText;

    if (!userText) return;

    const ready = await options.ensureServer();
    const serverPort = options.getServerPort();
    const sessionId = options.getSessionId();

    if (!ready || !serverPort) {
      errorMessage.value = 'Agent server is not available.';
      return;
    }

    // Ensure SSE is connected before sending
    options.openEventSource();

    // Generate requestId on client side for optimistic message matching
    // Server will use this requestId when echoing user message via SSE
    const requestId = crypto.randomUUID();

    // Create optimistic user message for immediate feedback
    // Note: Use userText for UI, not instructionText (which may contain injected context)
    const tempMessageId = `temp-${Date.now()}`;
    const optimisticMessage: AgentMessage = {
      id: tempMessageId,
      sessionId: sessionId,
      role: 'user',
      content: userText,
      messageType: 'chat',
      requestId, // Include requestId so we can match with server-echoed message
      createdAt: new Date().toISOString(),
      // Include metadata for immediate chip rendering (before server echo)
      metadata:
        chatOptions.displayText || chatOptions.clientMeta
          ? {
              displayText: chatOptions.displayText?.trim(),
              clientMeta: chatOptions.clientMeta,
            }
          : undefined,
    };

    // Add user message immediately
    messages.value.push(optimisticMessage);

    const payload: AgentActRequest = {
      // Use instructionText which may include injected context (e.g., web editor selection)
      instruction: instructionText,
      requestId, // Send requestId to server so it can be used in SSE events
      // Optional metadata for special UI rendering (stored with the user message)
      displayText: chatOptions.displayText?.trim() || undefined,
      clientMeta: chatOptions.clientMeta,
      cliPreference: chatOptions.cliPreference
        ? (chatOptions.cliPreference as AgentCliPreference)
        : undefined,
      model: chatOptions.model?.trim() || undefined,
      projectId: chatOptions.projectId || undefined,
      projectRoot: chatOptions.projectRoot?.trim() || undefined,
      dbSessionId: chatOptions.dbSessionId || undefined,
      attachments: attachments.value.length > 0 ? attachments.value : undefined,
    };

    sending.value = true;
    // Initialize request lifecycle state - request begins once we dispatch /act
    requestState.value = 'starting';
    currentRequestId.value = requestId;
    // Reset message-level streaming; it will be driven by message.isStreaming deltas
    isStreaming.value = false;
    errorMessage.value = null;

    // Clear input immediately for better UX
    const savedInput = input.value;
    input.value = '';
    const savedAttachments = [...attachments.value];
    attachments.value = [];

    try {
      const url = `http://127.0.0.1:${serverPort}/agent/chat/${encodeURIComponent(sessionId)}/act`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `HTTP ${response.status}`);
      }

      const result = await response.json().catch(() => ({}));

      // Guard: only update state if we're still on the same session
      // This prevents cross-session state pollution when user switches during request
      const currentSessionId = options.getSessionId();
      if (currentSessionId !== sessionId) {
        // Session changed during request - discard result silently
        // The optimistic message will be cleared when messages are reloaded
        isStreaming.value = false;
        requestState.value = 'idle';
        currentRequestId.value = null;
        return;
      }

      // Update currentRequestId from response (should match our client-generated one)
      // This is used for cancel functionality
      if (result.requestId) {
        currentRequestId.value = result.requestId;
      } else {
        // Fallback: use our client-generated requestId
        currentRequestId.value = requestId;
      }
    } catch (error: unknown) {
      // Guard: only handle error if still on same session
      const currentSessionId = options.getSessionId();
      if (currentSessionId !== sessionId) {
        isStreaming.value = false;
        requestState.value = 'idle';
        currentRequestId.value = null;
        return;
      }

      console.error('Failed to send agent act request:', error);
      errorMessage.value =
        error instanceof Error ? error.message : 'Failed to send request to agent server.';
      // Restore input on error
      input.value = savedInput;
      attachments.value = savedAttachments;
      // Remove optimistic message on error
      const msgIndex = messages.value.findIndex((m) => m.id === tempMessageId);
      if (msgIndex >= 0) {
        messages.value.splice(msgIndex, 1);
      }
      isStreaming.value = false;
      requestState.value = 'idle';
      currentRequestId.value = null;
    } finally {
      sending.value = false;
    }
  }

  // Cancel current request
  async function cancelCurrentRequest(): Promise<void> {
    if (!currentRequestId.value) return;

    const serverPort = options.getServerPort();
    const sessionId = options.getSessionId();

    if (!serverPort) return;

    cancelling.value = true;
    try {
      const url = `http://127.0.0.1:${serverPort}/agent/chat/${encodeURIComponent(sessionId)}/cancel/${encodeURIComponent(currentRequestId.value)}`;

      const response = await fetch(url, { method: 'DELETE' });
      const data = await response.json().catch(() => null);

      // Check if cancel was successful
      // Backend returns { success: boolean, message?: string }
      const isSuccess = response.ok && data?.success !== false;

      if (!isSuccess) {
        // Cancel failed - show error but keep request state intact
        // so user can try again or wait for natural completion
        const errorMsg = data?.message || `Failed to cancel request (HTTP ${response.status})`;
        console.error('Cancel request failed:', errorMsg);
        errorMessage.value = errorMsg;
        return;
      }

      // Cancel request sent successfully
      // Note: We intentionally do NOT clear currentRequestId/requestState here
      // The actual state cleanup will happen when we receive the 'cancelled' status event via SSE
      // This ensures UI stays consistent with backend state and avoids race conditions
      // Keep cancelling=true so UI shows "Stopping..." until SSE confirms
      // cancelling will be reset when handleStatusEvent receives 'cancelled' status
    } catch (error) {
      console.error('Failed to cancel request:', error);
      errorMessage.value = error instanceof Error ? error.message : 'Failed to cancel request';
      // Only reset cancelling on error, not on success
      cancelling.value = false;
    }
  }

  // Clear messages
  function clearMessages(): void {
    messages.value = [];
  }

  // Set messages (for loading history)
  function setMessages(newMessages: AgentMessage[]): void {
    messages.value = newMessages;
  }

  return {
    // State
    messages,
    input,
    sending,
    isStreaming,
    requestState,
    errorMessage,
    currentRequestId,
    cancelling,
    attachments,
    lastUsage,

    // Computed
    canSend,
    isRequestActive,

    // Methods
    handleRealtimeEvent,
    send,
    cancelCurrentRequest,
    clearMessages,
    setMessages,
  };
}
