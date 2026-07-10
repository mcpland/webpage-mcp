import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FlowV3 } from "@/entrypoints/background/record-replay-v3/domain/flow";

const dependencyMocks = vi.hoisted(() => ({
  acquireKeepalive: vi.fn(() => vi.fn()),
  clearAllSessionContexts: vi.fn(),
  handleCallTool: vi.fn(),
  updateConnectionBadge: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/entrypoints/background/tools", () => ({
  handleCallTool: dependencyMocks.handleCallTool,
}));
vi.mock("@/entrypoints/background/keepalive-manager", () => ({
  acquireKeepalive: dependencyMocks.acquireKeepalive,
}));
vi.mock("@/entrypoints/background/action-badge", () => ({
  updateConnectionBadge: dependencyMocks.updateConnectionBadge,
}));
vi.mock("@/entrypoints/background/first-connect-notification", () => ({
  maybeShowFirstConnectNotification: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/entrypoints/background/session-context", () => ({
  clearAllSessionContexts: dependencyMocks.clearAllSessionContexts,
  clearSessionContextsForTab: vi.fn(),
  clearSessionContextsForWindow: vi.fn(),
}));
vi.mock("@/entrypoints/background/tab-queue", () => ({
  clearTabQueue: vi.fn(),
}));

type RecordReplayV3Module = typeof import("@/entrypoints/background/record-replay-v3");
type MessageListener = (message: unknown) => void | Promise<void>;

function createFlow(index: number): FlowV3 {
  const suffix = String(index).padStart(2, "0");
  const timestamp = new Date(Date.UTC(2026, 0, index + 1)).toISOString();
  return {
    schemaVersion: 3,
    id: `flow-${suffix}`,
    name: `Flow ${suffix}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    entryNodeId: "node-1",
    nodes: [{ id: "node-1", kind: "test", config: {} }],
    edges: [],
    ...(index % 5 !== 0
      ? {
          meta: {
            tool: {
              published: true,
              slug: `published-${suffix}`,
            },
          },
        }
      : {}),
  };
}

describe("native published workflow handshake", () => {
  let recordReplayV3: RecordReplayV3Module | undefined;
  let messageListener: MessageListener | undefined;
  let postMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    messageListener = undefined;
    postMessage = vi.fn();

    const port = {
      onMessage: {
        addListener: vi.fn((listener: MessageListener) => {
          messageListener = listener;
        }),
        removeListener: vi.fn(),
      },
      onDisconnect: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      postMessage,
      disconnect: vi.fn(),
    } as unknown as chrome.runtime.Port;

    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        lastError: null,
        connectNative: vi.fn(() => port),
        getManifest: vi.fn(() => ({ version: "0.9.0" })),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: {
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      windows: {
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });

    recordReplayV3 = await import(
      "@/entrypoints/background/record-replay-v3"
    );
    await recordReplayV3.deleteRrV3Db();
  });

  afterEach(async () => {
    await recordReplayV3?.deleteRrV3Db();
    recordReplayV3 = undefined;
    vi.unstubAllGlobals();
  });

  it("returns every published descriptor beyond the default page and omits drafts", async () => {
    const storage = recordReplayV3!.createStoragePort();
    const flows = Array.from({ length: 30 }, (_, index) => createFlow(index));
    for (const flow of flows) {
      await storage.flows.save(flow);
    }

    const defaultPage = await storage.flows.list();
    expect(defaultPage).toHaveLength(20);
    expect(defaultPage.map((flow) => flow.id)).not.toContain("flow-01");

    const { connectNativeHost } = await import(
      "@/entrypoints/background/native-host"
    );
    expect(connectNativeHost()).toBe(true);
    expect(messageListener).toBeTypeOf("function");

    await messageListener!({
      type: "rr_list_published_flows",
      requestId: "published-request",
      payload: {},
    });

    expect(postMessage).toHaveBeenCalledOnce();
    const response = postMessage.mock.calls[0][0] as {
      responseToRequestId: string;
      payload: { status: string; items: Array<{ id: string; slug: string }> };
    };
    expect(response.responseToRequestId).toBe("published-request");
    expect(response.payload.status).toBe("success");
    expect(response.payload.items).toHaveLength(24);
    expect(response.payload.items.map((item) => item.id)).toContain("flow-01");
    expect(response.payload.items.map((item) => item.id)).not.toContain(
      "flow-00",
    );
    expect(response.payload.items.map((item) => item.slug)).toEqual(
      response.payload.items.map((item) => item.slug).sort(),
    );
  });
});
