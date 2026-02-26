/**
 * Quick Panel Message Renderer
 *
 * Renders AgentChat-compatible messages for the Quick Panel AI Chat UI.
 * Features:
 * - Markdown rendering for assistant messages
 * - XSS-safe rendering for user messages (textContent only)
 * - Streaming message support (in-place updates via message id)
 * - Auto-scroll with proximity detection
 * - Memory-efficient DOM recycling
 */

import type { AgentMessage, AgentRole } from 'webpage-mcp-shared';
import { createMarkdownRenderer, type MarkdownRendererInstance } from './markdown-renderer';

// ============================================================
// Types
// ============================================================

export interface QuickPanelMessageRendererOptions {
  /** Container element for message nodes (typically `.qp-messages`) */
  container: HTMLElement;
  /** Scroll container for auto-scroll heuristics (typically `.qp-content`) */
  scrollContainer?: HTMLElement | null;
  /** Auto-scroll on new/updated messages when user is near bottom. Default: true */
  autoScroll?: boolean;
  /** Pixel threshold for "near bottom" detection. Default: 96 */
  autoScrollThresholdPx?: number;
}

export interface QuickPanelMessageRenderer {
  /** Insert or update a message by id */
  upsert: (message: AgentMessage) => void;
  /** Remove a message by id */
  remove: (messageId: string) => void;
  /** Clear all messages */
  clear: () => void;
  /** Replace all messages with a new array */
  setMessages: (messages: AgentMessage[]) => void;
  /** Get current message count */
  getMessageCount: () => number;
  /** Force scroll to bottom */
  scrollToBottom: () => void;
  /** Clean up resources */
  dispose: () => void;
}

// ============================================================
// Internal Types
// ============================================================

/** DOM elements for a single message entry */
interface MessageEntry {
  wrapper: HTMLDivElement;
  bubble: HTMLDivElement;
  textEl: HTMLDivElement;
  metaEl: HTMLDivElement;
  metaLeftEl: HTMLDivElement;
  streamDotEl: HTMLSpanElement;
  timeEl: HTMLSpanElement;
  metaRightEl: HTMLSpanElement;
  requestIdEl: HTMLElement;
  /** Markdown renderer for assistant messages */
  markdownRenderer: MarkdownRendererInstance | null;
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_AUTO_SCROLL_THRESHOLD_PX = 96;

/** Maximum length for truncated request ID display */
const REQUEST_ID_DISPLAY_LENGTH = 10;

// ============================================================
// Utility Functions
// ============================================================

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function joinClasses(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function formatMessageTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';

  try {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function isStreamingMessage(message: AgentMessage): boolean {
  return message.isStreaming === true && message.isFinal !== true;
}

function getWrapperClassName(role: AgentRole): string {
  return role === 'user' ? 'qp-msg qp-msg--user' : 'qp-msg qp-msg--assistant';
}

function getBubbleClassName(role: AgentRole): string {
  return joinClasses('qp-bubble', role === 'user' && 'qp-bubble--user');
}

function formatRequestIdForDisplay(requestId: string): { short: string; full: string } {
  const full = requestId.trim();
  const short =
    full.length <= REQUEST_ID_DISPLAY_LENGTH ? full : full.slice(0, REQUEST_ID_DISPLAY_LENGTH);
  return { short, full };
}

/**
 * Get a label prefix for special message types
 */
function getMessageTypeLabel(message: AgentMessage): string | null {
  if (message.role === 'tool') return 'Tool';
  if (message.role === 'system') return 'System';
  if (message.messageType === 'tool_use') return 'Tool';
  if (message.messageType === 'tool_result') return 'Result';
  return null;
}

// ============================================================
// DOM Creation Helpers
// ============================================================

function createMetaLeftElement(): {
  container: HTMLDivElement;
  streamDot: HTMLSpanElement;
  time: HTMLSpanElement;
} {
  const container = document.createElement('div');
  Object.assign(container.style, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: '0',
  });

  const streamDot = document.createElement('span');
  streamDot.className = 'qp-msg-stream-dot ac-pulse';
  streamDot.hidden = true;

  const time = document.createElement('span');

  container.append(streamDot, time);

  return { container, streamDot, time };
}

function createMetaRightElement(): { container: HTMLSpanElement; requestId: HTMLElement } {
  const container = document.createElement('span');
  container.hidden = true;

  const requestId = document.createElement('code');

  container.append(requestId);

  return { container, requestId };
}

function createMessageEntry(messageId: string, message: AgentMessage): MessageEntry {
  const wrapper = document.createElement('div');
  wrapper.className = getWrapperClassName(message.role);
  wrapper.dataset.messageId = messageId;
  wrapper.dataset.role = message.role;
  wrapper.dataset.messageType = message.messageType;

  const bubble = document.createElement('div');
  bubble.className = getBubbleClassName(message.role);

  const textEl = document.createElement('div');
  textEl.className = 'qp-msg-text';

  const metaEl = document.createElement('div');
  metaEl.className = 'qp-msg-meta';

  const metaLeft = createMetaLeftElement();
  const metaRight = createMetaRightElement();

  metaEl.append(metaLeft.container, metaRight.container);
  bubble.append(textEl, metaEl);
  wrapper.append(bubble);

  // Create markdown renderer for assistant messages
  let markdownRenderer: MarkdownRendererInstance | null = null;
  if (message.role === 'assistant') {
    markdownRenderer = createMarkdownRenderer(textEl);
  }

  return {
    wrapper,
    bubble,
    textEl,
    metaEl,
    metaLeftEl: metaLeft.container,
    streamDotEl: metaLeft.streamDot,
    timeEl: metaLeft.time,
    metaRightEl: metaRight.container,
    requestIdEl: metaRight.requestId,
    markdownRenderer,
  };
}

// ============================================================
// Entry Update Logic
// ============================================================

function updateMessageEntry(entry: MessageEntry, messageId: string, message: AgentMessage): void {
  // Update wrapper classes and data attributes
  const wrapperClass = getWrapperClassName(message.role);
  if (entry.wrapper.className !== wrapperClass) {
    entry.wrapper.className = wrapperClass;
  }

  entry.wrapper.dataset.role = message.role;
  entry.wrapper.dataset.messageType = message.messageType;
  entry.wrapper.dataset.messageId = messageId;

  // Update bubble class
  const bubbleClass = getBubbleClassName(message.role);
  if (entry.bubble.className !== bubbleClass) {
    entry.bubble.className = bubbleClass;
  }

  // Update content based on message role
  const textContent = message.content ?? '';

  if (message.role === 'assistant' && entry.markdownRenderer) {
    // Use markdown renderer for assistant messages
    entry.markdownRenderer.setContent(textContent, isStreamingMessage(message));
  } else {
    // Use plain text for user messages (XSS-safe)
    if (entry.textEl.textContent !== textContent) {
      entry.textEl.textContent = textContent;
    }
  }

  // Update time display
  const typeLabel = getMessageTypeLabel(message);
  const timeText = formatMessageTime(message.createdAt) || '\u2014'; // em dash for empty
  entry.timeEl.textContent = typeLabel ? `${typeLabel} \u2022 ${timeText}` : timeText;

  // Update streaming indicator
  entry.streamDotEl.hidden = !isStreamingMessage(message);

  // Update request ID display
  const rawRequestId = isNonEmptyString(message.requestId) ? message.requestId.trim() : '';
  if (rawRequestId) {
    const formatted = formatRequestIdForDisplay(rawRequestId);
    entry.requestIdEl.textContent = formatted.short;
    entry.requestIdEl.title = formatted.full;
    entry.metaRightEl.hidden = false;
  } else {
    entry.requestIdEl.textContent = '';
    entry.requestIdEl.title = '';
    entry.metaRightEl.hidden = true;
  }
}

// ============================================================
// Main Factory
// ============================================================

/**
 * Create a message renderer instance for the Quick Panel AI Chat.
 *
 * @example
 * ```typescript
 * const renderer = createQuickPanelMessageRenderer({
 *   container: messagesEl,
 *   scrollContainer: contentEl,
 * });
 *
 * // Render streaming message
 * renderer.upsert(message);
 *
 * // Clean up
 * renderer.dispose();
 * ```
 */
export function createQuickPanelMessageRenderer(
  options: QuickPanelMessageRendererOptions,
): QuickPanelMessageRenderer {
  const container = options.container;
  const scrollContainer = options.scrollContainer ?? null;
  const autoScroll = options.autoScroll ?? true;
  const thresholdPx = options.autoScrollThresholdPx ?? DEFAULT_AUTO_SCROLL_THRESHOLD_PX;

  /** Map of messageId -> DOM entry */
  const entries = new Map<string, MessageEntry>();

  let disposed = false;

  // --------------------------------------------------------
  // Scroll Management
  // --------------------------------------------------------

  function isNearBottom(): boolean {
    if (!scrollContainer) return true;

    const { scrollHeight, scrollTop, clientHeight } = scrollContainer;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    return distanceFromBottom <= thresholdPx;
  }

  function scrollToBottom(): void {
    if (!scrollContainer) return;

    try {
      scrollContainer.scrollTo({ top: scrollContainer.scrollHeight });
    } catch {
      // Fallback for older browsers
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }

  // --------------------------------------------------------
  // Core Operations
  // --------------------------------------------------------

  function upsert(message: AgentMessage): void {
    if (disposed) return;

    const messageId = message.id?.trim();
    if (!messageId) return;

    const shouldAutoScroll = autoScroll && isNearBottom();

    let entry = entries.get(messageId);
    if (!entry) {
      entry = createMessageEntry(messageId, message);
      entries.set(messageId, entry);
      container.append(entry.wrapper);
    }

    updateMessageEntry(entry, messageId, message);

    if (shouldAutoScroll) {
      scrollToBottom();
    }
  }

  function remove(messageId: string): void {
    if (disposed) return;

    const id = messageId?.trim();
    if (!id) return;

    const entry = entries.get(id);
    if (!entry) return;

    entries.delete(id);

    // Dispose markdown renderer if exists
    if (entry.markdownRenderer) {
      entry.markdownRenderer.dispose();
    }

    try {
      entry.wrapper.remove();
    } catch {
      // Fallback for edge cases
      entry.wrapper.parentElement?.removeChild(entry.wrapper);
    }
  }

  function clear(): void {
    if (disposed) return;

    // Dispose all markdown renderers
    for (const entry of entries.values()) {
      if (entry.markdownRenderer) {
        entry.markdownRenderer.dispose();
      }
    }

    entries.clear();
    container.textContent = '';
  }

  function setMessages(messages: AgentMessage[]): void {
    if (disposed) return;

    // Dispose all existing markdown renderers
    for (const entry of entries.values()) {
      if (entry.markdownRenderer) {
        entry.markdownRenderer.dispose();
      }
    }

    // Clear existing state
    entries.clear();
    container.textContent = '';

    // Render all messages
    for (const msg of messages) {
      const id = msg.id?.trim();
      if (!id) continue;

      const entry = createMessageEntry(id, msg);
      entries.set(id, entry);
      updateMessageEntry(entry, id, msg);
      container.append(entry.wrapper);
    }

    // Scroll to bottom after batch render
    scrollToBottom();
  }

  function getMessageCount(): number {
    return entries.size;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    // Dispose all markdown renderers
    for (const entry of entries.values()) {
      if (entry.markdownRenderer) {
        entry.markdownRenderer.dispose();
      }
    }

    entries.clear();
    container.textContent = '';
  }

  // --------------------------------------------------------
  // Public API
  // --------------------------------------------------------

  return {
    upsert,
    remove,
    clear,
    setMessages,
    getMessageCount,
    scrollToBottom,
    dispose,
  };
}
