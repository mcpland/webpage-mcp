import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { listPublished } from '../record-replay/flow-store';
import { getFlow } from '../record-replay/flow-store';
import { runFlow } from '../record-replay/flow-runner';

class FlowRunTool {
  name = TOOL_NAMES.RECORD_REPLAY.FLOW_RUN;
  async execute(args: any): Promise<ToolResult> {
    const {
      flowId,
      args: vars,
      tabTarget,
      refresh,
      captureNetwork,
      returnLogs,
      timeoutMs,
      startUrl,
    } = args || {};
    if (!flowId) return createErrorResponse('flowId is required');
    const flow = await getFlow(flowId);
    if (!flow) return createErrorResponse(`Flow not found: ${flowId}`);
    const result = await runFlow(flow, {
      tabTarget,
      refresh,
      captureNetwork,
      returnLogs,
      timeoutMs,
      startUrl,
      args: vars,
    });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result),
        },
      ],
      isError: false,
    };
  }
}

class ListPublishedTool {
  name = TOOL_NAMES.RECORD_REPLAY.LIST_PUBLISHED;
  async execute(): Promise<ToolResult> {
    const list = await listPublished();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, published: list }),
        },
      ],
      isError: false,
    };
  }
}

export const flowRunTool = new FlowRunTool();
export const listPublishedFlowsTool = new ListPublishedTool();
