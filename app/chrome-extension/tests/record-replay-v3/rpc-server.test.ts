import { describe, expect, it, vi } from "vitest";

import { RpcServer } from "@/entrypoints/background/record-replay-v3/engine/transport/rpc-server";
import type { StoragePort } from "@/entrypoints/background/record-replay-v3/engine/storage/storage-port";
import type { EventsBus } from "@/entrypoints/background/record-replay-v3/engine/transport/events-bus";
import { RR_V3_RPC_LIMITS } from "@/entrypoints/background/record-replay-v3";
import { RR_V3_PORT_NAME } from "@/entrypoints/background/record-replay-v3/engine/transport/rpc";

function createMockStorage(): StoragePort {
  return {
    flows: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
    runs: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      patch: vi.fn(async () => {}),
    },
    events: {
      append: vi.fn(
        async () =>
          ({ runId: "run-1", type: "log", ts: Date.now(), seq: 1 }) as any,
      ),
      list: vi.fn(async () => []),
    },
    queue: {
      enqueue: vi.fn(async () => null as any),
      claimNext: vi.fn(async () => null),
      heartbeat: vi.fn(async () => {}),
      reclaimExpiredLeases: vi.fn(async () => []),
      markRunning: vi.fn(async () => {}),
      markPaused: vi.fn(async () => {}),
      markDone: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      get: vi.fn(async () => null),
      list: vi.fn(async () => []),
    },
    persistentVars: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => ({ key: "", value: null, updatedAt: 0 })),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => []),
    },
    triggers: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
  } as unknown as StoragePort;
}

function createMockPort(sender: chrome.runtime.MessageSender) {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port = {
    name: RR_V3_PORT_NAME,
    sender,
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: vi.fn((listener: (message: unknown) => void) =>
        messageListeners.push(listener),
      ),
    },
    onDisconnect: {
      addListener: vi.fn((listener: () => void) =>
        disconnectListeners.push(listener),
      ),
    },
  } as unknown as chrome.runtime.Port;
  return { port, messageListeners, disconnectListeners };
}

describe("RpcServer", () => {
  it("starts and stops without chrome.runtime.onConnect", () => {
    const subscribe = vi.fn(() => unsubscribe);
    const unsubscribe = vi.fn();
    const events = {
      subscribe,
      append: vi.fn(),
      list: vi.fn(),
    } as unknown as EventsBus;
    const originalOnConnect = chrome.runtime.onConnect;

    delete (chrome.runtime as { onConnect?: unknown }).onConnect;

    try {
      const server = new RpcServer({
        storage: createMockStorage(),
        events,
      });

      expect(() => server.start()).not.toThrow();
      expect(subscribe).toHaveBeenCalledTimes(1);

      expect(() => server.stop()).not.toThrow();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      if (originalOnConnect !== undefined) {
        (chrome.runtime as { onConnect?: typeof originalOnConnect }).onConnect =
          originalOnConnect;
      }
    }
  });

  it("accepts only bounded extension-page connections and cleans them on disconnect", () => {
    const originalGetUrl = chrome.runtime.getURL;
    chrome.runtime.getURL = vi.fn(
      (path = "") =>
        `chrome-extension://${chrome.runtime.id}/${path.replace(/^\//, "")}`,
    );
    try {
      const server = new RpcServer({
        storage: createMockStorage(),
        events: {
          subscribe: vi.fn(() => () => undefined),
        } as unknown as EventsBus,
      });
      const internals = server as unknown as {
        handleConnect(port: chrome.runtime.Port): void;
        connections: Map<string, unknown>;
      };
      const contentPort = createMockPort({
        id: chrome.runtime.id,
        tab: { id: 1 } as chrome.tabs.Tab,
        url: "https://example.com",
      });
      internals.handleConnect(contentPort.port);
      expect(contentPort.port.disconnect).toHaveBeenCalledOnce();
      expect(internals.connections.size).toBe(0);

      const pageSender: chrome.runtime.MessageSender = {
        id: chrome.runtime.id,
        url: `chrome-extension://${chrome.runtime.id}/sidepanel.html`,
        origin: `chrome-extension://${chrome.runtime.id}`,
      };
      const pagePort = createMockPort(pageSender);
      internals.handleConnect(pagePort.port);
      expect(internals.connections.size).toBe(1);
      pagePort.disconnectListeners[0]();
      expect(internals.connections.size).toBe(0);

      const accepted = Array.from(
        { length: RR_V3_RPC_LIMITS.maxConnections },
        () => createMockPort(pageSender),
      );
      accepted.forEach(({ port }) => internals.handleConnect(port));
      const overflow = createMockPort(pageSender);
      internals.handleConnect(overflow.port);
      expect(internals.connections.size).toBe(RR_V3_RPC_LIMITS.maxConnections);
      expect(overflow.port.disconnect).toHaveBeenCalledOnce();
    } finally {
      chrome.runtime.getURL = originalGetUrl;
    }
  });

  it("bounds subscriptions, in-flight calls, and echoed request IDs per connection", async () => {
    let resolveList!: () => void;
    const blockedList = new Promise<void>((resolve) => {
      resolveList = resolve;
    });
    const storage = createMockStorage();
    storage.flows.list = vi.fn(async () => {
      await blockedList;
      return [];
    });
    const server = new RpcServer({
      storage,
      events: {
        subscribe: vi.fn(() => () => undefined),
      } as unknown as EventsBus,
    });
    const port = createMockPort({ id: chrome.runtime.id });
    const connection = {
      port: port.port,
      subscriptions: new Set<string | null>(),
      inFlight: 0,
    };
    type TestConnection = typeof connection;
    const internals = server as unknown as {
      connections: Map<string, TestConnection>;
      handleMessage(connectionId: string, message: unknown): Promise<void>;
      handleRequest(
        request: Record<string, unknown>,
        connection: TestConnection,
      ): Promise<unknown>;
    };
    internals.connections.set("bounded", connection);

    const pending = Array.from(
      { length: RR_V3_RPC_LIMITS.maxInFlightPerConnection },
      (_, index) =>
        internals.handleMessage("bounded", {
          type: "rr_v3.request",
          method: "rr_v3.listFlows",
          params: {},
          requestId: `pending-${index}`,
        }),
    );
    await internals.handleMessage("bounded", {
      type: "rr_v3.request",
      method: "rr_v3.listFlows",
      params: {},
      requestId: "overflow",
    });
    expect(port.port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: "Too many in-flight RR-V3 requests",
      }),
    );
    resolveList();
    await Promise.all(pending);

    await internals.handleMessage("bounded", {
      type: "rr_v3.request",
      method: "rr_v3.listFlows",
      params: {},
      requestId: "x".repeat(RR_V3_RPC_LIMITS.maxRequestIdUtf8Bytes + 1),
    });
    expect(port.port.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: false, requestId: "" }),
    );

    for (
      let index = 0;
      index < RR_V3_RPC_LIMITS.maxSubscriptionsPerConnection;
      index += 1
    ) {
      connection.subscriptions.add(`run-${index}`);
    }
    await expect(
      internals.handleRequest(
        {
          method: "rr_v3.subscribe",
          params: { runId: "run-overflow" },
          requestId: "subscribe-overflow",
        },
        connection,
      ),
    ).rejects.toThrow("subscription limit exceeded");
  });
});
