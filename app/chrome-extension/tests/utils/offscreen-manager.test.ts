import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("OffscreenManager", () => {
  let alarmListener: ((alarm: chrome.alarms.Alarm) => void) | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("clients", undefined);
    alarmListener = undefined;

    delete (chrome.runtime as unknown as Record<string, unknown>).getContexts;
    chrome.runtime.getURL = vi.fn(
      (path: string) => `chrome-extension://test-extension-id/${path}`,
    );
    chrome.offscreen = {
      createDocument: vi.fn().mockResolvedValue(undefined),
      closeDocument: vi.fn().mockResolvedValue(undefined),
      hasDocument: vi.fn().mockResolvedValue(false),
      Reason: chrome.offscreen?.Reason,
    } as typeof chrome.offscreen;
    chrome.alarms.create = vi.fn();
    chrome.alarms.clear = vi.fn().mockResolvedValue(true);
    chrome.alarms.onAlarm.addListener = vi.fn((listener) => {
      alarmListener = listener;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses runtime.getContexts when the modern API is available", async () => {
    const getContexts = vi
      .fn()
      .mockResolvedValue([{ contextType: "OFFSCREEN_DOCUMENT" }]);
    (
      chrome.runtime as typeof chrome.runtime & {
        getContexts: typeof getContexts;
      }
    ).getContexts = getContexts;

    const { OffscreenManager } = await import("@/utils/offscreen-manager");
    await OffscreenManager.getInstance().ensureOffscreenDocument();

    expect(getContexts).toHaveBeenCalledWith({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it("uses service worker clients on Chrome 109 through 115", async () => {
    const matchAll = vi
      .fn()
      .mockResolvedValue([
        { url: "chrome-extension://test-extension-id/offscreen.html" },
      ]);
    vi.stubGlobal("clients", { matchAll });

    const { OffscreenManager } = await import("@/utils/offscreen-manager");
    await OffscreenManager.getInstance().ensureOffscreenDocument();

    expect(matchAll).toHaveBeenCalledOnce();
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it("creates the document through the Chrome 109 fallback when none exists", async () => {
    vi.stubGlobal("clients", { matchAll: vi.fn().mockResolvedValue([]) });

    const { OffscreenManager } = await import("@/utils/offscreen-manager");
    await OffscreenManager.getInstance().ensureOffscreenDocument();

    expect(chrome.offscreen.createDocument).toHaveBeenCalledWith({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Need to run semantic similarity engine with workers",
    });
  });

  it("does not close a document claimed by a persistent shared consumer", async () => {
    const { OffscreenManager } = await import("@/utils/offscreen-manager");
    const manager = OffscreenManager.getInstance();

    await manager.ensureOffscreenDocument();
    const releaseKeepalive = await manager.acquireOffscreenDocument(
      "temporary-keepalive",
    );
    await releaseKeepalive();

    expect(manager.getReferenceCount()).toBe(0);
    expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled();
  });

  it("does not retain a persistent claim when document creation fails", async () => {
    vi.mocked(chrome.offscreen.createDocument)
      .mockRejectedValueOnce(new Error("transient create failure"))
      .mockResolvedValue(undefined);
    const { OffscreenManager } = await import("@/utils/offscreen-manager");
    const manager = OffscreenManager.getInstance();

    await expect(manager.ensureOffscreenDocument()).rejects.toThrow(
      "transient create failure",
    );
    const release = await manager.acquireOffscreenDocument("replacement");
    await release();

    expect(chrome.offscreen.closeDocument).toHaveBeenCalledOnce();
  });

  it("closes only after the final reference is released and release is idempotent", async () => {
    const { OffscreenManager } = await import("@/utils/offscreen-manager");
    const manager = OffscreenManager.getInstance();
    const releaseFirst = await manager.acquireOffscreenDocument("first");
    const releaseSecond = await manager.acquireOffscreenDocument("second");

    expect(manager.getReferenceCount()).toBe(2);
    await releaseFirst();
    await releaseFirst();
    expect(manager.getReferenceCount()).toBe(1);
    expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled();

    await releaseSecond();
    expect(manager.getReferenceCount()).toBe(0);
    expect(manager.getPendingOperationCount()).toBe(0);
    expect(chrome.offscreen.closeDocument).toHaveBeenCalledOnce();
  });

  it("keeps the document open while an operation is pending, then closes it", async () => {
    let finishOperation!: () => void;
    const operation = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    const { OffscreenManager } = await import("@/utils/offscreen-manager");
    const manager = OffscreenManager.getInstance();

    const running = manager.runWithOffscreenDocument(
      "operation",
      () => operation,
    );
    await vi.waitFor(() => {
      expect(manager.getReferenceCount()).toBe(1);
      expect(manager.getPendingOperationCount()).toBe(1);
    });

    await manager.closeOffscreenDocument();
    expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled();

    finishOperation();
    await running;
    expect(manager.getReferenceCount()).toBe(0);
    expect(manager.getPendingOperationCount()).toBe(0);
    expect(chrome.offscreen.closeDocument).toHaveBeenCalledOnce();
  });

  it("recreates after an acquire races with an in-flight idle close", async () => {
    let finishClose!: () => void;
    const firstClose = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    vi.mocked(chrome.offscreen.closeDocument)
      .mockImplementationOnce(() => firstClose)
      .mockResolvedValue(undefined);

    const { OffscreenManager } = await import("@/utils/offscreen-manager");
    const manager = OffscreenManager.getInstance();
    const releaseFirst = await manager.acquireOffscreenDocument("first");
    const closing = releaseFirst();
    await vi.waitFor(() => {
      expect(chrome.offscreen.closeDocument).toHaveBeenCalledOnce();
    });

    const acquiring = manager.acquireOffscreenDocument("replacement");
    finishClose();
    await closing;
    const releaseReplacement = await acquiring;

    expect(chrome.offscreen.createDocument).toHaveBeenCalledTimes(2);
    expect(manager.getReferenceCount()).toBe(1);
    await releaseReplacement();
    expect(chrome.offscreen.closeDocument).toHaveBeenCalledTimes(2);
  });

  it("discovers and closes an orphan document after a worker restart", async () => {
    const getContexts = vi
      .fn()
      .mockResolvedValue([{ contextType: "OFFSCREEN_DOCUMENT" }]);
    (
      chrome.runtime as typeof chrome.runtime & {
        getContexts: typeof getContexts;
      }
    ).getContexts = getContexts;

    const { OffscreenManager } = await import("@/utils/offscreen-manager");
    const manager = OffscreenManager.getInstance();
    expect(manager.isOffscreenDocumentCreated()).toBe(false);

    await manager.closeOffscreenDocument();

    expect(getContexts).toHaveBeenCalledWith({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    expect(chrome.offscreen.closeDocument).toHaveBeenCalledOnce();
  });

  it("retries a transient idle-close failure without leaking the document", async () => {
    vi.useFakeTimers();
    vi.mocked(chrome.offscreen.closeDocument)
      .mockRejectedValueOnce(new Error("transient close failure"))
      .mockResolvedValue(undefined);
    const { OffscreenManager } = await import("@/utils/offscreen-manager");
    const manager = OffscreenManager.getInstance();
    const release = await manager.acquireOffscreenDocument("retry-close");

    const closing = release();
    await Promise.resolve();
    await Promise.resolve();
    expect(chrome.offscreen.closeDocument).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(50);
    await closing;
    expect(chrome.offscreen.closeDocument).toHaveBeenCalledTimes(2);
    expect(manager.isOffscreenDocumentCreated()).toBe(false);
  });

  it("uses a distinct durable alarm after bounded close retries are exhausted", async () => {
    vi.useFakeTimers();
    vi.mocked(chrome.offscreen.closeDocument).mockRejectedValue(
      new Error("persistent close failure"),
    );
    const { OffscreenManager, OFFSCREEN_CLOSE_RETRY_ALARM_NAME } =
      await import("@/utils/offscreen-manager");
    const manager = OffscreenManager.getInstance();
    const release = await manager.acquireOffscreenDocument("durable-retry");

    const closing = release();
    await vi.advanceTimersByTimeAsync(250);
    await closing;

    expect(chrome.offscreen.closeDocument).toHaveBeenCalledTimes(3);
    expect(chrome.alarms.create).toHaveBeenCalledWith(
      OFFSCREEN_CLOSE_RETRY_ALARM_NAME,
      { when: expect.any(Number) },
    );
    expect(OFFSCREEN_CLOSE_RETRY_ALARM_NAME).not.toBe(
      "webpage-mcp.native-host.reconnect",
    );

    vi.mocked(chrome.offscreen.closeDocument).mockResolvedValue(undefined);
    alarmListener?.({
      name: OFFSCREEN_CLOSE_RETRY_ALARM_NAME,
      scheduledTime: Date.now(),
    });
    await vi.waitFor(() => {
      expect(chrome.offscreen.closeDocument).toHaveBeenCalledTimes(4);
      expect(manager.isOffscreenDocumentCreated()).toBe(false);
    });
  });
});
