import type { FlowV3 } from "../record-replay-v3/domain/flow";
import { RR_ERROR_CODES } from "../record-replay-v3/domain/errors";
import {
  getEventErrorCode,
  getEventNodeId,
  getNodeTarget,
  getPrimarySelectorFromTarget,
} from "./flow-selector-repair";
import type {
  WaitRepairPlan,
  WorkflowRepairChange,
  WorkflowRepairRecommendation,
  WorkflowWaitConditionPatch,
} from "./flow-repair-types";

interface WaitRepairDebugRun {
  id: string;
  status: string;
  currentNodeId?: string;
  error?: unknown;
  events: Array<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getSanitizedErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function getIncomingEdges(flow: FlowV3, nodeId: string): FlowV3["edges"] {
  return (Array.isArray(flow.edges) ? flow.edges : []).filter(
    (edge) => edge.to === nodeId,
  );
}

export function getOutgoingEdges(
  flow: FlowV3,
  nodeId: string,
): FlowV3["edges"] {
  return (Array.isArray(flow.edges) ? flow.edges : []).filter(
    (edge) => edge.from === nodeId,
  );
}

function createUniqueFlowId(flow: FlowV3, prefix: string): string {
  const usedNodeIds = new Set(
    (Array.isArray(flow.nodes) ? flow.nodes : []).map((node) => node.id),
  );
  const usedEdgeIds = new Set(
    (Array.isArray(flow.edges) ? flow.edges : []).map((edge) => edge.id),
  );
  const normalized =
    prefix.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "repair";
  let candidate = normalized;
  let counter = 1;
  while (
    usedNodeIds.has(candidate as FlowV3["entryNodeId"]) ||
    usedEdgeIds.has(candidate as FlowV3["edges"][number]["id"])
  ) {
    counter += 1;
    candidate = `${normalized}-${counter}`;
  }
  return candidate;
}

function waitConditionsEqual(
  left: WorkflowWaitConditionPatch | undefined,
  right: WorkflowWaitConditionPatch | undefined,
): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "selector" && right.kind === "selector") {
    return (
      left.selector === right.selector &&
      (left.visible !== false) === (right.visible !== false)
    );
  }
  if (left.kind === "networkIdle" && right.kind === "networkIdle") {
    return (left.idleMs ?? 750) === (right.idleMs ?? 750);
  }
  return true;
}

function getWaitConditionFromNode(
  node: FlowV3["nodes"][number] | undefined,
): WorkflowWaitConditionPatch | undefined {
  if (!node || node.kind !== "wait" || !isRecord(node.config)) return undefined;
  const condition = node.config.condition;
  if (!isRecord(condition) || typeof condition.kind !== "string")
    return undefined;
  if (condition.kind === "navigation") return { kind: "navigation" };
  if (condition.kind === "networkIdle") {
    return {
      kind: "networkIdle",
      ...(typeof condition.idleMs === "number"
        ? { idleMs: condition.idleMs }
        : {}),
    };
  }
  if (condition.kind === "selector" && typeof condition.selector === "string") {
    return {
      kind: "selector",
      selector: condition.selector,
      ...(condition.visible === false ? { visible: false } : {}),
    };
  }
  return undefined;
}

function hasEquivalentWaitBefore(
  flow: FlowV3,
  nodeId: string,
  condition: WorkflowWaitConditionPatch,
): boolean {
  const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
  const incomingWaits = getIncomingEdges(flow, nodeId)
    .map((edge) => nodes.find((node) => node.id === edge.from))
    .filter((node): node is FlowV3["nodes"][number] => Boolean(node));
  if (flow.entryNodeId === nodeId) {
    const entryWait = nodes.find(
      (node) => node.id === flow.entryNodeId && node.kind === "wait",
    );
    if (
      entryWait &&
      getOutgoingEdges(flow, entryWait.id).some((edge) => edge.to === nodeId)
    ) {
      incomingWaits.push(entryWait);
    }
  }
  return incomingWaits.some((waitNode) =>
    waitConditionsEqual(getWaitConditionFromNode(waitNode), condition),
  );
}

function canInsertWaitBefore(flow: FlowV3, nodeId: string): boolean {
  return (
    flow.entryNodeId === nodeId || getIncomingEdges(flow, nodeId).length > 0
  );
}

function isWaitRepairFailureCode(code: string | undefined): boolean {
  return (
    code === RR_ERROR_CODES.TARGET_NOT_FOUND ||
    code === RR_ERROR_CODES.ELEMENT_NOT_VISIBLE ||
    code === RR_ERROR_CODES.TIMEOUT ||
    code === RR_ERROR_CODES.NAVIGATION_FAILED
  );
}

function failedNodeIdsForWaitRepair(runs: WaitRepairDebugRun[]): Set<string> {
  const nodeIds = new Set<string>();
  for (const run of runs) {
    const runErrorCode = getSanitizedErrorCode(run.error);
    if (
      run.status === "failed" &&
      run.currentNodeId &&
      isWaitRepairFailureCode(runErrorCode)
    ) {
      nodeIds.add(run.currentNodeId);
    }
    for (const event of run.events) {
      if (
        getEventNodeId(event) &&
        isWaitRepairFailureCode(getEventErrorCode(event))
      ) {
        nodeIds.add(getEventNodeId(event)!);
      }
    }
  }
  return nodeIds;
}

function buildSelectorWaitPlanFromEvent(
  run: WaitRepairDebugRun,
  event: Record<string, unknown>,
  nodeId: string,
): WaitRepairPlan | undefined {
  if (event.type !== "dom.visibility" || getEventNodeId(event) !== nodeId)
    return undefined;
  if (typeof event.selector !== "string" || !event.selector.trim())
    return undefined;
  if (event.status !== "appeared" && event.status !== "stable")
    return undefined;
  if (typeof event.matchCount === "number" && event.matchCount < 1)
    return undefined;
  return {
    op: "addWaitBefore",
    nodeId,
    status: "suggestion",
    reason:
      "The failed target was later observed as visible; add a bounded selector wait before retrying the action.",
    confidence: 0.92,
    condition: {
      kind: "selector",
      selector: event.selector.trim(),
      visible: true,
    },
    evidence: {
      runId: run.id,
      observedNodeId: nodeId,
      eventType: "dom.visibility",
      status: typeof event.status === "string" ? event.status : undefined,
      selector: event.selector.trim(),
      ...(typeof event.matchCount === "number"
        ? { matchCount: event.matchCount }
        : {}),
    },
  };
}

function buildNavigationWaitPlanFromEvent(
  run: WaitRepairDebugRun,
  event: Record<string, unknown>,
  nodeId: string,
  observedNodeIds: ReadonlySet<string>,
): WaitRepairPlan | undefined {
  if (event.type !== "navigation.observed") return undefined;
  const observedNodeId = getEventNodeId(event);
  if (!observedNodeId || !observedNodeIds.has(observedNodeId)) return undefined;
  if (event.status !== "completed") return undefined;
  const beforeUrl =
    typeof event.beforeUrl === "string" ? event.beforeUrl : undefined;
  const afterUrl =
    typeof event.afterUrl === "string" ? event.afterUrl : undefined;
  if (!beforeUrl || !afterUrl || beforeUrl === afterUrl) return undefined;
  return {
    op: "addWaitBefore",
    nodeId,
    status: "suggestion",
    reason:
      "A preceding step changed the page URL before this failure; add a bounded navigation wait.",
    confidence: 0.88,
    condition: { kind: "navigation" },
    evidence: {
      runId: run.id,
      observedNodeId,
      eventType: "navigation.observed",
      status: "completed",
      beforeUrl,
      afterUrl,
    },
  };
}

function buildNetworkIdleWaitPlanFromEvent(
  run: WaitRepairDebugRun,
  event: Record<string, unknown>,
  nodeId: string,
  observedNodeIds: ReadonlySet<string>,
): WaitRepairPlan | undefined {
  if (event.type !== "network.observed") return undefined;
  const observedNodeId = getEventNodeId(event);
  if (!observedNodeId || !observedNodeIds.has(observedNodeId)) return undefined;
  if (event.currentFrame !== true || typeof event.endedAt !== "number")
    return undefined;
  const resourceType =
    typeof event.resourceType === "string" ? event.resourceType : undefined;
  const longLived =
    event.longLived === true ||
    resourceType === "websocket" ||
    resourceType === "eventsource";
  const requestGroup =
    typeof event.requestGroup === "string" ? event.requestGroup.trim() : "";
  const quietWindowMs =
    typeof event.quietWindowMs === "number" &&
    Number.isFinite(event.quietWindowMs)
      ? Math.max(0, Math.floor(event.quietWindowMs))
      : undefined;
  const hasRelevantRequestGroup =
    requestGroup === "relevant" ||
    requestGroup === "current-node" ||
    requestGroup === "current-frame";
  const hasQuietWindow = quietWindowMs !== undefined && quietWindowMs >= 750;
  const strongEvidence =
    !longLived && hasRelevantRequestGroup && hasQuietWindow;
  return {
    op: "addWaitBefore",
    nodeId,
    status: strongEvidence ? "autoPatch" : "suggestion",
    reason: strongEvidence
      ? "A preceding step produced relevant current-frame network activity followed by a bounded quiet window."
      : "A preceding step produced current-frame network activity, but relevant request group and quiet-window evidence are required before automatic network-idle repair.",
    confidence: strongEvidence ? 0.9 : 0.72,
    condition: { kind: "networkIdle", idleMs: quietWindowMs ?? 750 },
    evidence: {
      runId: run.id,
      observedNodeId,
      eventType: "network.observed",
      resourceType,
      currentFrame: true,
      ...(requestGroup ? { requestGroup } : {}),
      ...(quietWindowMs !== undefined ? { quietWindowMs } : {}),
      ...(longLived ? { longLived } : {}),
    },
  };
}

function chooseWaitRepairObservation(
  flow: FlowV3,
  runs: WaitRepairDebugRun[],
  nodeId: string,
): WaitRepairPlan | undefined {
  const predecessorIds = new Set(
    getIncomingEdges(flow, nodeId).map((edge) => edge.from),
  );
  const observedNodeIds = new Set<string>([nodeId, ...predecessorIds]);
  const candidates: WaitRepairPlan[] = [];
  for (const run of runs) {
    for (const event of run.events) {
      const selectorPlan = buildSelectorWaitPlanFromEvent(run, event, nodeId);
      if (selectorPlan) candidates.push(selectorPlan);
      const navigationPlan = buildNavigationWaitPlanFromEvent(
        run,
        event,
        nodeId,
        observedNodeIds,
      );
      if (navigationPlan) candidates.push(navigationPlan);
      const networkPlan = buildNetworkIdleWaitPlanFromEvent(
        run,
        event,
        nodeId,
        observedNodeIds,
      );
      if (networkPlan) candidates.push(networkPlan);
    }
  }
  return candidates.sort(
    (left, right) => right.confidence - left.confidence,
  )[0];
}

export function planWaitRepairs(
  flow: FlowV3,
  runs: WaitRepairDebugRun[],
): WaitRepairPlan[] {
  const plans: WaitRepairPlan[] = [];
  const failedNodeIds = failedNodeIdsForWaitRepair(runs);
  for (const nodeId of failedNodeIds) {
    const node = flow.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.kind === "wait") continue;
    const observationPlan = chooseWaitRepairObservation(flow, runs, nodeId);
    if (!observationPlan) {
      plans.push({
        op: "addWaitBefore",
        nodeId,
        status: "suggestion",
        reason:
          "Recent failures look timing-related, but no navigation, network, or DOM visibility observation is available for a safe automatic wait patch.",
        confidence: 0.35,
        condition: {
          kind: "selector",
          selector: getPrimarySelectorFromTarget(getNodeTarget(node)) ?? "",
          visible: true,
        },
        evidence: {},
      });
      continue;
    }
    if (
      observationPlan.confidence >= 0.85 &&
      canInsertWaitBefore(flow, nodeId) &&
      !hasEquivalentWaitBefore(flow, nodeId, observationPlan.condition)
    ) {
      observationPlan.status = "autoPatch";
    }
    plans.push(observationPlan);
  }
  return plans;
}

export function buildWaitRepairRecommendations(
  plans: WaitRepairPlan[],
): WorkflowRepairRecommendation[] {
  return plans.map((plan) => ({
    severity: plan.status === "autoPatch" ? "info" : "warning",
    code:
      plan.status === "autoPatch"
        ? "bounded_wait_patch_available"
        : "bounded_wait_suggestion",
    message:
      plan.status === "autoPatch"
        ? `Observed timing evidence supports adding a bounded wait before ${plan.nodeId}; workflow_stabilize can apply and validate it.`
        : `A bounded wait before ${plan.nodeId} is suggested, but stronger observations or graph context are required before automatic patching.`,
    nodeId: plan.nodeId,
    ...(plan.status === "autoPatch" ? { autoFix: "wait_repair" as const } : {}),
  }));
}

function insertWaitBeforeNode(
  flow: FlowV3,
  plan: WaitRepairPlan,
): WorkflowRepairChange | undefined {
  if (plan.status !== "autoPatch") return undefined;
  const targetNode = flow.nodes.find((node) => node.id === plan.nodeId);
  if (!targetNode || !canInsertWaitBefore(flow, plan.nodeId)) return undefined;
  if (hasEquivalentWaitBefore(flow, plan.nodeId, plan.condition))
    return undefined;

  const waitNodeId = createUniqueFlowId(flow, `wait-before-${plan.nodeId}`);
  const waitEdgeId = createUniqueFlowId(
    flow,
    `edge-${waitNodeId}-${plan.nodeId}`,
  );
  const waitNode: FlowV3["nodes"][number] = {
    id: waitNodeId as FlowV3["entryNodeId"],
    kind: "wait",
    name: `Wait before ${targetNode.name || targetNode.kind}`,
    config: { condition: plan.condition },
  };
  const targetIndex = flow.nodes.findIndex((node) => node.id === plan.nodeId);
  flow.nodes.splice(
    targetIndex >= 0 ? targetIndex : flow.nodes.length,
    0,
    waitNode,
  );

  const incoming = getIncomingEdges(flow, plan.nodeId);
  if (incoming.length > 0) {
    for (const edge of flow.edges) {
      if (edge.to === plan.nodeId) {
        edge.to = waitNodeId as FlowV3["entryNodeId"];
      }
    }
  }
  if (flow.entryNodeId === plan.nodeId) {
    flow.entryNodeId = waitNodeId as FlowV3["entryNodeId"];
  }
  flow.edges.push({
    id: waitEdgeId as FlowV3["edges"][number]["id"],
    from: waitNodeId as FlowV3["entryNodeId"],
    to: plan.nodeId as FlowV3["entryNodeId"],
  });

  return {
    code: "bounded_wait_added",
    message: `Added a bounded ${plan.condition.kind} wait before ${plan.nodeId}.`,
    nodeId: plan.nodeId,
    reason: plan.reason,
    confidence: plan.confidence,
    patch: {
      op: "addWaitBefore",
      nodeId: plan.nodeId,
      waitNodeId,
      condition: plan.condition,
      confidence: plan.confidence,
      evidence: plan.evidence,
    },
  };
}

export function applyWaitRepairPlans(
  flow: FlowV3,
  plans: WaitRepairPlan[],
): WorkflowRepairChange[] {
  const changes: WorkflowRepairChange[] = [];
  for (const plan of plans) {
    const change = insertWaitBeforeNode(flow, plan);
    if (change) changes.push(change);
  }
  return changes;
}
