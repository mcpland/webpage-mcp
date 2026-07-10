import { cdpSessionManager } from '@/utils/cdp-session-manager';

/**
 * ConsoleBuffer - Persistent console log buffer manager
 *
 * Maintain a scroll buffer for each tab and continuously collect console events.
 * The buffer will be automatically cleared when the tab navigates to a new domain name to avoid confusion between logs from different sites.
 */

const DEFAULT_MAX_BUFFER_MESSAGES = 2000;
const DEFAULT_MAX_BUFFER_EXCEPTIONS = 500;

export interface BufferedConsoleMessage {
  timestamp: number;
  level: string;
  text: string;
  args?: unknown[];
  source?: string;
  url?: string;
  lineNumber?: number;
  stackTrace?: unknown;
}

export interface BufferedConsoleException {
  timestamp: number;
  text: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  stackTrace?: unknown;
}

interface TabConsoleBufferState {
  tabId: number;
  tabUrl: string;
  tabTitle: string;
  hostname: string;
  captureStartTime: number;
  messages: BufferedConsoleMessage[];
  exceptions: BufferedConsoleException[];
  droppedMessageCount: number;
  droppedExceptionCount: number;
}

export interface ConsoleBufferReadOptions {
  onlyErrors?: boolean;
  limit?: number;
  includeExceptions?: boolean;
}

export interface ConsoleBufferReadResult {
  tabId: number;
  tabUrl: string;
  tabTitle: string;
  captureStartTime: number;
  captureEndTime: number;
  totalDurationMs: number;
  messages: BufferedConsoleMessage[];
  exceptions: BufferedConsoleException[];
  totalBufferedMessages: number;
  totalBufferedExceptions: number;
  messageCount: number;
  exceptionCount: number;
  messageLimitReached: boolean;
  droppedMessageCount: number;
  droppedExceptionCount: number;
}

function extractHostname(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isErrorLevel(level?: string): boolean {
  const normalized = (level || '').toLowerCase();
  return normalized === 'error' || normalized === 'assert';
}

function formatConsoleArgs(args: unknown[]): string {
  if (!args || args.length === 0) return '';

  return args
    .map((arg: unknown) => {
      const a = arg as Record<string, unknown>;
      if (a.type === 'string') return (a.value as string) || '';
      if (a.type === 'number') return String(a.value ?? '');
      if (a.type === 'boolean') return String(a.value ?? '');
      if (a.type === 'object') return (a.description as string) || '[Object]';
      if (a.type === 'undefined') return 'undefined';
      if (a.type === 'function') return (a.description as string) || '[Function]';
      return (a.description as string) || (a.value as string) || String(arg);
    })
    .join(' ');
}

/**
 * Extract safe preview data from CDP RemoteObject, discard objectId to avoid memory leaks
 */
function extractArgPreview(arg: unknown): unknown {
  const a = arg as Record<string, unknown>;
  if (!a || typeof a !== 'object') return arg;

  // Only keep safe fields, discard objectId
  const preview: Record<string, unknown> = {
    type: a.type,
  };

  if ('value' in a) preview.value = a.value;
  if ('unserializableValue' in a) preview.unserializableValue = a.unserializableValue;
  if ('description' in a) preview.description = a.description;
  if ('subtype' in a) preview.subtype = a.subtype;
  if ('className' in a) preview.className = a.className;

  return preview;
}

function safeTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return Date.now();
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

class ConsoleBuffer {
  private buffers = new Map<number, TabConsoleBufferState>();
  private starting = new Map<number, Promise<void>>();
  private static instance: ConsoleBuffer | null = null;

  constructor() {
    if (ConsoleBuffer.instance) {
      return ConsoleBuffer.instance;
    }
    ConsoleBuffer.instance = this;

    chrome.debugger.onEvent.addListener(this.handleDebuggerEvent.bind(this));
    chrome.debugger.onDetach.addListener(this.handleDebuggerDetach.bind(this));
    chrome.tabs.onRemoved.addListener(this.handleTabRemoved.bind(this));
    chrome.tabs.onUpdated.addListener(this.handleTabUpdated.bind(this));
  }

  /**
   * Checks whether the specified tab is capturing in buffer mode
   */
  isCapturing(tabId: number): boolean {
    return this.buffers.has(tabId);
  }

  /**
   * Ensure buffer capture for the specified tab is enabled
   */
  async ensureStarted(tabId: number): Promise<void> {
    if (this.buffers.has(tabId)) return;

    const existing = this.starting.get(tabId);
    if (existing) return existing;

    const promise = this.startCapture(tabId).finally(() => {
      this.starting.delete(tabId);
    });
    this.starting.set(tabId, promise);
    return promise;
  }

  /**
   * Clear the buffer of the specified tab
   */
  clear(
    tabId: number,
    reason: string = 'manual',
  ): { clearedMessages: number; clearedExceptions: number } | null {
    const state = this.buffers.get(tabId);
    if (!state) return null;

    const clearedMessages = state.messages.length;
    const clearedExceptions = state.exceptions.length;

    state.messages.length = 0;
    state.exceptions.length = 0;
    state.droppedMessageCount = 0;
    state.droppedExceptionCount = 0;
    state.captureStartTime = Date.now();

    console.log(
      `ConsoleBuffer: Cleared buffer for tab ${tabId} (reason=${reason}). ` +
        `${clearedMessages} messages, ${clearedExceptions} exceptions.`,
    );

    return { clearedMessages, clearedExceptions };
  }

  /**
   * Read the buffer contents of the specified tab
   */
  read(tabId: number, options: ConsoleBufferReadOptions = {}): ConsoleBufferReadResult | null {
    const state = this.buffers.get(tabId);
    if (!state) return null;

    const { onlyErrors = false, limit, includeExceptions = true } = options;

    const totalBufferedMessages = state.messages.length;
    const totalBufferedExceptions = state.exceptions.length;

    // Filter messages
    let messages = state.messages;
    if (onlyErrors) {
      messages = messages.filter((m) => isErrorLevel(m.level));
    }

    // Sort by time
    messages = [...messages].sort((a, b) => a.timestamp - b.timestamp);

    // Apply limit
    let messageLimitReached = false;
    const normalizedLimit =
      typeof limit === 'number' && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : null;
    if (normalizedLimit !== null && messages.length > normalizedLimit) {
      messageLimitReached = true;
      // Keep the latest news
      messages = messages.slice(messages.length - normalizedLimit);
    }

    // Filter exceptions
    let exceptions: BufferedConsoleException[] = [];
    if (includeExceptions) {
      exceptions = state.exceptions;
      exceptions = [...exceptions].sort((a, b) => a.timestamp - b.timestamp);
    }

    const now = Date.now();

    return {
      tabId,
      tabUrl: state.tabUrl,
      tabTitle: state.tabTitle,
      captureStartTime: state.captureStartTime,
      captureEndTime: now,
      totalDurationMs: now - state.captureStartTime,
      messages,
      exceptions,
      totalBufferedMessages,
      totalBufferedExceptions,
      messageCount: messages.length,
      exceptionCount: exceptions.length,
      messageLimitReached,
      droppedMessageCount: state.droppedMessageCount,
      droppedExceptionCount: state.droppedExceptionCount,
    };
  }

  private async startCapture(tabId: number): Promise<void> {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || '';
    const title = tab.title || '';
    const hostname = extractHostname(url);

    const state: TabConsoleBufferState = {
      tabId,
      tabUrl: url,
      tabTitle: title,
      hostname,
      captureStartTime: Date.now(),
      messages: [],
      exceptions: [],
      droppedMessageCount: 0,
      droppedExceptionCount: 0,
    };

    this.buffers.set(tabId, state);

    try {
      await cdpSessionManager.attach(tabId, 'console-buffer');
      await cdpSessionManager.sendCommand(tabId, 'Runtime.enable');
      await cdpSessionManager.sendCommand(tabId, 'Log.enable');
    } catch (error) {
      this.buffers.delete(tabId);
      await cdpSessionManager.detach(tabId, 'console-buffer').catch(() => {});
      throw error;
    }
  }

  private handleTabRemoved(tabId: number): void {
    if (!this.buffers.has(tabId)) return;
    void this.stopCapture(tabId, 'tab_closed');
  }

  private handleTabUpdated(
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
  ): void {
    const state = this.buffers.get(tabId);
    if (!state) return;

    const nextUrl = changeInfo.url ?? tab.url;
    const nextTitle = tab.title;

    if (typeof nextUrl === 'string') {
      const nextHost = extractHostname(nextUrl);
      // Clear buffer when domain name changes
      if (nextHost !== state.hostname) {
        this.clear(tabId, 'domain_changed');
        state.hostname = nextHost;
      }
      state.tabUrl = nextUrl;
    }

    if (typeof nextTitle === 'string') {
      state.tabTitle = nextTitle;
    }
  }

  private handleDebuggerDetach(source: chrome.debugger.Debuggee, reason: string): void {
    if (typeof source.tabId !== 'number') return;
    if (!this.buffers.has(source.tabId)) return;

    console.log(
      `ConsoleBuffer: Debugger detached from tab ${source.tabId} (reason=${reason}), cleaning up.`,
    );

    this.buffers.delete(source.tabId);
    this.starting.delete(source.tabId);
    cdpSessionManager.detach(source.tabId, 'console-buffer').catch(() => {});
  }

  private handleDebuggerEvent(
    source: chrome.debugger.Debuggee,
    method: string,
    params?: unknown,
  ): void {
    const tabId = source.tabId;
    if (typeof tabId !== 'number') return;

    const state = this.buffers.get(tabId);
    if (!state) return;

    const p = params as Record<string, unknown>;

    if (method === 'Log.entryAdded' && p?.entry) {
      const entry = p.entry as Record<string, unknown>;
      state.messages.push({
        timestamp: safeTimestamp(entry.timestamp),
        level: safeString(entry.level) || 'log',
        text: safeString(entry.text),
        source: safeString(entry.source),
        url: safeString(entry.url),
        lineNumber: safeNumber(entry.lineNumber),
        stackTrace: entry.stackTrace,
      });
      this.trimMessages(state);
      return;
    }

    if (method === 'Runtime.consoleAPICalled' && p) {
      const stackTrace = p.stackTrace as Record<string, unknown[]> | undefined;
      const callFrame = stackTrace?.callFrames?.[0] as Record<string, unknown> | undefined;
      const rawArgs = (p.args as unknown[]) || [];

      state.messages.push({
        timestamp: safeTimestamp(p.timestamp),
        level: safeString(p.type) || 'log',
        text: formatConsoleArgs(rawArgs),
        source: 'console-api',
        url: safeString(callFrame?.url),
        lineNumber: safeNumber(callFrame?.lineNumber),
        stackTrace: stackTrace,
        // Only store safe preview data to avoid memory leaks
        args: rawArgs.map(extractArgPreview),
      });
      this.trimMessages(state);
      return;
    }

    if (method === 'Runtime.exceptionThrown' && p?.exceptionDetails) {
      const exceptionDetails = p.exceptionDetails as Record<string, unknown>;
      const exception = exceptionDetails.exception as Record<string, unknown> | undefined;
      state.exceptions.push({
        timestamp: Date.now(),
        text:
          safeString(exceptionDetails.text) ||
          safeString(exception?.description) ||
          'Unknown exception',
        url: safeString(exceptionDetails.url),
        lineNumber: safeNumber(exceptionDetails.lineNumber),
        columnNumber: safeNumber(exceptionDetails.columnNumber),
        stackTrace: exceptionDetails.stackTrace,
      });
      this.trimExceptions(state);
    }
  }

  private trimMessages(state: TabConsoleBufferState): void {
    const overflow = state.messages.length - DEFAULT_MAX_BUFFER_MESSAGES;
    if (overflow <= 0) return;
    state.messages.splice(0, overflow);
    state.droppedMessageCount += overflow;
  }

  private trimExceptions(state: TabConsoleBufferState): void {
    const overflow = state.exceptions.length - DEFAULT_MAX_BUFFER_EXCEPTIONS;
    if (overflow <= 0) return;
    state.exceptions.splice(0, overflow);
    state.droppedExceptionCount += overflow;
  }

  private async stopCapture(tabId: number, reason: string): Promise<void> {
    if (!this.buffers.has(tabId)) return;

    this.buffers.delete(tabId);
    this.starting.delete(tabId);

    try {
      await cdpSessionManager.sendCommand(tabId, 'Runtime.disable');
    } catch {
      // best effort
    }
    try {
      await cdpSessionManager.sendCommand(tabId, 'Log.disable');
    } catch {
      // best effort
    }
    await cdpSessionManager.detach(tabId, 'console-buffer').catch(() => {});
    console.log(`ConsoleBuffer: Stopped buffer for tab ${tabId} (reason=${reason}).`);
  }
}

export const consoleBuffer = new ConsoleBuffer();
