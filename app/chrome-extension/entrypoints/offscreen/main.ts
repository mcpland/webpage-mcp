import {
  PREDEFINED_MODELS,
  SemanticSimilarityEngine,
  type ModelPreset,
} from "@/utils/semantic-similarity-engine";
import {
  MessageTarget,
  SendMessageType,
  OFFSCREEN_MESSAGE_TYPES,
  BACKGROUND_MESSAGE_TYPES,
  type SemanticEngineInitMessage,
  type SemanticModelProgressMessage,
} from "@/common/message-types";
import { handleGifMessage } from "./gif-encoder";
import { initKeepalive } from "./rr-keepalive";
import {
  isExtensionBackgroundSender,
  isExtensionRuntimeSender,
} from "@/common/runtime-sender-auth";
import {
  SEMANTIC_RESOURCE_LIMITS,
  normalizeSemanticModelState,
  safeSemanticErrorMessage,
  validateEmbeddingPayload,
  validateEmbeddingsPayload,
  validateSemanticModelSelection,
  validateSemanticOptions,
  validateSemanticPairs,
  validateSemanticText,
  validateSemanticTexts,
  validateSimilaritiesPayload,
  type SemanticModelSelection,
} from "@/utils/semantic-similarity-boundaries";

// Initialize RR V3 Keepalive
initKeepalive();

// Global semantic similarity engine instance
let similarityEngine: SemanticSimilarityEngine | null = null;
interface OffscreenMessage {
  target: MessageTarget | string;
  type: SendMessageType | string;
}

interface SimilarityEngineComputeBatchMessage extends OffscreenMessage {
  type: SendMessageType.SimilarityEngineComputeBatch;
  pairs: unknown;
  options?: unknown;
}

interface SimilarityEngineGetEmbeddingMessage extends OffscreenMessage {
  type: "similarityEngineCompute";
  text: unknown;
  options?: unknown;
}

interface SimilarityEngineGetEmbeddingsBatchMessage extends OffscreenMessage {
  type: "similarityEngineBatchCompute";
  texts: unknown;
  options?: unknown;
}

type MessageResponse = {
  result?: string;
  error?: string;
  success?: boolean;
  similarities?: number[];
  embedding?: number[];
  embeddings?: number[][];
  isInitialized?: boolean;
  currentConfig?: SemanticModelSelection<ModelPreset> | null;
};

let activeSemanticRequests = 0;
let semanticInitializationInFlight = false;

async function withSemanticRequestSlot<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (semanticInitializationInFlight) {
    throw new Error("Semantic engine initialization is in progress");
  }
  if (
    activeSemanticRequests >= SEMANTIC_RESOURCE_LIMITS.maxConcurrentRequests
  ) {
    throw new Error("Too many concurrent semantic engine requests");
  }
  activeSemanticRequests++;
  try {
    return await operation();
  } finally {
    activeSemanticRequests--;
  }
}

// Listen for messages from the extension
chrome.runtime.onMessage.addListener(
  (
    message: OffscreenMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: MessageResponse) => void,
  ) => {
    if (message?.target !== MessageTarget.Offscreen) {
      return;
    }

    if (!isExtensionRuntimeSender(sender)) {
      sendResponse({
        success: false,
        error: "Offscreen controls require an extension context",
      });
      return false;
    }

    // Handle GIF encoding messages first
    if (handleGifMessage(message, sendResponse)) {
      return true;
    }

    try {
      switch (message.type) {
        case SendMessageType.SimilarityEngineInit:
        case OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_INIT: {
          if (!isExtensionBackgroundSender(sender)) {
            sendResponse({
              success: false,
              error:
                "Semantic engine initialization requires the background worker",
            });
            return false;
          }
          const initMsg = message as SemanticEngineInitMessage;
          console.log(
            "Offscreen: Received similarity engine init message:",
            message.type,
          );
          handleSimilarityEngineInit(initMsg.config, initMsg.attemptId)
            .then((status) => sendResponse({ success: true, ...status }))
            .catch((error: unknown) =>
              sendResponse({
                success: false,
                error: safeSemanticErrorMessage(error),
              }),
            );
          break;
        }

        case SendMessageType.SimilarityEngineComputeBatch: {
          const computeMsg = message as SimilarityEngineComputeBatchMessage;
          withSemanticRequestSlot(() =>
            handleComputeSimilarityBatch(computeMsg.pairs, computeMsg.options),
          )
            .then((similarities) =>
              sendResponse({ success: true, similarities }),
            )
            .catch((error: unknown) =>
              sendResponse({
                success: false,
                error: safeSemanticErrorMessage(error),
              }),
            );
          break;
        }

        case OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_COMPUTE: {
          const embeddingMsg = message as SimilarityEngineGetEmbeddingMessage;
          withSemanticRequestSlot(() =>
            handleGetEmbedding(embeddingMsg.text, embeddingMsg.options),
          )
            .then((embedding) => {
              const embeddingArray = Array.from(embedding);
              sendResponse({ success: true, embedding: embeddingArray });
            })
            .catch((error: unknown) =>
              sendResponse({
                success: false,
                error: safeSemanticErrorMessage(error),
              }),
            );
          break;
        }

        case OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_BATCH_COMPUTE: {
          const batchMsg = message as SimilarityEngineGetEmbeddingsBatchMessage;
          withSemanticRequestSlot(() =>
            handleGetEmbeddingsBatch(batchMsg.texts, batchMsg.options),
          )
            .then((embeddings) =>
              sendResponse({
                success: true,
                embeddings: embeddings.map((emb) => Array.from(emb)),
              }),
            )
            .catch((error: unknown) =>
              sendResponse({
                success: false,
                error: safeSemanticErrorMessage(error),
              }),
            );
          break;
        }

        case OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_STATUS: {
          handleGetEngineStatus()
            .then((status) => sendResponse({ success: true, ...status }))
            .catch((error: unknown) =>
              sendResponse({
                success: false,
                error: safeSemanticErrorMessage(error),
              }),
            );
          break;
        }

        default:
          sendResponse({
            error: safeSemanticErrorMessage(
              `Unknown message type: ${String(message.type)}`,
            ),
          });
      }
    } catch (error) {
      if (error instanceof Error) {
        sendResponse({ error: safeSemanticErrorMessage(error) });
      } else {
        sendResponse({ error: "Unknown error occurred" });
      }
    }

    // Return true to indicate we'll respond asynchronously
    return true;
  },
);

// Global variable to track current model state
let currentModelConfig: SemanticModelSelection<ModelPreset> | null = null;

/**
 * Check if engine reinitialization is needed
 */
function needsReinitialization(
  newConfig: SemanticModelSelection<ModelPreset>,
): boolean {
  const publishedConfig = currentModelConfig;
  if (!isPublishedEngineReady() || !publishedConfig) {
    return true;
  }

  return (
    newConfig.modelPreset !== publishedConfig.modelPreset ||
    newConfig.modelVersion !== publishedConfig.modelVersion ||
    newConfig.modelDimension !== publishedConfig.modelDimension
  );
}

function isPublishedEngineReady(): boolean {
  return (
    similarityEngine?.isInitialized === true && currentModelConfig !== null
  );
}

/**
 * Progress callback function type
 */
type ProgressCallback = (progress: {
  status: string;
  progress: number;
  message?: string;
}) => void;

function validateSemanticAttemptId(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new Error("Semantic initialization attemptId is invalid");
  }
  return value;
}

/**
 * Initialize semantic similarity engine
 */
async function handleSimilarityEngineInit(
  config: unknown,
  rawAttemptId: unknown,
): Promise<{
  isInitialized: true;
  currentConfig: SemanticModelSelection<ModelPreset>;
}> {
  const selection = validateSemanticModelSelection(config, PREDEFINED_MODELS);
  const attemptId = validateSemanticAttemptId(rawAttemptId);

  if (!needsReinitialization(selection)) {
    return {
      isInitialized: true,
      currentConfig: { ...selection },
    };
  }

  if (semanticInitializationInFlight || activeSemanticRequests > 0) {
    throw new Error("Semantic engine is busy");
  }
  if (!attemptId) {
    throw new Error(
      "Semantic initialization attemptId is required when creating or replacing an engine",
    );
  }

  semanticInitializationInFlight = true;
  try {
    await performSimilarityEngineInit(selection, attemptId);
    return {
      isInitialized: true,
      currentConfig: { ...selection },
    };
  } finally {
    semanticInitializationInFlight = false;
  }
}

async function performSimilarityEngineInit(
  selection: SemanticModelSelection<ModelPreset>,
  attemptId: string,
): Promise<void> {
  console.log("Offscreen: Initializing semantic similarity engine", {
    modelPreset: selection.modelPreset,
    modelVersion: selection.modelVersion,
    modelDimension: selection.modelDimension,
  });

  const previousEngine = similarityEngine;
  similarityEngine = null;
  currentModelConfig = null;

  // Do not retain two model instances. The published globals are revoked before
  // disposal, and a disposal failure prevents construction of the replacement.
  if (previousEngine) {
    console.log("Offscreen: Cleaning up existing engine for model switch...");
    await previousEngine.dispose();
    console.log("Offscreen: Previous engine disposed successfully");
  }

  let candidate: SemanticSimilarityEngine | null = null;
  try {
    await reportModelProgress(attemptId, "initializing", 10);

    let progressDelivery = Promise.resolve();
    let progressDeliveryError: unknown = null;

    const progressCallback: ProgressCallback = (progress) => {
      console.log("Offscreen: Progress update:", progress);
      if (
        progress.status !== "initializing" &&
        progress.status !== "downloading"
      ) {
        return;
      }
      if (
        typeof progress.progress !== "number" ||
        !Number.isFinite(progress.progress)
      ) {
        return;
      }
      const boundedProgress = Math.min(
        99,
        Math.max(0, Math.round(progress.progress)),
      );
      progressDelivery = progressDelivery.then(async () => {
        if (progressDeliveryError) return;
        try {
          await reportModelProgress(
            attemptId,
            progress.status as "initializing" | "downloading",
            boundedProgress,
          );
        } catch (error) {
          progressDeliveryError = error;
        }
      });
    };

    candidate = new SemanticSimilarityEngine({
      modelPreset: selection.modelPreset,
      modelVersion: selection.modelVersion,
      dimension: selection.modelDimension,
      useLocalFiles: false,
      forceOffscreen: false,
    });
    console.log(
      "Offscreen: Starting engine initialization with progress tracking...",
    );

    let initializationError: unknown = null;
    try {
      // Use enhanced initialization method (if progress callback is supported)
      if (typeof (candidate as any).initializeWithProgress === "function") {
        await (candidate as any).initializeWithProgress(progressCallback);
      } else {
        // Fallback to standard initialization method
        console.log(
          "Offscreen: Using standard initialization (no progress callback support)",
        );
        progressCallback({ status: "downloading", progress: 30 });
        await candidate.initialize();
      }
    } catch (error) {
      initializationError = error;
    }
    // A rejected engine initialization may still have queued progress writes.
    // Drain them before responding so background can revoke the attempt and
    // persist its terminal error without a late progress overwrite.
    await progressDelivery;
    if (initializationError && progressDeliveryError) {
      throw new AggregateError(
        [initializationError, progressDeliveryError],
        "Semantic engine initialization and progress reporting both failed",
      );
    }
    if (initializationError) throw initializationError;
    if (progressDeliveryError) throw progressDeliveryError;
    if (candidate.isInitialized !== true) {
      throw new Error(
        "Semantic engine initialization returned without a ready engine",
      );
    }

    // Publish the fully initialized candidate only after every accepted progress
    // update has been acknowledged by the owning background transaction.
    similarityEngine = candidate;
    currentModelConfig = { ...selection };

    console.log(
      "Offscreen: Semantic similarity engine initialized successfully",
    );
  } catch (error) {
    console.error(
      "Offscreen: Failed to initialize semantic similarity engine:",
      error,
    );
    similarityEngine = null;
    currentModelConfig = null;
    if (candidate) {
      try {
        await candidate.dispose();
      } catch (disposeError) {
        throw new AggregateError(
          [error, disposeError],
          "Semantic engine initialization and candidate disposal both failed",
        );
      }
    }
    throw error;
  }
}

async function reportModelProgress(
  attemptId: string,
  status: "initializing" | "downloading",
  progress: number,
): Promise<void> {
  const modelState = normalizeSemanticModelState({
    status,
    downloadProgress: Math.min(99, Math.max(0, Math.round(progress))),
    lastUpdated: Date.now(),
  });
  const message: SemanticModelProgressMessage = {
    type: BACKGROUND_MESSAGE_TYPES.UPDATE_MODEL_STATUS,
    attemptId,
    modelState,
  };
  const response = await chrome.runtime.sendMessage(message);
  if (response?.success !== true) {
    throw new Error(
      safeSemanticErrorMessage(
        response?.error,
        "Background rejected semantic model progress",
      ),
    );
  }
}

/**
 * Batch compute semantic similarity
 */
async function handleComputeSimilarityBatch(
  pairs: unknown,
  options: unknown = {},
): Promise<number[]> {
  const validatedPairs = validateSemanticPairs(pairs);
  const validatedOptions = validateSemanticOptions(
    options === undefined ? {} : options,
  );
  if (!isPublishedEngineReady() || !similarityEngine) {
    throw new Error(
      "Similarity engine not initialized. Please reinitialize the engine.",
    );
  }

  console.log(
    `Offscreen: Computing similarities for ${validatedPairs.length} pairs`,
  );
  const similarities = await similarityEngine.computeSimilarityBatch(
    validatedPairs,
    validatedOptions,
  );
  console.log("Offscreen: Similarity computation completed");

  return validateSimilaritiesPayload(similarities, validatedPairs.length);
}

/**
 * Get embedding vector for single text
 */
async function handleGetEmbedding(
  text: unknown,
  options: unknown = {},
): Promise<Float32Array> {
  const validatedText = validateSemanticText(text);
  const validatedOptions = validateSemanticOptions(
    options === undefined ? {} : options,
  );
  if (!isPublishedEngineReady() || !similarityEngine) {
    throw new Error(
      "Similarity engine not initialized. Please reinitialize the engine.",
    );
  }

  const expectedDimension = currentModelConfig?.modelDimension;
  if (!expectedDimension)
    throw new Error("Semantic model config is unavailable");
  console.log("Offscreen: Getting embedding");
  const embedding = await similarityEngine.getEmbedding(
    validatedText,
    validatedOptions,
  );
  validateEmbeddingPayload(embedding, expectedDimension);
  console.log("Offscreen: Embedding computation completed");

  return embedding;
}

/**
 * Batch get embedding vectors for texts
 */
async function handleGetEmbeddingsBatch(
  texts: unknown,
  options: unknown = {},
): Promise<Float32Array[]> {
  const validatedTexts = validateSemanticTexts(texts);
  const validatedOptions = validateSemanticOptions(
    options === undefined ? {} : options,
  );
  if (!isPublishedEngineReady() || !similarityEngine) {
    throw new Error(
      "Similarity engine not initialized. Please reinitialize the engine.",
    );
  }

  const expectedDimension = currentModelConfig?.modelDimension;
  if (!expectedDimension)
    throw new Error("Semantic model config is unavailable");
  console.log(
    `Offscreen: Getting embeddings for ${validatedTexts.length} texts`,
  );
  const embeddings = await similarityEngine.getEmbeddingsBatch(
    validatedTexts,
    validatedOptions,
  );
  validateEmbeddingsPayload(
    embeddings,
    validatedTexts.length,
    expectedDimension,
  );
  console.log("Offscreen: Batch embedding computation completed");

  return embeddings;
}

/**
 * Get engine status
 */
async function handleGetEngineStatus(): Promise<{
  isInitialized: boolean;
  currentConfig: SemanticModelSelection<ModelPreset> | null;
}> {
  return {
    isInitialized: isPublishedEngineReady(),
    currentConfig: isPublishedEngineReady() ? currentModelConfig : null,
  };
}

console.log("Offscreen: Semantic similarity engine handler loaded");
