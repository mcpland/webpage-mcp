import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKGROUND_MESSAGE_TYPES, PRIVILEGED_UI_ACTIONS } from '@/common/message-types';

const nativeHostMocks = vi.hoisted(() => ({
  requestAgentRpcFetch: vi.fn(),
  subscribeAgentStream: vi.fn(),
  unsubscribeAgentStream: vi.fn(),
}));
const authorizationMocks = vi.hoisted(() => ({
  consumePrivilegedUiAuthorization: vi.fn(),
}));
const sidepanelMocks = vi.hoisted(() => ({
  openAgentSetupSidepanel: vi.fn(),
}));
const propsInjectionMocks = vi.hoisted(() => ({
  initPropsAgentEarlyInjectionNavigationLifecycle: vi.fn(),
  pruneOrphanedPropsAgentEarlyInjections: vi.fn(),
  registerPropsAgentEarlyInjection: vi.fn(),
  releasePropsAgentEarlyInjection: vi.fn(),
}));

vi.mock('@/entrypoints/background/native-host', () => nativeHostMocks);
vi.mock('@/entrypoints/background/privileged-ui-authorization', () => authorizationMocks);
vi.mock('@/entrypoints/background/utils/sidepanel', () => sidepanelMocks);
vi.mock(
  '@/entrypoints/background/web-editor/props-early-injection',
  () => propsInjectionMocks,
);

type RequestListener = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (value: any) => void,
) => boolean;

describe('Web Editor execution cancellation authorization', () => {
  let requestListener: RequestListener | undefined;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    requestListener = undefined;
    authorizationMocks.consumePrivilegedUiAuthorization.mockReturnValue(true);
    sidepanelMocks.openAgentSetupSidepanel.mockResolvedValue(undefined);
    propsInjectionMocks.pruneOrphanedPropsAgentEarlyInjections.mockResolvedValue(undefined);
    propsInjectionMocks.releasePropsAgentEarlyInjection.mockResolvedValue(undefined);
    nativeHostMocks.subscribeAgentStream.mockResolvedValue({ subscriptionId: 'subscription-1' });
    nativeHostMocks.unsubscribeAgentStream.mockResolvedValue(undefined);
    nativeHostMocks.requestAgentRpcFetch.mockImplementation(async (request: any) => {
      if (request?.operation === 'agent.chat.act') {
        return { ok: true, statusCode: 200, json: { requestId: 'request-1' }, body: '' };
      }
      return { ok: true, statusCode: 200, json: {}, body: '' };
    });
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      'agent-selected-session-id': 'session-1',
    });
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation((listener) => {
      if (!requestListener) requestListener = listener as RequestListener;
    });

    const { initWebEditorListeners } = await import('@/entrypoints/background/web-editor');
    initWebEditorListeners();
  });

  async function startExecution(sender: chrome.runtime.MessageSender): Promise<void> {
    const sendResponse = vi.fn();
    expect(
      requestListener!(
        {
          type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_APPLY,
          authorizationToken: 'apply-token',
          payload: {
            pageUrl: 'https://example.com/editor',
            fingerprint: { tag: 'button', classes: [] },
            instruction: {
              type: 'update_text',
              description: 'Update the button label',
              text: 'Save',
            },
          },
        },
        sender,
        sendResponse,
      ),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        success: true,
        requestId: 'request-1',
        sessionId: 'session-1',
      });
    });
  }

  it('rejects cancellation from a different document', async () => {
    const owner = {
      id: chrome.runtime.id,
      tab: { id: 7, windowId: 3 },
      frameId: 0,
      documentId: 'document-a',
    } as chrome.runtime.MessageSender;
    await startExecution(owner);

    const statusResponse = vi.fn();
    requestListener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_STATUS_QUERY,
        requestId: 'request-1',
        sessionId: 'session-1',
      },
      { ...owner, documentId: 'document-b' },
      statusResponse,
    );
    expect(statusResponse).toHaveBeenCalledWith({
      success: false,
      error: 'Web Editor execution belongs to another document.',
    });

    const sendResponse = vi.fn();
    requestListener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_CANCEL_EXECUTION,
        authorizationToken: 'cancel-token',
        payload: { requestId: 'request-1', sessionId: 'session-1' },
      },
      { ...owner, documentId: 'document-b' },
      sendResponse,
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'Web Editor execution belongs to another document.',
      });
    });
    expect(
      nativeHostMocks.requestAgentRpcFetch.mock.calls.some(
        ([request]) => request?.operation === 'agent.chat.cancelRequest',
      ),
    ).toBe(false);
  });

  it('requires a cancellation capability and accepts the original document', async () => {
    const owner = {
      id: chrome.runtime.id,
      tab: { id: 7, windowId: 3 },
      frameId: 0,
      documentId: 'document-a',
    } as chrome.runtime.MessageSender;
    await startExecution(owner);

    authorizationMocks.consumePrivilegedUiAuthorization.mockReturnValueOnce(false);
    const deniedResponse = vi.fn();
    requestListener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_CANCEL_EXECUTION,
        authorizationToken: 'expired-token',
        payload: { requestId: 'request-1', sessionId: 'session-1' },
      },
      owner,
      deniedResponse,
    );
    await vi.waitFor(() => {
      expect(deniedResponse).toHaveBeenCalledWith({
        success: false,
        error: 'Web Editor cancellation authorization is missing or expired.',
      });
    });

    const acceptedResponse = vi.fn();
    requestListener!(
      {
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_CANCEL_EXECUTION,
        authorizationToken: 'cancel-token',
        payload: { requestId: 'request-1', sessionId: 'session-1' },
      },
      owner,
      acceptedResponse,
    );
    await vi.waitFor(() => expect(acceptedResponse).toHaveBeenCalledWith({ success: true }));

    expect(authorizationMocks.consumePrivilegedUiAuthorization).toHaveBeenLastCalledWith(
      'cancel-token',
      PRIVILEGED_UI_ACTIONS.WEB_EDITOR_CANCEL,
      owner,
    );
    expect(nativeHostMocks.requestAgentRpcFetch).toHaveBeenCalledWith({
      operation: 'agent.chat.cancelRequest',
      params: { sessionId: 'session-1', requestId: 'request-1' },
    });
  });
});
