import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { listPublished } from '../record-replay/flow-store';
import { getFlow } from '../record-replay/flow-store';
import { runFlow } from '../record-replay/flow-runner';
import { parseRunDatasetInput } from './flow-run-dataset';

class FlowRunTool {
  name = TOOL_NAMES.RECORD_REPLAY.FLOW_RUN;
  async execute(args: any): Promise<ToolResult> {
    const normalizeScreenshotBaselines = (value: unknown): Record<string, string> | undefined => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const normalized: Record<string, string> = {};
      for (const [key, baseline] of Object.entries(value)) {
        if (typeof key !== 'string' || !key.trim()) continue;
        if (typeof baseline !== 'string' || !baseline.trim()) continue;
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
      continueOnError,
    } = args || {};
    if (!flowId) return createErrorResponse('flowId is required');
    const flow = await getFlow(flowId);
    if (!flow) return createErrorResponse(`Flow not found: ${flowId}`);
    const normalizedBaselines = normalizeScreenshotBaselines(screenshotBaselines);
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
        typeof stepDelayMs === 'number' && Number.isFinite(stepDelayMs)
          ? Math.max(0, Math.floor(stepDelayMs))
          : undefined,
      captureStepScreenshots: captureStepScreenshots === true,
      recordStepScreenshotBaselines: recordStepScreenshotBaselines === true,
      screenshotBaselines: normalizedBaselines,
      screenshotDiffThreshold:
        typeof screenshotDiffThreshold === 'number' && Number.isFinite(screenshotDiffThreshold)
          ? screenshotDiffThreshold
          : undefined,
    };

    const parsedDataset = parseRunDatasetInput(args);
    if (parsedDataset && 'error' in parsedDataset) {
      return createErrorResponse(parsedDataset.error);
    }

    if (parsedDataset) {
      const baseVars = vars && typeof vars === 'object' && !Array.isArray(vars) ? vars : {};
      const keepRunning = continueOnError === true;
      const runs: Array<{
        index: number;
        input: Record<string, unknown>;
        success: boolean;
        paused?: boolean;
        summary?: { total: number; success: number; failed: number; tookMs: number };
        outputs?: Record<string, unknown> | null;
        result: unknown;
      }> = [];
      let stoppedEarly = false;

      for (let i = 0; i < parsedDataset.rows.length; i += 1) {
        const row = parsedDataset.rows[i] || {};
        const mergedVars = { ...baseVars, ...row };
        const result = await runFlow(flow, {
          ...runOptions,
          args: mergedVars,
        });
        const success = result.success === true && result.paused !== true;
        runs.push({
          index: i,
          input: row,
          success,
          paused: result.paused,
          summary: result.summary,
          outputs: (result.outputs as Record<string, unknown> | null | undefined) ?? null,
          result,
        });
        if (!success && !keepRunning) {
          stoppedEarly = i < parsedDataset.rows.length - 1;
          break;
        }
      }

      const total = runs.length;
      const succeeded = runs.filter((r) => r.success).length;
      const failed = total - succeeded;
      const response = {
        success: failed === 0,
        batch: {
          source: parsedDataset.source,
          totalPlanned: parsedDataset.rows.length,
          totalExecuted: total,
          succeeded,
          failed,
          stoppedEarly,
          continueOnError: keepRunning,
        },
        runs,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(response) }],
        isError: false,
      };
    }

    const result = await runFlow(flow, {
      ...runOptions,
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
