import { beforeEach, describe, expect, it, vi } from "vitest";

import { BACKGROUND_MESSAGE_TYPES } from "@/common/message-types";

const nativeHostMocks = vi.hoisted(() => ({
  requestAgentRpcFetch: vi.fn(),
  subscribeAgentStream: vi.fn(),
  unsubscribeAgentStream: vi.fn(),
}));
const authorizationMocks = vi.hoisted(() => ({
  consumePrivilegedUiAuthorization: vi.fn(),
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

describe("Web Editor status owner cleanup", () => {
  let requestListener: RequestListener | undefined;
  let tabRemovedListener:
    | ((tabId: number, removeInfo: chrome.tabs.TabRemoveInfo) => void)
    | undefined;
  let selectedSessionCount: number;
  let requestCount: number;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    requestListener = undefined;
    tabRemovedListener = undefined;
    selectedSessionCount = 0;
    requestCount = 0;
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
    nativeHostMocks.requestAgentRpcFetch.mockImplementation(async () => {
      requestCount += 1;
      return {
        ok: true,
        statusCode: 200,
        json: { requestId: `request-${requestCount}` },
        body: "",
      };
    });
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        selectedSessionCount += 1;
        return {
          "agent-selected-session-id": `session-${selectedSessionCount}`,
        };
      },
    );
    chrome.storage.session = {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof chrome.storage.session;
    vi.mocked(chrome.tabs.onRemoved.addListener).mockImplementation(
      (listener) => {
        tabRemovedListener = listener;
      },
    );
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation(
      (listener) => {
        if (!requestListener) requestListener = listener as RequestListener;
      },
    );

    const { initWebEditorListeners } =
      await import("@/entrypoints/background/web-editor");
    initWebEditorListeners();
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

  async function apply(index: number): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const keepChannelOpen = requestListener!(
        {
          type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_APPLY,
          authorizationToken: `apply-token-${index}`,
          payload: {
            pageUrl: "https://example.com/editor",
            fingerprint: { tag: "button", classes: [] },
            instruction: {
              type: "update_text",
              description: `Update text ${index}`,
              text: `Save ${index}`,
            },
          },
        },
        sender(),
        (value) => resolve(value as Record<string, unknown>),
      );
      expect(keepChannelOpen).toBe(true);
    });
  }

  it("closes every owned stream when its tab is removed", async () => {
    await expect(apply(1)).resolves.toMatchObject({ success: true });
    await expect(apply(2)).resolves.toMatchObject({ success: true });
    const subscriptionIds = nativeHostMocks.subscribeAgentStream.mock.calls.map(
      ([, options]) => options.subscriptionId as string,
    );
    expect(subscriptionIds).toHaveLength(2);

    expect(tabRemovedListener).toBeTypeOf("function");
    tabRemovedListener!(7, { windowId: 3, isWindowClosing: false });

    await vi.waitFor(() => {
      expect(nativeHostMocks.unsubscribeAgentStream).toHaveBeenCalledWith(
        subscriptionIds[0],
      );
      expect(nativeHostMocks.unsubscribeAgentStream).toHaveBeenCalledWith(
        subscriptionIds[1],
      );
      expect(
        nativeHostMocks.requestAgentRpcFetch.mock.calls.filter(
          ([request]) => request?.operation === "agent.chat.cancelRequest",
        ),
      ).toHaveLength(2);
    });
  });
});
