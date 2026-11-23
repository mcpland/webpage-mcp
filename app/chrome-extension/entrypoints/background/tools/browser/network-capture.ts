import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { networkCaptureStartTool, networkCaptureStopTool } from './network-capture-web-request';
import { networkDebuggerStartTool, networkDebuggerStopTool } from './network-capture-debugger';
import {
  NETWORK_CAPTURE_LIMITS,
  normalizeCaptureTimings,
  utf8ByteLength,
} from './network-capture-limits';

type NetworkCaptureBackend = 'webRequest' | 'debugger';

interface NetworkCaptureToolParams {
  action: 'start' | 'stop';
  needResponseBody?: boolean;
  url?: string;
  maxCaptureTime?: number;
  inactivityTimeout?: number;
  includeStatic?: boolean;
  tabId?: number;
  windowId?: number;
  background?: boolean;
  all?: boolean;
  durationMs?: number;
}

interface NetworkCaptureExecutionContext {
  signal?: AbortSignal;
}

const ONE_SHOT_MIN_DURATION_MS = 100;
/** Keeps the capture's own time limit from racing the one-shot's explicit stop. */
const ONE_SHOT_STOP_MARGIN_MS = 5_000;
const ONE_SHOT_POLL_MS = 200;

const NETWORK_CAPTURE_PUBLIC_PAGE_ERROR =
  'Only http:// and https:// pages are supported by chrome_network_capture';

function hasDisallowedPublicPageScheme(url: string): boolean {
  const match = url.trim().match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
  if (!match) {
    return false;
  }

  const protocol = match[1]?.toLowerCase();
  return protocol !== 'http' && protocol !== 'https';
}

function normalizePublicCaptureUrl(rawUrl: unknown): string | undefined | Error {
  if (rawUrl === undefined || rawUrl === null) return undefined;
  if (typeof rawUrl !== 'string') return new Error(NETWORK_CAPTURE_PUBLIC_PAGE_ERROR);
  const trimmed = rawUrl.trim();
  if (!trimmed) return new Error(NETWORK_CAPTURE_PUBLIC_PAGE_ERROR);
  if (utf8ByteLength(trimmed) > NETWORK_CAPTURE_LIMITS.maxUrlBytes) {
    return new Error('Network capture URL is too long.');
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return new Error(NETWORK_CAPTURE_PUBLIC_PAGE_ERROR);
    }
  } catch {
    return new Error(NETWORK_CAPTURE_PUBLIC_PAGE_ERROR);
  }
  return trimmed;
}

/**
 * Extract text content from ToolResult
 */
function getFirstText(result: ToolResult): string | undefined {
  const first = result.content?.[0];
  return first && first.type === 'text' ? first.text : undefined;
}

/**
 * Decorate JSON result with additional fields
 */
function decorateJsonResult(result: ToolResult, extra: Record<string, unknown>): ToolResult {
  const text = getFirstText(result);
  if (typeof text !== 'string') return result;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        ...result,
        content: [{ type: 'text', text: JSON.stringify({ ...parsed, ...extra }) }],
      };
    }
  } catch {
    // If the underlying tool didn't return JSON, keep it as-is
  }
  return result;
}

function sanitizePublicCaptureResult(result: ToolResult): ToolResult {
  const text = getFirstText(result);
  if (typeof text !== 'string') return result;

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return result;
    }

    const pageUrl =
      typeof parsed.tabUrl === 'string'
        ? parsed.tabUrl
        : typeof parsed.url === 'string'
          ? parsed.url
          : undefined;
    if (!pageUrl || !hasDisallowedPublicPageScheme(pageUrl)) {
      return result;
    }

    const requestCount =
      typeof parsed.requestCount === 'number' && Number.isFinite(parsed.requestCount)
        ? parsed.requestCount
        : 0;

    return {
      ...result,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...parsed,
            redacted: true,
            message:
              requestCount > 0
                ? `Capture stopped on a non-public page. ${requestCount} requests were captured, but detailed results were redacted.`
                : 'Capture stopped on a non-public page. Detailed results were redacted.',
            url: typeof parsed.url === 'string' ? null : parsed.url,
            tabUrl: typeof parsed.tabUrl === 'string' ? null : parsed.tabUrl,
            tabTitle: typeof parsed.tabTitle === 'string' ? null : parsed.tabTitle,
            requests: Array.isArray(parsed.requests) ? [] : parsed.requests,
            commonRequestHeaders:
              parsed.commonRequestHeaders &&
              typeof parsed.commonRequestHeaders === 'object' &&
              !Array.isArray(parsed.commonRequestHeaders)
                ? {}
                : parsed.commonRequestHeaders,
            commonResponseHeaders:
              parsed.commonResponseHeaders &&
              typeof parsed.commonResponseHeaders === 'object' &&
              !Array.isArray(parsed.commonResponseHeaders)
                ? {}
                : parsed.commonResponseHeaders,
          }),
        },
      ],
    };
  } catch {
    return result;
  }
}

/**
 * Check if debugger-based capture is active
 */
function isDebuggerCaptureActive(): boolean {
  if (typeof (networkDebuggerStartTool as any).hasAvailableCapture === 'function') {
    return (networkDebuggerStartTool as any).hasAvailableCapture();
  }
  const captureData = (
    networkDebuggerStartTool as unknown as { captureData?: Map<number, unknown> }
  ).captureData;
  return captureData instanceof Map && captureData.size > 0;
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (typeof text !== 'string') return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the capture started on this tab is still recording (not stopped or auto-stopped). */
function isTabCaptureRecording(tabId: number, backend: NetworkCaptureBackend): boolean {
  const owner = backend === 'debugger' ? networkDebuggerStartTool : networkCaptureStartTool;
  const captureData = (owner as unknown as { captureData?: Map<number, unknown> }).captureData;
  return captureData instanceof Map && captureData.has(tabId);
}

/**
 * Resolve after durationMs, or earlier when the capture ends on its own
 * (maxCaptureTime, inactivityTimeout, tab closed) or the tool call is aborted.
 */
function waitForOneShotCapture(
  tabId: number,
  backend: NetworkCaptureBackend,
  durationMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + durationMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const tick = (): void => {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !isTabCaptureRecording(tabId, backend)) {
        finish();
        return;
      }
      timer = setTimeout(tick, Math.min(ONE_SHOT_POLL_MS, remaining));
    };
    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener('abort', finish, { once: true });
    timer = setTimeout(tick, Math.min(ONE_SHOT_POLL_MS, durationMs));
  });
}

/**
 * Check if webRequest-based capture is active
 */
function isWebRequestCaptureActive(): boolean {
  return typeof (networkCaptureStartTool as any).hasAvailableCapture === 'function'
    ? (networkCaptureStartTool as any).hasAvailableCapture()
    : networkCaptureStartTool.captureData.size > 0;
}

/**
 * Unified Network Capture Tool
 *
 * Provides a single entry point for network capture, automatically selecting
 * the appropriate backend based on the `needResponseBody` parameter:
 * - needResponseBody=false (default): uses webRequest API (lightweight, no debugger conflict)
 * - needResponseBody=true: uses Debugger API (captures response body, may conflict with DevTools)
 */
class NetworkCaptureTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.NETWORK_CAPTURE;

  async execute(
    args: NetworkCaptureToolParams,
    context?: NetworkCaptureExecutionContext,
  ): Promise<ToolResult> {
    const action = args?.action;
    if (action !== 'start' && action !== 'stop') {
      return createErrorResponse('Parameter [action] is required and must be one of: start, stop');
    }
    if (args.durationMs !== undefined && action !== 'start') {
      return createErrorResponse('durationMs is only supported with action="start".');
    }

    const wantBody = args?.needResponseBody === true;
    const debuggerActive = isDebuggerCaptureActive();
    const webActive = isWebRequestCaptureActive();

    if (action === 'start') {
      if (args.durationMs !== undefined) {
        return this.handleOneShot(args, wantBody, debuggerActive, webActive, context?.signal);
      }
      return this.handleStart(args, wantBody, debuggerActive, webActive);
    }

    return this.handleStop(args, debuggerActive, webActive);
  }

  /**
   * start -> wait -> stop in a single call, so capturing the traffic of a page
   * load (or of a page's own polling) takes one tool call instead of three.
   */
  private async handleOneShot(
    args: NetworkCaptureToolParams,
    wantBody: boolean,
    debuggerActive: boolean,
    webActive: boolean,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const durationMs = args.durationMs;
    if (
      typeof durationMs !== 'number' ||
      !Number.isFinite(durationMs) ||
      durationMs < ONE_SHOT_MIN_DURATION_MS ||
      durationMs > NETWORK_CAPTURE_LIMITS.maxCaptureTimeMs
    ) {
      return createErrorResponse(
        `durationMs must be a number between ${ONE_SHOT_MIN_DURATION_MS} and ${NETWORK_CAPTURE_LIMITS.maxCaptureTimeMs}.`,
      );
    }

    const startResult = await this.handleStart(
      {
        ...args,
        maxCaptureTime: args.maxCaptureTime ?? durationMs + ONE_SHOT_STOP_MARGIN_MS,
      },
      wantBody,
      debuggerActive,
      webActive,
    );
    if (startResult.isError) return startResult;
    const tabId = parseJsonObject(getFirstText(startResult))?.tabId;
    if (typeof tabId !== 'number') return startResult;

    const backend: NetworkCaptureBackend = wantBody ? 'debugger' : 'webRequest';
    const startedAt = Date.now();
    // Even when the wait is cut short (abort), stop the capture so it is not left running.
    await waitForOneShotCapture(tabId, backend, Math.floor(durationMs), signal);
    const waitedMs = Date.now() - startedAt;

    const stopResult = await this.handleStop(
      { action: 'stop', tabId, needResponseBody: wantBody },
      isDebuggerCaptureActive(),
      isWebRequestCaptureActive(),
    );
    // Clean up any child tabs that inherited capture from this root tab so
    // subsequent start calls are not blocked by leaked background captures.
    const owner = backend === 'debugger' ? networkDebuggerStartTool : networkCaptureStartTool;
    const stopLineage = (
      owner as unknown as { stopLineageCaptures?: (rootTabId: number) => Promise<void> }
    ).stopLineageCaptures;
    if (typeof stopLineage === 'function') {
      await stopLineage.call(owner, tabId).catch(() => {});
    }
    return decorateJsonResult(stopResult, { oneShot: true, durationMs, waitedMs });
  }

  private async handleStart(
    args: NetworkCaptureToolParams,
    wantBody: boolean,
    debuggerActive: boolean,
    webActive: boolean,
  ): Promise<ToolResult> {
    // Prevent any capture conflict (cross-mode or same-mode)
    if (debuggerActive || webActive) {
      const activeMode = debuggerActive ? 'debugger' : 'webRequest';
      return createErrorResponse(
        `Network capture is already active in ${activeMode} mode. Stop it before starting a new capture.`,
      );
    }

    const normalizedUrl = normalizePublicCaptureUrl(args.url);
    if (normalizedUrl instanceof Error) {
      return createErrorResponse(normalizedUrl.message);
    }

    // With a url the capture runs on that (already validated) page, so the tab's
    // current page, such as a fresh browser's new-tab page, does not matter.
    if (!normalizedUrl) {
      const explicitTab = await this.tryGetTab(args.tabId);
      if (args.tabId !== undefined && !explicitTab) {
        return createErrorResponse(`Target tab ${args.tabId} is no longer available`);
      }
      const targetTab = explicitTab || (await this.getActiveTabInWindow(args.windowId));
      if (targetTab?.url && hasDisallowedPublicPageScheme(String(targetTab.url))) {
        return createErrorResponse(NETWORK_CAPTURE_PUBLIC_PAGE_ERROR);
      }
    }

    const delegate = wantBody ? networkDebuggerStartTool : networkCaptureStartTool;
    const backend: NetworkCaptureBackend = wantBody ? 'debugger' : 'webRequest';
    const timings = normalizeCaptureTimings(args);

    const result = await delegate.execute({
      url: normalizedUrl,
      maxCaptureTime: timings.maxCaptureTime,
      inactivityTimeout: timings.inactivityTimeout,
      includeStatic: args.includeStatic,
      tabId: args.tabId,
      windowId: args.windowId,
      background: args.background,
    });

    return sanitizePublicCaptureResult(
      decorateJsonResult(result, { backend, needResponseBody: wantBody }),
    );
  }

  private async handleStop(
    args: NetworkCaptureToolParams,
    debuggerActive: boolean,
    webActive: boolean,
  ): Promise<ToolResult> {
    // Determine which backend to stop
    let backendToStop: NetworkCaptureBackend | null = null;

    // If user explicitly specified needResponseBody, try to stop that specific backend
    if (args?.needResponseBody === true) {
      backendToStop = debuggerActive ? 'debugger' : null;
    } else if (args?.needResponseBody === false) {
      backendToStop = webActive ? 'webRequest' : null;
    }

    // If no explicit preference or the specified backend isn't active, auto-detect
    if (!backendToStop) {
      if (debuggerActive) {
        backendToStop = 'debugger';
      } else if (webActive) {
        backendToStop = 'webRequest';
      }
    }

    if (!backendToStop) {
      return createErrorResponse('No active network captures found in any tab.');
    }

    const delegateStop =
      backendToStop === 'debugger' ? networkDebuggerStopTool : networkCaptureStopTool;
    const result = await delegateStop.execute({
      tabId: args.tabId,
      windowId: args.windowId,
      all: args.all,
    });

    return sanitizePublicCaptureResult(
      decorateJsonResult(result, {
        backend: backendToStop,
        needResponseBody: backendToStop === 'debugger',
      }),
    );
  }
}

export const networkCaptureTool = new NetworkCaptureTool();
