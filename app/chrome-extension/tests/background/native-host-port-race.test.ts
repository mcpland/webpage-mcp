import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencyMocks = vi.hoisted(() => ({
  acquireKeepalive: vi.fn(() => vi.fn()),
  clearAllSessionContexts: vi.fn(),
  updateConnectionBadge: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/entrypoints/background/tools", () => ({
  handleCallTool: vi.fn(),
}));
vi.mock("@/entrypoints/background/record-replay-v3", () => ({
  createStoragePort: vi.fn(() => ({
    flows: { list: vi.fn().mockResolvedValue([]) },
  })),
}));
vi.mock("@/entrypoints/background/record-replay-v3/flows/publish", () => ({
  listPublishedFlowDetails: vi.fn(() => []),
}));
vi.mock("@/entrypoints/background/keepalive-manager", () => ({
  acquireKeepalive: dependencyMocks.acquireKeepalive,
}));
vi.mock("@/entrypoints/background/action-badge", () => ({
  updateConnectionBadge: dependencyMocks.updateConnectionBadge,
}));
vi.mock("@/entrypoints/background/first-connect-notification", () => ({
  maybeShowFirstConnectNotification: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/entrypoints/background/session-context", () => ({
  clearAllSessionContexts: dependencyMocks.clearAllSessionContexts,
  clearSessionContextsForTab: vi.fn(),
  clearSessionContextsForWindow: vi.fn(),
}));
vi.mock("@/entrypoints/background/tab-queue", () => ({
  clearTabQueue: vi.fn(),
}));

type DisconnectListener = () => void;

function createNativePort() {
  let disconnectListener: DisconnectListener | undefined;

  return {
    port: {
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      onDisconnect: {
        addListener: vi.fn((listener: DisconnectListener) => {
          disconnectListener = listener;
        }),
        removeListener: vi.fn(),
      },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as chrome.runtime.Port,
    emitDisconnect: () => disconnectListener?.(),
  };
}

describe("native host port lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("ignores a delayed disconnect from a superseded native port", async () => {
    const first = createNativePort();
    const second = createNativePort();
    const third = createNativePort();
    const ports = [first.port, second.port, third.port];
    let runtimeMessageListener:
      | ((
          message: unknown,
          sender: chrome.runtime.MessageSender,
          sendResponse: (value: unknown) => void,
        ) => boolean | void)
      | undefined;

    const storageGet = vi.fn(async (keys?: string | string[]) => {
      const requested = Array.isArray(keys) ? keys : keys ? [keys] : [];
      return Object.fromEntries(
        requested.map((key) => [
          key,
          key === "nativeAutoConnectEnabled" ? false : undefined,
        ]),
      );
    });

    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        lastError: null,
        connectNative: vi.fn(() => ports.shift()),
        getManifest: vi.fn(() => ({ version: "0.9.0" })),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: {
          addListener: vi.fn((listener) => {
            runtimeMessageListener = listener;
          }),
          removeListener: vi.fn(),
        },
        onStartup: { addListener: vi.fn(), removeListener: vi.fn() },
        onInstalled: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: {
        local: {
          get: storageGet,
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: {
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      windows: {
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });

    const { connectNativeHost, initNativeHostListener } =
      await import("@/entrypoints/background/native-host");
    initNativeHostListener();

    await vi.waitFor(() => {
      expect(storageGet).toHaveBeenCalled();
    });
    expect(runtimeMessageListener).toBeTypeOf("function");

    expect(connectNativeHost()).toBe(true);

    const disconnectResponse = vi.fn();
    runtimeMessageListener!(
      { type: "disconnect_native" },
      {} as chrome.runtime.MessageSender,
      disconnectResponse,
    );
    await vi.waitFor(() => {
      expect(disconnectResponse).toHaveBeenCalledWith({ success: true });
    });

    expect(connectNativeHost()).toBe(true);
    first.emitDisconnect();

    expect(connectNativeHost()).toBe(true);
    expect(chrome.runtime.connectNative).toHaveBeenCalledTimes(2);
  });
});
