import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOL_NAMES } from "webpage-mcp-shared";

import { TOOL_MESSAGE_TYPES } from "@/common/message-types";
import { createStoragePort } from "@/entrypoints/background/record-replay-v3";
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

import { getFlow } from "@/entrypoints/background/record-replay/flow-store";
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

describe("record to replay automation", () => {
  let currentTab: MockTab;
  let localStorageState: Record<string, unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();
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
    const savedFlow = await getFlow(flowId);
    const savedFlowV3 = await createStoragePort().flows.get(flowId as any);

    expect(stopPayload.success).toBe(true);
    expect(stopPayload.flow).toMatchObject({
      id: flowId,
      name: "Signup Replay Flow",
      description: "Captured from automated record-to-replay test",
      stepCount: 2,
    });
    expect(savedFlow?.nodes?.map((node) => node.type)).toEqual([
      "navigate",
      "fill",
    ]);
    expect(savedFlowV3).toMatchObject({
      id: flowId,
      name: "Signup Replay Flow",
      description: "Captured from automated record-to-replay test",
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
});
