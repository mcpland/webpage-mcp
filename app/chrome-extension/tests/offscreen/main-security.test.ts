import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageTarget, OFFSCREEN_MESSAGE_TYPES } from "@/common/message-types";

const mocks = vi.hoisted(() => ({
  handleGifMessage: vi.fn(),
  initKeepalive: vi.fn(),
  engineConfigs: [] as unknown[],
  engineInstances: [] as Array<{ isInitialized: boolean }>,
  initializeWithProgress: vi.fn(),
  initialize: vi.fn(),
  dispose: vi.fn(),
  getEmbedding: vi.fn(),
  getEmbeddingsBatch: vi.fn(),
  computeSimilarityBatch: vi.fn(),
}));

vi.mock("@/entrypoints/offscreen/gif-encoder", () => ({
  handleGifMessage: mocks.handleGifMessage,
}));
vi.mock("@/entrypoints/offscreen/rr-keepalive", () => ({
  initKeepalive: mocks.initKeepalive,
}));
vi.mock("@/utils/semantic-similarity-engine", () => ({
  PREDEFINED_MODELS: {
    "multilingual-e5-small": { dimension: 384 },
    "multilingual-e5-base": { dimension: 768 },
  },
  SemanticSimilarityEngine: class {
    isInitialized = false;

    constructor(config: unknown) {
      mocks.engineConfigs.push(config);
      mocks.engineInstances.push(this);
    }

    async initializeWithProgress(onProgress: unknown) {
      await mocks.initializeWithProgress(onProgress);
      this.isInitialized = true;
    }

    async initialize() {
      await mocks.initialize();
      this.isInitialized = true;
    }

    async dispose() {
      await mocks.dispose();
      this.isInitialized = false;
    }

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

describe("offscreen control authorization", () => {
  let listener: RuntimeListener;
  let runtimeSendMessage: ReturnType<typeof vi.fn>;
  let storageSet: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.engineConfigs.length = 0;
    mocks.engineInstances.length = 0;
    mocks.handleGifMessage.mockReturnValue(true);
    mocks.initializeWithProgress.mockResolvedValue(undefined);
    mocks.initialize.mockResolvedValue(undefined);
    mocks.dispose.mockResolvedValue(undefined);
    mocks.getEmbedding.mockResolvedValue(new Float32Array(384));
    mocks.getEmbeddingsBatch.mockImplementation(async (texts: string[]) =>
      texts.map(() => new Float32Array(384)),
    );
    mocks.computeSimilarityBatch.mockImplementation(async (pairs: unknown[]) =>
      pairs.map(() => 0),
    );
    runtimeSendMessage = vi.fn().mockResolvedValue({ success: true });
    storageSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-extension-id",
        getURL: vi.fn(
          (path = "") => `chrome-extension://test-extension-id/${path}`,
        ),
        onMessage: {
          addListener: vi.fn((candidate: RuntimeListener) => {
            listener = candidate;
          }),
        },
        sendMessage: runtimeSendMessage,
      },
      storage: { local: { set: storageSet } },
    });

    await import("@/entrypoints/offscreen/main");
  });

  function dispatch(
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ): Promise<any> {
    return new Promise((resolve) => {
      const keepOpen = listener(message, sender, resolve);
      if (keepOpen !== true) queueMicrotask(() => resolve(undefined));
    });
  }

  const gifReset = {
    target: MessageTarget.Offscreen,
    type: OFFSCREEN_MESSAGE_TYPES.GIF_RESET,
  };

  const backgroundSender = { id: "test-extension-id" };

  async function initializeSmallModel(
    config: Record<string, unknown> = {},
    attemptId: unknown = "small-attempt",
    includeAttemptId = true,
  ) {
    mocks.handleGifMessage.mockReturnValue(false);
    return dispatch(
      {
        target: MessageTarget.Offscreen,
        type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_INIT,
        config: {
          modelPreset: "multilingual-e5-small",
          modelVersion: "quantized",
          modelDimension: 384,
          ...config,
        },
        ...(includeAttemptId ? { attemptId } : {}),
      },
      backgroundSender,
    );
  }

  it("rejects same-extension content scripts before dispatching a GIF or semantic request", async () => {
    await expect(
      dispatch(gifReset, {
        id: "test-extension-id",
        tab: { id: 7 } as chrome.tabs.Tab,
        url: "https://example.com/",
        origin: "https://example.com",
      }),
    ).resolves.toEqual({
      success: false,
      error: "Offscreen controls require an extension context",
    });
    expect(mocks.handleGifMessage).not.toHaveBeenCalled();
  });

  it("rejects foreign extensions and forged web origins", async () => {
    for (const sender of [
      {
        id: "foreign-extension",
        url: "chrome-extension://foreign-extension/popup.html",
        origin: "chrome-extension://foreign-extension",
      },
      {
        id: "test-extension-id",
        url: "https://example.com/",
        origin: "https://example.com",
      },
    ]) {
      await expect(dispatch(gifReset, sender)).resolves.toMatchObject({
        success: false,
      });
    }
    expect(mocks.handleGifMessage).not.toHaveBeenCalled();
  });

  it("allows the background worker and extension pages", async () => {
    const background = { id: "test-extension-id" };
    const extensionPage = {
      id: "test-extension-id",
      url: "chrome-extension://test-extension-id/popup.html",
      origin: "chrome-extension://test-extension-id",
    };

    expect(listener(gifReset, background, vi.fn())).toBe(true);
    expect(listener(gifReset, extensionPage, vi.fn())).toBe(true);
    expect(mocks.handleGifMessage).toHaveBeenCalledTimes(2);
  });

  it("allows only the background worker to initialize the semantic engine", async () => {
    mocks.handleGifMessage.mockReturnValue(false);
    await expect(
      dispatch(
        {
          target: MessageTarget.Offscreen,
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_INIT,
          attemptId: "forged-attempt",
          config: {
            modelPreset: "multilingual-e5-small",
            modelVersion: "quantized",
            modelDimension: 384,
          },
        },
        {
          id: "test-extension-id",
          url: "chrome-extension://test-extension-id/popup.html",
          origin: "chrome-extension://test-extension-id",
        },
      ),
    ).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/background worker/i),
    });
    expect(mocks.engineConfigs).toHaveLength(0);
  });

  it("ignores non-offscreen and malformed messages", async () => {
    const sender = { id: "test-extension-id" };
    await expect(dispatch(null, sender)).resolves.toBeUndefined();
    await expect(
      dispatch({ target: "background" }, sender),
    ).resolves.toBeUndefined();
    expect(mocks.handleGifMessage).not.toHaveBeenCalled();
  });

  it("rejects injected model fields and mismatched dimensions before construction", async () => {
    await expect(
      initializeSmallModel({ modelIdentifier: "attacker/model" }),
    ).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/unsupported fields/i),
    });
    await expect(
      initializeSmallModel({ modelDimension: 768 }),
    ).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/dimension/i),
    });
    expect(mocks.engineConfigs).toHaveLength(0);
  });

  it("constructs the engine from a fixed whitelist for a valid preset", async () => {
    await expect(initializeSmallModel()).resolves.toEqual({
      success: true,
      isInitialized: true,
      currentConfig: {
        modelPreset: "multilingual-e5-small",
        modelVersion: "quantized",
        modelDimension: 384,
      },
    });
    expect(mocks.engineConfigs).toEqual([
      {
        modelPreset: "multilingual-e5-small",
        modelVersion: "quantized",
        dimension: 384,
        useLocalFiles: false,
        forceOffscreen: false,
      },
    ]);
    expect(storageSet).not.toHaveBeenCalled();
  });

  it("requires a bounded attempt id for real initialization but permits an exact no-op proxy", async () => {
    await expect(initializeSmallModel({}, undefined, false)).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/attemptId is required/i),
    });
    await expect(initializeSmallModel({}, "")).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/attemptId is invalid/i),
    });
    expect(mocks.engineConfigs).toHaveLength(0);

    await expect(initializeSmallModel()).resolves.toMatchObject({
      success: true,
      isInitialized: true,
    });
    const progressCalls = runtimeSendMessage.mock.calls.length;
    await expect(initializeSmallModel({}, undefined, false)).resolves.toEqual({
      success: true,
      isInitialized: true,
      currentConfig: {
        modelPreset: "multilingual-e5-small",
        modelVersion: "quantized",
        modelDimension: 384,
      },
    });
    expect(mocks.engineConfigs).toHaveLength(1);
    expect(runtimeSendMessage).toHaveBeenCalledTimes(progressCalls);
  });

  it("treats a worker-invalidated engine as unavailable until an owned rebuild succeeds", async () => {
    await initializeSmallModel();
    mocks.engineInstances[0].isInitialized = false;

    await expect(
      dispatch(
        {
          target: MessageTarget.Offscreen,
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_COMPUTE,
          text: "must-not-auto-initialize",
        },
        backgroundSender,
      ),
    ).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/not initialized/i),
    });
    expect(mocks.getEmbedding).not.toHaveBeenCalled();
    await expect(
      dispatch(
        {
          target: MessageTarget.Offscreen,
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_STATUS,
        },
        backgroundSender,
      ),
    ).resolves.toEqual({
      success: true,
      isInitialized: false,
      currentConfig: null,
    });

    await expect(initializeSmallModel({}, undefined, false)).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/attemptId is required/i),
    });
    await expect(
      initializeSmallModel({}, "worker-recovery"),
    ).resolves.toMatchObject({
      success: true,
      isInitialized: true,
    });
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.engineInstances).toHaveLength(2);
    expect(mocks.engineInstances[1].isInitialized).toBe(true);
  });

  it("reports only non-terminal bounded progress through the owning attempt", async () => {
    mocks.initializeWithProgress.mockImplementationOnce(async (onProgress) => {
      onProgress({ status: "initializing", progress: 5 });
      onProgress({ status: "downloading", progress: 100 });
      onProgress({ status: "ready", progress: 100 });
      onProgress({ status: "error", progress: 0 });
      onProgress({ status: "downloading", progress: Number.NaN });
    });

    await expect(
      initializeSmallModel({}, "progress-owner"),
    ).resolves.toMatchObject({
      success: true,
    });
    expect(runtimeSendMessage).toHaveBeenCalledTimes(3);
    expect(runtimeSendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "update_model_status",
        attemptId: "progress-owner",
        modelState: expect.objectContaining({
          status: "initializing",
          downloadProgress: 10,
        }),
      }),
    );
    expect(runtimeSendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        attemptId: "progress-owner",
        modelState: expect.objectContaining({
          status: "initializing",
          downloadProgress: 5,
        }),
      }),
    );
    expect(runtimeSendMessage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        attemptId: "progress-owner",
        modelState: expect.objectContaining({
          status: "downloading",
          downloadProgress: 99,
        }),
      }),
    );
    expect(storageSet).not.toHaveBeenCalled();
  });

  it("disposes a failed candidate and keeps the engine unpublished", async () => {
    mocks.initializeWithProgress.mockRejectedValueOnce(
      new Error("candidate failed"),
    );

    await expect(initializeSmallModel()).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/candidate failed/i),
    });
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
    await expect(
      dispatch(
        {
          target: MessageTarget.Offscreen,
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_STATUS,
        },
        backgroundSender,
      ),
    ).resolves.toEqual({
      success: true,
      isInitialized: false,
      currentConfig: null,
    });
  });

  it("drains queued progress before returning an initialization failure", async () => {
    let releaseProgress!: () => void;
    const blockedProgress = new Promise<{ success: true }>((resolve) => {
      releaseProgress = () => resolve({ success: true });
    });
    runtimeSendMessage
      .mockResolvedValueOnce({ success: true })
      .mockImplementationOnce(() => blockedProgress);
    mocks.initializeWithProgress.mockImplementationOnce(async (onProgress) => {
      onProgress({ status: "downloading", progress: 50 });
      throw new Error("initialization failed after progress");
    });

    let settled = false;
    const initialization = initializeSmallModel().finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(runtimeSendMessage).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseProgress();
    await expect(initialization).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/initialization failed after progress/i),
    });
  });

  it("revokes the old engine before disposal and does not construct after disposal failure", async () => {
    await initializeSmallModel();
    mocks.dispose.mockRejectedValueOnce(new Error("old dispose failed"));

    await expect(
      initializeSmallModel(
        {
          modelPreset: "multilingual-e5-base",
          modelVersion: "compressed",
          modelDimension: 768,
        },
        "base-attempt",
      ),
    ).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/old dispose failed/i),
    });
    expect(mocks.engineConfigs).toHaveLength(1);
    await expect(
      dispatch(
        {
          target: MessageTarget.Offscreen,
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_STATUS,
        },
        backgroundSender,
      ),
    ).resolves.toEqual({
      success: true,
      isInitialized: false,
      currentConfig: null,
    });
  });

  it("does not construct a candidate when the background rejects the attempt progress", async () => {
    runtimeSendMessage.mockResolvedValueOnce({
      success: false,
      error: "attempt is no longer active",
    });

    await expect(initializeSmallModel()).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/no longer active/i),
    });
    expect(mocks.engineConfigs).toHaveLength(0);
  });

  it("allows only one model initialization in flight", async () => {
    let resolveInitialization!: () => void;
    mocks.initializeWithProgress.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveInitialization = resolve)),
    );

    const firstInitialization = initializeSmallModel();
    await vi.waitFor(() =>
      expect(mocks.initializeWithProgress).toHaveBeenCalledTimes(1),
    );
    await expect(initializeSmallModel()).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/busy/i),
    });
    resolveInitialization();
    await expect(firstInitialization).resolves.toMatchObject({ success: true });
  });

  it("rejects oversized text and malformed options before invoking the engine", async () => {
    await initializeSmallModel();

    await expect(
      dispatch(
        {
          target: MessageTarget.Offscreen,
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_COMPUTE,
          text: "a".repeat(32 * 1024 + 1),
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
          text: "valid",
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

  it("rejects an embedding whose dimension does not match the active model", async () => {
    await initializeSmallModel();
    mocks.getEmbedding.mockResolvedValueOnce(new Float32Array(768));

    await expect(
      dispatch(
        {
          target: MessageTarget.Offscreen,
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_COMPUTE,
          text: "valid",
        },
        backgroundSender,
      ),
    ).resolves.toEqual({
      success: false,
      error: expect.stringMatching(/dimension/i),
    });
  });

  it("rejects semantic work above the global in-flight limit", async () => {
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
          text: "one-too-many",
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
