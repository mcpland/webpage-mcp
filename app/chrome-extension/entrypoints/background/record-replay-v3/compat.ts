import type {
  Flow as CompatFlow,
  RunLogEntry,
  RunResult,
} from "@/common/workflow-compat-types";
import type { FlowV3 } from "./domain/flow";
import { FLOW_SCHEMA_VERSION, type FlowMeta } from "./domain/flow";
import type { RunEvent, RunRecordV3 } from "./domain/events";
import { isTerminalStatus } from "./domain/events";
import type { FlowId, RunId } from "./domain/ids";
import type { JsonObject } from "./domain/json";
import { bootstrapV3, type V3Runtime } from "./bootstrap";
import { enqueueRun } from "./engine/queue/enqueue-run";
import { isV3UnsupportedNodeType } from "@/entrypoints/shared/utils/v3-authoring";
import {
  ensurePublishedSlugAvailable,
  normalizeToolSlug,
} from "./flows/publish";
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

export async function saveFlowToV3(rawFlow: unknown): Promise<FlowV3> {
  const runtime = await ensureV3Runtime();
  const nowIso = new Date().toISOString();

  let flow = isFlowV3Object(rawFlow)
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

  const existing = await runtime.storage.flows.get(flow.id as FlowId);
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
    ensurePublishedSlugAvailable(
      await runtime.storage.flows.list(),
      flow.id as FlowId,
      normalizeToolSlug(flow.meta.tool.slug, flow.name),
    );
  }
  await runtime.storage.flows.save(flow);
  return flow;
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

  return {
    runId: run.id,
    success: run.status === "succeeded",
    ...(typeof run.tabId === "number" ? { tabId: run.tabId } : {}),
    summary: {
      total,
      success: successCount,
      failed: failedCount,
      tookMs: run.tookMs ?? 0,
    },
    outputs: run.outputs ?? null,
    logs,
    paused: run.status === "paused",
  };
}

export async function enqueueRunAndWait(input: {
  flowId: FlowId;
  tabId?: number;
  tabTarget?: RunTargetPreference;
  args?: JsonObject;
  execution?: ExecutionFlags;
  startUrl?: string;
  refresh?: boolean;
  startNodeId?: string;
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
      tabId: resolvedTabId,
      args: input.args,
      execution: input.execution,
      startNodeId: input.startNodeId as FlowV3["entryNodeId"] | undefined,
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
