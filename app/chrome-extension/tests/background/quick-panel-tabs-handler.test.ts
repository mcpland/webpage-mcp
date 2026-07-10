import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

type RequestListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (value: unknown) => void,
) => boolean;

describe('Quick Panel tabs handler', () => {
  let requestListener!: RequestListener;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    chrome.tabs.query = vi.fn().mockResolvedValue([]);
    chrome.tabs.update = vi.fn().mockResolvedValue({});
    chrome.tabs.remove = vi.fn().mockResolvedValue(undefined);
    chrome.windows = {
      update: vi.fn().mockResolvedValue({}),
    } as unknown as typeof chrome.windows;
    vi.mocked(chrome.runtime.onMessage.addListener).mockImplementation((listener) => {
      requestListener = listener as RequestListener;
    });

    const { initQuickPanelTabsHandler } = await import(
      '@/entrypoints/background/quick-panel/tabs-handler'
    );
    initQuickPanelTabsHandler();
  });

  it.each([
    ['an extension page', { id: chrome.runtime.id }],
    [
      'a foreign extension',
      { id: 'foreign-extension', tab: { id: 7, windowId: 3 }, frameId: 0 },
    ],
    [
      'a child frame',
      { id: chrome.runtime.id, tab: { id: 7, windowId: 3 }, frameId: 1 },
    ],
  ])('rejects tab operations from %s', async (_label, rawSender) => {
    const sender = rawSender as chrome.runtime.MessageSender;
    const responses = [
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_TABS_QUERY,
        payload: { includeAllWindows: true },
      },
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_TAB_ACTIVATE,
        payload: { tabId: 8, windowId: 3 },
      },
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_TAB_CLOSE,
        payload: { tabId: 8 },
      },
    ].map(async (message) => {
      const sendResponse = vi.fn();
      expect(requestListener(message, sender, sendResponse)).toBe(true);
      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith({
          success: false,
          error: 'Quick Panel tab request denied',
        });
      });
    });

    await Promise.all(responses);
    expect(chrome.tabs.query).not.toHaveBeenCalled();
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(chrome.windows.update).not.toHaveBeenCalled();
  });

  it('allows top-frame Quick Panel content scripts to query and manage tabs', async () => {
    const sender = {
      id: chrome.runtime.id,
      tab: { id: 7, windowId: 3 },
      frameId: 0,
      documentId: 'document-a',
    } as chrome.runtime.MessageSender;

    const messages = [
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_TABS_QUERY,
        payload: { includeAllWindows: true },
      },
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_TAB_ACTIVATE,
        payload: { tabId: 8, windowId: 3 },
      },
      {
        type: BACKGROUND_MESSAGE_TYPES.QUICK_PANEL_TAB_CLOSE,
        payload: { tabId: 8 },
      },
    ];

    for (const message of messages) {
      const sendResponse = vi.fn();
      expect(requestListener(message, sender, sendResponse)).toBe(true);
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
      expect(sendResponse.mock.calls[0]?.[0]).toMatchObject({ success: true });
    }

    expect(chrome.tabs.query).toHaveBeenCalledWith({});
    expect(chrome.windows.update).toHaveBeenCalledWith(3, { focused: true });
    expect(chrome.tabs.update).toHaveBeenCalledWith(8, { active: true });
    expect(chrome.tabs.remove).toHaveBeenCalledWith(8);
  });
});
