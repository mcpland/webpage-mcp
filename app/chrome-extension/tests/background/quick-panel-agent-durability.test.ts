import { beforeEach, describe, expect, it, vi } from "vitest";

import { BACKGROUND_MESSAGE_TYPES } from "@/common/message-types";

const nativeHostMocks = vi.hoisted(() => ({
  requestAgentRpcFetch: vi.fn(),
  subscribeAgentStream: vi.fn(),
  unsubscribeAgentStream: vi.fn(),
}));
const sidepanelMocks = vi.hoisted(() => ({ openAgentSetupSidepanel: vi.fn() }));
const keepaliveMocks = vi.hoisted(() => ({
  acquireKeepalive: vi.fn(() => vi.fn()),
}));
const authorizationMocks = vi.hoisted(() => ({
  consumePrivilegedUiAuthorization: vi.fn(() => true),
}));

vi.mock("@/entrypoints/background/native-host", () => nativeHostMocks);
vi.mock("@/entrypoints/background/utils/sidepanel", () => sidepanelMocks);
vi.mock("@/entrypoints/background/keepalive-manager", () => keepaliveMocks);
vi.mock(
  "@/entrypoints/background/privileged-ui-authorization",
  () => authorizationMocks,
);

type RuntimeListener = Parameters<
  typeof chrome.runtime.onMessage.addListener
>[0];
type AlarmListener = Parameters<typeof chrome.alarms.onAlarm.addListener>[0];
type TabRemovedListener = Parameters<
  typeof chrome.tabs.onRemoved.addListener
>[0];

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("Quick Panel Agent durable lifecycle", () => {
  let storageState: Record<string, unknown>;
  let runtimeListeners: RuntimeListener[];
  let alarmListeners: AlarmListener[];
  let tabRemovedListeners: TabRemovedListener[];
  let alarms: Map<string, chrome.alarms.AlarmCreateInfo>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    storageState = {};
    runtimeListeners = [];
    alarmListeners = [];
    tabRemovedListeners = [];
    alarms = new Map();

    chrome.storage.session = {
      get: vi.fn(async () => structuredClone(storageState)),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(storageState, structuredClone(items));
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys])
          delete storageState[key];
      }),
    } as unknown as typeof chrome.storage.session;
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      "agent-selected-session-id": "session-1",
    });
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation(
      (listener) => {
        runtimeListeners.push(listener);
      },
    );
    vi.mocked(chrome.runtime.onMessage.removeListener).mockImplementation(
      (listener) => {
        runtimeListeners = runtimeListeners.filter(
          (entry) => entry !== listener,
        );
      },
    );
    vi.mocked(chrome.alarms.create).mockImplementation(async (name, info) => {
      alarms.set(name, info);
    });
    vi.mocked(chrome.alarms.clear).mockImplementation(async (name?: string) => {
      if (name) alarms.delete(name);
    });
    vi.mocked(chrome.alarms.onAlarm.addListener).mockImplementation(
      (listener) => {
        alarmListeners.push(listener);
      },
    );
    vi.mocked(chrome.tabs.onRemoved.addListener).mockImplementation(
      (listener) => {
        tabRemovedListeners.push(listener);
      },
    );
    vi.mocked(chrome.tabs.get).mockResolvedValue({ id: 7 } as chrome.tabs.Tab);
    (
      chrome.webNavigation as typeof chrome.webNavigation & {
        getFrame: ReturnType<typeof vi.fn>;
      }
    ).getFrame = vi.fn().mockResolvedValue({ documentId: "document-a" });
    (
      chrome.tabs as typeof chrome.tabs & {
        sendMessage: ReturnType<typeof vi.fn>;
      }
    ).sendMessage = vi.fn().mockResolvedValue(undefined);

    sidepanelMocks.openAgentSetupSidepanel.mockResolvedValue(undefined);
    nativeHostMocks.unsubscribeAgentStream.mockResolvedValue(undefined);
    nativeHostMocks.subscribeAgentStream.mockImplementation(
      async (_sessionId: string, options: { subscriptionId: string }) => ({
        subscriptionId: options.subscriptionId,
      }),
    );
    nativeHostMocks.requestAgentRpcFetch.mockImplementation(
      async (request: any) => {
        if (request.operation === "agent.sessions.get") {
          return { ok: true, statusCode: 200, json: {}, body: "" };
        }
        return { ok: true, statusCode: 200, json: {}, body: "" };
      },
    );
  });

  function sender(): chrome.runtime.MessageSender {
    return {
      id: chrome.runtime.id,
      tab: { id: 7, windowId: 3 } as chrome.tabs.Tab,
      frameId: 0,
      documentId: "document-a",
    };
  }

  async function initialize(): Promise<void> {
    const { initQuickPanelAgentHandler } =
      await import("@/entrypoints/background/quick-panel/agent-handler");
    initQuickPanelAgentHandler();
    await vi.waitFor(() =>
      expect(chrome.storage.session.get).toHaveBeenCalled(),
    );
  }

  it("does not subscribe or dispatch before the owner and alarm are durable", async () => {
    await initialize();
    const write = deferred<void>();
    vi.mocked(chrome.storage.session.set).mockImplementationOnce(
      async (items) => {
        await write.promise;
        Object.assign(storageState, structuredClone(items));
      },
    );
    const sendResponse = vi.fn();

    runtimeListeners[0]!(
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_SEND_TO_AI,
        authorizationToken: "token",
        payload: { instruction: "Review this page" },
      },
      sender(),
      sendResponse,
    );

    await vi.waitFor(() =>
      expect(chrome.storage.session.set).toHaveBeenCalledOnce(),
    );
    expect(alarms.size).toBe(1);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(nativeHostMocks.subscribeAgentStream).not.toHaveBeenCalled();
    expect(nativeHostMocks.requestAgentRpcFetch).not.toHaveBeenCalled();

    write.resolve();
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(nativeHostMocks.subscribeAgentStream).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() => {
      expect(
        nativeHostMocks.requestAgentRpcFetch.mock.calls.some(
          ([request]) => request.operation === "agent.chat.act",
        ),
      ).toBe(true);
    });
  });

  it("persists one terminal event and waits for exact-document delivery before deletion", async () => {
    const subscription = deferred<{ subscriptionId: string }>();
    nativeHostMocks.subscribeAgentStream.mockReturnValue(subscription.promise);
    const terminalDelivery = deferred<unknown>();
    vi.mocked(chrome.tabs.sendMessage).mockReturnValue(
      terminalDelivery.promise,
    );
    await initialize();

    const sendResponse = vi.fn();
    runtimeListeners[0]!(
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_SEND_TO_AI,
        authorizationToken: "token",
        payload: { instruction: "Review this page" },
      },
      sender(),
      sendResponse,
    );
    await vi.waitFor(() =>
      expect(nativeHostMocks.subscribeAgentStream).toHaveBeenCalledOnce(),
    );
    const requestId = sendResponse.mock.calls[0]![0].requestId as string;
    const subscriptionId = nativeHostMocks.subscribeAgentStream.mock
      .calls[0]![1].subscriptionId as string;
    const terminalMessage = {
      type: BACKGROUND_MESSAGE_TYPES.AGENT_STREAM_EVENT,
      payload: {
        subscriptionId,
        event: {
          type: "status",
          data: {
            sessionId: "session-1",
            requestId,
            status: "completed",
            message: "Done",
          },
        },
      },
    };

    runtimeListeners[1]!(terminalMessage, { id: chrome.runtime.id }, vi.fn());
    runtimeListeners[1]!(terminalMessage, { id: chrome.runtime.id }, vi.fn());
    await vi.waitFor(() => {
      expect(storageState["agent-request-owners-v1"]).toMatchObject({
        [`quick-panel:${requestId}`]: {
          phase: "terminal",
          status: "completed",
        },
      });
      expect(chrome.tabs.sendMessage).toHaveBeenCalledOnce();
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ requestId }),
      { frameId: 0, documentId: "document-a" },
    );

    subscription.resolve({ subscriptionId });
    await Promise.resolve();
    expect(
      nativeHostMocks.requestAgentRpcFetch.mock.calls.some(
        ([request]) => request.operation === "agent.chat.act",
      ),
    ).toBe(false);
    expect(storageState["agent-request-owners-v1"]).toBeDefined();

    terminalDelivery.resolve(undefined);
    await vi.waitFor(() =>
      expect(storageState["agent-request-owners-v1"]).toBeUndefined(),
    );
    expect(chrome.tabs.sendMessage).toHaveBeenCalledOnce();
  });

  it("fails closed on restart and retains cancel-pending ownership until cancellation is confirmed", async () => {
    const now = Date.now();
    storageState["agent-request-owners-v1"] = {
      "quick-panel:request-restart": {
        version: 1,
        surface: "quick-panel",
        requestId: "request-restart",
        sessionId: "session-1",
        tabId: 7,
        frameId: 0,
        documentId: "document-a",
        createdAt: now - 1_000,
        deadlineAt: now + 60_000,
        phase: "streaming",
        status: "running",
      },
    };
    nativeHostMocks.requestAgentRpcFetch.mockResolvedValue({
      ok: false,
      statusCode: 503,
      json: {},
      body: "offline",
    });

    await initialize();
    await vi.waitFor(() => {
      expect(
        nativeHostMocks.requestAgentRpcFetch.mock.calls.some(
          ([request]) => request.operation === "agent.chat.cancelRequest",
        ),
      ).toBe(true);
    });
    expect(storageState["agent-request-owners-v1"]).toMatchObject({
      "quick-panel:request-restart": {
        phase: "cancel-pending",
        status: "interrupted",
      },
    });
    expect(alarms.size).toBe(1);
    expect(nativeHostMocks.subscribeAgentStream).not.toHaveBeenCalled();
    expect(
      nativeHostMocks.requestAgentRpcFetch.mock.calls.some(
        ([request]) => request.operation === "agent.chat.act",
      ),
    ).toBe(false);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ requestId: "request-restart" }),
      { frameId: 0, documentId: "document-a" },
    );

    const cancelCallsBeforeClose =
      nativeHostMocks.requestAgentRpcFetch.mock.calls.length;
    tabRemovedListeners[0]!(7, { windowId: 3, isWindowClosing: false });
    await vi.waitFor(() => {
      expect(
        nativeHostMocks.requestAgentRpcFetch.mock.calls.length,
      ).toBeGreaterThan(cancelCallsBeforeClose);
    });
    expect(storageState["agent-request-owners-v1"]).toBeDefined();

    runtimeListeners = [];
    alarmListeners = [];
    tabRemovedListeners = [];
    vi.resetModules();
    nativeHostMocks.requestAgentRpcFetch.mockResolvedValue({
      ok: true,
      statusCode: 200,
      json: {},
      body: "",
    });
    await initialize();
    await vi.waitFor(() =>
      expect(storageState["agent-request-owners-v1"]).toBeUndefined(),
    );
    expect(nativeHostMocks.subscribeAgentStream).not.toHaveBeenCalled();
  });

  it("expires an unconfirmable cancellation at its hard deadline without leaking an owner", async () => {
    const now = 2_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    storageState["agent-request-owners-v1"] = {
      "quick-panel:request-expired": {
        version: 1,
        surface: "quick-panel",
        requestId: "request-expired",
        sessionId: "session-1",
        tabId: 7,
        frameId: 0,
        documentId: "document-a",
        createdAt: now - 30 * 60 * 1_000,
        deadlineAt: now,
        phase: "cancel-pending",
        status: "interrupted",
      },
    };
    nativeHostMocks.requestAgentRpcFetch.mockResolvedValue({
      ok: false,
      statusCode: 503,
      json: {},
      body: "offline",
    });

    try {
      await initialize();
      await vi.waitFor(() =>
        expect(storageState["agent-request-owners-v1"]).toBeUndefined(),
      );
      expect(
        nativeHostMocks.requestAgentRpcFetch.mock.calls.some(
          ([request]) => request.operation === "agent.chat.cancelRequest",
        ),
      ).toBe(false);
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ requestId: "request-expired" }),
        { frameId: 0, documentId: "document-a" },
      );
      expect(alarms.size).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it.each([
    ["a missing frame", null],
    ["a replaced document", { documentId: "new-document" }],
  ])("does not deliver recovered events to %s", async (_label, frameResult) => {
    const now = Date.now();
    storageState["agent-request-owners-v1"] = {
      "quick-panel:terminal-orphan": {
        version: 1,
        surface: "quick-panel",
        requestId: "terminal-orphan",
        sessionId: "session-1",
        tabId: 7,
        frameId: 0,
        documentId: "old-document",
        createdAt: now - 1_000,
        deadlineAt: now + 60_000,
        phase: "terminal",
        status: "completed",
      },
      "quick-panel:running-orphan": {
        version: 1,
        surface: "quick-panel",
        requestId: "running-orphan",
        sessionId: "session-1",
        tabId: 7,
        frameId: 0,
        documentId: "old-document",
        createdAt: now - 1_000,
        deadlineAt: now + 60_000,
        phase: "streaming",
        status: "running",
      },
    };
    vi.mocked(chrome.webNavigation.getFrame).mockResolvedValue(
      frameResult as chrome.webNavigation.GetFrameResultDetails | null,
    );
    nativeHostMocks.requestAgentRpcFetch.mockResolvedValue({
      ok: false,
      statusCode: 503,
      json: {},
      body: "offline",
    });

    await initialize();
    await vi.waitFor(() => {
      expect(
        nativeHostMocks.requestAgentRpcFetch.mock.calls.some(
          ([request]) => request.operation === "agent.chat.cancelRequest",
        ),
      ).toBe(true);
    });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(storageState["agent-request-owners-v1"]).not.toHaveProperty(
      "quick-panel:terminal-orphan",
    );
    expect(storageState["agent-request-owners-v1"]).toMatchObject({
      "quick-panel:running-orphan": { phase: "cancel-pending" },
    });
  });

  it("retains and rearms a terminal owner when its still-live document delivery rejects", async () => {
    vi.mocked(chrome.tabs.sendMessage).mockRejectedValue(
      new Error("temporary delivery failure"),
    );
    await initialize();
    const sendResponse = vi.fn();
    runtimeListeners[0]!(
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_SEND_TO_AI,
        authorizationToken: "token",
        payload: { instruction: "Review this page" },
      },
      sender(),
      sendResponse,
    );
    await vi.waitFor(() => expect(runtimeListeners).toHaveLength(2));
    const requestId = sendResponse.mock.calls[0]![0].requestId as string;
    const subscriptionId = nativeHostMocks.subscribeAgentStream.mock
      .calls[0]![1].subscriptionId as string;

    runtimeListeners[1]!(
      {
        type: BACKGROUND_MESSAGE_TYPES.AGENT_STREAM_EVENT,
        payload: {
          subscriptionId,
          event: {
            type: "status",
            data: { sessionId: "session-1", requestId, status: "completed" },
          },
        },
      },
      { id: chrome.runtime.id },
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(storageState["agent-request-owners-v1"]).toMatchObject({
        [`quick-panel:${requestId}`]: { phase: "terminal" },
      });
      expect(alarms.size).toBe(1);
    });
  });

  it("rearms an early deadline and cancels only once after the absolute timeout", async () => {
    let now = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await initialize();
      const sendResponse = vi.fn();
      runtimeListeners[0]!(
        {
          type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_SEND_TO_AI,
          authorizationToken: "token",
          payload: { instruction: "Review this page" },
        },
        sender(),
        sendResponse,
      );
      await vi.waitFor(() =>
        expect(nativeHostMocks.subscribeAgentStream).toHaveBeenCalledOnce(),
      );
      const alarmName = [...alarms.keys()][0]!;

      now += 1_000;
      alarmListeners[0]!({ name: alarmName, scheduledTime: now });
      await vi.waitFor(() =>
        expect(chrome.alarms.create).toHaveBeenCalledTimes(2),
      );
      expect(
        nativeHostMocks.requestAgentRpcFetch.mock.calls.some(
          ([request]) => request.operation === "agent.chat.cancelRequest",
        ),
      ).toBe(false);

      now += 15 * 60 * 1_000;
      alarmListeners[0]!({ name: alarmName, scheduledTime: now });
      await vi.waitFor(() => {
        expect(
          nativeHostMocks.requestAgentRpcFetch.mock.calls.filter(
            ([request]) => request.operation === "agent.chat.cancelRequest",
          ),
        ).toHaveLength(1);
        expect(storageState["agent-request-owners-v1"]).toBeUndefined();
      });

      alarmListeners[0]!({ name: alarmName, scheduledTime: now });
      await Promise.resolve();
      expect(
        nativeHostMocks.requestAgentRpcFetch.mock.calls.filter(
          ([request]) => request.operation === "agent.chat.cancelRequest",
        ),
      ).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
