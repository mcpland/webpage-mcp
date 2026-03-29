import { describe, expect, it } from "vitest";
import type { FlowV3 } from "@/entrypoints/background/record-replay-v3/domain/flow";
import {
  extractHiddenSensitiveVariables,
  flowV3ToBuilderForEditor,
  mergeHiddenSensitiveVariables,
} from "@/entrypoints/shared/utils/rr-flow-convert";

function createFlowV3(): FlowV3 {
  const iso = new Date(0).toISOString();
  return {
    schemaVersion: 3,
    id: "flow-builder-sensitive" as any,
    name: "Builder Sensitive Flow",
    entryNodeId: "node-1" as any,
    nodes: [{ id: "node-1" as any, kind: "navigate", config: { url: "https://example.com" } }],
    edges: [],
    variables: [
      {
        name: "email",
        label: "Email",
        default: "alice@example.com",
      },
      {
        name: "apiToken",
        sensitive: true,
        default: "super-secret-token",
        kind: "string",
      },
    ],
    createdAt: iso as any,
    updatedAt: iso as any,
  };
}

describe("rr-flow-convert sensitive variables", () => {
  it("redacts sensitive variables from builder editor payloads", () => {
    const { flow } = flowV3ToBuilderForEditor(createFlowV3());

    expect(flow.variables).toEqual([
      {
        key: "email",
        label: "Email",
        default: "alice@example.com",
      },
    ]);
  });

  it("preserves hidden sensitive variables when merging builder edits back to V3", () => {
    const source = createFlowV3();
    const hidden = extractHiddenSensitiveVariables(source);
    const merged = mergeHiddenSensitiveVariables(
      {
        ...source,
        variables: [
          {
            name: "email",
            label: "Email",
            default: "updated@example.com",
          },
        ],
      },
      hidden,
    );

    expect(merged.variables).toEqual([
      {
        name: "email",
        label: "Email",
        default: "updated@example.com",
      },
      {
        name: "apiToken",
        sensitive: true,
        default: "super-secret-token",
        kind: "string",
      },
    ]);
  });
});
