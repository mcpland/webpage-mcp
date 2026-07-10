import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import { AGENT_STREAM_LIMITS } from '@/common/agent-stream-boundaries';

const nativeHostMocks = vi.hoisted(() => ({
  requestAgentRpcFetch: vi.fn(),
  subscribeAgentStream: vi.fn(),
  unsubscribeAgentStream: vi.fn(),
}));
const sidepanelMocks = vi.hoisted(() => ({ openAgentSetupSidepanel: vi.fn() }));
const keepaliveMocks = vi.hoisted(() => ({ acquireKeepalive: vi.fn(() => vi.fn()) }));
const authorizationMocks = vi.hoisted(() => ({
  consumePrivilegedUiAuthorization: vi.fn(() => true),
}));

vi.mock('@/entrypoints/background/native-host', () => nativeHostMocks);
vi.mock('@/entrypoints/background/utils/sidepanel', () => sidepanelMocks);
vi.mock('@/entrypoints/background/keepalive-manager', () => keepaliveMocks);
vi.mock('@/entrypoints/background/privileged-ui-authorization', () => authorizationMocks);

type RequestListener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];

describe('Quick Panel Agent stream authorization', () => {
  let listeners: RequestListener[];

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    listeners = [];
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation((listener) => {
      listeners.push(listener);
    });
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      'agent-selected-session-id': 'session-1',
    });
    (chrome.tabs as typeof chrome.tabs & { sendMessage: ReturnType<typeof vi.fn> }).sendMessage = vi
      .fn()
      .mockResolvedValue(undefined);
    sidepanelMocks.openAgentSetupSidepanel.mockResolvedValue(undefined);
    nativeHostMocks.subscribeAgentStream.mockResolvedValue({ subscriptionId: 'subscription-1' });
    nativeHostMocks.unsubscribeAgentStream.mockResolvedValue(undefined);
    nativeHostMocks.requestAgentRpcFetch.mockResolvedValue({
      ok: true,
      statusCode: 200,
      json: {},
      body: '',
    });

    const { initQuickPanelAgentHandler } = await import(
      '@/entrypoints/background/quick-panel/agent-handler'
    );
    initQuickPanelAgentHandler();
  });

  it('rejects content-script stream forgeries and accepts the internal relay', async () => {
    const sendResponse = vi.fn();
    const contentSender = {
      id: chrome.runtime.id,
      tab: { id: 7, windowId: 2 } as chrome.tabs.Tab,
      frameId: 0,
      documentId: 'document-a',
    } as chrome.runtime.MessageSender;

    expect(
      listeners[0](
        {
          type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_SEND_TO_AI,
          authorizationToken: 'token',
          payload: { instruction: 'Review' },
        },
        contentSender,
        sendResponse,
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    await vi.waitFor(() => expect(listeners).toHaveLength(2));
    const requestId = sendResponse.mock.calls[0]?.[0]?.requestId;
    const eventMessage = {
      type: BACKGROUND_MESSAGE_TYPES.AGENT_STREAM_EVENT,
      payload: {
        subscriptionId: 'subscription-1',
        event: {
          type: 'message',
          data: {
            id: 'message-1',
            sessionId: 'session-1',
            requestId,
            role: 'assistant',
            content: 'done',
            messageType: 'chat',
            createdAt: new Date(0).toISOString(),
          },
        },
      },
    };

    listeners[1](eventMessage, contentSender, vi.fn());
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();

    listeners[1](eventMessage, { id: chrome.runtime.id }, vi.fn());
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ requestId }),
      { frameId: 0 },
    );

    listeners[1](
      {
        ...eventMessage,
        payload: {
          subscriptionId: 'subscription-1',
          event: { type: 'status', data: { requestId, status: 'completed' } },
        },
      },
      { id: chrome.runtime.id },
      vi.fn(),
    );
  });

  it('terminates a request at the cumulative stream event limit', async () => {
    const sendResponse = vi.fn();
    const contentSender = {
      id: chrome.runtime.id,
      tab: { id: 7, windowId: 2 } as chrome.tabs.Tab,
      frameId: 0,
      documentId: 'document-a',
    } as chrome.runtime.MessageSender;
    listeners[0](
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_SEND_TO_AI,
        authorizationToken: 'token',
        payload: { instruction: 'Review' },
      },
      contentSender,
      sendResponse,
    );
    await vi.waitFor(() => expect(listeners).toHaveLength(2));
    const requestId = sendResponse.mock.calls[0]?.[0]?.requestId;
    const eventMessage = {
      type: BACKGROUND_MESSAGE_TYPES.AGENT_STREAM_EVENT,
      payload: {
        subscriptionId: 'subscription-1',
        event: {
          type: 'status',
          data: { sessionId: 'session-1', requestId, status: 'running' },
        },
      },
    };

    for (let index = 0; index <= AGENT_STREAM_LIMITS.maxEventsPerRequest; index += 1) {
      listeners[1](eventMessage, { id: chrome.runtime.id }, vi.fn());
    }

    expect(nativeHostMocks.unsubscribeAgentStream).toHaveBeenCalledWith('subscription-1');
    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
      7,
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'error',
          error: 'Quick Panel stream exceeded its resource budget.',
        }),
      }),
      { frameId: 0 },
    );
  });
});
