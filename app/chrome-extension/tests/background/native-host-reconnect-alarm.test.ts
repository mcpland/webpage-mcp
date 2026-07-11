import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeMessageType } from "webpage-mcp-shared";

const dependencyMocks = vi.hoisted(() => ({
  acquireKeepalive: vi.fn(() => vi.fn()),
  updateConnectionBadge: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/entrypoints/background/tools", () => ({
  handleCallTool: vi.fn(),
}));
vi.mock("@/entrypoints/background/record-replay-v3", () => ({
  createStoragePort: vi.fn(() => ({
    flows: { listPublishedDetails: vi.fn().mockResolvedValue([]) },
  })),
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
  clearAllSessionContexts: vi.fn(),
  clearSessionContextsForTab: vi.fn(),
  clearSessionContextsForWindow: vi.fn(),
}));
vi.mock("@/entrypoints/background/tab-queue", () => ({
  clearTabQueue: vi.fn(),
}));

type AlarmListener = (alarm: chrome.alarms.Alarm) => void;
type DisconnectListener = () => void;
type NativeMessageListener = (message: unknown) => void | Promise<void>;
type RuntimeMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

function createReadyNativePort() {
  let disconnectListener: DisconnectListener | undefined;
  let messageListener: NativeMessageListener | undefined;

  const port = {
    onMessage: {
      addListener: vi.fn((listener: NativeMessageListener) => {
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
    postMessage: vi.fn((message: { requestId?: string }) => {
      if (!message.requestId) return;
      queueMicrotask(() => {
        void messageListener?.({
          responseToRequestId: message.requestId,
          payload: { status: "success", instances: [] },
        });
      });
    }),
    disconnect: vi.fn(),
  } as unknown as chrome.runtime.Port;

  return {
    port,
    emitDisconnect: () => disconnectListener?.(),
  };
}

describe("native host reconnect alarm", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("uses one durable alarm, survives a worker restart, and never acquires offscreen keepalive", async () => {
    let currentAlarm: chrome.alarms.Alarm | undefined;
    let alarmListener: AlarmListener | undefined;
    const createAlarm = vi.fn(
      (name: string, info: chrome.alarms.AlarmCreateInfo) => {
        currentAlarm = {
          name,
          scheduledTime: info.when ?? Date.now(),
          periodInMinutes: info.periodInMinutes,
        };
      },
    );
    const clearAlarm = vi.fn(async (name: string) => {
      if (currentAlarm?.name !== name) return false;
      currentAlarm = undefined;
      return true;
    });
    const getAlarm = vi.fn(async (name: string) =>
      currentAlarm?.name === name ? currentAlarm : undefined,
    );
    const firstPort = createReadyNativePort();
    const replacementPort = createReadyNativePort();
    const connectNative = vi.fn(() => firstPort.port);
    const stored: Record<string, unknown> = {
      nativeAutoConnectEnabled: true,
    };

    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        lastError: null,
        connectNative,
        getManifest: vi.fn(() => ({ version: "0.9.0" })),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        onStartup: { addListener: vi.fn(), removeListener: vi.fn() },
        onInstalled: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[]) => {
            const names = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(
              names
                .filter((name) =>
                  Object.prototype.hasOwnProperty.call(stored, name),
                )
                .map((name) => [name, stored[name]]),
            );
          }),
          set: vi.fn(async (values: Record<string, unknown>) => {
            Object.assign(stored, values);
          }),
          remove: vi.fn(async (key: string) => {
            delete stored[key];
          }),
        },
      },
      tabs: { onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } },
      windows: { onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } },
      alarms: {
        create: createAlarm,
        clear: clearAlarm,
        get: getAlarm,
        getAll: vi.fn().mockResolvedValue([]),
        clearAll: vi.fn().mockResolvedValue(true),
        onAlarm: {
          addListener: vi.fn((listener: AlarmListener) => {
            alarmListener = listener;
          }),
          removeListener: vi.fn(),
        },
      },
    });
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const firstWorker = await import("@/entrypoints/background/native-host");
    firstWorker.initNativeHostListener();
    firstWorker.initNativeHostListener();
    await vi.waitFor(() => {
      expect(connectNative).toHaveBeenCalledOnce();
      expect(alarmListener).toBeTypeOf("function");
    });

    firstPort.emitDisconnect();
    await vi.waitFor(() => {
      expect(createAlarm).toHaveBeenCalledWith(
        firstWorker.NATIVE_RECONNECT_ALARM_NAME,
        {
          when: expect.any(Number),
        },
      );
      expect(currentAlarm?.name).toBe(firstWorker.NATIVE_RECONNECT_ALARM_NAME);
    });
    expect(dependencyMocks.acquireKeepalive).not.toHaveBeenCalled();

    // Simulate the first worker being discarded while Chrome retains the
    // one-shot alarm and persisted attempt deadline. An unrelated worker wake
    // must wait for that alarm instead of bypassing the backoff.
    vi.resetModules();
    alarmListener = undefined;
    connectNative.mockImplementation(() => replacementPort.port);
    const restartedWorker =
      await import("@/entrypoints/background/native-host");
    restartedWorker.initNativeHostListener();
    await vi.waitFor(() => {
      expect(alarmListener).toBeTypeOf("function");
    });
    await vi.waitFor(() => {
      expect(getAlarm).toHaveBeenCalledWith(
        restartedWorker.NATIVE_RECONNECT_ALARM_NAME,
      );
    });
    expect(connectNative).toHaveBeenCalledTimes(1);
    expect(createAlarm).toHaveBeenCalledTimes(1);

    const firedAlarm = currentAlarm!;
    currentAlarm = undefined;
    const fireReconnectAlarm = alarmListener as AlarmListener | undefined;
    fireReconnectAlarm?.(firedAlarm);
    await vi.waitFor(() => {
      expect(connectNative).toHaveBeenCalledTimes(2);
      expect(replacementPort.port.postMessage).toHaveBeenCalled();
    });
    expect(dependencyMocks.acquireKeepalive).not.toHaveBeenCalled();
  });

  it("blocks automatic cancel recovery during persisted backoff while explicit UI connect still bypasses it", async () => {
    const now = Date.now();
    const alarmName = "webpage-mcp.native-host.reconnect";
    const stateKey = "webpage-mcp.native-host.reconnect-state.v1";
    let currentAlarm: chrome.alarms.Alarm | undefined = {
      name: alarmName,
      scheduledTime: now + 60_000,
    };
    let runtimeMessageListener: RuntimeMessageListener | undefined;
    const readyPort = createReadyNativePort();
    const connectNative = vi.fn(() => readyPort.port);
    const createAlarm = vi.fn(
      (name: string, info: chrome.alarms.AlarmCreateInfo) => {
        currentAlarm = { name, scheduledTime: info.when ?? Date.now() };
      },
    );
    const clearAlarm = vi.fn(async (name: string) => {
      if (currentAlarm?.name !== name) return false;
      currentAlarm = undefined;
      return true;
    });

    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        lastError: null,
        connectNative,
        getManifest: vi.fn(() => ({ version: "0.9.0" })),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: {
          addListener: vi.fn((listener: RuntimeMessageListener) => {
            runtimeMessageListener = listener;
          }),
          removeListener: vi.fn(),
        },
        onStartup: { addListener: vi.fn(), removeListener: vi.fn() },
        onInstalled: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            nativeAutoConnectEnabled: true,
            [stateKey]: {
              version: 1,
              attempts: 3,
              deadlineMs: currentAlarm.scheduledTime,
            },
          }),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: { onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } },
      windows: { onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } },
      alarms: {
        create: createAlarm,
        clear: clearAlarm,
        get: vi.fn(async (name: string) =>
          currentAlarm?.name === name ? currentAlarm : undefined,
        ),
        onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });

    const nativeHost = await import("@/entrypoints/background/native-host");
    nativeHost.initNativeHostListener();

    await expect(
      nativeHost.requestAgentRpcFetch({
        operation: "agent.chat.cancelRequest",
        params: { sessionId: "session-1", requestId: "request-1" },
      }),
    ).rejects.toThrow("Native host not connected");

    expect(connectNative).not.toHaveBeenCalled();
    expect(currentAlarm?.scheduledTime).toBe(now + 60_000);

    const sendResponse = vi.fn();
    expect(
      runtimeMessageListener?.(
        { type: NativeMessageType.CONNECT_NATIVE },
        { id: "test-extension-id" } as chrome.runtime.MessageSender,
        sendResponse,
      ),
    ).toBe(true);

    await vi.waitFor(() => {
      expect(connectNative).toHaveBeenCalledOnce();
      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, connected: true }),
      );
    });
  });

  it("serializes cancellation behind an in-flight alarm creation", async () => {
    let finishCreate!: () => void;
    const createPending = new Promise<void>((resolve) => {
      finishCreate = resolve;
    });
    let alarmCreated = false;
    const createAlarm = vi.fn(async () => {
      await createPending;
      alarmCreated = true;
    });
    const clearAlarm = vi.fn(async () => {
      const existed = alarmCreated;
      alarmCreated = false;
      return existed;
    });
    const readyPort = createReadyNativePort();
    const connectNative = vi
      .fn<() => chrome.runtime.Port>()
      .mockImplementationOnce(() => {
        throw new Error("native host unavailable");
      })
      .mockImplementation(() => readyPort.port);

    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        lastError: null,
        connectNative,
        getManifest: vi.fn(() => ({ version: "0.9.0" })),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        onStartup: { addListener: vi.fn(), removeListener: vi.fn() },
        onInstalled: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ nativeAutoConnectEnabled: true }),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: { onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } },
      windows: {
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      alarms: {
        create: createAlarm,
        clear: clearAlarm,
        get: vi.fn().mockResolvedValue(undefined),
        onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const nativeHost = await import("@/entrypoints/background/native-host");
    nativeHost.initNativeHostListener();
    await vi.waitFor(() => expect(createAlarm).toHaveBeenCalledOnce());

    expect(nativeHost.connectNativeHost()).toBe(true);
    finishCreate();
    await vi.waitFor(() => expect(clearAlarm).toHaveBeenCalled());

    expect(alarmCreated).toBe(false);
  });

  it("treats an overdue restored alarm as an immediately due attempt", async () => {
    const now = 1_700_000_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const alarmName = "webpage-mcp.native-host.reconnect";
    const stateKey = "webpage-mcp.native-host.reconnect-state.v1";
    let currentAlarm: chrome.alarms.Alarm | undefined = {
      name: alarmName,
      scheduledTime: now - 1,
    };
    const clearAlarm = vi.fn(async () => {
      currentAlarm = undefined;
      return true;
    });
    const connectNative = vi.fn(() => createReadyNativePort().port);

    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        lastError: null,
        connectNative,
        getManifest: vi.fn(() => ({ version: "0.9.0" })),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        onStartup: { addListener: vi.fn(), removeListener: vi.fn() },
        onInstalled: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            nativeAutoConnectEnabled: true,
            [stateKey]: { version: 1, attempts: 4, deadlineMs: now - 1 },
          }),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: { onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } },
      windows: { onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } },
      alarms: {
        create: vi.fn(),
        clear: clearAlarm,
        get: vi.fn(async () => currentAlarm),
        onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });

    try {
      const nativeHost = await import("@/entrypoints/background/native-host");
      nativeHost.initNativeHostListener();

      await vi.waitFor(() => {
        expect(connectNative).toHaveBeenCalledOnce();
      });
      expect(clearAlarm).toHaveBeenCalledWith(
        nativeHost.NATIVE_RECONNECT_ALARM_NAME,
      );
      expect(chrome.alarms.create).not.toHaveBeenCalled();
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("replaces an overlong restored alarm with the bounded deadline", async () => {
    const now = 1_700_000_000_000;
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const alarmName = "webpage-mcp.native-host.reconnect";
    const stateKey = "webpage-mcp.native-host.reconnect-state.v1";
    const overlongDeadline = now + 24 * 60 * 60_000;
    let currentAlarm: chrome.alarms.Alarm | undefined = {
      name: alarmName,
      scheduledTime: overlongDeadline,
    };
    const createAlarm = vi.fn(
      (name: string, info: chrome.alarms.AlarmCreateInfo) => {
        currentAlarm = { name, scheduledTime: info.when ?? now };
      },
    );
    const connectNative = vi.fn(() => createReadyNativePort().port);

    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        lastError: null,
        connectNative,
        getManifest: vi.fn(() => ({ version: "0.9.0" })),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
        onStartup: { addListener: vi.fn(), removeListener: vi.fn() },
        onInstalled: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            nativeAutoConnectEnabled: true,
            [stateKey]: {
              version: 1,
              attempts: Number.MAX_SAFE_INTEGER,
              deadlineMs: overlongDeadline,
            },
          }),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      },
      tabs: { onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } },
      windows: { onRemoved: { addListener: vi.fn(), removeListener: vi.fn() } },
      alarms: {
        create: createAlarm,
        clear: vi.fn().mockResolvedValue(true),
        get: vi.fn(async () => currentAlarm),
        onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });

    try {
      const nativeHost = await import("@/entrypoints/background/native-host");
      nativeHost.initNativeHostListener();

      await vi.waitFor(() => {
        expect(createAlarm).toHaveBeenCalledWith(
          nativeHost.NATIVE_RECONNECT_ALARM_NAME,
          { when: now + 10 * 60_000 },
        );
      });
      expect(currentAlarm?.scheduledTime).toBe(now + 10 * 60_000);
      expect(connectNative).not.toHaveBeenCalled();
    } finally {
      dateSpy.mockRestore();
    }
  });
});
