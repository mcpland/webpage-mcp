import { createErrorResponse, ToolResult } from "@/common/tool-handler";
import { TOOL_NAMES } from "webpage-mcp-shared";
import { createStoragePort } from "../record-replay-v3";
import type { FlowId } from "../record-replay-v3/domain/ids";
import type { JsonObject } from "../record-replay-v3/domain/json";
import { listPublishedFlowDetails } from "../record-replay-v3/flows/publish";
import { enqueueRunAndWait } from "../record-replay-v3/compat";

function hasDisallowedPublicUrlScheme(url: string): boolean {
  const match = url.trim().match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
  if (!match) {
    return false;
  }

  const protocol = match[1]?.toLowerCase();
  return protocol !== "http" && protocol !== "https";
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
    const flow = await createStoragePort().flows.get(flowId as FlowId);
    if (!flow) return createErrorResponse(`Flow not found: ${flowId}`);
    const normalizedStartUrl =
      typeof startUrl === "string" && startUrl.trim() ? startUrl.trim() : undefined;
    if (normalizedStartUrl && hasDisallowedPublicUrlScheme(normalizedStartUrl)) {
      return createErrorResponse(
        "Only http:// and https:// URLs are allowed for startUrl",
      );
    }
    const normalizedBaselines =
      normalizeScreenshotBaselines(screenshotBaselines);
    const unsupportedOptions = {
      captureNetwork,
      debugStepByStep,
      stepDelayMs,
      captureStepScreenshots,
      recordStepScreenshotBaselines,
      screenshotBaselines: normalizedBaselines,
      screenshotDiffThreshold,
    };
    const ignoredOptions = Object.entries(unsupportedOptions)
      .filter(([, value]) => value !== undefined && value !== false)
      .map(([key]) => key);

    let result;
    try {
      ({ result } = await enqueueRunAndWait({
        flowId: flow.id as FlowId,
        tabId:
          typeof tabId === "number" && Number.isFinite(tabId)
            ? Math.floor(tabId)
            : undefined,
        tabTarget: tabTarget === "new" ? "new" : "current",
        args:
          vars && typeof vars === "object" && !Array.isArray(vars)
            ? (vars as JsonObject)
            : undefined,
        execution: {
          disallowLocalFileUploads: true,
          disallowLocalFilePages: true,
        },
        startUrl: normalizedStartUrl,
        refresh: refresh === true,
        timeoutMs:
          typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
            ? Math.max(1_000, Math.floor(timeoutMs))
            : undefined,
      }));
    } catch (error) {
      return createErrorResponse(
        error instanceof Error ? error.message : String(error),
      );
    }

    const response =
      ignoredOptions.length > 0
        ? {
            ...result,
            warning: `Ignored legacy run options: ${ignoredOptions.join(", ")}`,
          }
        : result;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response),
        },
      ],
      isError: response.success !== true,
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
