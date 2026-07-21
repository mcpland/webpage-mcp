import { createErrorResponse, type ToolResult } from "@/common/tool-handler";
import {
  TOOL_NAMES,
  WEBPAGE_MCP_CAPABILITY_VERSION,
  WEBPAGE_MCP_PROTOCOL_VERSION,
} from "webpage-mcp-shared";

import {
  FLOW_DSL_VERSION,
  FLOW_NODE_SEMANTICS_VERSION,
  type FlowV3,
} from "../record-replay-v3/domain/flow";
import type { RunRecordV3 } from "../record-replay-v3/domain/events";
import type { FlowId } from "../record-replay-v3/domain/ids";
import { RR_ERROR_CODES } from "../record-replay-v3/domain/errors";
import { createStoragePort } from "../record-replay-v3";
import {
  buildWorkflowQualitySummary,
  calculateWorkflowRevision,
  getPublishedFlowInfo,
} from "../record-replay-v3/flows/publish";
import {
  classifyWorkflowRisk,
  summarizeWorkflowSideEffects,
} from "./flow-risk-analysis";

const WORKFLOW_RELEASE_CHECKLIST_STORE_KEY =
  "webpageMcpWorkflowReleaseChecklists";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function roundScore(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(4));
}

function roundMetric(value: number): number {
  return Number(Math.max(0, value).toFixed(4));
}

function isQuotaLikeErrorCode(code: string | undefined): boolean {
  return Boolean(
    code &&
    /(quota|rate.?limit|resource.?exhausted|storage.?limit|limit.?exceeded)/i.test(
      code,
    ),
  );
}

async function resolveFlowForWorkflowTool(
  args: unknown,
): Promise<FlowV3 | null> {
  const record = isRecord(args) ? args : {};
  const storage = createStoragePort();
  const flowId = typeof record.flowId === "string" ? record.flowId.trim() : "";
  if (flowId) return storage.flows.get(flowId as FlowId);

  const workflow =
    typeof record.workflow === "string" ? record.workflow.trim() : "";
  if (!workflow) return null;

  const flows = await storage.flows.list();
  return (
    flows.find((flow) => getPublishedFlowInfo(flow)?.slug === workflow) ?? null
  );
}

type WorkflowReleaseReadinessStatus = "ready" | "warning_beta" | "blocked";
type WorkflowReleaseChecklistItemStatus = "pass" | "warning" | "blocked";

interface WorkflowReleaseChecklistItem {
  id: string;
  status: WorkflowReleaseChecklistItemStatus;
  summary: string;
  evidence: Record<string, unknown>;
  nextActions?: string[];
}

interface WorkflowReleaseEvidence {
  pairedTokenBaselineCount: number;
  averageTokenReduction: number | null;
  safetyReviewCompleted: boolean;
  browserE2eCompleted: boolean;
  chaosUpgradeCompleted: boolean;
  docsUpdated: boolean;
  killSwitchVerified: boolean;
  links: string[];
}

const RELEASE_WINDOW_MS = {
  sevenDays: 7 * 24 * 60 * 60 * 1000,
  thirtyDays: 30 * 24 * 60 * 60 * 1000,
} as const;

function clampReleaseNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function normalizeReleaseEvidence(value: unknown): WorkflowReleaseEvidence {
  const evidence = isRecord(value) ? value : {};
  const links = Array.isArray(evidence.links)
    ? evidence.links.filter(
        (link): link is string =>
          typeof link === "string" && link.trim().length > 0,
      )
    : [];
  const averageTokenReduction =
    typeof evidence.averageTokenReduction === "number" &&
    Number.isFinite(evidence.averageTokenReduction)
      ? roundScore(evidence.averageTokenReduction)
      : null;
  return {
    pairedTokenBaselineCount: Math.max(
      0,
      Math.floor(
        typeof evidence.pairedTokenBaselineCount === "number" &&
          Number.isFinite(evidence.pairedTokenBaselineCount)
          ? evidence.pairedTokenBaselineCount
          : 0,
      ),
    ),
    averageTokenReduction,
    safetyReviewCompleted: evidence.safetyReviewCompleted === true,
    browserE2eCompleted: evidence.browserE2eCompleted === true,
    chaosUpgradeCompleted: evidence.chaosUpgradeCompleted === true,
    docsUpdated: evidence.docsUpdated === true,
    killSwitchVerified: evidence.killSwitchVerified === true,
    links,
  };
}

function checklistStatus(
  unmet: boolean,
  defaultOn: boolean,
): WorkflowReleaseChecklistItemStatus {
  if (!unmet) {
    return "pass";
  }
  return defaultOn ? "blocked" : "warning";
}

function createChecklistItem(options: {
  id: string;
  unmet: boolean;
  defaultOn: boolean;
  summary: string;
  evidence: Record<string, unknown>;
  nextActions?: string[];
}): WorkflowReleaseChecklistItem {
  return {
    id: options.id,
    status: checklistStatus(options.unmet, options.defaultOn),
    summary: options.summary,
    evidence: options.evidence,
    ...(options.nextActions && options.nextActions.length > 0
      ? { nextActions: options.nextActions }
      : {}),
  };
}

function percentile(values: number[], p: number): number | null {
  const usable = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (usable.length === 0) {
    return null;
  }
  const index = Math.min(
    usable.length - 1,
    Math.max(0, Math.ceil((p / 100) * usable.length) - 1),
  );
  return Math.round(usable[index]);
}

function getRunErrorCode(run: RunRecordV3): string | undefined {
  const error = run.error;
  if (isRecord(error)) {
    const code = error.code;
    if (typeof code === "string" && code.trim()) {
      return code.trim();
    }
  }
  return undefined;
}

function isReliabilityExcludedRun(run: RunRecordV3): boolean {
  if (run.status === "canceled" || run.status === "stopped_at_boundary") {
    return true;
  }
  const code = getRunErrorCode(run);
  return (
    code === RR_ERROR_CODES.RUN_CANCELED ||
    code === RR_ERROR_CODES.PERMISSION_DENIED ||
    code === RR_ERROR_CODES.SECRET_REF_NOT_FOUND ||
    code === RR_ERROR_CODES.SECRET_REF_EXPIRED ||
    code === RR_ERROR_CODES.SECRET_REF_REVOKED ||
    code === RR_ERROR_CODES.STALE_WORKFLOW_DESCRIPTOR
  );
}

function isTerminalReleaseRun(run: RunRecordV3): boolean {
  return (
    run.status === "succeeded" ||
    run.status === "failed" ||
    run.status === "canceled" ||
    run.status === "stopped_at_boundary"
  );
}

function buildReleaseRunWindowSummary(
  runs: RunRecordV3[],
  options: { nowMs: number; sinceMs?: number },
): Record<string, unknown> {
  const scoped = options.sinceMs
    ? runs.filter((run) => run.createdAt >= options.sinceMs!)
    : runs;
  const terminal = scoped.filter(isTerminalReleaseRun);
  const denominator = terminal.filter((run) => !isReliabilityExcludedRun(run));
  const succeeded = denominator.filter((run) => run.status === "succeeded");
  const failed = denominator.filter((run) => run.status === "failed");
  const quotaHitCount = terminal.filter((run) =>
    isQuotaLikeErrorCode(getRunErrorCode(run)),
  ).length;
  return {
    totalRuns: scoped.length,
    terminalRuns: terminal.length,
    reliabilityDenominator: denominator.length,
    excludedRuns: Math.max(0, terminal.length - denominator.length),
    successCount: succeeded.length,
    failureCount: failed.length,
    successRate:
      denominator.length > 0
        ? roundMetric(succeeded.length / denominator.length)
        : null,
    failureRate:
      denominator.length > 0
        ? roundMetric(failed.length / denominator.length)
        : null,
    successfulP95Ms: percentile(
      succeeded.map((run) => run.tookMs ?? 0),
      95,
    ),
    failedP95Ms: percentile(
      failed.map((run) => run.tookMs ?? 0),
      95,
    ),
    quotaHitCount,
    lastRunIds: terminal
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5)
      .map((run) => run.id),
    windowEndedAt: new Date(options.nowMs).toISOString(),
  };
}

function summarizeReleaseRepairMetrics(flows: FlowV3[]): {
  applyCount: number;
  falseRepairCount: number;
  falseRepairRate: number | null;
  missingRollbackCount: number;
} {
  const history = flows.flatMap((flow) =>
    Array.isArray(flow.meta?.repairs?.history) ? flow.meta.repairs.history : [],
  );
  const falseRepairCount = history.filter(
    (entry) =>
      typeof entry.beforeQuality === "number" &&
      typeof entry.afterQuality === "number" &&
      entry.afterQuality < entry.beforeQuality,
  ).length;
  return {
    applyCount: history.length,
    falseRepairCount,
    falseRepairRate:
      history.length > 0
        ? roundMetric(falseRepairCount / history.length)
        : null,
    missingRollbackCount: history.filter((entry) => !entry.rollback).length,
  };
}

function summarizeReleaseFlow(flow: FlowV3): Record<string, unknown> {
  const quality = buildWorkflowQualitySummary(flow);
  const sideEffects = summarizeWorkflowSideEffects(flow);
  const risk = flow.meta?.quality?.risk ?? classifyWorkflowRisk(sideEffects);
  return {
    flowId: flow.id,
    workflow: getPublishedFlowInfo(flow)?.slug ?? null,
    revision: calculateWorkflowRevision(flow),
    quality: {
      status: quality.status,
      level: quality.level,
      current: quality.current,
      passRate: quality.passRate,
      countedValidationRuns: quality.countedValidationRuns,
      staleReason: quality.staleReason,
      slo: quality.slo,
      verification: quality.verification,
      warnings: quality.warnings,
    },
    risk,
    runtime: flow.meta?.runtime ?? null,
  };
}

function runtimeMetadataMatchesCurrent(flow: FlowV3): boolean {
  const runtime = flow.meta?.runtime;
  return (
    runtime?.protocolVersion === WEBPAGE_MCP_PROTOCOL_VERSION &&
    runtime?.capabilityVersion === WEBPAGE_MCP_CAPABILITY_VERSION &&
    runtime?.dslVersion === FLOW_DSL_VERSION &&
    runtime?.nodeSemanticsVersion === FLOW_NODE_SEMANTICS_VERSION
  );
}

function collectReleaseAuditEvents(flows: FlowV3[]) {
  return flows.flatMap((flow) =>
    (flow.meta?.audit?.events ?? []).map((event) => ({
      ...event,
      flowId: event.flowId ?? flow.id,
    })),
  );
}

function getMigrationApplyEventsMissingRollback(flows: FlowV3[]): number {
  return collectReleaseAuditEvents(flows).filter((event) => {
    if (
      event.kind !== "schema_migration" ||
      event.reason !== "workflow_migrate_apply"
    ) {
      return false;
    }
    const metadata = event.metadata;
    return !isRecord(metadata) || !isRecord(metadata.rollbackSnapshot);
  }).length;
}

function aggregateCountedValidationRuns(flows: FlowV3[]): number {
  return flows.reduce(
    (sum, flow) =>
      sum + buildWorkflowQualitySummary(flow).countedValidationRuns,
    0,
  );
}

function aggregateWeightedPassRate(flows: FlowV3[]): number | null {
  let counted = 0;
  let passed = 0;
  for (const flow of flows) {
    const quality = buildWorkflowQualitySummary(flow);
    counted += quality.countedValidationRuns;
    passed += quality.passedRuns;
  }
  return counted > 0 ? roundMetric(passed / counted) : null;
}

async function resolveReleaseReadinessFlows(
  args: any,
): Promise<
  | { ok: true; flows: FlowV3[]; scope: Record<string, unknown> }
  | { ok: false; error: string }
> {
  const flowId = typeof args?.flowId === "string" ? args.flowId.trim() : "";
  const workflow =
    typeof args?.workflow === "string" ? args.workflow.trim() : "";
  const all = args?.all !== false;
  if ((flowId && workflow) || ((flowId || workflow) && args?.all === true)) {
    return {
      ok: false,
      error: "Exactly one of flowId, workflow, or all=true may be used.",
    };
  }
  if (!flowId && !workflow && !all) {
    return { ok: false, error: "flowId, workflow, or all=true is required." };
  }

  const storage = createStoragePort();
  if (flowId || workflow) {
    const flow = await resolveFlowForWorkflowTool(args);
    if (!flow) {
      return {
        ok: false,
        error: flowId
          ? `Flow not found: ${flowId}`
          : `Published workflow not found: ${workflow}`,
      };
    }
    return {
      ok: true,
      flows: [flow],
      scope: {
        type: flowId ? "flowId" : "workflow",
        ...(flowId ? { flowId } : { workflow }),
      },
    };
  }

  let flows = await storage.flows.list();
  if (args?.publishedOnly === true) {
    flows = flows.filter((flow) => Boolean(getPublishedFlowInfo(flow)));
  }
  return {
    ok: true,
    flows,
    scope: {
      type: args?.publishedOnly === true ? "published" : "all",
      publishedOnly: args?.publishedOnly === true,
    },
  };
}

async function persistWorkflowReleaseChecklist(
  releaseId: string,
  checklist: Record<string, unknown>,
): Promise<void> {
  const result = (await chrome.storage.local.get(
    WORKFLOW_RELEASE_CHECKLIST_STORE_KEY,
  )) as Record<string, unknown>;
  const rawStore = result?.[WORKFLOW_RELEASE_CHECKLIST_STORE_KEY];
  const store = isRecord(rawStore) ? rawStore : {};
  await chrome.storage.local.set({
    [WORKFLOW_RELEASE_CHECKLIST_STORE_KEY]: {
      ...store,
      [releaseId]: checklist,
    },
  });
}

export class WorkflowReleaseReadinessTool {
  name = TOOL_NAMES.RECORD_REPLAY.WORKFLOW_RELEASE_READINESS;

  async execute(args: any): Promise<ToolResult> {
    const resolved = await resolveReleaseReadinessFlows(args);
    if (!resolved.ok) {
      return createErrorResponse(resolved.error);
    }

    const defaultOn = args?.defaultOn === true;
    const persist = args?.persist !== false;
    const releaseId =
      typeof args?.releaseId === "string" && args.releaseId.trim()
        ? args.releaseId.trim()
        : `release-${Date.now().toString(36)}`;
    const evidence = normalizeReleaseEvidence(args?.evidence);
    const thresholds = {
      minSafeWorkflowCount: Math.floor(
        clampReleaseNumber(args?.minSafeWorkflowCount, 30, 1, 10_000),
      ),
      minValidationRuns: Math.floor(
        clampReleaseNumber(args?.minValidationRuns, 100, 1, 100_000),
      ),
      minReliability: roundScore(
        clampReleaseNumber(args?.minReliability, 0.99, 0, 1),
      ),
      minTokenReduction: roundScore(
        clampReleaseNumber(args?.minTokenReduction, 0.7, 0, 1),
      ),
      maxFalseRepairRate: roundScore(
        clampReleaseNumber(args?.maxFalseRepairRate, 0.01, 0, 1),
      ),
    };

    const nowMs = Date.now();
    const flows = resolved.flows;
    const flowIds = new Set(flows.map((flow) => String(flow.id)));
    const storage = createStoragePort();
    const runs = (await storage.runs.list()).filter((run) =>
      flowIds.has(String(run.flowId)),
    );
    const qualitySummaries = flows.map((flow) =>
      buildWorkflowQualitySummary(flow),
    );
    const releaseRuns = {
      perRelease: buildReleaseRunWindowSummary(runs, { nowMs }),
      rolling7Days: buildReleaseRunWindowSummary(runs, {
        nowMs,
        sinceMs: nowMs - RELEASE_WINDOW_MS.sevenDays,
      }),
      rolling30Days: buildReleaseRunWindowSummary(runs, {
        nowMs,
        sinceMs: nowMs - RELEASE_WINDOW_MS.thirtyDays,
      }),
    };
    const auditEvents = collectReleaseAuditEvents(flows);
    const repair = summarizeReleaseRepairMetrics(flows);
    const safeIdempotentFlows = flows.filter((flow) => {
      const risk =
        flow.meta?.quality?.risk ??
        classifyWorkflowRisk(summarizeWorkflowSideEffects(flow));
      return risk === "safe" || risk === "idempotent";
    });
    const dangerousOrUnknownFlows = flows.filter((flow) => {
      const risk =
        flow.meta?.quality?.risk ??
        classifyWorkflowRisk(summarizeWorkflowSideEffects(flow));
      return risk === "dangerous" || risk === "unknown";
    });
    const staleWorkflowCount = qualitySummaries.filter(
      (quality) => !quality.current,
    ).length;
    const aggregateValidationRuns = aggregateCountedValidationRuns(flows);
    const aggregatePassRate = aggregateWeightedPassRate(flows);
    const currentRuntimeCount = flows.filter(
      runtimeMetadataMatchesCurrent,
    ).length;
    const missingRuntimeCount = Math.max(0, flows.length - currentRuntimeCount);
    const migrationRollbackMissingCount =
      getMigrationApplyEventsMissingRollback(flows);
    const publishedCount = flows.filter((flow) =>
      Boolean(getPublishedFlowInfo(flow)),
    ).length;
    const approvalAuditCount = auditEvents.filter(
      (event) =>
        event.kind === "approval_use" || event.kind === "approval_revoke",
    ).length;
    const runQuotaHitCount = Object.values(releaseRuns).reduce(
      (sum, windowSummary) => {
        const count = isRecord(windowSummary) ? windowSummary.quotaHitCount : 0;
        return sum + (typeof count === "number" ? count : 0);
      },
      0,
    );
    const unsupportedCapabilityCount = qualitySummaries.reduce(
      (sum, quality) =>
        sum + (quality.capabilities?.unsupportedReasons?.length ?? 0),
      0,
    );

    const sampleReasons: string[] = [];
    if (safeIdempotentFlows.length < thresholds.minSafeWorkflowCount) {
      sampleReasons.push("insufficient_safe_idempotent_workflow_sample");
    }
    if (aggregateValidationRuns < thresholds.minValidationRuns) {
      sampleReasons.push("insufficient_validation_run_sample");
    }
    const sloReasons: string[] = [...sampleReasons];
    if (
      aggregatePassRate !== null &&
      aggregatePassRate < thresholds.minReliability
    ) {
      sloReasons.push("reliability_below_threshold");
    }
    if (
      repair.falseRepairRate !== null &&
      repair.falseRepairRate > thresholds.maxFalseRepairRate
    ) {
      sloReasons.push("false_repair_rate_above_threshold");
    }
    if (
      evidence.pairedTokenBaselineCount <= 0 ||
      evidence.averageTokenReduction === null
    ) {
      sloReasons.push("missing_paired_token_baseline");
    } else if (evidence.averageTokenReduction < thresholds.minTokenReduction) {
      sloReasons.push("token_reduction_below_threshold");
    }

    const checklist: WorkflowReleaseChecklistItem[] = [
      createChecklistItem({
        id: "schema_contract_and_migration",
        unmet:
          flows.length === 0 ||
          missingRuntimeCount > 0 ||
          migrationRollbackMissingCount > 0,
        defaultOn,
        summary:
          missingRuntimeCount === 0 && migrationRollbackMissingCount === 0
            ? "Current protocol, capability, DSL, node semantics, and migration rollback evidence are present."
            : "Runtime metadata or migration rollback evidence is missing.",
        evidence: {
          flowCount: flows.length,
          currentRuntimeCount,
          missingRuntimeCount,
          migrationRollbackMissingCount,
          protocolVersion: WEBPAGE_MCP_PROTOCOL_VERSION,
          capabilityVersion: WEBPAGE_MCP_CAPABILITY_VERSION,
          dslVersion: FLOW_DSL_VERSION,
          nodeSemanticsVersion: FLOW_NODE_SEMANTICS_VERSION,
        },
        nextActions:
          missingRuntimeCount > 0 || migrationRollbackMissingCount > 0
            ? [
                "Run workflow_migrate dry-run/apply and verify rollback snapshots before default-on release.",
              ]
            : undefined,
      }),
      createChecklistItem({
        id: "runtime_metrics_and_slo",
        unmet: sloReasons.length > 0,
        defaultOn,
        summary:
          sloReasons.length === 0
            ? "SLO sample, reliability, token reduction, and false repair thresholds are met."
            : "SLO conclusion is not ready for default-on release.",
        evidence: {
          conclusion:
            sloReasons.length === 0
              ? "met"
              : defaultOn
                ? "blocked"
                : "warning_beta",
          reasons: sloReasons,
          thresholds,
          safeIdempotentWorkflowCount: safeIdempotentFlows.length,
          countedValidationRuns: aggregateValidationRuns,
          aggregatePassRate,
          repair,
          releaseRuns,
          pairedTokenBaselineCount: evidence.pairedTokenBaselineCount,
          averageTokenReduction: evidence.averageTokenReduction,
          evidenceLinks: evidence.links,
        },
        nextActions:
          sloReasons.length > 0
            ? [
                "Collect paired transcript token baselines and enough compatible validation runs before claiming default-on readiness.",
              ]
            : undefined,
      }),
      createChecklistItem({
        id: "safety_review_and_approval",
        unmet:
          evidence.safetyReviewCompleted !== true ||
          (dangerousOrUnknownFlows.length > 0 && approvalAuditCount === 0),
        defaultOn,
        summary:
          evidence.safetyReviewCompleted &&
          (dangerousOrUnknownFlows.length === 0 || approvalAuditCount > 0)
            ? "Safety review and approval provenance evidence are present."
            : "Safety review or dangerous/unknown approval provenance is missing.",
        evidence: {
          safetyReviewCompleted: evidence.safetyReviewCompleted,
          dangerousOrUnknownWorkflowCount: dangerousOrUnknownFlows.length,
          approvalAuditCount,
          dangerousOrUnknownFlowIds: dangerousOrUnknownFlows.map(
            (flow) => flow.id,
          ),
        },
        nextActions:
          evidence.safetyReviewCompleted !== true ||
          (dangerousOrUnknownFlows.length > 0 && approvalAuditCount === 0)
            ? [
                "Complete safety review and record approval provenance for dangerous or unknown workflows.",
              ]
            : undefined,
      }),
      createChecklistItem({
        id: "audit_and_runtime_observability",
        unmet:
          auditEvents.length === 0 ||
          runQuotaHitCount > 0 ||
          unsupportedCapabilityCount > 0,
        defaultOn,
        summary:
          auditEvents.length > 0 &&
          runQuotaHitCount === 0 &&
          unsupportedCapabilityCount === 0
            ? "Audit and runtime observability evidence are present without quota or capability gaps."
            : "Audit events, quota health, or capability coverage need attention.",
        evidence: {
          auditEventCount: auditEvents.length,
          quotaHitCount: runQuotaHitCount,
          unsupportedCapabilityCount,
          staleWorkflowCount,
          lastAuditEventIds: auditEvents.slice(-5).map((event) => event.id),
        },
        nextActions:
          auditEvents.length === 0 ||
          runQuotaHitCount > 0 ||
          unsupportedCapabilityCount > 0
            ? [
                "Verify audit coverage and resolve quota/capability warnings before default-on release.",
              ]
            : undefined,
      }),
      createChecklistItem({
        id: "rollback_and_recovery",
        unmet: repair.missingRollbackCount > 0,
        defaultOn,
        summary:
          repair.missingRollbackCount === 0
            ? "Workflow metadata rollback evidence is present for recorded repair history."
            : "Some repair history entries lack rollback metadata.",
        evidence: {
          repairApplyCount: repair.applyCount,
          missingRepairRollbackCount: repair.missingRollbackCount,
          migrationRollbackMissingCount,
          externalSideEffectsReversible: false,
        },
        nextActions:
          repair.missingRollbackCount > 0
            ? [
                "Ensure repair and migration changes include rollback snapshots; document external side effects as non-reversible.",
              ]
            : undefined,
      }),
      createChecklistItem({
        id: "tests_docs_and_kill_switch",
        unmet:
          !evidence.browserE2eCompleted ||
          !evidence.chaosUpgradeCompleted ||
          !evidence.docsUpdated ||
          !evidence.killSwitchVerified,
        defaultOn,
        summary:
          evidence.browserE2eCompleted &&
          evidence.chaosUpgradeCompleted &&
          evidence.docsUpdated &&
          evidence.killSwitchVerified
            ? "Browser e2e, chaos/upgrade, docs, and kill-switch evidence are recorded."
            : "External readiness evidence is incomplete.",
        evidence: {
          browserE2eCompleted: evidence.browserE2eCompleted,
          chaosUpgradeCompleted: evidence.chaosUpgradeCompleted,
          docsUpdated: evidence.docsUpdated,
          killSwitchVerified: evidence.killSwitchVerified,
          evidenceLinks: evidence.links,
        },
        nextActions:
          !evidence.browserE2eCompleted ||
          !evidence.chaosUpgradeCompleted ||
          !evidence.docsUpdated ||
          !evidence.killSwitchVerified
            ? [
                "Attach browser e2e, chaos/upgrade, docs, and kill-switch evidence before default-on release.",
              ]
            : undefined,
      }),
    ];

    const defaultOnAllowed = checklist.every((item) => item.status === "pass");
    const hasBlocked = checklist.some((item) => item.status === "blocked");
    const hasWarnings = checklist.some((item) => item.status === "warning");
    const status: WorkflowReleaseReadinessStatus = defaultOnAllowed
      ? "ready"
      : hasBlocked
        ? "blocked"
        : hasWarnings
          ? "warning_beta"
          : "ready";
    const releaseChecklist = {
      releaseId,
      generatedAt: new Date(nowMs).toISOString(),
      status,
      defaultOnRequested: defaultOn,
      defaultOnAllowed,
      scope: {
        ...resolved.scope,
        flowCount: flows.length,
        publishedCount,
      },
      slo: {
        conclusion:
          sloReasons.length === 0
            ? "met"
            : defaultOn
              ? "blocked"
              : "warning_beta",
        reasons: sloReasons,
        thresholds,
        sample: {
          safeIdempotentWorkflowCount: safeIdempotentFlows.length,
          countedValidationRuns: aggregateValidationRuns,
          insufficientSample: sampleReasons.length > 0,
          reasons: sampleReasons,
        },
        releaseRuns,
        evidence: {
          runIds:
            (releaseRuns.perRelease as { lastRunIds?: string[] }).lastRunIds ??
            [],
          links: evidence.links,
        },
      },
      metrics: {
        workflowRun: releaseRuns,
        passRateByWorkflow: Object.fromEntries(
          flows.map((flow) => {
            const key = getPublishedFlowInfo(flow)?.slug ?? flow.id;
            return [key, buildWorkflowQualitySummary(flow).passRate];
          }),
        ),
        repair,
        quota: {
          hitCount: runQuotaHitCount,
        },
        capability: {
          unsupportedCount: unsupportedCapabilityCount,
        },
        approval: {
          useCount: auditEvents.filter((event) => event.kind === "approval_use")
            .length,
        },
        quality: {
          staleQualityCount: staleWorkflowCount,
        },
        audit: {
          eventCount: auditEvents.length,
        },
      },
      checklist,
      flows: flows.map(summarizeReleaseFlow),
    };

    if (persist) {
      await persistWorkflowReleaseChecklist(releaseId, releaseChecklist);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            releaseId,
            status,
            defaultOnAllowed,
            persisted: persist,
            releaseChecklist,
          }),
        },
      ],
      isError: status === "blocked",
    };
  }
}
