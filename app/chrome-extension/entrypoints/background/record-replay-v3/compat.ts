import type {
  Flow as CompatFlow,
  RunLogEntry,
  RunResult,
} from "@/common/workflow-compat-types";
import type { FlowV3 } from "./domain/flow";
import { FLOW_SCHEMA_VERSION, type FlowMeta } from "./domain/flow";
import type { RunEvent, RunRecordV3 } from "./domain/events";
import { isTerminalStatus } from "./domain/events";
import { RR_ERROR_CODES, type RRError } from "./domain/errors";
import type { FlowId, RunId } from "./domain/ids";
import type { JsonObject } from "./domain/json";
import { bootstrapV3, type V3Runtime } from "./bootstrap";
import { enqueueRun } from "./engine/queue/enqueue-run";
import { isV3UnsupportedNodeType } from "@/entrypoints/shared/utils/v3-authoring";
import {
  calculateWorkflowRevision,
  ensurePublishedSlugAvailable,
  normalizeToolSlug,
} from "./flows/publish";
import { withFlowWriteLock } from "./flows/write-lock";
import { normalizeFlowOptionalFields } from "./flows/normalize-flow-optional-fields";
import { validateReachableRuntimeNodes } from "./flows/runtime-validation";
import { convertCompatFlowToV3 as convertCompatFlowDocumentToV3 } from "./storage/import/flow-convert";
import { validateFlow } from "./storage/flows";
import {
  resolveRunTargetTab,
  type RunTargetPreference,
} from "./run-target";
import type { ExecutionFlags } from "@/entrypoints/background/replay-actions";

const DEFAULT_RUN_TIMEOUT_MS = 60_000;
const RUN_POLL_INTERVAL_MS = 150;

export interface SaveFlowToV3Options {
  expectedRevision?: string;
  revisionConflictMessage?: string;
}

export class FlowRevisionConflictError extends Error {
  readonly code = "STALE_WORKFLOW_REVISION" as const;
  readonly retryable = true;
  readonly flowId: FlowId;
  readonly expectedRevision: string;
  readonly currentRevision: string | null;

  constructor(
    flowId: FlowId,
    expectedRevision: string,
    currentRevision: string | null,
    message?: string,
  ) {
    super(
      message ??
        `Flow "${flowId}" changed while the operation was in progress; expected revision ${expectedRevision}, current ${currentRevision ?? "missing"}`,
    );
    this.name = "FlowRevisionConflictError";
    this.flowId = flowId;
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFlowV3Object(value: unknown): value is FlowV3 {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === FLOW_SCHEMA_VERSION &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.entryNodeId === "string" &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges)
  );
}

export function isCompatFlowObject(value: unknown): value is CompatFlow {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.version === "number" &&
    (Array.isArray(value.steps) || Array.isArray(value.nodes))
  );
}

function cloneMeta(meta: FlowMeta | undefined): FlowMeta | undefined {
  return meta ? (JSON.parse(JSON.stringify(meta)) as FlowMeta) : undefined;
}

function rawFlowExplicitlyProvidesToolSlug(rawFlow: unknown): boolean {
  return (
    isRecord(rawFlow) &&
    isRecord(rawFlow.meta) &&
    isRecord(rawFlow.meta.tool) &&
    rawFlow.meta.tool.slug !== undefined &&
    rawFlow.meta.tool.slug !== null
  );
}

function getExistingPublishedSlug(existing: FlowV3 | null): string | undefined {
  if (existing?.meta?.tool?.published !== true) {
    return undefined;
  }

  const slug = existing.meta.tool.slug;
  return typeof slug === "string" && slug.trim() ? slug : undefined;
}

function validateRuntimeNodeKinds(flow: FlowV3): void {
  flow.nodes.forEach((node, index) => {
    if (isV3UnsupportedNodeType(node.kind)) {
      throw new Error(
        `flow.nodes[${index}].kind "${node.kind}" is not supported by the current V3 runtime`,
      );
    }
  });
}

function normalizePublishedToolMetadata(flow: FlowV3): FlowV3 {
  const tool = flow.meta?.tool;
  if (!tool) {
    return flow;
  }

  if (!tool.published && tool.slug === undefined) {
    return flow;
  }

  return {
    ...flow,
    meta: {
      ...(flow.meta ?? {}),
      tool: {
        ...tool,
        slug: normalizeToolSlug(tool.slug, flow.name),
      },
    },
  };
}

export async function ensureV3Runtime(): Promise<V3Runtime> {
  return bootstrapV3();
}

export async function saveFlowToV3(
  rawFlow: unknown,
  options: SaveFlowToV3Options = {},
): Promise<FlowV3> {
  const runtime = await ensureV3Runtime();
  const nowIso = new Date().toISOString();

  const flow = isFlowV3Object(rawFlow)
    ? (JSON.parse(JSON.stringify(rawFlow)) as FlowV3)
    : isCompatFlowObject(rawFlow)
      ? (() => {
          const result = convertCompatFlowDocumentToV3(rawFlow);
          if (!result.success || !result.data) {
            throw new Error(
              result.errors.length > 0
                ? result.errors.join("; ")
                : `Failed to convert flow "${rawFlow.id}" to V3`,
            );
          }
          return result.data;
        })()
      : null;

  if (!flow) {
    throw new Error("Invalid flow payload");
  }

  const parsedFlow = flow;
  return withFlowWriteLock(parsedFlow.id as FlowId, async () => {
    let flow: FlowV3 = parsedFlow;
    const existing = await runtime.storage.flows.get(flow.id as FlowId);
    if (options.expectedRevision) {
      const currentRevision = existing ? calculateWorkflowRevision(existing) : null;
      if (currentRevision !== options.expectedRevision) {
        throw new FlowRevisionConflictError(
          flow.id as FlowId,
          options.expectedRevision,
          currentRevision,
          options.revisionConflictMessage,
        );
      }
    }
    flow = {
      ...flow,
      schemaVersion: FLOW_SCHEMA_VERSION,
      createdAt: existing?.createdAt ?? flow.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    const nodeIdSet = new Set(flow.nodes.map((node) => node.id));
    const flowForOptionalNormalization = { ...(flow as unknown as JsonObject) };
    const clonedMeta = cloneMeta(flow.meta);
    const existingPublishedSlug = getExistingPublishedSlug(existing);
    if (clonedMeta) {
      if (
        flow.meta?.tool?.published === true &&
        existingPublishedSlug &&
        !rawFlowExplicitlyProvidesToolSlug(rawFlow)
      ) {
        clonedMeta.tool = {
          ...(clonedMeta.tool ?? {}),
          slug: existingPublishedSlug,
        };
      }
      flowForOptionalNormalization.meta = clonedMeta as unknown as JsonObject;
    }
    flow = {
      ...flow,
      ...normalizeFlowOptionalFields(
        flowForOptionalNormalization,
        flow.name,
        nodeIdSet,
      ),
    };
    flow = normalizePublishedToolMetadata(flow);

    validateFlow(flow);
    validateRuntimeNodeKinds(flow);
    validateReachableRuntimeNodes(flow);
    if (flow.meta?.tool?.published) {
      const slug = normalizeToolSlug(flow.meta.tool.slug, flow.name);
      if (runtime.storage.flows.findPublishedSlugOwner) {
        const owner = await runtime.storage.flows.findPublishedSlugOwner(
          slug,
          flow.id as FlowId,
        );
        if (owner) {
          throw new Error(
            `Published workflow slug "${slug}" is already used by flow "${owner}"`,
          );
        }
      } else {
        ensurePublishedSlugAvailable(
          await runtime.storage.flows.list(),
          flow.id as FlowId,
          slug,
        );
      }
    }
    await runtime.storage.flows.save(flow);
    return flow;
  });
}

export function extractFlowCandidates(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (isRecord(parsed)) {
    if (Array.isArray(parsed.flows)) {
      return parsed.flows;
    }
    if (
      parsed.id &&
      (Array.isArray(parsed.steps) || Array.isArray(parsed.nodes))
    ) {
      return [parsed];
    }
  }
  return [];
}

export async function importFlowsToV3(json: string): Promise<FlowV3[]> {
  const parsed = JSON.parse(json);
  const candidates = extractFlowCandidates(parsed);
  if (candidates.length === 0) {
    throw new Error("invalid flow json: no flows found");
  }

  const imported: FlowV3[] = [];
  for (const candidate of candidates) {
    imported.push(await saveFlowToV3(candidate));
  }
  return imported;
}

function toRunLogEntries(events: RunEvent[]): RunLogEntry[] {
  const entries: RunLogEntry[] = [];

  for (const event of events) {
    switch (event.type) {
      case "node.succeeded":
        entries.push({
          stepId: event.nodeId,
          status: "success",
          tookMs: event.tookMs,
        });
        break;
      case "node.failed":
        entries.push({
          stepId: event.nodeId,
          status: "failed",
          message: event.error.message,
        });
        break;
      case "log":
        entries.push({
          stepId: `log_${event.seq}`,
          status:
            event.level === "error"
              ? "failed"
              : event.level === "warn"
                ? "warning"
                : "success",
          message: event.message,
        });
        break;
      default:
        break;
    }
  }

  return entries;
}

type StandardRunErrorCategory =
  | "validation"
  | "safety"
  | "capability"
  | "runtime"
  | "resource"
  | "storage"
  | "stale_revision";

function classifyRunErrorCategory(code: string): StandardRunErrorCategory {
  switch (code) {
    case RR_ERROR_CODES.VALIDATION_ERROR:
    case RR_ERROR_CODES.SECRET_REF_NOT_FOUND:
    case RR_ERROR_CODES.SECRET_REF_EXPIRED:
    case RR_ERROR_CODES.SECRET_REF_REVOKED:
    case RR_ERROR_CODES.SECRET_REF_SCOPE_MISMATCH:
    case RR_ERROR_CODES.SECRET_REF_INVALID:
    case RR_ERROR_CODES.OUTPUT_VALIDATION_FAILED:
    case RR_ERROR_CODES.UNSUPPORTED_NODE:
    case RR_ERROR_CODES.DAG_INVALID:
    case RR_ERROR_CODES.DAG_CYCLE:
      return "validation";
    case RR_ERROR_CODES.PERMISSION_DENIED:
      return "safety";
    case RR_ERROR_CODES.TAB_NOT_FOUND:
    case RR_ERROR_CODES.FRAME_NOT_FOUND:
      return "capability";
    case RR_ERROR_CODES.RESOURCE_LIMIT_EXCEEDED:
      return "resource";
    case RR_ERROR_CODES.TIMEOUT:
    case RR_ERROR_CODES.TARGET_NOT_FOUND:
    case RR_ERROR_CODES.ELEMENT_NOT_VISIBLE:
    case RR_ERROR_CODES.NAVIGATION_FAILED:
    case RR_ERROR_CODES.NETWORK_REQUEST_FAILED:
    case RR_ERROR_CODES.TOOL_ERROR:
    case RR_ERROR_CODES.SCRIPT_FAILED:
    case RR_ERROR_CODES.RUN_CANCELED:
    case RR_ERROR_CODES.RUN_PAUSED:
    case RR_ERROR_CODES.INTERNAL:
    case RR_ERROR_CODES.INVARIANT_VIOLATION:
    default:
      return "runtime";
  }
}

function inferRetryable(code: string, error: RRError | undefined): boolean {
  if (typeof error?.retryable === "boolean") {
    return error.retryable;
  }
  return (
    code === RR_ERROR_CODES.TIMEOUT ||
    code === RR_ERROR_CODES.TAB_NOT_FOUND ||
    code === RR_ERROR_CODES.FRAME_NOT_FOUND ||
    code === RR_ERROR_CODES.TARGET_NOT_FOUND ||
    code === RR_ERROR_CODES.ELEMENT_NOT_VISIBLE ||
    code === RR_ERROR_CODES.NAVIGATION_FAILED ||
    code === RR_ERROR_CODES.NETWORK_REQUEST_FAILED
  );
}

function findFailureEvent(events: RunEvent[]):
  | Extract<RunEvent, { type: "node.failed" | "run.failed" }>
  | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "node.failed" || event?.type === "run.failed") {
      return event;
    }
  }
  return undefined;
}

function buildStandardRunError(
  run: RunRecordV3,
  events: RunEvent[],
):
  | {
      code: string;
      category: StandardRunErrorCategory;
      retryable: boolean;
      message: string;
      nodeId?: string;
      data?: unknown;
    }
  | undefined {
  const failureEvent = findFailureEvent(events);
  const error = run.error ?? failureEvent?.error;
  const nodeId =
    run.currentNodeId ??
    (failureEvent && "nodeId" in failureEvent ? failureEvent.nodeId : undefined);

  if (!error && run.status === "canceled") {
    return {
      code: RR_ERROR_CODES.RUN_CANCELED,
      category: "runtime",
      retryable: false,
      message: "Run was canceled",
      ...(nodeId ? { nodeId } : {}),
    };
  }
  if (!error || run.status !== "failed") {
    return undefined;
  }

  return {
    code: error.code,
    category: classifyRunErrorCategory(error.code),
    retryable: inferRetryable(error.code, error),
    message: error.message,
    ...(nodeId ? { nodeId } : {}),
    ...(error.data !== undefined ? { data: error.data } : {}),
  };
}

function summarizeEvents(events: RunEvent[]): RunResult["eventSummary"] {
  return {
    totalEvents: events.length,
    nodeEvents: events.filter((event) => event.type.startsWith("node.")).length,
    artifactEvents: events.filter((event) => event.type.startsWith("artifact.")).length,
    ...(events.length > 0 ? { lastSeq: events[events.length - 1].seq } : {}),
  };
}

export function buildCompatRunResult(
  run: RunRecordV3,
  events: RunEvent[],
): RunResult {
  const logs = toRunLogEntries(events);
  const nodeEntries = logs.filter(
    (entry) => entry.stepId.startsWith("log_") === false,
  );
  const successCount = nodeEntries.filter(
    (entry) => entry.status === "success",
  ).length;
  const failedCount = nodeEntries.filter(
    (entry) => entry.status === "failed",
  ).length;
  const total = nodeEntries.length;
  const error = buildStandardRunError(run, events);
  const currentNodeId = run.currentNodeId ?? error?.nodeId;
  const isSuccessfulTerminal =
    run.status === "succeeded" || run.status === "stopped_at_boundary";

  return {
    runId: run.id,
    flowId: run.flowId,
    success: isSuccessfulTerminal,
    status: run.status,
    ...(currentNodeId ? { currentNodeId } : {}),
    ...(error?.nodeId ? { failedNodeId: error.nodeId } : {}),
    ...(error ? { errorCode: error.code, error } : {}),
    ...(typeof run.tabId === "number" ? { tabId: run.tabId } : {}),
    summary: {
      total,
      success: successCount,
      failed: failedCount,
      tookMs: run.tookMs ?? 0,
    },
    eventSummary: summarizeEvents(events),
    outputs: run.outputs ?? null,
    logs,
    paused: run.status === "paused",
    ...(error
      ? {
          debug: {
            debugTool: "workflow_debug_view",
            debugArgs: {
              runId: run.id,
              flowId: run.flowId,
              ...(error.nodeId ? { nodeId: error.nodeId } : {}),
              maxEvents: 200,
              includeArtifacts: true,
            },
          },
        }
      : {}),
  };
}

export async function enqueueRunAndWait(input: {
  flowId: FlowId;
  expectedRevision?: string;
  tabId?: number;
  tabTarget?: RunTargetPreference;
  args?: JsonObject;
  execution?: ExecutionFlags;
  startUrl?: string;
  refresh?: boolean;
  startNodeId?: string;
  stopBeforeNodeId?: string;
  endNodeId?: string;
  timeoutMs?: number;
}): Promise<{ run: RunRecordV3; events: RunEvent[]; result: RunResult }> {
  const runtime = await ensureV3Runtime();
  const resolvedTabId = await resolveRunTargetTab({
    tabId: input.tabId,
    tabTarget: input.tabTarget,
    startUrl: input.startUrl,
    refresh: input.refresh,
    execution: input.execution,
  });
  const { runId } = await enqueueRun(
    {
      storage: runtime.storage,
      events: runtime.events,
      scheduler: runtime.scheduler,
    },
    {
      flowId: input.flowId,
      expectedRevision: input.expectedRevision,
      tabId: resolvedTabId,
      args: input.args,
      execution: input.execution,
      startNodeId: input.startNodeId as FlowV3["entryNodeId"] | undefined,
      stopBeforeNodeId: input.stopBeforeNodeId as FlowV3["entryNodeId"] | undefined,
      endNodeId: input.endNodeId as FlowV3["entryNodeId"] | undefined,
    },
  );

  const timeoutMs = Math.max(1_000, input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;

  let run: RunRecordV3 | null = null;
  while (Date.now() < deadline) {
    run = await runtime.storage.runs.get(runId as RunId);
    if (run && isTerminalStatus(run.status)) {
      const events = await runtime.storage.events.list(run.id);
      return {
        run,
        events,
        result: buildCompatRunResult(run, events),
      };
    }
    await sleep(RUN_POLL_INTERVAL_MS);
  }

  throw new Error(`Run "${runId}" did not finish within ${timeoutMs}ms`);
}

export async function exportFlowJson(flowId: string): Promise<string> {
  const runtime = await ensureV3Runtime();
  const flow = await runtime.storage.flows.get(flowId as FlowId);
  if (!flow) {
    throw new Error(`Flow "${flowId}" not found`);
  }
  return JSON.stringify(flow, null, 2);
}

export async function exportAllFlowsJson(): Promise<string> {
  const runtime = await ensureV3Runtime();
  const flows = await runtime.storage.flows.list();
  return JSON.stringify({ flows }, null, 2);
}
