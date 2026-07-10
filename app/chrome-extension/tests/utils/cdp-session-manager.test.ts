import { describe, expect, it, vi } from "vitest";

import { CDPSessionManager } from "@/utils/cdp-session-manager";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createDebuggerHarness(tabId = 41) {
  let attached = false;
  type DetachReason = `${chrome.debugger.DetachReason}`;
  const detachListeners = new Set<
    (source: chrome.debugger.Debuggee, reason: DetachReason) => void
  >();

  const api = {
    onDetach: {
      addListener: vi.fn(
        (
          listener: (
            source: chrome.debugger.Debuggee,
            reason: DetachReason,
          ) => void,
        ) => {
          detachListeners.add(listener);
        },
      ),
      removeListener: vi.fn(
        (
          listener: (
            source: chrome.debugger.Debuggee,
            reason: DetachReason,
          ) => void,
        ) => {
          detachListeners.delete(listener);
        },
      ),
    },
    getTargets: vi.fn(async (): Promise<chrome.debugger.TargetInfo[]> => {
      return attached
        ? [
            {
              id: `target-${tabId}`,
              type: "page",
              title: "Test tab",
              url: "https://example.com",
              attached: true,
              tabId,
              extensionId: chrome.runtime.id,
            },
          ]
        : [];
    }),
    attach: vi.fn(async () => {
      attached = true;
    }),
    detach: vi.fn(async () => {
      attached = false;
    }),
    sendCommand: vi.fn(async () => ({})),
  };

  return {
    api,
    manager: new CDPSessionManager(api as unknown as typeof chrome.debugger),
    emitDetach(reason: DetachReason = "target_closed") {
      attached = false;
      for (const listener of detachListeners) {
        listener({ tabId }, reason);
      }
    },
    notifyDetach(reason: DetachReason) {
      for (const listener of detachListeners) {
        listener({ tabId }, reason);
      }
    },
    setAttached(value: boolean) {
      attached = value;
    },
  };
}

describe("CDPSessionManager", () => {
  it("unregisters its detach listener when disposed", () => {
    const { api, manager } = createDebuggerHarness();

    manager.dispose();

    expect(api.onDetach.removeListener).toHaveBeenCalledOnce();
  });

  it("clears every owner atomically when Chrome forcibly detaches the tab", async () => {
    const { api, manager, emitDetach } = createDebuggerHarness();

    await manager.attach(41, "network");
    await manager.attach(41, "console");
    expect(api.attach).toHaveBeenCalledOnce();

    emitDetach("canceled_by_user");
    await manager.detach(41, "network");
    await manager.detach(41, "console");

    expect(api.detach).not.toHaveBeenCalled();

    await manager.attach(41, "new-owner");
    expect(api.attach).toHaveBeenCalledTimes(2);
  });

  it("counts nested leases from the same owner independently", async () => {
    const { api, manager } = createDebuggerHarness();

    await manager.attach(41, "nested");
    await manager.attach(41, "nested");
    expect(api.attach).toHaveBeenCalledOnce();

    await manager.detach(41, "nested");
    expect(api.detach).not.toHaveBeenCalled();

    await manager.detach(41, "nested");
    expect(api.detach).toHaveBeenCalledOnce();
  });

  it("serializes concurrent attaches so Chrome is attached only once", async () => {
    const { api, manager } = createDebuggerHarness();
    const targets = deferred<chrome.debugger.TargetInfo[]>();
    api.getTargets.mockImplementationOnce(() => targets.promise);

    const first = manager.attach(41, "first");
    const second = manager.attach(41, "second");

    await vi.waitFor(() => expect(api.getTargets).toHaveBeenCalledOnce());
    targets.resolve([]);
    await Promise.all([first, second]);

    expect(api.attach).toHaveBeenCalledOnce();
    await manager.detach(41, "first");
    expect(api.detach).not.toHaveBeenCalled();
    await manager.detach(41, "second");
    expect(api.detach).toHaveBeenCalledOnce();
  });

  it("does not let an unknown owner decrement another owner lease", async () => {
    const { api, manager } = createDebuggerHarness();

    await manager.attach(41, "network");
    await manager.attach(41, "console");
    await manager.detach(41, "unknown-owner");
    await manager.detach(41, "network");

    expect(api.detach).not.toHaveBeenCalled();

    await manager.detach(41, "console");
    expect(api.detach).toHaveBeenCalledOnce();
  });

  it("orders a detach behind an in-flight attach for the same tab", async () => {
    const { api, manager } = createDebuggerHarness();
    const targets = deferred<chrome.debugger.TargetInfo[]>();
    api.getTargets.mockImplementationOnce(() => targets.promise);

    const attaching = manager.attach(41, "racing-owner");
    const detaching = manager.detach(41, "racing-owner");

    await vi.waitFor(() => expect(api.getTargets).toHaveBeenCalledOnce());
    expect(api.detach).not.toHaveBeenCalled();
    targets.resolve([]);
    await Promise.all([attaching, detaching]);

    expect(api.attach).toHaveBeenCalledOnce();
    expect(api.detach).toHaveBeenCalledOnce();
  });

  it("does not let a late local onDetach notification clear a queued reattach", async () => {
    const { api, manager, notifyDetach, setAttached } = createDebuggerHarness();
    await manager.attach(41, "first-owner");
    api.detach.mockImplementationOnce(async () => {
      setAttached(false);
    });

    const detaching = manager.detach(41, "first-owner");
    const reattaching = manager.attach(41, "second-owner");
    await Promise.all([detaching, reattaching]);

    // Simulate Chrome delivering the first detach's notification only after
    // detach() resolved and the serialized reattach completed.
    notifyDetach("canceled_by_user");
    await manager.detach(41, "second-owner");

    expect(api.attach).toHaveBeenCalledTimes(2);
    expect(api.detach).toHaveBeenCalledTimes(2);
  });

  it("reattaches and retries once only for a definite stale-session error", async () => {
    const { api, manager, setAttached } = createDebuggerHarness();
    await manager.attach(41, "long-lived-owner");
    api.sendCommand
      .mockImplementationOnce(async () => {
        setAttached(false);
        throw new Error("Debugger is not attached to the tab with id: 41");
      })
      .mockResolvedValueOnce({ result: "ok" });

    await expect(manager.sendCommand(41, "Runtime.evaluate")).resolves.toEqual({
      result: "ok",
    });

    expect(api.sendCommand).toHaveBeenCalledTimes(2);
    expect(api.attach).toHaveBeenCalledTimes(2);
    expect(api.detach).toHaveBeenCalledOnce();

    // The forced loss invalidated the original lease. Releasing it later must
    // not detach or mutate the recovered one-shot session.
    await manager.detach(41, "long-lived-owner");
    expect(api.detach).toHaveBeenCalledOnce();
  });

  it("does not retry ambiguous command failures that may have side effects", async () => {
    const { api, manager } = createDebuggerHarness();
    api.sendCommand.mockRejectedValueOnce(
      new Error("Detached while handling command"),
    );

    await expect(
      manager.sendCommand(41, "Input.dispatchMouseEvent"),
    ).rejects.toThrow("Detached while handling command");

    expect(api.sendCommand).toHaveBeenCalledOnce();
    expect(api.attach).toHaveBeenCalledOnce();
    expect(api.detach).toHaveBeenCalledOnce();
  });
});
