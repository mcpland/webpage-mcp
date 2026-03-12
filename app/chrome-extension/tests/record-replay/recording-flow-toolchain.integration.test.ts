import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Flow } from "@/entrypoints/background/record-replay/types";
import { createStoragePort } from "@/entrypoints/background/record-replay-v3";
import { deleteRrV3Db } from "@/entrypoints/background/record-replay-v3/storage/db";

const mocks = vi.hoisted(() => ({
  recorderStart: vi.fn(),
  recorderStop: vi.fn(),
  buildRecordingStateSnapshot: vi.fn(),
  runFlow: vi.fn(),
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

vi.mock("@/entrypoints/background/record-replay/flow-runner", () => ({
  runFlow: mocks.runFlow,
}));

import {
  getFlow,
  saveFlow,
} from "@/entrypoints/background/record-replay/flow-store";
import {
  flowAnalyzeTool,
  flowUpdateTool,
} from "@/entrypoints/background/tools/flow-tools";
import { flowRunTool } from "@/entrypoints/background/tools/record-replay";
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
  nodes: Flow["nodes"],
  overrides: Partial<Flow> = {},
): Flow {
  const iso = new Date(0).toISOString();
  return {
    id,
    name: `Flow ${id}`,
    version: 1,
    nodes: nodes ?? [],
    edges: [],
    variables: [],
    meta: {
      createdAt: iso,
      updatedAt: iso,
      ...(overrides.meta || {}),
    },
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

  it("recordingStopTool persists renamed flow metadata after a successful stop", async () => {
    const flowId = `flow-stop-${Date.now()}`;
    const recordedFlow = createFlow(flowId, [
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
    const persisted = await getFlow(flowId);
    const persistedV3 = await createStoragePort().flows.get(flowId as any);

    expect(payload.success).toBe(true);
    expect(payload.flow).toMatchObject({
      id: flowId,
      name: "Final Signup Flow",
      description: "Captures the signup form",
      stepCount: 1,
    });
    expect(persisted?.name).toBe("Final Signup Flow");
    expect(persisted?.description).toBe("Captures the signup form");
    expect(typeof persisted?.meta?.updatedAt).toBe("string");
    expect(persistedV3).toMatchObject({
      id: flowId,
      name: "Final Signup Flow",
      description: "Captures the signup form",
    });
  });

  it("flowAnalyzeTool summarizes saved flows and surfaces recording quality hints", async () => {
    const flowId = `flow-analyze-${Date.now()}`;
    await saveFlow(
      createFlow(flowId, [
        {
          id: "fill-1",
          type: "fill",
          config: {
            target: { selector: "/html/body/main/form/input[1]" },
            value: "alice@example.com",
          },
        },
        {
          id: "fill-2",
          type: "fill",
          config: {
            target: { selector: "/html/body/main/form/input[1]" },
            value: "alice@example.com",
          },
        },
      ]),
      { notify: false },
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
    await saveFlow(
      createFlow(
        flowId,
        [
          {
            id: "nav-1",
            type: "navigate",
            config: { url: "https://example.com/search?q=laptop" },
          },
          {
            id: "fill-1",
            type: "fill",
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
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            recording: {
              parameterSuggestions: [
                {
                  nodeId: "nav-1",
                  kind: "navigate",
                  suggestedKey: "q",
                  currentValue: "laptop",
                },
                {
                  nodeId: "fill-1",
                  kind: "fill",
                  suggestedKey: "email",
                  currentValue: "alice@example.com",
                },
              ],
            },
          },
        },
      ),
      { notify: false },
    );

    const result = await flowUpdateTool.execute({
      flowId,
      name: "Parameterized Search Flow",
      description: "Updated from tool integration test",
      applyParameterSuggestions: true,
    });
    const payload = parseToolPayload(result);
    const updated = await getFlow(flowId);

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
    expect(updated?.variables?.map((variable) => variable.key)).toEqual([
      "q",
      "email",
    ]);
  });

  it("flowRunTool loads the saved flow and forwards normalized run options to the runner", async () => {
    const flowId = `flow-run-${Date.now()}`;
    await saveFlow(
      createFlow(flowId, [
        {
          id: "fill-1",
          type: "fill",
          config: {
            target: {
              selector: "#email",
              candidates: [{ type: "css", value: "#email" }],
            },
            value: "{email}",
          },
        },
      ]),
      { notify: false },
    );
    mocks.runFlow.mockResolvedValue({
      runId: "run-toolchain",
      success: true,
      summary: { total: 1, success: 1, failed: 0, tookMs: 5 },
    });

    const result = await flowRunTool.execute({
      flowId,
      args: { email: "alice@example.com" },
      tabId: 21,
      returnLogs: true,
      stepDelayMs: 12.8,
      screenshotBaselines: {
        "": "ignored",
        "fill-1": "baseline-1",
        "fill-2": "",
      },
      screenshotDiffThreshold: 0.88,
    });

    expect(mocks.runFlow).toHaveBeenCalledWith(
      expect.objectContaining({ id: flowId }),
      expect.objectContaining({
        args: { email: "alice@example.com" },
        tabId: 21,
        returnLogs: true,
        stepDelayMs: 12,
        screenshotBaselines: { "fill-1": "baseline-1" },
        screenshotDiffThreshold: 0.88,
      }),
    );
    expect(parseToolPayload(result)).toMatchObject({
      runId: "run-toolchain",
      success: true,
      summary: { total: 1, success: 1, failed: 0, tookMs: 5 },
    });
  });
});
