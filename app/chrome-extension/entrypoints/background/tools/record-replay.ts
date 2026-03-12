import { createErrorResponse, ToolResult } from "@/common/tool-handler";
import { TOOL_NAMES } from "webpage-mcp-shared";
import type { Flow } from "../record-replay/types";
import { getFlow } from "../record-replay/flow-store";
import { runFlow } from "../record-replay/flow-runner";
import { createStoragePort } from "../record-replay-v3";
import type { FlowId } from "../record-replay-v3/domain/ids";
import { listPublishedFlowDetails } from "../record-replay-v3/flows/publish";
import { convertFlowV3ToV2 } from "../record-replay-v3/storage/import/v2-to-v3";

async function getRunnableFlow(flowId: string): Promise<Flow | null> {
  const legacyFlow = await getFlow(flowId);
  if (legacyFlow) {
    return legacyFlow;
  }

  const flowV3 = await createStoragePort().flows.get(flowId as FlowId);
  if (!flowV3) {
    return null;
  }

  const converted = convertFlowV3ToV2(flowV3);
  if (!converted.success || !converted.data) {
    throw new Error(
      converted.errors.length > 0
        ? converted.errors.join("; ")
        : `Failed to convert V3 workflow "${flowId}" for legacy runner`,
    );
  }

  return converted.data as Flow;
}

class FlowRunTool {
  name = TOOL_NAMES.RECORD_REPLAY.FLOW_RUN;
  async execute(args: any): Promise<ToolResult> {
    const normalizeScreenshotBaselines = (
      value: unknown,
    ): Record<string, string> | undefined => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
      const normalized: Record<string, string> = {};
      for (const [key, baseline] of Object.entries(value)) {
        if (typeof key !== "string" || !key.trim()) continue;
        if (typeof baseline !== "string" || !baseline.trim()) continue;
        normalized[key] = baseline;
      }
      return Object.keys(normalized).length > 0 ? normalized : undefined;
    };

    const {
      flowId,
      args: vars,
      tabTarget,
      refresh,
      captureNetwork,
      returnLogs,
      timeoutMs,
      startUrl,
      tabId,
      debugStepByStep,
      stepDelayMs,
      captureStepScreenshots,
      recordStepScreenshotBaselines,
      screenshotBaselines,
      screenshotDiffThreshold,
    } = args || {};
    if (!flowId) return createErrorResponse("flowId is required");
    const flow = await getRunnableFlow(flowId);
    if (!flow) return createErrorResponse(`Flow not found: ${flowId}`);
    const normalizedBaselines =
      normalizeScreenshotBaselines(screenshotBaselines);
    const runOptions = {
      tabTarget,
      refresh,
      captureNetwork,
      returnLogs,
      timeoutMs,
      startUrl,
      tabId,
      args: vars,
      debugStepByStep: debugStepByStep === true,
      stepDelayMs:
        typeof stepDelayMs === "number" && Number.isFinite(stepDelayMs)
          ? Math.max(0, Math.floor(stepDelayMs))
          : undefined,
      captureStepScreenshots: captureStepScreenshots === true,
      recordStepScreenshotBaselines: recordStepScreenshotBaselines === true,
      screenshotBaselines: normalizedBaselines,
      screenshotDiffThreshold:
        typeof screenshotDiffThreshold === "number" &&
        Number.isFinite(screenshotDiffThreshold)
          ? screenshotDiffThreshold
          : undefined,
    };

    const result = await runFlow(flow, {
      ...runOptions,
      args: vars,
    });

    return {
      content: [
        {
          type: "text",
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
    const list = listPublishedFlowDetails(
      await createStoragePort().flows.list(),
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: true, published: list }),
        },
      ],
      isError: false,
    };
  }
}

export const flowRunTool = new FlowRunTool();
export const listPublishedFlowsTool = new ListPublishedTool();
