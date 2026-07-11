import { beforeEach, describe, expect, it, vi } from "vitest";

const managerMocks = vi.hoisted(() => ({
  acquireOffscreenDocument: vi.fn(),
  closeOffscreenDocument: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/offscreen-manager", () => ({
  offscreenManager: managerMocks,
}));

import { createOffscreenKeepaliveController } from "@/entrypoints/background/record-replay-v3/engine/keepalive/offscreen-keepalive";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function silentLogger(): Pick<Console, "debug" | "info" | "warn" | "error"> {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("offscreen keepalive lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue(undefined);
  });

  it("holds one document reference for multiple callers and releases the final one", async () => {
    const releaseDocument = vi.fn().mockResolvedValue(undefined);
    managerMocks.acquireOffscreenDocument.mockResolvedValue(releaseDocument);
    const controller = createOffscreenKeepaliveController({
      logger: silentLogger(),
    });

    const releaseFirst = controller.acquire("first");
    const releaseSecond = controller.acquire("second");
    await vi.waitFor(() => {
      expect(managerMocks.acquireOffscreenDocument).toHaveBeenCalledTimes(1);
      expect(controller.getRefCount()).toBe(2);
    });

    releaseFirst();
    await Promise.resolve();
    expect(releaseDocument).not.toHaveBeenCalled();
    expect(controller.getRefCount()).toBe(1);

    releaseSecond();
    releaseSecond();
    await vi.waitFor(() => {
      expect(releaseDocument).toHaveBeenCalledOnce();
      expect(controller.getRefCount()).toBe(0);
      expect(controller.isActive()).toBe(false);
    });
  });

  it("releases a late document acquisition when the last caller leaves during creation", async () => {
    const ready = deferred<() => Promise<void>>();
    const releaseDocument = vi.fn().mockResolvedValue(undefined);
    managerMocks.acquireOffscreenDocument.mockReturnValue(ready.promise);
    const controller = createOffscreenKeepaliveController({
      logger: silentLogger(),
    });

    const release = controller.acquire("racing");
    await vi.waitFor(() => {
      expect(managerMocks.acquireOffscreenDocument).toHaveBeenCalledOnce();
    });
    release();
    ready.resolve(releaseDocument);

    await vi.waitFor(() => {
      expect(releaseDocument).toHaveBeenCalledOnce();
      expect(controller.getRefCount()).toBe(0);
    });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: "start" }),
    );
  });

  it("does not tear down a document reacquired while stop is awaiting", async () => {
    const stop = deferred<void>();
    const releaseDocument = vi.fn().mockResolvedValue(undefined);
    managerMocks.acquireOffscreenDocument.mockResolvedValue(releaseDocument);
    vi.mocked(chrome.runtime.sendMessage).mockImplementation((message) => {
      const command = (message as { command?: string }).command;
      return command === "stop" ? stop.promise : Promise.resolve(undefined);
    });
    const controller = createOffscreenKeepaliveController({
      logger: silentLogger(),
    });

    const releaseFirst = controller.acquire("first");
    await vi.waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: "start" }),
      );
    });

    releaseFirst();
    await vi.waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ command: "stop" }),
      );
    });
    const releaseReplacement = controller.acquire("replacement");
    stop.resolve(undefined);

    await vi.waitFor(() => {
      expect(controller.getRefCount()).toBe(1);
      expect(managerMocks.acquireOffscreenDocument).toHaveBeenCalledOnce();
    });
    expect(releaseDocument).not.toHaveBeenCalled();

    releaseReplacement();
    await vi.waitFor(() => {
      expect(releaseDocument).toHaveBeenCalledOnce();
    });
  });
});
