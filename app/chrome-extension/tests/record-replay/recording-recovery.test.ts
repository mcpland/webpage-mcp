import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TOOL_MESSAGE_TYPES } from "@/common/message-types";
import type { Flow } from "@/entrypoints/background/record-replay/types";
import type {
  RecordingRecoveryCheckpoint,
  RecordingRecoveryStore,
} from "@/entrypoints/background/record-replay/recording/recording-recovery-store";

const recoveryMocks = vi.hoisted(() => ({
  saveFlowToV3: vi.fn(),
}));

vi.mock(
  "@/entrypoints/background/record-replay-v3/compat",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/entrypoints/background/record-replay-v3/compat")
    >()),
    saveFlowToV3: recoveryMocks.saveFlowToV3,
  }),
);

function flow(): Flow {
  const now = new Date().toISOString();
  return {
    id: "flow-recovery",
    name: "Recovered recording",
    version: 1,
    nodes: [],
    edges: [],
    variables: [],
    meta: { createdAt: now, updatedAt: now },
  };
}

function clickStep(id: string) {
  return {
    id,
    type: "click",
    target: {
      selector: "#save",
      candidates: [{ type: "css", value: "#save" }],
    },
  };
}

function event(sessionId: string, id: string, seq: number) {
  return {
    type: TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT,
    payload: { kind: "steps", steps: [clickStep(id)] },
    meta: {
      version: 1,
      sessionId,
      eventId: `evt_${seq}`,
      seq,
    },
  };
}

function sender(): chrome.runtime.MessageSender {
  return {
    tab: { id: 7 } as chrome.tabs.Tab,
    frameId: 0,
    documentId: "document-a",
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function checkpointFixture(sessionId: string): RecordingRecoveryCheckpoint {
  const now = Date.now();
  return {
    id: "active",
    version: 1,
    revision: 1,
    sessionId,
    status: "recording",
    originTabId: 7,
    activeTabs: [{ tabId: 7, documentId: "document-a" }],
    stoppedTabs: [],
    flow: flow(),
    recordingStartedAtMs: now,
    rateWindowStartedAtMs: now,
    rateWindowStepCount: 0,
    stopRetryCount: 0,
    limitReached: null,
    ingest: {
      sessionId,
      sources: [],
      pendingFrameSteps: [],
      lastStepByTab: [],
    },
    createdAt: now,
    updatedAt: now,
    expiresAt: now + 24 * 60 * 60_000,
    nextAlarmAt: now + 60_000,
  };
}

function dispatch(
  handler: Parameters<typeof chrome.runtime.onMessage.addListener>[0],
  message: unknown,
): Promise<any> {
  return new Promise((resolve) => {
    const keepAlive = handler(message, sender(), resolve);
    expect(keepAlive).toBe(true);
  });
}

describe("recording MV3 recovery", () => {
  const sessionStorage = new Map<string, unknown>();
  const managers: Array<{ stopSession(): Promise<unknown> }> = [];

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    sessionStorage.clear();
    recoveryMocks.saveFlowToV3.mockReset();

    vi.mocked(chrome.storage.session.get).mockImplementation(
      async (keys?: any) => {
        const requested = Array.isArray(keys)
          ? keys
          : typeof keys === "string"
            ? [keys]
            : [];
        return Object.fromEntries(
          requested
            .filter((key) => sessionStorage.has(key))
            .map((key) => [key, sessionStorage.get(key)]),
        );
      },
    );
    vi.mocked(chrome.storage.session.set).mockImplementation(async (items) => {
      for (const [key, value] of Object.entries(items))
        sessionStorage.set(key, value);
    });
    vi.mocked(chrome.storage.session.remove).mockImplementation(
      async (keys) => {
        for (const key of Array.isArray(keys) ? keys : [keys])
          sessionStorage.delete(key);
      },
    );
    (chrome.tabs as any).onActivated = {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    };
    (chrome.tabs as any).sendMessage = vi.fn(
      async (_tabId: number, message: any) => {
        if (message?.cmd === "recover") return { success: true, active: true };
        if (message?.action === "rr_recorder_ping") return { status: "pong" };
        if (message?.action === "stop" && message?.requireAck)
          return { ack: true };
        return { ok: true, success: true };
      },
    );
    vi.mocked(chrome.tabs.get).mockResolvedValue({
      id: 7,
      url: "https://example.test/",
    } as any);
    (chrome.webNavigation as any).getAllFrames = vi
      .fn()
      .mockResolvedValue([
        { frameId: 0, documentId: "document-a", url: "https://example.test/" },
      ]);

    const { browserRecordingRecoveryStore } =
      await import("@/entrypoints/background/record-replay/recording/recording-recovery-store");
    await browserRecordingRecoveryStore.clear().catch(() => {});
  });

  afterEach(async () => {
    for (const manager of managers.splice(0))
      await manager.stopSession().catch(() => {});
    vi.useRealTimers();
  });

  it("restores flow and ingest watermarks across a real module reload before acknowledging events", async () => {
    const firstSessionModule =
      await import("@/entrypoints/background/record-replay/recording/session-manager");
    const firstHandlerModule =
      await import("@/entrypoints/background/record-replay/recording/content-message-handler");
    const first = firstSessionModule.recordingSession;
    managers.push(first);
    await first.initializeRecovery();
    await first.startSession(flow(), 7, "document-a");

    const firstHandler =
      firstHandlerModule.createRecorderEventMessageHandler(first);
    const sessionId = first.getSession().sessionId;
    const accepted = await dispatch(
      firstHandler,
      event(sessionId, "step-1", 1),
    );
    expect(accepted).toMatchObject({ ok: true, ack: { highWatermarkSeq: 1 } });

    vi.resetModules();
    const secondSessionModule =
      await import("@/entrypoints/background/record-replay/recording/session-manager");
    const secondHandlerModule =
      await import("@/entrypoints/background/record-replay/recording/content-message-handler");
    const recovered = secondSessionModule.recordingSession;
    managers.push(recovered);
    await recovered.initializeRecovery();

    expect(recovered.getStatus()).toBe("recording");
    expect(recovered.getSession().sessionId).toBe(sessionId);
    expect(recovered.getFlow()?.nodes).toHaveLength(1);

    const recoveredHandler =
      secondHandlerModule.createRecorderEventMessageHandler(recovered);
    const retry = await dispatch(
      recoveredHandler,
      event(sessionId, "step-1", 1),
    );
    expect(retry).toMatchObject({
      ok: true,
      deduped: true,
      ack: { highWatermarkSeq: 1 },
    });
    expect(recovered.getFlow()?.nodes).toHaveLength(1);

    await dispatch(recoveredHandler, event(sessionId, "step-2", 2));
    expect(recovered.getFlow()?.nodes).toHaveLength(2);
  });

  it("checkpoints the initial navigation before the top frame can acknowledge START", async () => {
    const { recordingSession } =
      await import("@/entrypoints/background/record-replay/recording/session-manager");
    const { RecorderManager } =
      await import("@/entrypoints/background/record-replay/recording/recorder-manager");
    managers.push(recordingSession);

    const result = await RecorderManager.start({ name: "Ordered start" }, 7);

    expect(result.success).toBe(true);
    expect(recordingSession.getFlow()?.nodes?.[0]).toMatchObject({
      type: "navigate",
      config: expect.objectContaining({ url: "https://example.test/" }),
    });
    const startCall = vi
      .mocked((chrome.tabs as any).sendMessage)
      .mock.calls.findIndex((call: any[]) => call[1]?.cmd === "start");
    expect(startCall).toBeGreaterThanOrEqual(0);
    const startOrder = vi.mocked((chrome.tabs as any).sendMessage).mock
      .invocationCallOrder[startCall];
    const lastLeaseWriteOrder = vi
      .mocked(chrome.storage.session.set)
      .mock.invocationCallOrder.at(-1);
    expect(lastLeaseWriteOrder).toBeDefined();
    expect(lastLeaseWriteOrder!).toBeLessThan(startOrder);
  });

  it("reserves START synchronously and explicitly rejects a concurrent attempt", async () => {
    const tabLookup = deferred<chrome.tabs.Tab>();
    vi.mocked(chrome.tabs.get).mockImplementationOnce(() => tabLookup.promise);
    const { recordingSession } =
      await import("@/entrypoints/background/record-replay/recording/session-manager");
    const { RecorderManager } =
      await import("@/entrypoints/background/record-replay/recording/recorder-manager");
    managers.push(recordingSession);

    const firstStart = RecorderManager.start({ name: "First start" }, 7);
    const concurrentStart = await RecorderManager.start(
      { name: "Concurrent start" },
      7,
    );

    expect(concurrentStart).toEqual({
      success: false,
      error: "Recording start already in progress",
    });
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalledOnce());
    tabLookup.resolve({
      id: 7,
      url: "https://example.test/",
    } as chrome.tabs.Tab);

    await expect(firstStart).resolves.toEqual({ success: true });
    const startCalls = vi
      .mocked((chrome.tabs as any).sendMessage)
      .mock.calls.filter((call: any[]) => call[1]?.cmd === "start");
    expect(startCalls).toHaveLength(1);
    expect(recordingSession.getFlow()?.name).toBe("First start");
  });

  it("rolls back the captured session when the post-start checkpoint fails", async () => {
    const checkpointWrite = deferred<void>();
    const { browserRecordingRecoveryStore } =
      await import("@/entrypoints/background/record-replay/recording/recording-recovery-store");
    const originalSave = browserRecordingRecoveryStore.save.bind(
      browserRecordingRecoveryStore,
    );
    const saveSpy = vi
      .spyOn(browserRecordingRecoveryStore, "save")
      .mockImplementationOnce(originalSave)
      .mockImplementationOnce(() => checkpointWrite.promise);
    const { recordingNetworkTracker } =
      await import("@/entrypoints/background/record-replay/recording/network-tracker");
    const endSession = vi.spyOn(recordingNetworkTracker, "endSession");
    const { recordingSession } =
      await import("@/entrypoints/background/record-replay/recording/session-manager");
    const { RecorderManager } =
      await import("@/entrypoints/background/record-replay/recording/recorder-manager");
    managers.push(recordingSession);

    const start = RecorderManager.start({ name: "Failed checkpoint" }, 7);

    await vi.waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(2));
    const expectedSessionId = saveSpy.mock.calls[0]?.[0].sessionId;
    expect(expectedSessionId).toBeTruthy();
    expect(recordingSession.getSession()).toMatchObject({
      sessionId: expectedSessionId,
      status: "recording",
    });
    checkpointWrite.reject(new Error("checkpoint unavailable"));

    const result = await start;
    expect(result).toEqual({
      success: false,
      error: "checkpoint unavailable",
    });
    expect(recordingSession.getStatus()).toBe("idle");
    expect(endSession).toHaveBeenCalledOnce();
    const stopCall = vi
      .mocked((chrome.tabs as any).sendMessage)
      .mock.calls.find(
        (call: any[]) =>
          call[1]?.action === "stop" && call[1]?.requireAck === true,
      );
    expect(stopCall?.[1]).toMatchObject({ sessionId: expectedSessionId });
    expect(
      vi
        .mocked((chrome.tabs as any).sendMessage)
        .mock.calls.some((call: any[]) => call[1]?.cmd === "start"),
    ).toBe(false);
  });

  it("stops a possibly-started page before clearing state when the START response is lost", async () => {
    const { recordingSession } =
      await import("@/entrypoints/background/record-replay/recording/session-manager");
    const { RecorderManager } =
      await import("@/entrypoints/background/record-replay/recording/recorder-manager");
    managers.push(recordingSession);
    vi.mocked(chrome.storage.session.remove).mockClear();
    vi.mocked((chrome.tabs as any).sendMessage).mockImplementation(
      async (_tabId: number, message: any) => {
        if (message?.action === "rr_recorder_ping") return { status: "pong" };
        if (message?.cmd === "start") return { success: false };
        if (message?.action === "stop" && message?.requireAck)
          return { ack: true };
        return { success: true, ok: true };
      },
    );

    const result = await RecorderManager.start(
      { name: "Lost START response" },
      7,
    );

    expect(result).toMatchObject({
      success: false,
      error: "Top-frame recorder did not acknowledge START",
    });
    expect(recordingSession.getStatus()).toBe("idle");
    const calls = vi.mocked((chrome.tabs as any).sendMessage).mock.calls;
    const startIndex = calls.findIndex(
      (call: any[]) => call[1]?.cmd === "start",
    );
    const stopIndex = calls.findIndex(
      (call: any[]) =>
        call[1]?.action === "stop" && call[1]?.requireAck === true,
    );
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeGreaterThan(startIndex);
    const stopOrder = vi.mocked((chrome.tabs as any).sendMessage).mock
      .invocationCallOrder[stopIndex];
    const clearOrder = vi
      .mocked(chrome.storage.session.remove)
      .mock.invocationCallOrder.at(-1);
    expect(clearOrder).toBeDefined();
    expect(stopOrder).toBeLessThan(clearOrder!);
  });

  it("reapplies the persisted paused state during a non-resetting control rebind", async () => {
    const firstSessionModule =
      await import("@/entrypoints/background/record-replay/recording/session-manager");
    const first = firstSessionModule.recordingSession;
    managers.push(first);
    await first.initializeRecovery();
    await first.startSession(flow(), 7, "document-a");
    first.pause();
    await first.persistRecoveryState();

    vi.resetModules();
    const { recordingSession: recovered } =
      await import("@/entrypoints/background/record-replay/recording/session-manager");
    const { RecorderManager } =
      await import("@/entrypoints/background/record-replay/recording/recorder-manager");
    managers.push(recovered);
    await RecorderManager.init();

    expect(recovered.getStatus()).toBe("paused");
    expect(vi.mocked((chrome.tabs as any).sendMessage)).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        cmd: "recover",
        meta: expect.objectContaining({
          sessionId: first.getSession().sessionId,
          desiredStatus: "paused",
        }),
      }),
      { documentId: "document-a" },
    );
  });

  it("rolls a failed resume broadcast back to a retryable paused checkpoint", async () => {
    const { recordingSession } =
      await import("@/entrypoints/background/record-replay/recording/session-manager");
    const { RecorderManager } =
      await import("@/entrypoints/background/record-replay/recording/recorder-manager");
    const { browserRecordingRecoveryStore } =
      await import("@/entrypoints/background/record-replay/recording/recording-recovery-store");
    managers.push(recordingSession);
    await recordingSession.initializeRecovery();
    await recordingSession.startSession(flow(), 7, "document-a");
    await RecorderManager.init();
    expect((await RecorderManager.pause()).success).toBe(true);

    vi.mocked((chrome.tabs as any).sendMessage).mockImplementation(
      async (_tabId: number, message: any) => {
        if (message?.cmd === "resume") return { success: false };
        return { success: true, active: true, ok: true };
      },
    );
    const result = await RecorderManager.resume();

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("Resume"),
    });
    expect(recordingSession.getStatus()).toBe("paused");
    expect(await browserRecordingRecoveryStore.load()).toMatchObject({
      status: "paused",
    });
  });

  it("keeps a stopping draft durable until final cleanup while final events can still drain", async () => {
    let checkpoint: RecordingRecoveryCheckpoint | null = null;
    const store: RecordingRecoveryStore = {
      load: vi.fn(async () => checkpoint),
      save: vi.fn(async (value) => {
        checkpoint = structuredClone(value);
      }),
      clear: vi.fn(async () => {
        checkpoint = null;
      }),
    };
    const { RecordingSessionManager } =
      await import("@/entrypoints/background/record-replay/recording/session-manager");
    const first = new RecordingSessionManager({}, store);
    managers.push(first);
    await first.initializeRecovery();
    await first.startSession(flow(), 7, "document-a");
    first.appendSteps([clickStep("step-before-stop") as any]);
    await first.persistRecoveryState();
    first.beginStopping();
    await first.persistRecoveryState();

    const savedCheckpoint = checkpoint as RecordingRecoveryCheckpoint | null;
    expect(savedCheckpoint).toMatchObject({
      status: "stopping",
      sessionId: first.getSession().sessionId,
    });
    expect(savedCheckpoint?.flow.nodes).toHaveLength(1);

    const recovered = new RecordingSessionManager({}, store);
    managers.push(recovered);
    await recovered.initializeRecovery();
    expect(recovered.getStatus()).toBe("stopping");
    expect(recovered.canAcceptSteps()).toBe(true);
    expect(recovered.getFlow()?.nodes).toHaveLength(1);

    await recovered.stopSession();
    expect(checkpoint).toBeNull();
    expect(recovered.getStatus()).toBe("idle");
  });

  it("retains the stopping checkpoint when V3 save fails and clears it only after a retry succeeds", async () => {
    const firstSessionModule =
      await import("@/entrypoints/background/record-replay/recording/session-manager");
    const first = firstSessionModule.recordingSession;
    managers.push(first);
    await first.initializeRecovery();
    await first.startSession(flow(), 7, "document-a");
    first.appendSteps([clickStep("durable-stop-step") as any]);
    first.beginStopping();
    await first.persistRecoveryState();

    vi.resetModules();
    recoveryMocks.saveFlowToV3.mockRejectedValueOnce(
      new Error("temporary V3 failure"),
    );
    const { recordingSession: recovered } =
      await import("@/entrypoints/background/record-replay/recording/session-manager");
    const { RecorderManager } =
      await import("@/entrypoints/background/record-replay/recording/recorder-manager");
    const { browserRecordingRecoveryStore } =
      await import("@/entrypoints/background/record-replay/recording/recording-recovery-store");
    managers.push(recovered);
    await RecorderManager.init();
    await vi.waitFor(() =>
      expect(recoveryMocks.saveFlowToV3).toHaveBeenCalledOnce(),
    );

    expect(recovered.getStatus()).toBe("stopping");
    expect(recovered.getFlow()?.nodes).toHaveLength(1);
    const failedCheckpoint = await browserRecordingRecoveryStore.load();
    expect(failedCheckpoint).toMatchObject({
      status: "stopping",
      stopRetryCount: 1,
      flow: { nodes: [expect.objectContaining({ id: "durable-stop-step" })] },
    });
    const alarm = vi.mocked(chrome.alarms.create).mock.calls.at(-1)?.[1];
    expect(alarm?.when).toBeGreaterThan(Date.now());
    expect(alarm?.when).toBeLessThanOrEqual(Date.now() + 2 * 60_000 + 1_000);

    recoveryMocks.saveFlowToV3.mockImplementationOnce(
      async (value) => value as any,
    );
    const alarmListener = vi
      .mocked(chrome.alarms.onAlarm.addListener)
      .mock.calls.at(-1)?.[0];
    if (!alarmListener)
      throw new Error("recording recovery alarm listener was not registered");
    alarmListener({
      name: "rr-recording-recovery-deadline-v1",
    } as chrome.alarms.Alarm);
    await vi.waitFor(() => expect(recovered.getStatus()).toBe("idle"));

    expect(recovered.getStatus()).toBe("idle");
    expect(await browserRecordingRecoveryStore.load()).toBeNull();
  });

  it("turns a structurally corrupt checkpoint into a terminal recovery error for recorder events", async () => {
    const store: RecordingRecoveryStore = {
      load: vi.fn(async () => ({
        id: "active",
        version: 1,
        status: "recording",
      })),
      save: vi.fn(),
      clear: vi.fn(async () => {}),
    };
    const { RecordingSessionManager } =
      await import("@/entrypoints/background/record-replay/recording/session-manager");
    const { createRecorderEventMessageHandler } =
      await import("@/entrypoints/background/record-replay/recording/content-message-handler");
    const recovered = new RecordingSessionManager({}, store);
    managers.push(recovered);
    const handler = createRecorderEventMessageHandler(recovered);

    await expect(recovered.initializeRecovery()).rejects.toThrow(
      "checkpoint is invalid",
    );
    const response = await dispatch(handler, event("sess_stale", "step-1", 1));

    expect(recovered.getStatus()).toBe("idle");
    expect(recovered.getFlow()).toBeNull();
    expect(store.clear).toHaveBeenCalledOnce();
    expect(response).toMatchObject({ ok: false, code: "RECOVERY_UNAVAILABLE" });
    expect(response).not.toHaveProperty("ignored");
  });

  it("does not publish a checkpoint or lease when the alarm-first write fails", async () => {
    const { browserRecordingRecoveryStore } =
      await import("@/entrypoints/background/record-replay/recording/recording-recovery-store");
    vi.mocked(chrome.alarms.create).mockRejectedValueOnce(
      new Error("alarm unavailable"),
    );

    await expect(
      browserRecordingRecoveryStore.save(
        checkpointFixture("sess-alarm-failure"),
      ),
    ).rejects.toThrow("alarm unavailable");

    expect(sessionStorage.size).toBe(0);
    expect(await browserRecordingRecoveryStore.load()).toBeNull();
  });

  it("treats a present malformed lease as terminal recovery corruption, not normal idle", async () => {
    const { browserRecordingRecoveryStore, RECORDING_RECOVERY_SESSION_KEY } =
      await import("@/entrypoints/background/record-replay/recording/recording-recovery-store");
    const { RecordingSessionManager } =
      await import("@/entrypoints/background/record-replay/recording/session-manager");
    const { createRecorderEventMessageHandler } =
      await import("@/entrypoints/background/record-replay/recording/content-message-handler");
    sessionStorage.set(RECORDING_RECOVERY_SESSION_KEY, {
      version: 1,
      sessionId: "",
    });
    const recovering = new RecordingSessionManager(
      {},
      browserRecordingRecoveryStore,
    );
    managers.push(recovering);

    const response = await dispatch(
      createRecorderEventMessageHandler(recovering),
      event("sess_stale", "step-1", 1),
    );

    expect(response).toMatchObject({ ok: false, code: "RECOVERY_UNAVAILABLE" });
    expect(response).not.toHaveProperty("ignored");
    expect(sessionStorage.has(RECORDING_RECOVERY_SESSION_KEY)).toBe(false);
  });

  it("rejects a valid lease whose IndexedDB checkpoint belongs to another session", async () => {
    const { browserRecordingRecoveryStore, RECORDING_RECOVERY_SESSION_KEY } =
      await import("@/entrypoints/background/record-replay/recording/recording-recovery-store");
    const checkpoint = checkpointFixture("sess-checkpoint");
    await browserRecordingRecoveryStore.save(checkpoint);
    sessionStorage.set(RECORDING_RECOVERY_SESSION_KEY, {
      version: 1,
      sessionId: "sess-other",
      createdAt: checkpoint.createdAt,
      expiresAt: checkpoint.expiresAt,
    });

    await expect(browserRecordingRecoveryStore.load()).rejects.toThrow(
      "does not match its lease",
    );
    expect(sessionStorage.has(RECORDING_RECOVERY_SESSION_KEY)).toBe(false);
  });

  it("serializes writes and ignores cleanup from an older recording session", async () => {
    const { browserRecordingRecoveryStore } =
      await import("@/entrypoints/background/record-replay/recording/recording-recovery-store");
    const oldSession = checkpointFixture("sess-old");
    const newSession = checkpointFixture("sess-new");
    await browserRecordingRecoveryStore.save(oldSession);

    const newWrite = browserRecordingRecoveryStore.save(newSession);
    const staleCleanup = browserRecordingRecoveryStore.clear(
      oldSession.sessionId,
    );
    await Promise.all([newWrite, staleCleanup]);

    expect(await browserRecordingRecoveryStore.load()).toMatchObject({
      sessionId: "sess-new",
    });
  });

  it("does not let delayed cleanup reset a replacement session", async () => {
    const clearStarted = deferred<void>();
    const allowClear = deferred<void>();
    const store: RecordingRecoveryStore = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      clear: vi.fn(async () => {
        clearStarted.resolve();
        await allowClear.promise;
      }),
    };
    const { RecordingSessionManager } =
      await import("@/entrypoints/background/record-replay/recording/session-manager");
    const manager = new RecordingSessionManager({}, store);
    managers.push(manager);
    await manager.initializeRecovery();
    const oldSessionId = await manager.startSession(
      { ...flow(), id: "old-flow" },
      7,
      "document-a",
    );

    const staleCleanup = manager.stopSession(oldSessionId);
    await clearStarted.promise;
    const replacementStart = manager.startSession(
      { ...flow(), id: "replacement-flow", name: "Replacement" },
      8,
      "document-b",
    );
    const replacementSessionId = manager.getSession().sessionId;
    expect(replacementSessionId).not.toBe(oldSessionId);
    allowClear.resolve();

    await expect(staleCleanup).resolves.toBeNull();
    await expect(replacementStart).resolves.toBe(replacementSessionId);
    expect(manager.getSession()).toMatchObject({
      sessionId: replacementSessionId,
      status: "recording",
      originTabId: 8,
    });
    expect(manager.getFlow()?.id).toBe("replacement-flow");
    expect(store.clear).toHaveBeenCalledWith(oldSessionId);
  });

  it("fails events closed while recovery storage is unavailable instead of replying ignored", async () => {
    const store: RecordingRecoveryStore = {
      load: vi.fn(async () => {
        throw new Error("IndexedDB unavailable");
      }),
      save: vi.fn(),
      clear: vi.fn(),
    };
    const { RecordingSessionManager } =
      await import("@/entrypoints/background/record-replay/recording/session-manager");
    const { createRecorderEventMessageHandler } =
      await import("@/entrypoints/background/record-replay/recording/content-message-handler");
    const recovering = new RecordingSessionManager({}, store);
    managers.push(recovering);
    const handler = createRecorderEventMessageHandler(recovering);

    const response = await dispatch(
      handler,
      event("sess_unknown", "step-1", 1),
    );

    expect(response).toMatchObject({ ok: false, code: "RECOVERY_UNAVAILABLE" });
    expect(response).not.toHaveProperty("ignored");
  });
});
