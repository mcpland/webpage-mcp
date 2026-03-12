import { describe, expect, it } from "vitest";

import {
  V3_UNSUPPORTED_NODE_TYPES,
  canCreateV3AuthoringNodeType,
  getV3AuthoringCompatibility,
  getV3AuthoringPaletteTypes,
} from "@/entrypoints/shared/utils/v3-authoring";

describe("v3 authoring support matrix", () => {
  it("omits unsupported node types from the palette", () => {
    const palette = getV3AuthoringPaletteTypes();

    expect(palette).toContain("click");
    expect(palette).not.toContain("trigger");
    for (const type of V3_UNSUPPORTED_NODE_TYPES) {
      expect(palette).not.toContain(type);
    }
  });

  it("optionally includes trigger creation", () => {
    expect(canCreateV3AuthoringNodeType("trigger")).toBe(false);
    expect(
      canCreateV3AuthoringNodeType("trigger", { includeTrigger: true }),
    ).toBe(true);
  });

  it("flags unsupported nodes and subflows as incompatible", () => {
    const compatibility = getV3AuthoringCompatibility({
      nodes: [
        { type: "click" },
        { type: "foreach" },
        { kind: "executeFlow" },
        { type: "loopElements" },
        { type: "foreach" },
      ],
      subflows: {
        branchA: {},
      },
    });

    expect(compatibility.isCompatible).toBe(false);
    expect(compatibility.unsupportedNodeTypes).toEqual([
      "executeFlow",
      "foreach",
      "loopElements",
    ]);
    expect(compatibility.hasSubflows).toBe(true);
    expect(compatibility.messages).toContain(
      "Unsupported node types for V3 authoring: executeFlow, foreach, loopElements.",
    );
    expect(compatibility.messages).toContain(
      "Subflows are not supported in V3 authoring yet.",
    );
  });
});
