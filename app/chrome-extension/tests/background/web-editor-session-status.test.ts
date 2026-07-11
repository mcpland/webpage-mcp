import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BACKGROUND_MESSAGE_TYPES } from "@/common/message-types";

const nativeHostMocks = vi.hoisted(() => ({
  requestAgentRpcFetch: vi.fn(),
  subscribeAgentStream: vi.fn(),
  unsubscribeAgentStream: vi.fn(),
}));

vi.mock("@/entrypoints/background/native-host", () => nativeHostMocks);

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

describe("Web Editor session status subscriptions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    nativeHostMocks.unsubscribeAgentStream.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("unsubscribes a late stream superseded by a newer request", async () => {
    const first = deferred<{ subscriptionId: string }>();
    const second = deferred<{ subscriptionId: string }>();
    nativeHostMocks.subscribeAgentStream
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { subscribeToSessionStatus } =
      await import("@/entrypoints/background/web-editor");

    const firstSetup = subscribeToSessionStatus("session-1", "request-1");
    await vi.waitFor(() =>
      expect(nativeHostMocks.subscribeAgentStream).toHaveBeenCalledOnce(),
    );
    const secondSetup = subscribeToSessionStatus("session-1", "request-2");

    const firstSubscriptionId = nativeHostMocks.subscribeAgentStream.mock
      .calls[0]![1].subscriptionId as string;
    first.resolve({ subscriptionId: firstSubscriptionId });
    await expect(firstSetup).resolves.toBe(false);

    expect(nativeHostMocks.unsubscribeAgentStream).toHaveBeenCalledWith(
      firstSubscriptionId,
    );
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(2);
    expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalledOnce();

    await vi.waitFor(() =>
      expect(nativeHostMocks.subscribeAgentStream).toHaveBeenCalledTimes(2),
    );
    const secondSubscriptionId = nativeHostMocks.subscribeAgentStream.mock
      .calls[1]![1].subscriptionId as string;
    second.resolve({ subscriptionId: secondSubscriptionId });
    await expect(secondSetup).resolves.toBe(true);

    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock
      .calls[1]?.[0];
    expect(listener).toBeTypeOf("function");
    listener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.AGENT_STREAM_EVENT,
        payload: {
          subscriptionId: secondSubscriptionId,
          event: {
            type: "error",
            error: "forged stream failure",
            data: { requestId: "request-2" },
          },
        },
      },
      {
        id: chrome.runtime.id,
        tab: { id: 7 } as chrome.tabs.Tab,
        frameId: 0,
      },
      vi.fn(),
    );
    expect(nativeHostMocks.unsubscribeAgentStream).not.toHaveBeenCalledWith(
      secondSubscriptionId,
    );

    listener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.AGENT_STREAM_EVENT,
        payload: {
          subscriptionId: secondSubscriptionId,
          event: { type: "error", error: "stream failed" },
        },
      },
      { id: chrome.runtime.id } as chrome.runtime.MessageSender,
      vi.fn(),
    );

    expect(nativeHostMocks.unsubscribeAgentStream).not.toHaveBeenCalledWith(
      secondSubscriptionId,
    );
  });

  it("unsubscribes a stream that resolves after cancellation", async () => {
    const pending = deferred<{ subscriptionId: string }>();
    nativeHostMocks.subscribeAgentStream.mockReturnValueOnce(pending.promise);

    const { closeSessionStatusSubscription, subscribeToSessionStatus } =
      await import("@/entrypoints/background/web-editor");

    const setup = subscribeToSessionStatus("session-1", "request-1");
    await vi.waitFor(() =>
      expect(nativeHostMocks.subscribeAgentStream).toHaveBeenCalledOnce(),
    );
    const subscriptionId = nativeHostMocks.subscribeAgentStream.mock
      .calls[0]![1].subscriptionId as string;
    await closeSessionStatusSubscription("session-1", "request-1");

    pending.resolve({ subscriptionId });
    await expect(setup).resolves.toBe(false);

    expect(nativeHostMocks.unsubscribeAgentStream).toHaveBeenCalledWith(
      subscriptionId,
    );
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledOnce();
    expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalledOnce();
  });

  it("caps pending and active status subscriptions together", async () => {
    const subscriptions = Array.from({ length: 16 }, () =>
      deferred<{ subscriptionId: string }>(),
    );
    nativeHostMocks.subscribeAgentStream.mockImplementation(
      () =>
        subscriptions[
          nativeHostMocks.subscribeAgentStream.mock.calls.length - 1
        ]!.promise,
    );

    const {
      closeSessionStatusSubscription,
      subscribeToSessionStatus,
      WEB_EDITOR_MAX_SESSION_STATUS_SUBSCRIPTIONS,
    } = await import("@/entrypoints/background/web-editor");

    const setups = Array.from(
      { length: WEB_EDITOR_MAX_SESSION_STATUS_SUBSCRIPTIONS },
      (_, index) =>
        subscribeToSessionStatus(`session-${index}`, `request-${index}`),
    );
    await expect(
      subscribeToSessionStatus("session-over-limit", "request-over-limit"),
    ).rejects.toThrow(/Too many Web Editor status subscriptions/);
    expect(nativeHostMocks.subscribeAgentStream).toHaveBeenCalledTimes(16);

    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        closeSessionStatusSubscription(`session-${index}`, `request-${index}`),
      ),
    );
    subscriptions.forEach((subscription, index) => {
      const subscriptionId = nativeHostMocks.subscribeAgentStream.mock.calls[
        index
      ]![1].subscriptionId as string;
      subscription.resolve({ subscriptionId });
    });
    await Promise.all(setups);
    expect(
      nativeHostMocks.unsubscribeAgentStream.mock.calls.length,
    ).toBeGreaterThanOrEqual(16);
  });

  it("closes an active status stream when its watchdog expires", async () => {
    vi.useFakeTimers();
    nativeHostMocks.subscribeAgentStream.mockImplementationOnce(
      async (_sessionId: string, options: { subscriptionId: string }) => ({
        subscriptionId: options.subscriptionId,
      }),
    );

    const { subscribeToSessionStatus, WEB_EDITOR_SESSION_STATUS_WATCHDOG_MS } =
      await import("@/entrypoints/background/web-editor");
    await expect(
      subscribeToSessionStatus("session-watchdog", "request-watchdog"),
    ).resolves.toBe(true);
    const subscriptionId = nativeHostMocks.subscribeAgentStream.mock
      .calls[0]![1].subscriptionId as string;

    await vi.advanceTimersByTimeAsync(WEB_EDITOR_SESSION_STATUS_WATCHDOG_MS);

    expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalledOnce();
    expect(nativeHostMocks.unsubscribeAgentStream).toHaveBeenCalledWith(
      subscriptionId,
    );
  });

  it("rejects oversized lifecycle IDs and never retains an oversized native subscription ID", async () => {
    vi.useFakeTimers();
    const { subscribeToSessionStatus } =
      await import("@/entrypoints/background/web-editor");

    await expect(
      subscribeToSessionStatus("s".repeat(385), "request-1"),
    ).rejects.toThrow(/sessionId.*field byte limit/);
    await expect(
      subscribeToSessionStatus("session-1", "r".repeat(385)),
    ).rejects.toThrow(/requestId.*field byte limit/);
    expect(nativeHostMocks.subscribeAgentStream).not.toHaveBeenCalled();

    nativeHostMocks.subscribeAgentStream.mockResolvedValueOnce({
      subscriptionId: "x".repeat(1025),
    });
    await expect(
      subscribeToSessionStatus("session-1", "request-1"),
    ).rejects.toThrow(/subscriptionId exceeds the Web Editor field byte limit/);

    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledOnce();
    expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
