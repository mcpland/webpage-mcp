import type { FlowId } from "../domain/ids";

export const FLOW_WRITE_CONFLICT_CODE = "FLOW_WRITE_CONFLICT" as const;
export const WORKFLOW_CATALOG_WRITE_CONFLICT_CODE =
  "WORKFLOW_CATALOG_WRITE_CONFLICT" as const;

export class FlowWriteConflictError extends Error {
  readonly code = FLOW_WRITE_CONFLICT_CODE;
  readonly retryable = true;
  readonly flowId: FlowId;

  constructor(flowId: FlowId) {
    super(`Flow "${flowId}" is already being modified; retry after the current write finishes`);
    this.name = "FlowWriteConflictError";
    this.flowId = flowId;
  }
}

export class WorkflowCatalogWriteConflictError extends Error {
  readonly code = WORKFLOW_CATALOG_WRITE_CONFLICT_CODE;
  readonly retryable = true;

  constructor() {
    super("Workflow catalog is already being modified; retry after the current write finishes");
    this.name = "WorkflowCatalogWriteConflictError";
  }
}

const flowWriteLocks = new Map<FlowId, symbol>();
let workflowCatalogWriteLock: symbol | null = null;

export function tryAcquireFlowWriteLock(flowId: FlowId): () => void {
  if (flowWriteLocks.has(flowId)) {
    throw new FlowWriteConflictError(flowId);
  }

  const token = Symbol(String(flowId));
  flowWriteLocks.set(flowId, token);

  return () => {
    if (flowWriteLocks.get(flowId) === token) {
      flowWriteLocks.delete(flowId);
    }
  };
}

export async function withFlowWriteLock<T>(
  flowId: FlowId,
  operation: () => Promise<T>,
): Promise<T> {
  const release = tryAcquireFlowWriteLock(flowId);
  try {
    return await operation();
  } finally {
    release();
  }
}

export function tryAcquireWorkflowCatalogWriteLock(): () => void {
  if (workflowCatalogWriteLock) {
    throw new WorkflowCatalogWriteConflictError();
  }

  const token = Symbol("workflow-catalog");
  workflowCatalogWriteLock = token;

  return () => {
    if (workflowCatalogWriteLock === token) {
      workflowCatalogWriteLock = null;
    }
  };
}

export async function withWorkflowCatalogWriteLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const release = tryAcquireWorkflowCatalogWriteLock();
  try {
    return await operation();
  } finally {
    release();
  }
}
