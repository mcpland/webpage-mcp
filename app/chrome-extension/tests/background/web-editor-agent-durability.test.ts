import { beforeEach, describe, expect, it, vi } from "vitest";

import { BACKGROUND_MESSAGE_TYPES } from "@/common/message-types";

const nativeHostMocks = vi.hoisted(() => ({
  requestAgentRpcFetch: vi.fn(),
  subscribeAgentStream: vi.fn(),
  unsubscribeAgentStream: vi.fn(),
}));
const authorizationMocks = vi.hoisted(() => ({
  addPrivilegedUiSurfaceDeactivationListener: vi.fn(() => vi.fn()),
  consumePrivilegedUiAuthorization: vi.fn(() => true),
  validatePrivilegedUiSurfaceSession: vi.fn(async () => true),
}));
const sidepanelMocks = vi.hoisted(() => ({ openAgentSetupSidepanel: vi.fn() }));
const propsInjectionMocks = vi.hoisted(() => ({
  initPropsAgentEarlyInjectionNavigationLifecycle: vi.fn(),
  pruneOrphanedPropsAgentEarlyInjections: vi.fn(),
  registerPropsAgentEarlyInjection: vi.fn(),
  releasePropsAgentEarlyInjection: vi.fn(),
}));

vi.mock("@/entrypoints/background/native-host", () => nativeHostMocks);
vi.mock(
  "@/entrypoints/background/privileged-ui-authorization",
  () => authorizationMocks,
);
vi.mock("@/entrypoints/background/utils/sidepanel", () => sidepanelMocks);
vi.mock(
  "@/entrypoints/background/web-editor/props-early-injection",
  () => propsInjectionMocks,
);

type RuntimeListener = Parameters<
  typeof chrome.runtime.onMessage.addListener
>[0];
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

describe("Web Editor Agent durable lifecycle", () => {
  let storageState: Record<string, unknown>;
  let runtimeListeners: RuntimeListener[];
  let userScriptListeners: RuntimeListener[];
  let tabRemovedListeners: TabRemovedListener[];
  let alarms: Map<string, chrome.alarms.AlarmCreateInfo>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    storageState = {};
    runtimeListeners = [];
    userScriptListeners = [];
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
    vi.mocked(
      chrome.runtime.onUserScriptMessage.addListener,
    ).mockImplementation((listener) => {
      userScriptListeners.push(listener);
    });
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
    vi.mocked(chrome.alarms.create).mockImplementation(async (name, info) => {
      alarms.set(name, info);
    });
    vi.mocked(chrome.alarms.clear).mockImplementation(async (name?: string) => {
      if (name) alarms.delete(name);
    });

    authorizationMocks.consumePrivilegedUiAuthorization.mockReturnValue(true);
    sidepanelMocks.openAgentSetupSidepanel.mockResolvedValue(undefined);
    propsInjectionMocks.pruneOrphanedPropsAgentEarlyInjections.mockResolvedValue(
      undefined,
    );
    propsInjectionMocks.releasePropsAgentEarlyInjection.mockResolvedValue(
      undefined,
    );
    nativeHostMocks.unsubscribeAgentStream.mockResolvedValue(undefined);
    nativeHostMocks.subscribeAgentStream.mockImplementation(
      async (_sessionId: string, options: { subscriptionId: string }) => ({
        subscriptionId: options.subscriptionId,
      }),
    );
    nativeHostMocks.requestAgentRpcFetch.mockResolvedValue({
      ok: true,
      statusCode: 200,
      json: {},
      body: "",
    });
  });

  function sender(): chrome.runtime.MessageSender {
    return {
      id: chrome.runtime.id,
      tab: {
        id: 7,
        windowId: 3,
        url: "https://example.com/editor",
      } as chrome.tabs.Tab,
      frameId: 0,
      documentId: "document-a",
    };
  }

  async function initialize(): Promise<void> {
    const { initWebEditorListeners } =
      await import("@/entrypoints/background/web-editor");
    initWebEditorListeners();
    await vi.waitFor(() =>
      expect(chrome.storage.session.get).toHaveBeenCalled(),
    );
  }

  function apply(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      expect(
        userScriptListeners[0]!(
          {
            type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_APPLY,
            surfaceSessionId: "aa".repeat(32),
            authorizationToken: "apply-token",
            payload: {
              pageUrl: "https://example.com/editor",
              fingerprint: { tag: "button", classes: [] },
              instruction: {
                type: "update_text",
                description: "Update the button label",
                text: "Save",
              },
            },
          },
          sender(),
          (value) => resolve(value as Record<string, unknown>),
        ),
      ).toBe(true);
    });
  }

  it("does not subscribe or dispatch until the owner and deadline are durable", async () => {
    await initialize();
    const write = deferred<void>();
    vi.mocked(chrome.storage.session.set).mockImplementationOnce(
      async (items) => {
        await write.promise;
        Object.assign(storageState, structuredClone(items));
      },
    );

    const response = apply();
    await vi.waitFor(() =>
      expect(chrome.storage.session.set).toHaveBeenCalledOnce(),
    );
    expect(alarms.size).toBe(1);
    expect(nativeHostMocks.subscribeAgentStream).not.toHaveBeenCalled();
    expect(nativeHostMocks.requestAgentRpcFetch).not.toHaveBeenCalled();

    write.resolve();
    await expect(response).resolves.toMatchObject({
      success: true,
      requestId: expect.any(String),
    });
    expect(nativeHostMocks.subscribeAgentStream).toHaveBeenCalledOnce();
    const act = nativeHostMocks.requestAgentRpcFetch.mock.calls.find(
      ([request]) => request.operation === "agent.chat.act",
    )?.[0];
    expect(act).toBeDefined();
    expect(JSON.parse(act.body).requestId).toBe(
      nativeHostMocks.subscribeAgentStream.mock.calls[0]![1].subscriptionId.replace(
        /^web-editor-session-1-/,
        "",
      ),
    );
  });

  it("accepts only the exact request terminal during subscribe and never dispatches afterward", async () => {
    const subscription = deferred<{ subscriptionId: string }>();
    nativeHostMocks.subscribeAgentStream.mockReturnValue(subscription.promise);
    await initialize();

    const response = apply();
    await vi.waitFor(() =>
      expect(nativeHostMocks.subscribeAgentStream).toHaveBeenCalledOnce(),
    );
    const requestedSubscriptionId = nativeHostMocks.subscribeAgentStream.mock
      .calls[0]![1].subscriptionId as string;
    const ledger = storageState["agent-request-owners-v1"] as Record<
      string,
      any
    >;
    const [ownerKey] = Object.keys(ledger);
    const requestId = ledger[ownerKey]!.requestId as string;
    const streamListener = runtimeListeners[1]!;
    const relay = (event: unknown): void => {
      streamListener(
        {
          type: BACKGROUND_MESSAGE_TYPES.AGENT_STREAM_EVENT,
          payload: { subscriptionId: requestedSubscriptionId, event },
        },
        { id: chrome.runtime.id },
        vi.fn(),
      );
    };

    relay({ type: "status", data: { status: "completed" } });
    relay({
      type: "status",
      data: { requestId: "wrong-request", status: "completed" },
    });
    expect(
      (storageState["agent-request-owners-v1"] as Record<string, any>)[
        ownerKey
      ],
    ).toMatchObject({
      phase: "reserved",
    });

    relay({
      type: "status",
      data: {
        sessionId: "session-1",
        requestId,
        status: "completed",
        message: "Done",
      },
    });
    relay({
      type: "status",
      data: {
        sessionId: "session-1",
        requestId,
        status: "completed",
        message: "Duplicate",
      },
    });
    await vi.waitFor(() => {
      expect(
        (storageState["agent-request-owners-v1"] as Record<string, any>)[
          ownerKey
        ],
      ).toMatchObject({
        phase: "terminal",
        status: "completed",
        message: "Done",
      });
    });

    subscription.resolve({ subscriptionId: requestedSubscriptionId });
    await expect(response).resolves.toMatchObject({ success: false });
    expect(
      nativeHostMocks.requestAgentRpcFetch.mock.calls.some(
        ([request]) => request.operation === "agent.chat.act",
      ),
    ).toBe(false);

    const statusResponse = vi.fn();
    userScriptListeners[0]!(
      {
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_STATUS_QUERY,
        surfaceSessionId: "aa".repeat(32),
        requestId,
        sessionId: "session-1",
      },
      sender(),
      statusResponse,
    );
    await vi.waitFor(() => {
      expect(statusResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          status: "completed",
          message: "Done",
        }),
      );
    });
    expect(nativeHostMocks.unsubscribeAgentStream).toHaveBeenCalledWith(
      requestedSubscriptionId,
    );
  });

  it.each([
    ["native rejection", () => Promise.reject(new Error("native unavailable"))],
    [
      "mismatched subscription ID",
      () => Promise.resolve({ subscriptionId: "unexpected-subscription" }),
    ],
  ])("cleans the unsent reservation on %s", async (_label, subscribe) => {
    nativeHostMocks.subscribeAgentStream.mockImplementationOnce(subscribe);
    await initialize();

    await expect(apply()).resolves.toMatchObject({ success: false });
    expect(
      nativeHostMocks.requestAgentRpcFetch.mock.calls.some(
        ([request]) => request.operation === "agent.chat.act",
      ),
    ).toBe(false);
    expect(storageState["agent-request-owners-v1"]).toBeUndefined();
    expect(alarms.size).toBe(0);
  });

  it("recovers a running owner by retaining cancel-pending state when transport is unknown", async () => {
    const now = Date.now();
    storageState["agent-request-owners-v1"] = {
      "web-editor:request-restart": {
        version: 1,
        surface: "web-editor",
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
      expect(storageState["agent-request-owners-v1"]).toMatchObject({
        "web-editor:request-restart": { phase: "cancel-pending" },
      });
    });
    expect(nativeHostMocks.subscribeAgentStream).not.toHaveBeenCalled();
    expect(
      nativeHostMocks.requestAgentRpcFetch.mock.calls.some(
        ([request]) => request.operation === "agent.chat.act",
      ),
    ).toBe(false);

    tabRemovedListeners[0]!(7, { windowId: 3, isWindowClosing: false });
    await vi.waitFor(() => {
      expect(
        nativeHostMocks.requestAgentRpcFetch.mock.calls.filter(
          ([request]) => request.operation === "agent.chat.cancelRequest",
        ).length,
      ).toBeGreaterThanOrEqual(2);
    });
    expect(storageState["agent-request-owners-v1"]).toBeDefined();
  });

  it("terminalizes a cancellation that reaches its hard retry deadline", async () => {
    const now = 2_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    storageState["agent-request-owners-v1"] = {
      "web-editor:request-expired": {
        version: 1,
        surface: "web-editor",
        requestId: "request-expired",
        sessionId: "session-1",
        tabId: 7,
        frameId: 0,
        documentId: "document-a",
        createdAt: now - 30 * 60 * 1_000,
        deadlineAt: now,
        phase: "cancel-pending",
        status: "running",
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
      await vi.waitFor(() => {
        expect(storageState["agent-request-owners-v1"]).toMatchObject({
          "web-editor:request-expired": {
            phase: "terminal",
            status: "failed",
            deadlineAt: now + 5 * 60 * 1_000,
          },
        });
      });
      expect(
        nativeHostMocks.requestAgentRpcFetch.mock.calls.some(
          ([request]) => request.operation === "agent.chat.cancelRequest",
        ),
      ).toBe(false);
      expect(alarms.size).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
