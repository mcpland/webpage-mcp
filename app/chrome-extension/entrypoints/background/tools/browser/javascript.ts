/**
 * JavaScript Tool - CDP Runtime.evaluate with fallback
 *
 * Execute JavaScript in the browser tab and return the result.
 * - Primary: CDP Runtime.evaluate (supports awaitPromise + returnByValue)
 * - Fallback: chrome.scripting.executeScript (when debugger is busy)
 *
 * Features:
 * - Async code support (top-level await via async wrapper)
 * - Output sanitization (sensitive data redaction)
 * - Output truncation (configurable max bytes)
 * - Timeout handling
 * - Detailed error classification
 */

import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  sanitizeAndLimitOutput,
  sanitizeText,
} from '@/utils/output-sanitizer';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT_MS = 15_000;
const CDP_SESSION_KEY = 'javascript';

// ============================================================================
// Types
// ============================================================================

type ExecutionEngine = 'cdp' | 'scripting';

type ErrorKind =
  | 'debugger_conflict'
  | 'timeout'
  | 'syntax_error'
  | 'runtime_error'
  | 'cdp_error'
  | 'scripting_error';

interface JavaScriptToolParams {
  code: string;
  tabId?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface ExecutionError {
  kind: ErrorKind;
  message: string;
  details?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

interface ExecutionMetrics {
  elapsedMs: number;
}

interface JavaScriptToolResult {
  success: boolean;
  tabId: number;
  engine: ExecutionEngine;
  result?: string;
  truncated?: boolean;
  redacted?: boolean;
  warnings?: string[];
  error?: ExecutionError;
  metrics?: ExecutionMetrics;
}

interface ExecutionOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

// Discriminated union for execution results
type ExecutionSuccess = {
  ok: true;
  engine: ExecutionEngine;
  output: string;
  truncated: boolean;
  redacted: boolean;
};

type ExecutionFailure = {
  ok: false;
  engine: ExecutionEngine;
  error: ExecutionError;
};

type ExecutionResult = ExecutionSuccess | ExecutionFailure;

// ============================================================================
// Timeout Error
// ============================================================================

class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Execution timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);

    promise
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
}

function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof Error && error.name === 'TimeoutError';
}

function isDebuggerConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Debugger is already attached|Another debugger is already attached|Cannot attach to this target/i.test(
    message,
  );
}

/**
 * Wrap user code in an async IIFE to support top-level await and return statements.
 */
function wrapUserCode(code: string): string {
  return `(async () => {\n${code}\n})()`;
}

// ============================================================================
// CDP Execution
// ============================================================================

interface CDPRemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

interface CDPExceptionDetails {
  text?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  exception?: {
    className?: string;
    description?: string;
    value?: string;
  };
}

interface CDPEvaluateResult {
  result?: CDPRemoteObject;
  exceptionDetails?: CDPExceptionDetails;
}

function extractReturnValue(remoteObject?: CDPRemoteObject): unknown {
  if (!remoteObject) return undefined;

  if ('value' in remoteObject) return remoteObject.value;
  if ('unserializableValue' in remoteObject) return remoteObject.unserializableValue;
  if (typeof remoteObject.description === 'string') return remoteObject.description;

  return undefined;
}

function parseExceptionDetails(details: CDPExceptionDetails): ExecutionError {
  const exceptionClassName = details.exception?.className ?? '';
  const exceptionDescription = details.exception?.description ?? '';
  const exceptionValue = details.exception?.value ?? '';
  const text = details.text ?? '';

  // Determine the raw error message
  const rawMessage =
    exceptionDescription || exceptionValue || text || 'JavaScript execution failed';

  // Sanitize the message
  const message = sanitizeText(rawMessage).text;

  // Classify the error kind
  const isSyntaxError = exceptionClassName === 'SyntaxError' || /SyntaxError/i.test(rawMessage);

  return {
    kind: isSyntaxError ? 'syntax_error' : 'runtime_error',
    message,
    details: {
      url: details.url,
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
    },
  };
}

async function executeViaCdp(
  tabId: number,
  code: string,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  try {
    const expression = wrapUserCode(code);

    const response = await withTimeout(
      cdpSessionManager.withSession(tabId, CDP_SESSION_KEY, async () => {
        return (await cdpSessionManager.sendCommand(tabId, 'Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
          // CDP Built-in timeout (milliseconds), double guarantee with outer withTimeout
          timeout: options.timeoutMs,
        })) as CDPEvaluateResult;
      }),
      // The outer timeout is slightly longer, giving CDP a little margin to handle the timeout response.
      options.timeoutMs + 1000,
    );

    // Check for exception
    if (response?.exceptionDetails) {
      return {
        ok: false,
        engine: 'cdp',
        error: parseExceptionDetails(response.exceptionDetails),
      };
    }

    // Extract and sanitize the result
    const value = extractReturnValue(response?.result);
    const sanitized = sanitizeAndLimitOutput(value, { maxBytes: options.maxOutputBytes });

    return {
      ok: true,
      engine: 'cdp',
      output: sanitized.text,
      truncated: sanitized.truncated,
      redacted: sanitized.redacted,
    };
  } catch (error) {
    if (isTimeoutError(error)) {
      return {
        ok: false,
        engine: 'cdp',
        error: { kind: 'timeout', message: error.message },
      };
    }

    if (isDebuggerConflictError(error)) {
      const message = sanitizeText(error instanceof Error ? error.message : String(error)).text;
      return {
        ok: false,
        engine: 'cdp',
        error: { kind: 'debugger_conflict', message },
      };
    }

    const message = sanitizeText(error instanceof Error ? error.message : String(error)).text;
    return {
      ok: false,
      engine: 'cdp',
      error: { kind: 'cdp_error', message },
    };
  }
}

// ============================================================================
// chrome.scripting.executeScript Fallback
// ============================================================================

interface ScriptingExecutionResult {
  ok: boolean;
  value?: unknown;
  error?: {
    name?: string;
    message?: string;
    stack?: string;
  };
}

async function executeViaScripting(
  tabId: number,
  code: string,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  const innerExecute = async (): Promise<ExecutionResult> => {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: async (userCode: string): Promise<ScriptingExecutionResult> => {
        try {
          // Use AsyncFunction constructor to support top-level await

          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const fn = new AsyncFunction(userCode);
          const value = await fn();
          return { ok: true, value };
        } catch (err: unknown) {
          const error = err as Error;
          return {
            ok: false,
            error: {
              name: error?.name ?? undefined,
              message: error?.message ?? String(err),
              stack: error?.stack ?? undefined,
            },
          };
        }
      },
      args: [code],
    });

    // Extract the first result
    const firstFrame = results?.[0];
    const result = (firstFrame as { result?: ScriptingExecutionResult })?.result;

    if (!result || typeof result !== 'object') {
      return {
        ok: false,
        engine: 'scripting',
        error: { kind: 'scripting_error', message: 'No result returned from executeScript' },
      };
    }

    if (!result.ok) {
      const rawMessage = result.error?.message ?? 'JavaScript execution failed';
      const rawStack = result.error?.stack;

      const message = sanitizeText(rawMessage).text;
      const sanitizedStack = rawStack ? sanitizeText(rawStack).text : undefined;

      const isSyntaxError = result.error?.name === 'SyntaxError' || /SyntaxError/i.test(rawMessage);

      return {
        ok: false,
        engine: 'scripting',
        error: {
          kind: isSyntaxError ? 'syntax_error' : 'runtime_error',
          message: sanitizedStack ? `${message}\n${sanitizedStack}` : message,
        },
      };
    }

    // Sanitize the successful result
    const sanitized = sanitizeAndLimitOutput(result.value, { maxBytes: options.maxOutputBytes });

    return {
      ok: true,
      engine: 'scripting',
      output: sanitized.text,
      truncated: sanitized.truncated,
      redacted: sanitized.redacted,
    };
  };

  try {
    return await withTimeout(innerExecute(), options.timeoutMs);
  } catch (error) {
    if (isTimeoutError(error)) {
      return {
        ok: false,
        engine: 'scripting',
        error: { kind: 'timeout', message: error.message },
      };
    }

    const message = sanitizeText(error instanceof Error ? error.message : String(error)).text;
    return {
      ok: false,
      engine: 'scripting',
      error: { kind: 'scripting_error', message },
    };
  }
}

// ============================================================================
// Tool Implementation
// ============================================================================

class JavaScriptTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.JAVASCRIPT;

  async execute(args: JavaScriptToolParams): Promise<ToolResult> {
    const startTime = performance.now();

    try {
      // Validate required parameter
      const code = typeof args?.code === 'string' ? args.code.trim() : '';
      if (!code) {
        return createErrorResponse('Parameter [code] is required');
      }

      // Resolve target tab
      const tab = await this.resolveTargetTab(args.tabId);
      if (!tab) {
        return createErrorResponse(
          typeof args.tabId === 'number' ? `Tab not found: ${args.tabId}` : 'No active tab found',
        );
      }

      if (!tab.id) {
        return createErrorResponse('Tab has no ID');
      }
      const tabId = tab.id;

      // Normalize options
      const options: ExecutionOptions = {
        timeoutMs: normalizePositiveInt(args.timeoutMs, DEFAULT_TIMEOUT_MS),
        maxOutputBytes: normalizePositiveInt(args.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
      };

      const warnings: string[] = [];

      // Try CDP execution first
      const cdpResult = await executeViaCdp(tabId, code, options);

      if (cdpResult.ok) {
        return this.buildSuccessResponse(tabId, cdpResult, startTime);
      }

      // If not a debugger conflict, return the CDP error
      if (cdpResult.error.kind !== 'debugger_conflict') {
        return this.buildErrorResponse(tabId, cdpResult, startTime);
      }

      // Debugger conflict - fallback to scripting API
      warnings.push(
        'Debugger is busy (DevTools or another extension attached). Falling back to chrome.scripting.executeScript (runs in ISOLATED world, not page context).',
      );

      const scriptingResult = await executeViaScripting(tabId, code, options);

      if (scriptingResult.ok) {
        return this.buildSuccessResponse(tabId, scriptingResult, startTime, warnings);
      }

      return this.buildErrorResponse(tabId, scriptingResult, startTime, warnings);
    } catch (error) {
      console.error('JavaScriptTool.execute error:', error);
      return createErrorResponse(
        `JavaScript tool error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async resolveTargetTab(tabId?: number): Promise<chrome.tabs.Tab | null> {
    if (typeof tabId === 'number') {
      return this.tryGetTab(tabId);
    }
    try {
      return await this.getActiveTabOrThrow();
    } catch {
      return null;
    }
  }

  private buildSuccessResponse(
    tabId: number,
    result: ExecutionSuccess,
    startTime: number,
    warnings?: string[],
  ): ToolResult {
    const payload: JavaScriptToolResult = {
      success: true,
      tabId,
      engine: result.engine,
      result: result.output,
      truncated: result.truncated || undefined,
      redacted: result.redacted || undefined,
      warnings: warnings?.length ? warnings : undefined,
      metrics: { elapsedMs: Math.round(performance.now() - startTime) },
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: false,
    };
  }

  private buildErrorResponse(
    tabId: number,
    result: ExecutionFailure,
    startTime: number,
    warnings?: string[],
  ): ToolResult {
    const payload: JavaScriptToolResult = {
      success: false,
      tabId,
      engine: result.engine,
      error: result.error,
      warnings: warnings?.length ? warnings : undefined,
      metrics: { elapsedMs: Math.round(performance.now() - startTime) },
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: true,
    };
  }
}

export const javascriptTool = new JavaScriptTool();
