import { beforeEach, describe, expect, it } from "vitest";

import {
  FLOW_RESOURCE_LIMITS,
  FLOW_SCHEMA_VERSION,
  closeRrV3Db,
  deleteRrV3Db,
  type FlowV3,
} from "@/entrypoints/background/record-replay-v3";
import { createFlowsStore } from "@/entrypoints/background/record-replay-v3/storage/flows";
import {
  RR_V3_STORES,
  withTransaction,
} from "@/entrypoints/background/record-replay-v3/storage/db";

function createFlow(
  id: string,
  updatedAt = "2026-01-01T00:00:00.000Z",
): FlowV3 {
  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id,
    name: `Flow ${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    entryNodeId: "node-1",
    nodes: [{ id: "node-1", kind: "test", config: {} }],
    edges: [],
  };
}

async function putFlowsWithoutValidation(flows: FlowV3[]): Promise<void> {
  await withTransaction(RR_V3_STORES.FLOWS, "readwrite", async (stores) => {
    const store = stores[RR_V3_STORES.FLOWS];
    await Promise.all(
      flows.map(
        (flow) =>
          new Promise<void>((resolve, reject) => {
            const request = store.put(flow);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
          }),
      ),
    );
  });
}

describe("V3 flow storage bounds", () => {
  beforeEach(async () => {
    await deleteRrV3Db();
    closeRrV3Db();
  });

  it("rejects node arrays beyond the persisted flow limit", async () => {
    const store = createFlowsStore();
    const flow = createFlow("too-many-nodes");
    flow.nodes = Array.from(
      { length: FLOW_RESOURCE_LIMITS.maxNodes + 1 },
      (_, index) => ({
        id: `node-${index}`,
        kind: "test",
        config: {},
      }),
    );
    flow.entryNodeId = flow.nodes[0].id;

    await expect(store.save(flow)).rejects.toThrow(
      `flow.nodes exceeds the ${FLOW_RESOURCE_LIMITS.maxNodes}-node limit`,
    );
  });

  it("rejects an oversized node config before writing it", async () => {
    const store = createFlowsStore();
    const flow = createFlow("oversized-config");
    const chunk = "x".repeat(240 * 1024);
    flow.nodes[0].config = {
      chunk1: chunk,
      chunk2: chunk,
      chunk3: chunk,
      chunk4: chunk,
      chunk5: chunk,
    };

    await expect(store.save(flow)).rejects.toThrow(
      `flow.nodes[0].config exceeds the ${FLOW_RESOURCE_LIMITS.maxNodeConfigUtf8Bytes}-byte JSON limit`,
    );
    expect(await store.get(flow.id)).toBeNull();
  });

  it("supports bounded newest-first pagination without getAll", async () => {
    const store = createFlowsStore();
    await store.save(createFlow("old", "2026-01-01T00:00:00.000Z"));
    await store.save(createFlow("middle", "2026-01-02T00:00:00.000Z"));
    await store.save(createFlow("new", "2026-01-03T00:00:00.000Z"));

    await expect(store.list({ limit: 2 })).resolves.toMatchObject([
      { id: "new" },
      { id: "middle" },
    ]);
    await expect(store.list({ offset: 1, limit: 1 })).resolves.toMatchObject([
      { id: "middle" },
    ]);
  });

  it("refuses a new flow after the collection cap but still permits updates", async () => {
    const store = createFlowsStore();
    const existing = Array.from(
      { length: FLOW_RESOURCE_LIMITS.maxStoredFlows },
      (_, index) => createFlow(`flow-${index}`),
    );
    await putFlowsWithoutValidation(existing);

    await expect(store.save(createFlow("overflow"))).rejects.toThrow(
      `Cannot store more than ${FLOW_RESOURCE_LIMITS.maxStoredFlows} flows`,
    );

    const updated = { ...existing[0], name: "Updated existing flow" };
    await expect(store.save(updated)).resolves.toBeUndefined();
    await expect(store.get(updated.id)).resolves.toMatchObject({
      name: updated.name,
    });
  });
});
