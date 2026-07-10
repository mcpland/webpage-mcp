import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('unsubscribes a late stream superseded by a newer request', async () => {
    const first = deferred<{ subscriptionId: string }>();
    const second = deferred<{ subscriptionId: string }>();
    nativeHostMocks.subscribeAgentStream
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { subscribeToSessionStatus } = await import(
      '@/entrypoints/background/web-editor'
    );

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
          event: { type: 'error', error: 'stream failed' },
        },
      },
      {} as chrome.runtime.MessageSender,
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

    const { closeSessionStatusSubscription, subscribeToSessionStatus } = await import(
      '@/entrypoints/background/web-editor'
    );

    const setup = subscribeToSessionStatus('session-1', 'request-1');
    await closeSessionStatusSubscription('session-1', 'request-1');

    pending.resolve({ subscriptionId: 'late-subscription' });
    await setup;

    expect(nativeHostMocks.unsubscribeAgentStream).toHaveBeenCalledWith('late-subscription');
    expect(chrome.runtime.onMessage.addListener).not.toHaveBeenCalled();
  });
});
