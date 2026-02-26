import { createErrorResponse } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import * as browserTools from './browser';
import { flowRunTool, listPublishedFlowsTool } from './record-replay';

const tools = { ...browserTools, flowRunTool, listPublishedFlowsTool } as any;
const toolsMap = new Map(Object.values(tools).map((tool: any) => [tool.name, tool]));

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

  try {
    return await tool.execute(param.args);
  } catch (error) {
    console.error(`Tool execution failed for ${param.name}:`, error);
    return createErrorResponse(
      error instanceof Error ? error.message : ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
    );
  }
};
