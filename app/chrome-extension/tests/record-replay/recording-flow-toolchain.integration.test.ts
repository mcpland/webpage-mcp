import { beforeEach, describe, expect, it, vi } from "vitest";

import { createStoragePort } from "@/entrypoints/background/record-replay-v3";
import type { FlowV3 } from "@/entrypoints/background/record-replay-v3/domain/flow";
import { deleteRrV3Db } from "@/entrypoints/background/record-replay-v3/storage/db";

const mocks = vi.hoisted(() => ({
  recorderStart: vi.fn(),
  recorderStop: vi.fn(),
  buildRecordingStateSnapshot: vi.fn(),
  saveFlowToV3: vi.fn(),
  enqueueRunAndWait: vi.fn(),
}));

vi.mock(
  "@/entrypoints/background/record-replay/recording/recorder-manager",
  () => ({
    RecorderManager: {
      start: mocks.recorderStart,
      stop: mocks.recorderStop,
    },
  }),
);

vi.mock(
  "@/entrypoints/background/record-replay/recording/recording-state",
  () => ({
    buildRecordingStateSnapshot: mocks.buildRecordingStateSnapshot,
  }),
);

vi.mock("@/entrypoints/background/record-replay-v3/compat", () => ({
  saveFlowToV3: mocks.saveFlowToV3,
  enqueueRunAndWait: mocks.enqueueRunAndWait,
}));

import {
  flowAnalyzeTool,
  flowUpdateTool,
} from "@/entrypoints/background/tools/flow-tools";
import {
  flowRunTool,
  listPublishedFlowsTool,
} from "@/entrypoints/background/tools/record-replay";
import {
  recordingStartTool,
  recordingStatusTool,
  recordingStopTool,
} from "@/entrypoints/background/tools/recording";

function asMock(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

function createFlow(
  id: string,
  nodes: FlowV3["nodes"],
  overrides: Partial<FlowV3> = {},
): FlowV3 {
  const iso = new Date(0).toISOString();
  return {
    schemaVersion: 3,
    id: id as any,
    name: `Flow ${id}`,
    entryNodeId: (nodes[0]?.id ?? "node-1") as any,
    nodes: nodes ?? [],
    edges: [],
    variables: [],
    createdAt: iso as any,
    updatedAt: iso as any,
    ...overrides,
  };
}

function parseToolPayload(result: {
  content?: Array<{ type?: string; text?: string }>;
}): any {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) {
    throw new Error("Expected text payload from tool result");
  }
  return JSON.parse(text);
}

describe("recording/editing/flow toolchain integration", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await deleteRrV3Db();
    mocks.buildRecordingStateSnapshot.mockReturnValue({
      status: "idle",
      activeTabIds: [],
      stepCount: 0,
    });
    asMock(chrome.storage.local.get).mockResolvedValue({});
    asMock(chrome.storage.local.set).mockResolvedValue(undefined);
    asMock(chrome.runtime.sendMessage).mockResolvedValue(undefined);
    mocks.saveFlowToV3.mockImplementation(async (flow: FlowV3) => {
      const now = new Date().toISOString();
      const persisted = {
        ...flow,
        schemaVersion: 3,
        createdAt: flow.createdAt ?? (now as any),
        updatedAt: now as any,
      };
      await createStoragePort().flows.save(persisted as FlowV3);
      return persisted;
    });
  });

  it("recordingStartTool forwards trimmed metadata and returns a state snapshot", async () => {
    mocks.recorderStart.mockResolvedValue({ success: true });
    mocks.buildRecordingStateSnapshot.mockReturnValue({
      status: "recording",
      activeTabIds: [17],
      stepCount: 1,
    });

    const result = await recordingStartTool.execute({
      name: "  Signup Flow  ",
      tabId: 17,
    });

    expect(mocks.recorderStart).toHaveBeenCalledWith(
      { name: "Signup Flow" },
      17,
    );
    expect(parseToolPayload(result)).toEqual({
      success: true,
      state: {
        status: "recording",
        activeTabIds: [17],
        stepCount: 1,
      },
    });
  });

  it("recordingStatusTool reports the latest recording snapshot", async () => {
    mocks.buildRecordingStateSnapshot.mockReturnValue({
      status: "paused",
      activeTabIds: [3],
      stepCount: 4,
    });

    const result = await recordingStatusTool.execute();

    expect(parseToolPayload(result)).toEqual({
      success: true,
      state: {
        status: "paused",
        activeTabIds: [3],
        stepCount: 4,
      },
    });
  });

  it("recordingStopTool persists renamed flow metadata into V3 storage", async () => {
    const flowId = `flow-stop-${Date.now()}`;
    const recordedFlow = createFlow(flowId, [
      {
        id: "fill-1" as any,
        kind: "fill",
        config: {
          target: {
            selector: "#email",
            candidates: [{ type: "css", value: "#email" }],
          },
          value: "alice@example.com",
        },
      },
    ]);

    mocks.recorderStop.mockResolvedValue({
      success: true,
      flow: recordedFlow,
    });

    const result = await recordingStopTool.execute({
      name: "  Final Signup Flow  ",
      description: "  Captures the signup form  ",
    });
    const payload = parseToolPayload(result);
    const persisted = await createStoragePort().flows.get(flowId as any);

    expect(payload.success).toBe(true);
    expect(payload.flow).toMatchObject({
      id: flowId,
      name: "Final Signup Flow",
      description: "Captures the signup form",
      stepCount: 1,
    });
    expect(persisted).toMatchObject({
      id: flowId,
      name: "Final Signup Flow",
      description: "Captures the signup form",
    });
    expect(typeof persisted?.updatedAt).toBe("string");
  });

  it("recordingStopTool keeps the recorded flow summary when V3 persistence fails", async () => {
    const flowId = `flow-stop-fallback-${Date.now()}`;
    const recordedFlow = {
      id: flowId,
      name: "Draft flow",
      version: 1,
      nodes: [
        {
          id: "fill-1",
          type: "fill",
          config: {
            target: {
              selector: "#email",
              candidates: [{ type: "css", value: "#email" }],
            },
            value: "alice@example.com",
          },
        },
      ],
      edges: [],
      variables: [],
      meta: {
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    };

    mocks.recorderStop.mockResolvedValue({
      success: true,
      flow: recordedFlow,
      error: "Initial V3 sync failed",
    });
    mocks.saveFlowToV3.mockRejectedValueOnce(new Error("V3 unavailable"));

    const result = await recordingStopTool.execute({
      name: "Recovered recording",
      description: "Still usable after V3 error",
    });
    const payload = parseToolPayload(result);

    expect(payload.success).toBe(true);
    expect(payload.flow).toMatchObject({
      id: flowId,
      name: "Recovered recording",
      description: "Still usable after V3 error",
      stepCount: 1,
    });
    expect(payload.warning).toContain("Initial V3 sync failed");
    expect(payload.warning).toContain(
      "Failed to persist renamed recorded workflow to V3: V3 unavailable",
    );
  });

  it("flowAnalyzeTool summarizes saved flows and surfaces recording quality hints", async () => {
    const flowId = `flow-analyze-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(flowId, [
        {
          id: "fill-1" as any,
          kind: "fill",
          config: {
            target: { selector: "/html/body/main/form/input[1]" },
            value: "alice@example.com",
          },
        },
        {
          id: "fill-2" as any,
          kind: "fill",
          config: {
            target: { selector: "/html/body/main/form/input[1]" },
            value: "alice@example.com",
          },
        },
      ]),
    );

    const result = await flowAnalyzeTool.execute({ flowId });
    const payload = parseToolPayload(result);
    const codes = new Set(
      payload.hints.map((hint: { code: string }) => hint.code),
    );

    expect(payload.summary).toMatchObject({
      flowId,
      nodeCount: 2,
      edgeCount: 0,
      variableCount: 0,
    });
    expect(codes.has("missing_assertion")).toBe(true);
    expect(codes.has("unstable_selector")).toBe(true);
    expect(codes.has("literal_fill_value")).toBe(true);
    expect(codes.has("possible_redundant_step")).toBe(true);
  });

  it("flowUpdateTool applies parameter suggestions and persists the edited flow", async () => {
    const flowId = `flow-update-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(
        flowId,
        [
          {
            id: "nav-1" as any,
            kind: "navigate",
            config: { url: "https://example.com/search?q=laptop" },
          },
          {
            id: "fill-1" as any,
            kind: "fill",
            config: {
              target: {
                selector: '[name="email"]',
                candidates: [{ type: "css", value: '[name="email"]' }],
              },
              value: "alice@example.com",
            },
          },
        ],
        {
          meta: {
            recording: {
              parameterSuggestions: [
                {
                  nodeId: "nav-1" as any,
                  kind: "navigate",
                  suggestedKey: "q",
                  currentValue: "laptop",
                },
                {
                  nodeId: "fill-1" as any,
                  kind: "fill",
                  suggestedKey: "email",
                  currentValue: "alice@example.com",
                },
              ],
            },
          },
        },
      ),
    );

    const result = await flowUpdateTool.execute({
      flowId,
      name: "Parameterized Search Flow",
      description: "Updated from tool integration test",
      applyParameterSuggestions: true,
    });
    const payload = parseToolPayload(result);
    const updated = await createStoragePort().flows.get(flowId as any);

    expect(payload.updated).toBe(true);
    expect(payload.parameterization).toMatchObject({
      changed: true,
      applied: 2,
      variablesAdded: 2,
      skipped: 0,
    });
    expect(updated?.name).toBe("Parameterized Search Flow");
    expect(updated?.description).toBe("Updated from tool integration test");
    expect(
      (
        updated?.nodes?.find((node) => node.id === "nav-1")?.config as {
          url?: string;
        }
      )?.url,
    ).toBe("https://example.com/search?q={q}");
    expect(
      (
        updated?.nodes?.find((node) => node.id === "fill-1")?.config as {
          value?: string;
        }
      )?.value,
    ).toBe("{email}");
    expect(updated?.variables?.map((variable) => variable.name)).toEqual([
      "q",
      "email",
    ]);
  });

  it("flowUpdateTool normalizes legacy variable payloads before saving", async () => {
    const flowId = `flow-update-vars-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(flowId, [
        {
          id: "node-1" as any,
          kind: "navigate",
          config: { url: "https://example.com" },
        },
      ]),
    );

    const result = await flowUpdateTool.execute({
      flowId,
      variables: [
        {
          key: "email",
          label: "Email",
          default: "alice@example.com",
          required: true,
          scope: "flow",
        },
      ],
    });
    const payload = parseToolPayload(result);
    const updated = await createStoragePort().flows.get(flowId as any);

    expect(payload).toMatchObject({
      success: true,
      updated: true,
      flow: {
        id: flowId,
        variableCount: 1,
      },
    });
    expect(updated?.variables).toEqual([
      {
        name: "email",
        label: "Email",
        default: "alice@example.com",
        required: true,
        scope: "flow",
      },
    ]);
  });

  it("flowUpdateTool recalculates entryNodeId when the node graph is replaced", async () => {
    const flowId = `flow-update-entry-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(flowId, [
        {
          id: "old-entry" as any,
          kind: "navigate",
          config: { url: "https://example.com/original" },
        },
        {
          id: "old-next" as any,
          kind: "click",
          config: {},
        },
      ], {
        edges: [
          {
            id: "edge-old" as any,
            from: "old-entry" as any,
            to: "old-next" as any,
          },
        ],
      }),
    );

    const result = await flowUpdateTool.execute({
      flowId,
      nodes: [
        {
          id: "new-start",
          kind: "fill",
          config: {
            target: {
              selector: "#email",
              candidates: [{ type: "css", value: "#email" }],
            },
            value: "{email}",
          },
        },
        {
          id: "new-next",
          kind: "click",
          config: {},
        },
      ],
      edges: [
        {
          id: "edge-new",
          from: "new-start",
          to: "new-next",
        },
      ],
    });
    const payload = parseToolPayload(result);
    const updated = await createStoragePort().flows.get(flowId as any);

    expect(payload).toMatchObject({
      success: true,
      updated: true,
      flow: {
        id: flowId,
        nodeCount: 2,
        edgeCount: 1,
      },
    });
    expect(updated?.entryNodeId).toBe("new-start");
    expect(updated?.nodes.map((node) => node.id)).toEqual([
      "new-start",
      "new-next",
    ]);
  });

  it("flowUpdateTool rejects replacement graphs with duplicate node ids", async () => {
    const flowId = `flow-update-duplicate-node-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(flowId, [
        {
          id: "start" as any,
          kind: "navigate",
          config: { url: "https://example.com/original" },
        },
      ]),
    );

    await expect(
      flowUpdateTool.execute({
        flowId,
        nodes: [
          {
            id: "dup-node",
            kind: "navigate",
            config: { url: "https://example.com/one" },
          },
          {
            id: "dup-node",
            kind: "click",
            config: {},
          },
        ],
        edges: [],
      }),
    ).rejects.toThrow('Duplicate node ID: "dup-node"');

    const unchanged = await createStoragePort().flows.get(flowId as any);
    expect(unchanged?.nodes.map((node) => node.id)).toEqual(["start"]);
  });

  it("flowRunTool forwards supported tab-binding options into the V3 runner path", async () => {
    const flowId = `flow-run-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(flowId, [
        {
          id: "fill-1" as any,
          kind: "fill",
          config: {
            target: {
              selector: "#email",
              candidates: [{ type: "css", value: "#email" }],
            },
            value: "{email}",
          },
        },
      ]),
    );
    mocks.enqueueRunAndWait.mockResolvedValue({
      run: { id: "run-toolchain" } as any,
      events: [],
      result: {
        runId: "run-toolchain",
        success: true,
        summary: { total: 1, success: 1, failed: 0, tookMs: 5 },
        outputs: null,
        logs: [],
        paused: false,
      },
    });

    const result = await flowRunTool.execute({
      flowId,
      args: { email: "alice@example.com" },
      tabTarget: "new",
      startUrl: "https://example.com/checkout",
      refresh: true,
      stepDelayMs: 12.8,
      screenshotBaselines: {
        "": "ignored",
        "fill-1": "baseline-1",
        "fill-2": "",
      },
      screenshotDiffThreshold: 0.88,
    });
    const payload = parseToolPayload(result);

    expect(mocks.enqueueRunAndWait).toHaveBeenCalledWith({
      flowId,
      tabId: undefined,
      tabTarget: "new",
      args: { email: "alice@example.com" },
      startUrl: "https://example.com/checkout",
      refresh: true,
      timeoutMs: undefined,
    });
    expect(payload).toMatchObject({
      runId: "run-toolchain",
      success: true,
      summary: { total: 1, success: 1, failed: 0, tookMs: 5 },
      warning: expect.stringContaining("stepDelayMs"),
    });
    expect(payload.warning).not.toContain("tabTarget");
    expect(payload.warning).not.toContain("startUrl");
    expect(payload.warning).not.toContain("refresh");
  });

  it("flowRunTool binds to an explicit tabId when one is provided", async () => {
    const flowId = `flow-run-tab-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(flowId, [
        {
          id: "fill-1" as any,
          kind: "fill",
          config: {
            target: {
              selector: "#email",
              candidates: [{ type: "css", value: "#email" }],
            },
            value: "{email}",
          },
        },
      ]),
    );
    mocks.enqueueRunAndWait.mockResolvedValue({
      run: { id: "run-toolchain-tab" } as any,
      events: [],
      result: {
        runId: "run-toolchain-tab",
        success: true,
        summary: { total: 1, success: 1, failed: 0, tookMs: 3 },
        outputs: null,
        logs: [],
        paused: false,
      },
    });

    await flowRunTool.execute({
      flowId,
      args: { email: "alice@example.com" },
      tabId: 21,
    });

    expect(mocks.enqueueRunAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        args: { email: "alice@example.com" },
        tabId: 21,
        tabTarget: "current",
      }),
    );
  });

  it("listPublishedFlowsTool reports published V3 workflows", async () => {
    const flowId = `flow-published-v3-${Date.now()}`;
    await createStoragePort().flows.save({
      schemaVersion: 3,
      id: flowId as any,
      name: "Published V3 Flow",
      entryNodeId: "node-1" as any,
      nodes: [
        {
          id: "node-1" as any,
          kind: "navigate",
          config: { url: "https://example.com" },
        },
      ],
      edges: [],
      variables: [
        { name: "target_url", default: "https://example.com" } as any,
      ],
      createdAt: new Date(0).toISOString() as any,
      updatedAt: new Date(0).toISOString() as any,
      meta: {
        tool: {
          published: true,
          slug: "published-v3-flow",
          description: "Published from V3",
        },
      },
    });

    const result = await listPublishedFlowsTool.execute();
    const payload = parseToolPayload(result);

    expect(payload).toEqual({
      success: true,
      published: [
        expect.objectContaining({
          id: flowId,
          slug: "published-v3-flow",
          name: "Published V3 Flow",
          description: "Published from V3",
          variables: [expect.objectContaining({ name: "target_url" })],
        }),
      ],
    });
  });
});
