import { beforeEach, describe, expect, it, vi } from "vitest";

import { openWorkflowBuilder } from "@/entrypoints/shared/utils";

describe("openWorkflowBuilder", () => {
  const getURL = vi.fn((path: string) => `chrome-extension://test/${path}`);
  const create = vi.fn(async (options: chrome.tabs.CreateProperties) => ({
    id: 1,
    ...options,
  }));

  beforeEach(() => {
    getURL.mockClear();
    create.mockClear();
    Object.assign(globalThis, {
      chrome: {
        runtime: {
          getURL,
        },
        tabs: {
          create,
        },
      },
    });
  });

  it("opens the builder in create mode", async () => {
    await openWorkflowBuilder({ createNew: true });

    expect(getURL).toHaveBeenCalledWith("builder.html?new=1");
    expect(create).toHaveBeenCalledWith({
      url: "chrome-extension://test/builder.html?new=1",
      active: true,
    });
  });

  it("opens the builder for an existing flow and focus target", async () => {
    await openWorkflowBuilder({ flowId: "flow-1", focusNodeId: "node-7" });

    expect(getURL).toHaveBeenCalledWith(
      "builder.html?flowId=flow-1&focus=node-7",
    );
    expect(create).toHaveBeenCalledWith({
      url: "chrome-extension://test/builder.html?flowId=flow-1&focus=node-7",
      active: true,
    });
  });
});
