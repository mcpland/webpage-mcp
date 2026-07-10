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
} from "@/common/message-types";
import { handleGifMessage } from "./gif-encoder";
import { initKeepalive } from "./rr-keepalive";
import { isExtensionRuntimeSender } from "@/common/runtime-sender-auth";
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

interface SimilarityEngineInitMessage extends OffscreenMessage {
  type: SendMessageType.SimilarityEngineInit;
  config: unknown;
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

interface SimilarityEngineStatusMessage extends OffscreenMessage {
  type: "similarityEngineStatus";
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

async function withSemanticRequestSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (semanticInitializationInFlight) {
    throw new Error("Semantic engine initialization is in progress");
  }
  if (activeSemanticRequests >= SEMANTIC_RESOURCE_LIMITS.maxConcurrentRequests) {
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
          const initMsg = message as SimilarityEngineInitMessage;
          console.log("Offscreen: Received similarity engine init message:", message.type);
          handleSimilarityEngineInit(initMsg.config)
            .then(() => sendResponse({ success: true }))
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
            .then((similarities) => sendResponse({ success: true, similarities }))
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
          withSemanticRequestSlot(() => handleGetEmbedding(embeddingMsg.text, embeddingMsg.options))
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
          withSemanticRequestSlot(() => handleGetEmbeddingsBatch(batchMsg.texts, batchMsg.options))
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
            error: safeSemanticErrorMessage(`Unknown message type: ${String(message.type)}`),
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
function needsReinitialization(newConfig: SemanticModelSelection<ModelPreset>): boolean {
  if (!similarityEngine || !currentModelConfig) {
    return true;
  }

  return (
    newConfig.modelPreset !== currentModelConfig.modelPreset ||
    newConfig.modelVersion !== currentModelConfig.modelVersion ||
    newConfig.modelDimension !== currentModelConfig.modelDimension
  );
}

/**
 * Progress callback function type
 */
type ProgressCallback = (progress: { status: string; progress: number; message?: string }) => void;

/**
 * Initialize semantic similarity engine
 */
async function handleSimilarityEngineInit(config: unknown): Promise<void> {
  const selection = validateSemanticModelSelection(config, PREDEFINED_MODELS);
  if (semanticInitializationInFlight || activeSemanticRequests > 0) {
    throw new Error("Semantic engine is busy");
  }
  semanticInitializationInFlight = true;
  try {
    await performSimilarityEngineInit(selection);
  } finally {
    semanticInitializationInFlight = false;
  }
}

async function performSimilarityEngineInit(
  selection: SemanticModelSelection<ModelPreset>,
): Promise<void> {
  console.log("Offscreen: Initializing semantic similarity engine", {
    modelPreset: selection.modelPreset,
    modelVersion: selection.modelVersion,
    modelDimension: selection.modelDimension,
  });

  // Check if reinitialization is needed
  const needsReinit = needsReinitialization(selection);
  console.log("Offscreen: Needs reinitialization:", needsReinit);

  if (!needsReinit) {
    console.log("Offscreen: Using existing engine (no changes detected)");
    await updateModelStatus("ready", 100);
    return;
  }

  // If engine already exists, clean up old instance first (support model switching)
  if (similarityEngine) {
    console.log("Offscreen: Cleaning up existing engine for model switch...");
    try {
      // Properly call dispose method to clean up all resources
      await similarityEngine.dispose();
      console.log("Offscreen: Previous engine disposed successfully");
    } catch (error) {
      console.warn("Offscreen: Failed to dispose previous engine:", error);
    }
    similarityEngine = null;
    currentModelConfig = null;

    // Clear vector data in IndexedDB to ensure data consistency
    try {
      console.log("Offscreen: Clearing IndexedDB vector data for model switch...");
      await clearVectorIndexedDB();
      console.log("Offscreen: IndexedDB vector data cleared successfully");
    } catch (error) {
      console.warn("Offscreen: Failed to clear IndexedDB vector data:", error);
    }
  }

  try {
    // Update status to initializing
    await updateModelStatus("initializing", 10);

    // Create progress callback function
    const progressCallback: ProgressCallback = async (progress) => {
      console.log("Offscreen: Progress update:", progress);
      await updateModelStatus(progress.status, progress.progress);
    };

    // Create engine instance and pass progress callback
    similarityEngine = new SemanticSimilarityEngine({
      modelPreset: selection.modelPreset,
      modelVersion: selection.modelVersion,
      dimension: selection.modelDimension,
      useLocalFiles: false,
      forceOffscreen: false,
    });
    console.log("Offscreen: Starting engine initialization with progress tracking...");

    // Use enhanced initialization method (if progress callback is supported)
    if (typeof (similarityEngine as any).initializeWithProgress === "function") {
      await (similarityEngine as any).initializeWithProgress(progressCallback);
    } else {
      // Fallback to standard initialization method
      console.log("Offscreen: Using standard initialization (no progress callback support)");
      await updateModelStatus("downloading", 30);
      await similarityEngine.initialize();
      await updateModelStatus("ready", 100);
    }

    // Save current configuration
    currentModelConfig = selection;

    console.log("Offscreen: Semantic similarity engine initialized successfully");
  } catch (error) {
    console.error("Offscreen: Failed to initialize semantic similarity engine:", error);
    // Update status to error
    const errorMessage = safeSemanticErrorMessage(error, "Unknown initialization error");
    const errorType = analyzeErrorType(errorMessage);
    await updateModelStatus("error", 0, errorMessage, errorType);
    // Clean up failed instance
    similarityEngine = null;
    currentModelConfig = null;
    throw error;
  }
}

/**
 * Clear vector data in IndexedDB
 */
async function clearVectorIndexedDB(): Promise<void> {
  try {
    // Clear vector search related IndexedDB databases
    const dbNames = ["VectorSearchDB", "ContentIndexerDB", "SemanticSimilarityDB"];

    for (const dbName of dbNames) {
      try {
        // Try to delete database
        const deleteRequest = indexedDB.deleteDatabase(dbName);
        await new Promise<void>((resolve, _reject) => {
          deleteRequest.onsuccess = () => {
            console.log(`Offscreen: Successfully deleted database: ${dbName}`);
            resolve();
          };
          deleteRequest.onerror = () => {
            console.warn(`Offscreen: Failed to delete database: ${dbName}`, deleteRequest.error);
            resolve(); // Don't block cleanup of other databases
          };
          deleteRequest.onblocked = () => {
            console.warn(`Offscreen: Database deletion blocked: ${dbName}`);
            resolve(); // Don't block cleanup of other databases
          };
        });
      } catch (error) {
        console.warn(`Offscreen: Error deleting database ${dbName}:`, error);
      }
    }
  } catch (error) {
    console.error("Offscreen: Failed to clear vector IndexedDB:", error);
    throw error;
  }
}

// Analyze error type
function analyzeErrorType(errorMessage: string): "network" | "file" | "unknown" {
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

// Helper function to update model status
async function updateModelStatus(
  status: unknown,
  progress: unknown,
  errorMessage?: unknown,
  errorType?: unknown,
) {
  try {
    const modelState = normalizeSemanticModelState({
      status,
      downloadProgress: progress,
      lastUpdated: Date.now(),
      errorMessage,
      errorType,
    });

    // In offscreen document, update storage through message passing to background script
    // because offscreen document may not have direct chrome.storage access
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ modelState });
    } else {
      // If chrome.storage is not available, pass message to background script
      console.log("Offscreen: chrome.storage not available, sending message to background");
      try {
        await chrome.runtime.sendMessage({
          type: BACKGROUND_MESSAGE_TYPES.UPDATE_MODEL_STATUS,
          modelState: modelState,
        });
      } catch (messageError) {
        console.error("Offscreen: Failed to send status update message:", messageError);
      }
    }
  } catch (error) {
    console.error("Offscreen: Failed to update model status:", error);
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
  const validatedOptions = validateSemanticOptions(options === undefined ? {} : options);
  if (!similarityEngine) {
    throw new Error("Similarity engine not initialized. Please reinitialize the engine.");
  }

  console.log(`Offscreen: Computing similarities for ${validatedPairs.length} pairs`);
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
async function handleGetEmbedding(text: unknown, options: unknown = {}): Promise<Float32Array> {
  const validatedText = validateSemanticText(text);
  const validatedOptions = validateSemanticOptions(options === undefined ? {} : options);
  if (!similarityEngine) {
    throw new Error("Similarity engine not initialized. Please reinitialize the engine.");
  }

  const expectedDimension = currentModelConfig?.modelDimension;
  if (!expectedDimension) throw new Error("Semantic model config is unavailable");
  console.log("Offscreen: Getting embedding");
  const embedding = await similarityEngine.getEmbedding(validatedText, validatedOptions);
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
  const validatedOptions = validateSemanticOptions(options === undefined ? {} : options);
  if (!similarityEngine) {
    throw new Error("Similarity engine not initialized. Please reinitialize the engine.");
  }

  const expectedDimension = currentModelConfig?.modelDimension;
  if (!expectedDimension) throw new Error("Semantic model config is unavailable");
  console.log(`Offscreen: Getting embeddings for ${validatedTexts.length} texts`);
  const embeddings = await similarityEngine.getEmbeddingsBatch(validatedTexts, validatedOptions);
  validateEmbeddingsPayload(embeddings, validatedTexts.length, expectedDimension);
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
    isInitialized: !!similarityEngine,
    currentConfig: currentModelConfig,
  };
}

console.log("Offscreen: Semantic similarity engine handler loaded");
