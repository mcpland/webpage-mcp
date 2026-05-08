import { beforeEach, describe, expect, it, vi } from "vitest";

import { createStoragePort } from "@/entrypoints/background/record-replay-v3";
import {
  RUN_SCHEMA_VERSION,
  type RunRecordV3,
} from "@/entrypoints/background/record-replay-v3/domain/events";
import type { FlowV3 } from "@/entrypoints/background/record-replay-v3/domain/flow";
import { calculateWorkflowRevision } from "@/entrypoints/background/record-replay-v3/flows/publish";
import { WORKFLOW_SECRET_STORE_KEY } from "@/entrypoints/background/record-replay-v3/secrets";
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
  workflowStabilizeTool,
} from "@/entrypoints/background/tools/flow-tools";
import {
  flowRunTool,
  listPublishedFlowsTool,
  workflowPublishTool,
  workflowUnpublishTool,
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

  it("flowAnalyzeTool marks trigger nodes non-executable without side effects", async () => {
    const flowId = `flow-analyze-trigger-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(flowId, [
        {
          id: "trigger-1" as any,
          kind: "trigger",
          config: { enabled: true },
        },
        {
          id: "wait-1" as any,
          kind: "wait",
          config: { ms: 100 },
        },
      ]),
    );

    const result = await flowAnalyzeTool.execute({ flowId });
    const payload = parseToolPayload(result);
    const triggerNode = payload.flow.nodes.find(
      (node: { id: string }) => node.id === "trigger-1",
    );
    const waitNode = payload.flow.nodes.find(
      (node: { id: string }) => node.id === "wait-1",
    );

    expect(triggerNode).toMatchObject({
      id: "trigger-1",
      kind: "trigger",
      executable: false,
    });
    expect(triggerNode).not.toHaveProperty("sideEffect");
    expect(waitNode.sideEffect).toMatchObject({
      category: "safe",
      retry: "default",
    });
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
      capabilityStatus: {
        screenshots: "partial",
        navigationEvents: "partial",
        networkEvents: "none",
        mutationEvents: "none",
        selectorResolution: "partial",
      },
    });
    expect(payload.capabilities).toMatchObject({
      domSnapshot: "none",
      accessibilitySnapshot: "none",
      downloads: "unknown",
      mfa: "unknown",
      captcha: "unknown",
      unsupportedReasons: expect.arrayContaining([
        expect.stringContaining("persisted observations only"),
      ]),
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

  it("workflowDebugViewTool marks trigger nodes non-executable without side effects", async () => {
    const flowId = `workflow-debug-trigger-${Date.now()}`;
    const flow = createFlow(
      flowId,
      [
        {
          id: "trigger-1" as any,
          kind: "trigger",
          config: { enabled: true },
        },
        {
          id: "wait-1" as any,
          kind: "wait",
          config: { ms: 100 },
        },
      ],
      {
        meta: {
          tool: {
            published: true,
            slug: "debug-trigger-flow",
          },
        },
      },
    );
    await createStoragePort().flows.save(flow);

    const result = await workflowDebugViewTool.execute({
      workflow: "debug-trigger-flow",
      includeRuns: false,
    });
    const payload = parseToolPayload(result);
    const triggerNode = payload.workflow.nodes.find(
      (node: { id: string }) => node.id === "trigger-1",
    );
    const waitNode = payload.workflow.nodes.find(
      (node: { id: string }) => node.id === "wait-1",
    );

    expect(triggerNode).toMatchObject({
      id: "trigger-1",
      kind: "trigger",
      executable: false,
      config: { enabled: true },
    });
    expect(triggerNode).not.toHaveProperty("sideEffect");
    expect(waitNode.sideEffect).toMatchObject({
      category: "safe",
      retry: "default",
    });
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
    await storage.events.append({
      runId: runId as any,
      type: "network.observed",
      nodeId: "fill-1" as any,
      requestId: "req-1",
      url: "https://example.com/api?token=secret-token",
      resourceType: "fetch",
      currentFrame: true,
      startedAt: 1_000,
      endedAt: 1_200,
      status: 200,
      frameId: 0,
      method: "GET",
    });
    await storage.events.append({
      runId: runId as any,
      type: "selector.resolution",
      nodeId: "fill-1" as any,
      primarySelector: "#email",
      resolvedBy: "primary",
      matchCount: 0,
      fingerprint: { status: "missing" },
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
    const networkEvent = payload.runs[0].events.find(
      (event: { type: string }) => event.type === "network.observed",
    );
    const selectorEvent = payload.runs[0].events.find(
      (event: { type: string }) => event.type === "selector.resolution",
    );

    expect(payload.summary.runCount).toBe(1);
    expect(payload.summary.capabilityStatus).toMatchObject({
      navigationEvents: "partial",
      networkEvents: "none",
      selectorResolution: "partial",
    });
    expect(payload.metrics).toMatchObject({
      workflowRun: {
        totalCount: 1,
        successCount: 0,
        failureCount: 1,
        successRate: 0,
      },
      artifactRedaction: {
        lowConfidenceCount: 1,
      },
      quality: {
        staleQualityCount: 1,
      },
    });
    expect(payload.artifactPolicy).toMatchObject({
      contentTrust: "untrusted",
      dataInline: "explicit_request_only_and_blocked_when_redaction_is_low_confidence",
      cleanup: { requested: false },
    });
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
          dataBase64Omitted: "redaction_low_confidence",
          ttlMs: 7 * 24 * 60 * 60 * 1000,
          untrusted: true,
          provenance: {
            source: "runtimeCapture",
            trust: "untrusted",
          },
          redaction: {
            status: "lowConfidence",
            confidence: "low",
            warnings: [
              "Screenshot pixel content has low-confidence redaction; binary data is not inlined in MCP debug responses.",
            ],
          },
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
    expect(payload.runs[0].artifacts[0]).not.toHaveProperty("dataBase64");
    expect(networkEvent).toMatchObject({
      type: "network.observed",
      nodeId: "fill-1",
      requestId: "req-1",
      url: "https://example.com/api?token=<redacted>",
      resourceType: "fetch",
      currentFrame: true,
      startedAt: 1000,
      endedAt: 1200,
      status: 200,
      frameId: 0,
      method: "GET",
    });
    expect(selectorEvent).toMatchObject({
      type: "selector.resolution",
      nodeId: "fill-1",
      primarySelector: "#email",
      resolvedBy: "primary",
      matchCount: 0,
      fingerprint: { status: "missing" },
    });
  });

  it("workflowDebugViewTool filters debug output and cleans run artifacts", async () => {
    const flowId = `workflow-debug-filter-${Date.now()}`;
    const runId = `${flowId}-run`;
    const storage = createStoragePort();
    await storage.flows.save(
      createFlow(flowId, [
        {
          id: "fill-1" as any,
          kind: "fill",
          config: { target: { selector: "#email" }, value: "{email}" },
        },
        {
          id: "click-1" as any,
          kind: "click",
          config: { target: { selector: "#submit" } },
        },
      ]),
    );
    await storage.runs.save({
      id: runId as any,
      flowId: flowId as any,
      schemaVersion: RUN_SCHEMA_VERSION,
      status: "failed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempt: 1,
      maxAttempts: 1,
      currentNodeId: "click-1" as any,
      nextSeq: 10,
    } as RunRecordV3);
    await storage.events.append({
      runId: runId as any,
      type: "node.failed",
      nodeId: "fill-1" as any,
      attempt: 1,
      error: { code: "TARGET_NOT_FOUND", message: "Missing input" },
      decision: "stop",
    });
    const fillArtifact = await storage.artifacts.saveScreenshot({
      runId: runId as any,
      nodeId: "fill-1" as any,
      base64: "ZmlsbA==",
    });
    await storage.events.append({
      runId: runId as any,
      type: "artifact.screenshot",
      nodeId: "fill-1" as any,
      artifactId: fillArtifact.id,
      savedAs: fillArtifact.filename,
    });
    await storage.events.append({
      runId: runId as any,
      type: "node.failed",
      nodeId: "click-1" as any,
      attempt: 1,
      error: { code: "TARGET_NOT_FOUND", message: "Missing button" },
      decision: "stop",
    });
    const clickArtifact = await storage.artifacts.saveScreenshot({
      runId: runId as any,
      nodeId: "click-1" as any,
      base64: "Y2xpY2s=",
    });
    await storage.events.append({
      runId: runId as any,
      type: "artifact.screenshot",
      nodeId: "click-1" as any,
      artifactId: clickArtifact.id,
      savedAs: clickArtifact.filename,
    });

    const result = await workflowDebugViewTool.execute({
      flowId,
      runId,
      nodeId: "click-1",
      maxEvents: 10,
      cleanupArtifacts: true,
    });
    const payload = parseToolPayload(result);

    expect(payload.artifactPolicy.cleanup).toEqual({
      requested: true,
      scope: "run",
      runId,
      deleted: 2,
    });
    expect(payload.runs[0].events.map((event: { nodeId?: string }) => event.nodeId)).toEqual([
      "click-1",
      "click-1",
    ]);
    expect(payload.runs[0].artifacts).toEqual([
      expect.objectContaining({
        id: clickArtifact.id,
        nodeId: "click-1",
        missing: true,
        unavailableReason: "expired_or_cleaned",
        dataBase64Omitted: "artifact_missing",
        untrusted: true,
      }),
    ]);
    expect(await storage.artifacts.listByRun(runId as any)).toEqual([]);
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

  it("workflowRepairTool suggests selector replacement without applying when failure artifacts are missing", async () => {
    const flowId = `workflow-repair-selector-suggest-${Date.now()}`;
    const runId = `${flowId}-run`;
    const oldSelector = "body > main > form:nth-of-type(1) input:nth-of-type(1)";
    const stableSelector = '[data-testid="email-input"]';
    const storage = createStoragePort();
    await storage.flows.save(
      createFlow(flowId, [
        {
          id: "fill-1" as any,
          kind: "fill",
          config: {
            target: {
              selector: oldSelector,
              fingerprint: "input|id=email|name=email",
              domPath: [0, 1, 0],
              shadowHostChain: [],
              candidates: [
                { type: "css", selector: oldSelector, value: oldSelector },
                {
                  type: "attr",
                  selector: stableSelector,
                  value: stableSelector,
                  unique: true,
                  stability: {
                    score: 0.96,
                    signals: { usesTestId: true, usesAttributes: true },
                  },
                },
              ],
            },
            value: "{email}",
          },
        },
      ]),
    );
    await storage.runs.save({
      schemaVersion: RUN_SCHEMA_VERSION,
      id: runId as any,
      flowId: flowId as any,
      status: "failed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      currentNodeId: "fill-1" as any,
      attempt: 1,
      maxAttempts: 1,
      error: { code: "TARGET_NOT_FOUND", message: "Missing input" },
      nextSeq: 1,
    } as RunRecordV3);
    await storage.events.append({
      runId: runId as any,
      type: "node.failed",
      nodeId: "fill-1" as any,
      attempt: 1,
      error: { code: "TARGET_NOT_FOUND", message: "Missing input" },
      decision: "stop",
    });
    await storage.events.append({
      runId: runId as any,
      type: "selector.resolution",
      nodeId: "fill-1" as any,
      primarySelector: oldSelector,
      resolvedBy: "candidate",
      candidateIndex: 1,
      matchCount: 1,
      fingerprint: { status: "matched", score: 0.94 },
    });

    const result = await workflowRepairTool.execute({
      flowId,
      apply: true,
      applyDefaultStabilityPolicy: false,
      applyParameterSuggestions: false,
    });
    const payload = parseToolPayload(result);
    const updated = await storage.flows.get(flowId as any);

    expect(payload.updated).toBe(false);
    expect(payload.selectorRepairsBeforeApply).toEqual([
      expect.objectContaining({
        op: "replaceTarget",
        nodeId: "fill-1",
        status: "suggestion",
        beforeSelector: oldSelector,
        afterSelector: stableSelector,
        selectorUnique: true,
        reason: expect.stringContaining("no failure artifact"),
      }),
    ]);
    expect((updated?.nodes[0].config as any).target.selector).toBe(oldSelector);
  });

  it("workflowRepairTool suggests assertion checkpoints from successful visibility observations", async () => {
    const flowId = `workflow-repair-assert-suggest-${Date.now()}`;
    const runId = `${flowId}-run`;
    const storage = createStoragePort();
    await storage.flows.save(
      createFlow(flowId, [
        {
          id: "wait-1" as any,
          kind: "wait",
          config: { condition: { kind: "selector", selector: "#done" } },
        },
      ]),
    );
    await storage.runs.save({
      schemaVersion: RUN_SCHEMA_VERSION,
      id: runId as any,
      flowId: flowId as any,
      status: "succeeded",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempt: 1,
      maxAttempts: 1,
      nextSeq: 1,
    } as RunRecordV3);
    await storage.events.append({
      runId: runId as any,
      type: "dom.visibility",
      nodeId: "wait-1" as any,
      selector: "#done",
      matchCount: 1,
      status: "stable",
      stableForMs: 800,
    });

    const result = await workflowRepairTool.execute({ flowId });
    const payload = parseToolPayload(result);

    expect(payload.assertionRepairs).toEqual([
      expect.objectContaining({
        op: "addAssertAfter",
        status: "suggestion",
        nodeId: "wait-1",
        assertion: { kind: "visible", selector: "#done" },
      }),
    ]);
    expect(payload.recommendations.map((item: { code: string }) => item.code)).toContain(
      "assertion_checkpoint_suggestion",
    );
  });

  it("workflowRepairTool scopes flow-level onError retry to safe nodes", async () => {
    const flowId = `workflow-repair-onerror-retry-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(
        flowId,
        [
          {
            id: "wait-1" as any,
            kind: "wait",
            config: { condition: { kind: "selector", selector: "#ready" } },
          },
          {
            id: "click-1" as any,
            kind: "click",
            config: { target: { selector: "#purchase" } },
          },
        ],
        {
          policy: {
            defaultNodePolicy: {
              onError: {
                kind: "retry",
                override: {
                  retries: 3,
                  intervalMs: 75 as any,
                },
              },
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
    const beforeApplyCodes = new Set(
      payload.recommendationsBeforeApply.map(
        (recommendation: { code: string }) => recommendation.code,
      ),
    );
    const remainingCodes = new Set(
      payload.recommendations.map(
        (recommendation: { code: string }) => recommendation.code,
      ),
    );
    const waitNode = updated?.nodes.find((node) => node.id === "wait-1");
    const clickNode = updated?.nodes.find((node) => node.id === "click-1");

    expect(payload).toMatchObject({
      success: true,
      flowId,
      applied: true,
      updated: true,
    });
    expect(payload.changes.map((change: { code: string }) => change.code)).toEqual(
      expect.arrayContaining([
        "global_retry_scoped_to_safe_nodes",
        "default_retry_added",
      ]),
    );
    expect(beforeApplyCodes.has("global_retry_policy_has_side_effect_risk")).toBe(true);
    expect(remainingCodes.has("global_retry_policy_has_side_effect_risk")).toBe(false);
    expect(updated?.policy?.defaultNodePolicy?.retry).toBeUndefined();
    expect(updated?.policy?.defaultNodePolicy?.onError).toBeUndefined();
    expect(waitNode?.policy?.retry).toMatchObject({
      retries: 3,
      intervalMs: 75,
      backoff: "linear",
      maxIntervalMs: 2000,
      jitter: "full",
    });
    expect(clickNode?.policy?.retry).toBeUndefined();
  });

  it("workflowRepairTool does not add automatic retry to JavaScript extract nodes", async () => {
    const flowId = `workflow-repair-js-extract-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(
        flowId,
        [
          {
            id: "extract-1" as any,
            kind: "extract",
            config: {
              mode: "js",
              code: "localStorage.setItem('submit', 'again'); return document.title;",
              saveAs: "title",
            },
          },
        ],
      ),
    );

    const result = await workflowRepairTool.execute({
      flowId,
      apply: true,
    });
    const payload = parseToolPayload(result);
    const updated = await createStoragePort().flows.get(flowId as any);
    const extractNode = updated?.nodes.find((node) => node.id === "extract-1");
    const changeCodes = payload.changes.map((change: { code: string }) => change.code);
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
    });
    expect(beforeApplyCodes.has("missing_default_retry_policy")).toBe(false);
    expect(changeCodes).not.toContain("default_retry_added");
    expect(extractNode?.policy?.retry).toBeUndefined();
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

  it("workflowStabilizeTool validates safe workflows and records quality when apply is false", async () => {
    const flowId = `workflow-stabilize-safe-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(flowId, [
        {
          id: "wait-1" as any,
          kind: "wait",
          config: { condition: { kind: "selector", selector: "#ready" } },
        },
      ]),
    );
    let runCall = 0;
    mocks.enqueueRunAndWait.mockImplementation(async () => {
      runCall += 1;
      return {
        run: {
          id: `run-stabilize-safe-${runCall}`,
          flowId,
          status: "succeeded",
          tookMs: 5,
        } as any,
        events: [],
        result: {
          runId: `run-stabilize-safe-${runCall}`,
          success: true,
          status: "succeeded",
          summary: { total: 1, success: 1, failed: 0, tookMs: 5 },
          outputs: null,
          eventSummary: { totalEvents: 0, nodeEvents: 0, artifactEvents: 0 },
        },
      };
    });

    const result = await workflowStabilizeTool.execute({
      flowId,
      iterations: 3,
      minPassRate: 1,
      apply: false,
    });
    const payload = parseToolPayload(result);
    const updated = await createStoragePort().flows.get(flowId as any);

    expect(result.isError).toBe(false);
    expect(payload).toMatchObject({
      success: true,
      flowId,
      applied: false,
      stable: true,
      score: {
        passRate: 1,
        iterations: 3,
      },
      safety: {
        risk: "safe",
        executionMode: "auto",
        executedIterations: 3,
      },
    });
    expect(mocks.enqueueRunAndWait).toHaveBeenCalledTimes(3);
    expect(payload.baselineRuns).toHaveLength(3);
    expect(payload.quality).toMatchObject({
      level: "stable",
      current: true,
      passRate: 1,
      countedValidationRuns: 3,
      verification: {
        oracle: "none",
        oracleStrength: "weak",
      },
    });
    expect(updated?.meta?.quality).toMatchObject({
      level: "stable",
      revision: expect.stringMatching(/^rev-fnv1a32-/),
      passRate: 1,
      validationRuns: 3,
      countedValidationRuns: 3,
      validationContext: {
        argsHash: expect.stringMatching(/^hmac-sha256:/),
        argsHashAlgorithm: "hmac-sha256",
        executionMode: "auto",
      },
      validationRecords: [
        expect.objectContaining({
          tool: "workflow_stabilize",
          countedRuns: 3,
          passedRuns: 3,
        }),
      ],
    });
    expect(payload.recommendations.map((item: { code: string }) => item.code)).toContain(
      "missing_default_timeout_policy",
    );
    expect(payload.capabilities.unsupportedReasons[0]).toContain("stabilize MVP");
    expect(payload.capabilities).toMatchObject({
      domSnapshot: "none",
      accessibilitySnapshot: "none",
      navigationEvents: "partial",
      networkEvents: "none",
      mutationEvents: "none",
      selectorResolution: "partial",
      screenshots: "partial",
      downloads: "unknown",
      mfa: "unknown",
      captcha: "unknown",
    });
    expect(updated?.updatedAt).not.toBe(new Date(0).toISOString());
  });

  it("workflowStabilizeTool runs reset workflow before validation without scoring reset runs", async () => {
    const flowId = `workflow-stabilize-reset-${Date.now()}`;
    const resetFlowId = `workflow-reset-${Date.now()}`;
    const resetFlow = createFlow(
      resetFlowId,
      [
        {
          id: "reset-wait" as any,
          kind: "wait",
          config: { condition: { kind: "selector", selector: "#reset-ready" } },
        },
      ],
      {
        variables: [{ name: "session", kind: "string", required: true }],
        meta: {
          tool: {
            published: true,
            slug: "reset-session",
          },
        },
      },
    );
    resetFlow.meta = {
      ...(resetFlow.meta ?? {}),
      quality: {
        revision: calculateWorkflowRevision(resetFlow),
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
    await createStoragePort().flows.save(resetFlow);
    await createStoragePort().flows.save(
      createFlow(flowId, [
        {
          id: "target-wait" as any,
          kind: "wait",
          config: { condition: { kind: "selector", selector: "#ready" } },
        },
      ]),
    );

    const flowIds: string[] = [];
    mocks.enqueueRunAndWait.mockImplementation(async (input: { flowId: string; args?: unknown }) => {
      flowIds.push(input.flowId);
      const runId = `${input.flowId === resetFlowId ? "reset" : "target"}-${flowIds.length}`;
      return {
        run: {
          id: runId,
          flowId: input.flowId,
          status: "succeeded",
          tookMs: 5,
        } as any,
        events: [],
        result: {
          runId,
          success: true,
          status: "succeeded",
          summary: { total: 1, success: 1, failed: 0, tookMs: 5 },
          outputs: null,
          eventSummary: { totalEvents: 0, nodeEvents: 0, artifactEvents: 0 },
        },
      };
    });

    const result = await workflowStabilizeTool.execute({
      flowId,
      iterations: 2,
      minPassRate: 1,
      apply: false,
      safety: {
        reset: {
          workflow: "reset-session",
          args: { session: "fresh" },
          requireStable: true,
        },
      },
    });
    const payload = parseToolPayload(result);
    const updated = await createStoragePort().flows.get(flowId as any);

    expect(result.isError).toBe(false);
    expect(flowIds).toEqual([resetFlowId, flowId, resetFlowId, flowId]);
    expect(mocks.enqueueRunAndWait).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        flowId: resetFlowId,
        args: { session: "fresh" },
      }),
    );
    expect(payload).toMatchObject({
      stable: true,
      reset: {
        requested: true,
        workflow: "reset-session",
        flowId: resetFlowId,
        requireStable: true,
        runCount: 2,
        failed: false,
      },
      summary: {
        resetRunCount: 2,
        baselineRunCount: 2,
      },
      score: {
        passRate: 1,
        iterations: 2,
      },
    });
    expect(payload.resetRuns).toHaveLength(2);
    expect(payload.baselineRuns).toHaveLength(2);
    expect(updated?.meta?.quality).toMatchObject({
      validationRuns: 2,
      countedValidationRuns: 2,
      passedRuns: 2,
      failedRuns: 0,
    });
  });

  it("workflowStabilizeTool reports reset failures separately from target passRate", async () => {
    const flowId = `workflow-stabilize-reset-fail-${Date.now()}`;
    const resetFlowId = `workflow-reset-fail-${Date.now()}`;
    const resetFlow = createFlow(
      resetFlowId,
      [
        {
          id: "reset-wait" as any,
          kind: "wait",
          config: { condition: { kind: "selector", selector: "#reset-ready" } },
        },
      ],
      {
        meta: {
          tool: {
            published: true,
            slug: "reset-failing-session",
          },
        },
      },
    );
    resetFlow.meta = {
      ...(resetFlow.meta ?? {}),
      quality: {
        revision: calculateWorkflowRevision(resetFlow),
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
    await createStoragePort().flows.save(resetFlow);
    await createStoragePort().flows.save(
      createFlow(flowId, [
        {
          id: "target-wait" as any,
          kind: "wait",
          config: { condition: { kind: "selector", selector: "#ready" } },
        },
      ]),
    );

    mocks.enqueueRunAndWait.mockImplementation(async (input: { flowId: string }) => {
      expect(input.flowId).toBe(resetFlowId);
      return {
        run: {
          id: "reset-failed-run",
          flowId: resetFlowId,
          status: "failed",
          currentNodeId: "reset-wait",
          tookMs: 5,
        } as any,
        events: [],
        result: {
          runId: "reset-failed-run",
          success: false,
          status: "failed",
          currentNodeId: "reset-wait",
          failedNodeId: "reset-wait",
          errorCode: "TIMEOUT",
          error: {
            code: "TIMEOUT",
            category: "runtime",
            retryable: true,
            message: "Reset timed out",
            nodeId: "reset-wait",
          },
          summary: { total: 1, success: 0, failed: 1, tookMs: 5 },
          outputs: null,
          eventSummary: { totalEvents: 0, nodeEvents: 0, artifactEvents: 0 },
        },
      };
    });

    const result = await workflowStabilizeTool.execute({
      flowId,
      iterations: 2,
      apply: false,
      safety: {
        resetWorkflow: "reset-failing-session",
      },
    });
    const payload = parseToolPayload(result);
    const updated = await createStoragePort().flows.get(flowId as any);

    expect(result.isError).toBe(false);
    expect(mocks.enqueueRunAndWait).toHaveBeenCalledTimes(1);
    expect(payload).toMatchObject({
      stable: false,
      reset: {
        requested: true,
        workflow: "reset-failing-session",
        flowId: resetFlowId,
        runCount: 1,
        failed: true,
      },
      summary: {
        resetRunCount: 1,
        baselineRunCount: 0,
      },
      score: {
        iterations: 0,
        passedRuns: 0,
        failedRuns: 0,
      },
    });
    expect(payload.resetRuns).toEqual([
      expect.objectContaining({
        phase: "reset",
        success: false,
        errorCode: "TIMEOUT",
      }),
    ]);
    expect(payload.warnings.map((warning: { code: string }) => warning.code)).toContain(
      "STABILIZE_RESET_FAILED",
    );
    expect(updated?.meta?.quality).toBeUndefined();
  });

  it("workflowStabilizeTool blocks validation outside the declared test environment", async () => {
    const flowId = `workflow-stabilize-boundary-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(flowId, [
        {
          id: "wait-1" as any,
          kind: "wait",
          config: { condition: { kind: "selector", selector: "#ready" } },
        },
      ]),
    );

    const result = await workflowStabilizeTool.execute({
      flowId,
      iterations: 2,
      startUrl: "https://prod.example.com/dashboard",
      safety: {
        executionMode: "sandboxReplay",
        allowedHosts: ["staging.example.com"],
        testEnvironment: {
          name: "staging",
          origins: ["https://staging.example.com"],
          pathPrefixes: ["/app"],
        },
      },
    });
    const payload = parseToolPayload(result);
    const updated = await createStoragePort().flows.get(flowId as any);

    expect(result.isError).toBe(false);
    expect(mocks.enqueueRunAndWait).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      stable: false,
      safety: {
        executionMode: "analyzeOnly",
        executedIterations: 0,
        blockedReason: expect.stringContaining("outside the declared safety boundary"),
      },
      summary: {
        baselineRunCount: 0,
        postRepairRunCount: 0,
      },
    });
    expect(payload.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "STABILIZE_TEST_ENVIRONMENT_BLOCKED",
          path: "/startUrl",
        }),
      ]),
    );
    expect(updated?.meta?.quality).toBeUndefined();
  });

  it("workflowStabilizeTool defaults dangerous workflows to analyze-only", async () => {
    const flowId = `workflow-stabilize-dangerous-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(flowId, [
        {
          id: "click-1" as any,
          kind: "click",
          config: { target: { candidates: [{ type: "css", value: "#buy" }] } },
        },
      ]),
    );

    const result = await workflowStabilizeTool.execute({
      flowId,
      iterations: 5,
      apply: true,
      safety: {
        executionMode: "auto",
        allowExternalSideEffects: true,
        maxDangerousRuns: 2,
      },
    });
    const payload = parseToolPayload(result);

    expect(result.isError).toBe(false);
    expect(payload).toMatchObject({
      success: true,
      applied: false,
      safety: {
        risk: "dangerous",
        executionMode: "analyzeOnly",
        executedIterations: 0,
        blockedReason: "dangerous workflow defaults to analyze-only",
      },
    });
    expect(payload.warnings.map((warning: { code: string }) => warning.code)).toEqual(
      expect.arrayContaining(["STABILIZE_REPLAY_BLOCKED", "STABILIZE_APPLY_SKIPPED"]),
    );
  });

  it("workflowStabilizeTool accepts trusted approval records from the local approval store", async () => {
    const flowId = `workflow-stabilize-approved-${Date.now()}`;
    const flow = createFlow(flowId, [
      {
        id: "click-1" as any,
        kind: "click",
        config: { target: { selector: "#submit" } },
      },
    ]);
    const revision = calculateWorkflowRevision(flow);
    await createStoragePort().flows.save(flow);
    asMock(chrome.storage.local.get).mockResolvedValue({
      webpageMcpWorkflowApprovals: {
        "approval-1": {
          approvedBy: "user",
          approvedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2999-01-01T00:00:00.000Z",
          scope: {
            flowId,
            revision,
          },
        },
      },
    });
    mocks.enqueueRunAndWait.mockResolvedValue({
      run: {
        id: "approved-dangerous-run",
        flowId,
        status: "succeeded",
        tookMs: 5,
      } as any,
      events: [],
      result: {
        runId: "approved-dangerous-run",
        success: true,
        status: "succeeded",
        summary: { total: 1, success: 1, failed: 0, tookMs: 5 },
        outputs: null,
        eventSummary: { totalEvents: 0, nodeEvents: 0, artifactEvents: 0 },
      },
    });

    const result = await workflowStabilizeTool.execute({
      flowId,
      iterations: 2,
      apply: false,
      safety: {
        executionMode: "userApprovedReplay",
        allowExternalSideEffects: true,
        maxDangerousRuns: 1,
        authorization: {
          approvalId: "approval-1",
        },
      },
    });
    const payload = parseToolPayload(result);
    const updated = await createStoragePort().flows.get(flowId as any);

    expect(result.isError).toBe(false);
    expect(mocks.enqueueRunAndWait).toHaveBeenCalledTimes(1);
    expect(payload).toMatchObject({
      stable: true,
      safety: {
        risk: "dangerous",
        executionMode: "userApprovedReplay",
        approvalReferenceAccepted: true,
        executedIterations: 1,
        approval: {
          approvalId: "approval-1",
          approvedBy: "user",
          scope: {
            flowId,
            revision,
          },
        },
      },
      metrics: {
        approval: {
          useCount: 1,
        },
      },
    });
    expect(updated?.meta?.audit?.events).toEqual([
      expect.objectContaining({
        kind: "approval_use",
        actor: "mcp",
        metadata: expect.objectContaining({
          approvalId: "approval-1",
          approvedBy: "user",
          scope: {
            flowId,
            revision,
          },
        }),
      }),
    ]);
  });

  it("workflowStabilizeTool rejects expired approval records before dangerous replay", async () => {
    const flowId = `workflow-stabilize-expired-approval-${Date.now()}`;
    const flow = createFlow(flowId, [
      {
        id: "click-1" as any,
        kind: "click",
        config: { target: { selector: "#submit" } },
      },
    ]);
    const revision = calculateWorkflowRevision(flow);
    await createStoragePort().flows.save(flow);
    asMock(chrome.storage.local.get).mockResolvedValue({
      webpageMcpWorkflowApprovals: {
        "approval-expired": {
          approvedBy: "user",
          approvedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2000-01-01T00:00:00.000Z",
          scope: {
            flowId,
            revision,
          },
        },
      },
    });

    const result = await workflowStabilizeTool.execute({
      flowId,
      iterations: 1,
      apply: true,
      safety: {
        executionMode: "userApprovedReplay",
        allowExternalSideEffects: true,
        maxDangerousRuns: 1,
        authorization: {
          approvalId: "approval-expired",
        },
      },
    });
    const payload = parseToolPayload(result);
    const updated = await createStoragePort().flows.get(flowId as any);

    expect(result.isError).toBe(false);
    expect(mocks.enqueueRunAndWait).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      applied: false,
      safety: {
        executionMode: "analyzeOnly",
        approvalReferenceAccepted: false,
        blockedReason: "external side effects require a trusted approval reference",
      },
    });
    expect(payload.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "STABILIZE_APPROVAL_REJECTED",
          message: "approval has expired",
        }),
        expect.objectContaining({
          code: "STABILIZE_REPLAY_BLOCKED",
        }),
      ]),
    );
    expect(updated?.meta?.audit?.events).toBeUndefined();
    expect(updated?.meta?.quality).toBeUndefined();
  });

  it("workflowStabilizeTool applies safe repairs and reruns validation", async () => {
    const flowId = `workflow-stabilize-apply-${Date.now()}`;
    const flow = createFlow(
      flowId,
      [
        {
          id: "fill-1" as any,
          kind: "fill",
          config: { target: { selector: "#email" }, value: "alice@example.com" },
        },
        {
          id: "wait-1" as any,
          kind: "wait",
          config: { condition: { kind: "selector", selector: "#ready" } },
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
    );
    await createStoragePort().flows.save(flow);

    let runCall = 0;
    mocks.enqueueRunAndWait.mockImplementation(async () => {
      runCall += 1;
      const success = runCall > 2;
      const runId = `run-stabilize-apply-${runCall}`;
      return {
        run: {
          id: runId,
          flowId,
          status: success ? "succeeded" : "failed",
          currentNodeId: "wait-1",
          tookMs: 5,
        } as any,
        events: [],
        result: {
          runId,
          success,
          status: success ? "succeeded" : "failed",
          currentNodeId: "wait-1",
          failedNodeId: success ? undefined : "wait-1",
          errorCode: success ? undefined : "TIMEOUT",
          error: success
            ? undefined
            : {
                code: "TIMEOUT",
                category: "runtime",
                retryable: true,
                message: "Timed out waiting for #ready",
                nodeId: "wait-1",
              },
          summary: { total: 2, success: success ? 2 : 1, failed: success ? 0 : 1, tookMs: 5 },
          outputs: null,
          eventSummary: { totalEvents: 0, nodeEvents: 0, artifactEvents: 0 },
          debug: success
            ? undefined
            : {
                debugArgs: {
                  runId,
                  flowId,
                  nodeId: "wait-1",
                  includeArtifacts: true,
                },
              },
        },
      };
    });

    const result = await workflowStabilizeTool.execute({
      flowId,
      iterations: 2,
      minPassRate: 1,
      apply: true,
    });
    const payload = parseToolPayload(result);
    const updated = await createStoragePort().flows.get(flowId as any);

    expect(result.isError).toBe(false);
    expect(mocks.enqueueRunAndWait).toHaveBeenCalledTimes(4);
    expect(payload).toMatchObject({
      success: true,
      applied: true,
      stable: true,
      baselineScore: { passRate: 0, passedRuns: 0, failedRuns: 2, iterations: 2 },
      postRepairScore: { passRate: 1, passedRuns: 2, failedRuns: 0, iterations: 2 },
      score: { passRate: 1, passedRuns: 2, failedRuns: 0, iterations: 2 },
      summary: {
        changeCount: 4,
        baselineRunCount: 2,
        postRepairRunCount: 2,
      },
    });
    expect(payload.metrics).toMatchObject({
      workflowRun: {
        totalCount: 4,
        successCount: 2,
        failureCount: 2,
        successRate: 0.5,
      },
      repair: {
        applyCount: 4,
        falseRepairCount: 0,
      },
      quality: {
        staleQualityCount: 0,
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
    expect(payload.baselineRuns.every((run: { phase: string }) => run.phase === "baseline")).toBe(true);
    expect(payload.postRepairRuns.every((run: { phase: string }) => run.phase === "postRepair")).toBe(true);
    expect((updated?.nodes[0].config as { value?: string }).value).toBe("{email}");
    expect(updated?.policy?.defaultNodePolicy?.timeout).toEqual({
      ms: 15000,
      scope: "attempt",
    });
    expect(updated?.policy?.defaultNodePolicy?.artifacts).toEqual({
      screenshot: "onFailure",
    });
    expect(updated?.meta?.repairs?.history?.[0]).toMatchObject({
      repairRevision: expect.stringMatching(/^repair-/),
      baseRevision: expect.stringMatching(/^rev-fnv1a32-/),
      provenance: {
        source: "workflow_stabilize",
        pageContentUsed: false,
      },
    });
    expect(updated?.meta?.audit?.events?.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["repair_apply", "policy_change"]),
    );
    expect(updated?.meta?.audit?.events?.find((event) => event.kind === "repair_apply")).toMatchObject({
      actor: "mcp",
      reason: "workflow_stabilize_apply",
      metadata: {
        tool: "workflow_stabilize",
        changeCount: 4,
        pageContentUsed: false,
      },
    });
    expect(updated?.meta?.quality).toMatchObject({
      level: "stable",
      passRate: 1,
      validationRuns: 2,
      countedValidationRuns: 2,
      validationRecords: [
        expect.objectContaining({
          phase: "postRepair",
          passedRuns: 2,
        }),
      ],
    });
  });

  it("workflowStabilizeTool applies high-confidence selector replacement and validates after patch", async () => {
    const flowId = `workflow-stabilize-selector-${Date.now()}`;
    const runId = `${flowId}-failed-run`;
    const oldSelector = "body > main > form:nth-of-type(1) input:nth-of-type(1)";
    const stableSelector = '[data-testid="email-input"]';
    const storage = createStoragePort();
    await storage.flows.save(
      createFlow(flowId, [
        {
          id: "fill-1" as any,
          kind: "fill",
          config: {
            target: {
              selector: oldSelector,
              fingerprint: "input|id=email|name=email",
              domPath: [0, 1, 0],
              shadowHostChain: [],
              candidates: [
                { type: "css", selector: oldSelector, value: oldSelector },
                {
                  type: "attr",
                  selector: stableSelector,
                  value: stableSelector,
                  unique: true,
                  stability: {
                    score: 0.97,
                    signals: { usesTestId: true, usesAttributes: true },
                  },
                },
              ],
            },
            value: "{email}",
          },
        },
      ]),
    );
    await storage.runs.save({
      schemaVersion: RUN_SCHEMA_VERSION,
      id: runId as any,
      flowId: flowId as any,
      status: "failed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      currentNodeId: "fill-1" as any,
      attempt: 1,
      maxAttempts: 1,
      error: { code: "TARGET_NOT_FOUND", message: "Missing input" },
      nextSeq: 1,
    } as RunRecordV3);
    await storage.events.append({
      runId: runId as any,
      type: "node.failed",
      nodeId: "fill-1" as any,
      attempt: 1,
      error: { code: "TARGET_NOT_FOUND", message: "Missing input" },
      decision: "stop",
    });
    const artifact = await storage.artifacts.saveScreenshot({
      runId: runId as any,
      nodeId: "fill-1" as any,
      base64: "ZmFpbHVyZS1zaG90",
    });
    await storage.events.append({
      runId: runId as any,
      type: "artifact.screenshot",
      nodeId: "fill-1" as any,
      artifactId: artifact.id,
      savedAs: artifact.filename,
    });
    await storage.events.append({
      runId: runId as any,
      type: "selector.resolution",
      nodeId: "fill-1" as any,
      primarySelector: oldSelector,
      resolvedBy: "candidate",
      candidateIndex: 1,
      matchCount: 1,
      fingerprint: { status: "matched", score: 0.95 },
    });
    let runCall = 0;
    mocks.enqueueRunAndWait.mockImplementation(async () => {
      runCall += 1;
      const validationRunId = `${flowId}-validation-${runCall}`;
      return {
        run: {
          id: validationRunId,
          flowId,
          status: "succeeded",
          tookMs: 5,
        } as any,
        events: [],
        result: {
          runId: validationRunId,
          success: true,
          status: "succeeded",
          summary: { total: 1, success: 1, failed: 0, tookMs: 5 },
          outputs: null,
          eventSummary: { totalEvents: 0, nodeEvents: 0, artifactEvents: 0 },
        },
      };
    });

    const result = await workflowStabilizeTool.execute({
      flowId,
      iterations: 1,
      minPassRate: 1,
      apply: true,
      repair: {
        parameterize: false,
        defaultStabilityPolicy: false,
        selectors: true,
      },
    });
    const payload = parseToolPayload(result);
    const updated = await storage.flows.get(flowId as any);

    expect(result.isError).toBe(false);
    expect(mocks.enqueueRunAndWait).toHaveBeenCalledTimes(2);
    expect(payload).toMatchObject({
      applied: true,
      stable: true,
      summary: {
        changeCount: 1,
        baselineRunCount: 1,
        postRepairRunCount: 1,
      },
    });
    expect(payload.selectorRepairsBeforeApply).toEqual([
      expect.objectContaining({
        op: "replaceTarget",
        nodeId: "fill-1",
        status: "autoPatch",
        beforeSelector: oldSelector,
        afterSelector: stableSelector,
        confidence: expect.any(Number),
        beforeQuality: expect.objectContaining({ usesNthOfType: true }),
        afterQuality: expect.objectContaining({ usesDataOrTestId: true }),
      }),
    ]);
    expect(payload.changes).toEqual([
      expect.objectContaining({
        code: "selector_target_replaced",
        nodeId: "fill-1",
        confidence: expect.any(Number),
        beforeQuality: expect.objectContaining({ primarySelector: oldSelector }),
        afterQuality: expect.objectContaining({ primarySelector: stableSelector }),
        patch: expect.objectContaining({
          op: "replaceTarget",
          selectorUnique: true,
        }),
      }),
    ]);
    expect((updated?.nodes[0].config as any).target.selector).toBe(stableSelector);
    expect((updated?.nodes[0].config as any).target.candidates[0]).toMatchObject({
      type: "attr",
      selector: stableSelector,
      value: stableSelector,
    });
    expect(updated?.meta?.repairs?.history?.[0]).toMatchObject({
      provenance: {
        source: "workflow_stabilize",
        pageContentUsed: true,
      },
      beforeQuality: expect.any(Number),
      afterQuality: expect.any(Number),
    });
  });

  it("workflowStabilizeTool inserts bounded wait repairs from DOM visibility observations", async () => {
    const flowId = `workflow-stabilize-wait-${Date.now()}`;
    const runId = `${flowId}-failed-run`;
    const storage = createStoragePort();
    await storage.flows.save(
      createFlow(flowId, [
        {
          id: "fill-1" as any,
          kind: "fill",
          config: {
            target: { selector: "#email" },
            value: "{email}",
          },
        },
      ]),
    );
    await storage.runs.save({
      schemaVersion: RUN_SCHEMA_VERSION,
      id: runId as any,
      flowId: flowId as any,
      status: "failed",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      currentNodeId: "fill-1" as any,
      attempt: 1,
      maxAttempts: 1,
      error: { code: "TARGET_NOT_FOUND", message: "Missing input" },
      nextSeq: 1,
    } as RunRecordV3);
    await storage.events.append({
      runId: runId as any,
      type: "node.failed",
      nodeId: "fill-1" as any,
      attempt: 1,
      error: { code: "TARGET_NOT_FOUND", message: "Missing input" },
      decision: "stop",
    });
    await storage.events.append({
      runId: runId as any,
      type: "dom.visibility",
      nodeId: "fill-1" as any,
      selector: "#email",
      matchCount: 1,
      appearedAt: Date.now(),
      status: "appeared",
    });
    let runCall = 0;
    mocks.enqueueRunAndWait.mockImplementation(async () => {
      runCall += 1;
      const validationRunId = `${flowId}-validation-${runCall}`;
      return {
        run: {
          id: validationRunId,
          flowId,
          status: "succeeded",
          tookMs: 5,
        } as any,
        events: [],
        result: {
          runId: validationRunId,
          success: true,
          status: "succeeded",
          summary: { total: 1, success: 1, failed: 0, tookMs: 5 },
          outputs: null,
          eventSummary: { totalEvents: 0, nodeEvents: 0, artifactEvents: 0 },
        },
      };
    });

    const result = await workflowStabilizeTool.execute({
      flowId,
      iterations: 1,
      minPassRate: 1,
      apply: true,
      repair: {
        parameterize: false,
        defaultStabilityPolicy: false,
        selectors: false,
        waits: true,
        assertions: false,
      },
    });
    const payload = parseToolPayload(result);
    const updated = await storage.flows.get(flowId as any);

    expect(result.isError).toBe(false);
    expect(mocks.enqueueRunAndWait).toHaveBeenCalledTimes(2);
    expect(payload).toMatchObject({
      applied: true,
      stable: true,
      summary: {
        changeCount: 1,
        baselineRunCount: 1,
        postRepairRunCount: 1,
      },
    });
    expect(payload.waitRepairsBeforeApply).toEqual([
      expect.objectContaining({
        op: "addWaitBefore",
        nodeId: "fill-1",
        status: "autoPatch",
        condition: { kind: "selector", selector: "#email", visible: true },
        confidence: expect.any(Number),
      }),
    ]);
    expect(payload.changes).toEqual([
      expect.objectContaining({
        code: "bounded_wait_added",
        nodeId: "fill-1",
        patch: expect.objectContaining({
          op: "addWaitBefore",
          condition: { kind: "selector", selector: "#email", visible: true },
        }),
      }),
    ]);
    const waitNode = updated?.nodes.find((node) => node.kind === "wait");
    expect(updated?.entryNodeId).toBe("wait-before-fill-1");
    expect(waitNode).toMatchObject({
      id: "wait-before-fill-1",
      config: { condition: { kind: "selector", selector: "#email", visible: true } },
    });
    expect(updated?.edges).toEqual([
      expect.objectContaining({
        from: "wait-before-fill-1",
        to: "fill-1",
      }),
    ]);
    expect(updated?.meta?.repairs?.history?.[0]).toMatchObject({
      provenance: {
        source: "workflow_stabilize",
        pageContentUsed: true,
      },
    });
  });

  it("workflowStabilizeTool returns rollback suggestion when validation regresses", async () => {
    const flowId = `workflow-stabilize-regress-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(flowId, [
        {
          id: "wait-1" as any,
          kind: "wait",
          config: { condition: { kind: "selector", selector: "#ready" } },
        },
      ]),
    );

    let runCall = 0;
    mocks.enqueueRunAndWait.mockImplementation(async () => {
      runCall += 1;
      const success = runCall === 1;
      const runId = `run-stabilize-regress-${runCall}`;
      return {
        run: {
          id: runId,
          flowId,
          status: success ? "succeeded" : "failed",
          currentNodeId: "wait-1",
          tookMs: 5,
        } as any,
        events: [],
        result: {
          runId,
          success,
          status: success ? "succeeded" : "failed",
          currentNodeId: "wait-1",
          failedNodeId: success ? undefined : "wait-1",
          errorCode: success ? undefined : "TIMEOUT",
          error: success
            ? undefined
            : {
                code: "TIMEOUT",
                category: "runtime",
                retryable: true,
                message: "Timed out waiting for #ready",
                nodeId: "wait-1",
              },
          summary: { total: 1, success: success ? 1 : 0, failed: success ? 0 : 1, tookMs: 5 },
          outputs: null,
          eventSummary: { totalEvents: 0, nodeEvents: 0, artifactEvents: 0 },
        },
      };
    });

    const result = await workflowStabilizeTool.execute({
      flowId,
      iterations: 1,
      minPassRate: 1,
      apply: true,
    });
    const payload = parseToolPayload(result);

    expect(result.isError).toBe(false);
    expect(payload).toMatchObject({
      applied: true,
      stable: false,
      baselineScore: { passRate: 1, passedRuns: 1, failedRuns: 0, iterations: 1 },
      postRepairScore: { passRate: 0, passedRuns: 0, failedRuns: 1, iterations: 1 },
      rollbackSuggestion: {
        beforeRevision: expect.stringMatching(/^rev-fnv1a32-/),
        reason: "post-repair validation passRate is lower than baseline",
        automaticRollbackAvailable: false,
      },
    });
  });

  it("workflowStabilizeTool returns structured validation errors", async () => {
    const result = await workflowStabilizeTool.execute({
      flowId: "flow-a",
      workflow: "slug-a",
      apply: true,
      dryRun: true,
      tabId: 1,
      tabTarget: "new",
      iterations: 99,
    });
    const payload = parseToolPayload(result);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      success: false,
      status: "validation_failed",
      error: {
        code: "INVALID_WORKFLOW_STABILIZE_ARGS",
        category: "validation",
        retryable: false,
      },
    });
    expect(payload.error.errors.map((error: { code: string }) => error.code)).toEqual(
      expect.arrayContaining([
        "INVALID_WORKFLOW_IDENTIFIER",
        "MUTUALLY_EXCLUSIVE_OPTIONS",
        "INVALID_ITERATIONS",
      ]),
    );
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
      createFlow(
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
              value: "{email}",
            },
          },
        ],
        {
          variables: [{ name: "email", kind: "string", required: true }],
        },
      ),
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
      flowId,
      revision: expect.stringMatching(/^rev-fnv1a32-/),
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
      createFlow(
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
              value: "{email}",
            },
          },
        ],
        {
          variables: [{ name: "email", kind: "string", required: true }],
        },
      ),
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
      createFlow(
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
              value: "{email}",
            },
          },
        ],
        {
          variables: [{ name: "email", kind: "string", required: true }],
        },
      ),
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

  it("flowRunTool validates args before enqueueing replay", async () => {
    const flowId = `flow-run-invalid-args-${Date.now()}`;
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
      ], {
        variables: [
          { name: "email", kind: "string", required: true },
          { name: "attempts", kind: "number" },
        ],
      }),
    );

    const result = await flowRunTool.execute({
      flowId,
      args: {
        attempts: "three",
        extra: true,
      },
    });
    const payload = parseToolPayload(result);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      success: false,
      flowId,
      status: "validation_failed",
      error: {
        code: "INVALID_WORKFLOW_ARGS",
        category: "validation",
      },
    });
    expect(payload.error.errors.map((error: { code: string }) => error.code)).toEqual(
      expect.arrayContaining([
        "MISSING_REQUIRED_WORKFLOW_ARG",
        "INVALID_WORKFLOW_ARG_TYPE",
        "UNKNOWN_WORKFLOW_ARG",
      ]),
    );
    expect(mocks.enqueueRunAndWait).not.toHaveBeenCalled();
  });

  it("flowRunTool accepts secretRef args without forwarding plaintext to the run queue", async () => {
    const flowId = `flow-run-secret-ref-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(
        flowId,
        [
          {
            id: "fill-1" as any,
            kind: "fill",
            config: {
              target: { selector: "#password" },
              value: "{password}",
            },
          },
        ],
        {
          variables: [{ name: "password", kind: "string", required: true, sensitive: true }],
        },
      ),
    );
    asMock(chrome.storage.local.get).mockResolvedValue({
      [WORKFLOW_SECRET_STORE_KEY]: {
        "secret://login-password": { value: "plain-secret-password" },
      },
    });
    mocks.enqueueRunAndWait.mockResolvedValue({
      run: { id: "run-secret-ref" } as any,
      events: [],
      result: {
        runId: "run-secret-ref",
        success: true,
        status: "succeeded",
        summary: { total: 1, success: 1, failed: 0, tookMs: 2 },
        outputs: null,
        logs: [],
        paused: false,
      },
    });

    const result = await flowRunTool.execute({
      flowId,
      args: {
        password: { secretRef: "secret://login-password" },
      },
    });
    const payload = parseToolPayload(result);
    const updated = await createStoragePort().flows.get(flowId as any);

    expect(result.isError).toBe(false);
    expect(mocks.enqueueRunAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        args: {
          password: { secretRef: "secret://login-password" },
        },
      }),
    );
    expect(JSON.stringify(mocks.enqueueRunAndWait.mock.calls[0][0])).not.toContain(
      "plain-secret-password",
    );
    expect(payload.metrics).toMatchObject({
      audit: { eventCount: 1 },
      approval: { useCount: 0 },
    });
    expect(updated?.meta?.audit?.events).toEqual([
      expect.objectContaining({
        kind: "secret_ref_use",
        actor: "runtime",
        runId: "run-secret-ref",
        metadata: {
          secretRefCount: 1,
        },
      }),
    ]);
    expect(JSON.stringify(updated?.meta?.audit)).not.toContain("plain-secret-password");
    expect(JSON.stringify(updated?.meta?.audit)).not.toContain("secret://login-password");
  });

  it("flowRunTool blocks missing secretRef args before replay", async () => {
    const flowId = `flow-run-secret-missing-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(
        flowId,
        [
          {
            id: "fill-1" as any,
            kind: "fill",
            config: { target: { selector: "#password" }, value: "{password}" },
          },
        ],
        {
          variables: [{ name: "password", kind: "string", required: true, sensitive: true }],
        },
      ),
    );
    asMock(chrome.storage.local.get).mockResolvedValue({ [WORKFLOW_SECRET_STORE_KEY]: {} });

    const result = await flowRunTool.execute({
      flowId,
      args: {
        password: { secretRef: "secret://missing" },
      },
    });
    const payload = parseToolPayload(result);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      success: false,
      flowId,
      status: "blocked",
      error: {
        code: "SECRET_REF_NOT_FOUND",
        path: "/args/password",
      },
    });
    expect(mocks.enqueueRunAndWait).not.toHaveBeenCalled();
  });

  it("flowRunTool projects declared outputs and validates their schema", async () => {
    const flowId = `flow-run-output-valid-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(
        flowId,
        [
          {
            id: "extract-1" as any,
            kind: "extract",
            config: { selector: "#account-id" },
          },
        ],
        {
          meta: {
            exposedOutputs: [
              {
                nodeId: "extract-1" as any,
                as: "accountId",
                path: ["value"],
                schema: { type: "string", pattern: "^acct_[0-9]+$" },
              },
            ],
          },
        },
      ),
    );
    mocks.enqueueRunAndWait.mockResolvedValue({
      run: { id: "run-output-valid" } as any,
      events: [],
      result: {
        runId: "run-output-valid",
        success: true,
        status: "succeeded",
        summary: { total: 1, success: 1, failed: 0, tookMs: 2 },
        outputs: {
          "extract-1": { value: "acct_123" },
        },
        logs: [],
        paused: false,
      },
    });

    const result = await flowRunTool.execute({ flowId });
    const payload = parseToolPayload(result);

    expect(result.isError).toBe(false);
    expect(payload.outputs).toEqual({ accountId: "acct_123" });
    expect(payload.outputValidation).toMatchObject({
      ok: true,
      declaredOutputCount: 1,
      errors: [],
    });
  });

  it("flowRunTool fails successful replays when required output validation fails", async () => {
    const flowId = `flow-run-output-invalid-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(
        flowId,
        [
          {
            id: "extract-1" as any,
            kind: "extract",
            config: { selector: "#account-id" },
          },
        ],
        {
          meta: {
            exposedOutputs: [
              {
                nodeId: "extract-1" as any,
                as: "accountId",
                path: ["value"],
                schema: { type: "string", pattern: "^acct_[0-9]+$" },
              },
            ],
          },
        },
      ),
    );
    mocks.enqueueRunAndWait.mockResolvedValue({
      run: { id: "run-output-invalid" } as any,
      events: [],
      result: {
        runId: "run-output-invalid",
        success: true,
        status: "succeeded",
        summary: { total: 1, success: 1, failed: 0, tookMs: 2 },
        outputs: {
          "extract-1": { value: "not-an-account-id" },
        },
        logs: [],
        paused: false,
      },
    });

    const result = await flowRunTool.execute({ flowId });
    const payload = parseToolPayload(result);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      success: false,
      status: "output_validation_failed",
      errorCode: "OUTPUT_VALIDATION_FAILED",
      error: {
        code: "OUTPUT_VALIDATION_FAILED",
        category: "validation",
      },
      outputValidation: {
        ok: false,
        errors: [
          expect.objectContaining({
            code: "OUTPUT_SCHEMA_PATTERN_MISMATCH",
            alias: "accountId",
          }),
        ],
      },
    });
  });

  it("flowRunTool redacts sensitive declared outputs by default", async () => {
    const flowId = `flow-run-output-sensitive-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(
        flowId,
        [
          {
            id: "extract-1" as any,
            kind: "extract",
            config: { selector: "#api-token" },
          },
        ],
        {
          meta: {
            exposedOutputs: [
              {
                nodeId: "extract-1" as any,
                as: "apiToken",
                path: ["value"],
                schema: { type: "string" },
                sensitive: true,
              },
            ],
          },
        },
      ),
    );
    mocks.enqueueRunAndWait.mockResolvedValue({
      run: { id: "run-output-sensitive" } as any,
      events: [],
      result: {
        runId: "run-output-sensitive",
        success: true,
        status: "succeeded",
        summary: { total: 1, success: 1, failed: 0, tookMs: 2 },
        outputs: {
          "extract-1": { value: "opaque-runtime-token" },
        },
        logs: [],
        paused: false,
      },
    });

    const result = await flowRunTool.execute({ flowId });
    const payload = parseToolPayload(result);

    expect(result.isError).toBe(false);
    expect(payload.outputs).toEqual({ apiToken: "[REDACTED]" });
    expect(payload.outputValidation).toMatchObject({
      ok: true,
      redacted: ["apiToken"],
    });
  });

  it("flowRunTool marks failed runs as MCP errors", async () => {
    const flowId = `flow-run-failed-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(
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
              value: "{email}",
            },
          },
        ],
        { variables: [{ name: "email", kind: "string", required: true }] },
      ),
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
      flowId,
      revision: expect.stringMatching(/^rev-fnv1a32-/),
      summary: { total: 1, success: 0, failed: 1, tookMs: 4 },
      debug: {
        debugTool: "workflow_debug_view",
        debugArgs: {
          runId: "run-toolchain-failed",
          flowId,
          includeArtifacts: true,
        },
      },
    });
  });

  it("flowRunTool downgrades stale quality after consecutive failures", async () => {
    const flowId = `flow-run-quality-downgrade-${Date.now()}`;
    const flow = createFlow(flowId, [
      {
        id: "wait-1" as any,
        kind: "wait",
        config: { condition: { kind: "selector", selector: "#ready" } },
      },
    ]);
    flow.meta = {
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
        lastValidatedAt: "2026-01-01T00:00:00.000Z" as any,
        freshnessExpiresAt: "2999-01-01T00:00:00.000Z" as any,
        verification: {
          oracle: "none",
          oracleStrength: "weak",
        },
        revalidation: {
          policy: "onFailure",
          nextRevalidateAt: "2999-01-01T00:00:00.000Z" as any,
          autoDowngrade: true,
        },
        slo: {
          targetPassRate: 1,
          minValidationRuns: 3,
        },
      },
    };
    await createStoragePort().flows.save(flow);

    let runCall = 0;
    mocks.enqueueRunAndWait.mockImplementation(async () => {
      runCall += 1;
      const runId = `run-quality-downgrade-${runCall}`;
      return {
        run: {
          id: runId,
          flowId,
          status: "failed",
          currentNodeId: "wait-1",
          tookMs: 4,
        } as any,
        events: [],
        result: {
          runId,
          success: false,
          status: "failed",
          currentNodeId: "wait-1",
          failedNodeId: "wait-1",
          errorCode: "TIMEOUT",
          error: {
            code: "TIMEOUT",
            category: "runtime",
            retryable: true,
            message: "Timed out waiting for #ready",
            nodeId: "wait-1",
          },
          summary: { total: 1, success: 0, failed: 1, tookMs: 4 },
          outputs: null,
          logs: [],
          paused: false,
        },
      };
    });

    await flowRunTool.execute({ flowId });
    await flowRunTool.execute({ flowId });
    const third = await flowRunTool.execute({ flowId });
    const payload = parseToolPayload(third);
    const updated = await createStoragePort().flows.get(flowId as any);

    expect(third.isError).toBe(true);
    expect(payload.quality).toMatchObject({
      status: "stale",
      current: false,
      staleReason: "consecutive_failures",
      slo: {
        status: "breached",
        breaches: expect.arrayContaining(["consecutive_failures"]),
      },
    });
    expect(payload.metrics.workflowRun).toMatchObject({
      totalCount: 1,
      success: false,
      successCount: 0,
      failureCount: 1,
      consecutiveFailureCount: 3,
      staleQualityCount: 1,
      revalidationRecommended: true,
    });
    expect(payload.metrics.quality).toMatchObject({
      staleQualityCount: 1,
    });
    expect(updated?.meta?.quality).toMatchObject({
      consecutiveFailureCount: 3,
      staleReason: "consecutive_failures",
      revalidation: {
        lastRevalidateReason: "workflow_run_failure",
      },
    });
    expect(updated?.meta?.audit?.events?.filter((event) => event.kind === "quality_downgrade")).toEqual([
      expect.objectContaining({
        actor: "runtime",
        runId: "run-quality-downgrade-3",
        previousStatus: "stable",
        nextStatus: "stale",
        reason: "consecutive_failures",
        metadata: {
          consecutiveFailureCount: 3,
        },
      }),
    ]);
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

  it("workflowPublishTool publishes stabilized drafts and workflowUnpublishTool removes the slug", async () => {
    const flowId = `workflow-publish-${Date.now()}`;
    const flow = createFlow(flowId, [
      {
        id: "node-1" as any,
        kind: "navigate",
        config: { url: "https://example.com" },
      },
    ]);
    flow.meta = {
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
    await createStoragePort().flows.save(flow);

    const publish = await workflowPublishTool.execute({
      flowId,
      slug: "Published From Tool",
      description: "Published through MCP",
    });
    const publishPayload = parseToolPayload(publish);
    const published = await createStoragePort().flows.get(flowId as any);

    expect(publish.isError).toBe(false);
    expect(publishPayload).toMatchObject({
      success: true,
      workflow: "published-from-tool",
      published: true,
      audit: {
        kind: "workflow_publish",
        actor: "mcp",
        workflow: "published-from-tool",
        previousStatus: "stable",
        nextStatus: "stable",
      },
      descriptor: {
        slug: "published-from-tool",
        quality: {
          current: true,
          level: "stable",
        },
      },
    });
    expect(publishPayload.warnings.map((warning: { code: string }) => warning.code)).toContain(
      "PUBLISH_QUALITY_REBOUND_TO_DESCRIPTOR",
    );
    expect(published?.meta?.tool).toMatchObject({
      published: true,
      slug: "published-from-tool",
      description: "Published through MCP",
    });
    expect(published?.meta?.quality?.revision).toBe(calculateWorkflowRevision(published as FlowV3));
    expect(published?.meta?.audit?.events?.map((event) => event.kind)).toContain("workflow_publish");

    const unpublish = await workflowUnpublishTool.execute({ workflow: "published-from-tool" });
    const unpublishPayload = parseToolPayload(unpublish);
    const unpublished = await createStoragePort().flows.get(flowId as any);

    expect(unpublish.isError).toBe(false);
    expect(unpublishPayload).toMatchObject({
      success: true,
      workflow: "published-from-tool",
      published: false,
      status: "draft",
      audit: {
        kind: "workflow_unpublish",
        actor: "mcp",
        workflow: "published-from-tool",
        previousStatus: "stable",
        nextStatus: "draft",
      },
    });
    expect(unpublished?.meta?.tool).toMatchObject({
      published: false,
      slug: "published-from-tool",
    });
    expect(unpublished?.meta?.audit?.events?.map((event) => event.kind)).toEqual([
      "workflow_publish",
      "workflow_unpublish",
    ]);
  });

  it("workflowPublishTool blocks unstabilized workflows unless warning mode is explicit", async () => {
    const flowId = `workflow-publish-blocked-${Date.now()}`;
    await createStoragePort().flows.save(
      createFlow(flowId, [
        {
          id: "node-1" as any,
          kind: "navigate",
          config: { url: "https://example.com" },
        },
      ]),
    );

    const blocked = await workflowPublishTool.execute({
      flowId,
      slug: "Blocked Publish",
    });
    expect(blocked.isError).toBe(true);
    expect(parseToolPayload(blocked)).toMatchObject({
      success: false,
      status: "blocked",
      error: {
        code: "PUBLISH_QUALITY_GATE_FAILED",
      },
    });

    const missingAck = await workflowPublishTool.execute({
      flowId,
      slug: "Blocked Publish",
      requireStable: false,
    });
    expect(missingAck.isError).toBe(true);
    expect(parseToolPayload(missingAck)).toMatchObject({
      error: {
        code: "UNVERIFIED_PUBLISH_REQUIRES_ACK",
      },
    });

    const warningMode = await workflowPublishTool.execute({
      flowId,
      slug: "Blocked Publish",
      requireStable: false,
      allowUnverified: true,
    });
    expect(warningMode.isError).toBe(false);
    expect(parseToolPayload(warningMode)).toMatchObject({
      success: true,
      workflow: "blocked-publish",
      quality: {
        current: false,
        staleReason: "missing_quality",
      },
    });
  });
});
