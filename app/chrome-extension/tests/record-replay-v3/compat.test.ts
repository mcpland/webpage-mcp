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

import { enqueueRunAndWait } from "@/entrypoints/background/record-replay-v3/compat";

function asMock(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

function createRuntime() {
  return {
    storage: {
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
});
