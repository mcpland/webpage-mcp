import type { FlowV3 } from "../domain/flow";
import {
  appendWorkflowAuditEvent,
  buildWorkflowQualitySummary,
  buildWorkflowSideEffectDescriptor,
  calculateWorkflowRevision,
} from "./publish";

export type ScheduledRevalidationCatchUpStatus = "missed" | "deferred";

export interface ScheduledRevalidationCatchUpResult {
  flow: FlowV3;
  changed: boolean;
  status?: ScheduledRevalidationCatchUpStatus;
  reason?: string;
}

const SAFE_REVALIDATION_MISSED_REASON = "scheduled_revalidation_missed_catchup";
const DANGEROUS_REVALIDATION_DEFERRED_REASON =
  "scheduled_revalidation_deferred_requires_safe_or_idempotent_workflow";

function parseDueTime(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasAlreadyRecordedCatchUp(
  flow: FlowV3,
  status: ScheduledRevalidationCatchUpStatus,
  dueMs: number,
): boolean {
  const revalidation = flow.meta?.quality?.revalidation;
  if (revalidation?.status !== status) {
    return false;
  }
  const lastAttemptedAtMs = parseDueTime(revalidation.lastAttemptedAt);
  return lastAttemptedAtMs !== null && lastAttemptedAtMs >= dueMs;
}

export function markScheduledRevalidationCatchUp(
  flow: FlowV3,
  options: { nowMs?: number } = {},
): ScheduledRevalidationCatchUpResult {
  const quality = flow.meta?.quality;
  const revalidation = quality?.revalidation;
  if (!quality || revalidation?.policy !== "scheduled") {
    return { flow, changed: false };
  }
  if (revalidation.status === "queued" || revalidation.status === "in_progress") {
    return { flow, changed: false };
  }

  const dueMs = parseDueTime(revalidation.nextRevalidateAt);
  const nowMs = options.nowMs ?? Date.now();
  if (dueMs === null || dueMs > nowMs) {
    return { flow, changed: false };
  }

  const sideEffects = buildWorkflowSideEffectDescriptor(flow).summary;
  const unsafeForBackgroundSchedule = sideEffects.dangerous > 0 || sideEffects.unknown > 0;
  const status: ScheduledRevalidationCatchUpStatus = unsafeForBackgroundSchedule
    ? "deferred"
    : "missed";
  const reason = unsafeForBackgroundSchedule
    ? DANGEROUS_REVALIDATION_DEFERRED_REASON
    : SAFE_REVALIDATION_MISSED_REASON;

  if (hasAlreadyRecordedCatchUp(flow, status, dueMs)) {
    return { flow, changed: false, status, reason };
  }

  const nowIso = new Date(nowMs).toISOString() as FlowV3["updatedAt"];
  const previousQuality = buildWorkflowQualitySummary(flow, { nowMs });
  let next: FlowV3 = {
    ...flow,
    updatedAt: nowIso,
    meta: {
      ...(flow.meta ?? {}),
      quality: {
        ...quality,
        staleReason: quality.staleReason ?? "revalidation_overdue",
        revalidation: {
          ...revalidation,
          status,
          lastAttemptedAt: nowIso as NonNullable<typeof revalidation>["lastAttemptedAt"],
          lastRevalidateReason: reason,
          ...(status === "deferred" ? { lastDeferredReason: reason } : {}),
        },
      },
    },
  };
  const nextQuality = buildWorkflowQualitySummary(next, { nowMs });
  next = appendWorkflowAuditEvent(next, {
    kind: "quality_downgrade",
    actor: "runtime",
    revision: calculateWorkflowRevision(next),
    previousStatus: previousQuality.status,
    nextStatus: nextQuality.status,
    reason,
    metadata: {
      policy: "scheduled",
      ...(revalidation.nextRevalidateAt ? { nextRevalidateAt: revalidation.nextRevalidateAt } : {}),
      revalidationStatus: status,
      sideEffects: {
        safe: sideEffects.safe,
        idempotent: sideEffects.idempotent,
        dangerous: sideEffects.dangerous,
        unknown: sideEffects.unknown,
      },
      countedAsValidationFailure: false,
    },
  });

  return { flow: next, changed: true, status, reason };
}
