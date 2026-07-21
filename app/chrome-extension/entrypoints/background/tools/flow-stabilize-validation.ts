import type { ToolResult } from "@/common/tool-handler";
import type { FlowV3 } from "../record-replay-v3/domain/flow";
import { createStoragePort } from "../record-replay-v3";
import {
  buildWorkflowQualitySummary,
  buildWorkflowToolDescriptor,
  calculateWorkflowRevision,
  getPublishedFlowInfo,
} from "../record-replay-v3/flows/publish";
import {
  getStabilizeSafetyBoundary,
  hasStabilizeUrlBoundary,
  isAllowedPublicStartUrl,
  normalizeBoundaryStrings,
  validateUrlAgainstStabilizeBoundary,
  type WorkflowStabilizeValidationError,
} from "./flow-safety-boundary";
import {
  classifyWorkflowRisk,
  hasSegmentBoundary,
  type WorkflowRiskProfile,
  type WorkflowSegmentPlan,
} from "./flow-risk-analysis";

export type WorkflowStabilizeExecutionMode =
  | "auto"
  | "analyzeOnly"
  | "sandboxReplay"
  | "userApprovedReplay";

export interface WorkflowResetPlan {
  flow: FlowV3;
  workflow?: string;
  args?: Record<string, unknown>;
  maxRuns: number;
  requireStable: boolean;
  revision: string;
  risk: WorkflowRiskProfile;
  quality: ReturnType<typeof buildWorkflowQualitySummary>;
}

export interface WorkflowResetValidation {
  requested: boolean;
  plan?: WorkflowResetPlan;
  blockedReason?: string;
  errors: WorkflowStabilizeValidationError[];
}

function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function normalizeExecutionMode(
  value: unknown,
): WorkflowStabilizeExecutionMode {
  return value === "analyzeOnly" ||
    value === "sandboxReplay" ||
    value === "userApprovedReplay"
    ? value
    : "auto";
}

async function resolveStabilizeTargetTabUrl(
  args: any,
): Promise<{ url?: string; path: string; label: string }> {
  const tabId =
    typeof args?.tabId === "number" && Number.isFinite(args.tabId)
      ? Math.floor(args.tabId)
      : undefined;
  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      return {
        url: typeof tab?.url === "string" ? tab.url : undefined,
        path: "/tabId",
        label: "target tab URL",
      };
    } catch {
      return { path: "/tabId", label: "target tab URL" };
    }
  }

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = Array.isArray(tabs) ? tabs[0] : undefined;
    return {
      url: typeof tab?.url === "string" ? tab.url : undefined,
      path: "/tabTarget",
      label: "current tab URL",
    };
  } catch {
    return { path: "/tabTarget", label: "current tab URL" };
  }
}

export async function validateStabilizeReplayBoundary(
  args: any,
  executionMode: WorkflowStabilizeExecutionMode,
): Promise<WorkflowStabilizeValidationError | undefined> {
  const boundary = getStabilizeSafetyBoundary(args);
  if (!hasStabilizeUrlBoundary(boundary)) {
    return undefined;
  }

  const startUrl =
    typeof args?.startUrl === "string" ? args.startUrl.trim() : "";
  if (startUrl) {
    return validateUrlAgainstStabilizeBoundary(
      startUrl,
      boundary,
      "/startUrl",
      "startUrl",
    );
  }
  if (executionMode !== "sandboxReplay") {
    return undefined;
  }
  if (args?.tabTarget === "new") {
    return {
      code: "SANDBOX_REPLAY_REQUIRES_START_URL",
      path: "/startUrl",
      message:
        'sandboxReplay with tabTarget="new" requires startUrl so the test environment boundary can be verified',
    };
  }

  const target = await resolveStabilizeTargetTabUrl(args);
  if (!target.url) {
    return {
      code: "SANDBOX_REPLAY_TARGET_URL_UNAVAILABLE",
      path: target.path,
      message: `sandboxReplay requires a readable ${target.label} so the test environment boundary can be verified`,
    };
  }
  return validateUrlAgainstStabilizeBoundary(
    target.url,
    boundary,
    target.path,
    target.label,
  );
}

export function getStabilizeTestEnvironment(
  args: any,
): Record<string, unknown> | undefined {
  return args?.safety?.testEnvironment &&
    typeof args.safety.testEnvironment === "object" &&
    !Array.isArray(args.safety.testEnvironment)
    ? args.safety.testEnvironment
    : undefined;
}

function hasRunnableResetPlan(
  resetValidation: WorkflowResetValidation,
): boolean {
  return Boolean(resetValidation.plan && resetValidation.plan.maxRuns > 0);
}

export function getSandboxReplayBoundaryError(
  args: any,
  resetValidation: WorkflowResetValidation,
  segmentPlan: WorkflowSegmentPlan,
): WorkflowStabilizeValidationError | undefined {
  const testEnvironment = getStabilizeTestEnvironment(args);
  if (!testEnvironment) {
    return {
      code: "SANDBOX_REPLAY_REQUIRES_TEST_ENVIRONMENT",
      path: "/safety/testEnvironment",
      message: "sandboxReplay requires safety.testEnvironment",
    };
  }

  const name =
    typeof testEnvironment.name === "string" ? testEnvironment.name.trim() : "";
  const origins = normalizeBoundaryStrings(testEnvironment.origins);
  if (!name || origins.length === 0) {
    return {
      code: "SANDBOX_REPLAY_TEST_ENVIRONMENT_INCOMPLETE",
      path: "/safety/testEnvironment",
      message:
        "sandboxReplay requires safety.testEnvironment.name and at least one origin",
    };
  }

  const accountLabel =
    typeof testEnvironment.accountLabel === "string" &&
    testEnvironment.accountLabel.trim()
      ? testEnvironment.accountLabel.trim()
      : "";
  if (
    !accountLabel &&
    !hasRunnableResetPlan(resetValidation) &&
    !hasSegmentBoundary(segmentPlan)
  ) {
    return {
      code: "SANDBOX_REPLAY_REQUIRES_BOUNDED_ENVIRONMENT",
      path: "/safety",
      message:
        "sandboxReplay is bounded test replay, not a rollback sandbox; provide a test account label, reset workflow, or segment boundary",
    };
  }

  return undefined;
}

export function validateWorkflowStabilizeArgs(
  args: any,
): WorkflowStabilizeValidationError[] {
  const errors: WorkflowStabilizeValidationError[] = [];
  const flowId = typeof args?.flowId === "string" ? args.flowId.trim() : "";
  const workflow =
    typeof args?.workflow === "string" ? args.workflow.trim() : "";

  if ((flowId && workflow) || (!flowId && !workflow)) {
    errors.push({
      code: "INVALID_WORKFLOW_IDENTIFIER",
      path: "",
      message: "Exactly one of flowId or workflow is required",
    });
  }
  if (args?.apply === true && args?.dryRun === true) {
    errors.push({
      code: "MUTUALLY_EXCLUSIVE_OPTIONS",
      path: "/apply",
      message: "apply=true cannot be combined with dryRun=true",
    });
  }
  if (
    typeof args?.tabId === "number" &&
    Number.isFinite(args.tabId) &&
    args?.tabTarget === "new"
  ) {
    errors.push({
      code: "MUTUALLY_EXCLUSIVE_OPTIONS",
      path: "/tabId",
      message: 'tabId cannot be combined with tabTarget="new"',
    });
  }
  const startUrl =
    typeof args?.startUrl === "string" ? args.startUrl.trim() : "";
  if (startUrl && !isAllowedPublicStartUrl(startUrl)) {
    errors.push({
      code: "INVALID_START_URL",
      path: "/startUrl",
      message: "Only http:// and https:// URLs are allowed for startUrl",
    });
  }
  if (
    args?.iterations !== undefined &&
    (typeof args.iterations !== "number" ||
      !Number.isFinite(args.iterations) ||
      args.iterations < 1 ||
      args.iterations > 10)
  ) {
    errors.push({
      code: "INVALID_ITERATIONS",
      path: "/iterations",
      message: "iterations must be a number from 1 to 10",
    });
  }
  if (
    args?.minPassRate !== undefined &&
    (typeof args.minPassRate !== "number" ||
      !Number.isFinite(args.minPassRate) ||
      args.minPassRate < 0 ||
      args.minPassRate > 1)
  ) {
    errors.push({
      code: "INVALID_MIN_PASS_RATE",
      path: "/minPassRate",
      message: "minPassRate must be a number from 0 to 1",
    });
  }

  return errors;
}

export function createStructuredToolError(
  code: string,
  message: string,
  errors: WorkflowStabilizeValidationError[],
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: false,
          status: "validation_failed",
          error: {
            code,
            category: "validation",
            retryable: false,
            message,
            errors,
          },
        }),
      },
    ],
    isError: true,
  };
}

type FlowVariable = NonNullable<FlowV3["variables"]>[number];

function inferFlowVariableKind(variable: FlowVariable): string {
  if (variable.kind) return variable.kind;
  if (typeof variable.default === "number") return "number";
  if (typeof variable.default === "boolean") return "boolean";
  if (Array.isArray(variable.default)) return "array";
  if (variable.default && typeof variable.default === "object") return "json";
  return "string";
}

function validateWorkflowArgsForStabilize(
  flow: FlowV3,
  value: unknown,
  pathPrefix: string,
): {
  args?: Record<string, unknown>;
  errors: WorkflowStabilizeValidationError[];
} {
  const errors: WorkflowStabilizeValidationError[] = [];
  if (value === undefined || value === null) {
    value = {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      errors: [
        {
          code: "INVALID_WORKFLOW_ARGS",
          path: pathPrefix,
          message: "workflow args must be an object",
        },
      ],
    };
  }

  const input = value as Record<string, unknown>;
  const variables = Array.isArray(flow.variables) ? flow.variables : [];
  const knownVariables = new Map(
    variables.map((variable) => [variable.name, variable]),
  );
  for (const key of Object.keys(input)) {
    if (!knownVariables.has(key)) {
      errors.push({
        code: "UNKNOWN_WORKFLOW_ARG",
        path: `${pathPrefix}/${key}`,
        message: `Unknown workflow argument: ${key}`,
      });
    }
  }

  for (const variable of variables) {
    if (!variable?.name) continue;
    const hasValue = Object.prototype.hasOwnProperty.call(input, variable.name);
    const argValue = input[variable.name];
    if (
      variable.required === true &&
      variable.default === undefined &&
      !hasValue
    ) {
      errors.push({
        code: "MISSING_REQUIRED_WORKFLOW_ARG",
        path: `${pathPrefix}/${variable.name}`,
        message: `Missing required workflow argument: ${variable.name}`,
      });
      continue;
    }
    if (!hasValue || argValue === undefined || argValue === null) {
      continue;
    }

    const kind = inferFlowVariableKind(variable);
    const valid =
      kind === "number"
        ? typeof argValue === "number" && Number.isFinite(argValue)
        : kind === "boolean"
          ? typeof argValue === "boolean"
          : kind === "array"
            ? Array.isArray(argValue)
            : kind === "json"
              ? true
              : kind === "enum"
                ? Array.isArray(variable.options) &&
                  variable.options.includes(argValue as never)
                : typeof argValue === "string";
    if (!valid) {
      errors.push({
        code: "INVALID_WORKFLOW_ARG_TYPE",
        path: `${pathPrefix}/${variable.name}`,
        message: `Invalid value for workflow argument "${variable.name}"`,
      });
    }
  }

  return {
    ...(Object.keys(input).length > 0 ? { args: input } : {}),
    errors,
  };
}

function getWorkflowResetSpec(args: any): {
  workflow: string;
  args?: Record<string, unknown>;
  maxRuns: number;
  requireStable: boolean;
} | null {
  const reset =
    args?.safety?.reset &&
    typeof args.safety.reset === "object" &&
    !Array.isArray(args.safety.reset)
      ? args.safety.reset
      : {};
  const workflow =
    typeof reset.workflow === "string" && reset.workflow.trim()
      ? reset.workflow.trim()
      : typeof args?.safety?.resetWorkflow === "string" &&
          args.safety.resetWorkflow.trim()
        ? args.safety.resetWorkflow.trim()
        : "";
  if (!workflow) {
    return null;
  }
  const resetArgs =
    reset.args && typeof reset.args === "object" && !Array.isArray(reset.args)
      ? (reset.args as Record<string, unknown>)
      : undefined;
  return {
    workflow,
    ...(resetArgs ? { args: resetArgs } : {}),
    maxRuns: clampNumber(reset.maxRuns, 1, 0, 3),
    requireStable: reset.requireStable !== false,
  };
}

export async function buildWorkflowResetValidation(options: {
  args: any;
  targetFlow: FlowV3;
  hasApprovalReference: boolean;
}): Promise<WorkflowResetValidation> {
  const spec = getWorkflowResetSpec(options.args);
  if (!spec) {
    return { requested: false, errors: [] };
  }

  const errors: WorkflowStabilizeValidationError[] = [];
  const storage = createStoragePort();
  const flows = await storage.flows.list();
  const resetFlow = flows.find(
    (flow) => getPublishedFlowInfo(flow)?.slug === spec.workflow,
  );
  if (!resetFlow) {
    errors.push({
      code: "RESET_WORKFLOW_NOT_FOUND",
      path: "/safety/reset/workflow",
      message: `Reset workflow not found: ${spec.workflow}`,
    });
    return {
      requested: true,
      blockedReason: `reset workflow not found: ${spec.workflow}`,
      errors,
    };
  }
  if (resetFlow.id === options.targetFlow.id) {
    errors.push({
      code: "RESET_WORKFLOW_SELF_REFERENCE",
      path: "/safety/reset/workflow",
      message: "reset workflow cannot reference the target workflow",
    });
    return {
      requested: true,
      blockedReason: "reset workflow cannot reference the target workflow",
      errors,
    };
  }

  const argsValidation = validateWorkflowArgsForStabilize(
    resetFlow,
    spec.args ?? {},
    "/safety/reset/args",
  );
  if (argsValidation.errors.length > 0) {
    return {
      requested: true,
      blockedReason: "reset workflow args failed validation",
      errors: argsValidation.errors,
    };
  }

  const descriptor = buildWorkflowToolDescriptor(resetFlow);
  const risk = classifyWorkflowRisk(descriptor.sideEffects.summary);
  if (
    (risk === "dangerous" || risk === "unknown") &&
    !options.hasApprovalReference
  ) {
    errors.push({
      code: "RESET_WORKFLOW_REQUIRES_APPROVAL",
      path: "/safety/reset/workflow",
      message:
        "dangerous or unknown reset workflow requires a trusted approval reference",
    });
    return {
      requested: true,
      blockedReason: "reset workflow requires trusted approval",
      errors,
    };
  }

  const quality = buildWorkflowQualitySummary(resetFlow);
  if (
    spec.requireStable &&
    (!quality.current ||
      (quality.level !== "stable" && quality.level !== "verified"))
  ) {
    errors.push({
      code: "RESET_WORKFLOW_QUALITY_STALE",
      path: "/safety/reset/workflow",
      message: `reset workflow quality is not current stable: ${quality.staleReason ?? quality.level}`,
    });
    return {
      requested: true,
      blockedReason: "reset workflow quality gate failed",
      errors,
    };
  }

  return {
    requested: true,
    plan: {
      flow: resetFlow,
      workflow: spec.workflow,
      args: argsValidation.args,
      maxRuns: spec.maxRuns,
      requireStable: spec.requireStable,
      revision: calculateWorkflowRevision(resetFlow),
      risk,
      quality,
    },
    errors: [],
  };
}
