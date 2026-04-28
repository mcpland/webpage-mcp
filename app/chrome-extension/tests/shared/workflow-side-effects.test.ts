import { describe, expect, it } from "vitest";

import {
  normalizeWorkflowSideEffectProfile,
  workflowSideEffectAllowsRetry,
} from "../../../../packages/shared/src/workflow-side-effects";

describe("workflow side-effect profiles", () => {
  it("derives retry semantics from an overridden category", () => {
    const profile = normalizeWorkflowSideEffectProfile("wait", {
      category: "dangerous",
    });

    expect(profile).toMatchObject({
      category: "dangerous",
      retry: "explicit",
    });
    expect(workflowSideEffectAllowsRetry(profile, "flowDefault")).toBe(false);
  });

  it("allows a dangerous node to become flow-default retryable when explicitly classified safe", () => {
    const profile = normalizeWorkflowSideEffectProfile("click", {
      category: "safe",
    });

    expect(profile).toMatchObject({
      category: "safe",
      retry: "default",
    });
    expect(workflowSideEffectAllowsRetry(profile, "flowDefault")).toBe(true);
  });

  it("keeps explicit retry overrides authoritative", () => {
    const profile = normalizeWorkflowSideEffectProfile("wait", {
      category: "safe",
      retry: "never",
    });

    expect(profile).toMatchObject({
      category: "safe",
      retry: "never",
    });
    expect(workflowSideEffectAllowsRetry(profile, "node")).toBe(false);
  });
});
