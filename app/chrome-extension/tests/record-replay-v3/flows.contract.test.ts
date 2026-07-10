import { beforeEach, describe, expect, it } from "vitest";

import {
  FLOW_RESOURCE_LIMITS,
  FLOW_SCHEMA_VERSION,
  jsonUtf8ByteLength,
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

  it("rejects retry and timeout policies that can create unbounded execution", async () => {
    const store = createFlowsStore();
    const retryFlow = createFlow("retry-overflow");
    retryFlow.policy = {
      defaultNodePolicy: {
        retry: {
          retries: FLOW_RESOURCE_LIMITS.maxRetries + 1,
          intervalMs: 0,
        },
      },
    };
    await expect(store.save(retryFlow)).rejects.toThrow(
      `flow.policy.defaultNodePolicy.retry.retries must be an integer between 0 and ${FLOW_RESOURCE_LIMITS.maxRetries}`,
    );

    const timeoutFlow = createFlow("timeout-overflow");
    timeoutFlow.nodes[0].policy = {
      timeout: { ms: FLOW_RESOURCE_LIMITS.maxNodeTimeoutMs + 1 },
    };
    await expect(store.save(timeoutFlow)).rejects.toThrow(
      `flow.nodes[0].policy.timeout.ms must be an integer between 1 and ${FLOW_RESOURCE_LIMITS.maxNodeTimeoutMs}`,
    );
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

    const newest = await store.get("new");
    const oneFlowBudget = jsonUtf8ByteLength(newest) + 2;
    await expect(
      store.list({ limit: 3, maxBytes: oneFlowBudget }),
    ).resolves.toMatchObject([{ id: "new" }]);
  });

  it("scans the full catalog for published slug conflicts without returning full flows", async () => {
    const store = createFlowsStore();
    const flows = Array.from(
      { length: FLOW_RESOURCE_LIMITS.defaultListLimit + 1 },
      (_, index) =>
        createFlow(
          `catalog-${index}`,
          `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        ),
    );
    flows[0].meta = {
      tool: { published: true, slug: "reserved-slug" },
    };
    await putFlowsWithoutValidation(flows);

    await expect(store.list()).resolves.toHaveLength(
      FLOW_RESOURCE_LIMITS.defaultListLimit,
    );
    await expect(
      store.findPublishedSlugOwner?.("reserved-slug", "new-flow"),
    ).resolves.toBe("catalog-0");
    await expect(store.listPublishedInfos?.()).resolves.toMatchObject([
      { id: "catalog-0", slug: "reserved-slug" },
    ]);
  });

  it("lists published descriptors beyond the default page while filtering drafts", async () => {
    const store = createFlowsStore();
    const flows = Array.from(
      { length: FLOW_RESOURCE_LIMITS.maxStoredFlows },
      (_, index) => {
        const flow = createFlow(
          `catalog-${String(index).padStart(2, "0")}`,
          new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        );
        if (index % 5 !== 0) {
          flow.meta = {
            tool: {
              published: true,
              slug: `published-${String(index).padStart(2, "0")}`,
            },
          };
        }
        return flow;
      },
    );
    await putFlowsWithoutValidation(flows);

    await expect(store.list()).resolves.toHaveLength(
      FLOW_RESOURCE_LIMITS.defaultListLimit,
    );
    const details = await store.listPublishedDetails!();

    expect(details).toHaveLength(51);
    expect(details.map((detail) => detail.id)).toContain("catalog-01");
    expect(details.map((detail) => detail.id)).toContain("catalog-63");
    expect(details.map((detail) => detail.id)).not.toContain("catalog-00");
    expect(details.map((detail) => detail.slug)).toEqual(
      details.map((detail) => detail.slug).sort(),
    );
  });

  it("bounds the aggregate published descriptor payload and keeps scanning", async () => {
    const store = createFlowsStore();
    const largeDescription = "x".repeat(
      FLOW_RESOURCE_LIMITS.maxStringUtf8Bytes,
    );
    const flows = Array.from({ length: 9 }, (_, index) => {
      const flow = createFlow(`large-${index}`);
      flow.meta = {
        tool: {
          published: true,
          slug: `large-${index}`,
          description: largeDescription,
        },
      };
      return flow;
    });
    const finalSmallFlow = createFlow("zz-small");
    finalSmallFlow.meta = {
      tool: { published: true, slug: "zz-small" },
    };
    await putFlowsWithoutValidation([...flows, finalSmallFlow]);

    const details = await store.listPublishedDetails!();

    expect(details.length).toBeLessThan(flows.length + 1);
    expect(details.map((detail) => detail.id)).toContain("zz-small");
    expect(jsonUtf8ByteLength(details)).toBeLessThanOrEqual(
      FLOW_RESOURCE_LIMITS.maxPublishedListUtf8Bytes,
    );
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
