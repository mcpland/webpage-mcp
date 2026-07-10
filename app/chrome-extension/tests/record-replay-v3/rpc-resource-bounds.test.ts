import { describe, expect, it, vi } from "vitest";

import {
  FLOW_RESOURCE_LIMITS,
  type FlowV3,
} from "@/entrypoints/background/record-replay-v3";
import { createNotImplementedStoragePort } from "@/entrypoints/background/record-replay-v3/engine/storage/storage-port";
import { RpcServer } from "@/entrypoints/background/record-replay-v3/engine/transport/rpc-server";
import type { EventsBus } from "@/entrypoints/background/record-replay-v3/engine/transport/events-bus";

function createServer() {
  const storage = createNotImplementedStoragePort();
  const list = vi.fn(async () => [] as FlowV3[]);
  const get = vi.fn(async () => null);
  const save = vi.fn(async () => undefined);
  storage.flows = {
    list,
    get,
    save,
    delete: vi.fn(async () => undefined),
  };
  const events = {
    append: vi.fn(),
    list: vi.fn(async () => []),
    subscribe: vi.fn(() => () => undefined),
  } as unknown as EventsBus;
  return { server: new RpcServer({ storage, events }), list, get, save };
}

async function call(
  server: RpcServer,
  method: "rr_v3.saveFlow" | "rr_v3.listFlows",
  params: Record<string, unknown>,
): Promise<unknown> {
  return (
    server as unknown as {
      handleRequest(
        request: {
          method: string;
          params: Record<string, unknown>;
          requestId: string;
        },
        connection: { subscriptions: Set<null> },
      ): Promise<unknown>;
    }
  ).handleRequest(
    { method, params, requestId: "resource-bounds" },
    { subscriptions: new Set() },
  );
}

describe("RR-V3 RPC resource bounds", () => {
  it("rejects an oversized raw flow before normalization or storage lookup", async () => {
    const { server, get, save } = createServer();
    const nodes = Array.from(
      { length: FLOW_RESOURCE_LIMITS.maxNodes + 1 },
      (_, index) => ({
        id: `node-${index}`,
        kind: "navigate",
        config: {},
      }),
    );

    await expect(
      call(server, "rr_v3.saveFlow", {
        flow: {
          id: "oversized",
          name: "Oversized",
          entryNodeId: "node-0",
          nodes,
          edges: [],
        },
      }),
    ).rejects.toThrow(
      `flow.nodes exceeds the ${FLOW_RESOURCE_LIMITS.maxNodes}-node limit`,
    );
    expect(get).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("validates list pagination and forwards only bounded values", async () => {
    const { server, list } = createServer();

    await call(server, "rr_v3.listFlows", { offset: 2, limit: 3 });
    expect(list).toHaveBeenCalledWith({ offset: 2, limit: 3 });

    await expect(call(server, "rr_v3.listFlows", { limit: 0 })).rejects.toThrow(
      `limit must be an integer between 1 and ${FLOW_RESOURCE_LIMITS.maxListLimit}`,
    );
    await expect(
      call(server, "rr_v3.listFlows", {
        offset: FLOW_RESOURCE_LIMITS.maxStoredFlows + 1,
      }),
    ).rejects.toThrow(
      `offset must be an integer between 0 and ${FLOW_RESOURCE_LIMITS.maxStoredFlows}`,
    );
  });

  it("rejects oversized execution policies before storage lookup", async () => {
    const { server, get } = createServer();

    await expect(
      call(server, "rr_v3.saveFlow", {
        flow: {
          id: "retry-overflow",
          name: "Retry overflow",
          entryNodeId: "node-1",
          nodes: [{ id: "node-1", kind: "navigate", config: {} }],
          edges: [],
          policy: {
            defaultNodePolicy: {
              retry: {
                retries: FLOW_RESOURCE_LIMITS.maxRetries + 1,
                intervalMs: 0,
              },
            },
          },
        },
      }),
    ).rejects.toThrow(`${FLOW_RESOURCE_LIMITS.maxRetries}`);
    expect(get).not.toHaveBeenCalled();
  });
});
