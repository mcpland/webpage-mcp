import {
  createEmptyWorkflowSideEffectSummary,
  isKnownWorkflowSideEffectKind,
  normalizeWorkflowNodeSideEffectProfile,
  type WorkflowSideEffectProfile,
  type WorkflowSideEffectSummary,
} from "webpage-mcp-shared";

import type { FlowV3 } from "../record-replay-v3/domain/flow";
import { redactWorkflowUrl } from "./flow-redaction";

export type WorkflowRiskProfile =
  | "safe"
  | "idempotent"
  | "dangerous"
  | "unknown";

type WorkflowSegmentBoundarySource = "static" | "runtime" | "override";

export interface WorkflowSegmentPlan {
  mode: "none" | "explicit" | "stopBeforeDangerous";
  stopBeforeNodeId?: string;
  endNodeId?: string;
  autoBoundary?: boolean;
  boundaryNodeId?: string;
  boundaryKind?: string;
  boundaryRisk?: WorkflowRiskProfile;
  boundarySource?: WorkflowSegmentBoundarySource;
  ambiguousBoundaryNodeIds?: string[];
}

interface RuntimeSideEffectObservation {
  runId: string;
  eventType: string;
  category: "dangerous" | "unknown";
  reason: string;
  nodeId?: string;
  method?: string;
  resourceType?: string;
  url?: string;
  beforeUrl?: string;
  afterUrl?: string;
}

export interface RuntimeSideEffectEvidence {
  risk: WorkflowRiskProfile;
  summary: WorkflowSideEffectSummary;
  observations: RuntimeSideEffectObservation[];
}

interface RuntimeEvidenceRun {
  id: string;
  events: Array<Record<string, unknown>>;
}

const HTTP_METHODS_WITHOUT_REQUEST_BODY_SIDE_EFFECTS = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "TRACE",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function getNodeSideEffectProfile(
  node: FlowV3["nodes"][number],
): WorkflowSideEffectProfile {
  return normalizeWorkflowNodeSideEffectProfile(
    node.kind,
    node.config,
    node.sideEffect,
  );
}

export function getDisabledWorkflowNodeIds(flow: FlowV3): Set<string> {
  return new Set(
    (Array.isArray(flow.nodes) ? flow.nodes : [])
      .filter((node) => node.disabled === true)
      .map((node) => String(node.id)),
  );
}

export function getPublicNodeExecutionMetadata(node: FlowV3["nodes"][number]): {
  executable?: boolean;
  sideEffect?: WorkflowSideEffectProfile;
} {
  if (node.kind === "trigger" || node.disabled === true) {
    return { executable: false };
  }
  return { sideEffect: getNodeSideEffectProfile(node) };
}

function sideEffectSummaryKeyForRisk(
  risk: WorkflowRiskProfile,
): keyof WorkflowSideEffectSummary {
  return risk === "unknown" ? "unknown" : risk;
}

export function summarizeWorkflowSideEffects(
  flow: FlowV3,
  nodeRiskOverrides: ReadonlyMap<string, WorkflowRiskProfile> = new Map(),
): WorkflowSideEffectSummary {
  const summary = createEmptyWorkflowSideEffectSummary();
  for (const node of Array.isArray(flow.nodes) ? flow.nodes : []) {
    if (node.disabled === true || node.kind === "trigger") continue;
    const override = nodeRiskOverrides.get(String(node.id));
    if (override) {
      summary[sideEffectSummaryKeyForRisk(override)] += 1;
    } else {
      const profile = getNodeSideEffectProfile(node);
      summary[profile.category] += 1;
    }
    if (!override && !isKnownWorkflowSideEffectKind(node.kind)) {
      summary.unknown += 1;
    }
  }
  return summary;
}

export function classifyWorkflowRisk(
  summary: WorkflowSideEffectSummary,
): WorkflowRiskProfile {
  if ((summary.dangerous ?? 0) > 0) return "dangerous";
  if ((summary.unknown ?? 0) > 0) return "unknown";
  if ((summary.idempotent ?? 0) > 0) return "idempotent";
  return "safe";
}

export function riskRank(risk: WorkflowRiskProfile): number {
  switch (risk) {
    case "safe":
      return 0;
    case "idempotent":
      return 1;
    case "dangerous":
      return 2;
    case "unknown":
      return 3;
  }
}

export function maxWorkflowRisk(
  left: WorkflowRiskProfile,
  right: WorkflowRiskProfile,
): WorkflowRiskProfile {
  return riskRank(left) >= riskRank(right) ? left : right;
}

export function mergeWorkflowSideEffectSummaries(
  base: WorkflowSideEffectSummary,
  observed: WorkflowSideEffectSummary,
): WorkflowSideEffectSummary {
  return {
    safe: base.safe + observed.safe,
    idempotent: base.idempotent + observed.idempotent,
    dangerous: base.dangerous + observed.dangerous,
    unknown: base.unknown + observed.unknown,
  };
}

function addRuntimeSideEffectObservation(
  evidence: RuntimeSideEffectEvidence,
  observation: RuntimeSideEffectObservation,
): void {
  evidence.observations.push(observation);
  evidence.summary[observation.category] += 1;
  evidence.risk = maxWorkflowRisk(evidence.risk, observation.category);
}

function normalizedHttpMethod(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export function collectRuntimeSideEffectEvidence(
  runs: RuntimeEvidenceRun[],
  options: { disabledNodeIds?: ReadonlySet<string> } = {},
): RuntimeSideEffectEvidence {
  const evidence: RuntimeSideEffectEvidence = {
    risk: "safe",
    summary: createEmptyWorkflowSideEffectSummary(),
    observations: [],
  };

  for (const run of runs) {
    for (const event of run.events) {
      const nodeId =
        typeof event.nodeId === "string" && event.nodeId.trim()
          ? event.nodeId.trim()
          : undefined;
      if (nodeId && options.disabledNodeIds?.has(nodeId)) continue;

      if (event.type === "network.observed") {
        const method = normalizedHttpMethod(event.method);
        const resourceType =
          typeof event.resourceType === "string"
            ? event.resourceType
            : undefined;
        const url = typeof event.url === "string" ? event.url : undefined;
        if (
          method &&
          !HTTP_METHODS_WITHOUT_REQUEST_BODY_SIDE_EFFECTS.has(method)
        ) {
          addRuntimeSideEffectObservation(evidence, {
            runId: run.id,
            eventType: "network.observed",
            category: "dangerous",
            reason: `Observed mutating network request method ${method}`,
            ...(nodeId ? { nodeId } : {}),
            method,
            ...(resourceType ? { resourceType } : {}),
            ...(url ? { url: redactWorkflowUrl(url) } : {}),
          });
          continue;
        }
        if (resourceType === "websocket" || resourceType === "eventsource") {
          addRuntimeSideEffectObservation(evidence, {
            runId: run.id,
            eventType: "network.observed",
            category: "unknown",
            reason: `Observed long-lived ${resourceType} network activity`,
            ...(nodeId ? { nodeId } : {}),
            ...(method ? { method } : {}),
            resourceType,
            ...(url ? { url: redactWorkflowUrl(url) } : {}),
          });
        }
        continue;
      }

      if (
        event.type !== "navigation.observed" ||
        event.status !== "completed"
      ) {
        continue;
      }
      const beforeUrl =
        typeof event.beforeUrl === "string" ? event.beforeUrl : "";
      const afterUrl = typeof event.afterUrl === "string" ? event.afterUrl : "";
      if (!beforeUrl || !afterUrl || beforeUrl === afterUrl) continue;

      try {
        const before = new URL(beforeUrl);
        const after = new URL(afterUrl);
        if (before.origin !== after.origin) {
          addRuntimeSideEffectObservation(evidence, {
            runId: run.id,
            eventType: "navigation.observed",
            category: "unknown",
            reason: "Observed cross-origin navigation during workflow replay",
            ...(nodeId ? { nodeId } : {}),
            beforeUrl: redactWorkflowUrl(beforeUrl),
            afterUrl: redactWorkflowUrl(afterUrl),
          });
        }
      } catch {
        addRuntimeSideEffectObservation(evidence, {
          runId: run.id,
          eventType: "navigation.observed",
          category: "unknown",
          reason: "Observed navigation with unparseable URL evidence",
          ...(nodeId ? { nodeId } : {}),
          beforeUrl: redactWorkflowUrl(beforeUrl),
          afterUrl: redactWorkflowUrl(afterUrl),
        });
      }
    }
  }

  return { ...evidence, observations: evidence.observations.slice(0, 20) };
}

export function getNodeWorkflowRisk(
  node: FlowV3["nodes"][number],
): WorkflowRiskProfile {
  if (node.kind === "trigger" || node.disabled === true) return "safe";
  if (!isKnownWorkflowSideEffectKind(node.kind)) return "unknown";
  return getNodeSideEffectProfile(node).category;
}

function buildRuntimeNodeRiskMap(
  evidence: RuntimeSideEffectEvidence,
): Map<string, WorkflowRiskProfile> {
  const risks = new Map<string, WorkflowRiskProfile>();
  for (const observation of evidence.observations) {
    if (!observation.nodeId) continue;
    const previous = risks.get(observation.nodeId) ?? "safe";
    risks.set(
      observation.nodeId,
      maxWorkflowRisk(previous, observation.category),
    );
  }
  return risks;
}

function getSegmentBoundaryRisk(
  node: FlowV3["nodes"][number],
  runtimeNodeRisks: Map<string, WorkflowRiskProfile>,
  nodeRiskOverrides: ReadonlyMap<string, WorkflowRiskProfile>,
): { risk: WorkflowRiskProfile; source: WorkflowSegmentBoundarySource } {
  const overrideRisk = nodeRiskOverrides.get(String(node.id));
  const staticRisk = overrideRisk ?? getNodeWorkflowRisk(node);
  const staticSource: WorkflowSegmentBoundarySource = overrideRisk
    ? "override"
    : "static";
  const runtimeRisk = runtimeNodeRisks.get(String(node.id));
  if (runtimeRisk && riskRank(runtimeRisk) > riskRank(staticRisk)) {
    return { risk: runtimeRisk, source: "runtime" };
  }
  return { risk: staticRisk, source: staticSource };
}

function isRiskBoundary(
  node: FlowV3["nodes"][number],
  runtimeNodeRisks: Map<string, WorkflowRiskProfile>,
  nodeRiskOverrides: ReadonlyMap<string, WorkflowRiskProfile>,
): boolean {
  const { risk } = getSegmentBoundaryRisk(
    node,
    runtimeNodeRisks,
    nodeRiskOverrides,
  );
  return risk === "dangerous" || risk === "unknown";
}

function findUniqueFirstRiskBoundary(
  flow: FlowV3,
  runtimeNodeRisks: Map<string, WorkflowRiskProfile>,
  nodeRiskOverrides: ReadonlyMap<string, WorkflowRiskProfile>,
): { node?: FlowV3["nodes"][number]; ambiguousNodeIds?: string[] } {
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const nodeById = new Map(nodes.map((node) => [String(node.id), node]));
  const queue: string[] = [String(flow.entryNodeId)];
  const visited = new Set<string>();
  const boundaryNodeIds = new Set<string>();

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId || visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = nodeById.get(nodeId);
    if (!node) continue;
    if (
      node.disabled !== true &&
      isRiskBoundary(node, runtimeNodeRisks, nodeRiskOverrides)
    ) {
      boundaryNodeIds.add(nodeId);
      continue;
    }
    for (const edge of Array.isArray(flow.edges) ? flow.edges : []) {
      if (String(edge.from) === nodeId && !visited.has(String(edge.to))) {
        queue.push(String(edge.to));
      }
    }
  }

  if (boundaryNodeIds.size === 1) {
    const [nodeId] = boundaryNodeIds;
    return { node: nodeById.get(nodeId) };
  }
  if (boundaryNodeIds.size > 1) {
    return { ambiguousNodeIds: Array.from(boundaryNodeIds).sort() };
  }
  return {};
}

export function buildWorkflowSegmentPlan(
  flow: FlowV3,
  args: unknown,
  runtimeEvidence: RuntimeSideEffectEvidence,
  nodeRiskOverrides: ReadonlyMap<string, WorkflowRiskProfile> = new Map(),
): WorkflowSegmentPlan {
  const record = isRecord(args) ? args : {};
  const safety = isRecord(record.safety) ? record.safety : {};
  const segments = isRecord(safety.segments) ? safety.segments : {};
  if (segments.mode === "explicit") {
    const stopBeforeNodeId =
      typeof segments.stopBeforeNodeId === "string" &&
      segments.stopBeforeNodeId.trim()
        ? segments.stopBeforeNodeId.trim()
        : undefined;
    const endNodeId =
      typeof segments.endNodeId === "string" && segments.endNodeId.trim()
        ? segments.endNodeId.trim()
        : undefined;
    return {
      mode: "explicit",
      ...(stopBeforeNodeId ? { stopBeforeNodeId } : {}),
      ...(endNodeId ? { endNodeId } : {}),
    };
  }

  if (segments.mode !== "stopBeforeDangerous") return { mode: "none" };

  const runtimeNodeRisks = buildRuntimeNodeRiskMap(runtimeEvidence);
  const boundaryResult = findUniqueFirstRiskBoundary(
    flow,
    runtimeNodeRisks,
    nodeRiskOverrides,
  );
  const boundaryNode = boundaryResult.node;
  if (!boundaryNode) {
    return {
      mode: "stopBeforeDangerous",
      ...(boundaryResult.ambiguousNodeIds
        ? { ambiguousBoundaryNodeIds: boundaryResult.ambiguousNodeIds }
        : {}),
    };
  }

  const boundary = getSegmentBoundaryRisk(
    boundaryNode,
    runtimeNodeRisks,
    nodeRiskOverrides,
  );
  return {
    mode: "stopBeforeDangerous",
    stopBeforeNodeId: String(boundaryNode.id),
    autoBoundary: true,
    boundaryNodeId: String(boundaryNode.id),
    boundaryKind: boundaryNode.kind,
    boundaryRisk: boundary.risk,
    boundarySource: boundary.source,
  };
}

export function hasSegmentBoundary(plan: WorkflowSegmentPlan): boolean {
  return Boolean(plan.stopBeforeNodeId || plan.endNodeId);
}

export function isBoundaryStoppedStatus(status: string): boolean {
  return status === "stopped" || status === "stopped_at_boundary";
}
