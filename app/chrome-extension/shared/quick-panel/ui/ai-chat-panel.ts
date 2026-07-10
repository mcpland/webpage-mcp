/**
 * Quick Panel AI Chat Panel
 *
 * A complete AI chat interface for Quick Panel, featuring:
 * - Streaming message display with real-time updates
 * - Liquid Glass design with AgentChat token compatibility
 * - Full keyboard navigation (Enter to send, Esc to close)
 * - Request lifecycle management (send, cancel, cleanup)
 * - Auto-context collection (page URL, text selection)
 *
 * This component is framework-agnostic and renders directly to Shadow DOM
 * for optimal isolation and performance in content script context.
 */

import type {
  AgentMessage,
  AgentStatusEvent,
  AgentUsageStats,
  RealtimeEvent,
} from 'webpage-mcp-shared';

import {
  PRIVILEGED_UI_ACTIONS,
  type QuickPanelAIContext,
  type QuickPanelSendToAIPayload,
} from '@/common/message-types';
import type { QuickPanelAgentBridge } from '../core/agent-bridge';
import { Disposer } from '@/entrypoints/web-editor/utils/disposables';
import {
  authorizePrivilegedUiAction,
  isTrustedPrivilegedUiEvent,
} from '@/utils/privileged-ui-authorization';
import {
  createQuickPanelMessageRenderer,
  type QuickPanelMessageRenderer,
} from './message-renderer';

// ============================================================
// Types
// ============================================================

export interface QuickPanelAiChatPanelOptions {
  /** Shadow DOM mount point (typically `elements.root` from shadow-host.ts) */
  mount: HTMLElement;
  /** Agent bridge for background communication */
  agentBridge: QuickPanelAgentBridge;

  /** Header title. Default: "Agent" */
  title?: string;
  /** Header subtitle. Default: "Quick Panel" */
  subtitle?: string;
  /** Input placeholder. Default: "Ask the agent..." */
  placeholder?: string;
  /** Auto-focus textarea on mount. Default: true */
  autoFocus?: boolean;

  /** Optional context provider for enhanced AI understanding */
  getContext?: () => QuickPanelAIContext | null | Promise<QuickPanelAIContext | null>;

  /** Called when user requests to close the panel */
  onRequestClose?: () => void;
}

export interface QuickPanelAiChatPanelState {
  sending: boolean;
  streaming: boolean;
  cancelling: boolean;
  currentRequestId: string | null;
  sessionId: string | null;
  lastStatus: AgentStatusEvent['status'] | null;
  lastUsage: AgentUsageStats | null;
  errorMessage: string | null;
}

export interface QuickPanelAiChatPanelManager {
  getState: () => QuickPanelAiChatPanelState;
  focusInput: () => void;
  clearMessages: () => void;
  close: () => void;
  dispose: () => void;
}

// ============================================================
// Constants
// ============================================================

const LOG_PREFIX = '[QuickPanelAiChatPanel]';

const DEFAULT_TITLE = 'Agent';
const DEFAULT_SUBTITLE = 'Quick Panel';
const DEFAULT_PLACEHOLDER = 'Ask the agent...';

/** Max chars for selected text context to avoid payload bloat */
const MAX_SELECTED_TEXT_CHARS = 3000;
/** Max chars for error message display */
const MAX_ERROR_DISPLAY_CHARS = 600;

const TEXTAREA_MIN_HEIGHT_PX = 42;
const TEXTAREA_MAX_HEIGHT_PX = 160;

/** Auto-hide duration for success/warning banners */
const BANNER_AUTO_HIDE_MS = 2400;

// SVG Icons
const ICON_CLOSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
const ICON_SEND = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>`;
const ICON_STOP = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`;

// ============================================================
// Utility Functions
// ============================================================

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function truncateText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}\u2026`;
}

function safeFocus(element: HTMLElement): void {
  try {
    element.focus();
  } catch {
    // Best-effort focus
  }
}

function isTerminalStatus(status: AgentStatusEvent['status']): boolean {
  return status === 'completed' || status === 'error' || status === 'cancelled';
}

/**
 * Collect default context from the current page
 */
function collectDefaultContext(): QuickPanelAIContext {
  const context: QuickPanelAIContext = {
    pageUrl: globalThis.location?.href,
  };

  try {
    const selection = globalThis.getSelection?.();
    const selectedText = selection?.toString()?.trim() ?? '';
    if (selectedText) {
      context.selectedText = truncateText(selectedText, MAX_SELECTED_TEXT_CHARS);
    }
  } catch {
    // Ignore selection access errors
  }

  return context;
}

/**
 * Build a local user message for optimistic rendering
 */
function buildLocalUserMessage(
  sessionId: string,
  requestId: string,
  instruction: string,
): AgentMessage {
  return {
    id: `local-user:${requestId}`,
    sessionId,
    role: 'user',
    content: instruction,
    messageType: 'chat',
    requestId,
    isStreaming: false,
    isFinal: true,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Format usage stats for display
 */
function formatUsageStats(usage: AgentUsageStats | null): string | null {
  if (!usage) return null;

  const parts: string[] = [];

  const inputTokens = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
  const outputTokens = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0;
  parts.push(`in ${inputTokens}`, `out ${outputTokens}`);

  if (Number.isFinite(usage.durationMs) && usage.durationMs > 0) {
    const seconds = Math.max(1, Math.round(usage.durationMs / 1000));
    parts.push(`${seconds}s`);
  }

  if (Number.isFinite(usage.totalCostUsd) && usage.totalCostUsd > 0) {
    parts.push(`$${usage.totalCostUsd.toFixed(4)}`);
  }

  return parts.join(' \u2022 ');
}

// ============================================================
// DOM Builder Functions
// ============================================================

interface PanelDOMElements {
  overlay: HTMLDivElement;
  panel: HTMLDivElement;
  titleSubEl: HTMLDivElement;
  streamIndicator: HTMLDivElement;
  streamText: HTMLSpanElement;
  closeBtn: HTMLButtonElement;
  contentEl: HTMLDivElement;
  emptyEl: HTMLDivElement;
  messagesEl: HTMLDivElement;
  banner: HTMLDivElement;
  textarea: HTMLTextAreaElement;
  /** Unified action button: send/stop */
  actionBtn: HTMLButtonElement;
}

function buildPanelDOM(options: QuickPanelAiChatPanelOptions): PanelDOMElements {
  const title = options.title?.trim() || DEFAULT_TITLE;
  const subtitle = options.subtitle?.trim() || DEFAULT_SUBTITLE;
  const placeholder = options.placeholder?.trim() || DEFAULT_PLACEHOLDER;

  // Overlay (click outside to close)
  const overlay = document.createElement('div');
  overlay.className = 'qp-overlay';
  overlay.setAttribute('data-mcp-quick-panel-ai-chat', 'true');

  // Panel container
  const panel = document.createElement('div');
  panel.className = 'qp-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', title);

  // ---- Header ----
  const header = document.createElement('div');
  header.className = 'qp-header';

  const headerLeft = document.createElement('div');
  headerLeft.className = 'qp-header-left';

  const brand = document.createElement('div');
  brand.className = 'qp-brand';
  brand.textContent = '\u2726'; // Star symbol

  const titleWrap = document.createElement('div');
  titleWrap.className = 'qp-title';

  const titleNameEl = document.createElement('div');
  titleNameEl.className = 'qp-title-name';
  titleNameEl.textContent = title;

  const titleSubEl = document.createElement('div');
  titleSubEl.className = 'qp-title-sub';
  titleSubEl.textContent = subtitle;

  titleWrap.append(titleNameEl, titleSubEl);
  headerLeft.append(brand, titleWrap);

  const headerRight = document.createElement('div');
  headerRight.className = 'qp-header-right';

  const streamIndicator = document.createElement('div');
  streamIndicator.className = 'qp-stream-indicator';
  streamIndicator.hidden = true;

  const streamDot = document.createElement('span');
  streamDot.className = 'qp-stream-dot ac-pulse';

  const streamText = document.createElement('span');
  streamText.textContent = 'Streaming';

  streamIndicator.append(streamDot, streamText);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'qp-icon-btn ac-focus-ring';
  closeBtn.innerHTML = ICON_CLOSE;
  closeBtn.setAttribute('aria-label', 'Close Quick Panel');

  headerRight.append(streamIndicator, closeBtn);
  header.append(headerLeft, headerRight);

  // ---- Content ----
  const contentEl = document.createElement('div');
  contentEl.className = 'qp-content ac-scroll';

  const emptyEl = document.createElement('div');
  emptyEl.className = 'qp-empty';

  const emptyIcon = document.createElement('div');
  emptyIcon.className = 'qp-empty-icon';
  emptyIcon.textContent = '\u2726';

  const emptyText = document.createElement('div');
  emptyText.className = 'qp-empty-text';
  emptyText.textContent = 'Ask about this page. Streaming replies appear here.';

  emptyEl.append(emptyIcon, emptyText);

  const messagesEl = document.createElement('div');
  messagesEl.className = 'qp-messages';

  contentEl.append(emptyEl, messagesEl);

  // ---- Composer ----
  const composer = document.createElement('div');
  composer.className = 'qp-composer';

  const banner = document.createElement('div');
  banner.className = 'qp-status';
  banner.hidden = true;

  const textarea = document.createElement('textarea');
  textarea.className = 'qp-textarea ac-focus-ring';
  textarea.placeholder = placeholder;
  textarea.rows = 1;

  const actions = document.createElement('div');
  actions.className = 'qp-actions';

  const actionsLeft = document.createElement('div');
  actionsLeft.className = 'qp-actions-left';

  // Keyboard hints
  const hints = [
    { key: 'Enter', label: 'Send' },
    { key: 'Shift+Enter', label: 'New line' },
    { key: 'Esc', label: 'Close' },
  ];

  for (const hint of hints) {
    const keyEl = document.createElement('span');
    keyEl.className = 'qp-kbd';
    keyEl.textContent = hint.key;

    const labelEl = document.createElement('span');
    labelEl.textContent = hint.label;

    actionsLeft.append(keyEl, labelEl);
  }

  const actionsRight = document.createElement('div');
  actionsRight.className = 'qp-actions-right';

  // Unified action button: shows send icon normally, stop icon when loading
  const actionBtn = document.createElement('button');
  actionBtn.type = 'button';
  actionBtn.className = 'qp-icon-btn qp-icon-btn--action qp-icon-btn--primary ac-focus-ring';
  actionBtn.innerHTML = ICON_SEND;
  actionBtn.setAttribute('aria-label', 'Send message');
  actionBtn.dataset.action = 'send';

  actionsRight.append(actionBtn);
  actions.append(actionsLeft, actionsRight);
  composer.append(banner, textarea, actions);

  // Assemble
  panel.append(header, contentEl, composer);
  overlay.append(panel);

  return {
    overlay,
    panel,
    titleSubEl,
    streamIndicator,
    streamText,
    closeBtn,
    contentEl,
    emptyEl,
    messagesEl,
    banner,
    textarea,
    actionBtn,
  };
}

// ============================================================
// Main Factory
// ============================================================

/**
 * Mount the Quick Panel AI Chat interface.
 *
 * @example
 * ```typescript
 * const chatPanel = mountQuickPanelAiChatPanel({
 *   mount: shadowHostElements.root,
 *   agentBridge,
 *   onRequestClose: () => quickPanel.hide(),
 * });
 *
 * // Later: clean up
 * chatPanel.dispose();
 * ```
 */
export function mountQuickPanelAiChatPanel(
  options: QuickPanelAiChatPanelOptions,
): QuickPanelAiChatPanelManager {
  const disposer = new Disposer();

  const mount = options.mount;
  const agentBridge = options.agentBridge;
  const defaultSubtitle = options.subtitle?.trim() || DEFAULT_SUBTITLE;

  // Clean up any existing panel in same mount (crash recovery)
  try {
    const existing = mount.querySelector?.('[data-mcp-quick-panel-ai-chat="true"]');
    if (existing instanceof HTMLElement) {
      existing.remove();
    }
  } catch {
    // Ignore cleanup errors
  }

  // --------------------------------------------------------
  // State Management
  // --------------------------------------------------------

  let disposed = false;
  let requestUnsubscribe: (() => void) | null = null;
  let bannerTimer: ReturnType<typeof setTimeout> | null = null;

  let state: QuickPanelAiChatPanelState = {
    sending: false,
    streaming: false,
    cancelling: false,
    currentRequestId: null,
    sessionId: null,
    lastStatus: null,
    lastUsage: null,
    errorMessage: null,
  };

  // --------------------------------------------------------
  // DOM Setup
  // --------------------------------------------------------

  const dom = buildPanelDOM(options);
  mount.append(dom.overlay);
  disposer.add(() => dom.overlay.remove());

  // Message renderer
  const renderer: QuickPanelMessageRenderer = createQuickPanelMessageRenderer({
    container: dom.messagesEl,
    scrollContainer: dom.contentEl,
    autoScroll: true,
    autoScrollThresholdPx: 96,
  });
  disposer.add(() => renderer.dispose());

  // --------------------------------------------------------
  // Banner Management
  // --------------------------------------------------------

  function clearBannerTimer(): void {
    if (bannerTimer) {
      clearTimeout(bannerTimer);
      bannerTimer = null;
    }
  }

  function hideBanner(): void {
    clearBannerTimer();
    dom.banner.hidden = true;
    dom.banner.className = 'qp-status';
    dom.banner.textContent = '';
  }

  function showBanner(
    tone: 'info' | 'success' | 'warning' | 'error',
    message: string,
    autoHideMs?: number,
  ): void {
    clearBannerTimer();
    dom.banner.hidden = false;
    dom.banner.className = 'qp-status';

    if (tone === 'error') dom.banner.classList.add('qp-status--error');
    if (tone === 'success') dom.banner.classList.add('qp-status--success');
    if (tone === 'warning') dom.banner.classList.add('qp-status--warning');

    dom.banner.textContent = message;

    if (autoHideMs && autoHideMs > 0) {
      bannerTimer = setTimeout(hideBanner, autoHideMs);
    }
  }

  // --------------------------------------------------------
  // Textarea Auto-resize
  // --------------------------------------------------------

  function resizeTextarea(): void {
    try {
      dom.textarea.style.height = 'auto';
      const targetHeight = Math.min(
        TEXTAREA_MAX_HEIGHT_PX,
        Math.max(TEXTAREA_MIN_HEIGHT_PX, dom.textarea.scrollHeight),
      );
      dom.textarea.style.height = `${targetHeight}px`;
    } catch {
      // Ignore resize errors
    }
  }

  // --------------------------------------------------------
  // UI Rendering
  // --------------------------------------------------------

  function renderEmptyState(): void {
    const hasMessages = renderer.getMessageCount() > 0;
    dom.emptyEl.hidden = hasMessages;
    dom.messagesEl.hidden = !hasMessages;
  }

  function renderHeaderSubtitle(): void {
    if (state.errorMessage) {
      dom.titleSubEl.textContent = 'Error';
      return;
    }
    if (state.streaming) {
      dom.titleSubEl.textContent = 'Streaming\u2026';
      return;
    }
    if (state.sending) {
      dom.titleSubEl.textContent = 'Sending\u2026';
      return;
    }

    const usageText = formatUsageStats(state.lastUsage);
    dom.titleSubEl.textContent = usageText ? `Last: ${usageText}` : defaultSubtitle;
  }

  function renderControls(): void {
    const inputText = dom.textarea.value.trim();
    const isLoading = state.sending || state.streaming || state.cancelling;
    const canSend = inputText.length > 0 && !isLoading;
    const canCancel = state.currentRequestId !== null && !state.cancelling;

    // Update action button state and appearance
    if (isLoading) {
      // Show stop icon when loading/streaming
      dom.actionBtn.innerHTML = ICON_STOP;
      dom.actionBtn.setAttribute('aria-label', 'Stop request');
      dom.actionBtn.dataset.action = 'stop';
      dom.actionBtn.disabled = !canCancel;
      dom.actionBtn.classList.remove('qp-icon-btn--primary');
      dom.actionBtn.classList.add('qp-icon-btn--danger');
    } else {
      // Show send icon when idle
      dom.actionBtn.innerHTML = ICON_SEND;
      dom.actionBtn.setAttribute('aria-label', 'Send message');
      dom.actionBtn.dataset.action = 'send';
      dom.actionBtn.disabled = !canSend;
      dom.actionBtn.classList.remove('qp-icon-btn--danger');
      dom.actionBtn.classList.add('qp-icon-btn--primary');
    }

    // Stream indicator
    dom.streamIndicator.hidden = !isLoading;
    if (state.cancelling) {
      dom.streamText.textContent = 'Cancelling';
    } else if (state.sending) {
      dom.streamText.textContent = 'Sending';
    } else {
      dom.streamText.textContent = 'Streaming';
    }

    // Allow typing while streaming; disable only during send/cancel
    dom.textarea.disabled = state.sending || state.cancelling;

    renderHeaderSubtitle();
    renderEmptyState();
  }

  function setState(patch: Partial<QuickPanelAiChatPanelState>): void {
    state = { ...state, ...patch };
    renderControls();
  }

  // --------------------------------------------------------
  // Subscription Management
  // --------------------------------------------------------

  function cleanupActiveSubscription(): void {
    if (requestUnsubscribe) {
      try {
        requestUnsubscribe();
      } catch {
        // Ignore cleanup errors
      }
      requestUnsubscribe = null;
    }
  }

  // --------------------------------------------------------
  // Context Resolution
  // --------------------------------------------------------

  async function resolveContext(): Promise<QuickPanelAIContext | undefined> {
    // Try custom context provider
    try {
      if (options.getContext) {
        const provided = await options.getContext();
        if (provided && typeof provided === 'object') {
          return provided;
        }
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} getContext failed:`, err);
    }

    // Fallback to default context
    const fallback = collectDefaultContext();

    // Don't send empty context
    if (!isNonEmptyString(fallback.pageUrl) && !isNonEmptyString(fallback.selectedText)) {
      return undefined;
    }

    return fallback;
  }

  // --------------------------------------------------------
  // Request Lifecycle
  // --------------------------------------------------------

  async function sendCurrentInput(activationEvent: Event): Promise<void> {
    if (disposed) return;
    if (state.sending || state.streaming || state.cancelling) return;
    if (!isTrustedPrivilegedUiEvent(activationEvent)) return;

    const instruction = dom.textarea.value.trim();
    if (!instruction) return;

    // Clear previous errors
    setState({ errorMessage: null, lastUsage: null, lastStatus: null });
    hideBanner();

    // Save input for restoration on failure
    const savedInput = dom.textarea.value;
    dom.textarea.value = '';
    resizeTextarea();

    setState({ sending: true });

    // Resolve context
    const context = await resolveContext();
    if (disposed) return;

    // Mint the capability immediately before use so slow context providers do
    // not consume its short validity window.
    let authorizationToken: string;
    try {
      authorizationToken = await authorizePrivilegedUiAction(
        PRIVILEGED_UI_ACTIONS.QUICK_PANEL_SEND,
      );
    } catch (error) {
      const errorMsg = truncateText(
        error instanceof Error ? error.message : String(error),
        MAX_ERROR_DISPLAY_CHARS,
      );
      dom.textarea.value = savedInput;
      resizeTextarea();
      setState({ sending: false, errorMessage: errorMsg });
      showBanner('error', errorMsg);
      return;
    }

    const payload: QuickPanelSendToAIPayload = {
      instruction,
      context: context ?? undefined,
    };

    // Send to agent
    const result = await agentBridge.sendToAI(payload, authorizationToken);
    if (disposed) return;

    if (!result.success) {
      // Restore input on failure
      dom.textarea.value = savedInput;
      resizeTextarea();

      const errorMsg = truncateText(result.error, MAX_ERROR_DISPLAY_CHARS);
      setState({ sending: false, errorMessage: errorMsg });
      showBanner('error', errorMsg);
      return;
    }

    // Optimistic user message rendering
    // Note: Server will also echo user message; we render locally for instant feedback
    // and skip server-echoed user messages in handleRequestEvent
    renderer.upsert(buildLocalUserMessage(result.sessionId, result.requestId, instruction));
    renderer.scrollToBottom();

    setState({
      sending: false,
      streaming: true,
      currentRequestId: result.requestId,
      sessionId: result.sessionId,
      lastStatus: 'starting',
    });

    // Subscribe to events
    cleanupActiveSubscription();
    requestUnsubscribe = agentBridge.onRequestEvent(result.requestId, (event) => {
      if (disposed) return;
      handleRequestEvent(event);
    });
  }

  async function cancelCurrentRequest(): Promise<void> {
    if (disposed) return;
    if (!state.currentRequestId) return;
    if (state.cancelling) return;

    const requestId = state.currentRequestId;
    const sessionId = state.sessionId || undefined;

    setState({ cancelling: true });

    const result = await agentBridge.cancelRequest(requestId, sessionId);
    if (disposed) return;

    if (!result.success) {
      const errorMsg = truncateText(result.error, MAX_ERROR_DISPLAY_CHARS);
      setState({ cancelling: false, errorMessage: errorMsg });
      showBanner('error', errorMsg);
      return;
    }

    // Cancellation completion will be driven by the 'cancelled' status event
    setState({ cancelling: false });
  }

  function handleTerminal(status: AgentStatusEvent['status'], message?: string): void {
    cleanupActiveSubscription();

    setState({
      streaming: false,
      sending: false,
      cancelling: false,
      currentRequestId: null,
      sessionId: null,
      lastStatus: status,
    });

    if (status === 'completed') {
      const usageText = formatUsageStats(state.lastUsage);
      const bannerMsg = usageText ? `Completed \u2022 ${usageText}` : 'Completed';
      showBanner('success', bannerMsg, BANNER_AUTO_HIDE_MS);
      return;
    }

    if (status === 'cancelled') {
      showBanner('warning', 'Cancelled', BANNER_AUTO_HIDE_MS);
      return;
    }

    if (status === 'error') {
      const errorMsg = truncateText(
        message || state.errorMessage || 'Request failed',
        MAX_ERROR_DISPLAY_CHARS,
      );
      setState({ errorMessage: errorMsg });
      showBanner('error', errorMsg);
    }
  }

  /**
   * Handle incoming RealtimeEvent with runtime guards for malformed data.
   */
  function handleRequestEvent(event: RealtimeEvent): void {
    if (disposed) return;

    // Runtime guard: validate event structure
    if (!event || typeof event !== 'object' || !('type' in event)) {
      console.warn(`${LOG_PREFIX} Invalid event structure:`, event);
      return;
    }

    try {
      switch (event.type) {
        case 'message': {
          const msg = event.data;

          // Runtime guard: validate message structure
          if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') {
            console.warn(`${LOG_PREFIX} Invalid message data:`, msg);
            return;
          }

          // For user messages from server, replace local optimistic message
          // This preserves server-side metadata (cliSource, etc.)
          if (msg.role === 'user') {
            const localUserId = `local-user:${msg.requestId}`;
            renderer.remove(localUserId);
          }

          renderer.upsert(msg);

          if (msg.isStreaming === true && !msg.isFinal) {
            setState({ streaming: true });
          }
          return;
        }

        case 'status': {
          const statusData = event.data;

          // Runtime guard: validate status data
          if (
            !statusData ||
            typeof statusData !== 'object' ||
            typeof statusData.status !== 'string'
          ) {
            console.warn(`${LOG_PREFIX} Invalid status data:`, statusData);
            return;
          }

          setState({ lastStatus: statusData.status });

          if (
            statusData.status === 'starting' ||
            statusData.status === 'ready' ||
            statusData.status === 'running'
          ) {
            setState({ streaming: true });
            return;
          }

          if (isTerminalStatus(statusData.status)) {
            handleTerminal(statusData.status, statusData.message);
          }
          return;
        }

        case 'usage': {
          setState({ lastUsage: event.data });
          return;
        }

        case 'error': {
          const errorMsg = truncateText(event.error || 'Unknown error', MAX_ERROR_DISPLAY_CHARS);
          setState({ errorMessage: errorMsg });
          showBanner('error', errorMsg);

          cleanupActiveSubscription();
          setState({
            streaming: false,
            sending: false,
            cancelling: false,
            currentRequestId: null,
            sessionId: null,
            lastStatus: 'error',
          });
          return;
        }

        case 'connected':
        case 'heartbeat': {
          // These events are typically filtered by background, but handle exhaustively
          return;
        }
      }
    } catch (err) {
      // Catch any unexpected errors to prevent UI crash
      console.warn(`${LOG_PREFIX} Error handling event:`, err, event);
    }
  }

  // --------------------------------------------------------
  // Event Handlers
  // --------------------------------------------------------

  disposer.listen(dom.overlay, 'click', (ev: MouseEvent) => {
    if (disposed) return;
    // Close on backdrop click
    if (ev.target === dom.overlay) {
      close();
    }
  });

  disposer.listen(dom.closeBtn, 'click', () => close());

  // Unified action button handler: send or stop based on current state
  disposer.listen(dom.actionBtn, 'click', (event: MouseEvent) => {
    if (disposed) return;
    if (!isTrustedPrivilegedUiEvent(event)) return;
    const action = dom.actionBtn.dataset.action;
    if (action === 'stop') {
      void cancelCurrentRequest();
    } else {
      void sendCurrentInput(event);
    }
  });

  disposer.listen(dom.textarea, 'input', () => {
    if (disposed) return;
    resizeTextarea();
    renderControls();
  });

  disposer.listen(dom.textarea, 'keydown', (ev: KeyboardEvent) => {
    if (disposed) return;

    // Esc closes the panel
    if (ev.key === 'Escape' && !ev.isComposing) {
      ev.preventDefault();
      close();
      return;
    }

    // Enter sends, Shift+Enter inserts newline
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      if (!isTrustedPrivilegedUiEvent(ev)) return;
      ev.preventDefault();
      void sendCurrentInput(ev);
    }
  });

  // --------------------------------------------------------
  // Public API
  // --------------------------------------------------------

  function focusInput(): void {
    if (disposed) return;
    safeFocus(dom.textarea);
  }

  function clearMessages(): void {
    if (disposed) return;
    renderer.clear();
    hideBanner();
    setState({ lastUsage: null, lastStatus: null, errorMessage: null });
  }

  function close(): void {
    if (disposed) return;

    // Best-effort cancel on close
    if (state.currentRequestId) {
      void cancelCurrentRequest();
    }

    try {
      options.onRequestClose?.();
    } catch (err) {
      console.warn(`${LOG_PREFIX} onRequestClose failed:`, err);
    }

    dispose();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    cleanupActiveSubscription();
    clearBannerTimer();
    disposer.dispose();
  }

  // --------------------------------------------------------
  // Initialization
  // --------------------------------------------------------

  resizeTextarea();
  renderControls();

  if (options.autoFocus !== false) {
    focusInput();
  }

  return {
    getState: () => ({ ...state }),
    focusInput,
    clearMessages,
    close,
    dispose,
  };
}
