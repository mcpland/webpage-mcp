import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

const nativeHostMocks = vi.hoisted(() => ({
  requestAgentRpcFetch: vi.fn(),
  subscribeAgentStream: vi.fn(),
  unsubscribeAgentStream: vi.fn(),
}));
const authorizationMocks = vi.hoisted(() => ({
  consumePrivilegedUiAuthorization: vi.fn(),
}));
const sidepanelMocks = vi.hoisted(() => ({ openAgentSetupSidepanel: vi.fn() }));
const propsInjectionMocks = vi.hoisted(() => ({
  initPropsAgentEarlyInjectionNavigationLifecycle: vi.fn(),
  pruneOrphanedPropsAgentEarlyInjections: vi.fn(),
  registerPropsAgentEarlyInjection: vi.fn(),
  releasePropsAgentEarlyInjection: vi.fn(),
}));

vi.mock('@/entrypoints/background/native-host', () => nativeHostMocks);
vi.mock('@/entrypoints/background/privileged-ui-authorization', () => authorizationMocks);
vi.mock('@/entrypoints/background/utils/sidepanel', () => sidepanelMocks);
vi.mock('@/entrypoints/background/web-editor/props-early-injection', () => propsInjectionMocks);

type RequestListener = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (value: any) => void,
) => boolean | undefined;

function contentSender(): chrome.runtime.MessageSender {
  return {
    id: chrome.runtime.id,
    tab: { id: 7, windowId: 3, url: 'https://example.com/editor' } as chrome.tabs.Tab,
    frameId: 0,
    documentId: 'document-a',
    url: 'https://example.com/editor',
    origin: 'https://example.com',
  };
}

function extensionSender(): chrome.runtime.MessageSender {
  return {
    id: chrome.runtime.id,
    url: chrome.runtime.getURL('sidepanel.html'),
    origin: `chrome-extension://${chrome.runtime.id}`,
  };
}

describe('Web Editor route resource boundaries', () => {
  let requestListener: RequestListener | undefined;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    requestListener = undefined;
    Object.assign(chrome.runtime, {
      id: 'test-extension-id',
      getURL: vi.fn((path = '') => `chrome-extension://test-extension-id/${path}`),
    });
    authorizationMocks.consumePrivilegedUiAuthorization.mockReturnValue(true);
    sidepanelMocks.openAgentSetupSidepanel.mockResolvedValue(undefined);
    propsInjectionMocks.pruneOrphanedPropsAgentEarlyInjections.mockResolvedValue(undefined);
    propsInjectionMocks.releasePropsAgentEarlyInjection.mockResolvedValue(undefined);
    nativeHostMocks.subscribeAgentStream.mockResolvedValue({ subscriptionId: 'subscription-1' });
    nativeHostMocks.unsubscribeAgentStream.mockResolvedValue(undefined);
    nativeHostMocks.requestAgentRpcFetch.mockImplementation(async (request: any) => {
      if (request?.operation === 'agent.projects.openFile') {
        return { ok: true, statusCode: 200, json: { success: true }, body: '' };
      }
      return { ok: true, statusCode: 200, json: { requestId: 'request-1' }, body: '' };
    });
    (chrome.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      'agent-selected-project-id': 'project-1',
      'agent-selected-session-id': 'session-1',
    });
    chrome.storage.session = {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof chrome.storage.session;
    (chrome.tabs as typeof chrome.tabs & { sendMessage: ReturnType<typeof vi.fn> }).sendMessage = vi
      .fn()
      .mockResolvedValue({ ok: true });
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation((listener) => {
      if (!requestListener) requestListener = listener as RequestListener;
    });

    const { initWebEditorListeners } = await import('@/entrypoints/background/web-editor');
    initWebEditorListeners();
  });

  async function sendAsync(
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ): Promise<Record<string, unknown>> {
    const sendResponse = vi.fn();
    expect(requestListener!(message, sender, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    return sendResponse.mock.calls[0]![0] as Record<string, unknown>;
  }

  it('bounds OPEN_SOURCE fields before JSON serialization', async () => {
    const oversized = await sendAsync(
      {
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_OPEN_SOURCE,
        payload: { debugSource: { file: 'x'.repeat(8 * 1024 + 1), line: 1 } },
      },
      contentSender(),
    );
    expect(oversized).toMatchObject({
      success: false,
      error: expect.stringMatching(/debugSource\.file.*field byte limit/),
    });
    expect(nativeHostMocks.requestAgentRpcFetch).not.toHaveBeenCalled();

    const valid = await sendAsync(
      {
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_OPEN_SOURCE,
        payload: {
          debugSource: { file: 'src/Button.tsx', line: 12, column: 4 },
          ignored: { object: true },
        },
      },
      contentSender(),
    );
    expect(valid).toEqual({ success: true });
    const request = nativeHostMocks.requestAgentRpcFetch.mock.calls[0]![0];
    expect(JSON.parse(request.body)).toEqual({
      filePath: 'src/Button.tsx',
      line: 12,
      column: 4,
    });
  });

  it('forwards only a bounded HIGHLIGHT locator and selector', async () => {
    const response = await sendAsync(
      {
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_HIGHLIGHT_ELEMENT,
        payload: {
          tabId: 7,
          mode: 'hover',
          elementKey: 'button-1',
          locator: {
            selectors: ['button.primary'],
            fingerprint: 'button.primary',
            path: [0, 1],
            ignored: { object: true },
          },
          ignored: { object: true },
        },
      },
      extensionSender(),
    );
    expect(response).toMatchObject({ success: true });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      action: 'web_editor_highlight_element',
      locator: {
        selectors: ['button.primary'],
        fingerprint: 'button.primary',
        path: [0, 1],
      },
      selector: 'button.primary',
      mode: 'hover',
      elementKey: 'button-1',
    });
  });

  it('rejects oversized HIGHLIGHT locators, including clear-mode ignored fields', async () => {
    const tooManySelectors = await sendAsync(
      {
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_HIGHLIGHT_ELEMENT,
        payload: {
          tabId: 7,
          mode: 'hover',
          elementKey: 'button-1',
          locator: {
            selectors: Array(17).fill('.selector'),
            fingerprint: 'button',
            path: [],
          },
        },
      },
      extensionSender(),
    );
    expect(tooManySelectors).toMatchObject({
      success: false,
      error: expect.stringMatching(/locator\.selectors.*item limit/),
    });

    const oversizedClear = await sendAsync(
      {
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_HIGHLIGHT_ELEMENT,
        payload: {
          tabId: 7,
          mode: 'clear',
          ignored: ['x'.repeat(70 * 1024), 'x'.repeat(70 * 1024)],
        },
      },
      extensionSender(),
    );
    expect(oversizedClear).toMatchObject({
      success: false,
      error: expect.stringMatching(/raw JSON byte limit/),
    });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('bounds REVERT and CLEAR tab/key fields before forwarding', async () => {
    const revert = await sendAsync(
      {
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_REVERT_ELEMENT,
        payload: { tabId: 7, elementKey: 'x'.repeat(1025) },
      },
      extensionSender(),
    );
    expect(revert).toMatchObject({
      success: false,
      error: expect.stringMatching(/elementKey.*field byte limit/),
    });

    const clear = await sendAsync(
      {
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_CLEAR_SELECTION,
        payload: { tabId: 1.5 },
      },
      extensionSender(),
    );
    expect(clear).toEqual({ success: false, error: 'Invalid tabId' });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('bounds status and cancellation identifiers before lookup or authorization', async () => {
    const statusResponse = vi.fn();
    expect(
      requestListener!(
        {
          type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_STATUS_QUERY,
          requestId: 'x'.repeat(1025),
          sessionId: 'session-1',
        },
        contentSender(),
        statusResponse,
      ),
    ).toBe(false);
    expect(statusResponse).toHaveBeenCalledWith({
      success: false,
      error: expect.stringMatching(/requestId.*field byte limit/),
    });

    const cancel = await sendAsync(
      {
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_CANCEL_EXECUTION,
        authorizationToken: 'cancel-token',
        payload: { requestId: 'request-1', sessionId: 'x'.repeat(1025) },
      },
      contentSender(),
    );
    expect(cancel).toMatchObject({
      success: false,
      error: expect.stringMatching(/sessionId.*field byte limit/),
    });
    expect(authorizationMocks.consumePrivilegedUiAuthorization).not.toHaveBeenCalled();
  });

  it('rejects an oversized Agent request ID before creating status state', async () => {
    nativeHostMocks.requestAgentRpcFetch.mockResolvedValueOnce({
      ok: true,
      statusCode: 200,
      json: { requestId: 'x'.repeat(1025) },
      body: '',
    });

    const response = await sendAsync(
      {
        type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_APPLY,
        authorizationToken: 'apply-token',
        payload: {
          pageUrl: 'https://example.com/editor',
          fingerprint: { tag: 'button', classes: [] },
          instruction: {
            type: 'update_text',
            description: 'Update text',
            text: 'Save',
          },
        },
      },
      contentSender(),
    );
    expect(response).toMatchObject({
      success: false,
      error: expect.stringMatching(/Agent request ID.*field byte limit/),
    });
    expect(nativeHostMocks.subscribeAgentStream).not.toHaveBeenCalled();
  });
});
