import { createErrorResponse, ToolResult } from "@/common/tool-handler";
import { TOOL_NAMES } from "webpage-mcp-shared";
import { createStoragePort } from "../record-replay-v3";
import type { FlowId } from "../record-replay-v3/domain/ids";
import type { JsonObject } from "../record-replay-v3/domain/json";
import type { FlowV3 } from "../record-replay-v3/domain/flow";
import {
  buildWorkflowQualitySummary,
  calculateWorkflowRevision,
  ensurePublishedSlugAvailable,
  evaluateWorkflowPublishGate,
  getPublishedFlowInfo,
  listPublishedFlowDetails,
  mergeFlowToolMetadata,
  normalizeToolSlug,
} from "../record-replay-v3/flows/publish";
import { enqueueRunAndWait } from "../record-replay-v3/compat";
import { withFlowWriteLock } from "../record-replay-v3/flows/write-lock";

function hasDisallowedPublicUrlScheme(url: string): boolean {
  const match = url.trim().match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
  if (!match) {
    return false;
  }

  const protocol = match[1]?.toLowerCase();
  return protocol !== "http" && protocol !== "https";
}

interface FlowRunArgValidationError {
  code: string;
  path: string;
  message: string;
}

function inferVariableKind(variable: NonNullable<FlowV3["variables"]>[number]): string {
  if (variable.kind) return variable.kind;
  if (typeof variable.default === "number") return "number";
  if (typeof variable.default === "boolean") return "boolean";
  if (Array.isArray(variable.default)) return "array";
  if (variable.default && typeof variable.default === "object") return "json";
  return "string";
}

function validateFlowRunArgs(
  flow: FlowV3,
  args: unknown,
): { ok: true; args: JsonObject | undefined } | { ok: false; errors: FlowRunArgValidationError[] } {
  if (args === undefined || args === null) {
    args = {};
  }
  if (typeof args !== "object" || Array.isArray(args)) {
    return {
      ok: false,
      errors: [
        {
          code: "INVALID_WORKFLOW_ARGS",
          path: "/args",
          message: "args must be an object",
        },
      ],
    };
  }

  const variables = Array.isArray(flow.variables) ? flow.variables : [];
  const input = args as Record<string, unknown>;
  const knownVariables = new Map(variables.map((variable) => [variable.name, variable]));
  const errors: FlowRunArgValidationError[] = [];

  for (const key of Object.keys(input)) {
    if (!knownVariables.has(key)) {
      errors.push({
        code: "UNKNOWN_WORKFLOW_ARG",
        path: `/args/${key}`,
        message: `Unknown workflow argument: ${key}`,
      });
    }
  }

  for (const variable of variables) {
    if (!variable?.name) continue;
    const hasValue = Object.prototype.hasOwnProperty.call(input, variable.name);
    const value = input[variable.name];
    if (variable.required === true && variable.default === undefined && !hasValue) {
      errors.push({
        code: "MISSING_REQUIRED_WORKFLOW_ARG",
        path: `/args/${variable.name}`,
        message: `Missing required workflow argument: ${variable.name}`,
      });
      continue;
    }
    if (!hasValue || value === undefined || value === null) {
      continue;
    }

    const kind = inferVariableKind(variable);
    const valid =
      kind === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : kind === "boolean"
          ? typeof value === "boolean"
          : kind === "array"
            ? Array.isArray(value)
            : kind === "json"
              ? true
              : kind === "enum"
                ? Array.isArray(variable.options) && variable.options.includes(value as never)
                : typeof value === "string";
    if (!valid) {
      errors.push({
        code: "INVALID_WORKFLOW_ARG_TYPE",
        path: `/args/${variable.name}`,
        message: `Invalid value for workflow argument "${variable.name}"`,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    args: Object.keys(input).length > 0 ? (input as JsonObject) : undefined,
  };
}

function createFlowRunValidationError(flowId: string, errors: FlowRunArgValidationError[]): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: false,
          flowId,
          status: "validation_failed",
          error: {
            code: "INVALID_WORKFLOW_ARGS",
            category: "validation",
            retryable: false,
            message: errors[0]?.message ?? "Invalid workflow arguments",
            errors,
          },
        }),
      },
    ],
    isError: true,
  };
}

async function recordQualityRunOutcome(flow: FlowV3, success: boolean): Promise<FlowV3> {
  if (!flow.meta?.quality) {
    return flow;
  }
  const previousFailures = flow.meta.quality.consecutiveFailureCount ?? 0;
  const consecutiveFailureCount = success ? 0 : previousFailures + 1;
  const staleReason =
    !success && consecutiveFailureCount >= 3
      ? "consecutive_failures"
      : success && flow.meta.quality.staleReason === "consecutive_failures"
        ? undefined
        : flow.meta.quality.staleReason;
  const next: FlowV3 = {
    ...flow,
    updatedAt: new Date().toISOString() as FlowV3["updatedAt"],
    meta: {
      ...(flow.meta ?? {}),
      quality: {
        ...flow.meta.quality,
        consecutiveFailureCount,
        ...(staleReason ? { staleReason } : {}),
        revalidation: {
          ...(flow.meta.quality.revalidation ?? {}),
          lastRevalidateReason: success ? "workflow_run_success" : "workflow_run_failure",
        },
      },
    },
  };
  if (!staleReason) {
    delete next.meta?.quality?.staleReason;
  }
  await createStoragePort().flows.save(next);
  return next;
}

function jsonToolResult(payload: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload),
      },
    ],
    isError,
  };
}

function workflowToolError(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): ToolResult {
  return jsonToolResult(
    {
      success: false,
      status: "validation_failed",
      error: {
        code,
        category: "validation",
        retryable: false,
        message,
        ...details,
      },
    },
    true,
  );
}

async function resolveFlowForUnpublish(args: any): Promise<
  | { ok: true; flow: FlowV3 }
  | { ok: false; result: ToolResult }
> {
  const flowId = typeof args?.flowId === "string" ? args.flowId.trim() : "";
  const workflow = typeof args?.workflow === "string" ? args.workflow.trim() : "";
  if (!flowId && !workflow) {
    return {
      ok: false,
      result: workflowToolError(
        "MISSING_WORKFLOW_TARGET",
        "Exactly one of flowId or workflow is required",
      ),
    };
  }
  if (flowId && workflow) {
    return {
      ok: false,
      result: workflowToolError(
        "AMBIGUOUS_WORKFLOW_TARGET",
        "flowId and workflow cannot be used together",
      ),
    };
  }

  const storage = createStoragePort();
  if (flowId) {
    const flow = await storage.flows.get(flowId as FlowId);
    if (!flow) {
      return {
        ok: false,
        result: workflowToolError("WORKFLOW_NOT_FOUND", `Flow not found: ${flowId}`),
      };
    }
    return { ok: true, flow };
  }

  const matches = (await storage.flows.list()).filter((flow) => {
    const info = getPublishedFlowInfo(flow);
    return info?.slug === workflow;
  });
  if (matches.length !== 1) {
    return {
      ok: false,
      result: workflowToolError(
        matches.length > 1 ? "WORKFLOW_SLUG_AMBIGUOUS" : "WORKFLOW_NOT_FOUND",
        matches.length > 1
          ? `Published workflow slug is ambiguous: ${workflow}`
          : `Published workflow not found: ${workflow}`,
      ),
    };
  }
  return { ok: true, flow: matches[0] };
}

function publishNotificationSummary(): Record<string, unknown> {
  return {
    toolListChanged: false,
    fallback:
      "record_replay_list_published and runtime slug validation are used when MCP tool-list changed notifications are unavailable.",
  };
}

class WorkflowPublishTool {
  name = TOOL_NAMES.RECORD_REPLAY.WORKFLOW_PUBLISH;

  async execute(args: any): Promise<ToolResult> {
    const flowId = typeof args?.flowId === "string" ? args.flowId.trim() : "";
    if (!flowId) {
      return workflowToolError("MISSING_FLOW_ID", "flowId is required");
    }

    const requireVerified = args?.requireVerified === true;
    const requireStable = requireVerified || args?.requireStable !== false;
    if (args?.requireStable === false && args?.allowUnverified !== true) {
      return workflowToolError(
        "UNVERIFIED_PUBLISH_REQUIRES_ACK",
        "Publishing without requireStable requires allowUnverified=true",
      );
    }

    try {
      return await withFlowWriteLock(flowId as FlowId, async () => {
        const storage = createStoragePort();
        const existing = await storage.flows.get(flowId as FlowId);
        if (!existing) {
          return workflowToolError("WORKFLOW_NOT_FOUND", `Flow not found: ${flowId}`);
        }

        const requestedSlug =
          typeof args?.slug === "string" && args.slug.trim()
            ? args.slug.trim()
            : existing.meta?.tool?.slug;
        const slug = normalizeToolSlug(requestedSlug, existing.name);
        const updated: FlowV3 = {
          ...existing,
          updatedAt: new Date().toISOString() as FlowV3["updatedAt"],
          meta: mergeFlowToolMetadata(existing.meta, {
            published: true,
            slug,
            ...(typeof args?.category === "string" && args.category.trim()
              ? { category: args.category.trim() }
              : {}),
            ...(typeof args?.description === "string" && args.description.trim()
              ? { description: args.description.trim() }
              : {}),
          }),
        };

        ensurePublishedSlugAvailable(await storage.flows.list(), updated.id, slug);

        const gateOptions = {
          requireStable,
          requireVerified,
          minStabilityScore:
            typeof args?.minStabilityScore === "number" ? args.minStabilityScore : undefined,
          minValidationRuns:
            typeof args?.minValidationRuns === "number" ? args.minValidationRuns : undefined,
          minPassRate: typeof args?.minPassRate === "number" ? args.minPassRate : undefined,
          allowWeakOracle: args?.allowWeakOracle === true,
        };
        let gate = evaluateWorkflowPublishGate(updated, gateOptions);
        const warnings: Array<{ code: string; message: string }> = [...gate.warnings];
        if (
          !gate.allowed &&
          gate.errors.every((error) => error.code === "PUBLISH_QUALITY_STALE") &&
          gate.quality.staleReason === "revision_mismatch" &&
          existing.meta?.quality
        ) {
          const prePublishGate = evaluateWorkflowPublishGate(existing, gateOptions);
          if (prePublishGate.allowed) {
            updated.meta = {
              ...(updated.meta ?? {}),
              quality: {
                ...existing.meta.quality,
                revision: calculateWorkflowRevision(updated),
                warnings: Array.from(
                  new Set([...(existing.meta.quality.warnings ?? []), "quality_rebound_publish_metadata"]),
                ),
              },
            };
            gate = evaluateWorkflowPublishGate(updated, gateOptions);
            warnings.push({
              code: "PUBLISH_QUALITY_REBOUND_TO_DESCRIPTOR",
              message:
                "Quality revision was rebound because publish metadata changed but the executable workflow quality gate passed.",
            });
          }
        }

        if (!gate.allowed) {
          return jsonToolResult(
            {
              success: false,
              flowId,
              workflow: slug,
              status: "blocked",
              error: {
                code: "PUBLISH_QUALITY_GATE_FAILED",
                category: "validation",
                retryable: false,
                message:
                  gate.errors[0]?.message ?? "Workflow does not satisfy publish quality gate",
                errors: gate.errors,
              },
              quality: gate.quality,
              warnings,
            },
            true,
          );
        }

        await storage.flows.save(updated);
        const descriptor = listPublishedFlowDetails([updated])[0];
        return jsonToolResult({
          success: true,
          flowId: updated.id,
          workflow: slug,
          published: true,
          status: gate.quality.level === "verified" ? "verified" : gate.quality.level,
          descriptor,
          quality: buildWorkflowQualitySummary(updated),
          warnings,
          notifications: publishNotificationSummary(),
        });
      });
    } catch (error) {
      return workflowToolError(
        "WORKFLOW_PUBLISH_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

class WorkflowUnpublishTool {
  name = TOOL_NAMES.RECORD_REPLAY.WORKFLOW_UNPUBLISH;

  async execute(args: any): Promise<ToolResult> {
    const resolved = await resolveFlowForUnpublish(args);
    if (!resolved.ok) {
      return resolved.result;
    }
    const previousInfo = getPublishedFlowInfo(resolved.flow);
    return withFlowWriteLock(resolved.flow.id as FlowId, async () => {
      const storage = createStoragePort();
      const existing = await storage.flows.get(resolved.flow.id as FlowId);
      if (!existing) {
        return workflowToolError("WORKFLOW_NOT_FOUND", `Flow not found: ${resolved.flow.id}`);
      }
      const updated: FlowV3 = {
        ...existing,
        updatedAt: new Date().toISOString() as FlowV3["updatedAt"],
        meta: mergeFlowToolMetadata(existing.meta, {
          published: false,
          ...(existing.meta?.tool?.slug ? { slug: existing.meta.tool.slug } : {}),
        }),
      };
      await storage.flows.save(updated);
      return jsonToolResult({
        success: true,
        flowId: updated.id,
        workflow: previousInfo?.slug ?? updated.meta?.tool?.slug,
        published: false,
        status: "draft",
        quality: buildWorkflowQualitySummary(updated),
        notifications: publishNotificationSummary(),
      });
    });
  }
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
      background,
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
    let flow = await createStoragePort().flows.get(flowId as FlowId);
    if (!flow) return createErrorResponse(`Flow not found: ${flowId}`);
    const normalizedStartUrl =
      typeof startUrl === "string" && startUrl.trim() ? startUrl.trim() : undefined;
    if (normalizedStartUrl && hasDisallowedPublicUrlScheme(normalizedStartUrl)) {
      return createErrorResponse(
        "Only http:// and https:// URLs are allowed for startUrl",
      );
    }
    const validatedArgs = validateFlowRunArgs(flow, vars);
    if (!validatedArgs.ok) {
      return createFlowRunValidationError(flow.id, validatedArgs.errors);
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
          validatedArgs.args,
        execution: {
          disallowLocalFileUploads: true,
          disallowLocalFilePages: true,
          redactDownloadPaths: true,
          ...(background === true ? { backgroundTabs: true } : {}),
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

    flow = await recordQualityRunOutcome(flow, result.success === true);
    const revision = calculateWorkflowRevision(flow);
    const publishedInfo = getPublishedFlowInfo(flow);
    const quality = buildWorkflowQualitySummary(flow);
    const qualityWarning = quality.current
      ? null
      : {
          code: "WORKFLOW_QUALITY_STALE",
          message: `Workflow quality is not current: ${quality.staleReason ?? "unknown"}`,
          revalidation: {
            recommended: true,
            policy: flow.meta?.quality?.revalidation?.policy ?? "manual",
          },
        };
    const response = {
      ...result,
      flowId: flow.id,
      ...(publishedInfo?.slug ? { workflow: publishedInfo.slug } : {}),
      revision,
      quality: {
        level: quality.level,
        status: quality.status,
        current: quality.current,
        verifiedThisRun:
          result.success === true &&
          quality.level === "verified" &&
          quality.verification.oracle !== "none",
        verification: quality.verification,
      },
      qualityWarning,
      ...(result.success !== true
        ? {
            debug: {
              ...(result.debug ?? {}),
              debugTool: TOOL_NAMES.RECORD_REPLAY.WORKFLOW_DEBUG_VIEW,
              debugArgs: {
                runId: result.runId,
                flowId: flow.id,
                ...(publishedInfo?.slug ? { workflow: publishedInfo.slug } : {}),
                ...(result.currentNodeId ? { nodeId: result.currentNodeId } : {}),
                maxEvents: 200,
                includeArtifacts: true,
              },
            },
          }
        : {}),
      ...(ignoredOptions.length > 0
        ? { warning: `Ignored legacy run options: ${ignoredOptions.join(", ")}` }
        : {}),
    };

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
export const workflowPublishTool = new WorkflowPublishTool();
export const workflowUnpublishTool = new WorkflowUnpublishTool();
