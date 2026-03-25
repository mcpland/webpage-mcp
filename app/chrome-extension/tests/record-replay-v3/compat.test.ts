import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bootstrapV3: vi.fn(),
  enqueueRun: vi.fn(),
}));

vi.mock("@/entrypoints/background/record-replay-v3/bootstrap", () => ({
  bootstrapV3: mocks.bootstrapV3,
}));

vi.mock(
  "@/entrypoints/background/record-replay-v3/engine/queue/enqueue-run",
  () => ({
    enqueueRun: mocks.enqueueRun,
  }),
);

import {
  enqueueRunAndWait,
  importFlowsToV3,
  saveFlowToV3,
} from "@/entrypoints/background/record-replay-v3/compat";

function asMock(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

function createRuntime() {
  const flows = new Map<string, any>();
  return {
    storage: {
      flows: {
        get: vi.fn(async (id: string) => flows.get(id) ?? null),
        save: vi.fn(async (flow: any) => {
          flows.set(flow.id, flow);
        }),
        list: vi.fn(async () => Array.from(flows.values())),
      },
      runs: {
        get: vi.fn().mockResolvedValue({
          id: "run-1",
          status: "succeeded",
          tookMs: 4,
          outputs: null,
        }),
      },
      events: {
        list: vi.fn().mockResolvedValue([]),
      },
    },
    events: {},
    scheduler: {},
  } as any;
}

describe("record-replay-v3 compat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bootstrapV3.mockResolvedValue(createRuntime());
    mocks.enqueueRun.mockResolvedValue({ runId: "run-1" });
    if (typeof (chrome.tabs as any).query !== "function") {
      (chrome.tabs as any).query = vi.fn();
    }
    if (typeof (chrome.tabs as any).get !== "function") {
      (chrome.tabs as any).get = vi.fn();
    }
    if (typeof (chrome.tabs as any).create !== "function") {
      (chrome.tabs as any).create = vi.fn();
    }
    if (typeof (chrome.tabs as any).update !== "function") {
      (chrome.tabs as any).update = vi.fn();
    }
    if (typeof (chrome.tabs as any).reload !== "function") {
      (chrome.tabs as any).reload = vi.fn();
    }
    asMock(chrome.tabs.query).mockReset();
    asMock(chrome.tabs.get).mockReset();
    asMock(chrome.tabs.create).mockReset();
    asMock(chrome.tabs.update).mockReset();
    asMock(chrome.tabs.reload).mockReset();
  });

  it("binds runs to an existing web tab by default instead of creating a blank ephemeral tab", async () => {
    const extensionTab = {
      id: 10,
      url: "chrome-extension://abc123/popup.html",
      active: true,
      status: "complete",
      windowId: 1,
    };
    const webTab = {
      id: 22,
      url: "https://example.com/dashboard",
      active: false,
      status: "complete",
      windowId: 1,
    };

    asMock(chrome.tabs.query).mockImplementation(async (query) => {
      if (query?.active) {
        return [extensionTab];
      }
      return [extensionTab, webTab];
    });
    asMock(chrome.tabs.update).mockResolvedValue({ ...webTab, active: true });

    await enqueueRunAndWait({
      flowId: "flow-1" as any,
    });

    expect(chrome.tabs.update).toHaveBeenCalledWith(22, { active: true });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(mocks.enqueueRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        flowId: "flow-1",
        tabId: 22,
      }),
    );
  });

  it("creates a new tab for explicit new-tab execution before enqueueing the run", async () => {
    const activeTab = {
      id: 15,
      url: "https://example.com/current",
      active: true,
      status: "complete",
      windowId: 1,
    };
    const createdTab = {
      id: 99,
      url: "https://example.com/checkout",
      active: true,
      status: "complete",
      windowId: 1,
    };

    asMock(chrome.tabs.query).mockImplementation(async () => [activeTab]);
    asMock(chrome.tabs.create).mockResolvedValue(createdTab);
    asMock(chrome.tabs.get).mockImplementation(async (tabId: number) => {
      if (tabId === 99) {
        return createdTab;
      }
      if (tabId === 15) {
        return activeTab;
      }
      throw new Error(`Unknown tab ${tabId}`);
    });

    await enqueueRunAndWait({
      flowId: "flow-2" as any,
      tabTarget: "new",
      startUrl: "https://example.com/checkout",
    });

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      active: true,
      url: "https://example.com/checkout",
    });
    expect(mocks.enqueueRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        flowId: "flow-2",
        tabId: 99,
      }),
    );
  });

  it("falls back to an about:blank tab instead of binding runs to a non-web current tab", async () => {
    const extensionTab = {
      id: 10,
      url: "chrome-extension://abc123/popup.html",
      active: true,
      status: "complete",
      windowId: 1,
    };
    const createdTab = {
      id: 55,
      url: "about:blank",
      active: true,
      status: "complete",
      windowId: 1,
    };

    asMock(chrome.tabs.query).mockImplementation(async () => [extensionTab]);
    asMock(chrome.tabs.create).mockResolvedValue(createdTab);
    asMock(chrome.tabs.get)
      .mockResolvedValueOnce(createdTab)
      .mockResolvedValueOnce(createdTab);

    await enqueueRunAndWait({
      flowId: "flow-current-fallback" as any,
      tabTarget: "current",
    });

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      active: true,
      url: "about:blank",
    });
    expect(mocks.enqueueRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        flowId: "flow-current-fallback",
        tabId: 55,
      }),
    );
  });

  it("uses about:blank for new-tab runs when the active tab is not a web page", async () => {
    const extensionTab = {
      id: 12,
      url: "chrome-extension://abc123/popup.html",
      active: true,
      status: "complete",
      windowId: 1,
    };
    const createdTab = {
      id: 77,
      url: "about:blank",
      active: true,
      status: "complete",
      windowId: 1,
    };

    asMock(chrome.tabs.query).mockImplementation(async () => [extensionTab]);
    asMock(chrome.tabs.create).mockResolvedValue(createdTab);
    asMock(chrome.tabs.get).mockImplementation(async (tabId: number) => {
      if (tabId === 77) {
        return createdTab;
      }
      if (tabId === 12) {
        return extensionTab;
      }
      throw new Error(`Unknown tab ${tabId}`);
    });

    await enqueueRunAndWait({
      flowId: "flow-new-fallback" as any,
      tabTarget: "new",
    });

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      active: true,
      url: "about:blank",
    });
    expect(mocks.enqueueRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        flowId: "flow-new-fallback",
        tabId: 77,
      }),
    );
  });

  it("waits for startUrl navigation to actually begin before enqueueing a run on an explicit tab", async () => {
    const tabBeforeNavigation = {
      id: 31,
      url: "https://example.com/current",
      active: true,
      status: "complete",
      windowId: 1,
    };
    const tabWhileNavigating = {
      id: 31,
      url: "https://example.com/current",
      pendingUrl: "https://example.com/target",
      active: true,
      status: "loading",
      windowId: 1,
    };
    const tabAfterNavigation = {
      id: 31,
      url: "https://example.com/target",
      active: true,
      status: "complete",
      windowId: 1,
    };

    asMock(chrome.tabs.get)
      .mockResolvedValueOnce(tabBeforeNavigation)
      .mockResolvedValueOnce(tabBeforeNavigation)
      .mockResolvedValueOnce(tabBeforeNavigation)
      .mockResolvedValueOnce(tabWhileNavigating)
      .mockResolvedValueOnce(tabAfterNavigation);
    asMock(chrome.tabs.update).mockResolvedValue(tabAfterNavigation);

    await enqueueRunAndWait({
      flowId: "flow-3" as any,
      tabId: 31,
      startUrl: "https://example.com/target",
    });

    expect(chrome.tabs.update).toHaveBeenCalledWith(31, {
      url: "https://example.com/target",
    });
    expect(chrome.tabs.get).toHaveBeenCalledTimes(5);
    expect(mocks.enqueueRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        flowId: "flow-3",
        tabId: 31,
      }),
    );
  });

  it("waits for a refresh to leave the pre-reload complete state before enqueueing", async () => {
    const tabBeforeReload = {
      id: 41,
      url: "https://example.com/dashboard",
      active: true,
      status: "complete",
      windowId: 1,
    };
    const tabReloading = {
      id: 41,
      url: "https://example.com/dashboard",
      active: true,
      status: "loading",
      windowId: 1,
    };

    asMock(chrome.tabs.get)
      .mockResolvedValueOnce(tabBeforeReload)
      .mockResolvedValueOnce(tabBeforeReload)
      .mockResolvedValueOnce(tabBeforeReload)
      .mockResolvedValueOnce(tabReloading)
      .mockResolvedValueOnce(tabBeforeReload);

    await enqueueRunAndWait({
      flowId: "flow-4" as any,
      tabId: 41,
      refresh: true,
    });

    expect(chrome.tabs.reload).toHaveBeenCalledWith(41);
    expect(chrome.tabs.get).toHaveBeenCalledTimes(5);
    expect(mocks.enqueueRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        flowId: "flow-4",
        tabId: 41,
      }),
    );
  });

  it("saveFlowToV3 converts steps-only compatibility flows before persisting", async () => {
    const runtime = createRuntime();
    mocks.bootstrapV3.mockResolvedValue(runtime);

    const saved = await saveFlowToV3({
      id: "legacy-flow",
      name: "Legacy Flow",
      version: 1,
      steps: [
        { id: "step-1", type: "navigate", url: "https://example.com" },
        { id: "step-2", type: "click", target: { selector: "#submit" } },
      ],
    });

    expect(saved.entryNodeId).toBe("step-1");
    expect(saved.nodes.map((node) => node.id)).toEqual(["step-1", "step-2"]);
    expect(saved.edges).toEqual([
      expect.objectContaining({
        from: "step-1",
        to: "step-2",
      }),
    ]);
    expect(runtime.storage.flows.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "legacy-flow",
        entryNodeId: "step-1",
      }),
    );
  });

  it("importFlowsToV3 accepts legacy steps-only JSON payloads", async () => {
    const runtime = createRuntime();
    mocks.bootstrapV3.mockResolvedValue(runtime);

    const imported = await importFlowsToV3(
      JSON.stringify({
        flows: [
          {
            id: "legacy-import",
            name: "Imported Legacy Flow",
            version: 1,
            steps: [{ id: "step-a", type: "navigate", url: "https://example.com/import" }],
          },
        ],
      }),
    );

    expect(imported).toHaveLength(1);
    expect(imported[0]?.entryNodeId).toBe("step-a");
    expect(runtime.storage.flows.save).toHaveBeenCalledTimes(1);
  });

  it("importFlowsToV3 falls back unknown legacy step types to script nodes", async () => {
    const runtime = createRuntime();
    mocks.bootstrapV3.mockResolvedValue(runtime);

    const imported = await importFlowsToV3(
      JSON.stringify({
        flows: [
          {
            id: "legacy-unknown-type",
            name: "Imported Unknown Type",
            version: 1,
            steps: [{ id: "step-a", type: "unknown_type_xyz", code: "return 42;" }],
          },
        ],
      }),
    );

    expect(imported).toHaveLength(1);
    expect(imported[0]?.nodes).toEqual([
      expect.objectContaining({
        id: "step-a",
        kind: "script",
      }),
    ]);
    expect(runtime.storage.flows.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "legacy-unknown-type",
        nodes: [expect.objectContaining({ id: "step-a", kind: "script" })],
      }),
    );
  });

  it("saveFlowToV3 rejects duplicate node ids produced by legacy steps payloads", async () => {
    const runtime = createRuntime();
    mocks.bootstrapV3.mockResolvedValue(runtime);

    await expect(
      saveFlowToV3({
        id: "legacy-dup",
        name: "Legacy Duplicate Flow",
        version: 1,
        steps: [
          { id: "dup-step", type: "navigate", url: "https://example.com" },
          { id: "dup-step", type: "click", target: { selector: "#submit" } },
        ],
      }),
    ).rejects.toThrow('Duplicate node ID: "dup-step"');

    expect(runtime.storage.flows.save).not.toHaveBeenCalled();
  });

  it("saveFlowToV3 rejects node kinds that are explicitly unsupported by the V3 runtime", async () => {
    const runtime = createRuntime();
    mocks.bootstrapV3.mockResolvedValue(runtime);

    await expect(
      saveFlowToV3({
        schemaVersion: 3,
        id: "unsupported-kind",
        name: "Unsupported Kind",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        entryNodeId: "node-1",
        nodes: [{ id: "node-1", kind: "foreach", config: {} }],
        edges: [],
      }),
    ).rejects.toThrow(
      'flow.nodes[0].kind "foreach" is not supported by the current V3 runtime',
    );

    expect(runtime.storage.flows.save).not.toHaveBeenCalled();
  });
});
