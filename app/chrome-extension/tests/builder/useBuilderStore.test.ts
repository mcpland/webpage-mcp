// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { nodesToSteps } from "@/entrypoints/popup/components/builder/model/transforms";
import { useBuilderStore } from "@/entrypoints/popup/components/builder/store/useBuilderStore";

describe("useBuilderStore V3 authoring guards", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not expose unsupported V3 node types in the palette", () => {
    const store = useBuilderStore();

    expect(store.paletteTypes).toContain("trigger");
    expect(store.paletteTypes).not.toContain("executeFlow");
    expect(store.paletteTypes).not.toContain("foreach");
    expect(store.paletteTypes).not.toContain("loopElements");
    expect(store.paletteTypes).not.toContain("while");
  });

  it("adds a single source-only trigger node without putting it on the execution path", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const store = useBuilderStore();

    store.addNode("click");
    store.addNode("trigger");
    store.addNode("trigger");

    const triggerNodes = store.nodes.filter((node) => node.type === "trigger");
    expect(triggerNodes).toHaveLength(1);
    expect(store.nodes[0].type).toBe("trigger");
    expect(store.edges.some((edge) => edge.to === triggerNodes[0].id)).toBe(false);
    expect(
      store.edges.some(
        (edge) => edge.from === triggerNodes[0].id && edge.to === store.nodes[1].id,
      ),
    ).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "rr_toast",
        detail: expect.objectContaining({
          message: "This workflow already has a trigger node",
        }),
      }),
    );
  });

  it("excludes trigger nodes and trigger edges when exporting executable steps", () => {
    const store = useBuilderStore();

    store.addNode("click");
    store.addNode("trigger");
    store.edges.push({
      id: "rogue-click-to-trigger",
      from: store.nodes[1].id,
      to: store.nodes[0].id,
      label: "default",
    });

    const steps = nodesToSteps(store.nodes, store.edges);

    expect(steps).toHaveLength(1);
    expect(steps[0]?.type).toBe("click");
  });

  it("rejects unsupported node creation requests", () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const store = useBuilderStore();

    store.addNode("executeFlow");
    store.addNodeAt("loopElements", 80, 120);

    expect(store.nodes).toHaveLength(0);
    expect(dispatchSpy).toHaveBeenCalledTimes(2);

    const firstToast = dispatchSpy.mock.calls[0]?.[0] as
      | CustomEvent
      | undefined;
    expect(firstToast?.type).toBe("rr_toast");
    expect(firstToast?.detail?.message).toContain("executeFlow");
  });
});
