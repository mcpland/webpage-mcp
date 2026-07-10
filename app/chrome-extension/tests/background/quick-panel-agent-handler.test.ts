import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

const nativeHostMocks = vi.hoisted(() => ({
  requestAgentRpcFetch: vi.fn(),
  subscribeAgentStream: vi.fn(),
  unsubscribeAgentStream: vi.fn(),
}));

const sidepanelMocks = vi.hoisted(() => ({
  openAgentChatSidepanel: vi.fn().mockResolvedValue(undefined),
}));

const keepaliveMocks = vi.hoisted(() => ({
  acquireKeepalive: vi.fn(() => vi.fn()),
}));

const authorizationMocks = vi.hoisted(() => ({
  consumePrivilegedUiAuthorization: vi.fn(() => true),
}));

vi.mock('@/entrypoints/background/native-host', () => nativeHostMocks);
vi.mock('@/entrypoints/background/utils/sidepanel', () => sidepanelMocks);
vi.mock('@/entrypoints/background/keepalive-manager', () => keepaliveMocks);
vi.mock('@/entrypoints/background/privileged-ui-authorization', () => authorizationMocks);

type RequestListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (value: unknown) => void,
) => boolean;

describe('Quick Panel agent handler', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    (globalThis.chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      async () => undefined,
    );
    (globalThis.chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      'agent-selected-session-id': 'session-123',
    });
    sidepanelMocks.openAgentChatSidepanel.mockResolvedValue(undefined);
    (globalThis.chrome.tabs as typeof globalThis.chrome.tabs & { sendMessage: ReturnType<typeof vi.fn> }).sendMessage =
      vi.fn().mockResolvedValue(undefined);

    nativeHostMocks.subscribeAgentStream.mockResolvedValue({ subscriptionId: 'sub-123' });
    nativeHostMocks.unsubscribeAgentStream.mockResolvedValue(undefined);
    nativeHostMocks.requestAgentRpcFetch.mockImplementation(async (request: any) => {
      if (request?.operation === 'agent.sessions.get') {
        return { ok: true, statusCode: 200, json: { session: { id: 'session-123' } }, body: '' };
      }
      if (request?.operation === 'agent.chat.act') {
        return { ok: true, statusCode: 200, json: { requestId: 'req-123' }, body: '' };
      }
      return { ok: true, statusCode: 200, json: {}, body: '' };
    });
    authorizationMocks.consumePrivilegedUiAuthorization.mockReturnValue(true);
  });

  it('forwards page context in the act payload', async () => {
    let requestListener: RequestListener | undefined;
    (globalThis.chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>).mockImplementation(
      (listener) => {
        if (!requestListener) {
          requestListener = listener as typeof requestListener;
        }
      },
    );

    const { initQuickPanelAgentHandler } = await import(
      '@/entrypoints/background/quick-panel/agent-handler'
    );
    initQuickPanelAgentHandler();

    expect(requestListener).toBeTypeOf('function');

    const sendResponse = vi.fn();
    const handled = requestListener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_SEND_TO_AI,
        authorizationToken: 'one-time-token',
        payload: {
          instruction: 'Review this page',
          context: {
            pageUrl: 'https://example.com/settings',
            selectedText: 'Save changes',
            elementInfo: { role: 'button', label: 'Save' },
          },
        },
      },
      { tab: { id: 7, windowId: 3 }, frameId: 0 } as chrome.runtime.MessageSender,
      sendResponse,
    );

    expect(handled).toBe(true);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        success: true,
        requestId: expect.any(String),
        sessionId: 'session-123',
      });
    });

    await vi.waitFor(() => {
      expect(
        nativeHostMocks.requestAgentRpcFetch.mock.calls.some(
          ([request]) => request?.operation === 'agent.chat.act',
        ),
      ).toBe(true);
    });

    const actRequest = nativeHostMocks.requestAgentRpcFetch.mock.calls.find(
      ([request]) => request?.operation === 'agent.chat.act',
    )?.[0];

    expect(actRequest).toBeTruthy();
    expect(JSON.parse(actRequest.body)).toEqual({
      instruction: 'Review this page',
      dbSessionId: 'session-123',
      requestId: expect.any(String),
      context: {
        pageUrl: 'https://example.com/settings',
        selectedText: 'Save changes',
        elementInfo: { role: 'button', label: 'Save' },
      },
    });
  });

  it('rejects Agent work without a valid document-bound authorization', async () => {
    let requestListener: RequestListener | undefined;
    (globalThis.chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>).mockImplementation(
      (listener) => {
        requestListener = listener as RequestListener;
      },
    );
    authorizationMocks.consumePrivilegedUiAuthorization.mockReturnValue(false);

    const { initQuickPanelAgentHandler } = await import(
      '@/entrypoints/background/quick-panel/agent-handler'
    );
    initQuickPanelAgentHandler();

    const sendResponse = vi.fn();
    requestListener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_SEND_TO_AI,
        payload: { instruction: 'Read local secrets' },
      },
      { id: chrome.runtime.id, tab: { id: 7 }, frameId: 0 } as chrome.runtime.MessageSender,
      sendResponse,
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'Quick Panel authorization is missing or expired.',
      });
    });
    expect(nativeHostMocks.requestAgentRpcFetch).not.toHaveBeenCalled();
  });

  it('unsubscribes when cancellation wins the subscription race', async () => {
    let requestListener: RequestListener | undefined;
    (globalThis.chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>).mockImplementation(
      (listener) => {
        if (!requestListener) {
          requestListener = listener as RequestListener;
        }
      },
    );

    let resolveSubscription!: (value: { subscriptionId: string }) => void;
    nativeHostMocks.subscribeAgentStream.mockReturnValue(
      new Promise((resolve) => {
        resolveSubscription = resolve;
      }),
    );

    const { initQuickPanelAgentHandler } = await import(
      '@/entrypoints/background/quick-panel/agent-handler'
    );
    initQuickPanelAgentHandler();

    const sendResponse = vi.fn();
    requestListener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_SEND_TO_AI,
        authorizationToken: 'one-time-token',
        payload: { instruction: 'Review this page' },
      },
      { tab: { id: 7, windowId: 3 }, frameId: 0 } as chrome.runtime.MessageSender,
      sendResponse,
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        success: true,
        requestId: expect.any(String),
        sessionId: 'session-123',
      });
      expect(nativeHostMocks.subscribeAgentStream).toHaveBeenCalledOnce();
    });

    const requestId = sendResponse.mock.calls[0]?.[0]?.requestId as string;
    const cancelResponse = vi.fn();
    requestListener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_CANCEL_AI,
        authorizationToken: 'cancel-token',
        payload: { requestId, sessionId: 'session-123' },
      },
      { tab: { id: 7, windowId: 3 }, frameId: 0 } as chrome.runtime.MessageSender,
      cancelResponse,
    );

    await vi.waitFor(() => {
      expect(cancelResponse).toHaveBeenCalledWith({ success: true });
    });

    resolveSubscription({ subscriptionId: 'late-subscription' });

    await vi.waitFor(() => {
      expect(nativeHostMocks.unsubscribeAgentStream).toHaveBeenCalledWith('late-subscription');
    });
    expect(globalThis.chrome.runtime.onMessage.addListener).toHaveBeenCalledOnce();
  });

  it('rejects cancellation without valid document-bound authorization', async () => {
    let requestListener: RequestListener | undefined;
    (globalThis.chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>).mockImplementation(
      (listener) => {
        requestListener = listener as RequestListener;
      },
    );
    authorizationMocks.consumePrivilegedUiAuthorization.mockReturnValue(false);

    const { initQuickPanelAgentHandler } = await import(
      '@/entrypoints/background/quick-panel/agent-handler'
    );
    initQuickPanelAgentHandler();

    const sendResponse = vi.fn();
    requestListener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_CANCEL_AI,
        authorizationToken: 'invalid-token',
        payload: { requestId: 'req-foreign', sessionId: 'session-foreign' },
      },
      {
        id: chrome.runtime.id,
        tab: { id: 7 },
        frameId: 0,
        documentId: 'document-a',
      } as chrome.runtime.MessageSender,
      sendResponse,
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'Quick Panel cancellation authorization is missing or expired.',
      });
    });
    expect(nativeHostMocks.requestAgentRpcFetch).not.toHaveBeenCalled();
  });

  it('rejects cancellation from a different originating document', async () => {
    let requestListener: RequestListener | undefined;
    (globalThis.chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>).mockImplementation(
      (listener) => {
        if (!requestListener) requestListener = listener as RequestListener;
      },
    );

    let resolveSubscription!: (value: { subscriptionId: string }) => void;
    nativeHostMocks.subscribeAgentStream.mockReturnValue(
      new Promise((resolve) => {
        resolveSubscription = resolve;
      }),
    );

    const { initQuickPanelAgentHandler } = await import(
      '@/entrypoints/background/quick-panel/agent-handler'
    );
    initQuickPanelAgentHandler();

    const originalSender = {
      id: chrome.runtime.id,
      tab: { id: 7, windowId: 3 },
      frameId: 0,
      documentId: 'document-a',
    } as chrome.runtime.MessageSender;
    const sendResponse = vi.fn();
    requestListener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_SEND_TO_AI,
        authorizationToken: 'send-token',
        payload: { instruction: 'Review this page' },
      },
      originalSender,
      sendResponse,
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        success: true,
        requestId: expect.any(String),
        sessionId: 'session-123',
      });
    });

    const requestId = sendResponse.mock.calls[0]?.[0]?.requestId as string;
    const foreignCancelResponse = vi.fn();
    requestListener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_CANCEL_AI,
        authorizationToken: 'foreign-cancel-token',
        payload: { requestId, sessionId: 'session-123' },
      },
      { ...originalSender, documentId: 'document-b' },
      foreignCancelResponse,
    );

    await vi.waitFor(() => {
      expect(foreignCancelResponse).toHaveBeenCalledWith({
        success: false,
        error: 'Quick Panel request belongs to a different document.',
      });
    });
    expect(
      nativeHostMocks.requestAgentRpcFetch.mock.calls.some(
        ([request]) => request?.operation === 'agent.chat.cancelRequest',
      ),
    ).toBe(false);

    const originalCancelResponse = vi.fn();
    requestListener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_CANCEL_AI,
        authorizationToken: 'original-cancel-token',
        payload: { requestId, sessionId: 'session-123' },
      },
      originalSender,
      originalCancelResponse,
    );
    await vi.waitFor(() => {
      expect(originalCancelResponse).toHaveBeenCalledWith({ success: true });
    });

    resolveSubscription({ subscriptionId: 'late-subscription' });
    await vi.waitFor(() => {
      expect(nativeHostMocks.unsubscribeAgentStream).toHaveBeenCalledWith('late-subscription');
    });
  });
});
