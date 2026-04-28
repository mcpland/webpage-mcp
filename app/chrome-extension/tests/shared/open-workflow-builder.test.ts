import { beforeEach, describe, expect, it, vi } from "vitest";

import { openWorkflowBuilder } from "@/entrypoints/shared/utils";

describe("openWorkflowBuilder", () => {
  const getURL = vi.fn((path: string) => `chrome-extension://test/${path}`);
  const query = vi.fn(async () => [{ id: 42, url: "https://example.com/" }]);
  const create = vi.fn(async (options: chrome.tabs.CreateProperties) => ({
    id: 1,
    ...options,
  }));

  beforeEach(() => {
    getURL.mockClear();
    query.mockClear();
    create.mockClear();
    Object.assign(globalThis, {
      chrome: {
        runtime: {
          getURL,
        },
        tabs: {
          query,
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

  it("preserves the active source tab when requested", async () => {
    await openWorkflowBuilder({
      flowId: "flow-1",
      preserveActiveTabContext: true,
    });

    expect(query).toHaveBeenCalledWith({
      active: true,
      currentWindow: true,
    });
    expect(getURL).toHaveBeenCalledWith(
      "builder.html?flowId=flow-1&sourceTabId=42",
    );
    expect(create).toHaveBeenCalledWith({
      url: "chrome-extension://test/builder.html?flowId=flow-1&sourceTabId=42",
      active: true,
    });
  });

  it("does not preserve non-runnable active source tabs", async () => {
    query.mockResolvedValueOnce([{ id: 42, url: "chrome://extensions/" }]);

    await openWorkflowBuilder({
      flowId: "flow-1",
      preserveActiveTabContext: true,
    });

    expect(query).toHaveBeenCalledWith({
      active: true,
      currentWindow: true,
    });
    expect(getURL).toHaveBeenCalledWith("builder.html?flowId=flow-1");
    expect(create).toHaveBeenCalledWith({
      url: "chrome-extension://test/builder.html?flowId=flow-1",
      active: true,
    });
  });
});
