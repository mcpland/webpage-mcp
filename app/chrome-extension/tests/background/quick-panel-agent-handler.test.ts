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

vi.mock('@/entrypoints/background/native-host', () => nativeHostMocks);
vi.mock('@/entrypoints/background/utils/sidepanel', () => sidepanelMocks);
vi.mock('@/entrypoints/background/keepalive-manager', () => keepaliveMocks);

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
  });

  it('forwards page context in the act payload', async () => {
    let requestListener: ((message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (value: unknown) => void) => boolean) | undefined;
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
});
