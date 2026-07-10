import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

const indexerMocks = vi.hoisted(() => ({
  clearAllIndexes: vi.fn(),
  getStats: vi.fn(),
}));
const vectorMocks = vi.hoisted(() => ({ clearAllVectorData: vi.fn() }));

vi.mock('@/utils/content-indexer', () => ({
  getGlobalContentIndexer: () => ({
    clearAllIndexes: indexerMocks.clearAllIndexes,
    getStats: indexerMocks.getStats,
  }),
}));
vi.mock('@/utils/vector-database', () => vectorMocks);

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

describe('storage manager authorization', () => {
  let listener: RuntimeListener;
  let storageRemove: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    indexerMocks.clearAllIndexes.mockResolvedValue(undefined);
    indexerMocks.getStats.mockReturnValue({ indexedPages: 3, totalDocuments: 4 });
    vectorMocks.clearAllVectorData.mockResolvedValue(undefined);
    storageRemove = vi.fn().mockResolvedValue(undefined);

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
      storage: { local: { remove: storageRemove } },
    });

    const { initStorageManagerListener } = await import(
      '@/entrypoints/background/storage-manager'
    );
    initStorageManagerListener();
  });

  function dispatch(message: unknown, sender: chrome.runtime.MessageSender): Promise<any> {
    return new Promise((resolve) => {
      const keepOpen = listener(message, sender, resolve);
      if (keepOpen !== true) queueMicrotask(() => resolve(undefined));
    });
  }

  function extensionSender(): chrome.runtime.MessageSender {
    return {
      id: 'test-extension-id',
      url: 'chrome-extension://test-extension-id/popup.html',
      origin: 'chrome-extension://test-extension-id',
    };
  }

  function contentSender(): chrome.runtime.MessageSender {
    return {
      id: 'test-extension-id',
      tab: { id: 7 } as chrome.tabs.Tab,
      url: 'https://example.com/',
      origin: 'https://example.com',
    };
  }

  it.each([
    BACKGROUND_MESSAGE_TYPES.GET_STORAGE_STATS,
    BACKGROUND_MESSAGE_TYPES.CLEAR_ALL_DATA,
  ])('rejects content-script requests for %s', async (type) => {
    await expect(dispatch({ type }, contentSender())).resolves.toEqual({
      success: false,
      error: 'Storage management requires an extension page',
    });
    expect(indexerMocks.getStats).not.toHaveBeenCalled();
    expect(indexerMocks.clearAllIndexes).not.toHaveBeenCalled();
    expect(vectorMocks.clearAllVectorData).not.toHaveBeenCalled();
    expect(storageRemove).not.toHaveBeenCalled();
  });

  it('allows an extension page to read storage statistics', async () => {
    await expect(
      dispatch({ type: BACKGROUND_MESSAGE_TYPES.GET_STORAGE_STATS }, extensionSender()),
    ).resolves.toMatchObject({
      success: true,
      stats: { indexedPages: 3, totalDocuments: 4 },
    });
    expect(indexerMocks.getStats).toHaveBeenCalledOnce();
  });

  it('allows an extension page to clear managed storage', async () => {
    await expect(
      dispatch({ type: BACKGROUND_MESSAGE_TYPES.CLEAR_ALL_DATA }, extensionSender()),
    ).resolves.toEqual({ success: true });
    expect(indexerMocks.clearAllIndexes).toHaveBeenCalledOnce();
    expect(vectorMocks.clearAllVectorData).toHaveBeenCalledOnce();
    expect(storageRemove).toHaveBeenCalledOnce();
  });

  it('ignores unrelated and malformed messages', async () => {
    await expect(dispatch(null, contentSender())).resolves.toBeUndefined();
    await expect(dispatch({ type: 'unrelated' }, contentSender())).resolves.toBeUndefined();
  });
});
