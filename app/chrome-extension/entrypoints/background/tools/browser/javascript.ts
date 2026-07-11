/**
 * JavaScript Tool - CDP Runtime.evaluate
 *
 * Execute JavaScript in the browser tab and return the result.
 * - CDP Runtime.evaluate retains the raw result as a remote object.
 * - Runtime.callFunctionOn sanitizes and serializes it under strict budgets.
 *
 * Features:
 * - Async code support (top-level await via async wrapper)
 * - Output sanitization (sensitive data redaction)
 * - Output truncation (configurable max bytes)
 * - Timeout handling
 * - Detailed error classification
 */

import { createErrorResponse, ToolResult } from "@/common/tool-handler";
import { BaseBrowserToolExecutor } from "../base-browser";
import { JAVASCRIPT_TOOL_LIMITS, TOOL_NAMES } from "webpage-mcp-shared";
import { cdpSessionManager } from "@/utils/cdp-session-manager";
import { sanitizeText } from "@/utils/output-sanitizer";
import {
  PageSerializationEnvelope,
  serializeJavaScriptEvaluation,
} from "./javascript-page-serializer";

// ============================================================================
// Constants
// ============================================================================

const CDP_SESSION_KEY = "javascript";
const MAX_ERROR_MESSAGE_CHARS = 10_000;
const PAGE_SERIALIZER_FUNCTION_DECLARATION =
  serializeJavaScriptEvaluation.toString();
let objectGroupSequence = 0;

// ============================================================================
// Types
// ============================================================================

type ExecutionEngine = "cdp";

type ErrorKind =
  | "debugger_conflict"
  | "timeout"
  | "syntax_error"
  | "runtime_error"
  | "cdp_error";

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
    this.name = "TimeoutError";
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function hasDisallowedPublicPageScheme(url: string): boolean {
  const match = url.trim().match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
  if (!match) {
    return false;
  }

  const protocol = match[1]?.toLowerCase();
  return protocol !== "http" && protocol !== "https";
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
  return error instanceof Error && error.name === "TimeoutError";
}

function isDebuggerConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Debugger is already attached|Another debugger is already attached|Cannot attach to this target/i.test(
    message,
  );
}

function normalizeBoundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  parameterName: string,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `Parameter [${parameterName}] must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function exceedsUtf8ByteLimit(value: string, maximumBytes: number): boolean {
  // UTF-8 cannot be shorter than the corresponding UTF-16 code-unit count.
  if (value.length > maximumBytes) return true;
  return new TextEncoder().encode(value).byteLength > maximumBytes;
}

function sanitizeBoundedErrorText(value: unknown): string {
  let raw: string;
  try {
    raw = value instanceof Error ? value.message : String(value);
  } catch {
    raw = "JavaScript execution failed";
  }
  const clipped =
    raw.length > MAX_ERROR_MESSAGE_CHARS
      ? `${raw.slice(0, MAX_ERROR_MESSAGE_CHARS)}... [error truncated]`
      : raw;
  return sanitizeText(clipped).text;
}

function nextObjectGroup(tabId: number): string {
  objectGroupSequence = (objectGroupSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `webpage-mcp-javascript-${tabId}-${Date.now().toString(36)}-${objectGroupSequence.toString(36)}`;
}

/**
 * Wrap user code in an async IIFE to support top-level await and return statements.
 */
function wrapUserCode(code: string): string {
  // The outer object is always retained by reference. Successful values and
  // thrown values therefore never cross CDP until the bounded serializer has
  // processed them in the page execution context.
  return `(async () => {
    try {
      return {
        __webpageMcpStatus: 1,
        __webpageMcpValue: await (async () => {
${code}
        })()
      };
    } catch (__webpageMcpCaughtError) {
      return {
        __webpageMcpStatus: 0,
        __webpageMcpValue: __webpageMcpCaughtError
      };
    }
  })()`;
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
  objectId?: string;
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

function parseExceptionDetails(details: CDPExceptionDetails): ExecutionError {
  const exceptionClassName = details.exception?.className ?? "";
  const exceptionDescription = details.exception?.description ?? "";
  const exceptionValue = details.exception?.value ?? "";
  const text = details.text ?? "";

  // Determine the raw error message
  const rawMessage =
    exceptionDescription ||
    exceptionValue ||
    text ||
    "JavaScript execution failed";

  // Sanitize the message
  const message = sanitizeBoundedErrorText(rawMessage);

  // Classify the error kind
  const isSyntaxError =
    exceptionClassName === "SyntaxError" || /SyntaxError/i.test(rawMessage);

  return {
    kind: isSyntaxError ? "syntax_error" : "runtime_error",
    message,
    details: {
      url: details.url,
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
    },
  };
}

function parseSerializerException(
  details: CDPExceptionDetails,
): ExecutionError {
  const rawMessage =
    details.exception?.description ||
    details.exception?.value ||
    details.text ||
    "Bounded page serialization failed";
  return {
    kind: "cdp_error",
    message: sanitizeBoundedErrorText(rawMessage),
  };
}

function isPageSerializationEnvelope(
  value: unknown,
): value is PageSerializationEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PageSerializationEnvelope>;
  if (candidate.version !== 1) return false;
  if (candidate.status === "success") {
    return (
      typeof candidate.text === "string" &&
      typeof candidate.truncated === "boolean" &&
      typeof candidate.redacted === "boolean"
    );
  }
  return (
    candidate.status === "error" &&
    (candidate.errorKind === "syntax_error" ||
      candidate.errorKind === "runtime_error" ||
      candidate.errorKind === "serialization_error") &&
    typeof candidate.message === "string"
  );
}

function isWithinUtf8ByteLimit(value: string, maximumBytes: number): boolean {
  if (value.length > maximumBytes) return false;
  return new TextEncoder().encode(value).byteLength <= maximumBytes;
}

async function executeViaCdp(
  tabId: number,
  code: string,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  try {
    const expression = wrapUserCode(code);
    const objectGroup = nextObjectGroup(tabId);

    return await withTimeout(
      cdpSessionManager.withSession(tabId, CDP_SESSION_KEY, async () => {
        try {
          const response = (await cdpSessionManager.sendCommand(
            tabId,
            "Runtime.evaluate",
            {
              expression,
              objectGroup,
              // Never clone the holder or its potentially enormous value into
              // the extension process.
              returnByValue: false,
              generatePreview: false,
              awaitPromise: true,
              timeout: options.timeoutMs,
            },
          )) as CDPEvaluateResult;

          if (response?.exceptionDetails) {
            return {
              ok: false,
              engine: "cdp",
              error: parseExceptionDetails(response.exceptionDetails),
            };
          }

          const objectId = response?.result?.objectId;
          if (!objectId) {
            return {
              ok: false,
              engine: "cdp",
              error: {
                kind: "cdp_error",
                message: "CDP did not retain the JavaScript result holder",
              },
            };
          }

          const serializedResponse = (await cdpSessionManager.sendCommand(
            tabId,
            "Runtime.callFunctionOn",
            {
              objectId,
              functionDeclaration: PAGE_SERIALIZER_FUNCTION_DECLARATION,
              arguments: [{ value: options.maxOutputBytes }],
              returnByValue: true,
              generatePreview: false,
              awaitPromise: false,
              timeout: options.timeoutMs,
            },
          )) as CDPEvaluateResult;

          if (serializedResponse?.exceptionDetails) {
            return {
              ok: false,
              engine: "cdp",
              error: parseSerializerException(
                serializedResponse.exceptionDetails,
              ),
            };
          }

          const envelope = serializedResponse?.result?.value;
          if (!isPageSerializationEnvelope(envelope)) {
            return {
              ok: false,
              engine: "cdp",
              error: {
                kind: "cdp_error",
                message: "Bounded page serializer returned an invalid response",
              },
            };
          }

          if (envelope.status === "error") {
            return {
              ok: false,
              engine: "cdp",
              error: {
                kind:
                  envelope.errorKind === "serialization_error"
                    ? "cdp_error"
                    : envelope.errorKind,
                message: sanitizeBoundedErrorText(envelope.message),
              },
            };
          }

          if (!isWithinUtf8ByteLimit(envelope.text, options.maxOutputBytes)) {
            return {
              ok: false,
              engine: "cdp",
              error: {
                kind: "cdp_error",
                message:
                  "Bounded page serializer exceeded the requested output limit",
              },
            };
          }

          return {
            ok: true,
            engine: "cdp",
            output: envelope.text,
            truncated: envelope.truncated,
            redacted: envelope.redacted,
          };
        } finally {
          // Release the holder even after page exceptions, serializer errors,
          // timeouts, or malformed responses. Object groups also cover any
          // temporary remote objects created by Runtime.evaluate.
          await cdpSessionManager
            .sendCommand(tabId, "Runtime.releaseObjectGroup", { objectGroup })
            .catch(() => undefined);
        }
      }),
      // The outer timeout is slightly longer, giving CDP a little margin to handle the timeout response.
      options.timeoutMs + 1000,
    );
  } catch (error) {
    if (isTimeoutError(error)) {
      return {
        ok: false,
        engine: "cdp",
        error: { kind: "timeout", message: error.message },
      };
    }

    if (isDebuggerConflictError(error)) {
      const message = sanitizeBoundedErrorText(error);
      return {
        ok: false,
        engine: "cdp",
        error: { kind: "debugger_conflict", message },
      };
    }

    const message = sanitizeBoundedErrorText(error);
    return {
      ok: false,
      engine: "cdp",
      error: { kind: "cdp_error", message },
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
      const rawCode = typeof args?.code === "string" ? args.code : "";
      if (
        exceedsUtf8ByteLimit(rawCode, JAVASCRIPT_TOOL_LIMITS.MAX_CODE_BYTES)
      ) {
        return createErrorResponse(
          `Parameter [code] exceeds the ${JAVASCRIPT_TOOL_LIMITS.MAX_CODE_BYTES}-byte UTF-8 limit`,
        );
      }
      const code = rawCode.trim();
      if (!code) {
        return createErrorResponse("Parameter [code] is required");
      }

      let options: ExecutionOptions;
      try {
        options = {
          timeoutMs: normalizeBoundedInteger(
            args.timeoutMs,
            JAVASCRIPT_TOOL_LIMITS.DEFAULT_TIMEOUT_MS,
            JAVASCRIPT_TOOL_LIMITS.MIN_TIMEOUT_MS,
            JAVASCRIPT_TOOL_LIMITS.MAX_TIMEOUT_MS,
            "timeoutMs",
          ),
          maxOutputBytes: normalizeBoundedInteger(
            args.maxOutputBytes,
            JAVASCRIPT_TOOL_LIMITS.DEFAULT_MAX_OUTPUT_BYTES,
            JAVASCRIPT_TOOL_LIMITS.MIN_OUTPUT_BYTES,
            JAVASCRIPT_TOOL_LIMITS.MAX_OUTPUT_BYTES,
            "maxOutputBytes",
          ),
        };
      } catch (error) {
        return createErrorResponse(sanitizeBoundedErrorText(error));
      }

      // Resolve target tab
      const tab = await this.resolveTargetTab(args.tabId);
      if (!tab) {
        return createErrorResponse(
          typeof args.tabId === "number"
            ? `Tab not found: ${args.tabId}`
            : "No active tab found",
        );
      }

      if (!tab.id) {
        return createErrorResponse("Tab has no ID");
      }
      if (hasDisallowedPublicPageScheme(String(tab.url || ""))) {
        return createErrorResponse(
          "Only http:// and https:// pages are supported by chrome_javascript",
        );
      }
      const tabId = tab.id;

      const warnings: string[] = [];

      // Try CDP execution first
      const cdpResult = await executeViaCdp(tabId, code, options);

      if (cdpResult.ok) {
        return this.buildSuccessResponse(tabId, cdpResult, startTime);
      }

      // If not a debugger conflict, return the CDP error
      if (cdpResult.error.kind !== "debugger_conflict") {
        return this.buildErrorResponse(tabId, cdpResult, startTime);
      }

      warnings.push(
        "JavaScript was not executed because DevTools or another extension owns the debugger session. Close that debugger and retry.",
      );
      return this.buildErrorResponse(tabId, cdpResult, startTime, warnings);
    } catch (error) {
      console.error("JavaScriptTool.execute error:", error);
      return createErrorResponse(
        `JavaScript tool error: ${sanitizeBoundedErrorText(error)}`,
      );
    }
  }

  private async resolveTargetTab(
    tabId?: number,
  ): Promise<chrome.tabs.Tab | null> {
    if (typeof tabId === "number") {
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
      content: [{ type: "text", text: JSON.stringify(payload) }],
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
      content: [{ type: "text", text: JSON.stringify(payload) }],
      isError: true,
    };
  }
}

export const javascriptTool = new JavaScriptTool();
