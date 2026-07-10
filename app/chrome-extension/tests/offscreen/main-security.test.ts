import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageTarget, OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';

const mocks = vi.hoisted(() => ({
  handleGifMessage: vi.fn(),
  initKeepalive: vi.fn(),
  engineConfigs: [] as unknown[],
  initializeWithProgress: vi.fn(),
  dispose: vi.fn(),
  getEmbedding: vi.fn(),
  getEmbeddingsBatch: vi.fn(),
  computeSimilarityBatch: vi.fn(),
}));

vi.mock('@/entrypoints/offscreen/gif-encoder', () => ({
  handleGifMessage: mocks.handleGifMessage,
}));
vi.mock('@/entrypoints/offscreen/rr-keepalive', () => ({
  initKeepalive: mocks.initKeepalive,
}));
vi.mock('@/utils/semantic-similarity-engine', () => ({
  PREDEFINED_MODELS: {
    'multilingual-e5-small': { dimension: 384 },
    'multilingual-e5-base': { dimension: 768 },
  },
  SemanticSimilarityEngine: class {
    constructor(config: unknown) {
      mocks.engineConfigs.push(config);
    }

    initializeWithProgress = mocks.initializeWithProgress;
    dispose = mocks.dispose;
    getEmbedding = mocks.getEmbedding;
    getEmbeddingsBatch = mocks.getEmbeddingsBatch;
    computeSimilarityBatch = mocks.computeSimilarityBatch;
  },
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
    mocks.engineConfigs.length = 0;
    mocks.handleGifMessage.mockReturnValue(true);
    mocks.initializeWithProgress.mockResolvedValue(undefined);
    mocks.dispose.mockResolvedValue(undefined);
    mocks.getEmbedding.mockResolvedValue(new Float32Array(384));
    mocks.getEmbeddingsBatch.mockImplementation(async (texts: string[]) =>
      texts.map(() => new Float32Array(384)),
    );
    mocks.computeSimilarityBatch.mockImplementation(async (pairs: unknown[]) => pairs.map(() => 0));
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
      storage: { local: { set: vi.fn().mockResolvedValue(undefined) } },
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

  const backgroundSender = { id: 'test-extension-id' };

  async function initializeSmallModel(config: Record<string, unknown> = {}) {
    mocks.handleGifMessage.mockReturnValue(false);
    return dispatch(
      {
        target: MessageTarget.Offscreen,
        type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_INIT,
        config: {
          modelPreset: 'multilingual-e5-small',
          modelVersion: 'quantized',
          modelDimension: 384,
          ...config,
        },
      },
      backgroundSender,
    );
  }

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
      await expect(dispatch(gifReset, sender)).resolves.toMatchObject({
        success: false,
      });
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

  it('rejects injected model fields and mismatched dimensions before construction', async () => {
    await expect(initializeSmallModel({ modelIdentifier: 'attacker/model' })).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/unsupported fields/i),
    });
    await expect(initializeSmallModel({ modelDimension: 768 })).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/dimension/i),
    });
    expect(mocks.engineConfigs).toHaveLength(0);
  });

  it('constructs the engine from a fixed whitelist for a valid preset', async () => {
    await expect(initializeSmallModel()).resolves.toEqual({ success: true });
    expect(mocks.engineConfigs).toEqual([
      {
        modelPreset: 'multilingual-e5-small',
        modelVersion: 'quantized',
        dimension: 384,
        useLocalFiles: false,
        forceOffscreen: false,
      },
    ]);
  });

  it('allows only one model initialization in flight', async () => {
    let resolveInitialization!: () => void;
    mocks.initializeWithProgress.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveInitialization = resolve)),
    );

    const firstInitialization = initializeSmallModel();
    await vi.waitFor(() => expect(mocks.initializeWithProgress).toHaveBeenCalledTimes(1));
    await expect(initializeSmallModel()).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/busy/i),
    });
    resolveInitialization();
    await expect(firstInitialization).resolves.toEqual({ success: true });
  });

  it('rejects oversized text and malformed options before invoking the engine', async () => {
    await initializeSmallModel();

    await expect(
      dispatch(
        {
          target: MessageTarget.Offscreen,
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_COMPUTE,
          text: 'a'.repeat(32 * 1024 + 1),
          options: {},
        },
        backgroundSender,
      ),
    ).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/UTF-8 byte limit/i),
    });
    await expect(
      dispatch(
        {
          target: MessageTarget.Offscreen,
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_COMPUTE,
          text: 'valid',
          options: null,
        },
        backgroundSender,
      ),
    ).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/plain object/i),
    });
    expect(mocks.getEmbedding).not.toHaveBeenCalled();
  });

  it('rejects an embedding whose dimension does not match the active model', async () => {
    await initializeSmallModel();
    mocks.getEmbedding.mockResolvedValueOnce(new Float32Array(768));

    await expect(
      dispatch(
        {
          target: MessageTarget.Offscreen,
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_COMPUTE,
          text: 'valid',
        },
        backgroundSender,
      ),
    ).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/dimension/i),
    });
  });

  it('rejects semantic work above the global in-flight limit', async () => {
    await initializeSmallModel();
    const resolvers: Array<(embedding: Float32Array) => void> = [];
    mocks.getEmbedding.mockImplementation(
      () => new Promise<Float32Array>((resolve) => resolvers.push(resolve)),
    );

    const requests = Array.from({ length: 4 }, (_, index) =>
      dispatch(
        {
          target: MessageTarget.Offscreen,
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_COMPUTE,
          text: `valid-${index}`,
        },
        backgroundSender,
      ),
    );
    await expect(
      dispatch(
        {
          target: MessageTarget.Offscreen,
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_COMPUTE,
          text: 'one-too-many',
        },
        backgroundSender,
      ),
    ).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/concurrent/i),
    });

    expect(resolvers).toHaveLength(4);
    resolvers.forEach((resolve) => resolve(new Float32Array(384)));
    await expect(Promise.all(requests)).resolves.toHaveLength(4);
  });
});
