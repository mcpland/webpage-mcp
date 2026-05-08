import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_NAMES } from 'webpage-mcp-shared';

const ALWAYS_REFRESH_WORKFLOW_TOOL_LIST_TOOLS = new Set<string>([
  TOOL_NAMES.RECORD_REPLAY.FLOW_UPDATE,
  TOOL_NAMES.RECORD_REPLAY.WORKFLOW_REPAIR,
  TOOL_NAMES.RECORD_REPLAY.WORKFLOW_REPAIR_ROLLBACK,
  TOOL_NAMES.RECORD_REPLAY.WORKFLOW_PUBLISH,
  TOOL_NAMES.RECORD_REPLAY.WORKFLOW_UNPUBLISH,
]);

function isApplyStabilizeCall(name: string, args: unknown): boolean {
  return Boolean(
    name === TOOL_NAMES.RECORD_REPLAY.WORKFLOW_STABILIZE &&
      args &&
      typeof args === 'object' &&
      !Array.isArray(args) &&
      (args as Record<string, unknown>).apply === true,
  );
}

export function shouldRefreshWorkflowToolList(name: string, args: unknown): boolean {
  return ALWAYS_REFRESH_WORKFLOW_TOOL_LIST_TOOLS.has(name) || isApplyStabilizeCall(name, args);
}

export function isSuccessfulMcpToolResult(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return false;
  }
  return (result as Partial<CallToolResult>).isError !== true;
}

export function shouldNotifyWorkflowToolListChanged(
  name: string,
  args: unknown,
  result: unknown,
): boolean {
  return shouldRefreshWorkflowToolList(name, args) && isSuccessfulMcpToolResult(result);
}
