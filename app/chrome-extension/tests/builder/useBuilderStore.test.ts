// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { useBuilderStore } from "@/entrypoints/popup/components/builder/store/useBuilderStore";

describe("useBuilderStore V3 authoring guards", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not expose unsupported V3 node types in the palette", () => {
    const store = useBuilderStore();

    expect(store.paletteTypes).not.toContain("executeFlow");
    expect(store.paletteTypes).not.toContain("foreach");
    expect(store.paletteTypes).not.toContain("loopElements");
    expect(store.paletteTypes).not.toContain("while");
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
