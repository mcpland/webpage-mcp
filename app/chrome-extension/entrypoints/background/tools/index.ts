import { createErrorResponse } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import * as browserTools from './browser';
import { flowRunTool, listPublishedFlowsTool } from './record-replay';
import { getSessionContext, patchSessionContext } from '../session-context';
import { runInTabQueue } from '../tab-queue';

const tools = { ...browserTools, flowRunTool, listPublishedFlowsTool } as any;
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
  };
}

function isTabScopedTool(toolName: string): boolean {
  if (NON_TAB_SCOPED_CHROME_TOOLS.has(toolName)) {
    return false;
  }
  return (
    toolName.startsWith('chrome_') ||
    toolName.startsWith('performance_') ||
    toolName === TOOL_NAMES.RECORD_REPLAY.FLOW_RUN
  );
}

async function resolveTabIdForExecution(
  toolName: string,
  args: any,
  sessionId?: string,
  instanceId?: string,
): Promise<number | undefined> {
  if (typeof args?.tabId === 'number') return args.tabId;
  if (URL_PRIORITY_TOOLS.has(toolName) && typeof args?.url === 'string' && args.url.trim()) {
    // These tools use `url` as the primary routing key; injecting a session tabId here
    // can accidentally bypass URL-based selection and produce unexpected behavior.
    return undefined;
  }
  if (!isTabScopedTool(toolName)) return undefined;
  if (toolName === TOOL_NAMES.RECORD_REPLAY.FLOW_RUN && args?.tabTarget === 'new') {
    // Respect explicit new-tab execution requests for flow runs.
    return undefined;
  }

  if (sessionId) {
    const sessionCtx = getSessionContext(sessionId, instanceId);
    if (typeof sessionCtx?.tabId === 'number') {
      try {
        const tab = await chrome.tabs.get(sessionCtx.tabId);
        if (typeof tab?.id === 'number') {
          return tab.id;
        }
      } catch {
        patchSessionContext(sessionId, { tabId: undefined }, instanceId);
      }
    }

    if (typeof sessionCtx?.windowId === 'number') {
      try {
        const [windowActive] = await chrome.tabs.query({
          active: true,
          windowId: sessionCtx.windowId,
        });
        if (typeof windowActive?.id === 'number') {
          return windowActive.id;
        }
      } catch {
        // Ignore window lookup failures and continue fallback resolution.
      }
    }
  }

  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (typeof active?.id === 'number') return active.id;
  } catch {
    // Ignore active-tab lookup failures; tools may handle missing target themselves.
  }
  return undefined;
}

function mergeArgsWithResolvedTab(args: any, resolvedTabId?: number): any {
  if (typeof resolvedTabId !== 'number') return args;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    if (typeof args.tabId === 'number') return args;
    return { ...args, tabId: resolvedTabId };
  }
  return { tabId: resolvedTabId };
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
  const resolvedTabId = await resolveTabIdForExecution(param.name, param.args, sessionId, instanceId);
  const mergedArgs = mergeArgsWithResolvedTab(param.args, resolvedTabId);

  try {
    const execute = async () => await tool.execute(mergedArgs);
    const result =
      typeof resolvedTabId === 'number' ? await runInTabQueue(resolvedTabId, execute) : await execute();

    if (sessionId) {
      const patch = extractSessionPatchFromResult(result);
      const tabIdToPersist =
        typeof patch.tabId === 'number' ? patch.tabId : typeof resolvedTabId === 'number' ? resolvedTabId : undefined;
      const update: { tabId?: number; windowId?: number } = {};
      if (typeof tabIdToPersist === 'number') update.tabId = tabIdToPersist;
      if (typeof patch.windowId === 'number') update.windowId = patch.windowId;
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
