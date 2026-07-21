import { describe, expect, it } from "vitest";

import {
  buildWorkflowSegmentPlan,
  collectRuntimeSideEffectEvidence,
  summarizeWorkflowSideEffects,
} from "@/entrypoints/background/tools/flow-risk-analysis";

describe("workflow risk analysis", () => {
  it("combines runtime mutation evidence without exposing URL credentials", () => {
    const evidence = collectRuntimeSideEffectEvidence([
      {
        id: "run-1",
        events: [
          {
            type: "network.observed",
            nodeId: "submit",
            method: "POST",
            url: "https://user:pass@example.test/orders?token=secret&view=1",
          },
          {
            type: "navigation.observed",
            status: "completed",
            nodeId: "submit",
            beforeUrl: "https://example.test/start",
            afterUrl: "https://other.test/finish?session=secret",
          },
        ],
      },
    ]);

    expect(evidence.risk).toBe("unknown");
    expect(evidence.summary).toMatchObject({ dangerous: 1, unknown: 1 });
    expect(JSON.stringify(evidence)).not.toContain("pass");
    expect(JSON.stringify(evidence)).not.toContain("secret");
  });

  it("stops at the unique first dangerous boundary", () => {
    const flow = {
      entryNodeId: "start",
      nodes: [
        { id: "start", kind: "trigger", config: {} },
        { id: "inspect", kind: "extract", config: {} },
        { id: "submit", kind: "click", config: {} },
      ],
      edges: [
        { from: "start", to: "inspect" },
        { from: "inspect", to: "submit" },
      ],
    } as any;
    const plan = buildWorkflowSegmentPlan(
      flow,
      { safety: { segments: { mode: "stopBeforeDangerous" } } },
      {
        risk: "safe",
        summary: summarizeWorkflowSideEffects(flow),
        observations: [],
      },
      new Map([["submit", "dangerous"]]),
    );

    expect(plan).toMatchObject({
      stopBeforeNodeId: "submit",
      boundaryNodeId: "submit",
      boundaryRisk: "dangerous",
      boundarySource: "override",
    });
    expect(summarizeWorkflowSideEffects(flow).unknown).toBe(0);
  });

  it("fails closed when parallel branches have different first boundaries", () => {
    const flow = {
      entryNodeId: "start",
      nodes: [
        { id: "start", kind: "trigger", config: {} },
        { id: "left", kind: "click", config: {} },
        { id: "right", kind: "click", config: {} },
      ],
      edges: [
        { from: "start", to: "left" },
        { from: "start", to: "right" },
      ],
    } as any;
    const plan = buildWorkflowSegmentPlan(
      flow,
      { safety: { segments: { mode: "stopBeforeDangerous" } } },
      {
        risk: "safe",
        summary: summarizeWorkflowSideEffects(flow),
        observations: [],
      },
      new Map([
        ["left", "dangerous"],
        ["right", "unknown"],
      ]),
    );

    expect(plan.stopBeforeNodeId).toBeUndefined();
    expect(plan.ambiguousBoundaryNodeIds).toEqual(["left", "right"]);
  });
});
