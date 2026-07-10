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
}

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

  async execute(args: NetworkCaptureToolParams): Promise<ToolResult> {
    const action = args?.action;
    if (action !== 'start' && action !== 'stop') {
      return createErrorResponse('Parameter [action] is required and must be one of: start, stop');
    }

    const wantBody = args?.needResponseBody === true;
    const debuggerActive = isDebuggerCaptureActive();
    const webActive = isWebRequestCaptureActive();

    if (action === 'start') {
      return this.handleStart(args, wantBody, debuggerActive, webActive);
    }

    return this.handleStop(args, debuggerActive, webActive);
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

    if (typeof args.url === 'string' && hasDisallowedPublicPageScheme(args.url)) {
      return createErrorResponse(NETWORK_CAPTURE_PUBLIC_PAGE_ERROR);
    }
    if (
      typeof args.url === 'string' &&
      utf8ByteLength(args.url) > NETWORK_CAPTURE_LIMITS.maxUrlBytes
    ) {
      return createErrorResponse('Network capture URL is too long.');
    }

    const explicitTab = await this.tryGetTab(args.tabId);
    const targetTab = explicitTab || (await this.getActiveTabInWindow(args.windowId));
    if (targetTab?.url && hasDisallowedPublicPageScheme(String(targetTab.url))) {
      return createErrorResponse(NETWORK_CAPTURE_PUBLIC_PAGE_ERROR);
    }

    const delegate = wantBody ? networkDebuggerStartTool : networkCaptureStartTool;
    const backend: NetworkCaptureBackend = wantBody ? 'debugger' : 'webRequest';
    const timings = normalizeCaptureTimings(args);

    const result = await delegate.execute({
      url: args.url,
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
