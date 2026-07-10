import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

const semanticMocks = vi.hoisted(() => ({ hasAnyModelCache: vi.fn() }));
const offscreenMocks = vi.hoisted(() => ({ ensureOffscreenDocument: vi.fn() }));
const indexerMocks = vi.hoisted(() => ({
  startSemanticEngineInitialization: vi.fn(),
  reinitialize: vi.fn(),
}));

vi.mock('@/utils/semantic-similarity-engine', () => ({
  hasAnyModelCache: semanticMocks.hasAnyModelCache,
  PREDEFINED_MODELS: {
    'multilingual-e5-small': { dimension: 384 },
    'multilingual-e5-base': { dimension: 768 },
  },
}));
vi.mock('@/utils/offscreen-manager', () => ({
  OffscreenManager: {
    getInstance: () => ({
      ensureOffscreenDocument: offscreenMocks.ensureOffscreenDocument,
    }),
  },
}));
vi.mock('@/utils/content-indexer', () => ({
  getGlobalContentIndexer: () => indexerMocks,
}));

type RuntimeListener = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
) => boolean | undefined;

describe('semantic engine control authorization', () => {
  let listener: RuntimeListener;
  let storageGet: ReturnType<typeof vi.fn>;
  let storageSet: ReturnType<typeof vi.fn>;
  let runtimeSendMessage: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    storageGet = vi.fn().mockResolvedValue({
      modelState: {
        status: 'ready',
        downloadProgress: 100,
        isDownloading: false,
        lastUpdated: 1,
      },
    });
    storageSet = vi.fn().mockResolvedValue(undefined);
    runtimeSendMessage = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'test-extension-id',
        getURL: vi.fn((path = '') => `chrome-extension://test-extension-id/${path}`),
        onMessage: {
          addListener: vi.fn((candidate: RuntimeListener) => {
            listener = candidate;
          }),
        },
        sendMessage: runtimeSendMessage,
      },
      storage: { local: { get: storageGet, set: storageSet } },
    });

    const { initSemanticSimilarityListener } =
      await import('@/entrypoints/background/semantic-similarity');
    initSemanticSimilarityListener();
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

  function offscreenSender(): chrome.runtime.MessageSender {
    return {
      id: 'test-extension-id',
      url: 'chrome-extension://test-extension-id/offscreen.html',
      origin: 'chrome-extension://test-extension-id',
    };
  }

  function contentSender(): chrome.runtime.MessageSender {
    return {
      id: 'test-extension-id',
      tab: { id: 4 } as chrome.tabs.Tab,
      url: 'https://example.com/',
      origin: 'https://example.com',
    };
  }

  it.each([
    BACKGROUND_MESSAGE_TYPES.SWITCH_SEMANTIC_MODEL,
    BACKGROUND_MESSAGE_TYPES.GET_MODEL_STATUS,
    BACKGROUND_MESSAGE_TYPES.INITIALIZE_SEMANTIC_ENGINE,
  ])('rejects content-script control request %s', async (type) => {
    await expect(dispatch({ type }, contentSender())).resolves.toEqual({
      success: false,
      error: 'Unauthorized semantic engine control request',
    });
    expect(storageGet).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('allows extension pages to query model status', async () => {
    await expect(
      dispatch({ type: BACKGROUND_MESSAGE_TYPES.GET_MODEL_STATUS }, extensionSender()),
    ).resolves.toMatchObject({
      success: true,
      status: { initializationStatus: 'ready', downloadProgress: 100 },
    });
    expect(storageGet).toHaveBeenCalledWith(['modelState']);
  });

  it('only accepts model status updates from the exact offscreen document', async () => {
    const message = {
      type: BACKGROUND_MESSAGE_TYPES.UPDATE_MODEL_STATUS,
      modelState: { status: 'ready' },
    };

    await expect(dispatch(message, extensionSender())).resolves.toMatchObject({
      success: false,
    });
    await expect(dispatch(message, contentSender())).resolves.toMatchObject({
      success: false,
    });
    expect(storageSet).not.toHaveBeenCalled();

    await expect(dispatch(message, offscreenSender())).resolves.toEqual({
      success: true,
    });
    expect(storageSet).toHaveBeenCalledWith({
      modelState: expect.objectContaining({
        status: 'ready',
        downloadProgress: 0,
        isDownloading: false,
        errorMessage: '',
        errorType: '',
      }),
    });
  });

  it('does not let the offscreen document invoke UI controls', async () => {
    await expect(
      dispatch({ type: BACKGROUND_MESSAGE_TYPES.GET_MODEL_STATUS }, offscreenSender()),
    ).resolves.toMatchObject({ success: false });
    expect(storageGet).not.toHaveBeenCalled();
  });

  it('ignores unrelated and malformed messages', async () => {
    await expect(dispatch(null, contentSender())).resolves.toBeUndefined();
    await expect(dispatch({ type: 'unrelated' }, contentSender())).resolves.toBeUndefined();
  });

  it('falls back from invalid stored preset and version before initializing', async () => {
    storageGet.mockResolvedValue({
      selectedModel: 'attacker/model',
      selectedVersion: 'latest',
    });
    runtimeSendMessage.mockResolvedValue({ success: true });

    const { initializeDefaultSemanticEngine } =
      await import('@/entrypoints/background/semantic-similarity');
    await initializeDefaultSemanticEngine();

    expect(runtimeSendMessage).toHaveBeenCalledWith({
      target: 'offscreen',
      type: expect.any(String),
      config: {
        modelPreset: 'multilingual-e5-small',
        modelVersion: 'quantized',
        modelDimension: 384,
      },
    });
  });

  it('strictly validates model switch parameters before offscreen work', async () => {
    const { handleModelSwitch } = await import('@/entrypoints/background/semantic-similarity');

    await expect(handleModelSwitch('attacker/model', 'quantized', 384)).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/preset/i),
    });
    await expect(handleModelSwitch('multilingual-e5-small', 'latest', 384)).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/version/i),
    });
    await expect(handleModelSwitch('multilingual-e5-small', undefined, 384)).resolves.toMatchObject(
      {
        success: false,
        error: expect.stringMatching(/version/i),
      },
    );
    await expect(
      handleModelSwitch('multilingual-e5-small', 'quantized', 768),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/dimension/i),
    });
    expect(offscreenMocks.ensureOffscreenDocument).not.toHaveBeenCalled();
    expect(runtimeSendMessage).not.toHaveBeenCalled();
  });

  it('sends only the validated model selection for a valid switch', async () => {
    runtimeSendMessage.mockResolvedValue({ success: true });
    const { handleModelSwitch } = await import('@/entrypoints/background/semantic-similarity');

    await expect(
      handleModelSwitch('multilingual-e5-base', 'compressed', 768, 384),
    ).resolves.toEqual({ success: true });
    expect(runtimeSendMessage).toHaveBeenCalledWith({
      target: 'offscreen',
      type: expect.any(String),
      config: {
        modelPreset: 'multilingual-e5-base',
        modelVersion: 'compressed',
        modelDimension: 768,
      },
    });
  });

  it('normalizes stored status fields before returning them', async () => {
    storageGet.mockResolvedValue({
      modelState: {
        status: 'attacker',
        downloadProgress: Number.POSITIVE_INFINITY,
        isDownloading: true,
        lastUpdated: -1,
        errorMessage: 'x'.repeat(10_000),
        errorType: 'attacker',
        injected: true,
      },
    });

    await expect(
      dispatch({ type: BACKGROUND_MESSAGE_TYPES.GET_MODEL_STATUS }, extensionSender()),
    ).resolves.toEqual({
      success: true,
      status: expect.objectContaining({
        initializationStatus: 'idle',
        downloadProgress: 0,
        isDownloading: false,
        errorMessage: '',
        errorType: '',
      }),
    });
  });
});
