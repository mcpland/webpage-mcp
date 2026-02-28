import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { networkCaptureStartTool, networkCaptureStopTool } from './network-capture-web-request';
import { networkDebuggerStartTool, networkDebuggerStopTool } from './network-capture-debugger';

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

/**
 * Check if debugger-based capture is active
 */
function isDebuggerCaptureActive(): boolean {
  const captureData = (
    networkDebuggerStartTool as unknown as { captureData?: Map<number, unknown> }
  ).captureData;
  return captureData instanceof Map && captureData.size > 0;
}

/**
 * Check if webRequest-based capture is active
 */
function isWebRequestCaptureActive(): boolean {
  return networkCaptureStartTool.captureData.size > 0;
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

    const delegate = wantBody ? networkDebuggerStartTool : networkCaptureStartTool;
    const backend: NetworkCaptureBackend = wantBody ? 'debugger' : 'webRequest';

    const result = await delegate.execute({
      url: args.url,
      maxCaptureTime: args.maxCaptureTime,
      inactivityTimeout: args.inactivityTimeout,
      includeStatic: args.includeStatic,
      tabId: args.tabId,
      windowId: args.windowId,
      background: args.background,
    });

    return decorateJsonResult(result, { backend, needResponseBody: wantBody });
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

    return decorateJsonResult(result, {
      backend: backendToStop,
      needResponseBody: backendToStop === 'debugger',
    });
  }
}

export const networkCaptureTool = new NetworkCaptureTool();
