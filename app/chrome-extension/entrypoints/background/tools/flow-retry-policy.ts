import { workflowSideEffectAllowsRetry } from "webpage-mcp-shared";

import type { FlowV3 } from "../record-replay-v3/domain/flow";
import { RR_ERROR_CODES } from "../record-replay-v3/domain/errors";
import type {
  NodePolicy,
  RetryPolicy,
} from "../record-replay-v3/domain/policy";
import { getNodeSideEffectProfile } from "./flow-risk-analysis";

const RETRYABLE_STABILITY_ERROR_CODES = [
  RR_ERROR_CODES.TARGET_NOT_FOUND,
  RR_ERROR_CODES.ELEMENT_NOT_VISIBLE,
  RR_ERROR_CODES.TIMEOUT,
  RR_ERROR_CODES.NAVIGATION_FAILED,
] as const;

const DEFAULT_SAFE_RETRY_POLICY: RetryPolicy = {
  retries: 1,
  intervalMs: 500,
  backoff: "linear",
  maxIntervalMs: 2_000,
  jitter: "full",
  retryOn: RETRYABLE_STABILITY_ERROR_CODES,
};

export interface WorkflowRetryPolicyChange {
  code: string;
  message: string;
}

function isSafeForFlowDefaultRetry(node: FlowV3["nodes"][number]): boolean {
  return workflowSideEffectAllowsRetry(
    getNodeSideEffectProfile(node),
    "flowDefault",
  );
}

function sideEffectRetryEligibleNodes(flow: FlowV3): FlowV3["nodes"] {
  return (Array.isArray(flow.nodes) ? flow.nodes : []).filter(
    isSafeForFlowDefaultRetry,
  );
}

export function isRetryableStabilityErrorCode(code: string): boolean {
  return (RETRYABLE_STABILITY_ERROR_CODES as readonly string[]).includes(code);
}

function policyHasRetryDirective(policy: NodePolicy | undefined): boolean {
  return Boolean(policy?.retry || policy?.onError?.kind === "retry");
}

function getRetryTemplateFromPolicy(
  policy: NodePolicy | undefined,
): RetryPolicy {
  if (policy?.retry) return { ...policy.retry };
  if (policy?.onError?.kind === "retry") {
    return {
      ...DEFAULT_SAFE_RETRY_POLICY,
      ...policy.onError.override,
    };
  }
  return { ...DEFAULT_SAFE_RETRY_POLICY };
}

export function safeRetryNodesMissingPolicy(flow: FlowV3): FlowV3["nodes"] {
  return sideEffectRetryEligibleNodes(flow).filter(
    (node) => !policyHasRetryDirective(node.policy),
  );
}

export function flowDefaultRetryTouchesSideEffects(flow: FlowV3): boolean {
  if (!policyHasRetryDirective(flow.policy?.defaultNodePolicy)) return false;
  return (Array.isArray(flow.nodes) ? flow.nodes : []).some(
    (node) => !isSafeForFlowDefaultRetry(node),
  );
}

export function applyDefaultStabilityPolicy(
  flow: FlowV3,
): WorkflowRetryPolicyChange[] {
  const changes: WorkflowRetryPolicyChange[] = [];
  const policy = flow.policy ?? {};
  const defaultNodePolicy = policy.defaultNodePolicy ?? {};
  const nextDefaultNodePolicy = { ...defaultNodePolicy };
  const retryTemplate = getRetryTemplateFromPolicy(nextDefaultNodePolicy);

  if (!nextDefaultNodePolicy.timeout) {
    nextDefaultNodePolicy.timeout = { ms: 15_000, scope: "attempt" };
    changes.push({
      code: "default_timeout_added",
      message: "Added default node attempt timeout of 15000ms.",
    });
  }

  if (policyHasRetryDirective(nextDefaultNodePolicy)) {
    delete nextDefaultNodePolicy.retry;
    if (nextDefaultNodePolicy.onError?.kind === "retry") {
      delete nextDefaultNodePolicy.onError;
    }
    changes.push({
      code: "global_retry_scoped_to_safe_nodes",
      message:
        "Removed flow-level default retry so side-effecting nodes are not retried automatically.",
    });
  }

  const safeNodesMissingRetry = safeRetryNodesMissingPolicy(flow);
  for (const node of safeNodesMissingRetry) {
    node.policy = {
      ...(node.policy ?? {}),
      retry: { ...retryTemplate },
    };
  }
  if (safeNodesMissingRetry.length > 0) {
    changes.push({
      code: "default_retry_added",
      message: `Added one retry to ${safeNodesMissingRetry.length} safe query/read node(s).`,
    });
  }

  const artifacts = nextDefaultNodePolicy.artifacts ?? {};
  if (
    artifacts.screenshot !== "onFailure" &&
    artifacts.screenshot !== "always"
  ) {
    nextDefaultNodePolicy.artifacts = {
      ...artifacts,
      screenshot: "onFailure",
    };
    changes.push({
      code: "failure_screenshot_added",
      message: "Enabled screenshot capture on node failure.",
    });
  }

  if (changes.length > 0) {
    flow.policy = {
      ...policy,
      defaultNodePolicy: nextDefaultNodePolicy,
    };
  }

  return changes;
}
