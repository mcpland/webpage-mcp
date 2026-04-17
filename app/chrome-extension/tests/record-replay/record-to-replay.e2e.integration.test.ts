import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_NAMES } from "webpage-mcp-shared";

import { TOOL_MESSAGE_TYPES } from "@/common/message-types";
import { createStoragePort } from "@/entrypoints/background/record-replay-v3";
import {
  bootstrapV3,
  getV3Runtime,
} from "@/entrypoints/background/record-replay-v3/bootstrap";
import { isTerminalStatus } from "@/entrypoints/background/record-replay-v3/domain/events";
import { deleteRrV3Db } from "@/entrypoints/background/record-replay-v3/storage/db";

const mocks = vi.hoisted(() => ({
  ensureRecorderInjected: vi.fn(),
  broadcastControlToTab: vi.fn(),
  handleCallTool: vi.fn(),
  waitForNavigationDone: vi.fn(),
  ensureReadPageIfWeb: vi.fn(),
  maybeQuickWaitForNav: vi.fn(),
  waitForNetworkIdle: vi.fn(),
}));

vi.mock(
  "@/entrypoints/background/record-replay/recording/content-injection",
  () => ({
    REC_CMD: {
      START: "start",
      STOP: "stop",
      PAUSE: "pause",
      RESUME: "resume",
    },
    ensureRecorderInjected: mocks.ensureRecorderInjected,
    broadcastControlToTab: mocks.broadcastControlToTab,
  }),
);

vi.mock("@/entrypoints/background/tools", () => ({
  handleCallTool: mocks.handleCallTool,
}));

vi.mock("@/entrypoints/background/record-replay/engine/policies/wait", () => ({
  waitForNavigationDone: mocks.waitForNavigationDone,
  ensureReadPageIfWeb: mocks.ensureReadPageIfWeb,
  maybeQuickWaitForNav: mocks.maybeQuickWaitForNav,
  waitForNetworkIdle: mocks.waitForNetworkIdle,
}));

import { recordingSession } from "@/entrypoints/background/record-replay/recording/session-manager";
import { flowRunTool } from "@/entrypoints/background/tools/record-replay";
import {
  recordingStartTool,
  recordingStopTool,
} from "@/entrypoints/background/tools/recording";

const TAB_ID = 41;

function asMock(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

interface MockTab extends Partial<chrome.tabs.Tab> {
  id: number;
  url: string;
  title: string;
  active: boolean;
  status: string;
  windowId: number;
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

async function waitForRunTerminal(
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const run = await createStoragePort().runs.get(runId as any);
    if (run && isTerminalStatus(run.status)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Run "${runId}" did not reach a terminal state`);
}

async function invokeRpcHandleRequest(
  method: string,
  params: Record<string, unknown>,
) {
  const runtime = await bootstrapV3();
  const rpcServer = runtime.rpcServer as unknown as {
    handleRequest: (
      request: { method: string; params?: Record<string, unknown>; requestId: string },
      conn: { subscriptions: Set<string | null> },
    ) => Promise<unknown>;
  };
  return rpcServer.handleRequest(
    {
      method,
      params,
      requestId: `req_${Date.now()}`,
    },
    { subscriptions: new Set() },
  );
}

describe("record to replay automation", () => {
  let currentTab: MockTab;
  let localStorageState: Record<string, unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();
    if (getV3Runtime()) {
      await getV3Runtime()?.stop();
    }
    await deleteRrV3Db();
    currentTab = {
      id: TAB_ID,
      url: "https://example.com/signup",
      title: "Signup",
      active: true,
      status: "complete",
      windowId: 1,
    };
    localStorageState = {};

    mocks.ensureRecorderInjected.mockResolvedValue(undefined);
    mocks.broadcastControlToTab.mockResolvedValue(undefined);
    mocks.waitForNavigationDone.mockResolvedValue(undefined);
    mocks.ensureReadPageIfWeb.mockResolvedValue(undefined);
    mocks.maybeQuickWaitForNav.mockResolvedValue(undefined);
    mocks.waitForNetworkIdle.mockResolvedValue(undefined);
    if (typeof (chrome.tabs as any).sendMessage !== "function") {
      (chrome.tabs as any).sendMessage = vi.fn();
    }
    if (typeof (chrome.webNavigation as any).getAllFrames !== "function") {
      (chrome.webNavigation as any).getAllFrames = vi.fn();
    }
    mocks.handleCallTool.mockImplementation(
      async ({ name, args }: { name: string; args?: any }) => {
        switch (name) {
          case TOOL_NAMES.BROWSER.NAVIGATE:
            if (typeof args?.url === "string" && args.url.trim()) {
              currentTab = { ...currentTab, url: args.url };
            }
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ success: true, tabId: TAB_ID }),
                },
              ],
              isError: false,
            };
          case TOOL_NAMES.BROWSER.READ_PAGE:
          case TOOL_NAMES.BROWSER.FILL:
          case TOOL_NAMES.BROWSER.INJECT_SCRIPT:
            return {
              content: [
                { type: "text", text: JSON.stringify({ success: true }) },
              ],
              isError: false,
            };
          default:
            return {
              content: [
                { type: "text", text: JSON.stringify({ success: true }) },
              ],
              isError: false,
            };
        }
      },
    );

    asMock(chrome.storage.local.get).mockImplementation(
      async (keys?: string | string[] | object | null) => {
        if (Array.isArray(keys)) {
          const out: Record<string, unknown> = {};
          for (const key of keys) {
            out[key] = localStorageState[key];
          }
          return out;
        }
        if (typeof keys === "string") {
          return { [keys]: localStorageState[keys] };
        }
        if (keys && typeof keys === "object") {
          const out: Record<string, unknown> = {};
          for (const [key, fallback] of Object.entries(keys)) {
            out[key] =
              key in localStorageState ? localStorageState[key] : fallback;
          }
          return out;
        }
        return { ...localStorageState };
      },
    );
    asMock(chrome.storage.local.set).mockImplementation(
      async (items: object) => {
        Object.assign(localStorageState, items);
      },
    );
    asMock(chrome.runtime.sendMessage).mockResolvedValue(undefined);
    (chrome.runtime as any).getManifest = vi.fn(() => ({ manifest_version: 3 }));
    asMock(chrome.tabs.query).mockImplementation(
      async (queryInfo?: chrome.tabs.QueryInfo) => {
        if (queryInfo?.currentWindow === true) {
          if (queryInfo.active === true) {
            return [currentTab as chrome.tabs.Tab];
          }
          return [currentTab as chrome.tabs.Tab];
        }
        return [currentTab as chrome.tabs.Tab];
      },
    );
    asMock(chrome.tabs.get).mockImplementation(async (tabId: number) => {
      if (tabId !== currentTab.id) {
        throw new Error(`Unknown tab: ${tabId}`);
      }
      return currentTab as chrome.tabs.Tab;
    });
    asMock(chrome.tabs.sendMessage).mockImplementation(
      async (_tabId: number, message: any): Promise<any> => {
        switch (message?.action) {
          case "stop":
            return { ack: true, stats: { steps: 1, variables: 0 } };
          case TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR:
            return {
              success: true,
              ref: "ref_email",
              center: { x: 10, y: 10 },
            };
          case TOOL_MESSAGE_TYPES.RESOLVE_REF:
          case "resolveRef":
            return {
              success: true,
              selector: "#email",
              center: { x: 10, y: 10 },
              rect: { width: 180, height: 24 },
            };
          case "getAttributeForSelector":
            return { value: "text" };
          case "focusByRef":
            return { success: true };
          default:
            return { success: true };
        }
      },
    );
    asMock(chrome.webNavigation.getAllFrames).mockResolvedValue([
      { frameId: 0, url: currentTab.url, parentFrameId: -1 },
    ] as chrome.webNavigation.GetAllFrameResultDetails[]);
  });

  afterEach(async () => {
    if (getV3Runtime()) {
      await getV3Runtime()?.stop();
    }
    if (recordingSession.getStatus() !== "idle") {
      await recordingSession.stopSession();
    }
    await deleteRrV3Db();
  });

  it("records a flow and replays the saved recording automatically", async () => {
    const startResult = await recordingStartTool.execute({
      name: "Recorded Signup",
      tabId: TAB_ID,
    });
    const startPayload = parseToolPayload(startResult);

    expect(startPayload.success).toBe(true);
    expect(mocks.ensureRecorderInjected).toHaveBeenCalledWith(TAB_ID);
    expect(mocks.broadcastControlToTab).toHaveBeenCalledWith(
      TAB_ID,
      "start",
      expect.objectContaining({
        name: "Recorded Signup",
        description: undefined,
      }),
    );

    recordingSession.appendSteps([
      {
        id: "fill-email",
        type: "fill",
        target: {
          selector: "#email",
          candidates: [{ type: "css", value: "#email" }],
        },
        value: "alice@example.com",
      } as any,
    ]);

    const stopResult = await recordingStopTool.execute({
      name: "Signup Replay Flow",
      description: "Captured from automated record-to-replay test",
    });
    const stopPayload = parseToolPayload(stopResult);
    const flowId = stopPayload.flow.id as string;
    const savedFlowV3 = await createStoragePort().flows.get(flowId as any);

    expect(stopPayload.success).toBe(true);
    expect(stopPayload.flow).toMatchObject({
      id: flowId,
      name: "Signup Replay Flow",
      description: "Captured from automated record-to-replay test",
      stepCount: 2,
    });
    expect(savedFlowV3).toMatchObject({
      id: flowId,
      name: "Signup Replay Flow",
      description: "Captured from automated record-to-replay test",
      nodes: [
        expect.objectContaining({ kind: "navigate" }),
        expect.objectContaining({ kind: "fill" }),
      ],
      meta: {
        recording: {
          originUrl: "https://example.com/signup",
          stepCount: 2,
        },
      },
    });

    const runResult = await flowRunTool.execute({
      flowId,
      tabId: TAB_ID,
      returnLogs: true,
    });
    const runPayload = parseToolPayload(runResult);
    const toolNames = mocks.handleCallTool.mock.calls.map(
      ([call]) => call.name,
    );

    expect(runPayload.success).toBe(true);
    expect(runPayload.summary).toMatchObject({
      total: 2,
      success: 2,
      failed: 0,
    });
    expect(toolNames).toContain(TOOL_NAMES.BROWSER.NAVIGATE);
    expect(toolNames).toContain(TOOL_NAMES.BROWSER.READ_PAGE);
    expect(toolNames).toContain(TOOL_NAMES.BROWSER.FILL);
    expect(currentTab.url).toBe("https://example.com/signup");
  });

  it("replays a recorded flow through the RR-V3 RPC path used by sidepanel", async () => {
    await recordingStartTool.execute({
      name: "Recorded Signup RPC",
      tabId: TAB_ID,
    });

    recordingSession.appendSteps([
      {
        id: "fill-email",
        type: "fill",
        target: {
          selector: "#email",
          candidates: [{ type: "css", value: "#email" }],
        },
        value: "alice@example.com",
      } as any,
    ]);

    const stopResult = await recordingStopTool.execute({
      name: "Signup Replay RPC Flow",
      description: "Captured for sidepanel RPC replay test",
    });
    const stopPayload = parseToolPayload(stopResult);
    const flowId = stopPayload.flow.id as string;

    const result = (await invokeRpcHandleRequest("rr_v3.enqueueRun", {
      flowId,
    })) as { runId: string; position: number };
    const run = await waitForRunTerminal(result.runId);
    const events = await createStoragePort().events.list(result.runId as any);
    const toolNames = mocks.handleCallTool.mock.calls.map(([call]) => call.name);

    expect(run.status).toBe("succeeded");
    expect(events.filter((event) => event.type === "node.succeeded")).toHaveLength(2);
    expect(toolNames).toContain(TOOL_NAMES.BROWSER.NAVIGATE);
    expect(toolNames).toContain(TOOL_NAMES.BROWSER.READ_PAGE);
    expect(toolNames).toContain(TOOL_NAMES.BROWSER.FILL);
    expect(currentTab.url).toBe("https://example.com/signup");
  });

  it("replays sequential navigate steps from chrome://newtab/ to google through the RR-V3 RPC path", async () => {
    const flowId = `flow-nav-seq-${Date.now()}`;
    await createStoragePort().flows.save({
      schemaVersion: 3,
      id: flowId as any,
      name: "Navigate Sequence",
      entryNodeId: "nav-1" as any,
      nodes: [
        {
          id: "nav-1" as any,
          kind: "navigate",
          config: { url: "chrome://newtab/" },
        },
        {
          id: "nav-2" as any,
          kind: "navigate",
          config: { url: "https://www.google.com/" },
        },
      ],
      edges: [
        {
          id: "edge-nav-1" as any,
          from: "nav-1" as any,
          to: "nav-2" as any,
          label: "default",
        },
      ],
      createdAt: new Date().toISOString() as any,
      updatedAt: new Date().toISOString() as any,
    });

    const result = (await invokeRpcHandleRequest("rr_v3.enqueueRun", {
      flowId,
      tabId: TAB_ID,
      tabTarget: "current",
    })) as { runId: string; position: number };
    const run = await waitForRunTerminal(result.runId);
    const events = await createStoragePort().events.list(result.runId as any);

    expect(run.status).toBe("succeeded");
    expect(events.filter((event) => event.type === "node.succeeded")).toHaveLength(2);
    expect(currentTab.url).toBe("https://www.google.com/");
  });
});
