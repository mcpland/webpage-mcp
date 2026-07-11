import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

const nativeHostMocks = vi.hoisted(() => ({
  requestAgentRpcFetch: vi.fn(),
  subscribeAgentStream: vi.fn(),
  unsubscribeAgentStream: vi.fn(),
}));
const authorizationMocks = vi.hoisted(() => ({
  consumePrivilegedUiAuthorization: vi.fn(),
  validatePrivilegedUiSurfaceSession: vi.fn(),
  startPrivilegedUiSurfaceSession: vi.fn(),
  stopPrivilegedUiSurfaceSession: vi.fn(),
}));
const sidepanelMocks = vi.hoisted(() => ({ openAgentSetupSidepanel: vi.fn() }));
const propsInjectionMocks = vi.hoisted(() => ({
  initPropsAgentEarlyInjectionNavigationLifecycle: vi.fn(),
  pruneOrphanedPropsAgentEarlyInjections: vi.fn(),
  registerPropsAgentEarlyInjection: vi.fn(),
  releasePropsAgentEarlyInjection: vi.fn(),
  retireLegacyPropsAgentInTab: vi.fn(),
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
  let commandListener: (command: string) => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    authorizationMocks.validatePrivilegedUiSurfaceSession.mockResolvedValue(true);
    authorizationMocks.startPrivilegedUiSurfaceSession.mockResolvedValue('a'.repeat(64));
    authorizationMocks.stopPrivilegedUiSurfaceSession.mockResolvedValue(true);
    propsInjectionMocks.pruneOrphanedPropsAgentEarlyInjections.mockResolvedValue(undefined);
    propsInjectionMocks.registerPropsAgentEarlyInjection.mockResolvedValue({ id: 'script-1' });
    propsInjectionMocks.releasePropsAgentEarlyInjection.mockResolvedValue(undefined);
    propsInjectionMocks.retireLegacyPropsAgentInTab.mockResolvedValue(true);

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
    chrome.tabs.query = vi.fn(async () => [
      { id: 7, url: 'https://example.com/' } as chrome.tabs.Tab,
    ]);
    (
      chrome as unknown as {
        scripting: { executeScript: ReturnType<typeof vi.fn> };
      }
    ).scripting = {
      executeScript: vi.fn(async (options: any) => {
        const request = options.args[0];
        return [
          {
            frameId: 0,
            documentId: options.target.documentIds[0],
            result: {
              response: {
                v: 1,
                requestId: request.requestId,
                success: true,
              },
            },
          },
        ];
      }),
    };
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation((candidate) => {
      requestListener = candidate as RequestListener;
    });
    vi.mocked(chrome.commands.onCommand.addListener).mockImplementation(
      (candidate) => {
        commandListener = candidate as (command: string) => Promise<void>;
      },
    );

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
    BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_PROPS_EXECUTE,
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

  it('routes an authenticated props operation only to the sender document', async () => {
    const sendResponse = vi.fn();
    expect(
      requestListener(
        {
          type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_PROPS_EXECUTE,
          surfaceSessionId: 'a'.repeat(64),
          request: { v: 1, requestId: 'request-1', op: 'probe' },
        },
        contentSender(),
        sendResponse,
      ),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      ),
    );
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 7, documentIds: ['document-a'] },
        world: 'MAIN',
      }),
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

  it('serializes concurrent toggles for the same editor tab', async () => {
    let resolveFirstPing!: (value: unknown) => void;
    const firstPing = new Promise((resolve) => {
      resolveFirstPing = resolve;
    });
    let pingCount = 0;
    vi.mocked(chrome.tabs.sendMessage).mockImplementation(
      ((...args: unknown[]) => {
        const message = args[1] as { action?: string };
        if (message.action === 'web_editor_ping') {
          pingCount += 1;
          if (pingCount === 1) return firstPing;
          if (pingCount === 2) return Promise.resolve({ status: 'pong', active: false });
          if (pingCount === 3) return Promise.resolve({ status: 'pong' });
          return Promise.resolve({ status: 'pong', active: true });
        }
        if (message.action === 'web_editor_start') {
          return Promise.resolve({ active: true });
        }
        if (message.action === 'web_editor_stop') {
          return Promise.resolve({ active: false });
        }
        return Promise.resolve({});
      }) as typeof chrome.tabs.sendMessage,
    );

    const firstToggle = commandListener('toggle_web_editor');
    const secondToggle = commandListener('toggle_web_editor');
    await vi.waitFor(() => expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1));
    expect(authorizationMocks.startPrivilegedUiSurfaceSession).not.toHaveBeenCalled();

    resolveFirstPing({ status: 'pong' });
    await Promise.all([firstToggle, secondToggle]);

    expect(pingCount).toBe(4);
    expect(authorizationMocks.startPrivilegedUiSurfaceSession).toHaveBeenCalledOnce();
    expect(authorizationMocks.stopPrivilegedUiSurfaceSession).toHaveBeenCalledOnce();
  });

  it('refuses to start when legacy MAIN-world retirement is unconfirmed', async () => {
    propsInjectionMocks.retireLegacyPropsAgentInTab.mockResolvedValueOnce(false);
    vi.mocked(chrome.tabs.sendMessage)
      .mockResolvedValueOnce({ status: 'pong' })
      .mockResolvedValueOnce({ status: 'pong', active: false });

    await commandListener('toggle_web_editor');

    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(authorizationMocks.startPrivilegedUiSurfaceSession).not.toHaveBeenCalled();
    expect(
      vi.mocked(chrome.tabs.sendMessage).mock.calls.some(
        ([, message]) => (message as { action?: string }).action === 'web_editor_start',
      ),
    ).toBe(false);
  });

  it('still stops an active editor when legacy retirement is unavailable', async () => {
    propsInjectionMocks.retireLegacyPropsAgentInTab.mockResolvedValueOnce(false);
    vi.mocked(chrome.tabs.sendMessage)
      .mockResolvedValueOnce({ status: 'pong' })
      .mockResolvedValueOnce({ status: 'pong', active: true })
      .mockResolvedValueOnce({ active: false });

    await commandListener('toggle_web_editor');

    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(
      7,
      { action: 'web_editor_stop' },
      { frameId: 0 },
    );
    expect(authorizationMocks.stopPrivilegedUiSurfaceSession).toHaveBeenCalledWith(
      'web_editor',
      7,
    );
    expect(propsInjectionMocks.retireLegacyPropsAgentInTab).not.toHaveBeenCalled();
  });
});
