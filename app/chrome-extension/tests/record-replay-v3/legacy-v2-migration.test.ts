import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FlowV3 } from "@/entrypoints/background/record-replay-v3/domain/flow";
import type { StoragePort } from "@/entrypoints/background/record-replay-v3/engine/storage/storage-port";
import { migrateLegacyFlowsToV3 } from "@/entrypoints/background/record-replay-v3/storage/import/legacy-v2-migration";

function createStorage(
  flows: FlowV3[] = [],
): StoragePort & { _flows: Map<string, FlowV3> } {
  const flowMap = new Map(flows.map((flow) => [flow.id, flow]));

  return {
    flows: {
      list: vi.fn(async () => Array.from(flowMap.values())),
      get: vi.fn(async (id: string) => flowMap.get(id) ?? null),
      save: vi.fn(async (flow: FlowV3) => {
        flowMap.set(flow.id, flow);
      }),
      delete: vi.fn(async () => {}),
    },
    runs: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      patch: vi.fn(async () => {}),
    },
    events: {
      append: vi.fn(async () => ({
        runId: "run-1",
        type: "run.started",
        ts: Date.now(),
        seq: 1,
      })),
      list: vi.fn(async () => []),
    },
    queue: {
      enqueue: vi.fn(async () => {
        throw new Error("not used");
      }),
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
    _flows: flowMap,
  } as unknown as StoragePort & { _flows: Map<string, FlowV3> };
}

function createKvStore(initialFlag = false) {
  const state: Record<string, unknown> = {
    rr_v3_legacy_flows_migrated_v1: initialFlag,
  };

  return {
    get: vi.fn(async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.map((key) => [key, state[key]]));
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(state, items);
    }),
    state,
  };
}

describe("migrateLegacyFlowsToV3", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("imports legacy flows and applies published metadata", async () => {
    const storage = createStorage();
    const kv = createKvStore(false);

    const result = await migrateLegacyFlowsToV3({
      storage,
      kv,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      legacySource: {
        listFlows: async () => [
          {
            id: "legacy-flow",
            name: "Legacy Flow",
            version: 2,
            nodes: [{ id: "node-1", type: "navigate", config: {} }],
            edges: [],
            meta: {
              domain: "example.com",
              tool: { description: "legacy description" },
            },
          },
        ],
        listPublished: async () => [
          {
            id: "legacy-flow",
            slug: "legacy-slug",
            version: 2,
            name: "Legacy Flow",
            description: "published description",
          },
        ],
      },
    });

    expect(result).toEqual({
      imported: 1,
      updated: 0,
      skipped: 0,
      errors: [],
    });

    expect(storage._flows.get("legacy-flow")).toMatchObject({
      name: "Legacy Flow",
      meta: {
        domain: "example.com",
        bindings: [{ kind: "domain", value: "example.com" }],
        tool: {
          published: true,
          slug: "legacy-slug",
          description: "published description",
        },
      },
    });
    expect(kv.state.rr_v3_legacy_flows_migrated_v1).toBe(true);
  });

  it("patches existing V3 flows with missing legacy publish metadata", async () => {
    const existingFlow: FlowV3 = {
      schemaVersion: 3,
      id: "legacy-flow",
      name: "Legacy Flow",
      entryNodeId: "node-1",
      nodes: [{ id: "node-1", kind: "navigate", config: {} }],
      edges: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const storage = createStorage([existingFlow]);
    const kv = createKvStore(false);

    const result = await migrateLegacyFlowsToV3({
      storage,
      kv,
      logger: console,
      legacySource: {
        listFlows: async () => [
          {
            id: "legacy-flow",
            name: "Legacy Flow",
            version: 2,
            nodes: [{ id: "node-1", type: "navigate", config: {} }],
            edges: [],
          },
        ],
        listPublished: async () => [
          {
            id: "legacy-flow",
            slug: "legacy-flow",
            version: 2,
            name: "Legacy Flow",
            description: "Migrated description",
          },
        ],
      },
    });

    expect(result).toEqual({
      imported: 0,
      updated: 1,
      skipped: 0,
      errors: [],
    });
    expect(storage._flows.get("legacy-flow")?.meta?.tool).toMatchObject({
      published: true,
      slug: "legacy-flow",
      description: "Migrated description",
    });
  });

  it("skips once the migration flag is set", async () => {
    const storage = createStorage();
    const kv = createKvStore(true);

    const result = await migrateLegacyFlowsToV3({
      storage,
      kv,
      logger: console,
      legacySource: {
        listFlows: async () => {
          throw new Error("should not run");
        },
        listPublished: async () => [],
      },
    });

    expect(result).toEqual({
      imported: 0,
      updated: 0,
      skipped: 0,
      errors: [],
    });
    expect(storage.flows.list).not.toHaveBeenCalled();
  });
});
