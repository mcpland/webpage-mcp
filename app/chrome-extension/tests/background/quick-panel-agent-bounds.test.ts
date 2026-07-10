import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

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

type RequestListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (value: unknown) => void,
) => boolean;

describe('Quick Panel agent payload limits', () => {
  let requestListener: RequestListener;
  let limits: typeof import('@/entrypoints/background/quick-panel/agent-handler').QUICK_PANEL_AGENT_LIMITS;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    requestListener = undefined as unknown as RequestListener;
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation((listener) => {
      if (!requestListener) requestListener = listener as RequestListener;
    });
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
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

    const module = await import('@/entrypoints/background/quick-panel/agent-handler');
    limits = module.QUICK_PANEL_AGENT_LIMITS;
    module.initQuickPanelAgentHandler();
  });

  function sender(): chrome.runtime.MessageSender {
    return {
      id: chrome.runtime.id,
      tab: { id: 7, windowId: 2 },
      frameId: 0,
      documentId: 'document-a',
    } as chrome.runtime.MessageSender;
  }

  async function dispatch(message: unknown): Promise<any> {
    const sendResponse = vi.fn();
    expect(requestListener(message, sender(), sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    return sendResponse.mock.calls[0]?.[0];
  }

  it('rejects an oversized instruction before reading session state', async () => {
    await expect(
      dispatch({
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_SEND_TO_AI,
        authorizationToken: 'token',
        payload: { instruction: 'x'.repeat(limits.maxInstructionBytes + 1) },
      }),
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('instruction') });
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(nativeHostMocks.subscribeAgentStream).not.toHaveBeenCalled();
  });

  it('rejects cyclic and deeply nested element context', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth <= limits.maxContextDepth; depth += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }

    for (const elementInfo of [cyclic, deep]) {
      await expect(
        dispatch({
          type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_SEND_TO_AI,
          authorizationToken: 'token',
          payload: { instruction: 'Review', context: { elementInfo } },
        }),
      ).resolves.toMatchObject({ success: false });
    }
    expect(nativeHostMocks.subscribeAgentStream).not.toHaveBeenCalled();
  });

  it('rejects a corrupted oversized selected session identifier', async () => {
    vi.mocked(chrome.storage.local.get).mockResolvedValue({
      'agent-selected-session-id': 's'.repeat(limits.maxIdentifierBytes + 1),
    });
    await expect(
      dispatch({
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_SEND_TO_AI,
        authorizationToken: 'token',
        payload: { instruction: 'Review' },
      }),
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('sessionId') });
    expect(nativeHostMocks.subscribeAgentStream).not.toHaveBeenCalled();
  });
});
