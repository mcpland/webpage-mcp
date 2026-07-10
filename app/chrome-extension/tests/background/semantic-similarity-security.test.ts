import { beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_MESSAGE_TYPES } from "@/common/message-types";

const semanticMocks = vi.hoisted(() => ({ hasAnyModelCache: vi.fn() }));
const offscreenMocks = vi.hoisted(() => ({ ensureOffscreenDocument: vi.fn() }));
const indexerMocks = vi.hoisted(() => ({
  runExclusiveModelTransition: vi.fn(),
  initialize: vi.fn(),
  reinitialize: vi.fn(),
  recoveryRequired: false,
}));

vi.mock("@/utils/semantic-similarity-engine", () => ({
  hasAnyModelCache: semanticMocks.hasAnyModelCache,
  PREDEFINED_MODELS: {
    "multilingual-e5-small": { dimension: 384 },
    "multilingual-e5-base": { dimension: 768 },
  },
}));
vi.mock("@/utils/offscreen-manager", () => ({
  OffscreenManager: {
    getInstance: () => ({
      ensureOffscreenDocument: offscreenMocks.ensureOffscreenDocument,
    }),
  },
}));
vi.mock("@/utils/content-indexer", () => ({
  getGlobalContentIndexer: () => indexerMocks,
}));

type RuntimeListener = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void,
) => boolean | undefined;

describe("semantic engine control authorization", () => {
  let listener: RuntimeListener;
  let storageGet: ReturnType<typeof vi.fn>;
  let storageSet: ReturnType<typeof vi.fn>;
  let runtimeSendMessage: ReturnType<typeof vi.fn>;
  let persistedStorage: Record<string, any>;
  let transitionAttempt = 0;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    transitionAttempt = 0;
    indexerMocks.recoveryRequired = false;
    persistedStorage = {
      selectedModel: "multilingual-e5-small",
      selectedVersion: "quantized",
      modelState: {
        status: "ready",
        downloadProgress: 100,
        isDownloading: false,
        lastUpdated: 1,
        errorMessage: "",
        errorType: "",
      },
    };
    storageGet = vi.fn(async (keys: string | string[]) => {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        requested
          .filter((key) =>
            Object.prototype.hasOwnProperty.call(persistedStorage, key),
          )
          .map((key) => [key, persistedStorage[key]]),
      );
    });
    storageSet = vi.fn(async (value: Record<string, unknown>) => {
      Object.assign(persistedStorage, value);
    });
    runtimeSendMessage = vi.fn(async (message: any) => {
      const currentConfig =
        message.type === "similarityEngineStatus"
          ? {
              modelPreset: persistedStorage.selectedModel,
              modelVersion: persistedStorage.selectedVersion,
              modelDimension:
                persistedStorage.selectedModel === "multilingual-e5-base"
                  ? 768
                  : 384,
            }
          : message.config;
      return { success: true, isInitialized: true, currentConfig };
    });
    indexerMocks.runExclusiveModelTransition.mockImplementation(
      async (operation: (transition: any) => Promise<unknown>) => {
        const attemptId = `transition-${++transitionAttempt}`;
        persistedStorage.semanticCleanupRequired = {
          schemaVersion: 1,
          state: "required",
          attemptId,
          kind: "index-recovery",
          startedAt: Date.now(),
        };
        const result = await operation({
          attemptId,
          recoveryRequired: indexerMocks.recoveryRequired,
          initializeForModel: indexerMocks.initialize,
          reinitializeForModel: indexerMocks.reinitialize,
        });
        persistedStorage.semanticCleanupRequired = {
          schemaVersion: 1,
          state: "clear",
          attemptId,
          completedAt: Date.now(),
        };
        return result;
      },
    );
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
      storage: { local: { get: storageGet, set: storageSet } },
    });

    const { initSemanticSimilarityListener } =
      await import("@/entrypoints/background/semantic-similarity");
    initSemanticSimilarityListener();
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

  function extensionSender(): chrome.runtime.MessageSender {
    return {
      id: "test-extension-id",
      url: "chrome-extension://test-extension-id/popup.html",
      origin: "chrome-extension://test-extension-id",
    };
  }

  function offscreenSender(): chrome.runtime.MessageSender {
    return {
      id: "test-extension-id",
      url: "chrome-extension://test-extension-id/offscreen.html",
      origin: "chrome-extension://test-extension-id",
    };
  }

  function contentSender(): chrome.runtime.MessageSender {
    return {
      id: "test-extension-id",
      tab: { id: 4 } as chrome.tabs.Tab,
      url: "https://example.com/",
      origin: "https://example.com",
    };
  }

  function rejectNextStorageWriteMatching(
    predicate: (value: Record<string, any>) => boolean,
    error: Error,
  ): void {
    let rejected = false;
    storageSet.mockImplementation(async (value: Record<string, any>) => {
      if (!rejected && predicate(value)) {
        rejected = true;
        throw error;
      }
      Object.assign(persistedStorage, value);
    });
  }

  it.each([
    BACKGROUND_MESSAGE_TYPES.SWITCH_SEMANTIC_MODEL,
    BACKGROUND_MESSAGE_TYPES.GET_MODEL_STATUS,
    BACKGROUND_MESSAGE_TYPES.INITIALIZE_SEMANTIC_ENGINE,
  ])("rejects content-script control request %s", async (type) => {
    await expect(dispatch({ type }, contentSender())).resolves.toEqual({
      success: false,
      error: "Unauthorized semantic engine control request",
    });
    expect(storageGet).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it("allows extension pages to query model status", async () => {
    await expect(
      dispatch(
        { type: BACKGROUND_MESSAGE_TYPES.GET_MODEL_STATUS },
        extensionSender(),
      ),
    ).resolves.toMatchObject({
      success: true,
      status: { initializationStatus: "ready", downloadProgress: 100 },
    });
    expect(storageGet).toHaveBeenCalledWith(["modelState"]);
    expect(runtimeSendMessage).toHaveBeenCalledWith({
      target: "offscreen",
      type: "similarityEngineStatus",
    });
  });

  it.each([
    ["missing", new Error("Receiving end does not exist")],
    [
      "not initialized",
      { success: true, isInitialized: false, currentConfig: null },
    ],
    [
      "config mismatch",
      {
        success: true,
        isInitialized: true,
        currentConfig: {
          modelPreset: "multilingual-e5-base",
          modelVersion: "compressed",
          modelDimension: 768,
        },
      },
    ],
  ])(
    "does not report stored ready when offscreen is %s",
    async (_label, response) => {
      if (response instanceof Error) {
        runtimeSendMessage.mockRejectedValueOnce(response);
      } else {
        runtimeSendMessage.mockResolvedValueOnce(response);
      }

      await expect(
        dispatch(
          { type: BACKGROUND_MESSAGE_TYPES.GET_MODEL_STATUS },
          extensionSender(),
        ),
      ).resolves.toMatchObject({
        success: true,
        status: {
          initializationStatus: "error",
          errorMessage: expect.stringMatching(/recovery is required/i),
        },
      });
      expect(offscreenMocks.ensureOffscreenDocument).not.toHaveBeenCalled();
    },
  );

  it("does not report ready from an explicitly invalid persisted selection", async () => {
    persistedStorage.selectedModel = "attacker/model";
    persistedStorage.selectedVersion = "latest";

    await expect(
      dispatch(
        { type: BACKGROUND_MESSAGE_TYPES.GET_MODEL_STATUS },
        extensionSender(),
      ),
    ).resolves.toMatchObject({
      success: true,
      status: { initializationStatus: "error" },
    });
    expect(runtimeSendMessage).not.toHaveBeenCalled();
  });

  it("rechecks the durable gate after offscreen ready verification", async () => {
    runtimeSendMessage.mockImplementationOnce(async () => {
      persistedStorage.semanticCleanupRequired = {
        schemaVersion: 1,
        state: "required",
        attemptId: "new-transition",
        kind: "index-recovery",
        startedAt: Date.now(),
      };
      return {
        success: true,
        isInitialized: true,
        currentConfig: {
          modelPreset: "multilingual-e5-small",
          modelVersion: "quantized",
          modelDimension: 384,
        },
      };
    });

    await expect(
      dispatch(
        { type: BACKGROUND_MESSAGE_TYPES.GET_MODEL_STATUS },
        extensionSender(),
      ),
    ).resolves.toMatchObject({
      success: true,
      status: { initializationStatus: "error" },
    });
  });

  it("never exposes a stored ready state while durable recovery is required", async () => {
    persistedStorage.semanticCleanupRequired = {
      schemaVersion: 1,
      state: "required",
      attemptId: "interrupted-attempt",
      kind: "index-recovery",
      startedAt: 1,
    };

    await expect(
      dispatch(
        { type: BACKGROUND_MESSAGE_TYPES.GET_MODEL_STATUS },
        extensionSender(),
      ),
    ).resolves.toMatchObject({
      success: true,
      status: {
        initializationStatus: "error",
        downloadProgress: 0,
        isDownloading: false,
        errorMessage: expect.stringMatching(/recovery is required/i),
      },
    });
  });

  it("only routes model progress updates from the exact offscreen document", async () => {
    const message = {
      type: BACKGROUND_MESSAGE_TYPES.UPDATE_MODEL_STATUS,
      attemptId: "transition-1",
      modelState: { status: "downloading", downloadProgress: 40 },
    };

    await expect(dispatch(message, extensionSender())).resolves.toMatchObject({
      success: false,
    });
    await expect(dispatch(message, contentSender())).resolves.toMatchObject({
      success: false,
    });
    expect(storageSet).not.toHaveBeenCalled();

    await expect(dispatch(message, offscreenSender())).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/no longer active/i),
    });
    expect(storageSet).not.toHaveBeenCalled();
  });

  it("accepts only non-terminal progress owned by the active durable attempt", async () => {
    let resolveOffscreen!: (response: unknown) => void;
    runtimeSendMessage.mockImplementationOnce(
      () => new Promise((resolve) => (resolveOffscreen = resolve)),
    );
    const { handleModelSwitch } =
      await import("@/entrypoints/background/semantic-similarity");
    const switching = handleModelSwitch(
      "multilingual-e5-base",
      "compressed",
      768,
    );
    await vi.waitFor(() => expect(runtimeSendMessage).toHaveBeenCalledTimes(1));

    await expect(
      dispatch(
        {
          type: BACKGROUND_MESSAGE_TYPES.UPDATE_MODEL_STATUS,
          attemptId: "transition-1",
          modelState: { status: "downloading", downloadProgress: 42 },
        },
        offscreenSender(),
      ),
    ).resolves.toEqual({ success: true });
    expect(persistedStorage.modelState).toMatchObject({
      status: "downloading",
      downloadProgress: 42,
    });
    await expect(
      dispatch(
        { type: BACKGROUND_MESSAGE_TYPES.GET_MODEL_STATUS },
        extensionSender(),
      ),
    ).resolves.toMatchObject({
      success: true,
      status: {
        initializationStatus: "downloading",
        downloadProgress: 42,
        isDownloading: true,
      },
    });

    for (const modelState of [
      { status: "ready", downloadProgress: 100 },
      { status: "error", downloadProgress: 0 },
      { status: "downloading", downloadProgress: 100 },
    ]) {
      await expect(
        dispatch(
          {
            type: BACKGROUND_MESSAGE_TYPES.UPDATE_MODEL_STATUS,
            attemptId: "transition-1",
            modelState,
          },
          offscreenSender(),
        ),
      ).resolves.toMatchObject({ success: false });
    }

    const requested = runtimeSendMessage.mock.calls[0][0];
    resolveOffscreen({
      success: true,
      isInitialized: true,
      currentConfig: requested.config,
    });
    await expect(switching).resolves.toEqual({ success: true });
    await expect(
      dispatch(
        {
          type: BACKGROUND_MESSAGE_TYPES.UPDATE_MODEL_STATUS,
          attemptId: "transition-1",
          modelState: { status: "initializing", downloadProgress: 5 },
        },
        offscreenSender(),
      ),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/no longer active/i),
    });
  });

  it("does not let the offscreen document invoke UI controls", async () => {
    await expect(
      dispatch(
        { type: BACKGROUND_MESSAGE_TYPES.GET_MODEL_STATUS },
        offscreenSender(),
      ),
    ).resolves.toMatchObject({ success: false });
    expect(storageGet).not.toHaveBeenCalled();
  });

  it("ignores unrelated and malformed messages", async () => {
    await expect(dispatch(null, contentSender())).resolves.toBeUndefined();
    await expect(
      dispatch({ type: "unrelated" }, contentSender()),
    ).resolves.toBeUndefined();
  });

  it("falls back from invalid stored preset and version before initializing", async () => {
    persistedStorage.selectedModel = "attacker/model";
    persistedStorage.selectedVersion = "latest";

    const { initializeDefaultSemanticEngine } =
      await import("@/entrypoints/background/semantic-similarity");
    await initializeDefaultSemanticEngine();

    expect(runtimeSendMessage).toHaveBeenCalledWith({
      target: "offscreen",
      type: expect.any(String),
      attemptId: "transition-1",
      config: {
        modelPreset: "multilingual-e5-small",
        modelVersion: "quantized",
        modelDimension: 384,
      },
    });
    expect(persistedStorage).toMatchObject({
      selectedModel: "multilingual-e5-small",
      selectedVersion: "quantized",
      modelState: expect.objectContaining({ status: "ready" }),
    });
  });

  it("rebuilds the default index when the transition reports interrupted recovery", async () => {
    indexerMocks.recoveryRequired = true;
    const { initializeDefaultSemanticEngine } =
      await import("@/entrypoints/background/semantic-similarity");

    await initializeDefaultSemanticEngine();

    expect(indexerMocks.initialize).not.toHaveBeenCalled();
    expect(indexerMocks.reinitialize).toHaveBeenCalledWith({
      modelPreset: "multilingual-e5-small",
      modelVersion: "quantized",
      modelDimension: 384,
    });
  });

  it("fails closed when the stored default selection cannot be read", async () => {
    storageGet.mockImplementation(async (keys: string | string[]) => {
      const requested = Array.isArray(keys) ? keys : [keys];
      if (requested.includes("selectedModel")) {
        throw new Error("selection read failed");
      }
      return Object.fromEntries(
        requested
          .filter((key) =>
            Object.prototype.hasOwnProperty.call(persistedStorage, key),
          )
          .map((key) => [key, persistedStorage[key]]),
      );
    });
    const { initializeDefaultSemanticEngine } =
      await import("@/entrypoints/background/semantic-similarity");

    await expect(initializeDefaultSemanticEngine()).rejects.toThrow(
      /selection read failed/i,
    );
    expect(runtimeSendMessage).not.toHaveBeenCalled();
    expect(indexerMocks.initialize).not.toHaveBeenCalled();
    expect(indexerMocks.reinitialize).not.toHaveBeenCalled();
  });

  it("queues a switch until startup default initialization fully settles", async () => {
    let resolveDefaultOffscreen!: (value: unknown) => void;
    const blockedDefaultOffscreen = new Promise<unknown>((resolve) => {
      resolveDefaultOffscreen = resolve;
    });
    let releaseDefaultIndexer!: () => void;
    const blockedDefaultIndexer = new Promise<void>((resolve) => {
      releaseDefaultIndexer = resolve;
    });
    let releaseDefaultReady!: () => void;
    const blockedDefaultReady = new Promise<void>((resolve) => {
      releaseDefaultReady = resolve;
    });
    let shouldBlockDefaultReady = true;
    runtimeSendMessage
      .mockImplementationOnce(() => blockedDefaultOffscreen)
      .mockResolvedValueOnce({
        success: true,
        isInitialized: true,
        currentConfig: {
          modelPreset: "multilingual-e5-base",
          modelVersion: "compressed",
          modelDimension: 768,
        },
      });
    indexerMocks.initialize.mockImplementationOnce(() => blockedDefaultIndexer);
    storageSet.mockImplementation(async (value) => {
      if (shouldBlockDefaultReady && value.modelState?.status === "ready") {
        shouldBlockDefaultReady = false;
        await blockedDefaultReady;
      }
      Object.assign(persistedStorage, value);
    });
    const { handleModelSwitch, initializeDefaultSemanticEngine } =
      await import("@/entrypoints/background/semantic-similarity");

    const defaultResult = initializeDefaultSemanticEngine();
    const switchResult = handleModelSwitch(
      "multilingual-e5-base",
      "compressed",
      768,
    );

    await vi.waitFor(() => expect(runtimeSendMessage).toHaveBeenCalledTimes(1));
    expect(runtimeSendMessage).toHaveBeenNthCalledWith(1, {
      target: "offscreen",
      type: expect.any(String),
      attemptId: "transition-1",
      config: {
        modelPreset: "multilingual-e5-small",
        modelVersion: "quantized",
        modelDimension: 384,
      },
    });
    expect(indexerMocks.reinitialize).not.toHaveBeenCalled();

    resolveDefaultOffscreen({
      success: true,
      isInitialized: true,
      currentConfig: {
        modelPreset: "multilingual-e5-small",
        modelVersion: "quantized",
        modelDimension: 384,
      },
    });
    await vi.waitFor(() =>
      expect(indexerMocks.initialize).toHaveBeenCalledTimes(1),
    );
    expect(runtimeSendMessage).toHaveBeenCalledTimes(1);
    expect(storageSet).not.toHaveBeenCalledWith({
      selectedModel: "multilingual-e5-base",
      selectedVersion: "compressed",
    });

    releaseDefaultIndexer();
    await vi.waitFor(() =>
      expect(storageSet).toHaveBeenCalledWith({
        modelState: expect.objectContaining({ status: "ready" }),
      }),
    );
    expect(runtimeSendMessage).toHaveBeenCalledTimes(1);
    expect(storageSet).not.toHaveBeenCalledWith({
      selectedModel: "multilingual-e5-base",
      selectedVersion: "compressed",
    });

    releaseDefaultReady();
    await expect(defaultResult).resolves.toBeUndefined();
    await expect(switchResult).resolves.toEqual({ success: true });

    expect(indexerMocks.initialize).toHaveBeenCalledTimes(1);
    expect(runtimeSendMessage).toHaveBeenNthCalledWith(2, {
      target: "offscreen",
      type: expect.any(String),
      attemptId: "transition-2",
      config: {
        modelPreset: "multilingual-e5-base",
        modelVersion: "compressed",
        modelDimension: 768,
      },
    });
    expect(indexerMocks.reinitialize).toHaveBeenCalledTimes(1);
    expect(persistedStorage).toMatchObject({
      selectedModel: "multilingual-e5-base",
      selectedVersion: "compressed",
      modelState: expect.objectContaining({ status: "ready" }),
    });

    await expect(
      handleModelSwitch("multilingual-e5-base", "compressed", 768),
    ).resolves.toEqual({ success: true });
    expect(runtimeSendMessage).toHaveBeenCalledTimes(3);
    expect(indexerMocks.reinitialize).toHaveBeenCalledTimes(2);
  });

  it("reports a rejected default offscreen initialization through the endpoint", async () => {
    runtimeSendMessage.mockRejectedValueOnce(
      new Error("default offscreen failed"),
    );

    await expect(
      dispatch(
        { type: BACKGROUND_MESSAGE_TYPES.INITIALIZE_SEMANTIC_ENGINE },
        extensionSender(),
      ),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/default offscreen failed/i),
    });
    expect(storageSet).toHaveBeenLastCalledWith({
      modelState: expect.objectContaining({ status: "error" }),
    });
    expect(indexerMocks.initialize).not.toHaveBeenCalled();
  });

  it("reports default indexer failure without committing the current target", async () => {
    indexerMocks.initialize.mockRejectedValueOnce(
      new Error("default indexer failed"),
    );

    await expect(
      dispatch(
        { type: BACKGROUND_MESSAGE_TYPES.INITIALIZE_SEMANTIC_ENGINE },
        extensionSender(),
      ),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/default indexer failed/i),
    });
    expect(storageSet).toHaveBeenLastCalledWith({
      modelState: expect.objectContaining({ status: "error" }),
    });

    await expect(
      dispatch(
        {
          type: BACKGROUND_MESSAGE_TYPES.SWITCH_SEMANTIC_MODEL,
          modelPreset: "multilingual-e5-small",
          modelVersion: "quantized",
          modelDimension: 384,
        },
        extensionSender(),
      ),
    ).resolves.toEqual({ success: true });
    expect(runtimeSendMessage).toHaveBeenCalledTimes(2);
    expect(indexerMocks.reinitialize).toHaveBeenCalledTimes(1);
  });

  it("reports ready persistence failure and leaves the same target retryable", async () => {
    rejectNextStorageWriteMatching(
      (value) => value.modelState?.status === "ready",
      new Error("default ready persistence failed"),
    );
    await expect(
      dispatch(
        { type: BACKGROUND_MESSAGE_TYPES.INITIALIZE_SEMANTIC_ENGINE },
        extensionSender(),
      ),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/default ready persistence failed/i),
    });
    expect(storageSet).toHaveBeenLastCalledWith({
      modelState: expect.objectContaining({ status: "error" }),
    });
    expect(indexerMocks.initialize).toHaveBeenCalledTimes(1);

    await expect(
      dispatch(
        {
          type: BACKGROUND_MESSAGE_TYPES.SWITCH_SEMANTIC_MODEL,
          modelPreset: "multilingual-e5-small",
          modelVersion: "quantized",
          modelDimension: 384,
        },
        extensionSender(),
      ),
    ).resolves.toEqual({ success: true });
    expect(runtimeSendMessage).toHaveBeenCalledTimes(2);
    expect(indexerMocks.reinitialize).toHaveBeenCalledTimes(1);
    expect(storageSet).toHaveBeenLastCalledWith({
      modelState: expect.objectContaining({ status: "ready" }),
    });
  });

  it("strictly validates model switch parameters before offscreen work", async () => {
    const { handleModelSwitch } =
      await import("@/entrypoints/background/semantic-similarity");

    await expect(
      handleModelSwitch("attacker/model", "quantized", 384),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/preset/i),
    });
    await expect(
      handleModelSwitch("multilingual-e5-small", "latest", 384),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/version/i),
    });
    await expect(
      handleModelSwitch("multilingual-e5-small", undefined, 384),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/version/i),
    });
    await expect(
      handleModelSwitch("multilingual-e5-small", "quantized", 768),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/dimension/i),
    });
    expect(offscreenMocks.ensureOffscreenDocument).not.toHaveBeenCalled();
    expect(runtimeSendMessage).not.toHaveBeenCalled();
  });

  it("rejects an offscreen success response whose active config differs", async () => {
    runtimeSendMessage.mockResolvedValueOnce({
      success: true,
      isInitialized: true,
      currentConfig: {
        modelPreset: "multilingual-e5-small",
        modelVersion: "quantized",
        modelDimension: 384,
      },
    });
    const { handleModelSwitch } =
      await import("@/entrypoints/background/semantic-similarity");

    await expect(
      handleModelSwitch("multilingual-e5-base", "compressed", 768),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/different model config/i),
    });
    expect(indexerMocks.reinitialize).not.toHaveBeenCalled();
    expect(persistedStorage.modelState.status).toBe("error");
  });

  it("fails closed when model selection set succeeds but readback differs", async () => {
    storageSet.mockImplementation(async (value: Record<string, any>) => {
      Object.assign(persistedStorage, value);
      if (Object.prototype.hasOwnProperty.call(value, "selectedModel")) {
        persistedStorage.selectedVersion = "corrupted";
      }
    });
    const { handleModelSwitch } =
      await import("@/entrypoints/background/semantic-similarity");

    await expect(
      handleModelSwitch("multilingual-e5-base", "compressed", 768),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/selection readback mismatched/i),
    });
    expect(indexerMocks.reinitialize).not.toHaveBeenCalled();
    expect(persistedStorage.modelState.status).toBe("error");
  });

  it("persists ready only after the durable transition has cleared", async () => {
    let readySawClearMarker = false;
    storageSet.mockImplementation(async (value: Record<string, any>) => {
      if (value.modelState?.status === "ready") {
        readySawClearMarker =
          persistedStorage.semanticCleanupRequired?.state === "clear";
      }
      Object.assign(persistedStorage, value);
    });
    const { handleModelSwitch } =
      await import("@/entrypoints/background/semantic-similarity");

    await expect(
      handleModelSwitch("multilingual-e5-base", "compressed", 768),
    ).resolves.toEqual({ success: true });
    expect(readySawClearMarker).toBe(true);
  });

  it.each([
    ["omitted", undefined],
    ["forged target dimension", 768],
    ["forged invalid value", "forged"],
  ] as const)(
    "rebuilds and persists a valid switch when previousDimension is %s",
    async (_label, previousDimension) => {
      indexerMocks.reinitialize.mockImplementation(async () => {
        expect(storageSet).toHaveBeenCalledWith({
          selectedModel: "multilingual-e5-base",
          selectedVersion: "compressed",
        });
      });
      const { handleModelSwitch } =
        await import("@/entrypoints/background/semantic-similarity");

      await expect(
        handleModelSwitch(
          "multilingual-e5-base",
          "compressed",
          768,
          previousDimension,
        ),
      ).resolves.toEqual({ success: true });
      expect(runtimeSendMessage).toHaveBeenCalledWith({
        target: "offscreen",
        type: expect.any(String),
        attemptId: "transition-1",
        config: {
          modelPreset: "multilingual-e5-base",
          modelVersion: "compressed",
          modelDimension: 768,
        },
      });
      expect(storageSet).toHaveBeenCalledWith({
        selectedModel: "multilingual-e5-base",
        selectedVersion: "compressed",
      });
      expect(indexerMocks.reinitialize).toHaveBeenCalledTimes(1);
      expect(storageSet).toHaveBeenLastCalledWith({
        modelState: expect.objectContaining({
          status: "ready",
          downloadProgress: 100,
          isDownloading: false,
        }),
      });
    },
  );

  it("fails closed on reinitialization failure and retries the same target", async () => {
    indexerMocks.reinitialize
      .mockRejectedValueOnce(new Error("reinitialize failed"))
      .mockResolvedValueOnce(undefined);
    const { handleModelSwitch } =
      await import("@/entrypoints/background/semantic-similarity");

    await expect(
      handleModelSwitch("multilingual-e5-base", "compressed", 768),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/reinitialize failed/i),
    });
    expect(storageSet).toHaveBeenCalledWith({
      selectedModel: "multilingual-e5-base",
      selectedVersion: "compressed",
    });
    expect(storageSet).toHaveBeenLastCalledWith({
      modelState: expect.objectContaining({ status: "error" }),
    });
    expect(
      storageSet.mock.calls.some(
        ([value]) => value.modelState && value.modelState.status === "ready",
      ),
    ).toBe(false);

    await expect(
      handleModelSwitch("multilingual-e5-base", "compressed", 768),
    ).resolves.toEqual({ success: true });
    expect(runtimeSendMessage).toHaveBeenCalledTimes(2);
    expect(indexerMocks.reinitialize).toHaveBeenCalledTimes(2);
  });

  it("revalidates an explicit same-target switch when offscreen has disappeared", async () => {
    const { handleModelSwitch } =
      await import("@/entrypoints/background/semantic-similarity");

    await expect(
      handleModelSwitch("multilingual-e5-small", "quantized", 384),
    ).resolves.toEqual({ success: true });
    runtimeSendMessage.mockRejectedValueOnce(new Error("offscreen missing"));
    await expect(
      handleModelSwitch("multilingual-e5-small", "quantized", 384),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/offscreen missing/i),
    });
    expect(runtimeSendMessage).toHaveBeenCalledTimes(2);
    expect(indexerMocks.reinitialize).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the initial status cannot be persisted", async () => {
    storageSet.mockRejectedValueOnce(new Error("status persistence failed"));
    const { handleModelSwitch } =
      await import("@/entrypoints/background/semantic-similarity");

    await expect(
      handleModelSwitch("multilingual-e5-base", "compressed", 768),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/status persistence failed/i),
    });
    expect(runtimeSendMessage).not.toHaveBeenCalled();
    expect(indexerMocks.reinitialize).not.toHaveBeenCalled();
    expect(storageSet).toHaveBeenLastCalledWith({
      modelState: expect.objectContaining({ status: "error" }),
    });
  });

  it("fails closed when target selection persistence rejects and retries", async () => {
    rejectNextStorageWriteMatching(
      (value) => Object.prototype.hasOwnProperty.call(value, "selectedModel"),
      new Error("selection persistence failed"),
    );
    const { handleModelSwitch } =
      await import("@/entrypoints/background/semantic-similarity");

    await expect(
      handleModelSwitch("multilingual-e5-base", "compressed", 768),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/selection persistence failed/i),
    });
    expect(indexerMocks.reinitialize).not.toHaveBeenCalled();
    expect(storageSet).toHaveBeenLastCalledWith({
      modelState: expect.objectContaining({ status: "error" }),
    });

    await expect(
      handleModelSwitch("multilingual-e5-base", "compressed", 768),
    ).resolves.toEqual({ success: true });
    expect(runtimeSendMessage).toHaveBeenCalledTimes(2);
    expect(indexerMocks.reinitialize).toHaveBeenCalledTimes(1);
  });

  it("does not commit ready/current state when ready status persistence rejects", async () => {
    rejectNextStorageWriteMatching(
      (value) => value.modelState?.status === "ready",
      new Error("ready status persistence failed"),
    );
    const { handleModelSwitch } =
      await import("@/entrypoints/background/semantic-similarity");

    await expect(
      handleModelSwitch("multilingual-e5-base", "compressed", 768),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/ready status persistence failed/i),
    });
    expect(storageSet).toHaveBeenLastCalledWith({
      modelState: expect.objectContaining({ status: "error" }),
    });

    await expect(
      handleModelSwitch("multilingual-e5-base", "compressed", 768),
    ).resolves.toEqual({ success: true });
    expect(runtimeSendMessage).toHaveBeenCalledTimes(2);
    expect(indexerMocks.reinitialize).toHaveBeenCalledTimes(2);
  });

  it("rejects a ready write whose durable readback differs", async () => {
    storageSet.mockImplementation(async (value: Record<string, any>) => {
      Object.assign(persistedStorage, value);
      if (value.modelState?.status === "ready") {
        persistedStorage.modelState = {
          ...persistedStorage.modelState,
          downloadProgress: 99,
        };
      }
    });
    const { handleModelSwitch } =
      await import("@/entrypoints/background/semantic-similarity");

    await expect(
      handleModelSwitch("multilingual-e5-base", "compressed", 768),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/status readback mismatched/i),
    });
    expect(indexerMocks.reinitialize).toHaveBeenCalledTimes(1);
    expect(persistedStorage.modelState.status).toBe("error");
  });

  it("serializes concurrent targets and continues only after a failed transaction settles", async () => {
    let rejectFirstReinitialize!: (reason?: unknown) => void;
    const firstReinitialize = new Promise<void>((_resolve, reject) => {
      rejectFirstReinitialize = reject;
    });
    let releaseErrorStatus!: () => void;
    const blockedErrorStatus = new Promise<void>((resolve) => {
      releaseErrorStatus = resolve;
    });
    storageSet.mockImplementation(async (value) => {
      if (value.modelState?.status === "error") {
        await blockedErrorStatus;
      }
      Object.assign(persistedStorage, value);
    });
    indexerMocks.reinitialize
      .mockImplementationOnce(() => firstReinitialize)
      .mockResolvedValueOnce(undefined);
    const { handleModelSwitch } =
      await import("@/entrypoints/background/semantic-similarity");

    const firstResult = handleModelSwitch(
      "multilingual-e5-base",
      "compressed",
      768,
    );
    const secondResult = handleModelSwitch(
      "multilingual-e5-small",
      "quantized",
      384,
    );

    await vi.waitFor(() =>
      expect(indexerMocks.reinitialize).toHaveBeenCalledTimes(1),
    );
    expect(runtimeSendMessage).toHaveBeenCalledTimes(1);
    expect(storageSet).not.toHaveBeenCalledWith({
      selectedModel: "multilingual-e5-small",
      selectedVersion: "quantized",
    });

    rejectFirstReinitialize(new Error("first switch failed"));
    await vi.waitFor(() =>
      expect(storageSet).toHaveBeenCalledWith({
        modelState: expect.objectContaining({ status: "error" }),
      }),
    );
    expect(runtimeSendMessage).toHaveBeenCalledTimes(1);

    releaseErrorStatus();
    await expect(firstResult).resolves.toMatchObject({ success: false });
    await expect(secondResult).resolves.toEqual({ success: true });

    expect(runtimeSendMessage).toHaveBeenNthCalledWith(1, {
      target: "offscreen",
      type: expect.any(String),
      attemptId: "transition-1",
      config: {
        modelPreset: "multilingual-e5-base",
        modelVersion: "compressed",
        modelDimension: 768,
      },
    });
    expect(runtimeSendMessage).toHaveBeenNthCalledWith(2, {
      target: "offscreen",
      type: expect.any(String),
      attemptId: "transition-2",
      config: {
        modelPreset: "multilingual-e5-small",
        modelVersion: "quantized",
        modelDimension: 384,
      },
    });
    expect(persistedStorage).toMatchObject({
      selectedModel: "multilingual-e5-small",
      selectedVersion: "quantized",
      modelState: expect.objectContaining({ status: "ready" }),
    });

    // An explicit same-target request still runs a complete recovery
    // transaction; in-memory state is never accepted as proof that offscreen
    // and the durable index survived together.
    await expect(
      handleModelSwitch("multilingual-e5-small", "quantized", 384),
    ).resolves.toEqual({ success: true });
    expect(runtimeSendMessage).toHaveBeenCalledTimes(3);
    expect(indexerMocks.reinitialize).toHaveBeenCalledTimes(3);
  });

  it("normalizes stored status fields before returning them", async () => {
    storageGet.mockResolvedValue({
      modelState: {
        status: "attacker",
        downloadProgress: Number.POSITIVE_INFINITY,
        isDownloading: true,
        lastUpdated: -1,
        errorMessage: "x".repeat(10_000),
        errorType: "attacker",
        injected: true,
      },
    });

    await expect(
      dispatch(
        { type: BACKGROUND_MESSAGE_TYPES.GET_MODEL_STATUS },
        extensionSender(),
      ),
    ).resolves.toEqual({
      success: true,
      status: expect.objectContaining({
        initializationStatus: "idle",
        downloadProgress: 0,
        isDownloading: false,
        errorMessage: "",
        errorType: "",
      }),
    });
  });
});
