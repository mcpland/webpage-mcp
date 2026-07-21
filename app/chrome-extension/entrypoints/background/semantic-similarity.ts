import {
  PREDEFINED_MODELS,
  hasAnyModelCache,
  type ModelPreset,
} from "@/utils/semantic-similarity-engine";
import { OffscreenManager } from "@/utils/offscreen-manager";
import {
  BACKGROUND_MESSAGE_TYPES,
  OFFSCREEN_MESSAGE_TYPES,
} from "@/common/message-types";
import { STORAGE_KEYS, ERROR_MESSAGES } from "@/common/constants";
import { isOffscreenDocumentSender } from "@/common/runtime-sender-auth";
import {
  getStoredSemanticModelSelection,
  normalizeSemanticModelState,
  safeSemanticErrorMessage,
  validateSemanticModelSelection,
  type NormalizedSemanticModelState,
  type SemanticModelSelection,
  type SemanticModelVersion,
} from "@/utils/semantic-similarity-boundaries";
import { readSemanticMaintenanceMarker } from "@/utils/semantic-maintenance-marker";

/**
 * Model configuration state management interface
 */
interface ModelConfig {
  modelPreset: ModelPreset;
  modelVersion: SemanticModelVersion;
  modelDimension: number;
}

let currentBackgroundModelConfig: ModelConfig | null = null;
let activeModelAttemptId: string | null = null;
let semanticModelOperationQueue: Promise<void> = Promise.resolve();

function releaseActiveModelAttempt(attemptId: string | null): void {
  if (attemptId && activeModelAttemptId === attemptId) {
    activeModelAttemptId = null;
  }
}

function enqueueSemanticModelOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const result = semanticModelOperationQueue.then(operation);

  // Keep later operations moving even if an unexpected error escapes an
  // operation body. Callers still receive the original result/rejection.
  semanticModelOperationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function sameModelSelection(
  left: SemanticModelSelection<ModelPreset>,
  right: SemanticModelSelection<ModelPreset>,
): boolean {
  return (
    left.modelPreset === right.modelPreset &&
    left.modelVersion === right.modelVersion &&
    left.modelDimension === right.modelDimension
  );
}

function validateOffscreenReadyResponse(
  response: unknown,
  selection: SemanticModelSelection<ModelPreset>,
): void {
  const responseRecord =
    typeof response === "object" &&
    response !== null &&
    !Array.isArray(response)
      ? (response as Record<string, unknown>)
      : null;
  if (responseRecord?.success !== true) {
    throw new Error(
      safeSemanticErrorMessage(
        responseRecord?.error,
        ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
      ),
    );
  }
  if (responseRecord.isInitialized !== true) {
    throw new Error("Offscreen semantic engine did not confirm initialization");
  }

  let responseSelection: SemanticModelSelection<ModelPreset>;
  try {
    responseSelection = validateSemanticModelSelection(
      responseRecord.currentConfig,
      PREDEFINED_MODELS,
    );
  } catch (error) {
    throw new Error(
      "Offscreen semantic engine returned an invalid model config",
      {
        cause: error,
      },
    );
  }
  if (!sameModelSelection(responseSelection, selection)) {
    throw new Error(
      "Offscreen semantic engine returned a different model config",
    );
  }
}

function getStrictStoredModelSelection(
  storedPreset: unknown,
  storedVersion: unknown,
): SemanticModelSelection<ModelPreset> {
  if (storedPreset === undefined && storedVersion === undefined) {
    return validateSemanticModelSelection(
      {
        modelPreset: "multilingual-e5-small",
        modelVersion: "quantized",
        modelDimension: 384,
      },
      PREDEFINED_MODELS,
    );
  }
  const modelInfo =
    typeof storedPreset === "string"
      ? PREDEFINED_MODELS[storedPreset as ModelPreset]
      : undefined;
  return validateSemanticModelSelection(
    {
      modelPreset: storedPreset,
      modelVersion: storedVersion,
      modelDimension: modelInfo?.dimension,
    },
    PREDEFINED_MODELS,
  );
}

async function initializeOffscreenModel(
  selection: SemanticModelSelection<ModelPreset>,
  attemptId: string,
): Promise<void> {
  try {
    await OffscreenManager.getInstance().ensureOffscreenDocument();
  } catch (offscreenError: unknown) {
    const errorMessage = safeSemanticErrorMessage(
      offscreenError,
      "Failed to create offscreen document",
    );
    throw new Error(errorMessage, { cause: offscreenError });
  }

  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_INIT,
    attemptId,
    config: selection,
  });
  validateOffscreenReadyResponse(response, selection);
}

/**
 * Initialize semantic engine only if model cache exists
 * This is called during plugin startup to avoid downloading models unnecessarily
 */
export async function initializeSemanticEngineIfCached(): Promise<boolean> {
  try {
    console.log(
      "Background: Checking if semantic engine should be initialized from cache...",
    );

    const hasCachedModel = await hasAnyModelCache();
    if (!hasCachedModel) {
      console.log(
        "Background: No cached models found, skipping semantic engine initialization",
      );
      return false;
    }

    console.log(
      "Background: Found cached models, initializing semantic engine...",
    );
    await initializeDefaultSemanticEngine();
    return true;
  } catch (error) {
    console.error(
      "Background: Error during conditional semantic engine initialization:",
      error,
    );
    return false;
  }
}

/**
 * Initialize default semantic engine model
 */
async function performDefaultSemanticEngineInitialization(): Promise<void> {
  currentBackgroundModelConfig = null;
  let ownedAttemptId: string | null = null;
  let committedSelection: ModelConfig | null = null;
  try {
    console.log("Background: Initializing default semantic engine...");

    const { getGlobalContentIndexer } = await import("@/utils/content-indexer");
    const contentIndexer = getGlobalContentIndexer();
    await contentIndexer.runExclusiveModelTransition(async (transition) => {
      ownedAttemptId = transition.attemptId;
      activeModelAttemptId = transition.attemptId;
      await persistModelStatus("initializing", 0);

      const result = await getSemanticStorage().get([
        STORAGE_KEYS.SEMANTIC_MODEL,
        "selectedVersion",
      ]);
      const selection = getStoredSemanticModelSelection(
        result[STORAGE_KEYS.SEMANTIC_MODEL],
        result.selectedVersion,
        PREDEFINED_MODELS,
        "multilingual-e5-small",
      );

      await initializeOffscreenModel(selection, transition.attemptId);
      await persistModelSelection(selection);
      if (transition.recoveryRequired) {
        await transition.reinitializeForModel(selection);
      } else {
        await transition.initializeForModel(selection);
      }
      committedSelection = selection;
    });

    if (!committedSelection) {
      throw new Error("Semantic model transition completed without a target");
    }
    await persistModelStatus("ready", 100);
    currentBackgroundModelConfig = committedSelection;
    console.log(
      "Semantic engine initialized successfully:",
      currentBackgroundModelConfig,
    );
  } catch (error: unknown) {
    releaseActiveModelAttempt(ownedAttemptId);
    console.error(
      "Background: Failed to initialize default semantic engine:",
      error,
    );
    const errorMessage = safeSemanticErrorMessage(
      error,
      "Unknown error during semantic engine initialization",
    );
    await persistFinalModelError(errorMessage, analyzeErrorType(errorMessage));
    throw new Error(errorMessage, { cause: error });
  } finally {
    releaseActiveModelAttempt(ownedAttemptId);
  }
}

export function initializeDefaultSemanticEngine(): Promise<void> {
  return enqueueSemanticModelOperation(
    performDefaultSemanticEngineInitialization,
  );
}

/**
 * Handle model switching
 */
async function performModelSwitch(
  modelPreset: unknown,
  modelVersion: unknown,
  modelDimension?: unknown,
  previousDimension?: unknown,
): Promise<{ success: boolean; error?: string }> {
  // `previousDimension` is supplied by the caller and is therefore not an
  // authoritative signal for deciding whether the background index must be
  // rebuilt. Keep accepting it for message compatibility, but never trust it.
  void previousDimension;

  currentBackgroundModelConfig = null;
  let ownedAttemptId: string | null = null;
  try {
    const selection = validateSemanticModelSelection(
      { modelPreset, modelVersion, modelDimension },
      PREDEFINED_MODELS,
    );

    const { getGlobalContentIndexer } = await import("@/utils/content-indexer");
    const contentIndexer = getGlobalContentIndexer();
    await contentIndexer.runExclusiveModelTransition(async (transition) => {
      ownedAttemptId = transition.attemptId;
      activeModelAttemptId = transition.attemptId;
      await persistModelStatus("downloading", 0);

      await initializeOffscreenModel(selection, transition.attemptId);
      await persistModelSelection(selection);
      await transition.reinitializeForModel(selection);
    });

    await persistModelStatus("ready", 100);
    currentBackgroundModelConfig = selection;
    return { success: true };
  } catch (error: unknown) {
    releaseActiveModelAttempt(ownedAttemptId);
    console.error("Model switch failed:", error);
    const errorMessage = safeSemanticErrorMessage(error);
    const errorType = analyzeErrorType(errorMessage);
    await persistFinalModelError(errorMessage, errorType);
    return { success: false, error: errorMessage };
  } finally {
    releaseActiveModelAttempt(ownedAttemptId);
  }
}

export function handleModelSwitch(
  modelPreset: unknown,
  modelVersion: unknown,
  modelDimension?: unknown,
  previousDimension?: unknown,
): Promise<{ success: boolean; error?: string }> {
  return enqueueSemanticModelOperation(() =>
    performModelSwitch(
      modelPreset,
      modelVersion,
      modelDimension,
      previousDimension,
    ),
  );
}

/**
 * Get model status
 */
export async function handleGetModelStatus(): Promise<{
  success: boolean;
  status?: any;
  error?: string;
}> {
  try {
    if (
      typeof chrome === "undefined" ||
      !chrome.storage ||
      !chrome.storage.local
    ) {
      console.error(
        "Background: chrome.storage.local is not available for status query",
      );
      return {
        success: true,
        status: {
          initializationStatus: "idle",
          downloadProgress: 0,
          isDownloading: false,
          lastUpdated: Date.now(),
        },
      };
    }

    const result = await chrome.storage.local.get(["modelState"]);
    const modelState = normalizeSemanticModelState(
      result.modelState || {
        status: "idle",
        downloadProgress: 0,
        isDownloading: false,
        lastUpdated: Date.now(),
      },
    );

    let recoveryRequired = false;
    let ownedActiveAttempt = false;
    try {
      const gate = await readSemanticMaintenanceMarker();
      recoveryRequired = gate.state === "required";
      ownedActiveAttempt =
        gate.state === "required" &&
        activeModelAttemptId !== null &&
        gate.marker.attemptId === activeModelAttemptId;
    } catch {
      // Malformed or unreadable durable state can never be treated as ready.
      recoveryRequired = true;
    }

    if (recoveryRequired) {
      if (ownedActiveAttempt) {
        const activeStatus =
          modelState.status === "downloading" ? "downloading" : "initializing";
        return {
          success: true,
          status: {
            initializationStatus: activeStatus,
            downloadProgress: Math.min(99, modelState.downloadProgress),
            isDownloading: true,
            lastUpdated: modelState.lastUpdated,
            errorMessage: "",
            errorType: "",
          },
        };
      }
      return {
        success: true,
        status: {
          initializationStatus: "error",
          downloadProgress: 0,
          isDownloading: false,
          lastUpdated: Date.now(),
          errorMessage:
            "Semantic model recovery is required before the index can be used",
          errorType: "unknown",
        },
      };
    }

    if (modelState.status === "ready") {
      try {
        const storedSelection = await chrome.storage.local.get([
          STORAGE_KEYS.SEMANTIC_MODEL,
          "selectedVersion",
        ]);
        const selection = getStrictStoredModelSelection(
          storedSelection[STORAGE_KEYS.SEMANTIC_MODEL],
          storedSelection.selectedVersion,
        );
        // A status query must never create or initialize an offscreen document.
        // Messaging the existing document fails closed when Chrome reclaimed it.
        const offscreenStatus = await chrome.runtime.sendMessage({
          target: "offscreen",
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_STATUS,
        });
        validateOffscreenReadyResponse(offscreenStatus, selection);
        const verifiedGate = await readSemanticMaintenanceMarker();
        if (verifiedGate.state !== "clear") {
          throw new Error(
            "Semantic maintenance started during model status verification",
          );
        }
      } catch {
        return {
          success: true,
          status: {
            initializationStatus: "error",
            downloadProgress: 0,
            isDownloading: false,
            lastUpdated: Date.now(),
            errorMessage:
              "Semantic engine is unavailable or inconsistent; recovery is required",
            errorType: "unknown",
          },
        };
      }
    }

    return {
      success: true,
      status: {
        initializationStatus: modelState.status,
        downloadProgress: modelState.downloadProgress,
        isDownloading: modelState.isDownloading,
        lastUpdated: modelState.lastUpdated,
        errorMessage: modelState.errorMessage,
        errorType: modelState.errorType,
      },
    };
  } catch (error: unknown) {
    console.error("Failed to get model status:", error);
    return { success: false, error: safeSemanticErrorMessage(error) };
  }
}

/**
 * Update model status
 */
function getSemanticStorage(): chrome.storage.StorageArea {
  if (
    typeof chrome === "undefined" ||
    !chrome.storage ||
    !chrome.storage.local
  ) {
    throw new Error(
      "chrome.storage.local is not available for semantic model persistence",
    );
  }
  return chrome.storage.local;
}

function sameNormalizedModelState(
  value: unknown,
  expected: NormalizedSemanticModelState,
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = value as Record<string, unknown>;
  const expectedKeys = [
    "status",
    "downloadProgress",
    "isDownloading",
    "lastUpdated",
    "errorMessage",
    "errorType",
  ].sort();
  const actualKeys = Object.keys(actual).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    actual.status === expected.status &&
    actual.downloadProgress === expected.downloadProgress &&
    actual.isDownloading === expected.isDownloading &&
    actual.lastUpdated === expected.lastUpdated &&
    actual.errorMessage === expected.errorMessage &&
    actual.errorType === expected.errorType
  );
}

async function persistModelStatus(
  status: unknown,
  progress: unknown,
  errorMessage?: unknown,
  errorType?: unknown,
): Promise<void> {
  const modelState = normalizeSemanticModelState({
    status,
    downloadProgress: progress,
    lastUpdated: Date.now(),
    errorMessage,
    errorType,
  });
  const storage = getSemanticStorage();
  await storage.set({ modelState });
  const stored = await storage.get(["modelState"]);
  if (!sameNormalizedModelState(stored.modelState, modelState)) {
    throw new Error("Semantic model status readback mismatched");
  }
}

async function persistModelSelection(selection: ModelConfig): Promise<void> {
  const storage = getSemanticStorage();
  await storage.set({
    [STORAGE_KEYS.SEMANTIC_MODEL]: selection.modelPreset,
    selectedVersion: selection.modelVersion,
  });
  const stored = await storage.get([
    STORAGE_KEYS.SEMANTIC_MODEL,
    "selectedVersion",
  ]);
  if (
    stored[STORAGE_KEYS.SEMANTIC_MODEL] !== selection.modelPreset ||
    stored.selectedVersion !== selection.modelVersion
  ) {
    throw new Error("Semantic model selection readback mismatched");
  }
}

async function persistFinalModelError(
  errorMessage: string,
  errorType: "network" | "file" | "unknown",
): Promise<void> {
  try {
    await persistModelStatus("error", 0, errorMessage, errorType);
  } catch (statusError) {
    console.error(
      "Failed to persist final semantic model error status:",
      statusError,
    );
  }
}

/**
 * Handle model status updates from offscreen document
 */
export async function handleUpdateModelStatus(
  attemptId: unknown,
  modelState: unknown,
): Promise<{ success: boolean; error?: string }> {
  try {
    if (
      typeof attemptId !== "string" ||
      attemptId.length === 0 ||
      attemptId.length > 128 ||
      attemptId !== activeModelAttemptId
    ) {
      throw new Error("Semantic model progress attempt is no longer active");
    }

    if (typeof modelState !== "object" || modelState === null) {
      throw new Error("Semantic model progress payload is invalid");
    }
    const input = modelState as Record<string, unknown>;
    if (
      (input.status !== "initializing" && input.status !== "downloading") ||
      typeof input.downloadProgress !== "number" ||
      !Number.isFinite(input.downloadProgress) ||
      input.downloadProgress < 0 ||
      input.downloadProgress > 99
    ) {
      throw new Error("Only non-terminal semantic model progress is accepted");
    }

    const gate = await readSemanticMaintenanceMarker();
    if (gate.state !== "required" || gate.marker.attemptId !== attemptId) {
      throw new Error("Semantic model progress attempt lost durable ownership");
    }

    await persistModelStatus(input.status, input.downloadProgress);
    return { success: true };
  } catch (error: unknown) {
    console.error("Background: Failed to update model status:", error);
    return { success: false, error: safeSemanticErrorMessage(error) };
  }
}

/**
 * Analyze error type based on error message
 */
function analyzeErrorType(
  errorMessage: string,
): "network" | "file" | "unknown" {
  const message = errorMessage.toLowerCase();

  if (
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("timeout") ||
    message.includes("connection") ||
    message.includes("cors") ||
    message.includes("failed to fetch")
  ) {
    return "network";
  }

  if (
    message.includes("corrupt") ||
    message.includes("invalid") ||
    message.includes("format") ||
    message.includes("parse") ||
    message.includes("decode") ||
    message.includes("onnx")
  ) {
    return "file";
  }

  return "unknown";
}

/**
 * Initialize semantic similarity module message listeners
 */
export const initSemanticSimilarityListener = () => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const messageType = message?.type;
    if (messageType !== BACKGROUND_MESSAGE_TYPES.UPDATE_MODEL_STATUS) return;

    if (!isOffscreenDocumentSender(sender)) {
      sendResponse({
        success: false,
        error: "Unauthorized semantic engine control request",
      });
      return false;
    }

    handleUpdateModelStatus(message.attemptId, message.modelState)
      .then((result: { success: boolean; error?: string }) =>
        sendResponse(result),
      )
      .catch((error: unknown) =>
        sendResponse({
          success: false,
          error: safeSemanticErrorMessage(error),
        }),
      );
    return true;
  });
};
