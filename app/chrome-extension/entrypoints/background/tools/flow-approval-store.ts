import { createErrorResponse, type ToolResult } from "@/common/tool-handler";
import { TOOL_NAMES } from "webpage-mcp-shared";

import {
  type FlowQualityMeta,
  type FlowV3,
} from "../record-replay-v3/domain/flow";
import type { FlowId } from "../record-replay-v3/domain/ids";
import { createStoragePort } from "../record-replay-v3";
import {
  FlowWriteConflictError,
  withFlowWriteLock,
} from "../record-replay-v3/flows/write-lock";
import {
  appendWorkflowAuditEvent,
  buildWorkflowQualitySummary,
  calculateWorkflowRevision,
  getPublishedFlowInfo,
} from "../record-replay-v3/flows/publish";

const WORKFLOW_APPROVAL_STORE_KEY = "webpageMcpWorkflowApprovals";

export interface TrustedWorkflowApproval {
  approvalId: string;
  approvedBy: "user" | "ui" | "policy";
  approvedAt: string;
  expiresAt: string;
  scope: {
    flowId: string;
    revision: string;
    testEnvironment?: string;
  };
}

interface WorkflowApprovalCheck {
  accepted: boolean;
  approval?: TrustedWorkflowApproval;
  reason?: string;
}

interface StoredWorkflowApproval extends TrustedWorkflowApproval {
  revoked: boolean;
  revokedAt?: string;
  expired: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function getApprovalIdReference(args: unknown): string {
  if (!isRecord(args) || !isRecord(args.safety)) return "";
  const authorization = args.safety.authorization;
  if (!isRecord(authorization)) return "";
  return typeof authorization.approvalId === "string"
    ? authorization.approvalId.trim()
    : "";
}

function normalizeApprovalRecord(
  approvalId: string,
  value: unknown,
): TrustedWorkflowApproval | undefined {
  if (!isRecord(value)) return undefined;
  const approvedBy = value.approvedBy;
  if (approvedBy !== "user" && approvedBy !== "ui" && approvedBy !== "policy") {
    return undefined;
  }
  const approvedAt =
    typeof value.approvedAt === "string" ? value.approvedAt.trim() : "";
  const expiresAt =
    typeof value.expiresAt === "string" ? value.expiresAt.trim() : "";
  const scope = isRecord(value.scope) ? value.scope : undefined;
  const flowId = typeof scope?.flowId === "string" ? scope.flowId.trim() : "";
  const revision =
    typeof scope?.revision === "string" ? scope.revision.trim() : "";
  if (!approvedAt || !expiresAt || !flowId || !revision) return undefined;

  const testEnvironment =
    typeof scope?.testEnvironment === "string" && scope.testEnvironment.trim()
      ? scope.testEnvironment.trim()
      : undefined;
  return {
    approvalId,
    approvedBy,
    approvedAt,
    expiresAt,
    scope: {
      flowId,
      revision,
      ...(testEnvironment ? { testEnvironment } : {}),
    },
  };
}

function getStoredApprovalRecord(store: unknown, approvalId: string): unknown {
  if (Array.isArray(store)) {
    return store.find(
      (item) =>
        isRecord(item) &&
        typeof item.approvalId === "string" &&
        item.approvalId === approvalId,
    );
  }
  return isRecord(store) ? store[approvalId] : undefined;
}

function normalizeStoredApprovalRecord(
  approvalId: string,
  value: unknown,
): StoredWorkflowApproval | undefined {
  const approval = normalizeApprovalRecord(approvalId, value);
  if (!approval) return undefined;
  const revoked = isRecord(value) && value.revoked === true;
  const revokedAt =
    isRecord(value) &&
    typeof value.revokedAt === "string" &&
    value.revokedAt.trim()
      ? value.revokedAt.trim()
      : undefined;
  const expiresAtMs = Date.parse(approval.expiresAt);
  return {
    ...approval,
    revoked,
    ...(revokedAt ? { revokedAt } : {}),
    expired: !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now(),
  };
}

function listStoredApprovalRecords(
  store: unknown,
  includeRevoked = false,
): StoredWorkflowApproval[] {
  const records: StoredWorkflowApproval[] = [];
  if (Array.isArray(store)) {
    for (const item of store) {
      if (!isRecord(item) || typeof item.approvalId !== "string") continue;
      const record = normalizeStoredApprovalRecord(item.approvalId, item);
      if (record && (includeRevoked || !record.revoked)) records.push(record);
    }
  } else if (isRecord(store)) {
    for (const [approvalId, value] of Object.entries(store)) {
      const record = normalizeStoredApprovalRecord(approvalId, value);
      if (record && (includeRevoked || !record.revoked)) records.push(record);
    }
  }
  return records.sort((left, right) =>
    left.approvalId.localeCompare(right.approvalId),
  );
}

function revokeApprovalRecordInStore(
  store: unknown,
  approvalId: string,
  revokedAt: string,
  reason: string,
): { nextStore: unknown; record?: StoredWorkflowApproval } {
  const rawRecord = getStoredApprovalRecord(store, approvalId);
  const record = normalizeStoredApprovalRecord(approvalId, rawRecord);
  if (!record || !isRecord(rawRecord)) return { nextStore: store };

  const revokedRecord = {
    ...rawRecord,
    approvalId,
    revoked: true,
    revokedAt,
    ...(reason ? { revokeReason: reason } : {}),
  };
  if (Array.isArray(store)) {
    return {
      nextStore: store.map((item) =>
        isRecord(item) && item.approvalId === approvalId ? revokedRecord : item,
      ),
      record,
    };
  }
  if (isRecord(store)) {
    return {
      nextStore: { ...store, [approvalId]: revokedRecord },
      record,
    };
  }
  return { nextStore: store };
}

export async function resolveTrustedWorkflowApproval(options: {
  args: unknown;
  flow: FlowV3;
  revision: string;
}): Promise<WorkflowApprovalCheck> {
  const approvalId = getApprovalIdReference(options.args);
  if (!approvalId) return { accepted: false };

  let rawStore: unknown;
  try {
    const result = (await chrome.storage.local.get(
      WORKFLOW_APPROVAL_STORE_KEY,
    )) as Record<string, unknown>;
    rawStore = result?.[WORKFLOW_APPROVAL_STORE_KEY];
  } catch {
    return { accepted: false, reason: "approval store unavailable" };
  }

  const rawApproval = getStoredApprovalRecord(rawStore, approvalId);
  if (isRecord(rawApproval) && rawApproval.revoked === true) {
    return { accepted: false, reason: "approval has been revoked" };
  }
  const approval = normalizeApprovalRecord(approvalId, rawApproval);
  if (!approval) {
    return {
      accepted: false,
      reason: "approval record not found or invalid",
    };
  }
  const expiresAtMs = Date.parse(approval.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return { accepted: false, reason: "approval has expired" };
  }
  if (
    approval.scope.flowId !== options.flow.id ||
    approval.scope.revision !== options.revision
  ) {
    return {
      accepted: false,
      reason: "approval scope does not match workflow revision",
    };
  }

  const args = isRecord(options.args) ? options.args : {};
  const safety = isRecord(args.safety) ? args.safety : {};
  const testEnvironment = isRecord(safety.testEnvironment)
    ? safety.testEnvironment
    : {};
  const requestedEnvironment =
    typeof testEnvironment.name === "string" ? testEnvironment.name.trim() : "";
  if (
    approval.scope.testEnvironment &&
    approval.scope.testEnvironment !== requestedEnvironment
  ) {
    return {
      accepted: false,
      reason: "approval testEnvironment scope does not match request",
    };
  }
  return { accepted: true, approval };
}

function markQualityStaleForApprovalRevoke(
  quality: FlowQualityMeta | undefined,
): FlowQualityMeta | undefined {
  if (!quality) return undefined;
  return {
    ...cloneJson(quality),
    status: "stale",
    staleReason: "approval_revoked",
    revalidation: {
      ...(quality.revalidation ?? {}),
      ...(quality.revalidation?.policy ? { status: "deferred" as const } : {}),
      lastDeferredReason: "approval_revoked",
    },
    warnings: Array.from(
      new Set([
        ...(quality.warnings ?? []),
        "Quality marked stale because trusted approval was revoked.",
      ]),
    ),
  };
}

async function auditApprovalRevocation(
  approval: StoredWorkflowApproval,
  reason: string,
): Promise<Record<string, unknown>> {
  const flowId = approval.scope.flowId as FlowId;
  const storage = createStoragePort();
  try {
    return await withFlowWriteLock(flowId, async () => {
      const flow = await storage.flows.get(flowId);
      if (!flow) {
        return {
          audited: false,
          flowId: approval.scope.flowId,
          reason: "flow_not_found",
        };
      }
      const previousQuality = buildWorkflowQualitySummary(flow);
      let nextFlow: FlowV3 = {
        ...flow,
        updatedAt: new Date().toISOString() as FlowV3["updatedAt"],
        meta: {
          ...(flow.meta ?? {}),
          ...(flow.meta?.quality
            ? {
                quality: markQualityStaleForApprovalRevoke(flow.meta.quality),
              }
            : {}),
        },
      };
      const nextQuality = buildWorkflowQualitySummary(nextFlow);
      nextFlow = appendWorkflowAuditEvent(nextFlow, {
        kind: "approval_revoke",
        actor: "mcp",
        revision: calculateWorkflowRevision(nextFlow),
        previousStatus: previousQuality.status,
        nextStatus: nextQuality.status,
        reason: "workflow_approval_store_revoke",
        metadata: {
          approvalId: approval.approvalId,
          approvedBy: approval.approvedBy,
          approvedAt: approval.approvedAt,
          expiresAt: approval.expiresAt,
          scope: approval.scope,
          revokeReason: reason || "not_specified",
        },
      });
      if (previousQuality.current && !nextQuality.current) {
        nextFlow = appendWorkflowAuditEvent(nextFlow, {
          kind: "quality_downgrade",
          actor: "mcp",
          revision: calculateWorkflowRevision(nextFlow),
          previousStatus: previousQuality.status,
          nextStatus: nextQuality.status,
          reason: "approval_revoked",
          metadata: {
            approvalId: approval.approvalId,
            tool: TOOL_NAMES.RECORD_REPLAY.WORKFLOW_APPROVAL_STORE,
          },
        });
      }
      await storage.flows.save(nextFlow);
      return {
        audited: true,
        flowId: flow.id,
        workflow: getPublishedFlowInfo(flow)?.slug,
        previousStatus: previousQuality.status,
        nextStatus: nextQuality.status,
        staleReason: nextQuality.staleReason ?? null,
      };
    });
  } catch (error) {
    if (error instanceof FlowWriteConflictError) {
      return {
        audited: false,
        flowId: approval.scope.flowId,
        reason: "flow_write_conflict",
        retryable: true,
      };
    }
    throw error;
  }
}

export class WorkflowApprovalStoreTool {
  name = TOOL_NAMES.RECORD_REPLAY.WORKFLOW_APPROVAL_STORE;

  async execute(args: any): Promise<ToolResult> {
    const operation =
      args?.operation === "get" || args?.operation === "revoke"
        ? args.operation
        : "list";
    const approvalId =
      typeof args?.approvalId === "string" ? args.approvalId.trim() : "";
    if ((operation === "get" || operation === "revoke") && !approvalId) {
      return createErrorResponse(
        "approvalId is required for get and revoke operations",
      );
    }

    let rawStore: unknown;
    try {
      const result = (await chrome.storage.local.get(
        WORKFLOW_APPROVAL_STORE_KEY,
      )) as Record<string, unknown>;
      rawStore = result?.[WORKFLOW_APPROVAL_STORE_KEY];
    } catch {
      return createErrorResponse("approval store unavailable");
    }

    if (operation === "list") {
      const approvals = listStoredApprovalRecords(
        rawStore,
        args?.includeRevoked === true,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              operation,
              approvalCreation: "ui_user_or_policy_store_only",
              count: approvals.length,
              approvals,
            }),
          },
        ],
        isError: false,
      };
    }

    const rawRecord = getStoredApprovalRecord(rawStore, approvalId);
    const approval = normalizeStoredApprovalRecord(approvalId, rawRecord);
    if (!approval) {
      return createErrorResponse(
        `Approval record not found or invalid: ${approvalId}`,
      );
    }

    if (operation === "get") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              operation,
              approval,
              approvalCreation: "ui_user_or_policy_store_only",
            }),
          },
        ],
        isError: false,
      };
    }

    const revokedAt = new Date().toISOString();
    const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
    const revoked = revokeApprovalRecordInStore(
      rawStore,
      approvalId,
      revokedAt,
      reason,
    );
    if (!revoked.record) {
      return createErrorResponse(
        `Approval record not found or invalid: ${approvalId}`,
      );
    }
    await chrome.storage.local.set({
      [WORKFLOW_APPROVAL_STORE_KEY]: revoked.nextStore,
    });
    const audit = await auditApprovalRevocation(revoked.record, reason);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            operation,
            approval: {
              ...revoked.record,
              revoked: true,
              revokedAt,
              ...(reason ? { revokeReason: reason } : {}),
            },
            approvalCreation: "ui_user_or_policy_store_only",
            audit,
          }),
        },
      ],
      isError: false,
    };
  }
}
