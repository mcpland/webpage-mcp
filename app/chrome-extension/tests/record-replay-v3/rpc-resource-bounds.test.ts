import { describe, expect, it, vi } from "vitest";

import {
  FLOW_RESOURCE_LIMITS,
  EVENT_RESOURCE_LIMITS,
  RR_V3_RPC_LIMITS,
  RUN_RESOURCE_LIMITS,
  RUN_SCHEMA_VERSION,
  type FlowV3,
  type RunRecordV3,
} from "@/entrypoints/background/record-replay-v3";
import { createNotImplementedStoragePort } from "@/entrypoints/background/record-replay-v3/engine/storage/storage-port";
import { RpcServer } from "@/entrypoints/background/record-replay-v3/engine/transport/rpc-server";
import type { EventsBus } from "@/entrypoints/background/record-replay-v3/engine/transport/events-bus";

function createServer() {
  const storage = createNotImplementedStoragePort();
  const list = vi.fn(async () => [] as FlowV3[]);
  const get = vi.fn(async () => null);
  const save = vi.fn(async () => undefined);
  const runList = vi.fn(async () => [] as RunRecordV3[]);
  const runGet = vi.fn(async () => null as RunRecordV3 | null);
  const runDelete = vi.fn(async () => undefined);
  const eventList = vi.fn(async () => []);
  storage.flows = {
    list,
    get,
    save,
    delete: vi.fn(async () => undefined),
  };
  storage.runs = {
    list: runList,
    get: runGet,
    save: vi.fn(async () => undefined),
    patch: vi.fn(async () => undefined),
    delete: runDelete,
  };
  storage.events = {
    append: vi.fn(),
    list: eventList,
    deleteByRun: vi.fn(async () => 0),
  };
  const events = {
    append: vi.fn(),
    list: vi.fn(async () => []),
    subscribe: vi.fn(() => () => undefined),
  } as unknown as EventsBus;
  return {
    server: new RpcServer({ storage, events }),
    list,
    get,
    save,
    runList,
    runGet,
    runDelete,
    eventList,
  };
}

async function call(
  server: RpcServer,
  method:
    | "rr_v3.saveFlow"
    | "rr_v3.listFlows"
    | "rr_v3.listRuns"
    | "rr_v3.getEvents"
    | "rr_v3.deleteRun"
    | "rr_v3.startRun",
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

  it("validates run and event pagination before forwarding bounded options", async () => {
    const { server, runList, eventList } = createServer();

    await call(server, "rr_v3.listRuns", {
      offset: 2,
      limit: 3,
      status: "failed",
    });
    expect(runList).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 2, limit: 3, status: "failed" }),
    );

    await call(server, "rr_v3.getEvents", { runId: "run-1" });
    expect(eventList).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        fromSeq: 0,
        limit: RR_V3_RPC_LIMITS.defaultEventListLimit,
        maxBytes: EVENT_RESOURCE_LIMITS.maxListUtf8Bytes,
      }),
    );

    await expect(
      call(server, "rr_v3.listRuns", {
        limit: RUN_RESOURCE_LIMITS.maxListLimit + 1,
      }),
    ).rejects.toThrow(`${RUN_RESOURCE_LIMITS.maxListLimit}`);
    await expect(
      call(server, "rr_v3.getEvents", {
        runId: "run-1",
        limit: EVENT_RESOURCE_LIMITS.maxListLimit + 1,
      }),
    ).rejects.toThrow(`${EVENT_RESOURCE_LIMITS.maxListLimit}`);
  });

  it("only deletes terminal runs", async () => {
    const { server, runGet, runDelete } = createServer();
    const run: RunRecordV3 = {
      schemaVersion: RUN_SCHEMA_VERSION,
      id: "run-1",
      flowId: "flow-1",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
      attempt: 1,
      maxAttempts: 1,
      nextSeq: 0,
    };
    runGet.mockResolvedValue(run);
    await expect(
      call(server, "rr_v3.deleteRun", { runId: run.id }),
    ).rejects.toThrow("Cannot delete non-terminal run");
    runGet.mockResolvedValue({ ...run, status: "succeeded" });
    await expect(
      call(server, "rr_v3.deleteRun", { runId: run.id }),
    ).resolves.toEqual({
      deleted: true,
      runId: run.id,
    });
    expect(runDelete).toHaveBeenCalledWith(run.id);
  });

  it("rejects oversized envelopes and run inputs before dispatch side effects", async () => {
    const { server, list, get } = createServer();
    const handleRequest = (
      server as unknown as {
        handleRequest(
          request: Record<string, unknown>,
          connection: unknown,
        ): Promise<unknown>;
      }
    ).handleRequest.bind(server);

    await expect(
      handleRequest(
        {
          method: "rr_v3.listFlows",
          params: {},
          requestId: "x".repeat(RR_V3_RPC_LIMITS.maxRequestIdUtf8Bytes + 1),
        },
        { subscriptions: new Set() },
      ),
    ).rejects.toThrow("requestId exceeds");
    expect(list).not.toHaveBeenCalled();

    await expect(
      call(server, "rr_v3.startRun", {
        flowId: "flow-1",
        args: { huge: "x".repeat(RUN_RESOURCE_LIMITS.maxStringUtf8Bytes + 1) },
      }),
    ).rejects.toThrow("run request.args.huge exceeds");
    expect(get).not.toHaveBeenCalled();
  });
});
