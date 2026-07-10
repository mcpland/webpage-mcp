import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  appendToByteRing,
  CONSOLE_BUFFER_MAX_EXCEPTION_BYTES,
  CONSOLE_BUFFER_MAX_EXCEPTIONS,
  CONSOLE_BUFFER_MAX_MESSAGE_BYTES,
  CONSOLE_BUFFER_MAX_MESSAGES,
  CONSOLE_TITLE_MAX_UTF8_BYTES,
  CONSOLE_URL_MAX_UTF8_BYTES,
  getByteRingLength,
  getByteRingValues,
  sanitizeConsoleExceptionInput,
  sanitizeConsoleMessageInput,
  sanitizeRuntimeConsoleEvent,
  truncateConsoleJsonString,
  type BoundedConsoleException,
  type BoundedConsoleMessage,
  type ByteRingState,
} from './console-limits';

/**
 * Persistent console capture is intentionally scarce: every active tab owns a
 * debugger session and receives page-controlled events until explicitly
 * stopped or expired.
 */
export const CONSOLE_BUFFER_IDLE_TTL_MS = 5 * 60 * 1_000;
export const CONSOLE_BUFFER_MAX_CAPTURED_TABS = 4;

export type BufferedConsoleMessage = BoundedConsoleMessage;
export type BufferedConsoleException = BoundedConsoleException;

interface TabConsoleBufferState {
  tabId: number;
  tabUrl: string;
  tabTitle: string;
  hostname: string;
  captureStartTime: number;
  messages: ByteRingState<BufferedConsoleMessage>;
  exceptions: ByteRingState<BufferedConsoleException>;
  idleTimer?: ReturnType<typeof setTimeout>;
  attached: boolean;
}

interface StartOperation {
  cancelled: boolean;
  promise: Promise<void>;
}

interface ConsoleBufferSessionManager {
  attach(tabId: number, owner: string): Promise<void>;
  detach(tabId: number, owner: string): Promise<void>;
  sendCommand(
    tabId: number,
    method: string,
    commandParams?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface ConsoleBufferLimits {
  maxMessages: number;
  maxExceptions: number;
  maxMessageBytes: number;
  maxExceptionBytes: number;
  maxCapturedTabs: number;
  idleTtlMs: number;
}

export interface ConsoleBufferOptions extends Partial<ConsoleBufferLimits> {
  chromeApi?: typeof chrome;
  sessionManager?: ConsoleBufferSessionManager;
  now?: () => number;
}

export interface ConsoleBufferReadOptions {
  onlyErrors?: boolean;
  limit?: number;
  exceptionLimit?: number;
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

function boundedLimit(
  value: unknown,
  fallback: number,
  hardMax: number,
): number {
  const numeric =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.floor(value)
      : fallback;
  return Math.min(hardMax, Math.max(0, numeric));
}

function boundedPositiveOption(value: unknown, fallback: number): number {
  const numeric =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.floor(value)
      : fallback;
  return Math.min(fallback, Math.max(1, numeric));
}

function emptyRing<T>(): ByteRingState<T> {
  return { entries: [], head: 0, byteSize: 0, droppedCount: 0 };
}

export class ConsoleBuffer {
  private readonly buffers = new Map<number, TabConsoleBufferState>();
  private readonly starting = new Map<number, StartOperation>();
  private readonly chromeApi: typeof chrome;
  private readonly sessionManager: ConsoleBufferSessionManager;
  private readonly now: () => number;
  private readonly limits: ConsoleBufferLimits;

  private readonly debuggerEventListener = (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: unknown,
  ): void => this.handleDebuggerEvent(source, method, params);

  private readonly debuggerDetachListener = (
    source: chrome.debugger.Debuggee,
    reason: string,
  ): void => this.handleDebuggerDetach(source, reason);

  private readonly tabRemovedListener = (tabId: number): void =>
    this.handleTabRemoved(tabId);

  private readonly tabUpdatedListener = (
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
  ): void => this.handleTabUpdated(tabId, changeInfo, tab);

  constructor(options: ConsoleBufferOptions = {}) {
    this.chromeApi = options.chromeApi ?? chrome;
    this.sessionManager = options.sessionManager ?? cdpSessionManager;
    this.now = options.now ?? Date.now;
    this.limits = {
      maxMessages: boundedPositiveOption(
        options.maxMessages,
        CONSOLE_BUFFER_MAX_MESSAGES,
      ),
      maxExceptions: boundedPositiveOption(
        options.maxExceptions,
        CONSOLE_BUFFER_MAX_EXCEPTIONS,
      ),
      maxMessageBytes: boundedPositiveOption(
        options.maxMessageBytes,
        CONSOLE_BUFFER_MAX_MESSAGE_BYTES,
      ),
      maxExceptionBytes: boundedPositiveOption(
        options.maxExceptionBytes,
        CONSOLE_BUFFER_MAX_EXCEPTION_BYTES,
      ),
      maxCapturedTabs: boundedPositiveOption(
        options.maxCapturedTabs,
        CONSOLE_BUFFER_MAX_CAPTURED_TABS,
      ),
      idleTtlMs: boundedPositiveOption(
        options.idleTtlMs,
        CONSOLE_BUFFER_IDLE_TTL_MS,
      ),
    };

    this.chromeApi.debugger.onEvent.addListener(this.debuggerEventListener);
    this.chromeApi.debugger.onDetach.addListener(this.debuggerDetachListener);
    this.chromeApi.tabs.onRemoved.addListener(this.tabRemovedListener);
    this.chromeApi.tabs.onUpdated.addListener(this.tabUpdatedListener);
  }

  isCapturing(tabId: number): boolean {
    return this.buffers.has(tabId);
  }

  async ensureStarted(tabId: number): Promise<void> {
    const existing = this.starting.get(tabId);
    if (existing) return existing.promise;

    const current = this.buffers.get(tabId);
    if (current) {
      this.touch(current);
      return;
    }

    const reservedTabs = new Set([
      ...this.buffers.keys(),
      ...this.starting.keys(),
    ]);
    if (reservedTabs.size >= this.limits.maxCapturedTabs) {
      throw new Error(
        `Console buffer capture limit reached (${this.limits.maxCapturedTabs} tabs). Stop an existing buffer before starting another.`,
      );
    }

    const operation = { cancelled: false } as StartOperation;
    this.starting.set(tabId, operation);
    operation.promise = this.startCapture(tabId, operation).finally(() => {
      if (this.starting.get(tabId) === operation) this.starting.delete(tabId);
    });
    return operation.promise;
  }

  clear(
    tabId: number,
    reason = 'manual',
  ): { clearedMessages: number; clearedExceptions: number } | null {
    const state = this.buffers.get(tabId);
    if (!state) return null;
    this.touch(state);
    return this.resetState(state, reason);
  }

  read(
    tabId: number,
    options: ConsoleBufferReadOptions = {},
  ): ConsoleBufferReadResult | null {
    const state = this.buffers.get(tabId);
    if (!state) return null;
    this.touch(state);

    const { onlyErrors = false, includeExceptions = true } = options;
    const totalBufferedMessages = getByteRingLength(state.messages);
    const totalBufferedExceptions = getByteRingLength(state.exceptions);

    let messages = getByteRingValues(state.messages);
    if (onlyErrors)
      messages = messages.filter((message) => isErrorLevel(message.level));
    messages.sort((left, right) => left.timestamp - right.timestamp);

    const messageLimit = boundedLimit(
      options.limit,
      this.limits.maxMessages,
      this.limits.maxMessages,
    );
    let messageLimitReached = state.messages.droppedCount > 0;
    if (messages.length > messageLimit) {
      messageLimitReached = true;
      messages = messages.slice(messages.length - messageLimit);
    }

    let exceptions: BufferedConsoleException[] = [];
    if (includeExceptions) {
      exceptions = getByteRingValues(state.exceptions);
      exceptions.sort((left, right) => left.timestamp - right.timestamp);
      const exceptionLimit = boundedLimit(
        options.exceptionLimit,
        this.limits.maxExceptions,
        this.limits.maxExceptions,
      );
      if (exceptions.length > exceptionLimit) {
        exceptions = exceptions.slice(exceptions.length - exceptionLimit);
      }
    }

    const captureEndTime = this.now();
    return {
      tabId,
      tabUrl: state.tabUrl,
      tabTitle: state.tabTitle,
      captureStartTime: state.captureStartTime,
      captureEndTime,
      totalDurationMs: captureEndTime - state.captureStartTime,
      messages,
      exceptions,
      totalBufferedMessages,
      totalBufferedExceptions,
      messageCount: messages.length,
      exceptionCount: exceptions.length,
      messageLimitReached,
      droppedMessageCount: state.messages.droppedCount,
      droppedExceptionCount: state.exceptions.droppedCount,
    };
  }

  /** Stop is deliberately separate from clear: clear keeps the debugger lease alive. */
  async stop(tabId: number, reason = 'manual'): Promise<boolean> {
    const operation = this.starting.get(tabId);
    if (operation) operation.cancelled = true;

    const state = this.buffers.get(tabId);
    if (!state) return operation !== undefined;

    this.buffers.delete(tabId);
    this.clearIdleTimer(state);

    if (state.attached) {
      await this.sessionManager
        .sendCommand(tabId, 'Runtime.disable')
        .catch(() => undefined);
      await this.sessionManager
        .sendCommand(tabId, 'Log.disable')
        .catch(() => undefined);
      await this.sessionManager
        .detach(tabId, 'console-buffer')
        .catch(() => undefined);
    }
    console.log(
      `ConsoleBuffer: Stopped buffer for tab ${tabId} (reason=${reason}).`,
    );
    return true;
  }

  async dispose(): Promise<void> {
    this.chromeApi.debugger.onEvent.removeListener(this.debuggerEventListener);
    this.chromeApi.debugger.onDetach.removeListener(
      this.debuggerDetachListener,
    );
    this.chromeApi.tabs.onRemoved.removeListener(this.tabRemovedListener);
    this.chromeApi.tabs.onUpdated.removeListener(this.tabUpdatedListener);

    const tabIds = new Set([...this.buffers.keys(), ...this.starting.keys()]);
    await Promise.all([...tabIds].map((tabId) => this.stop(tabId, 'dispose')));
  }

  private async startCapture(
    tabId: number,
    operation: StartOperation,
  ): Promise<void> {
    let state: TabConsoleBufferState | undefined;
    try {
      const tab = await this.chromeApi.tabs.get(tabId);
      if (operation.cancelled)
        throw new Error('Console buffer start was cancelled.');

      const url = truncateConsoleJsonString(
        tab.url || '',
        CONSOLE_URL_MAX_UTF8_BYTES,
      );
      state = {
        tabId,
        tabUrl: url,
        tabTitle: truncateConsoleJsonString(
          tab.title || '',
          CONSOLE_TITLE_MAX_UTF8_BYTES,
        ),
        hostname: extractHostname(url),
        captureStartTime: this.now(),
        messages: emptyRing(),
        exceptions: emptyRing(),
        attached: false,
      };
      this.buffers.set(tabId, state);
      this.touch(state);

      await this.sessionManager.attach(tabId, 'console-buffer');
      state.attached = true;
      this.assertStartActive(tabId, state, operation);
      await this.sessionManager.sendCommand(tabId, 'Runtime.enable');
      this.assertStartActive(tabId, state, operation);
      await this.sessionManager.sendCommand(tabId, 'Log.enable');
      this.assertStartActive(tabId, state, operation);
    } catch (error) {
      if (state && this.buffers.get(tabId) === state)
        this.buffers.delete(tabId);
      if (state) this.clearIdleTimer(state);
      await this.sessionManager
        .detach(tabId, 'console-buffer')
        .catch(() => undefined);
      throw error;
    }
  }

  private assertStartActive(
    tabId: number,
    state: TabConsoleBufferState,
    operation: StartOperation,
  ): void {
    if (operation.cancelled || this.buffers.get(tabId) !== state) {
      throw new Error('Console buffer start was cancelled.');
    }
  }

  private touch(state: TabConsoleBufferState): void {
    this.clearIdleTimer(state);
    state.idleTimer = setTimeout(() => {
      if (this.buffers.get(state.tabId) === state) {
        void this.stop(state.tabId, 'idle_timeout');
      }
    }, this.limits.idleTtlMs);
  }

  private clearIdleTimer(state: TabConsoleBufferState): void {
    if (state.idleTimer !== undefined) {
      clearTimeout(state.idleTimer);
      state.idleTimer = undefined;
    }
  }

  private resetState(
    state: TabConsoleBufferState,
    reason: string,
  ): { clearedMessages: number; clearedExceptions: number } {
    const clearedMessages = getByteRingLength(state.messages);
    const clearedExceptions = getByteRingLength(state.exceptions);
    state.messages = emptyRing();
    state.exceptions = emptyRing();
    state.captureStartTime = this.now();
    console.log(
      `ConsoleBuffer: Cleared buffer for tab ${state.tabId} (reason=${reason}). ` +
        `${clearedMessages} messages, ${clearedExceptions} exceptions.`,
    );
    return { clearedMessages, clearedExceptions };
  }

  private handleTabRemoved(tabId: number): void {
    if (!this.buffers.has(tabId) && !this.starting.has(tabId)) return;
    void this.stop(tabId, 'tab_closed');
  }

  private handleTabUpdated(
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab,
  ): void {
    const state = this.buffers.get(tabId);
    if (!state) return;
    const nextUrl = changeInfo.url ?? tab.url;
    if (typeof nextUrl === 'string') {
      const boundedNextUrl = truncateConsoleJsonString(
        nextUrl,
        CONSOLE_URL_MAX_UTF8_BYTES,
      );
      const nextHostname = extractHostname(boundedNextUrl);
      if (nextHostname !== state.hostname) {
        this.resetState(state, 'domain_changed');
        state.hostname = nextHostname;
      }
      state.tabUrl = boundedNextUrl;
    }
    if (typeof tab.title === 'string') {
      state.tabTitle = truncateConsoleJsonString(
        tab.title,
        CONSOLE_TITLE_MAX_UTF8_BYTES,
      );
    }
  }

  private handleDebuggerDetach(
    source: chrome.debugger.Debuggee,
    reason: string,
  ): void {
    if (typeof source.tabId !== 'number') return;
    const operation = this.starting.get(source.tabId);
    if (operation) operation.cancelled = true;
    const state = this.buffers.get(source.tabId);
    if (!state && !operation) return;

    if (state) {
      this.buffers.delete(source.tabId);
      this.clearIdleTimer(state);
    }
    void this.sessionManager
      .detach(source.tabId, 'console-buffer')
      .catch(() => undefined);
    console.log(
      `ConsoleBuffer: Debugger detached from tab ${source.tabId} (reason=${reason}), cleaning up.`,
    );
  }

  private handleDebuggerEvent(
    source: chrome.debugger.Debuggee,
    method: string,
    params?: unknown,
  ): void {
    if (typeof source.tabId !== 'number') return;
    const state = this.buffers.get(source.tabId);
    if (!state) return;
    const record =
      params !== null && typeof params === 'object'
        ? (params as Record<string, unknown>)
        : {};

    if (method === 'Log.entryAdded' && record.entry) {
      appendToByteRing(
        state.messages,
        sanitizeConsoleMessageInput(record.entry, this.now),
        this.limits.maxMessages,
        this.limits.maxMessageBytes,
      );
      return;
    }

    if (method === 'Runtime.consoleAPICalled') {
      appendToByteRing(
        state.messages,
        sanitizeRuntimeConsoleEvent(record, this.now),
        this.limits.maxMessages,
        this.limits.maxMessageBytes,
      );
      return;
    }

    if (method === 'Runtime.exceptionThrown' && record.exceptionDetails) {
      appendToByteRing(
        state.exceptions,
        sanitizeConsoleExceptionInput(record.exceptionDetails, this.now),
        this.limits.maxExceptions,
        this.limits.maxExceptionBytes,
      );
    }
  }
}

export const consoleBuffer = new ConsoleBuffer();
