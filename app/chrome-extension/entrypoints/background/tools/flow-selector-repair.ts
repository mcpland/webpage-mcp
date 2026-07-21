import {
  compareSelectorCandidates,
  computeSelectorStability,
  type SelectorCandidate,
  type SelectorCandidateSource,
  type SelectorStability,
  type SelectorType,
} from "@/shared/selector";

import type { FlowV3 } from "../record-replay-v3/domain/flow";
import { getNodeSideEffectProfile } from "./flow-risk-analysis";
import { isRetryableStabilityErrorCode } from "./flow-retry-policy";
import type {
  SelectorQualityDiagnostic,
  SelectorRepairEvidence,
  SelectorRepairPlan,
  WorkflowRepairChange,
  WorkflowRepairRecommendation,
} from "./flow-repair-types";

interface SelectorDebugRun {
  id: string;
  status: string;
  currentNodeId?: string;
  events: Array<Record<string, unknown>>;
  artifacts?: Array<{ nodeId: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function roundScore(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(4));
}

function getSanitizedErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function getNodeTarget(
  node: FlowV3["nodes"][number],
): Record<string, unknown> | undefined {
  if (!node.config || !isRecord(node.config)) return undefined;
  const target = node.config.target;
  return isRecord(target) ? target : undefined;
}

export function getPrimarySelectorFromTarget(
  target: Record<string, unknown> | undefined,
): string | undefined {
  const selector = target?.selector;
  return typeof selector === "string" && selector.trim()
    ? selector.trim()
    : undefined;
}

function getTargetCandidates(
  target: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  if (!Array.isArray(target?.candidates)) return [];
  return target.candidates.filter(isRecord);
}

function normalizeSelectorType(value: unknown): SelectorType | undefined {
  return value === "css" ||
    value === "xpath" ||
    value === "attr" ||
    value === "aria" ||
    value === "text"
    ? value
    : undefined;
}

function normalizeSelectorStability(
  value: unknown,
): SelectorStability | undefined {
  if (
    !isRecord(value) ||
    typeof value.score !== "number" ||
    !Number.isFinite(value.score)
  ) {
    return undefined;
  }
  return {
    score: roundScore(value.score),
    ...(isRecord(value.signals)
      ? { signals: { ...value.signals } as SelectorStability["signals"] }
      : {}),
    ...(typeof value.note === "string" ? { note: value.note } : {}),
  };
}

function candidateSelectorValue(
  candidate: Record<string, unknown>,
): string | undefined {
  const type = normalizeSelectorType(candidate.type);
  const value = candidate.value;
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (
    (type === "css" || type === "attr") &&
    typeof candidate.selector === "string"
  ) {
    return candidate.selector.trim() || undefined;
  }
  if (type === "xpath" && typeof candidate.xpath === "string") {
    return candidate.xpath.trim() || undefined;
  }
  if (type === "text" && typeof candidate.text === "string") {
    return candidate.text.trim() || undefined;
  }
  if (type === "aria") {
    const role =
      typeof candidate.role === "string" ? candidate.role.trim() : "";
    const name =
      typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (role && name) return `${role}[name=${JSON.stringify(name)}]`;
    if (name) return `aria-label=${JSON.stringify(name)}`;
  }
  return undefined;
}

function toSharedSelectorCandidate(
  candidate: Record<string, unknown>,
): SelectorCandidate | null {
  const type = normalizeSelectorType(candidate.type);
  const value = candidateSelectorValue(candidate);
  if (!type || !value) return null;

  const weight =
    typeof candidate.weight === "number" && Number.isFinite(candidate.weight)
      ? candidate.weight
      : undefined;
  const source: SelectorCandidateSource | undefined =
    candidate.source === "recorded" ||
    candidate.source === "user" ||
    candidate.source === "generated"
      ? candidate.source
      : undefined;
  const strategy =
    typeof candidate.strategy === "string" ? candidate.strategy : undefined;
  const stability = normalizeSelectorStability(candidate.stability);
  const base = {
    value,
    ...(weight !== undefined ? { weight } : {}),
    ...(source ? { source } : {}),
    ...(strategy ? { strategy } : {}),
    ...(stability ? { stability } : {}),
  };

  switch (type) {
    case "css":
      return { type: "css", ...base };
    case "attr":
      return { type: "attr", ...base };
    case "xpath":
      return { type: "xpath", ...base };
    case "text":
      return {
        type: "text",
        ...base,
        ...(candidate.match === "exact" || candidate.match === "contains"
          ? { match: candidate.match }
          : {}),
        ...(typeof candidate.tagNameHint === "string"
          ? { tagNameHint: candidate.tagNameHint }
          : {}),
      };
    case "aria":
      return {
        type: "aria",
        ...base,
        ...(typeof candidate.role === "string" ? { role: candidate.role } : {}),
        ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
      };
  }
}

function candidateForPrimarySelector(selector: string): SelectorCandidate {
  const usesXPath = selector.startsWith("/") || selector.startsWith("xpath=");
  return usesXPath
    ? { type: "xpath", value: selector.replace(/^xpath=/, "") }
    : { type: "css", value: selector };
}

function selectorHasAriaNameOrRole(selector: string): boolean {
  return /\[\s*aria-[^=\]]+\s*=|\[\s*role\s*=|\[\s*name\s*=|\brole\s*=|\bname\s*=/i.test(
    selector,
  );
}

function selectorUsesXPath(selector: string): boolean {
  return selector.startsWith("/") || selector.startsWith("xpath=");
}

function selectorUsesNth(selector: string): boolean {
  return /:nth-(?:of-type|child)\(/i.test(selector);
}

function selectorUsesDataOrTestId(selector: string): boolean {
  return /\[\s*(?:data-testid|data-test-id|data-test|data-qa|data-cy)\s*=/i.test(
    selector,
  );
}

function selectorUsesId(selector: string): boolean {
  return (
    /(^|[\s>+~])#[^\s>+~.:#[]+/.test(selector) || /\[\s*id\s*=/i.test(selector)
  );
}

function getTargetFrameContext(
  target: Record<string, unknown> | undefined,
): SelectorQualityDiagnostic["frameContext"] {
  const rawFrameContext = target?.frameContext;
  const frameContext = isRecord(rawFrameContext) ? rawFrameContext : undefined;
  if (frameContext?.kind === "top" || frameContext?.kind === "iframe") {
    return frameContext.kind;
  }
  const rawFrame = target?.frame;
  if (isRecord(rawFrame)) {
    const kind = rawFrame.kind;
    if (kind === "top") return "top";
    if (kind === "index" || kind === "urlContains") return "iframe";
  }
  return "unknown";
}

function targetHasLocatorMetadata(
  target: Record<string, unknown> | undefined,
): boolean {
  return Boolean(
    typeof target?.fingerprint === "string" &&
    target.fingerprint.trim() &&
    Array.isArray(target.domPath) &&
    target.domPath.every((item) => Number.isInteger(item)),
  );
}

export function buildSelectorQualityDiagnostic(
  target: Record<string, unknown> | undefined,
  observation?: Pick<
    SelectorQualityDiagnostic,
    "resolvedBy" | "matchCount" | "fingerprint"
  >,
): SelectorQualityDiagnostic | undefined {
  if (!target) return undefined;
  const primarySelector = getPrimarySelectorFromTarget(target);
  const rawCandidates = getTargetCandidates(target);
  const candidates = rawCandidates
    .map(toSharedSelectorCandidate)
    .filter((candidate): candidate is SelectorCandidate => Boolean(candidate));

  const primaryStability = primarySelector
    ? computeSelectorStability(candidateForPrimarySelector(primarySelector))
    : undefined;
  const candidateScores = candidates.map((candidate) => {
    const stability =
      candidate.stability ?? computeSelectorStability(candidate);
    return stability.score;
  });
  const bestCandidateScore =
    candidateScores.length > 0
      ? Math.max(...candidateScores.map((score) => roundScore(score)))
      : undefined;
  const score = roundScore(primaryStability?.score ?? bestCandidateScore ?? 0);
  const selector = primarySelector ?? "";
  const usesNthOfType =
    selectorUsesNth(selector) ||
    Boolean(primaryStability?.signals?.usesNthOfType);
  const usesXPath = selectorUsesXPath(selector);
  const usesDataOrTestId =
    selectorUsesDataOrTestId(selector) ||
    Boolean(primaryStability?.signals?.usesTestId);
  const usesId =
    selectorUsesId(selector) || Boolean(primaryStability?.signals?.usesId);
  const usesAriaNameOrRole =
    selectorHasAriaNameOrRole(selector) ||
    Boolean(primaryStability?.signals?.usesAria);
  const hasLocatorMetadata = targetHasLocatorMetadata(target);
  const shadowHostChain = target.shadowHostChain;
  const shadowContext = Array.isArray(shadowHostChain)
    ? shadowHostChain.length > 0
      ? "present"
      : "absent"
    : "unknown";
  const reasons: string[] = [];

  if (!primarySelector) reasons.push("missing primary selector");
  if (usesXPath) reasons.push("primary selector is XPath");
  if (usesNthOfType)
    reasons.push("primary selector uses nth-child/nth-of-type");
  if (usesDataOrTestId) reasons.push("uses data/test id");
  else if (usesId) reasons.push("uses id");
  else if (usesAriaNameOrRole) reasons.push("uses aria/name/role");
  if (!hasLocatorMetadata)
    reasons.push("missing fingerprint/domPath locator metadata");
  if (bestCandidateScore !== undefined && bestCandidateScore > score) {
    reasons.push("stable fallback candidate available");
  }
  if (observation?.resolvedBy && observation.resolvedBy !== "primary") {
    reasons.push(`resolved by fallback ${observation.resolvedBy}`);
  }

  return {
    ...(primarySelector ? { primarySelector } : {}),
    score,
    candidateCount: rawCandidates.length,
    ...(bestCandidateScore !== undefined ? { bestCandidateScore } : {}),
    usesNthOfType,
    usesXPath,
    usesDataOrTestId,
    usesId,
    usesAriaNameOrRole,
    hasLocatorMetadata,
    degraded: !hasLocatorMetadata,
    ...(observation?.resolvedBy ? { resolvedBy: observation.resolvedBy } : {}),
    ...(observation?.resolvedBy
      ? { fallback: observation.resolvedBy !== "primary" }
      : {}),
    ...(typeof observation?.matchCount === "number"
      ? { matchCount: observation.matchCount }
      : {}),
    ...(observation?.fingerprint
      ? { fingerprint: observation.fingerprint }
      : {}),
    frameContext: getTargetFrameContext(target),
    shadowContext,
    reasons,
  };
}

export function buildNodeSelectorQualityDiagnostic(
  node: FlowV3["nodes"][number],
  runs: SelectorDebugRun[] = [],
): SelectorQualityDiagnostic | undefined {
  const target = getNodeTarget(node);
  if (!target) return undefined;
  return buildSelectorQualityDiagnostic(
    target,
    getLatestSelectorObservation(runs, node.id),
  );
}

export function buildSelectorDiagnostics(
  flow: FlowV3,
  runs: SelectorDebugRun[] = [],
): Array<{
  nodeId: string;
  kind: string;
  quality: SelectorQualityDiagnostic;
}> {
  const diagnostics: Array<{
    nodeId: string;
    kind: string;
    quality: SelectorQualityDiagnostic;
  }> = [];
  for (const node of Array.isArray(flow.nodes) ? flow.nodes : []) {
    const quality = buildNodeSelectorQualityDiagnostic(node, runs);
    if (quality) {
      diagnostics.push({ nodeId: node.id, kind: node.kind, quality });
    }
  }
  return diagnostics;
}

export function getEventNodeId(
  event: Record<string, unknown>,
): string | undefined {
  return typeof event.nodeId === "string" ? event.nodeId : undefined;
}

export function getEventErrorCode(
  event: Record<string, unknown>,
): string | undefined {
  return getSanitizedErrorCode(event.error);
}

function normalizeFingerprintObservation(
  value: unknown,
): { status?: string; score?: number } | undefined {
  if (!isRecord(value)) return undefined;
  const status = typeof value.status === "string" ? value.status : undefined;
  const score =
    typeof value.score === "number" && Number.isFinite(value.score)
      ? roundScore(value.score)
      : undefined;
  return status || score !== undefined
    ? {
        ...(status ? { status } : {}),
        ...(score !== undefined ? { score } : {}),
      }
    : undefined;
}

function getLatestSelectorObservation(
  runs: SelectorDebugRun[],
  nodeId: string,
):
  | Pick<SelectorQualityDiagnostic, "resolvedBy" | "matchCount" | "fingerprint">
  | undefined {
  for (const run of runs) {
    for (const event of [...run.events].reverse()) {
      if (
        event.type !== "selector.resolution" ||
        getEventNodeId(event) !== nodeId
      ) {
        continue;
      }
      return {
        ...(typeof event.resolvedBy === "string"
          ? { resolvedBy: event.resolvedBy }
          : {}),
        ...(typeof event.matchCount === "number"
          ? { matchCount: event.matchCount }
          : {}),
        ...(normalizeFingerprintObservation(event.fingerprint)
          ? { fingerprint: normalizeFingerprintObservation(event.fingerprint) }
          : {}),
      };
    }
  }
  return undefined;
}

function hasNodeFailure(run: SelectorDebugRun, nodeId: string): boolean {
  if (run.status === "failed" && run.currentNodeId === nodeId) return true;
  return run.events.some((event) => {
    if (getEventNodeId(event) !== nodeId) return false;
    if (event.type === "node.failed") return true;
    const code = getEventErrorCode(event);
    return Boolean(code && isRetryableStabilityErrorCode(code));
  });
}

function collectSelectorRepairEvidence(
  runs: SelectorDebugRun[],
  nodeId: string,
): SelectorRepairEvidence {
  let hasTargetFailure = false;
  let hasFailureArtifact = false;
  let hasSelectorObservation = false;
  let hasSuccessfulResolution = false;
  let resolvedBy: string | undefined;
  let matchCount: number | undefined;
  let fingerprint: SelectorRepairEvidence["fingerprint"];
  let latestRunId: string | undefined;

  for (const run of runs) {
    const nodeFailed = hasNodeFailure(run, nodeId);
    if (nodeFailed) {
      hasTargetFailure = true;
      if (run.artifacts?.some((artifact) => artifact.nodeId === nodeId)) {
        hasFailureArtifact = true;
        latestRunId ??= run.id;
      }
    }
    for (const event of run.events) {
      if (
        event.type !== "selector.resolution" ||
        getEventNodeId(event) !== nodeId
      ) {
        continue;
      }
      hasSelectorObservation = true;
      if (typeof event.resolvedBy === "string") resolvedBy = event.resolvedBy;
      if (typeof event.matchCount === "number") matchCount = event.matchCount;
      fingerprint = normalizeFingerprintObservation(event.fingerprint);
      latestRunId ??= run.id;
      if (
        run.status === "succeeded" &&
        event.resolvedBy !== "none" &&
        typeof event.matchCount === "number" &&
        event.matchCount === 1
      ) {
        hasSuccessfulResolution = true;
      }
    }
  }

  return {
    hasTargetFailure,
    hasFailureArtifact,
    hasSelectorObservation,
    hasSuccessfulResolution,
    ...(resolvedBy ? { resolvedBy } : {}),
    ...(typeof matchCount === "number" ? { matchCount } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(latestRunId ? { latestRunId } : {}),
  };
}

function candidateHasUniqueSignal(
  candidate: Record<string, unknown>,
  evidence: SelectorRepairEvidence,
): boolean {
  return (
    candidate.unique === true ||
    candidate.isUnique === true ||
    candidate.matchCount === 1 ||
    evidence.matchCount === 1
  );
}

function selectorContainsTemplate(value: string): boolean {
  return /\{[a-zA-Z_][a-zA-Z0-9_]*\}/.test(value);
}

function selectorsEqual(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return (left ?? "").trim() === (right ?? "").trim();
}

function candidateToStoredCandidate(
  raw: Record<string, unknown>,
  candidate: SelectorCandidate,
): Record<string, unknown> {
  const stability = candidate.stability ?? computeSelectorStability(candidate);
  const base = {
    ...raw,
    type: candidate.type,
    value: candidate.value,
    source:
      raw.source === "recorded" || raw.source === "user"
        ? raw.source
        : "generated",
    stability,
  };
  switch (candidate.type) {
    case "css":
    case "attr":
      return { ...base, selector: candidate.value };
    case "xpath":
      return { ...base, xpath: candidate.value };
    case "text":
      return { ...base, text: candidate.value };
    case "aria":
      return {
        ...base,
        ...(candidate.role ? { role: candidate.role } : {}),
        ...(candidate.name ? { name: candidate.name } : {}),
      };
  }
}

function chooseSelectorReplacementCandidate(
  target: Record<string, unknown>,
  beforeSelector: string | undefined,
):
  | {
      index: number;
      raw: Record<string, unknown>;
      candidate: SelectorCandidate;
      selector: string;
    }
  | undefined {
  const candidates = getTargetCandidates(target)
    .map((raw, index) => {
      const candidate = toSharedSelectorCandidate(raw);
      return candidate ? { index, raw, candidate } : undefined;
    })
    .filter(
      (
        candidate,
      ): candidate is {
        index: number;
        raw: Record<string, unknown>;
        candidate: SelectorCandidate;
      } => Boolean(candidate),
    )
    .filter(
      ({ candidate }) => candidate.type === "css" || candidate.type === "attr",
    )
    .filter(({ candidate }) => candidate.value.trim().length > 0)
    .filter(({ candidate }) => !selectorsEqual(candidate.value, beforeSelector))
    .filter(({ candidate }) => !selectorContainsTemplate(candidate.value))
    .map((entry) => {
      const stability =
        entry.candidate.stability ?? computeSelectorStability(entry.candidate);
      return {
        ...entry,
        candidate: { ...entry.candidate, stability } as SelectorCandidate,
      };
    })
    .filter(({ candidate }) => (candidate.stability?.score ?? 0) >= 0.75)
    .sort((left, right) =>
      compareSelectorCandidates(left.candidate, right.candidate),
    );

  const best = candidates[0];
  return best ? { ...best, selector: best.candidate.value } : undefined;
}

function nodeRequiresSelectorFailClosed(
  node: FlowV3["nodes"][number],
): boolean {
  return getNodeSideEffectProfile(node).category !== "safe";
}

function fingerprintGateSatisfied(
  evidence: SelectorRepairEvidence,
  node: FlowV3["nodes"][number],
): boolean {
  if (!nodeRequiresSelectorFailClosed(node)) return true;
  const fingerprint = evidence.fingerprint;
  if (!fingerprint) return false;
  if (fingerprint.status === "matched") return true;
  return typeof fingerprint.score === "number" && fingerprint.score >= 0.8;
}

function estimateSelectorRepairConfidence(input: {
  node: FlowV3["nodes"][number];
  beforeQuality: SelectorQualityDiagnostic;
  afterQuality: SelectorQualityDiagnostic;
  selectorUnique: boolean;
  evidence: SelectorRepairEvidence;
}): number {
  let confidence = 0.45;
  const improvement = input.afterQuality.score - input.beforeQuality.score;
  if (input.afterQuality.score >= 0.9) confidence += 0.2;
  else if (input.afterQuality.score >= 0.8) confidence += 0.12;
  if (improvement >= 0.25) confidence += 0.15;
  else if (improvement >= 0.1) confidence += 0.08;
  if (input.selectorUnique) confidence += 0.15;
  if (input.evidence.hasTargetFailure) confidence += 0.1;
  if (input.evidence.hasFailureArtifact) confidence += 0.1;
  if (input.evidence.fingerprint?.status === "matched") confidence += 0.1;
  else if ((input.evidence.fingerprint?.score ?? 0) >= 0.8) confidence += 0.08;
  else if (input.evidence.fingerprint?.status === "mismatch")
    confidence -= 0.25;
  if (input.beforeQuality.hasLocatorMetadata) confidence += 0.05;
  if (input.afterQuality.usesDataOrTestId || input.afterQuality.usesId)
    confidence += 0.05;
  if (
    nodeRequiresSelectorFailClosed(input.node) &&
    !input.beforeQuality.hasLocatorMetadata
  ) {
    confidence -= 0.2;
  }
  return roundScore(confidence);
}

function canAutoApplySelectorRepair(
  plan: SelectorRepairPlan,
  node: FlowV3["nodes"][number],
): boolean {
  if (plan.op !== "replaceTarget" || !plan.afterQuality || !plan.afterSelector)
    return false;
  if (plan.confidence < 0.85) return false;
  if (!plan.selectorUnique) return false;
  if (!plan.evidence.hasTargetFailure || !plan.evidence.hasFailureArtifact)
    return false;
  if (plan.afterQuality.score < 0.8) return false;
  if (!fingerprintGateSatisfied(plan.evidence, node)) return false;
  if (nodeRequiresSelectorFailClosed(node) && plan.beforeQuality.degraded)
    return false;
  return true;
}

export function planSelectorRepairs(
  flow: FlowV3,
  runs: SelectorDebugRun[],
): SelectorRepairPlan[] {
  const plans: SelectorRepairPlan[] = [];
  for (const node of Array.isArray(flow.nodes) ? flow.nodes : []) {
    const target = getNodeTarget(node);
    if (!target) continue;

    const beforeQuality = buildSelectorQualityDiagnostic(
      target,
      getLatestSelectorObservation(runs, node.id),
    );
    if (!beforeQuality) continue;

    const evidence = collectSelectorRepairEvidence(runs, node.id);
    const beforeSelector = getPrimarySelectorFromTarget(target);
    const unstable =
      beforeQuality.usesXPath ||
      beforeQuality.usesNthOfType ||
      (beforeSelector
        ? beforeQuality.score < 0.65
        : beforeQuality.bestCandidateScore === undefined);

    if (beforeQuality.degraded && evidence.hasSuccessfulResolution) {
      plans.push({
        op: "backfillTargetMetadata",
        nodeId: node.id,
        status: "suggestion",
        reason:
          "A successful replay resolved this degraded target. Capture live locator metadata and validate before writing a backfill patch.",
        confidence: 0.55,
        selectorUnique: evidence.matchCount === 1,
        ...(beforeSelector ? { beforeSelector } : {}),
        beforeQuality,
        evidence,
      });
    }

    if (!unstable) continue;
    const replacement = chooseSelectorReplacementCandidate(
      target,
      beforeSelector,
    );
    if (!replacement) continue;

    const afterTarget = {
      ...target,
      selector: replacement.selector,
      candidates: [
        candidateToStoredCandidate(replacement.raw, replacement.candidate),
      ],
    };
    const afterQuality = buildSelectorQualityDiagnostic(afterTarget, {
      resolvedBy: "primary",
      matchCount: evidence.matchCount,
      fingerprint: evidence.fingerprint,
    });
    if (!afterQuality) continue;

    const selectorUnique = candidateHasUniqueSignal(replacement.raw, evidence);
    const confidence = estimateSelectorRepairConfidence({
      node,
      beforeQuality,
      afterQuality,
      selectorUnique,
      evidence,
    });
    const draftPlan: SelectorRepairPlan = {
      op: "replaceTarget",
      nodeId: node.id,
      status: "suggestion",
      reason: selectorUnique
        ? "Stable unique selector candidate can replace the structural primary selector."
        : "Stable selector candidate exists, but uniqueness is not proven from stored evidence.",
      confidence,
      selectorUnique,
      ...(beforeSelector ? { beforeSelector } : {}),
      afterSelector: replacement.selector,
      candidateIndex: replacement.index,
      candidate: candidateToStoredCandidate(
        replacement.raw,
        replacement.candidate,
      ),
      beforeQuality,
      afterQuality,
      evidence,
    };
    draftPlan.status = canAutoApplySelectorRepair(draftPlan, node)
      ? "autoPatch"
      : "suggestion";
    if (draftPlan.status === "suggestion" && !evidence.hasFailureArtifact) {
      draftPlan.reason =
        "Stable selector candidate exists, but no failure artifact is available; selector replacement is suggestion-only.";
    }
    plans.push(draftPlan);
  }
  return plans;
}

export function buildSelectorRepairRecommendations(
  plans: SelectorRepairPlan[],
): WorkflowRepairRecommendation[] {
  const recommendations: WorkflowRepairRecommendation[] = [];
  for (const plan of plans) {
    if (plan.op === "replaceTarget") {
      recommendations.push({
        severity: plan.status === "autoPatch" ? "info" : "warning",
        code:
          plan.status === "autoPatch"
            ? "selector_repair_patch_available"
            : "selector_repair_suggestion",
        message:
          plan.status === "autoPatch"
            ? `High-confidence selector replacement is available for ${plan.nodeId}; apply it through workflow_stabilize so the patch is followed by validation replay.`
            : `Selector replacement for ${plan.nodeId} needs validation or stronger evidence before it can be applied automatically.`,
        nodeId: plan.nodeId,
        ...(plan.status === "autoPatch"
          ? { autoFix: "selector_repair" as const }
          : {}),
      });
    } else if (plan.op === "backfillTargetMetadata") {
      recommendations.push({
        severity: "info",
        code: "selector_metadata_backfill_available",
        message:
          "A successful replay can be used to backfill missing locator metadata, but the metadata capture and validation step must run before writing.",
        nodeId: plan.nodeId,
      });
    }
  }
  return recommendations;
}

function prependReplacementCandidate(
  existingCandidates: Record<string, unknown>[],
  replacement: Record<string, unknown>,
): Record<string, unknown>[] {
  const replacementValue = candidateSelectorValue(replacement);
  const deduped = existingCandidates.filter(
    (candidate) =>
      !selectorsEqual(candidateSelectorValue(candidate), replacementValue),
  );
  return [replacement, ...deduped];
}

export function applySelectorRepairPlans(
  flow: FlowV3,
  plans: SelectorRepairPlan[],
): WorkflowRepairChange[] {
  const changes: WorkflowRepairChange[] = [];
  for (const plan of plans) {
    if (
      plan.op !== "replaceTarget" ||
      plan.status !== "autoPatch" ||
      !plan.afterSelector
    ) {
      continue;
    }
    const node = flow.nodes.find((candidate) => candidate.id === plan.nodeId);
    if (!node) continue;
    const target = getNodeTarget(node);
    if (!target) continue;
    const currentSelector = getPrimarySelectorFromTarget(target);
    if (!selectorsEqual(currentSelector, plan.beforeSelector)) {
      continue;
    }

    target.selector = plan.afterSelector;
    target.candidates = prependReplacementCandidate(
      getTargetCandidates(target),
      plan.candidate ?? {
        type: "css",
        value: plan.afterSelector,
        selector: plan.afterSelector,
        source: "generated",
      },
    );

    changes.push({
      code: "selector_target_replaced",
      message: `Replaced selector for ${plan.nodeId} with a stable candidate.`,
      nodeId: plan.nodeId,
      reason: plan.reason,
      confidence: plan.confidence,
      beforeQuality: plan.beforeQuality,
      ...(plan.afterQuality ? { afterQuality: plan.afterQuality } : {}),
      patch: {
        op: "replaceTarget",
        nodeId: plan.nodeId,
        beforeSelector: plan.beforeSelector,
        afterSelector: plan.afterSelector,
        confidence: plan.confidence,
        selectorUnique: plan.selectorUnique,
        evidence: plan.evidence,
      },
    });
  }
  return changes;
}
