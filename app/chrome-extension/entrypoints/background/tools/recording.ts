import { createErrorResponse, type ToolResult } from "@/common/tool-handler";
import { TOOL_NAMES } from "webpage-mcp-shared";
import type { Flow } from "@/common/workflow-compat-types";
import { RecorderManager, buildRecordingStateSnapshot } from "../recording";
import type { FlowV3 } from "../record-replay-v3/domain/flow";
import { saveFlowToV3 } from "../record-replay-v3/compat";

function countFlowSteps(flow: Flow | FlowV3 | null): number {
  if (!flow) return 0;
  if (Array.isArray(flow.nodes)) return flow.nodes.length;
  if (Array.isArray(flow.steps)) return flow.steps.length;
  return 0;
}

function appendWarning(current: string | undefined, next: string): string {
  if (!current) {
    return next;
  }
  return `${current}; ${next}`;
}

class RecordingStartTool {
  name = TOOL_NAMES.RECORD_REPLAY.RECORDING_START;

  async execute(args: any): Promise<ToolResult> {
    const flowName =
      typeof args?.name === "string" && args.name.trim()
        ? args.name.trim()
        : "";
    const tabId = typeof args?.tabId === "number" ? args.tabId : undefined;
    const meta = flowName
      ? { name: flowName }
      : undefined;
    const result = await RecorderManager.start(meta, tabId);
    if (!result.success) {
      return createErrorResponse(result.error || "Failed to start recording");
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            state: buildRecordingStateSnapshot(),
          }),
        },
      ],
      isError: false,
    };
  }
}

class RecordingStopTool {
  name = TOOL_NAMES.RECORD_REPLAY.RECORDING_STOP;

  async execute(args: any): Promise<ToolResult> {
    const result = await RecorderManager.stop();
    if (!result.success) {
      return createErrorResponse(result.error || "Failed to stop recording");
    }

    const nextName =
      typeof args?.name === "string" && args.name.trim()
        ? args.name.trim()
        : "";
    const nextDescription =
      typeof args?.description === "string" && args.description.trim()
        ? args.description.trim()
        : "";

    const flow = result.flow;
    let warning = result.error || undefined;
    if (flow && (nextName || nextDescription)) {
      if (nextName) flow.name = nextName;
      if (nextDescription) flow.description = nextDescription;
      if ("updatedAt" in flow) {
        flow.updatedAt = new Date().toISOString();
      } else if (flow.meta) {
        flow.meta.updatedAt = new Date().toISOString();
      }
      try {
        await saveFlowToV3(flow);
      } catch (error) {
        warning = appendWarning(
          warning,
          `Failed to persist renamed recorded workflow to V3: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            warning,
            flow: flow
              ? {
                  id: flow.id,
                  name: flow.name,
                  description: flow.description,
                  stepCount: countFlowSteps(flow),
                }
              : null,
            state: buildRecordingStateSnapshot(),
          }),
        },
      ],
      isError: false,
    };
  }
}

class RecordingStatusTool {
  name = TOOL_NAMES.RECORD_REPLAY.RECORDING_STATUS;

  async execute(): Promise<ToolResult> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            state: buildRecordingStateSnapshot(),
          }),
        },
      ],
      isError: false,
    };
  }
}

export const recordingStartTool = new RecordingStartTool();
export const recordingStopTool = new RecordingStopTool();
export const recordingStatusTool = new RecordingStatusTool();
