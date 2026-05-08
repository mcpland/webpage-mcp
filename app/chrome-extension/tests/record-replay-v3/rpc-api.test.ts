/* eslint-disable @typescript-eslint/no-unsafe-function-type */
/**
 * @fileoverview Record-Replay V3 RPC API Tests
 * @description
 * Tests for the queue management RPC APIs:
 * - rr_v3.enqueueRun
 * - rr_v3.listQueue
 * - rr_v3.cancelQueueItem
 *
 * Tests for Flow CRUD RPC APIs:
 * - rr_v3.saveFlow
 * - rr_v3.deleteFlow
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FlowV3 } from "@/entrypoints/background/record-replay-v3/domain/flow";
import type { RunRecordV3 } from "@/entrypoints/background/record-replay-v3/domain/events";
import type { StoragePort } from "@/entrypoints/background/record-replay-v3/engine/storage/storage-port";
import type { EventsBus } from "@/entrypoints/background/record-replay-v3/engine/transport/events-bus";
import type { RunScheduler } from "@/entrypoints/background/record-replay-v3/engine/queue/scheduler";
import type { RunQueueItem } from "@/entrypoints/background/record-replay-v3/engine/queue/queue";
import { RpcServer } from "@/entrypoints/background/record-replay-v3/engine/transport/rpc-server";
import type { TriggerManager } from "@/entrypoints/background/record-replay-v3/engine/triggers/trigger-manager";
import type { TriggerSpec } from "@/entrypoints/background/record-replay-v3/domain/triggers";
import type { ArtifactRecord } from "@/entrypoints/background/record-replay-v3/storage/artifacts";
import { tryAcquireFlowWriteLock } from "@/entrypoints/background/record-replay-v3/flows/write-lock";
import { calculateWorkflowRevision } from "@/entrypoints/background/record-replay-v3/flows/publish";

// ==================== Test Utilities ====================

function createMockStorage(): StoragePort {
  const flowsMap = new Map<string, FlowV3>();
  const runsMap = new Map<string, RunRecordV3>();
  const queueMap = new Map<string, RunQueueItem>();
  const triggersMap = new Map<string, TriggerSpec>();
  const artifactsMap = new Map<string, ArtifactRecord>();
  const eventsLog: Array<{ runId: string; type: string }> = [];

  return {
    flows: {
      list: vi.fn(async () => Array.from(flowsMap.values())),
      get: vi.fn(async (id: string) => flowsMap.get(id) ?? null),
      save: vi.fn(async (flow: FlowV3) => {
        flowsMap.set(flow.id, flow);
      }),
      delete: vi.fn(async (id: string) => {
        flowsMap.delete(id);
      }),
    },
    runs: {
      list: vi.fn(async () => Array.from(runsMap.values())),
      get: vi.fn(async (id: string) => runsMap.get(id) ?? null),
      save: vi.fn(async (record: RunRecordV3) => {
        runsMap.set(record.id, record);
      }),
      patch: vi.fn(async (id: string, patch: Partial<RunRecordV3>) => {
        const existing = runsMap.get(id);
        if (existing) {
          runsMap.set(id, { ...existing, ...patch });
        }
      }),
    },
    events: {
      append: vi.fn(async (event: { runId: string; type: string }) => {
        eventsLog.push(event);
        return { ...event, ts: Date.now(), seq: eventsLog.length };
      }),
      list: vi.fn(async () => eventsLog),
    },
    queue: {
      enqueue: vi.fn(async (input) => {
        const now = Date.now();
        const item: RunQueueItem = {
          ...input,
          priority: input.priority ?? 0,
          maxAttempts: input.maxAttempts ?? 1,
          status: "queued",
          createdAt: now,
          updatedAt: now,
          attempt: 0,
        };
        queueMap.set(input.id, item);
        return item;
      }),
      claimNext: vi.fn(async () => null),
      heartbeat: vi.fn(async () => {}),
      reclaimExpiredLeases: vi.fn(async () => []),
      markRunning: vi.fn(async () => {}),
      markPaused: vi.fn(async () => {}),
      markDone: vi.fn(async () => {}),
      cancel: vi.fn(async (runId: string) => {
        queueMap.delete(runId);
      }),
      get: vi.fn(async (runId: string) => queueMap.get(runId) ?? null),
      list: vi.fn(async (status?: string) => {
        const items = Array.from(queueMap.values());
        if (status) {
          return items.filter((item) => item.status === status);
        }
        return items;
      }),
    },
    persistentVars: {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => ({ key: "", value: null, updatedAt: 0 })),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => []),
    },
    triggers: {
      list: vi.fn(async () => Array.from(triggersMap.values())),
      get: vi.fn(async (id: string) => triggersMap.get(id) ?? null),
      save: vi.fn(async (spec: TriggerSpec) => {
        triggersMap.set(spec.id, spec);
      }),
      delete: vi.fn(async (id: string) => {
        triggersMap.delete(id);
      }),
    },
    artifacts: {
      saveScreenshot: vi.fn(async (input) => {
        const record: ArtifactRecord = {
          id: `${input.runId}/${input.nodeId}/artifact`,
          runId: input.runId,
          nodeId: input.nodeId,
          kind: "screenshot",
          filename: input.filename ?? "artifact.png",
          mimeType: input.mimeType ?? "image/png",
          dataBase64: input.base64,
          sizeBytes: input.base64.length,
          createdAt: 1_700_000_000_000,
          expiresAt: 1_700_000_001_000,
        };
        artifactsMap.set(record.id, record);
        return record;
      }),
      get: vi.fn(async (id: string) => artifactsMap.get(id) ?? null),
      listByRun: vi.fn(async (runId: string) =>
        Array.from(artifactsMap.values()).filter((artifact) => artifact.runId === runId),
      ),
      deleteByRun: vi.fn(async (runId: string) => {
        const ids = Array.from(artifactsMap.values())
          .filter((artifact) => artifact.runId === runId)
          .map((artifact) => artifact.id);
        ids.forEach((id) => artifactsMap.delete(id));
        return ids.length;
      }),
      cleanupExpired: vi.fn(async () => 1),
      enforceRetention: vi.fn(async () => 2),
    },
    // Expose internal maps for assertions
    _internal: { flowsMap, runsMap, queueMap, triggersMap, artifactsMap, eventsLog },
  } as unknown as StoragePort & {
    _internal: {
      flowsMap: Map<string, FlowV3>;
      runsMap: Map<string, RunRecordV3>;
      queueMap: Map<string, RunQueueItem>;
      triggersMap: Map<string, TriggerSpec>;
      artifactsMap: Map<string, ArtifactRecord>;
      eventsLog: Array<{ runId: string; type: string }>;
    };
  };
}

function createMockEventsBus(): EventsBus {
  const subscribers: Array<(event: unknown) => void> = [];
  return {
    subscribe: vi.fn((callback: (event: unknown) => void) => {
      subscribers.push(callback);
      return () => {
        const idx = subscribers.indexOf(callback);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    }),
    append: vi.fn(async (event) => {
      const fullEvent = { ...event, ts: Date.now(), seq: 1 };
      subscribers.forEach((cb) => cb(fullEvent));
      return fullEvent as ReturnType<EventsBus["append"]> extends Promise<
        infer T
      >
        ? T
        : never;
    }),
    list: vi.fn(async () => []),
  } as EventsBus;
}

function createMockScheduler(): RunScheduler {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    kick: vi.fn(async () => {}),
    getState: vi.fn(() => ({
      started: false,
      ownerId: "test-owner",
      maxParallelRuns: 3,
      activeRunIds: [],
    })),
    dispose: vi.fn(),
  };
}

function createMockTriggerManager(): TriggerManager {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    fire: vi.fn(async (triggerId) => ({
      runId: `run-${triggerId}`,
      position: 0,
    })),
    dispose: vi.fn(async () => {}),
    getState: vi.fn(() => ({
      started: true,
      installedTriggerIds: [],
    })),
  };
}

function createTestFlow(
  id: string,
  options: { withNodes?: boolean } = {},
): FlowV3 {
  const now = new Date().toISOString();
  const nodes =
    options.withNodes !== false
      ? [
          { id: "node-start", kind: "navigate", config: {} },
          { id: "node-end", kind: "navigate", config: {} },
        ]
      : [];
  return {
    schemaVersion: 3,
    id: id as FlowV3["id"],
    name: `Test Flow ${id}`,
    entryNodeId: "node-start" as FlowV3["entryNodeId"],
    nodes: nodes as FlowV3["nodes"],
    edges: [
      { id: "edge-1", from: "node-start", to: "node-end" },
    ] as FlowV3["edges"],
    variables: [],
    createdAt: now,
    updatedAt: now,
  };
}

// Helper type for accessing internal maps in mock storage
interface MockStorageInternal {
  flowsMap: Map<string, FlowV3>;
  runsMap: Map<string, RunRecordV3>;
  queueMap: Map<string, RunQueueItem>;
  triggersMap: Map<string, TriggerSpec>;
  artifactsMap: Map<string, ArtifactRecord>;
  eventsLog: Array<{ runId: string; type: string }>;
}

// Access _internal property with type safety
function getInternal(storage: StoragePort): MockStorageInternal {
  return (storage as unknown as { _internal: MockStorageInternal })._internal;
}

// ==================== Tests ====================

describe("V3 RPC Queue Management APIs", () => {
  let storage: ReturnType<typeof createMockStorage>;
  let events: EventsBus;
  let scheduler: RunScheduler;
  let server: RpcServer;
  let runIdCounter: number;
  let fixedNow: number;

  beforeEach(() => {
    storage = createMockStorage();
    events = createMockEventsBus();
    scheduler = createMockScheduler();
    runIdCounter = 0;
    fixedNow = 1_700_000_000_000;
    delete (chrome.runtime as any).getManifest;

    server = new RpcServer({
      storage,
      events,
      scheduler,
      generateRunId: () => `run-${++runIdCounter}`,
      now: () => fixedNow,
    });
  });

  describe("rr_v3 artifact APIs", () => {
    it("lists artifact metadata without inline screenshot data", async () => {
      getInternal(storage).artifactsMap.set("artifact-1", {
        id: "artifact-1",
        runId: "run-artifacts" as never,
        nodeId: "node-a" as never,
        kind: "screenshot",
        filename: "failure.png",
        mimeType: "image/png",
        dataBase64: "ZmFpbHVyZS1zaG90",
        sizeBytes: 12,
        createdAt: 1000,
        expiresAt: 2000,
        metadata: { source: "test" },
      });

      const result = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.listArtifacts",
          params: { runId: "run-artifacts" },
          requestId: "req-artifacts-list",
        },
        { subscriptions: new Set() },
      );

      expect(result).toEqual([
        {
          id: "artifact-1",
          runId: "run-artifacts",
          nodeId: "node-a",
          kind: "screenshot",
          savedAs: "failure.png",
          mimeType: "image/png",
          sizeBytes: 12,
          createdAt: 1000,
          expiresAt: 2000,
          metadata: { source: "test" },
        },
      ]);
      expect(result[0]).not.toHaveProperty("dataBase64");
    });

    it("returns artifact screenshot data by artifactId and supports cleanup", async () => {
      getInternal(storage).artifactsMap.set("artifact-1", {
        id: "artifact-1",
        runId: "run-artifacts" as never,
        nodeId: "node-a" as never,
        kind: "screenshot",
        filename: "failure.png",
        mimeType: "image/png",
        dataBase64: "ZmFpbHVyZS1zaG90",
        sizeBytes: 12,
        createdAt: 1000,
        expiresAt: 2000,
      });

      const artifact = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.getArtifact",
          params: { artifactId: "artifact-1" },
          requestId: "req-artifact-get",
        },
        { subscriptions: new Set() },
      );
      const deleted = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.deleteRunArtifacts",
          params: { runId: "run-artifacts" },
          requestId: "req-artifact-delete",
        },
        { subscriptions: new Set() },
      );
      const cleanup = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.cleanupArtifacts",
          params: {},
          requestId: "req-artifact-cleanup",
        },
        { subscriptions: new Set() },
      );

      expect(artifact).toMatchObject({
        id: "artifact-1",
        dataBase64: "ZmFpbHVyZS1zaG90",
      });
      expect(deleted).toEqual({ deleted: 1 });
      expect(cleanup).toEqual({ deleted: 3 });
    });
  });

  describe("rr_v3.enqueueRun", () => {
    it("binds UI-initiated runs to the current active tab by default", async () => {
      const flow = createTestFlow("flow-active-tab");
      getInternal(storage).flowsMap.set(flow.id, flow);

      (chrome.runtime as any).getManifest = vi.fn(() => ({ manifest_version: 3 }));
      const tabsQuery = chrome.tabs.query as ReturnType<typeof vi.fn>;
      tabsQuery.mockResolvedValue([
        {
          id: 77,
          active: true,
          currentWindow: true,
          url: "https://example.com/form",
          status: "complete",
          windowId: 1,
        },
      ]);

      await (server as unknown as { handleRequest: Function }).handleRequest(
        {
          method: "rr_v3.enqueueRun",
          params: { flowId: "flow-active-tab" },
          requestId: "req-active-tab",
        },
        { subscriptions: new Set() },
      );

      expect(storage.runs.save).toHaveBeenCalledWith(
        expect.objectContaining({
          flowId: "flow-active-tab",
          tabId: 77,
        }),
      );
      expect(storage.queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          flowId: "flow-active-tab",
          tabId: 77,
        }),
      );
    });

    it("creates run record, enqueues, emits event, and kicks scheduler", async () => {
      // Setup: add a flow
      const flow = createTestFlow("flow-1");
      getInternal(storage).flowsMap.set(flow.id, flow);

      // Act: call enqueueRun via handleRequest
      const result = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.enqueueRun",
          params: { flowId: "flow-1" },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      );

      // Assert: run record created
      expect(storage.runs.save).toHaveBeenCalledTimes(1);
      const savedRun = (storage.runs.save as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(savedRun).toMatchObject({
        id: "run-1",
        flowId: "flow-1",
        status: "queued",
        attempt: 0,
        maxAttempts: 1,
      });

      // Assert: enqueued
      expect(storage.queue.enqueue).toHaveBeenCalledTimes(1);
      expect(storage.queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          flowId: "flow-1",
          profile: "idempotent",
        }),
      );

      // Assert: event emitted via EventsBus
      expect(events.append).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          type: "run.queued",
          flowId: "flow-1",
        }),
      );

      // Assert: scheduler kicked
      expect(scheduler.kick).toHaveBeenCalledTimes(1);

      // Assert: result
      expect(result).toMatchObject({
        runId: "run-1",
        position: 1,
      });
    });

    it("throws if flowId is missing", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          { method: "rr_v3.enqueueRun", params: {}, requestId: "req-1" },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow("flowId is required");
    });

    it("throws if flow does not exist", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.enqueueRun",
            params: { flowId: "non-existent" },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Flow "non-existent" not found');
    });

    it("respects custom priority and maxAttempts", async () => {
      const flow = createTestFlow("flow-1");
      getInternal(storage).flowsMap.set(flow.id, flow);

      await (server as unknown as { handleRequest: Function }).handleRequest(
        {
          method: "rr_v3.enqueueRun",
          params: { flowId: "flow-1", priority: 10, maxAttempts: 3 },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      );

      expect(storage.queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          priority: 10,
          maxAttempts: 3,
        }),
      );
    });

    it("passes args and debug config", async () => {
      const flow = createTestFlow("flow-1");
      getInternal(storage).flowsMap.set(flow.id, flow);

      const args = { url: "https://example.com" };
      const debug = { pauseOnStart: true, breakpoints: ["node-1"] };

      await (server as unknown as { handleRequest: Function }).handleRequest(
        {
          method: "rr_v3.enqueueRun",
          params: { flowId: "flow-1", args, debug },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      );

      expect(storage.runs.save).toHaveBeenCalledWith(
        expect.objectContaining({
          args,
          debug,
        }),
      );
    });

    it("rejects NaN priority", async () => {
      const flow = createTestFlow("flow-1");
      getInternal(storage).flowsMap.set(flow.id, flow);

      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.enqueueRun",
            params: { flowId: "flow-1", priority: NaN },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow("priority must be a finite number");
    });

    it("rejects Infinity maxAttempts", async () => {
      const flow = createTestFlow("flow-1");
      getInternal(storage).flowsMap.set(flow.id, flow);

      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.enqueueRun",
            params: { flowId: "flow-1", maxAttempts: Infinity },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow("maxAttempts must be a finite number");
    });

    it("rejects maxAttempts < 1", async () => {
      const flow = createTestFlow("flow-1");
      getInternal(storage).flowsMap.set(flow.id, flow);

      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.enqueueRun",
            params: { flowId: "flow-1", maxAttempts: 0 },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow("maxAttempts must be >= 1");
    });

    it("persists startNodeId in RunRecord when provided", async () => {
      // Setup: add a flow with multiple nodes
      const flow = createTestFlow("flow-start-node");
      getInternal(storage).flowsMap.set(flow.id, flow);

      // Act: enqueue with startNodeId
      const targetNodeId = flow.nodes[0].id; // Use the first node
      await (server as unknown as { handleRequest: Function }).handleRequest(
        {
          method: "rr_v3.enqueueRun",
          params: { flowId: "flow-start-node", startNodeId: targetNodeId },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      );

      // Assert: RunRecord should have startNodeId
      const runsMap = getInternal(storage).runsMap;
      expect(runsMap.size).toBe(1);
      const runRecord = Array.from(runsMap.values())[0];
      expect(runRecord.startNodeId).toBe(targetNodeId);
    });

    it("throws if startNodeId does not exist in flow", async () => {
      // Setup: add a flow
      const flow = createTestFlow("flow-invalid-start");
      getInternal(storage).flowsMap.set(flow.id, flow);

      // Act & Assert
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.enqueueRun",
            params: {
              flowId: "flow-invalid-start",
              startNodeId: "non-existent-node",
            },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('startNodeId "non-existent-node" not found in flow');
    });
  });

  describe("rr_v3.listQueue", () => {
    it("returns all queue items sorted by priority DESC and createdAt ASC", async () => {
      // Setup: add items with different priorities and times
      getInternal(storage).queueMap.set("run-1", {
        id: "run-1",
        flowId: "flow-1",
        status: "queued",
        priority: 5,
        createdAt: 1000,
        updatedAt: 1000,
        attempt: 0,
        maxAttempts: 1,
      });
      getInternal(storage).queueMap.set("run-2", {
        id: "run-2",
        flowId: "flow-1",
        status: "queued",
        priority: 10,
        createdAt: 2000,
        updatedAt: 2000,
        attempt: 0,
        maxAttempts: 1,
      });
      getInternal(storage).queueMap.set("run-3", {
        id: "run-3",
        flowId: "flow-1",
        status: "queued",
        priority: 10,
        createdAt: 1500,
        updatedAt: 1500,
        attempt: 0,
        maxAttempts: 1,
      });

      const result = (await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        { method: "rr_v3.listQueue", params: {}, requestId: "req-1" },
        { subscriptions: new Set() },
      )) as RunQueueItem[];

      // run-3 (priority 10, earlier) > run-2 (priority 10, later) > run-1 (priority 5)
      expect(result.map((r) => r.id)).toEqual(["run-3", "run-2", "run-1"]);
    });

    it("filters by status", async () => {
      getInternal(storage).queueMap.set("run-1", {
        id: "run-1",
        flowId: "flow-1",
        status: "queued",
        priority: 0,
        createdAt: 1000,
        updatedAt: 1000,
        attempt: 0,
        maxAttempts: 1,
      });
      getInternal(storage).queueMap.set("run-2", {
        id: "run-2",
        flowId: "flow-1",
        status: "running",
        priority: 0,
        createdAt: 2000,
        updatedAt: 2000,
        attempt: 1,
        maxAttempts: 1,
      });

      const result = (await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.listQueue",
          params: { status: "queued" },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      )) as RunQueueItem[];

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("run-1");
    });

    it("rejects invalid status", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.listQueue",
            params: { status: "invalid" },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow("status must be one of: queued, running, paused");
    });
  });

  describe("rr_v3.cancelQueueItem", () => {
    it("cancels queue item, patches run, and emits event", async () => {
      // Setup
      getInternal(storage).queueMap.set("run-1", {
        id: "run-1",
        flowId: "flow-1",
        status: "queued",
        priority: 0,
        createdAt: 1000,
        updatedAt: 1000,
        attempt: 0,
        maxAttempts: 1,
      });
      getInternal(storage).runsMap.set("run-1", {
        schemaVersion: 3,
        id: "run-1",
        flowId: "flow-1",
        status: "queued",
        createdAt: 1000,
        updatedAt: 1000,
        attempt: 0,
        maxAttempts: 1,
        nextSeq: 0,
      });

      const result = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.cancelQueueItem",
          params: { runId: "run-1" },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      );

      // Assert: queue.cancel called
      expect(storage.queue.cancel).toHaveBeenCalledWith(
        "run-1",
        fixedNow,
        undefined,
      );

      // Assert: run patched
      expect(storage.runs.patch).toHaveBeenCalledWith("run-1", {
        status: "canceled",
        updatedAt: fixedNow,
        finishedAt: fixedNow,
      });

      // Assert: event emitted via EventsBus
      expect(events.append).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          type: "run.canceled",
        }),
      );

      // Assert: result
      expect(result).toMatchObject({ ok: true, runId: "run-1" });
    });

    it("throws if runId is missing", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          { method: "rr_v3.cancelQueueItem", params: {}, requestId: "req-1" },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow("runId is required");
    });

    it("throws if queue item does not exist", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.cancelQueueItem",
            params: { runId: "non-existent" },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Queue item "non-existent" not found');
    });

    it("throws if queue item is not queued", async () => {
      getInternal(storage).queueMap.set("run-1", {
        id: "run-1",
        flowId: "flow-1",
        status: "running",
        priority: 0,
        createdAt: 1000,
        updatedAt: 1000,
        attempt: 1,
        maxAttempts: 1,
      });

      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.cancelQueueItem",
            params: { runId: "run-1" },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow(
        'Cannot cancel queue item "run-1" with status "running"',
      );
    });

    it("includes reason in cancel event", async () => {
      getInternal(storage).queueMap.set("run-1", {
        id: "run-1",
        flowId: "flow-1",
        status: "queued",
        priority: 0,
        createdAt: 1000,
        updatedAt: 1000,
        attempt: 0,
        maxAttempts: 1,
      });

      await (server as unknown as { handleRequest: Function }).handleRequest(
        {
          method: "rr_v3.cancelQueueItem",
          params: { runId: "run-1", reason: "User requested cancellation" },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      );

      expect(storage.queue.cancel).toHaveBeenCalledWith(
        "run-1",
        fixedNow,
        "User requested cancellation",
      );
      expect(events.append).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "User requested cancellation",
        }),
      );
    });
  });
});

describe("V3 RPC Trigger Management APIs", () => {
  let storage: ReturnType<typeof createMockStorage>;
  let events: EventsBus;
  let scheduler: RunScheduler;
  let triggerManager: TriggerManager;
  let server: RpcServer;

  beforeEach(() => {
    storage = createMockStorage();
    events = createMockEventsBus();
    scheduler = createMockScheduler();
    triggerManager = createMockTriggerManager();
    server = new RpcServer({
      storage,
      events,
      scheduler,
      triggerManager,
      now: () => 1_700_000_000_000,
    });
    getInternal(storage).flowsMap.set("flow-1", createTestFlow("flow-1"));
  });

  it("creates, lists, toggles, fires, and deletes workflow triggers", async () => {
    const created = (await (
      server as unknown as { handleRequest: Function }
    ).handleRequest(
      {
        method: "rr_v3.createTrigger",
        params: {
          trigger: {
            id: "trg-1",
            kind: "manual",
            enabled: true,
            flowId: "flow-1",
            args: { query: "value" },
          },
        },
        requestId: "req-trigger-create",
      },
      { subscriptions: new Set() },
    )) as TriggerSpec;

    expect(created).toEqual({
      id: "trg-1",
      kind: "manual",
      enabled: true,
      flowId: "flow-1",
      args: { query: "value" },
    });
    expect(triggerManager.refresh).toHaveBeenCalledTimes(1);

    const listed = await (
      server as unknown as { handleRequest: Function }
    ).handleRequest(
      {
        method: "rr_v3.listTriggers",
        params: { flowId: "flow-1" },
        requestId: "req-trigger-list",
      },
      { subscriptions: new Set() },
    );
    expect(listed).toEqual([created]);

    const updated = (await (
      server as unknown as { handleRequest: Function }
    ).handleRequest(
      {
        method: "rr_v3.updateTrigger",
        params: {
          trigger: {
            id: "trg-1",
            kind: "manual",
            enabled: true,
            flowId: "flow-1",
            args: { query: "updated" },
          },
        },
        requestId: "req-trigger-update",
      },
      { subscriptions: new Set() },
    )) as TriggerSpec;
    expect(updated).toEqual({
      id: "trg-1",
      kind: "manual",
      enabled: true,
      flowId: "flow-1",
      args: { query: "updated" },
    });
    expect(getInternal(storage).triggersMap.get("trg-1")).toEqual(updated);

    const disabled = (await (
      server as unknown as { handleRequest: Function }
    ).handleRequest(
      {
        method: "rr_v3.disableTrigger",
        params: { triggerId: "trg-1" },
        requestId: "req-trigger-disable",
      },
      { subscriptions: new Set() },
    )) as TriggerSpec;
    expect(disabled.enabled).toBe(false);

    const enabled = (await (
      server as unknown as { handleRequest: Function }
    ).handleRequest(
      {
        method: "rr_v3.enableTrigger",
        params: { triggerId: "trg-1" },
        requestId: "req-trigger-enable",
      },
      { subscriptions: new Set() },
    )) as TriggerSpec;
    expect(enabled.enabled).toBe(true);

    const fired = await (
      server as unknown as { handleRequest: Function }
    ).handleRequest(
      {
        method: "rr_v3.fireTrigger",
        params: { triggerId: "trg-1" },
        requestId: "req-trigger-fire",
      },
      { subscriptions: new Set() },
    );
    expect(fired).toEqual({ runId: "run-trg-1", position: 0 });
    expect(triggerManager.fire).toHaveBeenCalledWith("trg-1", {
      sourceTabId: undefined,
      sourceUrl: undefined,
    });

    const deleted = await (
      server as unknown as { handleRequest: Function }
    ).handleRequest(
      {
        method: "rr_v3.deleteTrigger",
        params: { triggerId: "trg-1" },
        requestId: "req-trigger-delete",
      },
      { subscriptions: new Set() },
    );
    expect(deleted).toEqual({ ok: true, triggerId: "trg-1" });
    expect(getInternal(storage).triggersMap.has("trg-1")).toBe(false);
  });

  it("validates and normalizes URL trigger match rules", async () => {
    const created = (await (
      server as unknown as { handleRequest: Function }
    ).handleRequest(
      {
        method: "rr_v3.createTrigger",
        params: {
          trigger: {
            id: "trg-url",
            kind: "url",
            enabled: true,
            flowId: "flow-1",
            match: [
              { kind: "domain", value: " example.com " },
              { kind: "path", value: "/checkout" },
            ],
          },
        },
        requestId: "req-trigger-url",
      },
      { subscriptions: new Set() },
    )) as TriggerSpec;

    expect(created).toEqual({
      id: "trg-url",
      kind: "url",
      enabled: true,
      flowId: "flow-1",
      args: undefined,
      match: [
        { kind: "domain", value: "example.com" },
        { kind: "path", value: "/checkout" },
      ],
    });
  });

  it("rejects URL triggers without concrete match rules", async () => {
    await expect(
      (server as unknown as { handleRequest: Function }).handleRequest(
        {
          method: "rr_v3.createTrigger",
          params: {
            trigger: {
              id: "trg-url",
              kind: "url",
              enabled: true,
              flowId: "flow-1",
              match: [],
            },
          },
          requestId: "req-trigger-url",
        },
        { subscriptions: new Set() },
      ),
    ).rejects.toThrow("trigger.match must include at least one URL rule");

    await expect(
      (server as unknown as { handleRequest: Function }).handleRequest(
        {
          method: "rr_v3.createTrigger",
          params: {
            trigger: {
              id: "trg-url",
              kind: "url",
              enabled: true,
              flowId: "flow-1",
              match: [{ kind: "host", value: "example.com" }],
            },
          },
          requestId: "req-trigger-url",
        },
        { subscriptions: new Set() },
      ),
    ).rejects.toThrow(
      "trigger.match[0].kind must be one of: url, domain, path",
    );

    await expect(
      (server as unknown as { handleRequest: Function }).handleRequest(
        {
          method: "rr_v3.createTrigger",
          params: {
            trigger: {
              id: "trg-url",
              kind: "url",
              enabled: true,
              flowId: "flow-1",
              match: [{ kind: "domain", value: " " }],
            },
          },
          requestId: "req-trigger-url",
        },
        { subscriptions: new Set() },
      ),
    ).rejects.toThrow("trigger.match[0].value must be a non-empty string");
  });
});

describe("V3 RPC Flow CRUD APIs", () => {
  let storage: ReturnType<typeof createMockStorage>;
  let events: EventsBus;
  let scheduler: RunScheduler;
  let server: RpcServer;
  let fixedNow: number;

  beforeEach(() => {
    storage = createMockStorage();
    events = createMockEventsBus();
    scheduler = createMockScheduler();
    fixedNow = 1_700_000_000_000;

    server = new RpcServer({
      storage,
      events,
      scheduler,
      now: () => fixedNow,
    });
  });

  describe("rr_v3.saveFlow", () => {
    it("saves a new flow with all required fields", async () => {
      const flowInput = {
        name: "My New Flow",
        entryNodeId: "node-1",
        nodes: [
          { id: "node-1", kind: "click", config: { selector: "#btn" } },
          { id: "node-2", kind: "delay", config: { ms: 1000 } },
        ],
        edges: [{ id: "e1", from: "node-1", to: "node-2" }],
      };

      const result = (await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.saveFlow",
          params: { flow: flowInput },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      )) as FlowV3;

      // Assert: flow saved
      expect(storage.flows.save).toHaveBeenCalledTimes(1);

      // Assert: returned flow has all fields
      expect(result.schemaVersion).toBe(3);
      expect(result.id).toMatch(/^flow_\d+_[a-z0-9]+$/);
      expect(result.name).toBe("My New Flow");
      expect(result.entryNodeId).toBe("node-1");
      expect(result.nodes).toHaveLength(2);
      expect(result.edges).toHaveLength(1);
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });

    it("updates an existing flow", async () => {
      // Setup: add existing flow with a past timestamp
      const existing = createTestFlow("flow-1");
      const pastDate = new Date(Date.now() - 100000).toISOString(); // 100 seconds ago
      existing.createdAt = pastDate;
      existing.updatedAt = pastDate;
      getInternal(storage).flowsMap.set(existing.id, existing);

      const flowInput = {
        id: "flow-1",
        name: "Updated Flow",
        entryNodeId: "node-start",
        nodes: [
          {
            id: "node-start",
            kind: "navigate",
            config: { url: "https://example.com" },
          },
        ],
        edges: [],
        createdAt: existing.createdAt, // Preserve original createdAt
      };

      const result = (await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.saveFlow",
          params: { flow: flowInput },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      )) as FlowV3;

      // Assert: flow updated
      expect(result.id).toBe("flow-1");
      expect(result.name).toBe("Updated Flow");
      expect(result.createdAt).toBe(existing.createdAt);
      expect(result.updatedAt).not.toBe(existing.updatedAt);
    });

    it("preserves createdAt when updating without providing it", async () => {
      // Setup: add existing flow with a past timestamp
      const existing = createTestFlow("flow-1");
      const pastDate = new Date(Date.now() - 100000).toISOString();
      existing.createdAt = pastDate;
      existing.updatedAt = pastDate;
      getInternal(storage).flowsMap.set(existing.id, existing);

      // Update without providing createdAt - should inherit from existing
      const flowInput = {
        id: "flow-1",
        name: "Updated Without CreatedAt",
        entryNodeId: "node-start",
        nodes: [{ id: "node-start", kind: "navigate", config: {} }],
        edges: [],
        // Note: createdAt is NOT provided
      };

      const result = (await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.saveFlow",
          params: { flow: flowInput },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      )) as FlowV3;

      // Assert: createdAt is inherited from existing flow
      expect(result.createdAt).toBe(existing.createdAt);
      expect(result.updatedAt).not.toBe(existing.updatedAt);
    });

    it("throws if flow is missing", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          { method: "rr_v3.saveFlow", params: {}, requestId: "req-1" },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow("flow is required");
    });

    it("throws if name is missing", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.saveFlow",
            params: {
              flow: {
                entryNodeId: "node-1",
                nodes: [{ id: "node-1", kind: "navigate", config: {} }],
              },
            },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow("flow.name is required");
    });

    it("throws if entryNodeId is missing", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.saveFlow",
            params: {
              flow: {
                name: "Test",
                nodes: [{ id: "node-1", kind: "navigate", config: {} }],
              },
            },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow("flow.entryNodeId is required");
    });

    it("throws if entryNodeId does not exist in nodes", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.saveFlow",
            params: {
              flow: {
                name: "Test",
                entryNodeId: "non-existent",
                nodes: [{ id: "node-1", kind: "navigate", config: {} }],
              },
            },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Entry node "non-existent" does not exist in flow');
    });

    it("throws if edge references non-existent source node", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.saveFlow",
            params: {
              flow: {
                name: "Test",
                entryNodeId: "node-1",
                nodes: [{ id: "node-1", kind: "navigate", config: {} }],
                edges: [{ id: "e1", from: "non-existent", to: "node-1" }],
              },
            },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow(
        'Edge "e1" references non-existent source node "non-existent"',
      );
    });

    it("throws if edge references non-existent target node", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.saveFlow",
            params: {
              flow: {
                name: "Test",
                entryNodeId: "node-1",
                nodes: [{ id: "node-1", kind: "navigate", config: {} }],
                edges: [{ id: "e1", from: "node-1", to: "non-existent" }],
              },
            },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow(
        'Edge "e1" references non-existent target node "non-existent"',
      );
    });

    it("validates node structure", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.saveFlow",
            params: {
              flow: {
                name: "Test",
                entryNodeId: "node-1",
                nodes: [{ id: "node-1" }], // missing kind
              },
            },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow("flow.nodes[0].kind is required");
    });

    it("rejects unsupported V3 runtime node kinds", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.saveFlow",
            params: {
              flow: {
                name: "Test",
                entryNodeId: "node-1",
                nodes: [{ id: "node-1", kind: "foreach", config: {} }],
              },
            },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow(
        'flow.nodes[0].kind "foreach" is not supported by the current V3 runtime',
      );
    });

    it("rejects entry paths that start with a non-executable trigger node", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.saveFlow",
            params: {
              flow: {
                name: "Trigger Entry",
                entryNodeId: "trigger-1",
                nodes: [
                  { id: "trigger-1", kind: "trigger", config: {} },
                  { id: "node-1", kind: "navigate", config: { url: "https://example.com" } },
                ],
                edges: [{ id: "edge-1", from: "trigger-1", to: "node-1" }],
              },
            },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow(
        'Flow entry path reaches non-executable node "trigger-1" with kind "trigger"',
      );
    });

    it("generates edge ID if not provided", async () => {
      const result = (await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.saveFlow",
          params: {
            flow: {
              name: "Test",
              entryNodeId: "node-1",
              nodes: [
                { id: "node-1", kind: "navigate", config: {} },
                { id: "node-2", kind: "navigate", config: {} },
              ],
              edges: [{ from: "node-1", to: "node-2" }], // no id
            },
          },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      )) as FlowV3;

      expect(result.edges[0].id).toMatch(/^edge_0_[a-z0-9]+$/);
    });

    it("saves flow with optional fields", async () => {
      const result = (await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.saveFlow",
          params: {
            flow: {
              name: "Test",
              description: "A test flow",
              entryNodeId: "node-1",
              nodes: [
                {
                  id: "node-1",
                  kind: "navigate",
                  config: {},
                  name: "Start Node",
                  disabled: false,
                },
              ],
              edges: [],
              // Comply with VariableDefinition type: name is required, description/default/label is optional
              variables: [
                {
                  name: "url",
                  description: "Target URL",
                  default: "https://example.com",
                },
              ],
              // Conforms to the FlowPolicy type
              policy: {
                runTimeoutMs: 30000,
                defaultNodePolicy: { onError: { kind: "stop" } },
              },
              meta: { tags: ["test", "demo"] },
            },
          },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      )) as FlowV3;

      expect(result.description).toBe("A test flow");
      expect(result.variables).toHaveLength(1);
      expect(result.policy).toEqual({
        runTimeoutMs: 30000,
        defaultNodePolicy: { onError: { kind: "stop" } },
      });
      expect(result.meta).toEqual({ tags: ["test", "demo"] });
      expect(result.nodes[0].name).toBe("Start Node");
    });

    it("preserves node side-effect profiles when saving flows", async () => {
      const result = (await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.saveFlow",
          params: {
            flow: {
              name: "Side Effects",
              entryNodeId: "node-1",
              nodes: [
                {
                  id: "node-1",
                  kind: "click",
                  config: { selector: "#buy" },
                  sideEffect: {
                    category: "dangerous",
                    retry: "never",
                    description: "Do not click twice",
                  },
                },
              ],
              edges: [],
            },
          },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      )) as FlowV3;

      expect(result.nodes[0].sideEffect).toEqual({
        category: "dangerous",
        retry: "never",
        description: "Do not click twice",
      });
    });

    it("rejects invalid node side-effect profiles", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.saveFlow",
            params: {
              flow: {
                name: "Side Effects",
                entryNodeId: "node-1",
                nodes: [
                  {
                    id: "node-1",
                    kind: "click",
                    config: { selector: "#buy" },
                    sideEffect: { category: "unsafe" },
                  },
                ],
                edges: [],
              },
            },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow(
        "flow.nodes[0].sideEffect.category must be one of",
      );
    });

    it("normalizes typed variable metadata when saving flows", async () => {
      const result = (await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.saveFlow",
          params: {
            flow: {
              name: "Typed Variables",
              entryNodeId: "node-1",
              nodes: [{ id: "node-1", kind: "navigate", config: {} }],
              edges: [],
              variables: [
                {
                  key: "email",
                  type: "string",
                  default: "alice@example.com",
                  rules: { required: true },
                },
                {
                  name: "plan",
                  kind: "enum",
                  options: ["free", "pro"],
                },
                {
                  name: "scores",
                  kind: "array",
                  item: "number",
                },
              ],
            },
          },
          requestId: "req-typed-vars",
        },
        { subscriptions: new Set() },
      )) as FlowV3;

      expect(result.variables).toEqual([
        {
          name: "email",
          kind: "string",
          default: "alice@example.com",
          required: true,
        },
        {
          name: "plan",
          kind: "enum",
          options: ["free", "pro"],
        },
        {
          name: "scores",
          kind: "array",
          item: "number",
        },
      ]);
    });

    it("normalizes publish metadata and recording metadata", async () => {
      const result = (await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.saveFlow",
          params: {
            flow: {
              name: "Checkout Flow",
              entryNodeId: "node-1",
              nodes: [{ id: "node-1", kind: "navigate", config: {} }],
              edges: [],
              meta: {
                domain: "example.com",
                tool: {
                  published: true,
                  slug: " Checkout Flow ",
                  category: " automation ",
                  description: " Checkout run ",
                },
                exposedOutputs: [{ nodeId: "node-1", as: "landing_page" }],
                recording: {
                  originUrl: "https://example.com",
                  parameterSuggestions: [
                    {
                      nodeId: "node-1",
                      kind: "navigate",
                      suggestedKey: " start_url ",
                      currentValue: "https://example.com",
                    },
                  ],
                },
              },
            },
          },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      )) as FlowV3;

      expect(result.meta).toMatchObject({
        domain: "example.com",
        bindings: [{ kind: "domain", value: "example.com" }],
        tool: {
          published: true,
          slug: "checkout-flow",
          category: "automation",
          description: "Checkout run",
        },
        exposedOutputs: [{ nodeId: "node-1", as: "landing_page" }],
        recording: {
          originUrl: "https://example.com",
          parameterSuggestions: [
            {
              nodeId: "node-1",
              kind: "navigate",
              suggestedKey: "start_url",
              currentValue: "https://example.com",
            },
          ],
        },
      });
    });

    it("throws if variable is missing name", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.saveFlow",
            params: {
              flow: {
                name: "Test",
                entryNodeId: "node-1",
                nodes: [{ id: "node-1", kind: "navigate", config: {} }],
                variables: [{ description: "Missing name field" }],
              },
            },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow("flow.variables[0].name is required");
    });

    it("throws if duplicate variable names", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.saveFlow",
            params: {
              flow: {
                name: "Test",
                entryNodeId: "node-1",
                nodes: [{ id: "node-1", kind: "navigate", config: {} }],
                variables: [
                  { name: "myVar" },
                  { name: "myVar" }, // duplicate
                ],
              },
            },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Duplicate variable name: "myVar"');
    });

    it("throws if duplicate node IDs", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.saveFlow",
            params: {
              flow: {
                name: "Test",
                entryNodeId: "node-1",
                nodes: [
                  { id: "node-1", kind: "navigate", config: {} },
                  { id: "node-1", kind: "navigate", config: {} }, // duplicate
                ],
              },
            },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Duplicate node ID: "node-1"');
    });

    it("throws if duplicate edge IDs", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.saveFlow",
            params: {
              flow: {
                name: "Test",
                entryNodeId: "node-1",
                nodes: [
                  { id: "node-1", kind: "navigate", config: {} },
                  { id: "node-2", kind: "navigate", config: {} },
                ],
                edges: [
                  { id: "e1", from: "node-1", to: "node-2" },
                  { id: "e1", from: "node-2", to: "node-1" }, // duplicate
                ],
              },
            },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Duplicate edge ID: "e1"');
    });

    it("rejects invalid exposed output references", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.saveFlow",
            params: {
              flow: {
                name: "Test",
                entryNodeId: "node-1",
                nodes: [{ id: "node-1", kind: "navigate", config: {} }],
                meta: {
                  exposedOutputs: [{ nodeId: "missing-node", as: "result" }],
                },
              },
            },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow(
        'flow.meta.exposedOutputs[0].nodeId "missing-node" does not exist',
      );
    });
  });

  describe("rr_v3 publish APIs", () => {
    it("publishes a flow, lists it, and unpublishes it", async () => {
      const flow = createTestFlow("flow-1");
      getInternal(storage).flowsMap.set(flow.id, flow);

      const published = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.publishFlow",
          params: {
            flowId: "flow-1",
            slug: "Checkout Flow",
            category: "automation",
            description: "Checkout automation",
          },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      );

      expect(published).toEqual({
        id: "flow-1",
        slug: "checkout-flow",
        revision: expect.stringMatching(/^rev-fnv1a32-/),
        version: 3,
        name: "Test Flow flow-1",
        description: "Checkout automation",
        category: "automation",
      });
      expect(
        getInternal(storage).flowsMap.get("flow-1")?.meta?.tool,
      ).toMatchObject({
        published: true,
        slug: "checkout-flow",
        category: "automation",
        description: "Checkout automation",
      });

      const listed = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        { method: "rr_v3.listPublishedFlows", params: {}, requestId: "req-2" },
        { subscriptions: new Set() },
      );
      expect(listed).toEqual([published]);

      const unpublished = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.unpublishFlow",
          params: { flowId: "flow-1" },
          requestId: "req-3",
        },
        { subscriptions: new Set() },
      );
      expect(unpublished).toEqual({ ok: true, flowId: "flow-1" });
      expect(
        getInternal(storage).flowsMap.get("flow-1")?.meta?.tool,
      ).toMatchObject({
        published: false,
        slug: "checkout-flow",
      });

      const emptyPublishedList = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        { method: "rr_v3.listPublishedFlows", params: {}, requestId: "req-4" },
        { subscriptions: new Set() },
      );
      expect(emptyPublishedList).toEqual([]);
    });

    it("publishes already-stored flows without revalidating their graph", async () => {
      const flow = createTestFlow("flow-invalid-publish");
      flow.entryNodeId = "trigger-1" as FlowV3["entryNodeId"];
      flow.nodes = [
        { id: "trigger-1", kind: "trigger", config: {} },
        { id: "node-1", kind: "navigate", config: {} },
      ] as FlowV3["nodes"];
      flow.edges = [
        { id: "edge-1", from: "trigger-1", to: "node-1" },
      ] as FlowV3["edges"];
      getInternal(storage).flowsMap.set(flow.id, flow);

      const published = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.publishFlow",
          params: {
            flowId: "flow-invalid-publish",
            slug: "Legacy Broken Flow",
          },
          requestId: "req-legacy-publish",
        },
        { subscriptions: new Set() },
      );

      expect(published).toEqual({
        id: "flow-invalid-publish",
        slug: "legacy-broken-flow",
        revision: expect.stringMatching(/^rev-fnv1a32-/),
        version: 3,
        name: "Test Flow flow-invalid-publish",
      });
      expect(
        getInternal(storage).flowsMap.get("flow-invalid-publish")?.meta?.tool,
      ).toMatchObject({
        published: true,
        slug: "legacy-broken-flow",
      });
    });

    it("rejects publish while the flow write lock is held", async () => {
      const flow = createTestFlow("flow-locked-publish");
      getInternal(storage).flowsMap.set(flow.id, flow);
      const release = tryAcquireFlowWriteLock(flow.id);

      try {
        await expect(
          (server as unknown as { handleRequest: Function }).handleRequest(
            {
              method: "rr_v3.publishFlow",
              params: { flowId: flow.id, slug: "Locked Publish" },
              requestId: "req-locked-publish",
            },
            { subscriptions: new Set() },
          ),
        ).rejects.toMatchObject({
          code: "FLOW_WRITE_CONFLICT",
          retryable: true,
          flowId: flow.id,
        });
        expect(storage.flows.save).not.toHaveBeenCalled();
      } finally {
        release();
      }
    });

    it("enforces requireStable publish quality gate when requested", async () => {
      const flow = createTestFlow("flow-require-stable");
      getInternal(storage).flowsMap.set(flow.id, flow);

      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.publishFlow",
            params: {
              flowId: flow.id,
              slug: "Require Stable",
              requireStable: true,
            },
            requestId: "req-require-stable-missing",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow("Workflow quality is not current: missing_quality");

      flow.meta = {
        tool: {
          published: true,
          slug: "require-stable",
        },
      };
      flow.meta = {
        ...flow.meta,
        quality: {
          revision: calculateWorkflowRevision(flow),
          level: "stable",
          status: "stable",
          stabilityScore: 1,
          passRate: 1,
          validationRuns: 3,
          countedValidationRuns: 3,
          passedRuns: 3,
          failedRuns: 0,
          minValidationRuns: 3,
          freshnessExpiresAt: "2999-01-01T00:00:00.000Z" as any,
          verification: {
            oracle: "none",
            oracleStrength: "weak",
          },
        },
      };

      const published = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.publishFlow",
          params: {
            flowId: flow.id,
            slug: "Require Stable",
            requireStable: true,
          },
          requestId: "req-require-stable-ok",
        },
        { subscriptions: new Set() },
      );

      expect(published).toMatchObject({
        id: flow.id,
        slug: "require-stable",
      });
    });

    it("preserves an existing custom slug when republishing without a slug override", async () => {
      const flow = createTestFlow("flow-custom-slug");
      flow.meta = {
        tool: {
          published: false,
          slug: "existing-custom-slug",
        },
      };
      getInternal(storage).flowsMap.set(flow.id, flow);

      const published = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.publishFlow",
          params: { flowId: "flow-custom-slug" },
          requestId: "req-custom-slug",
        },
        { subscriptions: new Set() },
      );

      expect(published).toEqual({
        id: "flow-custom-slug",
        slug: "existing-custom-slug",
        revision: expect.stringMatching(/^rev-fnv1a32-/),
        version: 3,
        name: "Test Flow flow-custom-slug",
      });
      expect(
        getInternal(storage).flowsMap.get("flow-custom-slug")?.meta?.tool,
      ).toMatchObject({
        published: true,
        slug: "existing-custom-slug",
      });
    });

    it("sanitizes legacy invalid tool metadata when publishing a stored flow", async () => {
      const flow = createTestFlow("flow-dirty-tool");
      flow.meta = {
        tool: {
          published: false,
          slug: "legacy-tool-slug",
          category: 123 as unknown as string,
          description: { bad: true } as unknown as string,
        },
      };
      getInternal(storage).flowsMap.set(flow.id, flow);

      const published = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.publishFlow",
          params: { flowId: "flow-dirty-tool" },
          requestId: "req-dirty-tool",
        },
        { subscriptions: new Set() },
      );

      expect(published).toEqual({
        id: "flow-dirty-tool",
        slug: "legacy-tool-slug",
        revision: expect.stringMatching(/^rev-fnv1a32-/),
        version: 3,
        name: "Test Flow flow-dirty-tool",
      });
      expect(
        getInternal(storage).flowsMap.get("flow-dirty-tool")?.meta?.tool,
      ).toEqual({
        published: true,
        slug: "legacy-tool-slug",
      });
    });

    it("unpublishes already-stored flows without revalidating their graph", async () => {
      const flow = createTestFlow("flow-invalid-unpublish");
      flow.entryNodeId = "trigger-1" as FlowV3["entryNodeId"];
      flow.nodes = [
        { id: "trigger-1", kind: "trigger", config: {} },
        { id: "node-1", kind: "navigate", config: {} },
      ] as FlowV3["nodes"];
      flow.edges = [
        { id: "edge-1", from: "trigger-1", to: "node-1" },
      ] as FlowV3["edges"];
      flow.meta = {
        tool: {
          published: true,
          slug: "legacy-broken-flow",
        },
      };
      getInternal(storage).flowsMap.set(flow.id, flow);

      const unpublished = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.unpublishFlow",
          params: { flowId: "flow-invalid-unpublish" },
          requestId: "req-legacy-unpublish",
        },
        { subscriptions: new Set() },
      );

      expect(unpublished).toEqual({ ok: true, flowId: "flow-invalid-unpublish" });
      expect(
        getInternal(storage).flowsMap.get("flow-invalid-unpublish")?.meta?.tool,
      ).toMatchObject({
        published: false,
        slug: "legacy-broken-flow",
      });
    });

    it("lists published flows even when legacy tool metadata contains non-string text fields", async () => {
      const dirtyPublishedFlow = createTestFlow("flow-dirty-listed");
      dirtyPublishedFlow.meta = {
        tool: {
          published: true,
          slug: "listed-legacy-slug",
          category: 123 as unknown as string,
          description: { bad: true } as unknown as string,
        },
      };
      getInternal(storage).flowsMap.set(dirtyPublishedFlow.id, dirtyPublishedFlow);

      const listed = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        { method: "rr_v3.listPublishedFlows", params: {}, requestId: "req-dirty-list" },
        { subscriptions: new Set() },
      );

      expect(listed).toEqual([
        {
          id: "flow-dirty-listed",
          slug: "listed-legacy-slug",
          revision: expect.stringMatching(/^rev-fnv1a32-/),
          version: 3,
          name: "Test Flow flow-dirty-listed",
        },
      ]);
    });

    it("rejects duplicate published slugs", async () => {
      const flowA = createTestFlow("flow-a");
      flowA.meta = {
        tool: {
          published: true,
          slug: "shared-slug",
        },
      };
      const flowB = createTestFlow("flow-b");
      getInternal(storage).flowsMap.set(flowA.id, flowA);
      getInternal(storage).flowsMap.set(flowB.id, flowB);

      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.publishFlow",
            params: { flowId: "flow-b", slug: "shared slug" },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow(
        'Published workflow slug "shared-slug" is already used by flow "flow-a"',
      );
    });

    it("throws when publishing a missing flow", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.publishFlow",
            params: { flowId: "missing-flow" },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Flow "missing-flow" not found');
    });
  });

  describe("rr_v3.deleteFlow", () => {
    it("deletes an existing flow", async () => {
      // Setup: add flow
      const flow = createTestFlow("flow-1");
      getInternal(storage).flowsMap.set(flow.id, flow);

      const result = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.deleteFlow",
          params: { flowId: "flow-1" },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      );

      expect(storage.flows.delete).toHaveBeenCalledWith("flow-1");
      expect(result).toEqual({ ok: true, flowId: "flow-1" });
    });

    it("throws if flowId is missing", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          { method: "rr_v3.deleteFlow", params: {}, requestId: "req-1" },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow("flowId is required");
    });

    it("throws if flow does not exist", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.deleteFlow",
            params: { flowId: "non-existent" },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow('Flow "non-existent" not found');
    });

    it("throws if flow has linked triggers", async () => {
      // Setup: add flow and trigger
      const flow = createTestFlow("flow-1");
      getInternal(storage).flowsMap.set(flow.id, flow);

      // Mock triggers.list to return a trigger linked to this flow
      (storage.triggers.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "trigger-1", kind: "manual", flowId: "flow-1", enabled: true },
      ]);

      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.deleteFlow",
            params: { flowId: "flow-1" },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow(
        'Cannot delete flow "flow-1": it has 1 linked trigger(s): trigger-1',
      );
    });

    it("throws if flow has multiple linked triggers", async () => {
      // Setup
      const flow = createTestFlow("flow-1");
      getInternal(storage).flowsMap.set(flow.id, flow);

      (storage.triggers.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "trigger-1", kind: "manual", flowId: "flow-1", enabled: true },
        {
          id: "trigger-2",
          kind: "interval",
          flowId: "flow-1",
          enabled: true,
          everySec: 300,
        },
      ]);

      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.deleteFlow",
            params: { flowId: "flow-1" },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow(
        'Cannot delete flow "flow-1": it has 2 linked trigger(s): trigger-1, trigger-2',
      );
    });

    it("throws if flow has queued runs", async () => {
      // Setup
      const flow = createTestFlow("flow-1");
      getInternal(storage).flowsMap.set(flow.id, flow);

      // Add queued run
      getInternal(storage).queueMap.set("run-1", {
        id: "run-1",
        flowId: "flow-1",
        status: "queued",
        priority: 0,
        createdAt: 1000,
        updatedAt: 1000,
        attempt: 0,
        maxAttempts: 1,
      });

      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          {
            method: "rr_v3.deleteFlow",
            params: { flowId: "flow-1" },
            requestId: "req-1",
          },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow(
        'Cannot delete flow "flow-1": it has 1 queued run(s): run-1',
      );
    });

    it("allows deletion when runs are running (not queued)", async () => {
      // Setup
      const flow = createTestFlow("flow-1");
      getInternal(storage).flowsMap.set(flow.id, flow);

      // Add running run (not queued) - should NOT block deletion
      getInternal(storage).queueMap.set("run-1", {
        id: "run-1",
        flowId: "flow-1",
        status: "running", // running, not queued
        priority: 0,
        createdAt: 1000,
        updatedAt: 1000,
        attempt: 1,
        maxAttempts: 1,
      });

      const result = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.deleteFlow",
          params: { flowId: "flow-1" },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      );

      expect(result).toEqual({ ok: true, flowId: "flow-1" });
    });
  });

  describe("rr_v3.getFlow", () => {
    it("returns flow by id", async () => {
      const flow = createTestFlow("flow-1");
      getInternal(storage).flowsMap.set(flow.id, flow);

      const result = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.getFlow",
          params: { flowId: "flow-1" },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      );

      expect(result).toEqual(flow);
    });

    it("returns null for non-existent flow", async () => {
      const result = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        {
          method: "rr_v3.getFlow",
          params: { flowId: "non-existent" },
          requestId: "req-1",
        },
        { subscriptions: new Set() },
      );

      expect(result).toBeNull();
    });

    it("throws if flowId is missing", async () => {
      await expect(
        (server as unknown as { handleRequest: Function }).handleRequest(
          { method: "rr_v3.getFlow", params: {}, requestId: "req-1" },
          { subscriptions: new Set() },
        ),
      ).rejects.toThrow("flowId is required");
    });
  });

  describe("rr_v3.listFlows", () => {
    it("returns all flows", async () => {
      const flow1 = createTestFlow("flow-1");
      const flow2 = createTestFlow("flow-2");
      getInternal(storage).flowsMap.set(flow1.id, flow1);
      getInternal(storage).flowsMap.set(flow2.id, flow2);

      const result = (await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        { method: "rr_v3.listFlows", params: {}, requestId: "req-1" },
        { subscriptions: new Set() },
      )) as FlowV3[];

      expect(result).toHaveLength(2);
      expect(result.map((f) => f.id).sort()).toEqual(["flow-1", "flow-2"]);
    });

    it("returns empty array when no flows exist", async () => {
      const result = await (
        server as unknown as { handleRequest: Function }
      ).handleRequest(
        { method: "rr_v3.listFlows", params: {}, requestId: "req-1" },
        { subscriptions: new Set() },
      );

      expect(result).toEqual([]);
    });
  });
});
