import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_MESSAGE_TYPES } from "@/common/message-types";
import { CLEAR_DATA_RESPONSE_TIMEOUT_MS } from "@/entrypoints/background/storage-manager";

const indexerMocks = vi.hoisted(() => ({
  clearAllIndexes: vi.fn(),
  getStats: vi.fn(),
  runExclusiveDataCleanup: vi.fn(),
}));

vi.mock("@/utils/content-indexer", () => ({
  getGlobalContentIndexer: () => ({
    clearAllIndexes: indexerMocks.clearAllIndexes,
    getStats: indexerMocks.getStats,
    runExclusiveDataCleanup: indexerMocks.runExclusiveDataCleanup,
  }),
}));

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

describe("storage manager authorization", () => {
  let listener: RuntimeListener;
  let storageRemove: ReturnType<typeof vi.fn>;
  let storageGet: ReturnType<typeof vi.fn>;
  let activeCleanup: Promise<void> | null;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    indexerMocks.clearAllIndexes.mockResolvedValue(undefined);
    indexerMocks.getStats.mockReturnValue({
      available: true,
      indexedPages: 3,
      totalDocuments: 4,
    });
    activeCleanup = null;
    indexerMocks.runExclusiveDataCleanup.mockImplementation(
      (
        operation: (activity: {
          clearAllIndexes: typeof indexerMocks.clearAllIndexes;
        }) => Promise<void>,
      ) => {
        if (activeCleanup) return activeCleanup;
        const cleanup = operation({
          clearAllIndexes: indexerMocks.clearAllIndexes,
        });
        const tracked = cleanup.finally(() => {
          if (activeCleanup === tracked) activeCleanup = null;
        });
        activeCleanup = tracked;
        return tracked;
      },
    );
    storageRemove = vi.fn().mockResolvedValue(undefined);
    storageGet = vi.fn().mockResolvedValue({});

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
      },
      storage: { local: { get: storageGet, remove: storageRemove } },
    });

    const { initStorageManagerListener } =
      await import("@/entrypoints/background/storage-manager");
    initStorageManagerListener();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  function contentSender(): chrome.runtime.MessageSender {
    return {
      id: "test-extension-id",
      tab: { id: 7 } as chrome.tabs.Tab,
      url: "https://example.com/",
      origin: "https://example.com",
    };
  }

  it.each([
    BACKGROUND_MESSAGE_TYPES.GET_STORAGE_STATS,
    BACKGROUND_MESSAGE_TYPES.CLEAR_ALL_DATA,
  ])("rejects content-script requests for %s", async (type) => {
    await expect(dispatch({ type }, contentSender())).resolves.toEqual({
      success: false,
      error: "Storage management requires an extension page",
    });
    expect(indexerMocks.getStats).not.toHaveBeenCalled();
    expect(indexerMocks.clearAllIndexes).not.toHaveBeenCalled();
    expect(indexerMocks.runExclusiveDataCleanup).not.toHaveBeenCalled();
    expect(storageRemove).not.toHaveBeenCalled();
  });

  it("allows an extension page to read storage statistics", async () => {
    await expect(
      dispatch(
        { type: BACKGROUND_MESSAGE_TYPES.GET_STORAGE_STATS },
        extensionSender(),
      ),
    ).resolves.toMatchObject({
      success: true,
      stats: { indexedPages: 3, totalDocuments: 4 },
    });
    expect(indexerMocks.getStats).toHaveBeenCalledOnce();
  });

  it("does not report unloaded persistent statistics as zero after a worker restart", async () => {
    indexerMocks.getStats.mockReturnValueOnce({
      available: false,
      indexedPages: 0,
      totalDocuments: 0,
      totalTabs: 0,
      indexSize: 0,
      isInitialized: false,
    });

    await expect(
      dispatch(
        { type: BACKGROUND_MESSAGE_TYPES.GET_STORAGE_STATS },
        extensionSender(),
      ),
    ).resolves.toMatchObject({
      success: true,
      stats: {
        available: false,
        indexedPages: null,
        totalDocuments: null,
        totalTabs: null,
        indexSize: null,
      },
    });
  });

  it("allows an extension page to clear managed storage", async () => {
    await expect(
      dispatch(
        { type: BACKGROUND_MESSAGE_TYPES.CLEAR_ALL_DATA },
        extensionSender(),
      ),
    ).resolves.toEqual({ success: true });
    expect(indexerMocks.clearAllIndexes).toHaveBeenCalledOnce();
    expect(indexerMocks.runExclusiveDataCleanup).toHaveBeenCalledOnce();
    expect(storageRemove).toHaveBeenCalledOnce();
    expect(storageGet).toHaveBeenCalledOnce();
  });

  it.each([
    {
      step: "semantic index data",
      fail: () =>
        indexerMocks.clearAllIndexes.mockRejectedValueOnce(
          new Error("index failure"),
        ),
    },
    {
      step: "storage metadata",
      fail: () =>
        storageRemove.mockRejectedValueOnce(new Error("storage failure")),
    },
  ])(
    "runs every cleanup phase and reports a $step failure",
    async ({ step, fail }) => {
      fail();

      const response = await dispatch(
        { type: BACKGROUND_MESSAGE_TYPES.CLEAR_ALL_DATA },
        extensionSender(),
      );

      expect(response).toMatchObject({ success: false });
      expect(response.error).toContain(step);
      expect(indexerMocks.clearAllIndexes).toHaveBeenCalledOnce();
      expect(storageRemove).toHaveBeenCalledOnce();
    },
  );

  it("fails when managed storage metadata remains after removal", async () => {
    storageGet.mockResolvedValueOnce({ vectorDatabaseStats: { documents: 1 } });

    await expect(
      dispatch(
        { type: BACKGROUND_MESSAGE_TYPES.CLEAR_ALL_DATA },
        extensionSender(),
      ),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("managed keys still exist"),
    });
  });

  it("bounds only the response while late cleanup and retries stay coalesced", async () => {
    vi.useFakeTimers();
    let finishIndexCleanup!: () => void;
    indexerMocks.clearAllIndexes.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishIndexCleanup = resolve;
      }),
    );

    const firstResponse = dispatch(
      { type: BACKGROUND_MESSAGE_TYPES.CLEAR_ALL_DATA },
      extensionSender(),
    );
    await vi.advanceTimersByTimeAsync(CLEAR_DATA_RESPONSE_TIMEOUT_MS);

    await expect(firstResponse).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("still in progress"),
    });
    expect(storageRemove).not.toHaveBeenCalled();

    const retryResponse = dispatch(
      { type: BACKGROUND_MESSAGE_TYPES.CLEAR_ALL_DATA },
      extensionSender(),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(indexerMocks.runExclusiveDataCleanup).toHaveBeenCalledTimes(2);
    expect(indexerMocks.clearAllIndexes).toHaveBeenCalledOnce();

    finishIndexCleanup();
    await vi.runAllTicks();
    await expect(retryResponse).resolves.toEqual({ success: true });
    expect(storageRemove).toHaveBeenCalledOnce();
  });

  it("ignores unrelated and malformed messages", async () => {
    await expect(dispatch(null, contentSender())).resolves.toBeUndefined();
    await expect(
      dispatch({ type: "unrelated" }, contentSender()),
    ).resolves.toBeUndefined();
  });
});
