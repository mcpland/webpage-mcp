import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  consoleBuffer,
  BufferedConsoleMessage,
  BufferedConsoleException,
} from './console-buffer';
import {
  measureWorkflowRegexUtf8Bytes,
  testWorkflowRegex,
  validateWorkflowRegexPattern,
  validateWorkflowRegexPatternSize,
  WORKFLOW_REGEX_BATCH_INPUT_MAX_UTF8_BYTES,
  WORKFLOW_REGEX_INPUT_MAX_UTF8_BYTES,
  type WorkflowRegexFailure,
} from '@/entrypoints/background/record-replay/workflow-regex';
import {
  appendToByteRing,
  CONSOLE_MAX_EXCEPTIONS,
  CONSOLE_MAX_MESSAGES,
  CONSOLE_SNAPSHOT_MAX_EVENTS,
  CONSOLE_SNAPSHOT_MAX_EXCEPTION_BYTES,
  CONSOLE_SNAPSHOT_MAX_MESSAGE_BYTES,
  CONSOLE_TITLE_MAX_UTF8_BYTES,
  CONSOLE_URL_MAX_UTF8_BYTES,
  getByteRingValues,
  sanitizeConsoleExceptionInput,
  sanitizeConsoleMessageInput,
  sanitizeRuntimeConsoleEvent,
  truncateConsoleJsonString,
  type ByteRingState,
} from './console-limits';

const DEFAULT_MAX_MESSAGES = 100;
const DEFAULT_MAX_EXCEPTIONS = 50;
export const CONSOLE_TAB_READY_TIMEOUT_MS = 30_000;
const CONSOLE_TAB_READY_POLL_MS = 100;

type ConsoleMode = 'snapshot' | 'buffer';

interface ConsoleToolParams {
  url?: string;
  tabId?: number;
  background?: boolean;
  windowId?: number;
  includeExceptions?: boolean;
  maxMessages?: number;
  maxExceptions?: number;
  // New parameters
  mode?: ConsoleMode;
  buffer?: boolean; // mode="buffer" alias
  clear?: boolean; // Clear before reading
  clearAfterRead?: boolean; // Empty after reading (mcp-tools.js style)
  stop?: boolean; // Stop persistent capture without treating clear as a stop
  pattern?: string;
  onlyErrors?: boolean;
  limit?: number;
}

interface ConsoleMessage {
  timestamp: number;
  level: string;
  text: string;
  args?: any[];
  argsSerialized?: any[];
  source?: string;
  url?: string | null;
  urlRedacted?: boolean;
  lineNumber?: number;
  stackTrace?: any;
}

interface ConsoleException {
  timestamp: number;
  text: string;
  url?: string | null;
  urlRedacted?: boolean;
  lineNumber?: number;
  columnNumber?: number;
  stackTrace?: any;
}

interface ConsoleResult {
  success: boolean;
  message: string;
  tabId: number;
  tabUrl: string;
  tabTitle: string;
  captureStartTime: number;
  captureEndTime: number;
  totalDurationMs: number;
  messages: ConsoleMessage[];
  exceptions: ConsoleException[];
  messageCount: number;
  exceptionCount: number;
  messageLimitReached: boolean;
  droppedMessageCount: number;
  droppedExceptionCount: number;
}

// Helper function

interface ParsedRegexPattern {
  source: string;
  flags: string;
}

function normalizeLimit(
  value: unknown,
  fallback: number,
  hardMax = CONSOLE_MAX_MESSAGES,
): number {
  const n =
    typeof value === 'number' && Number.isFinite(value)
      ? Math.floor(value)
      : fallback;
  return Math.min(hardMax, Math.max(0, n));
}

function hasDisallowedPublicPageScheme(url: string): boolean {
  const match = url.trim().match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
  if (!match) {
    return false;
  }

  const protocol = match[1]?.toLowerCase();
  return protocol !== 'http' && protocol !== 'https';
}

function formatRegexFailure(result: WorkflowRegexFailure): string {
  return `Console regex rejected (${result.code}): ${result.message}`;
}

function hasSupportedRegexFlags(value: string): boolean {
  for (const flag of value) {
    if (
      flag !== 'g' &&
      flag !== 'i' &&
      flag !== 'm' &&
      flag !== 's' &&
      flag !== 'u' &&
      flag !== 'y'
    ) {
      return false;
    }
  }
  return true;
}

function parseRegexPattern(pattern?: string): ParsedRegexPattern | undefined {
  if (typeof pattern !== 'string') return undefined;
  const rawSize = validateWorkflowRegexPatternSize(pattern);
  if (!rawSize.ok) throw new Error(formatRegexFailure(rawSize));
  const trimmed = pattern.trim();
  if (!trimmed) return undefined;

  // Support /pattern/flags syntax
  let source = trimmed;
  let flags = '';
  if (trimmed.startsWith('/')) {
    const finalSlash = trimmed.lastIndexOf('/');
    const candidateFlags = finalSlash > 0 ? trimmed.slice(finalSlash + 1) : '';
    const candidateSource = finalSlash > 0 ? trimmed.slice(1, finalSlash) : '';
    if (
      finalSlash > 1 &&
      hasSupportedRegexFlags(candidateFlags) &&
      !candidateSource.includes('\n') &&
      !candidateSource.includes('\r')
    ) {
      source = candidateSource;
      flags = candidateFlags;
    }
  }

  const validation = validateWorkflowRegexPattern(source, flags);
  if (!validation.ok) throw new Error(formatRegexFailure(validation));
  return { source, flags };
}

function matchesPattern(pattern: ParsedRegexPattern, text: string): boolean {
  const result = testWorkflowRegex(pattern.source, text, pattern.flags);
  if (!result.ok) throw new Error(formatRegexFailure(result));
  return result.matched;
}

function sanitizeConsoleUrl(url: unknown): {
  url?: string | null;
  urlRedacted?: true;
} {
  if (typeof url !== 'string' || !url.trim()) {
    return {};
  }
  if (hasDisallowedPublicPageScheme(url)) {
    return { url: null, urlRedacted: true };
  }
  return { url };
}

function sanitizeNestedUrls(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeNestedUrls(item, depth + 1));
  }
  if (typeof value !== 'object') {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (key === 'url') {
      const sanitized = sanitizeConsoleUrl(nested);
      if ('url' in sanitized) {
        result.url = sanitized.url;
      }
      if (sanitized.urlRedacted) {
        result.urlRedacted = true;
      }
      continue;
    }
    result[key] = sanitizeNestedUrls(nested, depth + 1);
  }
  return result;
}

function sanitizeConsoleMessage(message: ConsoleMessage): ConsoleMessage {
  const bounded = sanitizeConsoleMessageInput(message);
  const sanitizedUrl = sanitizeConsoleUrl(bounded.url);
  return {
    ...bounded,
    ...sanitizedUrl,
    ...(bounded.stackTrace
      ? { stackTrace: sanitizeNestedUrls(bounded.stackTrace) }
      : {}),
  };
}

function sanitizeConsoleException(
  exception: ConsoleException,
): ConsoleException {
  const bounded = sanitizeConsoleExceptionInput(exception);
  const sanitizedUrl = sanitizeConsoleUrl(bounded.url);
  return {
    ...bounded,
    ...sanitizedUrl,
    ...(bounded.stackTrace
      ? { stackTrace: sanitizeNestedUrls(bounded.stackTrace) }
      : {}),
  };
}

function isErrorLevel(level?: string): boolean {
  const normalized = (level || '').toLowerCase();
  return normalized === 'error' || normalized === 'assert';
}

function applyResultFilters(
  result: ConsoleResult,
  options: {
    pattern?: ParsedRegexPattern;
    onlyErrors?: boolean;
    includeExceptions: boolean;
  },
): ConsoleResult {
  const { pattern, onlyErrors = false, includeExceptions } = options;
  let matchedInputBytes = 0;
  const matchesWithinBudget = (text: string): boolean => {
    if (!pattern) return true;
    const inputBytes = measureWorkflowRegexUtf8Bytes(
      text,
      WORKFLOW_REGEX_INPUT_MAX_UTF8_BYTES,
    );
    if (inputBytes === null) return matchesPattern(pattern, text);
    if (
      inputBytes >
      WORKFLOW_REGEX_BATCH_INPUT_MAX_UTF8_BYTES - matchedInputBytes
    ) {
      throw new Error(
        `Console regex rejected (WORKFLOW_REGEX_BATCH_INPUT_TOO_LARGE): cumulative input exceeds ${WORKFLOW_REGEX_BATCH_INPUT_MAX_UTF8_BYTES} UTF-8 bytes.`,
      );
    }
    matchedInputBytes += inputBytes;
    return matchesPattern(pattern, text);
  };

  let messages = result.messages;
  if (onlyErrors) {
    messages = messages.filter((m) => isErrorLevel(m.level));
  }
  if (pattern) {
    messages = messages.filter((m) => matchesWithinBudget(m.text || ''));
  }

  let exceptions = includeExceptions ? result.exceptions : [];
  if (includeExceptions && pattern) {
    exceptions = exceptions.filter((e) => matchesWithinBudget(e.text || ''));
  }

  return {
    ...result,
    messages,
    exceptions,
    messageCount: messages.length,
    exceptionCount: exceptions.length,
  };
}

function applyResultLimits(
  result: ConsoleResult,
  messageLimit: number,
  exceptionLimit: number,
): ConsoleResult {
  const normalizedMessageLimit = normalizeLimit(
    messageLimit,
    DEFAULT_MAX_MESSAGES,
    CONSOLE_MAX_MESSAGES,
  );
  const normalizedExceptionLimit = normalizeLimit(
    exceptionLimit,
    DEFAULT_MAX_EXCEPTIONS,
    CONSOLE_MAX_EXCEPTIONS,
  );
  const messages =
    result.messages.length > normalizedMessageLimit
      ? result.messages.slice(result.messages.length - normalizedMessageLimit)
      : result.messages;
  const exceptions =
    result.exceptions.length > normalizedExceptionLimit
      ? result.exceptions.slice(
          result.exceptions.length - normalizedExceptionLimit,
        )
      : result.exceptions;
  return {
    ...result,
    messages,
    exceptions,
    messageCount: messages.length,
    exceptionCount: exceptions.length,
    messageLimitReached:
      result.messageLimitReached ||
      result.messages.length > normalizedMessageLimit,
  };
}

function isDebuggerConflictError(error: unknown): boolean {
  const msg = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    msg.includes('debugger is already attached') ||
    msg.includes('another client')
  );
}

function formatDebuggerConflictMessage(
  tabId: number,
  originalMessage: string,
): string {
  return (
    `Failed to attach Chrome Debugger to tab ${tabId}: another debugger client is already attached ` +
    `(likely DevTools or another extension). Close DevTools for this tab or disable the conflicting extension, ` +
    `then retry. Original error: ${originalMessage}`
  );
}

/**
 * Tool for capturing console output from browser tabs
 */
class ConsoleTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CONSOLE;

  async execute(args: ConsoleToolParams): Promise<ToolResult> {
    const {
      url,
      tabId,
      windowId,
      background = false,
      includeExceptions = true,
      maxMessages = DEFAULT_MAX_MESSAGES,
      maxExceptions = DEFAULT_MAX_EXCEPTIONS,
      mode = 'snapshot',
      buffer,
      clear = false,
      clearAfterRead = false,
      stop = false,
      pattern,
      onlyErrors = false,
      limit,
    } = args;

    let targetTab: chrome.tabs.Tab;
    let targetTabId: number | undefined;

    // Stop is a lifecycle operation, so filtering options must not prevent it.
    let compiledPattern: ParsedRegexPattern | undefined;
    if (stop !== true) {
      try {
        compiledPattern = parseRegexPattern(pattern);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return createErrorResponse(msg);
      }
    }

    try {
      if (url && hasDisallowedPublicPageScheme(url)) {
        return createErrorResponse(
          'Only http:// and https:// pages are supported by chrome_console',
        );
      }

      if (typeof tabId === 'number') {
        // Use explicit tab
        const t = await chrome.tabs.get(tabId);
        if (!t?.id)
          return createErrorResponse('Failed to identify target tab.');
        targetTab = t;
      } else if (url) {
        // Navigate to the specified URL
        targetTab = await this.navigateToUrl(
          url,
          background === true,
          windowId,
        );
      } else {
        // Use current active tab
        const [activeTab] =
          typeof windowId === 'number'
            ? await chrome.tabs.query({ active: true, windowId })
            : await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab?.id) {
          return createErrorResponse(
            'No active tab found and no URL provided.',
          );
        }
        targetTab = activeTab;
      }

      if (!targetTab?.id) {
        return createErrorResponse('Failed to identify target tab.');
      }
      if (
        stop !== true &&
        hasDisallowedPublicPageScheme(String(targetTab.url || ''))
      ) {
        return createErrorResponse(
          'Only http:// and https:// pages are supported by chrome_console',
        );
      }

      targetTabId = targetTab.id;

      // Determine the mode: the buffer parameter is an alias for mode="buffer"
      const resolvedMode: ConsoleMode =
        mode === 'buffer' || buffer === true || stop === true
          ? 'buffer'
          : 'snapshot';

      // Calculate effective message limit
      const normalizedMaxMessages = normalizeLimit(
        maxMessages,
        DEFAULT_MAX_MESSAGES,
        CONSOLE_MAX_MESSAGES,
      );
      const normalizedMaxExceptions = normalizeLimit(
        maxExceptions,
        DEFAULT_MAX_EXCEPTIONS,
        CONSOLE_MAX_EXCEPTIONS,
      );
      const effectiveLimit =
        typeof limit === 'number'
          ? normalizeLimit(limit, normalizedMaxMessages, CONSOLE_MAX_MESSAGES)
          : normalizedMaxMessages;

      // Buffer mode
      if (resolvedMode === 'buffer') {
        if (stop === true) {
          const stopped = await consoleBuffer.stop(targetTabId, 'manual');
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: stopped
                    ? `Console buffer stopped for tab ${targetTabId}.`
                    : `No console buffer was active for tab ${targetTabId}.`,
                  tabId: targetTabId,
                  stopped,
                  capturing: consoleBuffer.isCapturing(targetTabId),
                }),
              },
            ],
            isError: false,
          };
        }

        try {
          await consoleBuffer.ensureStarted(targetTabId);
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          if (isDebuggerConflictError(error)) {
            return createErrorResponse(
              formatDebuggerConflictMessage(targetTabId, msg),
            );
          }
          throw error;
        }

        // Handle flush requests before reading
        let clearedBefore: {
          clearedMessages: number;
          clearedExceptions: number;
        } | null = null;
        if (clear === true) {
          clearedBefore = consoleBuffer.clear(targetTabId, 'manual');
        }

        // Read buffer
        const read = consoleBuffer.read(targetTabId, {
          includeExceptions,
          exceptionLimit: normalizedMaxExceptions,
        });

        if (!read) {
          return createErrorResponse(
            'Console buffer is not available for this tab.',
          );
        }

        const result: ConsoleResult = {
          success: true,
          message: '',
          tabId: targetTabId,
          tabUrl: truncateConsoleJsonString(
            read.tabUrl || '',
            CONSOLE_URL_MAX_UTF8_BYTES,
          ),
          tabTitle: truncateConsoleJsonString(
            read.tabTitle || '',
            CONSOLE_TITLE_MAX_UTF8_BYTES,
          ),
          captureStartTime: read.captureStartTime,
          captureEndTime: read.captureEndTime,
          totalDurationMs: read.totalDurationMs,
          messages: read.messages as ConsoleMessage[],
          exceptions: read.exceptions as ConsoleException[],
          messageCount: read.messageCount,
          exceptionCount: read.exceptionCount,
          messageLimitReached: read.messageLimitReached,
          droppedMessageCount: read.droppedMessageCount,
          droppedExceptionCount: read.droppedExceptionCount,
        };

        const filtered = applyResultFilters(result, {
          pattern: compiledPattern,
          onlyErrors,
          includeExceptions,
        });
        const bounded: ConsoleResult = {
          ...filtered,
          messages: filtered.messages.map(sanitizeConsoleMessage),
          exceptions: filtered.exceptions.map(sanitizeConsoleException),
        };
        const limited = applyResultLimits(
          bounded,
          effectiveLimit,
          normalizedMaxExceptions,
        );

        // Clear only after every fallible filter/limit step has succeeded.
        let clearedAfter: {
          clearedMessages: number;
          clearedExceptions: number;
        } | null = null;
        if (clearAfterRead === true) {
          clearedAfter = consoleBuffer.clear(targetTabId, 'manual');
        }
        let clearedSummary = '';
        if (clearedBefore) {
          clearedSummary += ` Cleared ${clearedBefore.clearedMessages} messages and ${clearedBefore.clearedExceptions} exceptions before reading.`;
        }
        if (clearedAfter) {
          clearedSummary += ` Cleared ${clearedAfter.clearedMessages} messages and ${clearedAfter.clearedExceptions} exceptions after reading.`;
        }
        limited.message =
          `Console buffer read for tab ${targetTabId}.` +
          clearedSummary +
          ` Returned ${limited.messageCount} messages and ${limited.exceptionCount} exceptions.`;

        return {
          content: [{ type: 'text', text: JSON.stringify(limited) }],
          isError: false,
        };
      }

      // Snapshot Mode (one-shot capture)
      const result = await this.captureConsoleMessages(targetTabId, {
        includeExceptions,
        maxMessages: effectiveLimit,
        maxExceptions: normalizedMaxExceptions,
      });

      // Apply filter
      const filtered = applyResultFilters(result, {
        pattern: compiledPattern,
        onlyErrors,
        includeExceptions,
      });
      const limited = applyResultLimits(
        filtered,
        effectiveLimit,
        normalizedMaxExceptions,
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(limited) }],
        isError: false,
      };
    } catch (error: unknown) {
      console.error('ConsoleTool: Critical error during execute:', error);
      const msg = error instanceof Error ? error.message : String(error);
      if (typeof targetTabId === 'number' && isDebuggerConflictError(error)) {
        return createErrorResponse(
          formatDebuggerConflictMessage(targetTabId, msg),
        );
      }
      return createErrorResponse(`Error in ConsoleTool: ${msg}`);
    }
  }

  private async navigateToUrl(
    url: string,
    background = false,
    windowId?: number,
  ): Promise<chrome.tabs.Tab> {
    // Check if URL is already open
    const existingTabs = await chrome.tabs.query({ url });

    if (existingTabs.length > 0 && existingTabs[0]?.id) {
      const tab = existingTabs[0];
      if (!background) {
        // Activate the existing tab
        await chrome.tabs.update(tab.id!, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return tab;
    } else {
      // Create new tab with the URL
      const createInfo: chrome.tabs.CreateProperties = {
        url,
        active: background ? false : true,
      };
      if (typeof windowId === 'number') createInfo.windowId = windowId;
      const newTab = await chrome.tabs.create(createInfo);
      // Wait for tab to be ready
      await this.waitForTabReady(newTab.id!);
      return newTab;
    }
  }

  private async waitForTabReady(tabId: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (pollTimer !== undefined) clearTimeout(pollTimer);
        clearTimeout(deadlineTimer);
        resolve();
      };

      const checkTab = async () => {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (settled) return;
          if (tab.status === 'complete') {
            finish();
          } else {
            pollTimer = setTimeout(checkTab, CONSOLE_TAB_READY_POLL_MS);
          }
        } catch {
          finish();
        }
      };

      const deadlineTimer = setTimeout(finish, CONSOLE_TAB_READY_TIMEOUT_MS);
      void checkTab();
    });
  }

  private async captureConsoleMessages(
    tabId: number,
    options: {
      includeExceptions: boolean;
      maxMessages: number;
      maxExceptions: number;
    },
  ): Promise<ConsoleResult> {
    const { includeExceptions, maxMessages, maxExceptions } = options;
    const startTime = Date.now();
    const messageRing: ByteRingState<ConsoleMessage> = {
      entries: [],
      head: 0,
      byteSize: 0,
      droppedCount: 0,
    };
    const exceptionRing: ByteRingState<ConsoleException> = {
      entries: [],
      head: 0,
      byteSize: 0,
      droppedCount: 0,
    };
    let processedEventCount = 0;
    let rateDroppedMessageCount = 0;
    let rateDroppedExceptionCount = 0;

    try {
      const tab = await chrome.tabs.get(tabId);
      await cdpSessionManager.attach(tabId, 'console');

      let listenerActive = true;
      const acceptEvent = (kind: 'message' | 'exception'): boolean => {
        if (processedEventCount < CONSOLE_SNAPSHOT_MAX_EVENTS) {
          processedEventCount += 1;
          return true;
        }
        if (kind === 'message') rateDroppedMessageCount += 1;
        else rateDroppedExceptionCount += 1;
        if (listenerActive) {
          chrome.debugger.onEvent.removeListener(eventListener);
          listenerActive = false;
        }
        return false;
      };

      const eventListener = (
        source: chrome.debugger.Debuggee,
        method: string,
        params?: unknown,
      ): void => {
        if (source.tabId !== tabId) return;
        const record =
          params !== null && typeof params === 'object'
            ? (params as Record<string, unknown>)
            : {};

        if (method === 'Log.entryAdded' && record.entry) {
          if (!acceptEvent('message')) return;
          appendToByteRing(
            messageRing,
            sanitizeConsoleMessage(sanitizeConsoleMessageInput(record.entry)),
            maxMessages,
            CONSOLE_SNAPSHOT_MAX_MESSAGE_BYTES,
          );
          return;
        }
        if (method === 'Runtime.consoleAPICalled') {
          if (!acceptEvent('message')) return;
          appendToByteRing(
            messageRing,
            sanitizeConsoleMessage(sanitizeRuntimeConsoleEvent(record)),
            maxMessages,
            CONSOLE_SNAPSHOT_MAX_MESSAGE_BYTES,
          );
          return;
        }
        if (
          method === 'Runtime.exceptionThrown' &&
          includeExceptions &&
          record.exceptionDetails
        ) {
          if (!acceptEvent('exception')) return;
          appendToByteRing(
            exceptionRing,
            sanitizeConsoleException(
              sanitizeConsoleExceptionInput(record.exceptionDetails),
            ),
            maxExceptions,
            CONSOLE_SNAPSHOT_MAX_EXCEPTION_BYTES,
          );
        }
      };

      chrome.debugger.onEvent.addListener(eventListener);

      try {
        await cdpSessionManager.sendCommand(tabId, 'Runtime.enable');
        await cdpSessionManager.sendCommand(tabId, 'Log.enable');
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } finally {
        if (listenerActive) {
          chrome.debugger.onEvent.removeListener(eventListener);
          listenerActive = false;
        }

        const keepDomainsEnabled = consoleBuffer.isCapturing(tabId);
        if (!keepDomainsEnabled) {
          try {
            await cdpSessionManager.sendCommand(tabId, 'Runtime.disable');
          } catch (e) {
            console.warn(
              `ConsoleTool: Error disabling Runtime for tab ${tabId}:`,
              e,
            );
          }

          try {
            await cdpSessionManager.sendCommand(tabId, 'Log.disable');
          } catch (e) {
            console.warn(
              `ConsoleTool: Error disabling Log for tab ${tabId}:`,
              e,
            );
          }
        }

        try {
          await cdpSessionManager.detach(tabId, 'console');
        } catch (e) {
          console.warn(
            `ConsoleTool: Error detaching debugger for tab ${tabId}:`,
            e,
          );
        }
      }

      const endTime = Date.now();
      const messages = getByteRingValues(messageRing);
      const exceptions = getByteRingValues(exceptionRing);
      messages.sort((a, b) => a.timestamp - b.timestamp);
      exceptions.sort((a, b) => a.timestamp - b.timestamp);
      const droppedMessageCount =
        messageRing.droppedCount + rateDroppedMessageCount;
      const droppedExceptionCount =
        exceptionRing.droppedCount + rateDroppedExceptionCount;

      return {
        success: true,
        message: `Console capture completed for tab ${tabId}. ${messages.length} messages, ${exceptions.length} exceptions captured.`,
        tabId,
        tabUrl: truncateConsoleJsonString(
          tab.url || '',
          CONSOLE_URL_MAX_UTF8_BYTES,
        ),
        tabTitle: truncateConsoleJsonString(
          tab.title || '',
          CONSOLE_TITLE_MAX_UTF8_BYTES,
        ),
        captureStartTime: startTime,
        captureEndTime: endTime,
        totalDurationMs: endTime - startTime,
        messages,
        exceptions,
        messageCount: messages.length,
        exceptionCount: exceptions.length,
        messageLimitReached: droppedMessageCount > 0,
        droppedMessageCount,
        droppedExceptionCount,
      };
    } catch (error: unknown) {
      console.error(
        `ConsoleTool: Error capturing console messages for tab ${tabId}:`,
        error,
      );
      throw error;
    }
  }
}

export const consoleTool = new ConsoleTool();
