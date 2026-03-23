/**
 * @fileoverview Compatibility-flow conversion tests.
 * @description Tests compatibility-flow -> V3 conversion logic, especially entryNodeId calculation.
 */

import { describe, it, expect } from "vitest";
import {
  convertCompatFlowToV3,
  convertFlowV3ToCompat,
} from "@/entrypoints/background/record-replay-v3/storage/import/flow-convert";

// ==================== Test Helpers ====================

function createCompatFlowDocument(
  overrides: Partial<Parameters<typeof convertCompatFlowToV3>[0]> = {},
) {
  return {
    id: "test-flow",
    name: "Test Flow",
    version: 2,
    nodes: [],
    edges: [],
    ...overrides,
  };
}

// ==================== entryNodeId Calculation Tests ====================

describe("convertCompatFlowToV3 - entryNodeId calculation", () => {
  describe("basic scenarios", () => {
    it("selects the only executable node as entry", () => {
      const result = convertCompatFlowToV3(
        createCompatFlowDocument({
          nodes: [{ id: "nav-1", type: "navigate" }],
          edges: [],
        }),
      );

      expect(result.success).toBe(true);
      expect(result.data?.entryNodeId).toBe("nav-1");
      expect(result.warnings).toHaveLength(0);
    });

    it("selects node with inDegree=0 as entry", () => {
      const result = convertCompatFlowToV3(
        createCompatFlowDocument({
          nodes: [
            { id: "nav-1", type: "navigate" },
            { id: "click-1", type: "click" },
          ],
          edges: [{ id: "e1", from: "nav-1", to: "click-1" }],
        }),
      );

      expect(result.success).toBe(true);
      expect(result.data?.entryNodeId).toBe("nav-1");
    });
  });

  describe("trigger node handling", () => {
    it("ignores trigger node when selecting entry", () => {
      const result = convertCompatFlowToV3(
        createCompatFlowDocument({
          nodes: [
            { id: "trigger-1", type: "trigger" },
            { id: "nav-1", type: "navigate" },
          ],
          edges: [],
        }),
      );

      expect(result.success).toBe(true);
      expect(result.data?.entryNodeId).toBe("nav-1");
    });

    it("ignores edges from trigger node when calculating inDegree", () => {
      // Scenario: trigger → navigate → click
      // Without this fix, navigate would have inDegree=1 and not be selected
      const result = convertCompatFlowToV3(
        createCompatFlowDocument({
          nodes: [
            { id: "trigger-1", type: "trigger" },
            { id: "nav-1", type: "navigate" },
            { id: "click-1", type: "click" },
          ],
          edges: [
            { id: "e1", from: "trigger-1", to: "nav-1" },
            { id: "e2", from: "nav-1", to: "click-1" },
          ],
        }),
      );

      expect(result.success).toBe(true);
      // navigate should be entry because trigger edges are ignored
      expect(result.data?.entryNodeId).toBe("nav-1");
    });

    it("returns error when only trigger nodes exist", () => {
      const result = convertCompatFlowToV3(
        createCompatFlowDocument({
          nodes: [{ id: "trigger-1", type: "trigger" }],
          edges: [],
        }),
      );

      expect(result.success).toBe(false);
      expect(result.errors).toContain(
        "Could not determine entry node. No valid root node found.",
      );
    });
  });

  describe("multiple root nodes - stable selection", () => {
    it("warns and selects by UI coordinates (leftmost, then topmost)", () => {
      const result = convertCompatFlowToV3(
        createCompatFlowDocument({
          nodes: [
            { id: "nav-b", type: "navigate", ui: { x: 200, y: 100 } },
            { id: "nav-a", type: "navigate", ui: { x: 100, y: 200 } },
            { id: "nav-c", type: "navigate", ui: { x: 100, y: 100 } },
          ],
          edges: [],
        }),
      );

      expect(result.success).toBe(true);
      // nav-c has smallest x, and smallest y at that x
      expect(result.data?.entryNodeId).toBe("nav-c");
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(
        result.warnings.some((w) => w.includes("Multiple inDegree=0")),
      ).toBe(true);
      expect(result.warnings.some((w) => w.includes("ui(x=100, y=100)"))).toBe(
        true,
      );
    });

    it("selects by ID when no UI coordinates available", () => {
      const result = convertCompatFlowToV3(
        createCompatFlowDocument({
          nodes: [
            { id: "nav-b", type: "navigate" },
            { id: "nav-a", type: "navigate" },
            { id: "nav-c", type: "navigate" },
          ],
          edges: [],
        }),
      );

      expect(result.success).toBe(true);
      // nav-a comes first alphabetically
      expect(result.data?.entryNodeId).toBe("nav-a");
      expect(result.warnings.some((w) => w.includes("by id"))).toBe(true);
    });

    it("uses UI for nodes that have it, ignoring nodes without UI", () => {
      const result = convertCompatFlowToV3(
        createCompatFlowDocument({
          nodes: [
            { id: "nav-a", type: "navigate" }, // no UI
            { id: "nav-b", type: "navigate", ui: { x: 50, y: 50 } },
          ],
          edges: [],
        }),
      );

      expect(result.success).toBe(true);
      // nav-b has UI coordinates, so it's preferred
      expect(result.data?.entryNodeId).toBe("nav-b");
    });
  });

  describe("cycle detection", () => {
    it("falls back using stable selection when graph has cycle (no inDegree=0)", () => {
      const result = convertCompatFlowToV3(
        createCompatFlowDocument({
          nodes: [
            { id: "nav-1", type: "navigate" },
            { id: "click-1", type: "click" },
          ],
          edges: [
            { id: "e1", from: "nav-1", to: "click-1" },
            { id: "e2", from: "click-1", to: "nav-1" },
          ],
        }),
      );

      expect(result.success).toBe(true);
      expect(result.data?.entryNodeId).toBeTruthy();
      expect(result.warnings.some((w) => w.includes("cycles"))).toBe(true);
    });

    it("uses stable selection (by id) for cycle fallback", () => {
      const result = convertCompatFlowToV3(
        createCompatFlowDocument({
          nodes: [
            { id: "z-node", type: "navigate" },
            { id: "a-node", type: "click" },
          ],
          edges: [
            { id: "e1", from: "z-node", to: "a-node" },
            { id: "e2", from: "a-node", to: "z-node" },
          ],
        }),
      );

      expect(result.success).toBe(true);
      // Should select 'a-node' as it comes first alphabetically
      expect(result.data?.entryNodeId).toBe("a-node");
      expect(result.warnings.some((w) => w.includes("by id"))).toBe(true);
    });

    it("uses stable selection (by UI) for cycle fallback when UI available", () => {
      const result = convertCompatFlowToV3(
        createCompatFlowDocument({
          nodes: [
            { id: "a-node", type: "navigate", ui: { x: 200, y: 100 } },
            { id: "z-node", type: "click", ui: { x: 100, y: 100 } },
          ],
          edges: [
            { id: "e1", from: "a-node", to: "z-node" },
            { id: "e2", from: "z-node", to: "a-node" },
          ],
        }),
      );

      expect(result.success).toBe(true);
      // Should select 'z-node' as it has smaller x coordinate
      expect(result.data?.entryNodeId).toBe("z-node");
      expect(result.warnings.some((w) => w.includes("ui(x=100"))).toBe(true);
    });
  });

  describe("UI coordinate edge cases", () => {
    it("treats NaN coordinates as invalid UI", () => {
      const result = convertCompatFlowToV3(
        createCompatFlowDocument({
          nodes: [
            { id: "nav-a", type: "navigate", ui: { x: NaN, y: 100 } },
            { id: "nav-b", type: "navigate" },
          ],
          edges: [],
        }),
      );

      expect(result.success).toBe(true);
      // Both nodes have no valid UI, should use ID sorting
      expect(result.data?.entryNodeId).toBe("nav-a");
      expect(result.warnings.some((w) => w.includes("by id"))).toBe(true);
    });

    it("treats Infinity coordinates as invalid UI", () => {
      const result = convertCompatFlowToV3(
        createCompatFlowDocument({
          nodes: [
            { id: "nav-a", type: "navigate", ui: { x: Infinity, y: 100 } },
            { id: "nav-b", type: "navigate", ui: { x: 50, y: 50 } },
          ],
          edges: [],
        }),
      );

      expect(result.success).toBe(true);
      // Only nav-b has valid UI
      expect(result.data?.entryNodeId).toBe("nav-b");
    });

    it("uses id as tie-breaker when UI coordinates are equal", () => {
      const result = convertCompatFlowToV3(
        createCompatFlowDocument({
          nodes: [
            { id: "nav-z", type: "navigate", ui: { x: 100, y: 100 } },
            { id: "nav-a", type: "navigate", ui: { x: 100, y: 100 } },
          ],
          edges: [],
        }),
      );

      expect(result.success).toBe(true);
      // Same coordinates, should use ID as tie-breaker
      expect(result.data?.entryNodeId).toBe("nav-a");
    });
  });

  describe("empty and error cases", () => {
    it("returns error when no nodes exist", () => {
      const result = convertCompatFlowToV3(
        createCompatFlowDocument({
          nodes: [],
          edges: [],
        }),
      );

      expect(result.success).toBe(false);
      expect(result.errors).toContain("Compatibility flow has no nodes");
    });

    it("rejects executeFlow nodes that the V3 runtime does not support", () => {
      const result = convertCompatFlowToV3(
        createCompatFlowDocument({
          nodes: [
            { id: "exec-1", type: "executeFlow", config: { flowId: "child" } },
          ],
          edges: [],
        }),
      );

      expect(result.success).toBe(false);
      expect(result.errors).toContain(
        "V3 does not support these node types yet. Found: exec-1 (executeFlow)",
      );
    });

    it("rejects loopElements nodes that still depend on subflows", () => {
      const result = convertCompatFlowToV3(
        createCompatFlowDocument({
          nodes: [
            {
              id: "loop-1",
              type: "loopElements",
              config: { selector: ".item", subflowId: "sub-1" },
            },
          ],
          edges: [],
        }),
      );

      expect(result.success).toBe(false);
      expect(result.errors).toContain(
        "V3 does not support these node types yet. Found: loop-1 (loopElements)",
      );
    });
  });
});

// ==================== Roundtrip Tests ====================

describe("compatibility-flow <-> V3 roundtrip conversion", () => {
  it("preserves basic flow structure through roundtrip", () => {
    const original = createCompatFlowDocument({
      name: "Roundtrip Test",
      description: "Test description",
      nodes: [
        {
          id: "nav-1",
          type: "navigate",
          config: { url: "https://example.com" },
        },
        { id: "click-1", type: "click", config: { selector: "#btn" } },
      ],
      edges: [{ id: "e1", from: "nav-1", to: "click-1" }],
    });

    const toV3 = convertCompatFlowToV3(original);
    expect(toV3.success).toBe(true);

    const backToCompat = convertFlowV3ToCompat(toV3.data!);
    expect(backToCompat.success).toBe(true);

    // Check structure preserved
    expect(backToCompat.data?.name).toBe(original.name);
    expect(backToCompat.data?.description).toBe(original.description);
    expect(backToCompat.data?.nodes).toHaveLength(2);
    expect(backToCompat.data?.edges).toHaveLength(1);
  });

  it("preserves node configs through roundtrip", () => {
    const original = createCompatFlowDocument({
      nodes: [
        {
          id: "nav-1",
          type: "navigate",
          name: "Go to site",
          disabled: true,
          config: { url: "https://example.com", waitUntil: "load" },
          ui: { x: 100, y: 200 },
        },
      ],
      edges: [],
    });

    const toV3 = convertCompatFlowToV3(original);
    const backToCompat = convertFlowV3ToCompat(toV3.data!);

    const node = backToCompat.data?.nodes?.[0];
    expect(node?.type).toBe("navigate");
    expect(node?.name).toBe("Go to site");
    expect(node?.disabled).toBe(true);
    expect(node?.config).toEqual({
      url: "https://example.com",
      waitUntil: "load",
    });
    expect(node?.ui).toEqual({ x: 100, y: 200 });
  });

  it("preserves legacy metadata through roundtrip", () => {
    const original = createCompatFlowDocument({
      description: "Published flow",
      nodes: [
        {
          id: "nav-1",
          type: "navigate",
          config: { url: "https://example.com" },
        },
      ],
      edges: [],
      meta: {
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
        domain: "example.com",
        tags: ["critical", "smoke"],
        bindings: [
          { type: "domain", value: "example.com" },
          { type: "path", value: "/checkout" },
        ],
        tool: {
          published: true,
          slug: "checkout-flow",
          category: "automation",
          description: "Run checkout automation",
        },
        exposedOutputs: [{ nodeId: "nav-1", as: "landing" }],
        recording: {
          originUrl: "https://example.com",
          originTitle: "Example",
          originTabId: 11,
          browser: "chrome",
          userAgent: "UA",
          startedAt: "2026-01-01T00:00:00.000Z",
          stoppedAt: "2026-01-01T00:00:05.000Z",
          durationMs: 5000,
          stepCount: 1,
          parameterSuggestions: [
            {
              nodeId: "nav-1",
              kind: "navigate",
              suggestedKey: "start_url",
              currentValue: "https://example.com",
            },
          ],
        },
        stopBarrier: {
          ok: true,
          sessionId: "session-1",
          stoppedAt: "2026-01-01T00:00:06.000Z",
          failed: [{ tabId: 11, skipped: false }],
        },
      },
    });

    const toV3 = convertCompatFlowToV3(original);
    expect(toV3.success).toBe(true);
    expect(toV3.data?.meta).toMatchObject({
      domain: "example.com",
      tags: ["critical", "smoke"],
      tool: {
        published: true,
        slug: "checkout-flow",
        category: "automation",
        description: "Run checkout automation",
      },
      exposedOutputs: [{ nodeId: "nav-1", as: "landing" }],
      recording: {
        originUrl: "https://example.com",
        parameterSuggestions: [
          {
            nodeId: "nav-1",
            kind: "navigate",
            suggestedKey: "start_url",
            currentValue: "https://example.com",
          },
        ],
      },
      stopBarrier: {
        ok: true,
        sessionId: "session-1",
      },
    });
    expect(toV3.data?.meta?.bindings).toEqual([
      { kind: "domain", value: "example.com" },
      { kind: "path", value: "/checkout" },
    ]);

    const backToV2 = convertFlowV3ToCompat(toV3.data!);
    expect(backToV2.success).toBe(true);
    expect(backToV2.data?.meta).toMatchObject({
      domain: "example.com",
      tags: ["critical", "smoke"],
      tool: {
        published: true,
        slug: "checkout-flow",
        category: "automation",
        description: "Run checkout automation",
      },
      exposedOutputs: [{ nodeId: "nav-1", as: "landing" }],
      recording: {
        originUrl: "https://example.com",
      },
      stopBarrier: {
        ok: true,
        sessionId: "session-1",
      },
    });
  });
});
