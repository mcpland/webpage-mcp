import { beforeEach, describe, expect, it, vi } from "vitest";

import { createStoragePort } from "@/entrypoints/background/record-replay-v3";
import {
  RUN_SCHEMA_VERSION,
  type RunRecordV3,
} from "@/entrypoints/background/record-replay-v3/domain/events";
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
  workflowDescribeTool,
  workflowDebugViewTool,
  workflowRepairTool,
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

  it("flowAnalyzeTool redacts sensitive variables from the returned flow", async () => {
    const flowId = `flow-analyze-sensitive-${Date.now()}`;
    const flow = createFlow(flowId, [
      {
        id: "start-1" as any,
        kind: "navigate",
        config: { url: "https://example.com" },
      },
    ]);
    flow.variables = [
      {
        name: "email",
        label: "Email",
        default: "alice@example.com",
      },
      {
        name: "apiToken",
        label: "API token",
        default: "secret-token",
      },
      {
        name: "apiKey",
        label: "API key",
        default: "opaque-value",
      },
    ] as any;
    await createStoragePort().flows.save(flow);

    const result = await flowAnalyzeTool.execute({ flowId });
    const payload = parseToolPayload(result);

    expect(payload.summary).toMatchObject({
      flowId,
      variableCount: 1,
    });
    expect(payload.flow.variables).toEqual([
      {
        name: "email",
        label: "Email",
        default: "alice@example.com",
      },
    ]);
  });

  it("flowAnalyzeTool returns a minimized public flow view", async () => {
    const flowId = `flow-analyze-public-${Date.now()}`;
    const flow = createFlow(
      flowId,
      [
        {
          id: "script-1" as any,
          kind: "script",
          name: "Read token",
          config: {
            code: "return localStorage.getItem('token')",
          },
        },
      ],
      {
        meta: {
          tool: {
            published: true,
            slug: "public-flow",
          },
          recording: {
            originUrl: "file:///tmp/secret.txt",
            originTitle: "secret.txt",
            userAgent: "secret-agent",
          },
        },
      },
    );
    await createStoragePort().flows.save(flow);

    const result = await flowAnalyzeTool.execute({ flowId });
    const payload = parseToolPayload(result);

    expect(payload.flow).toMatchObject({
      id: flowId,
      name: `Flow ${flowId}`,
      nodes: [
        {
          id: "script-1",
          kind: "script",
          name: "Read token",
        },
      ],
      meta: {
        tool: {
          published: true,
          slug: "public-flow",
        },
      },
    });
    expect(payload.flow.nodes[0]).not.toHaveProperty("config");
    expect(payload.flow.meta).not.toHaveProperty("recording");
    expect(payload.flow.meta).not.toHaveProperty("stopBarrier");
  });

  it("workflowDebugViewTool returns sanitized node configs for a published workflow", async () => {
    const flowId = `workflow-debug-${Date.now()}`;
    const flow = createFlow(
      flowId,
      [
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
        {
          id: "script-1" as any,
          kind: "script",
          config: {
            code: "return localStorage.getItem('token')",
          },
        },
        {
          id: "http-1" as any,
          kind: "http",
          config: {
            url: "https://example.com/api",
            method: "POST",
            headers: { "x-session": "opaque-session-id" },
            body: "card=4111111111111111",
            payload: { raw: "opaque-payload" },
            data: "opaque-data",
          },
        },
      ],
      {
        meta: {
          tool: {
            published: true,
            slug: "debug-flow",
          },
        },
      },
    );
    flow.variables = [
      {
        name: "email",
        default: "alice@example.com",
      },
      {
        name: "apiToken",
        default: "secret-token",
      },
      {
        name: "apiKey",
        default: "opaque-value",
      },
    ] as any;
    await createStoragePort().flows.save(flow);

    const result = await workflowDebugViewTool.execute({
      workflow: "debug-flow",
      includeRuns: false,
    });
    const payload = parseToolPayload(result);
    const fillNode = payload.workflow.nodes.find(
      (node: { id: string }) => node.id === "fill-1",
    );
    const scriptNode = payload.workflow.nodes.find(
      (node: { id: string }) => node.id === "script-1",
    );
    const httpNode = payload.workflow.nodes.find(
      (node: { id: string }) => node.id === "http-1",
    );

    expect(payload.summary).toMatchObject({
      flowId,
      workflow: "debug-flow",
      nodeCount: 3,
      runCount: 0,
    });
    expect(fillNode.config.target.selector).toBe("#email");
    expect(fillNode.config.target.candidates).toEqual([
      { type: "css", value: "#email" },
    ]);
    expect(fillNode.config.value).toBe("<redacted>");
    expect(scriptNode.config.code).toContain("<redacted script:");
    expect(httpNode.config).toMatchObject({
      url: "https://example.com/api",
      method: "POST",
      headers: "<redacted>",
      body: "<redacted>",
      payload: "<redacted>",
      data: "<redacted>",
    });
    expect(payload.workflow.variables).toEqual([
      {
        name: "email",
        default: "alice@example.com",
      },
      {
        name: "apiToken",
        sensitive: true,
      },
      {
        name: "apiKey",
        sensitive: true,
      },
    ]);
    expect(payload.runs).toEqual([]);
  });

  it("workflowDebugViewTool includes sanitized recent run failures", async () => {
    const flowId = `workflow-debug-run-${Date.now()}`;
    const runId = `${flowId}-run`;
    const storage = createStoragePort();
    const flow = createFlow(flowId, [
      {
        id: "fill-1" as any,
        kind: "fill",
        config: {
          target: { selector: "#email" },
          value: "{email}",
        },
      },
    ]);
    flow.variables = [
      { name: "email" },
      { name: "apiToken", sensitive: true },
      { name: "apiKey" },
    ] as any;
    await storage.flows.save(flow);
    await storage.runs.save({
      schemaVersion: RUN_SCHEMA_VERSION,
      id: runId as any,
      flowId: flowId as any,
      status: "failed",
      createdAt: 1000 as any,
      updatedAt: 2000 as any,
      startedAt: 1000 as any,
      finishedAt: 2000 as any,
      tookMs: 1000,
      tabId: 17,
      currentNodeId: "fill-1" as any,
      attempt: 1,
      maxAttempts: 1,
      args: {
        email: "alice@example.com",
        apiToken: "secret-token",
        apiKey: "opaque-value",
      },
      error: {
        code: "TARGET_NOT_FOUND",
        message: "Missing input",
        data: {
          selector: "#email",
          token: "secret-token",
          apiKey: "opaque-value",
          payload: "opaque-payload",
          body: "card=4111111111111111",
          headers: { "x-session": "opaque-session-id" },
        },
      },
      nextSeq: 1,
    } as RunRecordV3);
    await storage.events.append({
      runId: runId as any,
      type: "run.started",
      flowId: flowId as any,
      tabId: 17,
    });
    await storage.events.append({
      runId: runId as any,
      type: "node.failed",
      nodeId: "fill-1" as any,
      attempt: 1,
      error: {
        code: "TARGET_NOT_FOUND",
        message: "Missing input",
        data: {
          selector: "#email",
          token: "secret-token",
          apiKey: "opaque-value",
          payload: "opaque-payload",
          body: "card=4111111111111111",
          headers: { "x-session": "opaque-session-id" },
        },
      },
      decision: "stop",
    });
    const artifact = await storage.artifacts.saveScreenshot({
      runId: runId as any,
      nodeId: "fill-1" as any,
      base64: "ZmFpbHVyZS1zaG90",
      filename: "password=secret-token.png",
      metadata: {
        note: "failure screenshot",
        token: "secret-token",
      },
    });
    await storage.events.append({
      runId: runId as any,
      type: "artifact.screenshot",
      nodeId: "fill-1" as any,
      artifactId: artifact.id,
      savedAs: artifact.filename,
    });

    const result = await workflowDebugViewTool.execute({
      flowId,
      runId,
      maxEventsPerRun: 10,
    });
    const payload = parseToolPayload(result);
    const failedEvent = payload.runs[0].events.find(
      (event: { type: string }) => event.type === "node.failed",
    );
    const artifactEvent = payload.runs[0].events.find(
      (event: { type: string }) => event.type === "artifact.screenshot",
    );

    expect(payload.summary.runCount).toBe(1);
    expect(payload.runs[0]).toMatchObject({
      id: runId,
      status: "failed",
      args: {
        email: "alice@example.com",
        apiToken: "<redacted>",
        apiKey: "<redacted>",
      },
      error: {
        code: "TARGET_NOT_FOUND",
        message: "Missing input",
        data: {
          selector: "#email",
          token: "<redacted>",
          apiKey: "<redacted>",
          payload: "<redacted>",
          body: "<redacted>",
          headers: "<redacted>",
        },
      },
      artifacts: [
        {
          id: artifact.id,
          nodeId: "fill-1",
          savedAs: "[REDACTED].png",
          dataBase64: "ZmFpbHVyZS1zaG90",
          metadata: {
            note: "failure screenshot",
            "[REDACTED]": "[REDACTED]-[REDACTED]",
          },
        },
      ],
    });
    expect(failedEvent).toMatchObject({
      type: "node.failed",
      nodeId: "fill-1",
      decision: "stop",
      error: {
        code: "TARGET_NOT_FOUND",
        message: "Missing input",
        data: {
          selector: "#email",
          token: "<redacted>",
          apiKey: "<redacted>",
          payload: "<redacted>",
          body: "<redacted>",
          headers: "<redacted>",
        },
      },
    });
    expect(artifactEvent).toMatchObject({
      type: "artifact.screenshot",
      nodeId: "fill-1",
      artifactId: artifact.id,
      savedAs: "[REDACTED].png",
    });
    expect(artifactEvent).not.toHaveProperty("data");
  });

  it("workflowRepairTool returns recommendations without mutating by default", async () => {
    const flowId = `workflow-repair-dry-${Date.now()}`;
    const flow = createFlow(
      flowId,
      [
        {
          id: "fill-1" as any,
          kind: "fill",
          config: {
            target: { selector: "/html/body/main/form/input[1]" },
            value: "alice@example.com",
          },
        },
        {
          id: "wait-1" as any,
          kind: "wait",
          config: { condition: { kind: "selector", selector: "#ready" } },
        },
      ],
      {
        meta: {
          tool: {
            published: true,
            slug: "repair-dry",
          },
          recording: {
            parameterSuggestions: [
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
    );
    await createStoragePort().flows.save(flow);

    const result = await workflowRepairTool.execute({ workflow: "repair-dry" });
    const payload = parseToolPayload(result);
    const persisted = await createStoragePort().flows.get(flowId as any);
    const codes = new Set(
      payload.recommendations.map(
        (recommendation: { code: string }) => recommendation.code,
      ),
    );

    expect(payload).toMatchObject({
      success: true,
      flowId,
      workflow: "repair-dry",
      applied: false,
      updated: false,
    });
    expect(codes.has("missing_default_retry_policy")).toBe(true);
    expect(codes.has("missing_default_timeout_policy")).toBe(true);
    expect(codes.has("selector_needs_human_or_ai_repair")).toBe(true);
    expect(codes.has("recorded_parameter_suggestions_available")).toBe(true);
    expect(payload.plannedAutoFixes).toContain("default_stability_policy");
    expect(payload.plannedAutoFixes).toContain("parameterize_recorded_values");
    expect(persisted?.policy).toBeUndefined();
    expect((persisted?.nodes[0].config as { value?: string }).value).toBe(
      "alice@example.com",
    );
  });

  it("workflowRepairTool applies safe parameterization and default stability policy", async () => {
    const flowId = `workflow-repair-apply-${Date.now()}`;
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
              target: { selector: "#email" },
              value: "alice@example.com",
            },
          },
          {
            id: "wait-1" as any,
            kind: "wait",
            config: { condition: { kind: "selector", selector: "#results" } },
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

    const result = await workflowRepairTool.execute({
      flowId,
      apply: true,
    });
    const payload = parseToolPayload(result);
    const updated = await createStoragePort().flows.get(flowId as any);
    const remainingCodes = new Set(
      payload.recommendations.map(
        (recommendation: { code: string }) => recommendation.code,
      ),
    );
    const beforeApplyCodes = new Set(
      payload.recommendationsBeforeApply.map(
        (recommendation: { code: string }) => recommendation.code,
      ),
    );

    expect(payload).toMatchObject({
      success: true,
      flowId,
      applied: true,
      updated: true,
      parameterization: {
        changed: true,
        applied: 2,
        variablesAdded: 2,
      },
    });
    expect(payload.changes.map((change: { code: string }) => change.code)).toEqual(
      expect.arrayContaining([
        "parameter_suggestions_applied",
        "default_timeout_added",
        "default_retry_added",
        "failure_screenshot_added",
      ]),
    );
    expect(beforeApplyCodes.has("missing_default_retry_policy")).toBe(true);
    expect(beforeApplyCodes.has("missing_default_timeout_policy")).toBe(true);
    expect(beforeApplyCodes.has("recorded_parameter_suggestions_available")).toBe(true);
    expect(remainingCodes.has("missing_default_retry_policy")).toBe(false);
    expect(remainingCodes.has("missing_default_timeout_policy")).toBe(false);
    expect(remainingCodes.has("recorded_parameter_suggestions_available")).toBe(false);
    expect(payload.plannedAutoFixes).toEqual([]);
    expect(
      (
        updated?.nodes.find((node) => node.id === "nav-1")?.config as {
          url?: string;
        }
      )?.url,
    ).toBe("https://example.com/search?q={q}");
    expect(
      (
        updated?.nodes.find((node) => node.id === "fill-1")?.config as {
          value?: string;
        }
      )?.value,
    ).toBe("{email}");
    expect(updated?.policy?.defaultNodePolicy?.timeout).toEqual({
      ms: 15000,
      scope: "attempt",
    });
    expect(updated?.policy?.defaultNodePolicy?.retry).toBeUndefined();
    expect(updated?.nodes.find((node) => node.id === "wait-1")?.policy?.retry).toMatchObject({
      retries: 1,
      intervalMs: 500,
      backoff: "linear",
      maxIntervalMs: 2000,
      jitter: "full",
    });
    expect(updated?.policy?.defaultNodePolicy?.artifacts).toEqual({
      screenshot: "onFailure",
    });
  });

  it("workflowRepairTool marks inferred sensitive parameter variables", async () => {
    const flowId = `workflow-repair-sensitive-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(
        flowId,
        [
          {
            id: "fill-1" as any,
            kind: "fill",
            config: {
              target: { selector: "#token" },
              value: "secret-token",
            },
          },
        ],
        {
          meta: {
            recording: {
              parameterSuggestions: [
                {
                  nodeId: "fill-1" as any,
                  kind: "fill",
                  suggestedKey: "apiToken",
                  currentValue: "secret-token",
                },
              ],
            },
          },
        },
      ),
    );

    const result = await workflowRepairTool.execute({
      flowId,
      apply: true,
    });
    const payload = parseToolPayload(result);
    const updated = await createStoragePort().flows.get(flowId as any);

    expect(payload.updated).toBe(true);
    expect(updated?.variables).toContainEqual({
      name: "apiToken",
      label: "apiToken",
      default: "secret-token",
      scope: "flow",
      sensitive: true,
    });
  });

  it("workflowRepairTool skips stale recorded parameter suggestions", async () => {
    const flowId = `workflow-repair-stale-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(
        flowId,
        [
          {
            id: "fill-1" as any,
            kind: "fill",
            config: {
              target: { selector: "#email" },
              value: "bob@example.com",
            },
          },
        ],
        {
          meta: {
            recording: {
              parameterSuggestions: [
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

    const result = await workflowRepairTool.execute({
      flowId,
      apply: true,
      applyDefaultStabilityPolicy: false,
    });
    const payload = parseToolPayload(result);
    const updated = await createStoragePort().flows.get(flowId as any);

    expect(payload.updated).toBe(false);
    expect(payload.plannedAutoFixes).not.toContain("parameterize_recorded_values");
    expect(updated?.variables).toEqual([]);
    expect((updated?.nodes[0].config as { value?: string }).value).toBe("bob@example.com");
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

  it("flowUpdateTool preserves typed variable metadata before saving", async () => {
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
          type: "string",
          rules: { required: true },
          scope: "flow",
        },
        {
          name: "attempts",
          kind: "number",
          required: true,
        },
        {
          key: "plan",
          type: "enum",
          rules: { enum: ["free", "pro"] },
        },
        {
          name: "scores",
          kind: "array",
          item: "number",
        },
        {
          name: "payload",
          kind: "json",
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
        variableCount: 5,
      },
    });
    expect(updated?.variables).toEqual([
      {
        name: "email",
        label: "Email",
        default: "alice@example.com",
        kind: "string",
        required: true,
        scope: "flow",
      },
      {
        name: "attempts",
        kind: "number",
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
      {
        name: "payload",
        kind: "json",
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
      execution: {
        disallowLocalFileUploads: true,
        disallowLocalFilePages: true,
        redactDownloadPaths: true,
      },
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
        execution: {
          disallowLocalFileUploads: true,
          disallowLocalFilePages: true,
          redactDownloadPaths: true,
        },
      }),
    );
  });

  it("flowRunTool rejects non-http startUrl values", async () => {
    const flowId = `flow-run-file-start-${Date.now()}`;
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

    const result = await flowRunTool.execute({
      flowId,
      startUrl: "file:///tmp/secret.txt",
    });

    expect(result.isError).toBe(true);
    expect(String((result.content[0] as { text?: string })?.text)).toContain(
      "Only http:// and https:// URLs are allowed for startUrl",
    );
    expect(mocks.enqueueRunAndWait).not.toHaveBeenCalled();
  });

  it("flowRunTool marks failed runs as MCP errors", async () => {
    const flowId = `flow-run-failed-${Date.now()}`;
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
      run: { id: "run-toolchain-failed" } as any,
      events: [],
      result: {
        runId: "run-toolchain-failed",
        success: false,
        summary: { total: 1, success: 0, failed: 1, tookMs: 4 },
        outputs: null,
        logs: [{ stepId: "fill-1", status: "failed", message: "Upload blocked" }],
        paused: false,
      },
    });

    const result = await flowRunTool.execute({
      flowId,
      args: { email: "alice@example.com" },
    });

    expect(result.isError).toBe(true);
    expect(parseToolPayload(result)).toMatchObject({
      runId: "run-toolchain-failed",
      success: false,
      summary: { total: 1, success: 0, failed: 1, tookMs: 4 },
    });
  });

  it("workflowDescribeTool returns schema, example args, background, and side-effect metadata", async () => {
    const flowId = `workflow-describe-${Date.now()}`;
    await createStoragePort().flows.save({
      schemaVersion: 3,
      id: flowId as any,
      name: "Described Flow",
      entryNodeId: "wait-1" as any,
      nodes: [
        {
          id: "wait-1" as any,
          kind: "wait",
          config: { ms: 100 },
        },
        {
          id: "click-1" as any,
          kind: "click",
          config: { target: { selector: "#submit" } },
        },
      ],
      edges: [{ id: "edge-1" as any, from: "wait-1" as any, to: "click-1" as any }],
      variables: [
        {
          name: "email",
          kind: "string",
          required: true,
        },
        {
          name: "apiToken",
          default: "secret-token",
        },
      ] as any,
      createdAt: new Date(0).toISOString() as any,
      updatedAt: new Date(0).toISOString() as any,
      meta: {
        tool: {
          published: true,
          slug: "describe-flow",
          description: "Describe me",
        },
        exposedOutputs: [{ nodeId: "wait-1" as any, as: "ready" }],
      },
    });

    const result = await workflowDescribeTool.execute({ workflow: "describe-flow" });
    const payload = parseToolPayload(result);

    expect(payload).toMatchObject({
      success: true,
      flowId,
      workflow: "describe-flow",
      name: "Described Flow",
      description: "Describe me",
      runTool: "record_replay_flow_run",
      runArgs: {
        flowId,
        args: {
          email: "<email>",
          apiToken: "<apiToken>",
        },
        tabTarget: "current",
        background: true,
      },
      descriptor: {
        parameters: {
          type: "object",
          required: ["email"],
          additionalProperties: false,
          properties: {
            email: expect.objectContaining({ type: "string" }),
            apiToken: expect.not.objectContaining({ default: "secret-token" }),
          },
        },
        exampleArgs: {
          email: "<email>",
          apiToken: "<apiToken>",
        },
        backgroundSupport: {
          supported: true,
          modes: ["currentTab", "newTab", "background"],
          caveats: [],
        },
        sideEffects: {
          summary: {
            safe: 1,
            idempotent: 0,
            dangerous: 1,
            unknown: 0,
          },
        },
        outputs: [{ nodeId: "wait-1", as: "ready" }],
      },
    });
    expect(payload.descriptor.sideEffects.nodes).toEqual([
      expect.objectContaining({
        id: "wait-1",
        kind: "wait",
        sideEffect: expect.objectContaining({ category: "safe" }),
      }),
      expect.objectContaining({
        id: "click-1",
        kind: "click",
        sideEffect: expect.objectContaining({ category: "dangerous" }),
      }),
    ]);
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
        { name: "apiToken", default: "secret-token" } as any,
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
          parameters: expect.objectContaining({
            properties: expect.objectContaining({
              target_url: expect.objectContaining({
                type: "string",
                default: "https://example.com",
              }),
              apiToken: expect.not.objectContaining({ default: "secret-token" }),
            }),
          }),
          exampleArgs: {
            target_url: "https://example.com",
            apiToken: "<apiToken>",
          },
          backgroundSupport: {
            supported: true,
            modes: ["currentTab", "newTab", "background"],
            caveats: [],
          },
          sideEffects: expect.objectContaining({
            summary: {
              safe: 0,
              idempotent: 1,
              dangerous: 0,
              unknown: 0,
            },
          }),
        }),
      ],
    });
  });
});
