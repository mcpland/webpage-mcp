import { createErrorResponse } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import { readMcpBackgroundModeDefault } from '@/common/mcp-background-mode';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import * as browserTools from './browser';
import {
  flowRunTool,
  listPublishedFlowsTool,
  runCancelTool,
  workflowPublishTool,
  workflowUnpublishTool,
} from './record-replay';
import {
  flowAnalyzeTool,
  flowUpdateTool,
  workflowApprovalStoreTool,
  workflowDescribeTool,
  workflowDebugViewTool,
  workflowMigrateTool,
  workflowReleaseReadinessTool,
  workflowRepairRollbackTool,
  workflowRepairTool,
  workflowStabilizeTool,
} from './flow-tools';
import { recordingStartTool, recordingStatusTool, recordingStopTool } from './recording';
import { getSessionContext, patchSessionContext } from '../session-context';
import { runInTabQueue } from '../tab-queue';

const tools = {
  ...browserTools,
  flowRunTool,
  runCancelTool,
  listPublishedFlowsTool,
  workflowPublishTool,
  workflowUnpublishTool,
  flowAnalyzeTool,
  flowUpdateTool,
  workflowApprovalStoreTool,
  workflowDescribeTool,
  workflowDebugViewTool,
  workflowMigrateTool,
  workflowReleaseReadinessTool,
  workflowRepairTool,
  workflowRepairRollbackTool,
  workflowStabilizeTool,
  recordingStartTool,
  recordingStopTool,
  recordingStatusTool,
} as any;
const toolsMap = new Map(Object.values(tools).map((tool: any) => [tool.name, tool]));
const NON_TAB_SCOPED_CHROME_TOOLS = new Set<string>([
  TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS,
  TOOL_NAMES.BROWSER.SEARCH_TABS_CONTENT,
  TOOL_NAMES.BROWSER.HISTORY,
  TOOL_NAMES.BROWSER.BOOKMARK_SEARCH,
  TOOL_NAMES.BROWSER.BOOKMARK_DELETE,
]);
const URL_PRIORITY_TOOLS = new Set<string>([
  TOOL_NAMES.BROWSER.WEB_FETCHER,
  TOOL_NAMES.BROWSER.INJECT_SCRIPT,
]);
// Only these executors intentionally create or select a different target than
// the one resolved before execution. Their own top-level result metadata may
// advance the session cursor; arbitrary tool payloads (including page/network
// data) must never be interpreted as routing metadata.
const TRUSTED_RESULT_TARGET_TOOLS = new Set<string>([
  TOOL_NAMES.BROWSER.NAVIGATE,
  TOOL_NAMES.RECORD_REPLAY.FLOW_RUN,
]);
// Tools whose `background` argument can be auto-populated from MCP Background Mode.
// Every entry here must declare a `background` parameter in its schema and honour it
// in the executor; otherwise the injected value is silently ignored.
const BACKGROUND_DEFAULT_SUPPORTED_TOOLS = new Set<string>([
  TOOL_NAMES.BROWSER.NAVIGATE,
  TOOL_NAMES.BROWSER.SCREENSHOT,
  TOOL_NAMES.BROWSER.SWITCH_TAB,
  TOOL_NAMES.BROWSER.WEB_FETCHER,
  TOOL_NAMES.BROWSER.NETWORK_CAPTURE,
  TOOL_NAMES.BROWSER.NETWORK_CAPTURE_START,
  TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_START,
  TOOL_NAMES.BROWSER.INJECT_SCRIPT,
  TOOL_NAMES.BROWSER.CONSOLE,
  TOOL_NAMES.BROWSER.COMPUTER,
  // Interaction tools that previously fell through and silently activated the
  // foreground tab; including them here lets background mode actually keep the
  // tab in the background end-to-end.
  TOOL_NAMES.BROWSER.READ_PAGE,
  TOOL_NAMES.BROWSER.CLICK,
  TOOL_NAMES.BROWSER.FILL,
  TOOL_NAMES.BROWSER.KEYBOARD,
  TOOL_NAMES.RECORD_REPLAY.FLOW_RUN,
]);
const MCP_CONTEXT_AWARE_TOOLS = new Set<string>([
  TOOL_NAMES.RECORD_REPLAY.WORKFLOW_DEBUG_VIEW,
  TOOL_NAMES.RECORD_REPLAY.WORKFLOW_STABILIZE,
]);

interface ResolvedExecutionTarget {
  tabId?: number;
  windowId?: number;
}

const getLazyTool = async (toolName: string) => {
  if (toolName === TOOL_NAMES.BROWSER.SEARCH_TABS_CONTENT) {
    const { vectorSearchTabsContentTool } = await import('./browser/vector-search');
    return vectorSearchTabsContentTool;
  }

  return null;
};

/**
 * Tool call parameter interface
 */
export interface ToolCallParam {
  name: string;
  args: any;
  signal?: AbortSignal;
  meta?: {
    mcpSessionId?: string;
    instanceId?: string;
    source?: 'mcp' | 'ui';
    clientCapabilities?:
      | string[]
      | {
          toolListChanged?: boolean;
          resourceReferences?: boolean;
          cancellation?: boolean;
          structuredErrors?: boolean;
          largeResults?: boolean;
          source?: string;
          warnings?: string[];
        };
  };
}

function createToolAbortError(): Error {
  const error = new Error('Tool execution cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfToolAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createToolAbortError();
}

function isTabScopedTool(toolName: string): boolean {
  if (NON_TAB_SCOPED_CHROME_TOOLS.has(toolName)) {
    return false;
  }
  return (
    toolName.startsWith('chrome_') ||
    toolName.startsWith('performance_') ||
    toolName === TOOL_NAMES.RECORD_REPLAY.FLOW_RUN ||
    toolName === TOOL_NAMES.RECORD_REPLAY.RECORDING_START
  );
}

function hasUrlNavigationTarget(args: any): boolean {
  return typeof args?.url === 'string' && args.url.trim().length > 0;
}

function isHistoryNavigation(args: any): boolean {
  return args?.url === 'back' || args?.url === 'forward';
}

function isExplicitNewWindowRequest(args: any): boolean {
  // Aligned with NavigateTool.normalizeOpenMode: width/height alone no longer
  // promote a navigate call to a new window.
  return args?.openMode === 'new_window' || args?.newWindow === true;
}

function isExplicitNewTabRequest(args: any): boolean {
  return args?.openMode === 'new_tab' || args?.newTab === true;
}

/**
 * Whether a chrome_navigate call should be treated as a new-tab open for
 * routing purposes. Mirrors NavigateTool.normalizeOpenMode: if the caller did
 * not opt into current_tab/new_window, the implicit default is new_tab.
 *
 * Must be kept in sync with normalizeOpenMode in browser/common.ts.
 */
function isImplicitOrExplicitNewTabRequest(args: any): boolean {
  if (isExplicitNewTabRequest(args)) return true;
  if (args?.openMode === 'current_tab') return false;
  if (isExplicitNewWindowRequest(args)) return false;
  return true;
}

function shouldPreferWindowScopedExecution(toolName: string, args: any): boolean {
  if (URL_PRIORITY_TOOLS.has(toolName) && hasUrlNavigationTarget(args)) {
    return true;
  }

  if (toolName !== TOOL_NAMES.BROWSER.NAVIGATE) {
    return false;
  }

  if (args?.refresh === true || isHistoryNavigation(args) || !hasUrlNavigationTarget(args)) {
    return false;
  }

  return isImplicitOrExplicitNewTabRequest(args) || isExplicitNewWindowRequest(args);
}

async function resolveExecutionTarget(
  toolName: string,
  args: any,
  sessionId?: string,
  instanceId?: string,
): Promise<ResolvedExecutionTarget> {
  const hasExplicitTabId = typeof args?.tabId === 'number';
  const hasExplicitWindowId = typeof args?.windowId === 'number';
  if (hasExplicitTabId || hasExplicitWindowId) {
    return {
      tabId: hasExplicitTabId ? args.tabId : undefined,
      windowId: hasExplicitWindowId ? args.windowId : undefined,
    };
  }

  const preferWindowScopedExecution = shouldPreferWindowScopedExecution(toolName, args);
  if (!isTabScopedTool(toolName)) return {};
  if (toolName === TOOL_NAMES.RECORD_REPLAY.FLOW_RUN && args?.tabTarget === 'new') {
    // Respect explicit new-tab execution requests for flow runs.
    return {};
  }

  if (sessionId) {
    const sessionCtx = getSessionContext(sessionId, instanceId);
    if (typeof sessionCtx?.tabId === 'number') {
      try {
        const tab = await chrome.tabs.get(sessionCtx.tabId);
        if (typeof tab?.id === 'number') {
          if (preferWindowScopedExecution) {
            return typeof tab.windowId === 'number' ? { windowId: tab.windowId } : {};
          }

          return {
            tabId: tab.id,
            windowId: typeof tab.windowId === 'number' ? tab.windowId : undefined,
          };
        }
      } catch {
        patchSessionContext(sessionId, { tabId: undefined }, instanceId);
      }
    }

    if (typeof sessionCtx?.windowId === 'number') {
      try {
        const targetWindow = await chrome.windows.get(sessionCtx.windowId, { populate: false });
        if (typeof targetWindow?.id === 'number') {
          if (preferWindowScopedExecution) {
            return { windowId: targetWindow.id };
          }

          const [windowActive] = await chrome.tabs.query({
            active: true,
            windowId: targetWindow.id,
          });
          if (typeof windowActive?.id === 'number') {
            return { tabId: windowActive.id, windowId: targetWindow.id };
          }
        }
      } catch {
        // Ignore window lookup failures and continue fallback resolution.
      }
    }
  }

  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!active) return {};
    if (preferWindowScopedExecution) {
      return typeof active.windowId === 'number' ? { windowId: active.windowId } : {};
    }
    if (typeof active?.id === 'number') {
      return {
        tabId: active.id,
        windowId: typeof active.windowId === 'number' ? active.windowId : undefined,
      };
    }
  } catch {
    // Ignore active-tab lookup failures; tools may handle missing target themselves.
  }
  return {};
}

function mergeArgsWithResolvedTarget(args: any, resolvedTarget: ResolvedExecutionTarget): any {
  const resolvedTabId = resolvedTarget.tabId;
  const resolvedWindowId = resolvedTarget.windowId;
  const hasResolvedTabId = typeof resolvedTabId === 'number';
  const hasResolvedWindowId = typeof resolvedWindowId === 'number';
  if (!hasResolvedTabId && !hasResolvedWindowId) return args;

  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const nextArgs = { ...args };
    if (!hasResolvedTabId || typeof nextArgs.tabId === 'number') {
      if (hasResolvedWindowId && typeof nextArgs.windowId !== 'number') {
        nextArgs.windowId = resolvedWindowId;
      }
      return nextArgs;
    }

    nextArgs.tabId = resolvedTabId;
    if (hasResolvedWindowId && typeof nextArgs.windowId !== 'number') {
      nextArgs.windowId = resolvedWindowId;
    }
    return nextArgs;
  }
  const nextArgs: Record<string, number> = {};
  if (hasResolvedTabId) nextArgs.tabId = resolvedTabId;
  if (hasResolvedWindowId) nextArgs.windowId = resolvedWindowId;
  return nextArgs;
}

function isPlainArgsObject(args: any): args is Record<string, unknown> {
  return args != null && typeof args === 'object' && !Array.isArray(args);
}

function supportsBackgroundDefaultForArgs(toolName: string, args: any): boolean {
  if (!BACKGROUND_DEFAULT_SUPPORTED_TOOLS.has(toolName)) {
    return false;
  }

  if (toolName !== TOOL_NAMES.BROWSER.SCREENSHOT || !isPlainArgsObject(args)) {
    return true;
  }

  const hasSelectorCapture = typeof args.selector === 'string' && args.selector.length > 0;
  return args.fullPage !== true && !hasSelectorCapture;
}

async function mergeArgsWithDefaultBackground(toolName: string, args: any): Promise<any> {
  if (!supportsBackgroundDefaultForArgs(toolName, args)) {
    return args;
  }

  // Fast path: caller already opted into background. No need to consult storage
  // and no override possible.
  if (isPlainArgsObject(args) && args.background === true) {
    return args;
  }

  const backgroundModeEnabled = await readMcpBackgroundModeDefault();
  if (!backgroundModeEnabled) {
    return args;
  }

  // MCP Background Mode is the user's session-level invariant. Force background:true
  // even when the caller (typically an LLM) explicitly passed false, otherwise the
  // model can — and in practice does — silently flip the user's preference by
  // following the schema's documented "Default: false".
  return isPlainArgsObject(args) ? { ...args, background: true } : { background: true };
}

function readTargetId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function extractSessionPatchFromResult(
  toolName: string,
  result: any,
): { tabId?: number; windowId?: number } {
  if (!TRUSTED_RESULT_TARGET_TOOLS.has(toolName)) {
    return {};
  }

  const candidates: Array<Record<string, unknown>> = [];
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    candidates.push(result as Record<string, unknown>);
  }
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const item of content) {
    if (item?.type !== 'text' || typeof item?.text !== 'string') continue;
    try {
      const parsed = JSON.parse(item.text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore non-JSON text content
    }
  }

  let tabId: number | undefined;
  let windowId: number | undefined;

  for (const candidate of candidates) {
    if (candidate.success === false) continue;
    if (typeof tabId !== 'number') {
      tabId = readTargetId(candidate.tabId);
    }
    if (typeof windowId !== 'number') {
      windowId = readTargetId(candidate.windowId);
    }
    if (typeof tabId === 'number' && typeof windowId === 'number') break;
  }

  return { tabId, windowId };
}

/**
 * Handle tool execution
 */
export const handleCallTool = async (param: ToolCallParam) => {
  throwIfToolAborted(param.signal);
  let tool = toolsMap.get(param.name);
  if (!tool) {
    tool = await getLazyTool(param.name);
  }
  throwIfToolAborted(param.signal);

  if (!tool) {
    return createErrorResponse(`Tool ${param.name} not found`);
  }

  const sessionId = param.meta?.mcpSessionId?.trim() || undefined;
  const instanceId = param.meta?.instanceId?.trim() || undefined;
  const resolvedTarget = await resolveExecutionTarget(param.name, param.args, sessionId, instanceId);
  throwIfToolAborted(param.signal);
  const targetMergedArgs = mergeArgsWithResolvedTarget(param.args, resolvedTarget);
  const shouldApplyMcpBackgroundDefault = param.meta?.source === 'mcp' || !!sessionId;
  const mergedArgs = shouldApplyMcpBackgroundDefault
    ? await mergeArgsWithDefaultBackground(param.name, targetMergedArgs)
    : targetMergedArgs;
  throwIfToolAborted(param.signal);

  try {
    const executionContext =
      param.signal ||
      (param.meta &&
        (param.meta.clientCapabilities !== undefined || MCP_CONTEXT_AWARE_TOOLS.has(param.name)))
        ? {
            ...(param.meta ? { meta: param.meta } : {}),
            ...(param.signal ? { signal: param.signal } : {}),
          }
        : undefined;
    const execute = async () => {
      throwIfToolAborted(param.signal);
      const result = executionContext
        ? await tool.execute(mergedArgs, executionContext)
        : await tool.execute(mergedArgs);
      throwIfToolAborted(param.signal);
      return result;
    };
    const result =
      typeof resolvedTarget.tabId === 'number'
        ? await runInTabQueue(resolvedTarget.tabId, execute)
        : await execute();

    throwIfToolAborted(param.signal);
    if (sessionId && result?.isError !== true) {
      const patch = extractSessionPatchFromResult(param.name, result);
      const tabIdToPersist =
        typeof patch.tabId === 'number'
          ? patch.tabId
          : typeof resolvedTarget.tabId === 'number'
            ? resolvedTarget.tabId
            : undefined;
      const windowIdToPersist =
        typeof patch.windowId === 'number'
          ? patch.windowId
          : typeof resolvedTarget.windowId === 'number'
            ? resolvedTarget.windowId
            : undefined;
      const update: { tabId?: number; windowId?: number } = {};
      if (typeof tabIdToPersist === 'number') update.tabId = tabIdToPersist;
      if (typeof windowIdToPersist === 'number') update.windowId = windowIdToPersist;
      if (Object.keys(update).length > 0) {
        patchSessionContext(sessionId, update, instanceId);
      }
    }

    return result;
  } catch (error) {
    if (
      param.signal &&
      (param.signal.aborted ||
        (error &&
          typeof error === 'object' &&
          'name' in error &&
          (error as { name?: unknown }).name === 'AbortError'))
    ) {
      throw error;
    }
    console.error(`Tool execution failed for ${param.name}:`, error);
    return createErrorResponse(
      error instanceof Error ? error.message : ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
    );
  }
};
