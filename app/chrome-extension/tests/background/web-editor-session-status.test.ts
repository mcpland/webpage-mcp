import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

const nativeHostMocks = vi.hoisted(() => ({
  requestAgentRpcFetch: vi.fn(),
  subscribeAgentStream: vi.fn(),
  unsubscribeAgentStream: vi.fn(),
}));

vi.mock('@/entrypoints/background/native-host', () => nativeHostMocks);

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

describe('Web Editor session status subscriptions', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    nativeHostMocks.unsubscribeAgentStream.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('unsubscribes a late stream superseded by a newer request', async () => {
    const first = deferred<{ subscriptionId: string }>();
    const second = deferred<{ subscriptionId: string }>();
    nativeHostMocks.subscribeAgentStream
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { subscribeToSessionStatus } = await import('@/entrypoints/background/web-editor');

    const firstSetup = subscribeToSessionStatus('session-1', 'request-1');
    const secondSetup = subscribeToSessionStatus('session-1', 'request-2');

    first.resolve({ subscriptionId: 'subscription-1' });
    await firstSetup;

    expect(nativeHostMocks.unsubscribeAgentStream).toHaveBeenCalledWith('subscription-1');
    expect(chrome.runtime.onMessage.addListener).not.toHaveBeenCalled();

    second.resolve({ subscriptionId: 'subscription-2' });
    await secondSetup;

    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledOnce();

    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0]?.[0];
    expect(listener).toBeTypeOf('function');
    listener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.AGENT_STREAM_EVENT,
        payload: {
          subscriptionId: 'subscription-2',
          event: { type: 'error', error: 'forged stream failure' },
        },
      },
      {
        id: chrome.runtime.id,
        tab: { id: 7 } as chrome.tabs.Tab,
        frameId: 0,
      },
      vi.fn(),
    );
    expect(nativeHostMocks.unsubscribeAgentStream).toHaveBeenCalledTimes(1);

    listener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.AGENT_STREAM_EVENT,
        payload: {
          subscriptionId: 'subscription-2',
          event: { type: 'error', error: 'stream failed' },
        },
      },
      { id: chrome.runtime.id } as chrome.runtime.MessageSender,
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(nativeHostMocks.unsubscribeAgentStream).toHaveBeenCalledWith('subscription-2');
      expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalledOnce();
    });
  });

  it('unsubscribes a stream that resolves after cancellation', async () => {
    const pending = deferred<{ subscriptionId: string }>();
    nativeHostMocks.subscribeAgentStream.mockReturnValueOnce(pending.promise);

    const { closeSessionStatusSubscription, subscribeToSessionStatus } =
      await import('@/entrypoints/background/web-editor');

    const setup = subscribeToSessionStatus('session-1', 'request-1');
    await closeSessionStatusSubscription('session-1', 'request-1');

    pending.resolve({ subscriptionId: 'late-subscription' });
    await setup;

    expect(nativeHostMocks.unsubscribeAgentStream).toHaveBeenCalledWith('late-subscription');
    expect(chrome.runtime.onMessage.addListener).not.toHaveBeenCalled();
  });

  it('caps pending and active status subscriptions together', async () => {
    const subscriptions = Array.from({ length: 16 }, () => deferred<{ subscriptionId: string }>());
    nativeHostMocks.subscribeAgentStream.mockImplementation(
      () => subscriptions[nativeHostMocks.subscribeAgentStream.mock.calls.length - 1]!.promise,
    );

    const {
      closeSessionStatusSubscription,
      subscribeToSessionStatus,
      WEB_EDITOR_MAX_SESSION_STATUS_SUBSCRIPTIONS,
    } = await import('@/entrypoints/background/web-editor');

    const setups = Array.from({ length: WEB_EDITOR_MAX_SESSION_STATUS_SUBSCRIPTIONS }, (_, index) =>
      subscribeToSessionStatus(`session-${index}`, `request-${index}`),
    );
    await expect(
      subscribeToSessionStatus('session-over-limit', 'request-over-limit'),
    ).rejects.toThrow(/Too many Web Editor status subscriptions/);
    expect(nativeHostMocks.subscribeAgentStream).toHaveBeenCalledTimes(16);

    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        closeSessionStatusSubscription(`session-${index}`, `request-${index}`),
      ),
    );
    subscriptions.forEach((subscription, index) => {
      subscription.resolve({ subscriptionId: `subscription-${index}` });
    });
    await Promise.all(setups);
    expect(nativeHostMocks.unsubscribeAgentStream).toHaveBeenCalledTimes(16);
  });

  it('closes an active status stream when its watchdog expires', async () => {
    vi.useFakeTimers();
    nativeHostMocks.subscribeAgentStream.mockResolvedValueOnce({
      subscriptionId: 'subscription-watchdog',
    });

    const { subscribeToSessionStatus, WEB_EDITOR_SESSION_STATUS_WATCHDOG_MS } =
      await import('@/entrypoints/background/web-editor');
    await subscribeToSessionStatus('session-watchdog', 'request-watchdog');

    await vi.advanceTimersByTimeAsync(WEB_EDITOR_SESSION_STATUS_WATCHDOG_MS);

    expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalledOnce();
    expect(nativeHostMocks.unsubscribeAgentStream).toHaveBeenCalledWith('subscription-watchdog');
  });

  it('rejects oversized lifecycle IDs and never retains an oversized native subscription ID', async () => {
    vi.useFakeTimers();
    const { subscribeToSessionStatus } = await import('@/entrypoints/background/web-editor');

    await expect(subscribeToSessionStatus('s'.repeat(385), 'request-1')).rejects.toThrow(
      /sessionId.*field byte limit/,
    );
    await expect(subscribeToSessionStatus('session-1', 'r'.repeat(385))).rejects.toThrow(
      /requestId.*field byte limit/,
    );
    expect(nativeHostMocks.subscribeAgentStream).not.toHaveBeenCalled();

    nativeHostMocks.subscribeAgentStream.mockResolvedValueOnce({
      subscriptionId: 'x'.repeat(1025),
    });
    await subscribeToSessionStatus('session-1', 'request-1');

    expect(chrome.runtime.onMessage.addListener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
