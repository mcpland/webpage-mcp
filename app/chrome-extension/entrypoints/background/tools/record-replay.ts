import { createErrorResponse, ToolResult } from "@/common/tool-handler";
import { TOOL_NAMES } from "webpage-mcp-shared";
import { createStoragePort } from "../record-replay-v3";
import { enqueueRunAndWait, ensureV3Runtime } from "../record-replay-v3/compat";
import { isTerminalStatus, type RunRecordV3 } from "../record-replay-v3/domain/events";
import type { FlowId, RunId } from "../record-replay-v3/domain/ids";
import type { JsonObject } from "../record-replay-v3/domain/json";
import type { FlowV3 } from "../record-replay-v3/domain/flow";
import {
  appendWorkflowAuditEvent,
  buildWorkflowQualitySummary,
  calculateWorkflowRevision,
  ensurePublishedSlugAvailable,
  evaluateWorkflowPublishGate,
  getPublishedFlowInfo,
  listPublishedFlowDetails,
  mergeFlowToolMetadata,
  normalizeToolSlug,
} from "../record-replay-v3/flows/publish";
import {
  projectAndValidateWorkflowOutputs,
  type WorkflowOutputProjectionResult,
} from "../record-replay-v3/flows/output-validation";
import { markScheduledRevalidationCatchUp } from "../record-replay-v3/flows/revalidation";
import { withFlowWriteLock } from "../record-replay-v3/flows/write-lock";
import {
  WorkflowSecretRefError,
  assertWorkflowSecretRefsResolvable,
  isWorkflowSecretRefValue,
} from "../record-replay-v3/secrets";
import { RR_ERROR_CODES } from "../record-replay-v3/domain/errors";

function hasDisallowedPublicUrlScheme(url: string): boolean {
  const match = url.trim().match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
  if (!match) {
    return false;
  }

  const protocol = match[1]?.toLowerCase();
  return protocol !== "http" && protocol !== "https";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    if (isWorkflowSecretRefValue(value)) {
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

function createFlowRunSecretRefError(flowId: string, error: WorkflowSecretRefError): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: false,
          flowId,
          status: "blocked",
          error: {
            code:
              error.code === RR_ERROR_CODES.SECRET_REF_NOT_FOUND ||
              error.code === RR_ERROR_CODES.SECRET_REF_EXPIRED ||
              error.code === RR_ERROR_CODES.SECRET_REF_REVOKED
                ? error.code
                : RR_ERROR_CODES.SECRET_REF_INVALID,
            category: "validation",
            retryable: false,
            message: error.message,
            path: error.path,
            ...(error.secretRef ? { secretRef: error.secretRef } : {}),
          },
        }),
      },
    ],
    isError: true,
  };
}

function createFlowRunStaleDescriptorError(
  flowId: string,
  requiredRevision: string,
  currentRevision: string,
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: false,
          flowId,
          revision: currentRevision,
          status: "stale_descriptor",
          error: {
            code: RR_ERROR_CODES.STALE_WORKFLOW_DESCRIPTOR,
            category: "stale_revision",
            retryable: true,
            message: `Workflow descriptor revision is stale: expected ${requiredRevision}, current ${currentRevision}`,
            expectedRevision: requiredRevision,
            currentRevision,
          },
        }),
      },
    ],
    isError: true,
  };
}

function createFlowRunQualityStatusError(
  flow: FlowV3,
  quality: ReturnType<typeof buildWorkflowQualitySummary>,
): ToolResult {
  const publishedInfo = getPublishedFlowInfo(flow);
  const paused = quality.status === "paused";
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: false,
          flowId: flow.id,
          ...(publishedInfo?.slug ? { workflow: publishedInfo.slug } : {}),
          revision: calculateWorkflowRevision(flow),
          status: quality.status,
          quality,
          error: {
            code: paused ? "WORKFLOW_PAUSED" : "WORKFLOW_BLOCKED",
            category: paused ? "safety" : "capability",
            retryable: false,
            message: paused
              ? "Workflow quality status is paused; explicit user or policy resume plus revalidation is required before running."
              : "Workflow quality status is blocked; the blocking dependency must be fixed and re-evaluated before running.",
            nextActions: [
              paused
                ? "Resume through trusted UI/policy approval and rerun workflow_stabilize for revalidation."
                : "Resolve the blocking schema, capability, safety, secret, or migration issue and rerun workflow_stabilize or workflow_migrate.",
            ],
          },
        }),
      },
    ],
    isError: true,
  };
}

function countSecretRefs(value: unknown): number {
  if (isWorkflowSecretRefValue(value)) return 1;
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + countSecretRefs(item), 0);
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (sum, item) => sum + countSecretRefs(item),
      0,
    );
  }
  return 0;
}

function roundMetric(value: number): number {
  return Number(Math.max(0, value).toFixed(4));
}

function isQuotaLikeErrorCode(code: unknown): boolean {
  return typeof code === "string" && /(quota|rate.?limit|resource.?exhausted|storage.?limit|limit.?exceeded)/i.test(code);
}

function buildFlowRunRuntimeMetrics(
  flow: FlowV3,
  success: boolean,
  result: Record<string, any>,
) {
  const quality = buildWorkflowQualitySummary(flow);
  const workflowKey = getPublishedFlowInfo(flow)?.slug ?? flow.id;
  const repairHistory = Array.isArray(flow.meta?.repairs?.history) ? flow.meta.repairs.history : [];
  const falseRepairCount = repairHistory.filter(
    (entry) =>
      typeof entry.beforeQuality === "number" &&
      typeof entry.afterQuality === "number" &&
      entry.afterQuality < entry.beforeQuality,
  ).length;
  const auditEvents = Array.isArray(flow.meta?.audit?.events) ? flow.meta.audit.events : [];
  const unsupportedCount = Array.isArray(quality.capabilities?.unsupportedReasons)
    ? quality.capabilities.unsupportedReasons.length
    : 0;

  return {
    workflowRun: {
      totalCount: 1,
      success,
      successCount: success ? 1 : 0,
      failureCount: success ? 0 : 1,
      successRate: success ? 1 : 0,
      consecutiveFailureCount: flow.meta?.quality?.consecutiveFailureCount ?? 0,
      staleQualityCount: quality.current ? 0 : 1,
      revalidationRecommended: !quality.current,
    },
    passRateByWorkflow: {
      [workflowKey]: quality.passRate,
    },
    repair: {
      applyCount: repairHistory.length,
      applyRate: null,
      falseRepairCount,
      falseRepairRate:
        repairHistory.length > 0 ? roundMetric(falseRepairCount / repairHistory.length) : null,
    },
    artifactRedaction: {
      lowConfidenceCount: 0,
    },
    quota: {
      hitCount: isQuotaLikeErrorCode(result.errorCode ?? result.error?.code) ? 1 : 0,
    },
    capability: {
      unsupportedCount,
    },
    approval: {
      useCount: auditEvents.filter((event) => event.kind === "approval_use").length,
    },
    quality: {
      staleQualityCount: quality.current ? 0 : 1,
    },
    audit: {
      eventCount: auditEvents.length,
    },
    slo: quality.slo,
  };
}

async function recordQualityRunOutcome(
  flow: FlowV3,
  success: boolean,
  context: { runId?: string; secretRefCount?: number } = {},
): Promise<FlowV3> {
  let next = flow;
  if ((context.secretRefCount ?? 0) > 0) {
    next = {
      ...appendWorkflowAuditEvent(next, {
        kind: "secret_ref_use",
        actor: "runtime",
        runId: context.runId,
        revision: calculateWorkflowRevision(next),
        reason: "workflow_run_secret_ref_args",
        metadata: {
          secretRefCount: context.secretRefCount ?? 0,
        },
      }),
      updatedAt: new Date().toISOString() as FlowV3["updatedAt"],
    };
  }
  if (!next.meta?.quality) {
    if (next !== flow) {
      await createStoragePort().flows.save(next);
    }
    return next;
  }
  const existingQuality = next.meta.quality;
  const previousQuality = buildWorkflowQualitySummary(next);
  const previousFailures = existingQuality.consecutiveFailureCount ?? 0;
  const consecutiveFailureCount = success ? 0 : previousFailures + 1;
  const staleReason =
    !success && consecutiveFailureCount >= 3
      ? "consecutive_failures"
      : success && existingQuality.staleReason === "consecutive_failures"
        ? undefined
        : existingQuality.staleReason;
  next = {
    ...next,
    updatedAt: new Date().toISOString() as FlowV3["updatedAt"],
    meta: {
      ...(next.meta ?? {}),
      quality: {
        ...existingQuality,
        consecutiveFailureCount,
        ...(staleReason ? { staleReason } : {}),
        revalidation: {
          ...(next.meta.quality.revalidation ?? {}),
          lastRevalidateReason: success ? "workflow_run_success" : "workflow_run_failure",
        },
      },
    },
  };
  if (!staleReason) {
    delete next.meta?.quality?.staleReason;
  }
  const nextQuality = buildWorkflowQualitySummary(next);
  if (
    previousQuality.status !== "stale" &&
    nextQuality.status === "stale" &&
    nextQuality.staleReason
  ) {
    next = appendWorkflowAuditEvent(next, {
      kind: "quality_downgrade",
      actor: "runtime",
      runId: context.runId,
      revision: calculateWorkflowRevision(next),
      previousStatus: previousQuality.status,
      nextStatus: nextQuality.status,
      reason: nextQuality.staleReason,
      metadata: {
        consecutiveFailureCount,
      },
    });
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

function applyOutputContractToRunResult(
  result: Record<string, any>,
  outputContract: WorkflowOutputProjectionResult,
): Record<string, any> {
  const outputValidation = {
    ok: outputContract.ok,
    declaredOutputCount: outputContract.declaredOutputCount,
    redacted: outputContract.redacted,
    errors: outputContract.errors,
  };
  if (outputContract.ok) {
    return {
      ...result,
      outputs: outputContract.outputs,
      outputValidation,
    };
  }

  return {
    ...result,
    success: false,
    status: "output_validation_failed",
    errorCode: RR_ERROR_CODES.OUTPUT_VALIDATION_FAILED,
    error: {
      code: RR_ERROR_CODES.OUTPUT_VALIDATION_FAILED,
      category: "validation",
      retryable: false,
      message:
        outputContract.errors[0]?.message ?? "Workflow output validation failed",
      errors: outputContract.errors,
    },
    outputs: outputContract.outputs,
    outputValidation,
  };
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

        const audited = appendWorkflowAuditEvent(updated, {
          kind: "workflow_publish",
          actor: "mcp",
          workflow: slug,
          revision: calculateWorkflowRevision(updated),
          previousStatus: buildWorkflowQualitySummary(existing).status,
          nextStatus: gate.quality.status,
          reason: requireStable ? "quality_gate_passed" : "unverified_publish_acknowledged",
          metadata: {
            requireStable,
            requireVerified,
            warningCount: warnings.length,
          },
        });
        await storage.flows.save(audited);
        const descriptor = listPublishedFlowDetails([audited])[0];
        return jsonToolResult({
          success: true,
          flowId: audited.id,
          workflow: slug,
          published: true,
          status: gate.quality.level === "verified" ? "verified" : gate.quality.level,
          descriptor,
          quality: buildWorkflowQualitySummary(audited),
          audit: audited.meta?.audit?.events?.at(-1),
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
      let updated: FlowV3 = {
        ...existing,
        updatedAt: new Date().toISOString() as FlowV3["updatedAt"],
        meta: mergeFlowToolMetadata(existing.meta, {
          published: false,
          ...(existing.meta?.tool?.slug ? { slug: existing.meta.tool.slug } : {}),
        }),
      };
      updated = appendWorkflowAuditEvent(updated, {
        kind: "workflow_unpublish",
        actor: "mcp",
        workflow: previousInfo?.slug ?? updated.meta?.tool?.slug,
        revision: calculateWorkflowRevision(updated),
        previousStatus: buildWorkflowQualitySummary(existing).status,
        nextStatus: "draft",
        reason: "workflow_unpublish",
      });
      await storage.flows.save(updated);
      return jsonToolResult({
        success: true,
        flowId: updated.id,
        workflow: previousInfo?.slug ?? updated.meta?.tool?.slug,
        published: false,
        status: "draft",
        quality: buildWorkflowQualitySummary(updated),
        audit: updated.meta?.audit?.events?.at(-1),
        notifications: publishNotificationSummary(),
      });
    });
  }
}

function createRunCancelError(code: string, message: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: false,
          error: {
            code,
            category: "runtime",
            retryable: false,
            message,
          },
        }),
      },
    ],
    isError: true,
  };
}

function clampRunCancelTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 5_000;
  }
  return Math.max(100, Math.min(30_000, Math.floor(value)));
}

async function waitForTerminalRun(
  runId: RunId,
  timeoutMs: number,
): Promise<RunRecordV3 | null> {
  const runtime = await ensureV3Runtime();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await runtime.storage.runs.get(runId);
    if (run && isTerminalStatus(run.status)) {
      return run;
    }
    await sleep(100);
  }
  return runtime.storage.runs.get(runId);
}

async function forceCancelRunRecord(
  run: RunRecordV3,
  reason: string | undefined,
): Promise<RunRecordV3> {
  const runtime = await ensureV3Runtime();
  const now = Date.now();
  const tookMs =
    typeof run.startedAt === "number" ? Math.max(0, now - run.startedAt) : undefined;
  await runtime.storage.queue.cancel(run.id, now, reason);
  await runtime.storage.runs.patch(run.id, {
    status: "canceled",
    finishedAt: now,
    ...(tookMs !== undefined ? { tookMs } : {}),
  });
  await runtime.events.append({
    runId: run.id,
    type: "run.canceled",
    ...(reason ? { reason } : {}),
  });
  return (await runtime.storage.runs.get(run.id)) ?? {
    ...run,
    status: "canceled",
    finishedAt: now,
    updatedAt: now,
    ...(tookMs !== undefined ? { tookMs } : {}),
  };
}

class RunCancelTool {
  name = TOOL_NAMES.RECORD_REPLAY.RUN_CANCEL;

  async execute(args: any): Promise<ToolResult> {
    const runId = typeof args?.runId === "string" ? args.runId.trim() : "";
    if (!runId) {
      return createRunCancelError("RUN_ID_REQUIRED", "runId is required");
    }

    const runtime = await ensureV3Runtime();
    const run = await runtime.storage.runs.get(runId as RunId);
    if (!run) {
      return createRunCancelError("RUN_NOT_FOUND", `Run not found: ${runId}`);
    }

    const previousStatus = run.status;
    const reason =
      typeof args?.reason === "string" && args.reason.trim()
        ? args.reason.trim()
        : "Canceled by MCP request";
    const waitForTerminal = args?.waitForTerminal !== false;
    const timeoutMs = clampRunCancelTimeout(args?.timeoutMs);

    if (isTerminalStatus(run.status)) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              canceled: false,
              terminal: true,
              runId: run.id,
              previousStatus,
              status: run.status,
              reason: "run is already terminal",
            }),
          },
        ],
        isError: false,
      };
    }

    const queueItem = await runtime.storage.queue.get(run.id);
    let current: RunRecordV3 | null = null;
    let cleanup: "queued" | "active" | "orphaned_active" | "missing_queue" = "active";

    if (!queueItem) {
      cleanup = "missing_queue";
      current = await forceCancelRunRecord(run, reason);
    } else if (queueItem.status === "queued") {
      cleanup = "queued";
      current = await forceCancelRunRecord(run, reason);
    } else {
      const runner = runtime.runners.get(run.id);
      if (runner) {
        runner.cancel(reason);
        current = waitForTerminal
          ? await waitForTerminalRun(run.id, timeoutMs)
          : await runtime.storage.runs.get(run.id);
      } else {
        cleanup = "orphaned_active";
        current = await forceCancelRunRecord(run, reason);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            canceled: current?.status === "canceled",
            terminal: current ? isTerminalStatus(current.status) : false,
            runId: run.id,
            previousStatus,
            status: current?.status ?? "unknown",
            cleanup,
            waitForTerminal,
            ...(current?.finishedAt ? { finishedAt: current.finishedAt } : {}),
          }),
        },
      ],
      isError: false,
    };
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
      requireRevision,
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
    const currentRevision = calculateWorkflowRevision(flow);
    const requiredRevision =
      typeof requireRevision === "string" && requireRevision.trim()
        ? requireRevision.trim()
        : "";
    if (requiredRevision && requiredRevision !== currentRevision) {
      return createFlowRunStaleDescriptorError(flow.id, requiredRevision, currentRevision);
    }
    const qualityBeforeRun = buildWorkflowQualitySummary(flow);
    if (qualityBeforeRun.status === "paused" || qualityBeforeRun.status === "blocked") {
      return createFlowRunQualityStatusError(flow, qualityBeforeRun);
    }
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
    try {
      await assertWorkflowSecretRefsResolvable(validatedArgs.args);
    } catch (error) {
      if (error instanceof WorkflowSecretRefError) {
        return createFlowRunSecretRefError(flow.id, error);
      }
      return createErrorResponse(
        error instanceof Error ? error.message : String(error),
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

    const outputContract = projectAndValidateWorkflowOutputs(flow, result.outputs);
    const contractedResult = applyOutputContractToRunResult(
      result as unknown as Record<string, any>,
      outputContract,
    );
    const secretRefCount = countSecretRefs(validatedArgs.args);
    flow = await recordQualityRunOutcome(flow, contractedResult.success === true, {
      runId: contractedResult.runId,
      secretRefCount,
    });
    const revision = calculateWorkflowRevision(flow);
    const publishedInfo = getPublishedFlowInfo(flow);
    const quality = buildWorkflowQualitySummary(flow);
    const tabOwnership =
      typeof tabId === "number" && Number.isFinite(tabId)
        ? "current"
        : tabTarget === "new"
          ? "owned"
          : "current";
    const resultSummary =
      contractedResult.summary &&
      typeof contractedResult.summary === "object" &&
      !Array.isArray(contractedResult.summary)
        ? contractedResult.summary
        : {};
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
    const response: Record<string, any> = {
      ...contractedResult,
      flowId: flow.id,
      ...(publishedInfo?.slug ? { workflow: publishedInfo.slug } : {}),
      revision,
      summary: {
        ...resultSummary,
        tabTarget: tabTarget === "new" ? "new" : "current",
        tabOwnership,
        background: background === true,
      },
      quality: {
        level: quality.level,
        status: quality.status,
        current: quality.current,
        staleReason: quality.staleReason,
        slo: quality.slo,
        verifiedThisRun:
          contractedResult.success === true &&
          quality.level === "verified" &&
          quality.verification.oracle !== "none",
        verification: quality.verification,
      },
      metrics: buildFlowRunRuntimeMetrics(
        flow,
        contractedResult.success === true,
        contractedResult,
      ),
      qualityWarning,
      ...(contractedResult.success !== true
        ? {
            debug: {
              ...(contractedResult.debug ?? {}),
              debugTool: TOOL_NAMES.RECORD_REPLAY.WORKFLOW_DEBUG_VIEW,
              debugArgs: {
                runId: contractedResult.runId,
                flowId: flow.id,
                ...(publishedInfo?.slug ? { workflow: publishedInfo.slug } : {}),
                ...(contractedResult.currentNodeId ? { nodeId: contractedResult.currentNodeId } : {}),
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
    const storage = createStoragePort();
    const flows: FlowV3[] = [];
    for (const flow of await storage.flows.list()) {
      const catchUp = markScheduledRevalidationCatchUp(flow);
      if (catchUp.changed) {
        await storage.flows.save(catchUp.flow);
      }
      flows.push(catchUp.flow);
    }
    const list = listPublishedFlowDetails(flows);
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
export const runCancelTool = new RunCancelTool();
export const listPublishedFlowsTool = new ListPublishedTool();
export const workflowPublishTool = new WorkflowPublishTool();
export const workflowUnpublishTool = new WorkflowUnpublishTool();
