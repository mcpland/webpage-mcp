import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencyMocks = vi.hoisted(() => ({
  acquireKeepalive: vi.fn(() => vi.fn()),
  clearAllSessionContexts: vi.fn(),
  handleCallTool: vi.fn(),
  updateConnectionBadge: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/entrypoints/background/tools", () => ({
  handleCallTool: dependencyMocks.handleCallTool,
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
type MessageListener = (message: any) => void | Promise<void>;

function createNativePort() {
  let disconnectListener: DisconnectListener | undefined;
  let messageListener: MessageListener | undefined;

  return {
    port: {
      onMessage: {
        addListener: vi.fn((listener: MessageListener) => {
          messageListener = listener;
        }),
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
    emitMessage: async (message: any) => await messageListener?.(message),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
        getURL: vi.fn(
          (path = "") =>
            `chrome-extension://test-extension-id/${path.replace(/^\//, "")}`,
        ),
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

    const untrustedResponse = vi.fn();
    expect(
      runtimeMessageListener!(
        { type: "call_tool", name: "chrome_read_page", args: {} },
        {
          id: "test-extension-id",
          tab: { id: 7 },
          url: "https://example.com/",
          origin: "https://example.com",
        } as chrome.runtime.MessageSender,
        untrustedResponse,
      ),
    ).toBe(false);
    expect(dependencyMocks.handleCallTool).not.toHaveBeenCalled();
    expect(untrustedResponse).not.toHaveBeenCalled();

    dependencyMocks.handleCallTool.mockResolvedValueOnce({ ok: true });
    const trustedTabResponse = vi.fn();
    expect(
      runtimeMessageListener!(
        { type: "call_tool", name: "chrome_read_page", args: {} },
        {
          id: "test-extension-id",
          tab: { id: 8 },
          frameId: 0,
          documentId: "options-document",
          url: "chrome-extension://test-extension-id/options.html",
          origin: "chrome-extension://test-extension-id",
        } as chrome.runtime.MessageSender,
        trustedTabResponse,
      ),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(trustedTabResponse).toHaveBeenCalledWith({
        success: true,
        result: { ok: true },
      }),
    );

    const disconnectResponse = vi.fn();
    runtimeMessageListener!(
      { type: "disconnect_native" },
      { id: "test-extension-id" } as chrome.runtime.MessageSender,
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

  it("does not post an old port's delayed tool completion to a replacement port", async () => {
    const first = createNativePort();
    const second = createNativePort();
    const ports = [first.port, second.port];
    const toolResult = deferred<unknown>();
    dependencyMocks.handleCallTool.mockReturnValueOnce(toolResult.promise);

    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        lastError: null,
        connectNative: vi.fn(() => ports.shift()),
        getManifest: vi.fn(() => ({ version: "0.9.0" })),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
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

    const { connectNativeHost } = await import("@/entrypoints/background/native-host");
    expect(connectNativeHost()).toBe(true);

    const oldRequest = first.emitMessage({
      type: "call_tool",
      requestId: "old-request",
      payload: { name: "chrome_read_page", args: {} },
    });
    await vi.waitFor(() => {
      expect(dependencyMocks.handleCallTool).toHaveBeenCalledOnce();
    });
    const oldSignal = dependencyMocks.handleCallTool.mock.calls[0]?.[0]
      ?.signal as AbortSignal;
    expect(oldSignal.aborted).toBe(false);

    first.emitDisconnect();
    expect(oldSignal.aborted).toBe(true);
    expect(connectNativeHost()).toBe(true);

    await oldRequest;
    toolResult.resolve({ content: [{ type: "text", text: "done" }] });
    await Promise.resolve();

    expect(first.port.postMessage).not.toHaveBeenCalled();
    expect(second.port.postMessage).not.toHaveBeenCalled();

    dependencyMocks.handleCallTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "current" }],
    });
    await second.emitMessage({
      type: "call_tool",
      requestId: "current-request",
      payload: { name: "chrome_read_page", args: {} },
    });

    expect(second.port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ responseToRequestId: "current-request" }),
    );
  });

  it("aborts a named tool request without posting a late completion", async () => {
    const native = createNativePort();
    const toolResult = deferred<unknown>();
    dependencyMocks.handleCallTool.mockReturnValueOnce(toolResult.promise);

    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        lastError: null,
        connectNative: vi.fn(() => native.port),
        getManifest: vi.fn(() => ({ version: "0.9.0" })),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: { onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } },
      windows: {
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });

    const { connectNativeHost } =
      await import("@/entrypoints/background/native-host");
    expect(connectNativeHost()).toBe(true);

    const execution = native.emitMessage({
      type: "call_tool",
      requestId: "cancel-me",
      payload: { name: "chrome_read_page", args: {} },
    });
    await vi.waitFor(() => {
      expect(dependencyMocks.handleCallTool).toHaveBeenCalledOnce();
    });
    const signal = dependencyMocks.handleCallTool.mock.calls[0]?.[0]
      ?.signal as AbortSignal;

    await native.emitMessage({
      type: "cancel_request",
      payload: { requestId: "cancel-me", reason: "cancelled" },
    });
    await execution;

    expect(signal.aborted).toBe(true);
    expect(native.port.postMessage).not.toHaveBeenCalled();

    toolResult.resolve({ content: [{ type: "text", text: "too late" }] });
    await Promise.resolve();
    await Promise.resolve();
    expect(native.port.postMessage).not.toHaveBeenCalled();
  });

  it("bounds active tool requests per native port", async () => {
    const native = createNativePort();
    const signals: AbortSignal[] = [];
    dependencyMocks.handleCallTool.mockImplementation(
      ({ signal }: { signal: AbortSignal }) => {
        signals.push(signal);
        return new Promise(() => {});
      },
    );

    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        lastError: null,
        connectNative: vi.fn(() => native.port),
        getManifest: vi.fn(() => ({ version: "0.9.0" })),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: { onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } },
      windows: {
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });

    const { connectNativeHost } =
      await import("@/entrypoints/background/native-host");
    expect(connectNativeHost()).toBe(true);

    const executions = Array.from({ length: 65 }, (_, index) =>
      native.emitMessage({
        type: "call_tool",
        requestId: `request-${index}`,
        payload: { name: "chrome_read_page", args: {} },
      }),
    );
    await vi.waitFor(() => {
      expect(dependencyMocks.handleCallTool).toHaveBeenCalledTimes(64);
      expect(native.port.postMessage).toHaveBeenCalledWith({
        responseToRequestId: "request-64",
        payload: expect.objectContaining({
          status: "error",
          error: "Too many active native tool requests",
        }),
      });
    });

    native.emitDisconnect();
    await Promise.all(executions);
    expect(signals).toHaveLength(64);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});
