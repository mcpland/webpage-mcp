import { beforeEach, describe, expect, it, vi } from "vitest";

import { BACKGROUND_MESSAGE_TYPES } from "@/common/message-types";

const nativeHostMocks = vi.hoisted(() => ({
  requestAgentRpcFetch: vi.fn(),
  subscribeAgentStream: vi.fn(),
  unsubscribeAgentStream: vi.fn(),
}));
const authorizationMocks = vi.hoisted(() => ({
  consumePrivilegedUiAuthorization: vi.fn(),
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

type RequestListener = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (value: any) => void,
) => boolean | undefined;

function locator(): Record<string, unknown> {
  return {
    selectors: ["button.primary"],
    fingerprint: "button.primary",
    path: [0, 1],
  };
}

function element(): Record<string, unknown> {
  return {
    elementKey: "button-1",
    label: "button.primary",
    fullLabel: "body > button.primary",
    locator: locator(),
    type: "text",
    changes: { text: { beforePreview: "Old", afterPreview: "New" } },
    transactionIds: ["tx-1"],
    netEffect: {
      elementKey: "button-1",
      locator: locator(),
      textChange: { before: "Old", after: "New" },
    },
    updatedAt: 100,
  };
}

function txPayload(): Record<string, unknown> {
  return {
    tabId: 0,
    action: "push",
    elements: [element()],
    undoCount: 1,
    redoCount: 0,
    hasApplicableChanges: true,
    pageUrl: "https://example.com/editor",
  };
}

function selectionPayload(): Record<string, unknown> {
  return {
    tabId: 0,
    selected: {
      elementKey: "button-1",
      locator: locator(),
      label: "button.primary",
      fullLabel: "body > button.primary",
      tagName: "button",
      updatedAt: 100,
    },
    pageUrl: "https://example.com/editor",
  };
}

function contentSender(): chrome.runtime.MessageSender {
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

describe("Web Editor session payload boundaries", () => {
  let requestListener: RequestListener | undefined;
  let sessionSet: ReturnType<typeof vi.fn>;
  let sessionRemove: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    requestListener = undefined;
    sessionSet = vi.fn().mockResolvedValue(undefined);
    sessionRemove = vi.fn().mockResolvedValue(undefined);
    chrome.storage.session = {
      get: vi.fn().mockResolvedValue({}),
      set: sessionSet,
      remove: sessionRemove,
    } as unknown as typeof chrome.storage.session;
    propsInjectionMocks.pruneOrphanedPropsAgentEarlyInjections.mockResolvedValue(
      undefined,
    );
    propsInjectionMocks.releasePropsAgentEarlyInjection.mockResolvedValue(
      undefined,
    );
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
    vi.mocked(
      chrome.runtime.onUserScriptMessage.addListener,
    ).mockImplementation((listener) => {
      if (!requestListener) requestListener = listener as RequestListener;
    });

    const { initWebEditorListeners } =
      await import("@/entrypoints/background/web-editor");
    initWebEditorListeners();
  });

  async function send(
    type: string,
    payload: unknown,
  ): Promise<Record<string, unknown>> {
    const sendResponse = vi.fn();
    expect(
      requestListener!(
        { type, payload, surfaceSessionId: "aa".repeat(32) },
        contentSender(),
        sendResponse,
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    return sendResponse.mock.calls[0]![0] as Record<string, unknown>;
  }

  it("stores and broadcasts only the TX_CHANGED schema fields", async () => {
    const payload = txPayload();
    payload.arbitraryObject = { shouldNotPersist: true };
    (payload.elements as Record<string, unknown>[])[0]!.arbitraryNestedObject =
      {
        shouldNotPersist: true,
      };

    await expect(
      send(BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED, payload),
    ).resolves.toEqual({
      success: true,
    });

    expect(sessionSet).toHaveBeenCalledOnce();
    const stored = sessionSet.mock.calls[0]![0]["web-editor-tx-changed-7"];
    expect(stored).toMatchObject({
      tabId: 7,
      action: "push",
      undoCount: 1,
      redoCount: 0,
      hasApplicableChanges: true,
    });
    expect(stored).not.toHaveProperty("arbitraryObject");
    expect(stored.elements[0]).not.toHaveProperty("arbitraryNestedObject");
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED,
      payload: stored,
    });
  });

  it("rejects invalid TX fields and total bytes before session storage", async () => {
    const invalidAction = await send(
      BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED,
      {
        ...txPayload(),
        action: "execute-arbitrary-object",
      },
    );
    expect(invalidAction).toMatchObject({
      success: false,
      error: expect.stringMatching(/action/),
    });

    const oversized = await send(
      BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED,
      {
        ...txPayload(),
        ignored: Array(5).fill("x".repeat(120 * 1024)),
      },
    );
    expect(oversized).toMatchObject({
      success: false,
      error: expect.stringMatching(/raw JSON byte limit/),
    });
    expect(sessionSet).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("stores only bounded SELECTION_CHANGED fields", async () => {
    const payload = selectionPayload();
    payload.arbitraryObject = { shouldNotPersist: true };
    (payload.selected as Record<string, unknown>).arbitraryNestedObject = {
      shouldNotPersist: true,
    };

    await expect(
      send(BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_SELECTION_CHANGED, payload),
    ).resolves.toEqual({ success: true });

    const stored = sessionSet.mock.calls[0]![0]["web-editor-selection-7"];
    expect(stored).toMatchObject({
      tabId: 7,
      selected: {
        elementKey: "button-1",
        tagName: "button",
      },
      pageUrl: "https://example.com/editor",
    });
    expect(stored).not.toHaveProperty("arbitraryObject");
    expect(stored.selected).not.toHaveProperty("arbitraryNestedObject");
  });

  it("rejects an oversized selection locator before storage or rebroadcast", async () => {
    const payload = selectionPayload();
    (payload.selected as Record<string, any>).locator.selectors =
      Array(17).fill(".selector");

    const response = await send(
      BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_SELECTION_CHANGED,
      payload,
    );

    expect(response).toMatchObject({
      success: false,
      error: expect.stringMatching(/locator\.selectors.*item limit/),
    });
    expect(sessionSet).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("removes selection storage for a schema-valid deselection", async () => {
    await expect(
      send(BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_SELECTION_CHANGED, {
        selected: null,
        pageUrl: "https://example.com/editor",
        ignored: { object: true },
      }),
    ).resolves.toEqual({ success: true });

    expect(sessionRemove).toHaveBeenCalledWith("web-editor-selection-7");
    expect(sessionSet).not.toHaveBeenCalled();
  });
});
