import { BACKGROUND_MESSAGE_TYPES } from "@/common/message-types";
import { isExtensionPageSender } from "@/common/runtime-sender-auth";

const MANAGED_STORAGE_KEYS = [
  "vectorDatabaseStats",
  "lastCleanupTime",
  "contentIndexerStats",
];
export const CLEAR_DATA_RESPONSE_TIMEOUT_MS = 10_000;

function cleanupErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Get storage statistics
 */
export async function handleGetStorageStats(): Promise<{
  success: boolean;
  stats?: any;
  error?: string;
}> {
  try {
    // Get ContentIndexer statistics
    const { getGlobalContentIndexer } = await import("@/utils/content-indexer");
    const contentIndexer = getGlobalContentIndexer();

    // Note: Semantic engine initialization is now user-controlled
    // ContentIndexer will be initialized when user manually triggers semantic engine initialization

    // Get statistics
    const stats = await contentIndexer.getVerifiedStats();
    const available = stats.available === true;
    const count = (value: unknown): number | null =>
      available && typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : null;

    return {
      success: true,
      stats: {
        available,
        indexedPages: count(stats.indexedPages),
        totalDocuments: count(stats.totalDocuments),
        totalTabs: count(stats.totalTabs),
        indexSize: count(stats.indexSize),
        isInitialized: stats.isInitialized === true,
        semanticEngineReady: stats.semanticEngineReady === true,
        semanticEngineInitializing: stats.semanticEngineInitializing === true,
      },
    };
  } catch (error: any) {
    console.error("Background: Failed to get storage stats:", error);
    return {
      success: false,
      error: error.message,
      stats: {
        available: false,
        indexedPages: null,
        totalDocuments: null,
        totalTabs: null,
        indexSize: null,
        isInitialized: false,
        semanticEngineReady: false,
        semanticEngineInitializing: false,
      },
    };
  }
}

/**
 * Clear all data
 */
export async function handleClearAllData(): Promise<{
  success: boolean;
  error?: string;
}> {
  const { getGlobalContentIndexer } = await import("@/utils/content-indexer");
  const contentIndexer = getGlobalContentIndexer();
  const cleanup = contentIndexer.runExclusiveDataCleanup(async (activity) => {
    const failures: string[] = [];
    const runCleanupStep = async (
      step: string,
      operation: () => Promise<void>,
    ) => {
      try {
        await operation();
      } catch (error) {
        failures.push(`${step}: ${cleanupErrorMessage(error)}`);
        console.warn(`Background: ${step} failed:`, error);
      }
    };

    // ContentIndexer performs the persistent vector/IDBFS clear even when the
    // service worker has no initialized in-memory index.
    await runCleanupStep("semantic index data", () =>
      activity.clearAllIndexes(),
    );
    await runCleanupStep("storage metadata", async () => {
      await chrome.storage.local.remove(MANAGED_STORAGE_KEYS);
      if (typeof chrome.storage.local.get !== "function") return;

      const remaining = await chrome.storage.local.get(MANAGED_STORAGE_KEYS);
      const remainingKeys = MANAGED_STORAGE_KEYS.filter((key) =>
        Object.prototype.hasOwnProperty.call(remaining, key),
      );
      if (remainingKeys.length > 0) {
        throw new Error(
          `managed keys still exist: ${remainingKeys.join(", ")}`,
        );
      }
    });

    if (failures.length > 0) {
      throw new Error(`Data cleanup incomplete (${failures.join("; ")})`);
    }
  });

  // This timeout only bounds the extension-page response. The cleanup promise
  // remains alive and keeps the exclusive gate held until the real operation
  // settles; concurrent calls and retries coalesce onto that same promise.
  return new Promise((resolve) => {
    let responded = false;
    const respond = (result: { success: boolean; error?: string }) => {
      if (responded) return;
      responded = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(
      () =>
        respond({
          success: false,
          error: `Data cleanup is still in progress after ${CLEAR_DATA_RESPONSE_TIMEOUT_MS} ms`,
        }),
      CLEAR_DATA_RESPONSE_TIMEOUT_MS,
    );

    cleanup.then(
      () => respond({ success: true }),
      (error) =>
        respond({
          success: false,
          error: cleanupErrorMessage(error),
        }),
    );
  });
}

/**
 * Initialize storage manager module message listeners
 */
export const initStorageManagerListener = () => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const messageType = message?.type;
    const isStorageRequest =
      messageType === BACKGROUND_MESSAGE_TYPES.GET_STORAGE_STATS ||
      messageType === BACKGROUND_MESSAGE_TYPES.CLEAR_ALL_DATA;

    if (!isStorageRequest) return;

    if (!isExtensionPageSender(sender)) {
      sendResponse({
        success: false,
        error: "Storage management requires an extension page",
      });
      return false;
    }

    if (messageType === BACKGROUND_MESSAGE_TYPES.GET_STORAGE_STATS) {
      handleGetStorageStats()
        .then((result: { success: boolean; stats?: any; error?: string }) =>
          sendResponse(result),
        )
        .catch((error: any) =>
          sendResponse({ success: false, error: error.message }),
        );
      return true;
    } else {
      handleClearAllData()
        .then((result: { success: boolean; error?: string }) =>
          sendResponse(result),
        )
        .catch((error: any) =>
          sendResponse({ success: false, error: error.message }),
        );
      return true;
    }
  });
};
