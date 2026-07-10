import { beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_MESSAGE_TYPES } from "@/common/message-types";

const semanticMocks = vi.hoisted(() => ({ hasAnyModelCache: vi.fn() }));
const offscreenMocks = vi.hoisted(() => ({ ensureOffscreenDocument: vi.fn() }));
const indexerMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  reinitialize: vi.fn(),
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

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    storageGet = vi.fn().mockResolvedValue({
      modelState: {
        status: "ready",
        downloadProgress: 100,
        isDownloading: false,
        lastUpdated: 1,
      },
    });
    storageSet = vi.fn().mockResolvedValue(undefined);
    runtimeSendMessage = vi.fn();
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
  });

  it("only accepts model status updates from the exact offscreen document", async () => {
    const message = {
      type: BACKGROUND_MESSAGE_TYPES.UPDATE_MODEL_STATUS,
      modelState: { status: "ready" },
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
        status: "ready",
        downloadProgress: 0,
        isDownloading: false,
        errorMessage: "",
        errorType: "",
      }),
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
    storageGet.mockResolvedValue({
      selectedModel: "attacker/model",
      selectedVersion: "latest",
    });
    runtimeSendMessage.mockResolvedValue({ success: true });

    const { initializeDefaultSemanticEngine } =
      await import("@/entrypoints/background/semantic-similarity");
    await initializeDefaultSemanticEngine();

    expect(runtimeSendMessage).toHaveBeenCalledWith({
      target: "offscreen",
      type: expect.any(String),
      config: {
        modelPreset: "multilingual-e5-small",
        modelVersion: "quantized",
        modelDimension: 384,
      },
    });
  });

  it("queues a switch until startup default initialization fully settles", async () => {
    let resolveDefaultOffscreen!: (value: { success: boolean }) => void;
    const blockedDefaultOffscreen = new Promise<{ success: boolean }>(
      (resolve) => {
        resolveDefaultOffscreen = resolve;
      },
    );
    let releaseDefaultIndexer!: () => void;
    const blockedDefaultIndexer = new Promise<void>((resolve) => {
      releaseDefaultIndexer = resolve;
    });
    let releaseDefaultReady!: () => void;
    const blockedDefaultReady = new Promise<void>((resolve) => {
      releaseDefaultReady = resolve;
    });
    let shouldBlockDefaultReady = true;
    const persistedStorage: Record<string, unknown> = {};

    runtimeSendMessage
      .mockImplementationOnce(() => blockedDefaultOffscreen)
      .mockResolvedValueOnce({ success: true });
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
      config: {
        modelPreset: "multilingual-e5-small",
        modelVersion: "quantized",
        modelDimension: 384,
      },
    });
    expect(indexerMocks.reinitialize).not.toHaveBeenCalled();

    resolveDefaultOffscreen({ success: true });
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
    expect(runtimeSendMessage).toHaveBeenCalledTimes(2);
    expect(indexerMocks.reinitialize).toHaveBeenCalledTimes(1);
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
    runtimeSendMessage.mockResolvedValue({ success: true });
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
    storageSet
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("default ready persistence failed"));
    runtimeSendMessage.mockResolvedValue({ success: true });

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

  it.each([
    ["omitted", undefined],
    ["forged target dimension", 768],
    ["forged invalid value", "forged"],
  ] as const)(
    "rebuilds and persists a valid switch when previousDimension is %s",
    async (_label, previousDimension) => {
      runtimeSendMessage.mockResolvedValue({ success: true });
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
    runtimeSendMessage.mockResolvedValue({ success: true });
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

  it("fails closed when the initial status cannot be persisted", async () => {
    storageSet.mockRejectedValueOnce(new Error("status persistence failed"));
    runtimeSendMessage.mockResolvedValue({ success: true });
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
    storageSet
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("selection persistence failed"));
    runtimeSendMessage.mockResolvedValue({ success: true });
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
    storageSet
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("ready status persistence failed"));
    runtimeSendMessage.mockResolvedValue({ success: true });
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

  it("serializes concurrent targets and continues only after a failed transaction settles", async () => {
    let rejectFirstReinitialize!: (reason?: unknown) => void;
    const firstReinitialize = new Promise<void>((_resolve, reject) => {
      rejectFirstReinitialize = reject;
    });
    let releaseErrorStatus!: () => void;
    const blockedErrorStatus = new Promise<void>((resolve) => {
      releaseErrorStatus = resolve;
    });
    const persistedStorage: Record<string, unknown> = {};

    storageSet.mockImplementation(async (value) => {
      if (value.modelState?.status === "error") {
        await blockedErrorStatus;
      }
      Object.assign(persistedStorage, value);
    });
    runtimeSendMessage.mockResolvedValue({ success: true });
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
      config: {
        modelPreset: "multilingual-e5-base",
        modelVersion: "compressed",
        modelDimension: 768,
      },
    });
    expect(runtimeSendMessage).toHaveBeenNthCalledWith(2, {
      target: "offscreen",
      type: expect.any(String),
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

    // A third request for the final target must observe the committed in-memory
    // config and avoid starting another offscreen/index transaction.
    await expect(
      handleModelSwitch("multilingual-e5-small", "quantized", 384),
    ).resolves.toEqual({ success: true });
    expect(runtimeSendMessage).toHaveBeenCalledTimes(2);
    expect(indexerMocks.reinitialize).toHaveBeenCalledTimes(2);
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
