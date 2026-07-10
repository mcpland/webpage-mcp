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
vi.mock(
  '@/entrypoints/background/web-editor/props-early-injection',
  () => propsInjectionMocks,
);

type RequestListener = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (value: any) => void,
) => boolean | undefined;

describe('Web Editor listener role authorization', () => {
  let requestListener: RequestListener;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    propsInjectionMocks.pruneOrphanedPropsAgentEarlyInjections.mockResolvedValue(undefined);
    propsInjectionMocks.registerPropsAgentEarlyInjection.mockResolvedValue({ id: 'script-1' });
    propsInjectionMocks.releasePropsAgentEarlyInjection.mockResolvedValue(undefined);

    Object.assign(chrome.runtime, {
      id: 'test-extension-id',
      getURL: vi.fn((path = '') => `chrome-extension://test-extension-id/${path}`),
    });
    chrome.storage.session = {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof chrome.storage.session;
    (chrome.tabs as typeof chrome.tabs & { sendMessage: ReturnType<typeof vi.fn> }).sendMessage = vi
      .fn()
      .mockResolvedValue({ ok: true });
    (chrome.tabs as typeof chrome.tabs & { reload: ReturnType<typeof vi.fn> }).reload = vi
      .fn()
      .mockResolvedValue(undefined);
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation((candidate) => {
      requestListener = candidate as RequestListener;
    });

    const { initWebEditorListeners } = await import('@/entrypoints/background/web-editor');
    initWebEditorListeners();
  });

  function contentSender(): chrome.runtime.MessageSender {
    return {
      id: 'test-extension-id',
      tab: { id: 7, windowId: 2, url: 'https://example.com/' } as chrome.tabs.Tab,
      frameId: 0,
      documentId: 'document-a',
      url: 'https://example.com/',
      origin: 'https://example.com',
    };
  }

  function extensionSender(): chrome.runtime.MessageSender {
    return {
      id: 'test-extension-id',
      url: 'chrome-extension://test-extension-id/sidepanel.html',
      origin: 'chrome-extension://test-extension-id',
    };
  }

  it('registers the navigation lifecycle before starting asynchronous reconciliation', () => {
    expect(
      propsInjectionMocks.initPropsAgentEarlyInjectionNavigationLifecycle,
    ).toHaveBeenCalledOnce();
    expect(propsInjectionMocks.pruneOrphanedPropsAgentEarlyInjections).toHaveBeenCalledOnce();
    expect(
      propsInjectionMocks.initPropsAgentEarlyInjectionNavigationLifecycle.mock.invocationCallOrder[0],
    ).toBeLessThan(
      propsInjectionMocks.pruneOrphanedPropsAgentEarlyInjections.mock.invocationCallOrder[0],
    );
  });

  it.each([
    BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TOGGLE,
    BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_CLEAR_SELECTION,
    BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_HIGHLIGHT_ELEMENT,
    BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_REVERT_ELEMENT,
  ])('rejects content-script use of extension-page control %s', (type) => {
    const sendResponse = vi.fn();
    expect(requestListener({ type }, contentSender(), sendResponse)).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'Web Editor control requires an extension page',
    });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_PROPS_REGISTER_EARLY_INJECTION,
    BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_OPEN_SOURCE,
    BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED,
    BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_SELECTION_CHANGED,
  ])('rejects extension-page use of content-script message %s', (type) => {
    const sendResponse = vi.fn();
    expect(requestListener({ type }, extensionSender(), sendResponse)).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'Web Editor page message sender is not trusted',
    });
  });

  it('allows extension pages to route a clear-selection control', async () => {
    const sendResponse = vi.fn();
    expect(
      requestListener(
        {
          type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_CLEAR_SELECTION,
          payload: { tabId: 7 },
        },
        extensionSender(),
        sendResponse,
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ success: true }));
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, {
      action: 'web_editor_clear_selection',
    });
  });

  it('allows the top-frame editor content script to request early injection', async () => {
    const sendResponse = vi.fn();
    expect(
      requestListener(
        { type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_PROPS_REGISTER_EARLY_INJECTION },
        contentSender(),
        sendResponse,
      ),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(propsInjectionMocks.registerPropsAgentEarlyInjection).toHaveBeenCalledWith(
        7,
        'https://example.com/',
      ),
    );
  });

  it('ignores background rebroadcasts of hydrated editor state', () => {
    const sendResponse = vi.fn();
    expect(
      requestListener(
        { type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED, payload: { tabId: 7 } },
        { id: 'test-extension-id' },
        sendResponse,
      ),
    ).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
