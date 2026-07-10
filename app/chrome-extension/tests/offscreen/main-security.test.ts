import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageTarget, OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';

const mocks = vi.hoisted(() => ({
  handleGifMessage: vi.fn(),
  initKeepalive: vi.fn(),
}));

vi.mock('@/entrypoints/offscreen/gif-encoder', () => ({
  handleGifMessage: mocks.handleGifMessage,
}));
vi.mock('@/entrypoints/offscreen/rr-keepalive', () => ({
  initKeepalive: mocks.initKeepalive,
}));
vi.mock('@/utils/semantic-similarity-engine', () => ({
  SemanticSimilarityEngine: class {},
}));

type RuntimeListener = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
) => boolean | undefined;

describe('offscreen control authorization', () => {
  let listener: RuntimeListener;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.handleGifMessage.mockReturnValue(true);
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-extension-id',
        getURL: vi.fn((path = '') => `chrome-extension://test-extension-id/${path}`),
        onMessage: {
          addListener: vi.fn((candidate: RuntimeListener) => {
            listener = candidate;
          }),
        },
      },
    });

    await import('@/entrypoints/offscreen/main');
  });

  function dispatch(message: unknown, sender: chrome.runtime.MessageSender): Promise<any> {
    return new Promise((resolve) => {
      const keepOpen = listener(message, sender, resolve);
      if (keepOpen !== true) queueMicrotask(() => resolve(undefined));
    });
  }

  const gifReset = {
    target: MessageTarget.Offscreen,
    type: OFFSCREEN_MESSAGE_TYPES.GIF_RESET,
  };

  it('rejects same-extension content scripts before dispatching a GIF or semantic request', async () => {
    await expect(
      dispatch(gifReset, {
        id: 'test-extension-id',
        tab: { id: 7 } as chrome.tabs.Tab,
        url: 'https://example.com/',
        origin: 'https://example.com',
      }),
    ).resolves.toEqual({
      success: false,
      error: 'Offscreen controls require an extension context',
    });
    expect(mocks.handleGifMessage).not.toHaveBeenCalled();
  });

  it('rejects foreign extensions and forged web origins', async () => {
    for (const sender of [
      {
        id: 'foreign-extension',
        url: 'chrome-extension://foreign-extension/popup.html',
        origin: 'chrome-extension://foreign-extension',
      },
      {
        id: 'test-extension-id',
        url: 'https://example.com/',
        origin: 'https://example.com',
      },
    ]) {
      await expect(dispatch(gifReset, sender)).resolves.toMatchObject({ success: false });
    }
    expect(mocks.handleGifMessage).not.toHaveBeenCalled();
  });

  it('allows the background worker and extension pages', async () => {
    const background = { id: 'test-extension-id' };
    const extensionPage = {
      id: 'test-extension-id',
      url: 'chrome-extension://test-extension-id/popup.html',
      origin: 'chrome-extension://test-extension-id',
    };

    expect(listener(gifReset, background, vi.fn())).toBe(true);
    expect(listener(gifReset, extensionPage, vi.fn())).toBe(true);
    expect(mocks.handleGifMessage).toHaveBeenCalledTimes(2);
  });

  it('ignores non-offscreen and malformed messages', async () => {
    const sender = { id: 'test-extension-id' };
    await expect(dispatch(null, sender)).resolves.toBeUndefined();
    await expect(dispatch({ target: 'background' }, sender)).resolves.toBeUndefined();
    expect(mocks.handleGifMessage).not.toHaveBeenCalled();
  });
});
