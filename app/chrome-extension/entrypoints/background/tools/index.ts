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
  workflowDescribeTool,
  workflowDebugViewTool,
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
  workflowDescribeTool,
  workflowDebugViewTool,
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
  TOOL_NAMES.RECORD_REPLAY.FLOW_RUN,
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
  return (
    args?.openMode === 'new_window' ||
    args?.newWindow === true ||
    typeof args?.width === 'number' ||
    typeof args?.height === 'number'
  );
}

function isExplicitNewTabRequest(args: any): boolean {
  return args?.openMode === 'new_tab' || args?.newTab === true;
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

  return isExplicitNewTabRequest(args) || isExplicitNewWindowRequest(args);
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

  if (isPlainArgsObject(args) && typeof args.background === 'boolean') {
    return args;
  }

  const backgroundModeEnabled = await readMcpBackgroundModeDefault();
  if (!backgroundModeEnabled) {
    return args;
  }

  return isPlainArgsObject(args) ? { ...args, background: true } : { background: true };
}

function findNumericField(
  value: unknown,
  key: 'tabId' | 'windowId',
  depth = 0,
  seen = new Set<unknown>(),
): number | undefined {
  if (depth > 6 || value == null || typeof value !== 'object' || seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  const obj = value as Record<string, unknown>;
  if (typeof obj[key] === 'number' && Number.isFinite(obj[key] as number)) {
    return obj[key] as number;
  }
  for (const nested of Object.values(obj)) {
    const found = findNumericField(nested, key, depth + 1, seen);
    if (typeof found === 'number') return found;
  }
  return undefined;
}

function extractSessionPatchFromResult(result: any): { tabId?: number; windowId?: number } {
  const candidates: unknown[] = [result];
  const content = Array.isArray(result?.content) ? result.content : [];
  for (const item of content) {
    if (item?.type !== 'text' || typeof item?.text !== 'string') continue;
    try {
      candidates.push(JSON.parse(item.text));
    } catch {
      // Ignore non-JSON text content
    }
  }

  let tabId: number | undefined;
  let windowId: number | undefined;

  for (const candidate of candidates) {
    if (typeof tabId !== 'number') {
      tabId = findNumericField(candidate, 'tabId');
    }
    if (typeof windowId !== 'number') {
      windowId = findNumericField(candidate, 'windowId');
    }
    if (typeof tabId === 'number' && typeof windowId === 'number') break;
  }

  return { tabId, windowId };
}

/**
 * Handle tool execution
 */
export const handleCallTool = async (param: ToolCallParam) => {
  let tool = toolsMap.get(param.name);
  if (!tool) {
    tool = await getLazyTool(param.name);
  }

  if (!tool) {
    return createErrorResponse(`Tool ${param.name} not found`);
  }

  const sessionId = param.meta?.mcpSessionId?.trim() || undefined;
  const instanceId = param.meta?.instanceId?.trim() || undefined;
  const resolvedTarget = await resolveExecutionTarget(param.name, param.args, sessionId, instanceId);
  const targetMergedArgs = mergeArgsWithResolvedTarget(param.args, resolvedTarget);
  const shouldApplyMcpBackgroundDefault = param.meta?.source === 'mcp' || !!sessionId;
  const mergedArgs = shouldApplyMcpBackgroundDefault
    ? await mergeArgsWithDefaultBackground(param.name, targetMergedArgs)
    : targetMergedArgs;

  try {
    const executionContext =
      param.meta?.clientCapabilities !== undefined ? { meta: param.meta } : undefined;
    const execute = async () =>
      executionContext ? await tool.execute(mergedArgs, executionContext) : await tool.execute(mergedArgs);
    const result =
      typeof resolvedTarget.tabId === 'number'
        ? await runInTabQueue(resolvedTarget.tabId, execute)
        : await execute();

    if (sessionId && result?.isError !== true) {
      const patch = extractSessionPatchFromResult(result);
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
    console.error(`Tool execution failed for ${param.name}:`, error);
    return createErrorResponse(
      error instanceof Error ? error.message : ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
    );
  }
};
