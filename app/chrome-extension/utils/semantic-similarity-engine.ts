import { AutoTokenizer, env as TransformersEnv } from '@xenova/transformers';
import type { Tensor as TransformersTensor, PreTrainedTokenizer } from '@xenova/transformers';
import LRUCache from './lru-cache';
import { SIMDMathEngine } from './simd-math-engine';
import { OffscreenManager } from './offscreen-manager';
import { STORAGE_KEYS } from '@/common/constants';
import { OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';
import {
  SEMANTIC_RESOURCE_LIMITS,
  getStoredSemanticModelSelection,
  validateEmbeddingPayload,
  validateEmbeddingsPayload,
  validateSemanticModelSelection,
  validateSemanticOptions,
  validateSemanticPairs,
  validateSemanticText,
  validateSemanticTexts,
  validateSimilaritiesPayload,
  type SemanticModelSelection,
} from './semantic-similarity-boundaries';

import { ModelCacheManager } from './model-cache-manager';
import {
  resolvePinnedModelArtifact,
  verifyPinnedModelArtifact,
  type PinnedModelArtifact,
} from './model-assets';

function decodeProbeText(buffer: ArrayBuffer, maxBytes = 512): string {
  try {
    return new TextDecoder('utf-8', { fatal: false })
      .decode(buffer.slice(0, maxBytes))
      .replaceAll('\u0000', '')
      .trim();
  } catch {
    return '';
  }
}

function looksLikeHtmlOrJson(text: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return (
    normalized.startsWith('<!doctype html') ||
    normalized.startsWith('<html') ||
    normalized.startsWith('<?xml') ||
    normalized.startsWith('{') ||
    normalized.startsWith('[')
  );
}

export async function readPinnedModelResponse(
  response: Response,
  expectedBytes: number,
): Promise<ArrayBuffer> {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes <= 0 ||
    expectedBytes > SEMANTIC_RESOURCE_LIMITS.maxPinnedModelBytes
  ) {
    throw new Error('Pinned model declares an invalid expected size');
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes =
      contentLength.length <= 32 && /^\d+$/.test(contentLength)
        ? Number(contentLength)
        : Number.NaN;
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes !== expectedBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Model response size mismatch: expected ${expectedBytes} bytes, got Content-Length ${contentLength}`,
      );
    }
  }

  if (!response.body) {
    throw new Error('Model response body is unavailable for bounded streaming');
  }

  const reader = response.body.getReader();
  const output = new Uint8Array(expectedBytes);
  let receivedBytes = 0;
  let chunkCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount++;
      if (chunkCount > SEMANTIC_RESOURCE_LIMITS.maxModelResponseChunks) {
        await reader
          .cancel('Model response exceeded the stream chunk limit')
          .catch(() => undefined);
        throw new Error('Model response exceeded the stream chunk limit');
      }
      if (!(value instanceof Uint8Array)) {
        throw new Error('Model response returned an invalid stream chunk');
      }
      if (value.byteLength > expectedBytes - receivedBytes) {
        await reader.cancel('Model response exceeded its pinned size').catch(() => undefined);
        throw new Error(`Model response exceeded the pinned size of ${expectedBytes} bytes`);
      }
      output.set(value, receivedBytes);
      receivedBytes += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (receivedBytes !== expectedBytes) {
    throw new Error(
      `Model response ended early: expected ${expectedBytes} bytes, got ${receivedBytes}`,
    );
  }
  return output.buffer;
}

/**
 * Get cached model data, prioritizing cache reads and handling redirected URLs.
 * @param artifact Pinned model artifact metadata
 * @returns {Promise<ArrayBuffer>} Model data as ArrayBuffer
 */
async function getCachedModelData(artifact: PinnedModelArtifact): Promise<ArrayBuffer> {
  const cacheManager = ModelCacheManager.getInstance();

  // 1. Try the immutable cache key first. The legacy `main` key is accepted
  // only after the same integrity check so existing offline caches keep working.
  for (const cacheUrl of [artifact.url, artifact.legacyCacheUrl]) {
    const cachedData = await cacheManager.getCachedModelData(cacheUrl);
    if (!cachedData) continue;

    try {
      await verifyPinnedModelArtifact(cachedData, artifact);
      return cachedData;
    } catch (error) {
      console.warn(`Discarding model cache entry that failed integrity verification:`, error);
      await cacheManager.deleteCacheEntry(cacheUrl);
    }
  }

  console.log('Model not found in cache or expired. Fetching from network...');

  try {
    // 2. Fetch data from network
    const response = await fetch(artifact.url);

    if (!response.ok) {
      throw new Error(`Failed to fetch model: ${response.status} ${response.statusText}`);
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      throw new Error(
        `Model endpoint returned unexpected content-type (${contentType}) instead of binary model data`,
      );
    }

    // 3. Stream into a pinned-size allocation. This prevents a compromised CDN or proxy
    // from making the extension buffer an arbitrarily large response before integrity checks.
    const arrayBuffer = await readPinnedModelResponse(response, artifact.size);

    // Guard against CDN/auth/error pages returned as HTML/JSON with 200 status.
    const probe = decodeProbeText(arrayBuffer);
    if (looksLikeHtmlOrJson(probe)) {
      const preview = probe.slice(0, 120).replace(/\s+/g, ' ');
      throw new Error(
        `Model download returned non-model payload (looks like HTML/JSON). Preview: ${preview}`,
      );
    }

    await verifyPinnedModelArtifact(arrayBuffer, artifact);
    await cacheManager.storeModelData(artifact.url, arrayBuffer);

    console.log(
      `Model fetched from network and successfully cached (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)}MB).`,
    );

    return arrayBuffer;
  } catch (error) {
    console.error(`Error fetching or caching model:`, error);
    // If fetch fails, clean up potentially incomplete cache entries
    await cacheManager.deleteCacheEntry(artifact.url);
    throw error;
  }
}

/**
 * Clear all model cache entries
 */
export async function clearModelCache(): Promise<void> {
  try {
    const cacheManager = ModelCacheManager.getInstance();
    await cacheManager.clearAllCache();
  } catch (error) {
    console.error('Failed to clear model cache:', error);
    throw error;
  }
}

/**
 * Get cache statistics
 */
export async function getCacheStats(): Promise<{
  totalSize: number;
  totalSizeMB: number;
  entryCount: number;
  entries: Array<{
    url: string;
    size: number;
    sizeMB: number;
    timestamp: number;
    age: string;
    expired: boolean;
  }>;
}> {
  try {
    const cacheManager = ModelCacheManager.getInstance();
    return await cacheManager.getCacheStats();
  } catch (error) {
    console.error('Failed to get cache stats:', error);
    throw error;
  }
}

/**
 * Manually trigger cache cleanup
 */
export async function cleanupModelCache(): Promise<void> {
  try {
    const cacheManager = ModelCacheManager.getInstance();
    await cacheManager.manualCleanup();
  } catch (error) {
    console.error('Failed to cleanup cache:', error);
    throw error;
  }
}

/**
 * Check if the default model is cached and available
 * @returns Promise<boolean> True if default model is cached and valid
 */
export async function isDefaultModelCached(): Promise<boolean> {
  try {
    // Get the default model configuration
    const result = await chrome.storage.local.get([STORAGE_KEYS.SEMANTIC_MODEL]);
    const selection = getStoredSemanticModelSelection(
      result[STORAGE_KEYS.SEMANTIC_MODEL],
      'quantized',
      PREDEFINED_MODELS,
      'multilingual-e5-small',
    );

    // Build the model URL
    const modelInfo = PREDEFINED_MODELS[selection.modelPreset];
    const artifact = resolvePinnedModelArtifact(
      modelInfo.modelIdentifier,
      getOnnxFileNameForVersion('quantized'),
    );

    // Check if this model is cached
    const cacheManager = ModelCacheManager.getInstance();
    return (
      (await cacheManager.isModelCached(artifact.url)) ||
      (await cacheManager.isModelCached(artifact.legacyCacheUrl))
    );
  } catch (error) {
    console.error('Error checking if default model is cached:', error);
    return false;
  }
}

/**
 * Check if any model cache exists (for conditional initialization)
 * @returns Promise<boolean> True if any valid model cache exists
 */
export async function hasAnyModelCache(): Promise<boolean> {
  try {
    const cacheManager = ModelCacheManager.getInstance();
    return await cacheManager.hasAnyValidCache();
  } catch (error) {
    console.error('Error checking for any model cache:', error);
    return false;
  }
}

// Predefined model configurations - 2025 curated recommended models, using quantized versions to reduce file size
export const PREDEFINED_MODELS = {
  // Multilingual model - default recommendation
  'multilingual-e5-small': {
    modelIdentifier: 'Xenova/multilingual-e5-small',
    dimension: 384,
    description: 'Multilingual E5 Small - Lightweight multilingual model supporting 100+ languages',
    language: 'multilingual',
    performance: 'excellent',
    size: '116MB', // Quantized version
    latency: '20ms',
    multilingualFeatures: {
      languageSupport: '100+',
      crossLanguageRetrieval: 'good',
      chineseEnglishMixed: 'good',
    },
    modelSpecificConfig: {
      requiresTokenTypeIds: false, // E5 model doesn't require token_type_ids
    },
  },
  'multilingual-e5-base': {
    modelIdentifier: 'Xenova/multilingual-e5-base',
    dimension: 768,
    description: 'Multilingual E5 base - Medium-scale multilingual model supporting 100+ languages',
    language: 'multilingual',
    performance: 'excellent',
    size: '279MB', // Quantized version
    latency: '30ms',
    multilingualFeatures: {
      languageSupport: '100+',
      crossLanguageRetrieval: 'excellent',
      chineseEnglishMixed: 'excellent',
    },
    modelSpecificConfig: {
      requiresTokenTypeIds: false, // E5 model doesn't require token_type_ids
    },
  },
} as const;

export type ModelPreset = keyof typeof PREDEFINED_MODELS;

/**
 * Get model information
 */
export function getModelInfo(preset: ModelPreset) {
  return PREDEFINED_MODELS[preset];
}

/**
 * List all available models
 */
export function listAvailableModels() {
  return Object.entries(PREDEFINED_MODELS).map(([key, value]) => ({
    preset: key as ModelPreset,
    ...value,
  }));
}

/**
 * Recommend model based on language - only uses multilingual-e5 series models
 */
export function recommendModelForLanguage(
  _language: 'en' | 'zh' | 'multilingual' = 'multilingual',
  scenario: 'speed' | 'balanced' | 'quality' = 'balanced',
): ModelPreset {
  // All languages use multilingual models
  if (scenario === 'quality') {
    return 'multilingual-e5-base'; // High quality choice
  }
  return 'multilingual-e5-small'; // Default lightweight choice
}

/**
 * Intelligently recommend model based on device performance and usage scenario - only uses multilingual-e5 series models
 */
export function recommendModelForDevice(
  _language: 'en' | 'zh' | 'multilingual' = 'multilingual',
  deviceMemory: number = 4, // GB
  networkSpeed: 'slow' | 'fast' = 'fast',
  prioritizeSpeed: boolean = false,
): ModelPreset {
  // Low memory devices or slow network, prioritize small models
  if (deviceMemory < 4 || networkSpeed === 'slow' || prioritizeSpeed) {
    return 'multilingual-e5-small'; // Lightweight choice
  }

  // High performance devices can use better models
  if (deviceMemory >= 8 && !prioritizeSpeed) {
    return 'multilingual-e5-base'; // High performance choice
  }

  // Default balanced choice
  return 'multilingual-e5-small';
}

/**
 * Get model size information (only supports quantized version)
 */
export function getModelSizeInfo(
  preset: ModelPreset,
  _version: 'full' | 'quantized' | 'compressed' = 'quantized',
) {
  const model = PREDEFINED_MODELS[preset];

  return {
    size: model.size,
    recommended: 'quantized',
    description: `${model.description} (Size: ${model.size})`,
  };
}

/**
 * Compare performance and size of multiple models
 */
export function compareModels(presets: ModelPreset[]) {
  return presets.map((preset) => {
    const model = PREDEFINED_MODELS[preset];

    return {
      preset,
      name: model.description.split(' - ')[0],
      language: model.language,
      performance: model.performance,
      dimension: model.dimension,
      latency: model.latency,
      size: model.size,
      features: (model as any).multilingualFeatures || {},
      maxLength: (model as any).maxLength || 512,
      recommendedFor: getRecommendationContext(preset),
    };
  });
}

/**
 * Get recommended use cases for model
 */
function getRecommendationContext(preset: ModelPreset): string[] {
  const contexts: string[] = [];
  const model = PREDEFINED_MODELS[preset];

  // All models are multilingual
  contexts.push('Multilingual document processing');

  if (model.performance === 'excellent') contexts.push('High accuracy requirements');
  if (model.latency.includes('20ms')) contexts.push('Fast response');

  // Add scenarios based on model size
  const sizeInMB = parseInt(model.size.replace('MB', ''));
  if (sizeInMB < 300) {
    contexts.push('Mobile devices');
    contexts.push('Lightweight deployment');
  }

  if (preset === 'multilingual-e5-small') {
    contexts.push('Lightweight deployment');
  } else if (preset === 'multilingual-e5-base') {
    contexts.push('High accuracy requirements');
  }

  return contexts;
}

/**
 * Get ONNX model filename (only supports quantized version)
 */
export function getOnnxFileNameForVersion(
  _version: 'full' | 'quantized' | 'compressed' = 'quantized',
): string {
  // Only return quantized version filename
  return 'model_quantized.onnx';
}

/**
 * Get model identifier (only supports quantized version)
 */
export function getModelIdentifierWithVersion(
  preset: ModelPreset,
  _version: 'full' | 'quantized' | 'compressed' = 'quantized',
): string {
  const model = PREDEFINED_MODELS[preset];
  return model.modelIdentifier;
}

/**
 * Get size comparison of all available models
 */
export function getAllModelSizes() {
  const models = Object.entries(PREDEFINED_MODELS).map(([preset, config]) => {
    return {
      preset: preset as ModelPreset,
      name: config.description.split(' - ')[0],
      language: config.language,
      size: config.size,
      performance: config.performance,
      latency: config.latency,
    };
  });

  // Sort by size
  return models.sort((a, b) => {
    const sizeA = parseInt(a.size.replace('MB', ''));
    const sizeB = parseInt(b.size.replace('MB', ''));
    return sizeA - sizeB;
  });
}

// Define necessary types
interface ModelConfig {
  modelIdentifier: string;
  localModelPathPrefix?: string; // Base path for local models (relative to public)
  onnxModelFile?: string; // ONNX model filename
  maxLength?: number;
  cacheSize?: number;
  numThreads?: number;
  executionProviders?: string[];
  useLocalFiles?: boolean;
  workerPath?: string; // Worker script path (relative to extension root)
  concurrentLimit?: number; // Worker task concurrency limit
  forceOffscreen?: boolean; // Force offscreen mode (for testing)
  modelPreset?: ModelPreset; // Predefined model selection
  dimension?: number; // Vector dimension (auto-obtained from preset model)
  modelVersion?: 'full' | 'quantized' | 'compressed'; // Model version selection
  requiresTokenTypeIds?: boolean; // Whether model requires token_type_ids input
}

function normalizeInternalModelSelection(
  options: Partial<ModelConfig>,
): SemanticModelSelection<ModelPreset> {
  const modelPreset = options.modelPreset ?? 'multilingual-e5-small';
  const hasKnownPreset =
    typeof modelPreset === 'string' &&
    Object.prototype.hasOwnProperty.call(PREDEFINED_MODELS, modelPreset);
  const modelDimension =
    options.dimension ??
    (hasKnownPreset ? PREDEFINED_MODELS[modelPreset as ModelPreset].dimension : -1);

  return validateSemanticModelSelection(
    {
      modelPreset,
      modelVersion: options.modelVersion ?? 'quantized',
      modelDimension,
    },
    PREDEFINED_MODELS,
  );
}

const SAFE_ENGINE_OPTION_KEYS = new Set([
  'modelPreset',
  'modelVersion',
  'dimension',
  'useLocalFiles',
  'forceOffscreen',
]);
const SAFE_PROXY_OPTION_KEYS = new Set(['modelPreset', 'modelVersion', 'dimension']);

interface WorkerMessagePayload {
  modelPath?: string;
  modelData?: ArrayBuffer;
  numThreads?: number;
  executionProviders?: string[];
  input_ids?: number[];
  attention_mask?: number[];
  token_type_ids?: number[];
  dims?: {
    input_ids: number[];
    attention_mask: number[];
    token_type_ids?: number[];
  };
}

interface WorkerResponsePayload {
  data?: Float32Array | number[]; // Tensor data as Float32Array or number array
  dims?: number[]; // Tensor dimensions
  message?: string; // For error or status messages
}

interface WorkerStats {
  inferenceTime?: number;
  totalInferences?: number;
  averageInferenceTime?: number;
  memoryAllocations?: number;
  batchSize?: number;
}

// Memory pool manager
class EmbeddingMemoryPool {
  private pools: Map<number, Float32Array[]> = new Map();
  private maxPoolSize: number = 10;
  private stats = { allocated: 0, reused: 0, released: 0 };

  getEmbedding(size: number): Float32Array {
    if (
      !Number.isInteger(size) ||
      size <= 0 ||
      size > SEMANTIC_RESOURCE_LIMITS.maxEmbeddingDimension
    ) {
      throw new Error('Invalid embedding allocation size');
    }
    const pool = this.pools.get(size);
    if (pool && pool.length > 0) {
      this.stats.reused++;
      return pool.pop()!;
    }

    this.stats.allocated++;
    return new Float32Array(size);
  }

  releaseEmbedding(embedding: Float32Array): void {
    const size = embedding.length;
    if (!this.pools.has(size)) {
      this.pools.set(size, []);
    }

    const pool = this.pools.get(size)!;
    if (pool.length < this.maxPoolSize) {
      // Clear array for reuse
      embedding.fill(0);
      pool.push(embedding);
      this.stats.released++;
    }
  }

  getStats() {
    return { ...this.stats };
  }

  clear(): void {
    this.pools.clear();
    this.stats = { allocated: 0, reused: 0, released: 0 };
  }
}

interface PendingMessage {
  resolve: (value: WorkerResponsePayload | PromiseLike<WorkerResponsePayload>) => void;
  reject: (reason?: any) => void;
  type: string;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface WorkerTaskWaiter {
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

const SEMANTIC_WORKER_DEFAULT_TIMEOUT_MS = 60_000;
const SEMANTIC_WORKER_INFERENCE_TIMEOUT_MS = 120_000;
const SEMANTIC_WORKER_INITIALIZATION_TIMEOUT_MS = 5 * 60_000;
const SEMANTIC_WORKER_CONTROL_TIMEOUT_MS = 10_000;
const SEMANTIC_WORKER_DISPOSE_CLEAR_TIMEOUT_MS = 2_000;

function semanticWorkerTimeoutMs(type: string): number {
  if (type === 'init') return SEMANTIC_WORKER_INITIALIZATION_TIMEOUT_MS;
  if (type === 'infer' || type === 'batchInfer') {
    return SEMANTIC_WORKER_INFERENCE_TIMEOUT_MS;
  }
  if (type === 'getStats' || type === 'clearBuffers') {
    return SEMANTIC_WORKER_CONTROL_TIMEOUT_MS;
  }
  return SEMANTIC_WORKER_DEFAULT_TIMEOUT_MS;
}

interface TokenizedOutput {
  // Simulates part of transformers.js tokenizer output
  input_ids: TransformersTensor;
  attention_mask: TransformersTensor;
  token_type_ids?: TransformersTensor;
}

/**
 * SemanticSimilarityEngine proxy class
 * Used by ContentIndexer and other components to reuse engine instance in offscreen, avoiding duplicate model downloads
 */
export class SemanticSimilarityEngineProxy {
  private _isInitialized = false;
  private config: SemanticModelSelection<ModelPreset>;
  private offscreenManager: OffscreenManager;
  private _isEnsuring = false; // Flag to prevent concurrent ensureOffscreenEngineInitialized calls

  constructor(config: Partial<ModelConfig> = {}) {
    let configKeyCount = 0;
    for (const key in config) {
      if (!Object.prototype.hasOwnProperty.call(config, key)) continue;
      configKeyCount++;
      if (configKeyCount > SAFE_PROXY_OPTION_KEYS.size || !SAFE_PROXY_OPTION_KEYS.has(key)) {
        throw new Error('Semantic engine proxy config contains unsupported fields');
      }
    }
    this.config = normalizeInternalModelSelection(config);
    this.offscreenManager = OffscreenManager.getInstance();
    console.log('SemanticSimilarityEngineProxy: Proxy created with config:', {
      modelPreset: this.config.modelPreset,
      modelVersion: this.config.modelVersion,
      dimension: this.config.modelDimension,
    });
  }

  async initialize(): Promise<void> {
    try {
      console.log('SemanticSimilarityEngineProxy: Starting proxy initialization...');

      // Ensure offscreen document exists
      console.log('SemanticSimilarityEngineProxy: Ensuring offscreen document exists...');
      await this.offscreenManager.ensureOffscreenDocument();
      console.log('SemanticSimilarityEngineProxy: Offscreen document ready');

      // Ensure engine in offscreen is initialized
      console.log('SemanticSimilarityEngineProxy: Ensuring offscreen engine is initialized...');
      await this.ensureOffscreenEngineInitialized();

      this._isInitialized = true;
      console.log(
        'SemanticSimilarityEngineProxy: Proxy initialized, delegating to offscreen engine',
      );
    } catch (error) {
      console.error('SemanticSimilarityEngineProxy: Initialization failed:', error);
      throw new Error(
        `Failed to initialize proxy: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Check engine status in offscreen
   */
  private async checkOffscreenEngineStatus(): Promise<{
    isInitialized: boolean;
    currentConfig: any;
  }> {
    try {
      const response = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_STATUS,
      });

      if (response && response.success) {
        return {
          isInitialized: response.isInitialized || false,
          currentConfig: response.currentConfig || null,
        };
      }
    } catch (error) {
      console.warn('SemanticSimilarityEngineProxy: Failed to check engine status:', error);
    }

    return { isInitialized: false, currentConfig: null };
  }

  /**
   * Ensure engine in offscreen is initialized (with concurrency protection)
   */
  private async ensureOffscreenEngineInitialized(): Promise<void> {
    // Prevent concurrent initialization attempts
    if (this._isEnsuring) {
      console.log('SemanticSimilarityEngineProxy: Already ensuring initialization, waiting...');
      // Wait a bit and check again
      await new Promise((resolve) => setTimeout(resolve, 100));
      return;
    }

    try {
      this._isEnsuring = true;
      const status = await this.checkOffscreenEngineStatus();
      let configMatches = false;
      if (status.isInitialized) {
        try {
          const currentConfig = validateSemanticModelSelection(
            status.currentConfig,
            PREDEFINED_MODELS,
          );
          configMatches =
            currentConfig.modelPreset === this.config.modelPreset &&
            currentConfig.modelVersion === this.config.modelVersion &&
            currentConfig.modelDimension === this.config.modelDimension;
        } catch {
          configMatches = false;
        }
      }

      if (!status.isInitialized || !configMatches) {
        console.log(
          'SemanticSimilarityEngineProxy: Engine not initialized in offscreen, initializing...',
        );

        // Reinitialize engine
        const response = await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_INIT,
          config: this.config,
        });

        if (!response || !response.success) {
          throw new Error(response?.error || 'Failed to initialize engine in offscreen document');
        }

        console.log('SemanticSimilarityEngineProxy: Engine reinitialized successfully');
      }
    } finally {
      this._isEnsuring = false;
    }
  }

  /**
   * Send message to offscreen document with retry mechanism and auto-reinitialization
   */
  private async sendMessageToOffscreen(message: any, maxRetries: number = 3): Promise<any> {
    // Ensure offscreen document exists
    await this.offscreenManager.ensureOffscreenDocument();

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(
          `SemanticSimilarityEngineProxy: Sending message (attempt ${attempt}/${maxRetries}):`,
          message.type,
        );

        const response = await chrome.runtime.sendMessage(message);

        if (!response) {
          throw new Error('No response received from offscreen document');
        }

        // If engine not initialized error received, try to reinitialize
        if (!response.success && response.error && response.error.includes('not initialized')) {
          console.log(
            'SemanticSimilarityEngineProxy: Engine not initialized, attempting to reinitialize...',
          );
          await this.ensureOffscreenEngineInitialized();

          // Resend original message
          const retryResponse = await chrome.runtime.sendMessage(message);
          if (retryResponse && retryResponse.success) {
            return retryResponse;
          }
        }

        return response;
      } catch (error) {
        lastError = error as Error;
        console.warn(
          `SemanticSimilarityEngineProxy: Message failed (attempt ${attempt}/${maxRetries}):`,
          error,
        );

        // If engine not initialized error, try to reinitialize
        if (error instanceof Error && error.message.includes('not initialized')) {
          try {
            console.log(
              'SemanticSimilarityEngineProxy: Attempting to reinitialize engine due to error...',
            );
            await this.ensureOffscreenEngineInitialized();

            // Resend original message
            const retryResponse = await chrome.runtime.sendMessage(message);
            if (retryResponse && retryResponse.success) {
              return retryResponse;
            }
          } catch (reinitError) {
            console.warn(
              'SemanticSimilarityEngineProxy: Failed to reinitialize engine:',
              reinitError,
            );
          }
        }

        if (attempt < maxRetries) {
          // Wait before retry
          await new Promise((resolve) => setTimeout(resolve, 100 * attempt));

          // Re-ensure offscreen document exists
          try {
            await this.offscreenManager.ensureOffscreenDocument();
          } catch (offscreenError) {
            console.warn(
              'SemanticSimilarityEngineProxy: Failed to ensure offscreen document:',
              offscreenError,
            );
          }
        }
      }
    }

    throw new Error(
      `Failed to communicate with offscreen document after ${maxRetries} attempts. Last error: ${lastError?.message}`,
    );
  }

  async getEmbedding(text: string, options: Record<string, any> = {}): Promise<Float32Array> {
    const validatedText = validateSemanticText(text);
    const validatedOptions = validateSemanticOptions(options);
    if (!this._isInitialized) {
      await this.initialize();
    }

    // Check and ensure engine is initialized before each call
    await this.ensureOffscreenEngineInitialized();

    const response = await this.sendMessageToOffscreen({
      target: 'offscreen',
      type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_COMPUTE,
      text: validatedText,
      options: validatedOptions,
    });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Failed to get embedding from offscreen document');
    }

    const embedding = validateEmbeddingPayload(response.embedding, this.config.modelDimension);
    return new Float32Array(embedding);
  }

  async getEmbeddingsBatch(
    texts: string[],
    options: Record<string, any> = {},
  ): Promise<Float32Array[]> {
    const validatedTexts = validateSemanticTexts(texts);
    const validatedOptions = validateSemanticOptions(options);
    if (!this._isInitialized) {
      await this.initialize();
    }

    if (validatedTexts.length === 0) return [];

    // Check and ensure engine is initialized before each call
    await this.ensureOffscreenEngineInitialized();

    const response = await this.sendMessageToOffscreen({
      target: 'offscreen',
      type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_BATCH_COMPUTE,
      texts: validatedTexts,
      options: validatedOptions,
    });

    if (!response || !response.success) {
      throw new Error(response?.error || 'Failed to get embeddings batch from offscreen document');
    }

    const embeddings = validateEmbeddingsPayload(
      response.embeddings,
      validatedTexts.length,
      this.config.modelDimension,
    );
    return embeddings.map((embedding) => new Float32Array(embedding));
  }

  async computeSimilarity(
    text1: string,
    text2: string,
    options: Record<string, any> = {},
  ): Promise<number> {
    const validatedTexts = validateSemanticTexts([text1, text2]);
    const validatedOptions = validateSemanticOptions(options);
    const [embedding1, embedding2] = await this.getEmbeddingsBatch(
      validatedTexts,
      validatedOptions,
    );
    return this.cosineSimilarity(embedding1, embedding2);
  }

  async computeSimilarityBatch(
    pairs: { text1: string; text2: string }[],
    options: Record<string, any> = {},
  ): Promise<number[]> {
    const validatedPairs = validateSemanticPairs(pairs);
    const validatedOptions = validateSemanticOptions(options);
    if (!this._isInitialized) {
      await this.initialize();
    }

    // Check and ensure engine is initialized before each call
    await this.ensureOffscreenEngineInitialized();

    const response = await this.sendMessageToOffscreen({
      target: 'offscreen',
      type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_BATCH_COMPUTE,
      pairs: validatedPairs,
      options: validatedOptions,
    });

    if (!response || !response.success) {
      throw new Error(
        response?.error || 'Failed to compute similarity batch from offscreen document',
      );
    }

    return validateSimilaritiesPayload(response.similarities, validatedPairs.length);
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error(`Vector dimensions don't match: ${a.length} vs ${b.length}`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  get isInitialized(): boolean {
    return this._isInitialized;
  }

  async dispose(): Promise<void> {
    // Proxy class doesn't need to clean up resources, actual resources are managed by offscreen
    this._isInitialized = false;
    console.log('SemanticSimilarityEngineProxy: Proxy disposed');
  }
}

export class SemanticSimilarityEngine {
  private worker: Worker | null = null;
  private tokenizer: PreTrainedTokenizer | null = null;
  public isInitialized = false;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;
  private nextTokenId = 0;
  private pendingMessages = new Map<number, PendingMessage>();
  private isDisposing = false;
  private disposePromise: Promise<void> | null = null;
  private useOffscreen = false; // Whether to use offscreen mode

  public readonly config: Required<ModelConfig>;

  private embeddingCache: LRUCache<string, Float32Array>;
  // Added: tokenization cache
  private tokenizationCache: LRUCache<string, TokenizedOutput>;
  // Added: memory pool manager
  private memoryPool: EmbeddingMemoryPool;
  // Added: SIMD math engine
  private simdMath: SIMDMathEngine | null = null;
  private useSIMD = false;

  public cacheStats = {
    embedding: { hits: 0, misses: 0, size: 0 },
    tokenization: { hits: 0, misses: 0, size: 0 },
  };

  public performanceStats = {
    totalEmbeddingComputations: 0,
    totalEmbeddingTime: 0,
    averageEmbeddingTime: 0,
    totalTokenizationTime: 0,
    averageTokenizationTime: 0,
    totalSimilarityComputations: 0,
    totalSimilarityTime: 0,
    averageSimilarityTime: 0,
    workerStats: null as WorkerStats | null,
  };

  private runningWorkerTasks = 0;
  private workerTaskQueue: WorkerTaskWaiter[] = [];

  /**
   * Detect if current runtime environment supports Worker
   */
  private isWorkerSupported(): boolean {
    try {
      // Check if in Service Worker environment (background script)
      if (typeof importScripts === 'function') {
        return false;
      }

      // Check if Worker constructor is available
      return typeof Worker !== 'undefined';
    } catch {
      return false;
    }
  }

  /**
   * Detect if in offscreen document environment
   */
  private isInOffscreenDocument(): boolean {
    try {
      // In offscreen document, window.location.pathname is usually '/offscreen.html'
      return (
        typeof window !== 'undefined' &&
        window.location &&
        window.location.pathname.includes('offscreen')
      );
    } catch {
      return false;
    }
  }

  /**
   * Ensure offscreen document exists
   */
  private async ensureOffscreenDocument(): Promise<void> {
    return OffscreenManager.getInstance().ensureOffscreenDocument();
  }

  // Helper function to safely convert tensor data to number array
  private convertTensorDataToNumbers(data: any): number[] {
    const maxElements = SEMANTIC_RESOURCE_LIMITS.maxBatchTexts * this.config.maxLength;
    if (
      data === null ||
      data === undefined ||
      typeof data.length !== 'number' ||
      !Number.isInteger(data.length) ||
      data.length < 0 ||
      data.length > maxElements
    ) {
      throw new Error('Tokenizer output exceeds the tensor element limit');
    }
    if (data instanceof BigInt64Array) {
      return Array.from(data, (val: bigint) => Number(val));
    } else if (data instanceof Int32Array) {
      return Array.from(data);
    } else {
      return Array.from(data);
    }
  }

  private validateTokenizedOutput(output: TokenizedOutput, expectedBatchSize: number): void {
    if (
      !Number.isInteger(expectedBatchSize) ||
      expectedBatchSize <= 0 ||
      expectedBatchSize > SEMANTIC_RESOURCE_LIMITS.maxBatchTexts
    ) {
      throw new Error('Invalid tokenizer batch size');
    }

    const validateTensor = (tensor: TransformersTensor | undefined, label: string): void => {
      if (!tensor || !Array.isArray(tensor.dims) || tensor.dims.length !== 2) {
        throw new Error(`${label} has invalid dimensions`);
      }
      const [batchSize, sequenceLength] = tensor.dims;
      if (
        batchSize !== expectedBatchSize ||
        !Number.isInteger(sequenceLength) ||
        sequenceLength <= 0 ||
        sequenceLength > this.config.maxLength
      ) {
        throw new Error(`${label} exceeds the tensor dimension limit`);
      }
      const expectedElements = batchSize * sequenceLength;
      if (
        !tensor.data ||
        typeof tensor.data.length !== 'number' ||
        tensor.data.length !== expectedElements
      ) {
        throw new Error(`${label} has an invalid element count`);
      }
    };

    validateTensor(output.input_ids, 'input_ids');
    validateTensor(output.attention_mask, 'attention_mask');
    if (output.token_type_ids) validateTensor(output.token_type_ids, 'token_type_ids');
  }

  constructor(options: Partial<ModelConfig> = {}) {
    let optionKeyCount = 0;
    for (const key in options) {
      if (!Object.prototype.hasOwnProperty.call(options, key)) continue;
      optionKeyCount++;
      if (optionKeyCount > SAFE_ENGINE_OPTION_KEYS.size || !SAFE_ENGINE_OPTION_KEYS.has(key)) {
        throw new Error('Semantic engine config contains unsupported fields');
      }
    }
    if (options.useLocalFiles !== undefined && options.useLocalFiles !== false) {
      throw new Error('Semantic engine local-file configuration is not allowed');
    }
    if (options.forceOffscreen !== undefined && typeof options.forceOffscreen !== 'boolean') {
      throw new Error('Semantic engine forceOffscreen must be a boolean');
    }

    const selection = normalizeInternalModelSelection(options);
    const preset = PREDEFINED_MODELS[selection.modelPreset];
    const detectedThreads =
      typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)
        ? Math.floor(navigator.hardwareConcurrency / 2)
        : 2;
    const numThreads = Math.min(4, Math.max(1, detectedThreads));

    this.config = {
      modelIdentifier: preset.modelIdentifier,
      localModelPathPrefix: 'models/',
      onnxModelFile: getOnnxFileNameForVersion(selection.modelVersion),
      maxLength: 256,
      cacheSize: 500,
      numThreads,
      executionProviders:
        typeof WebAssembly === 'object' &&
        WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
          ? ['wasm']
          : ['webgl'],
      useLocalFiles: false,
      workerPath: 'js/similarity.worker.js',
      concurrentLimit: Math.min(SEMANTIC_RESOURCE_LIMITS.maxConcurrentRequests, numThreads),
      forceOffscreen: options.forceOffscreen === true,
      modelPreset: selection.modelPreset,
      dimension: selection.modelDimension,
      modelVersion: selection.modelVersion,
      requiresTokenTypeIds: preset.modelSpecificConfig.requiresTokenTypeIds !== false,
    } as Required<ModelConfig>;

    console.log('SemanticSimilarityEngine: Final config:', {
      useLocalFiles: this.config.useLocalFiles,
      modelIdentifier: this.config.modelIdentifier,
      forceOffscreen: this.config.forceOffscreen,
    });

    this.embeddingCache = new LRUCache<string, Float32Array>(this.config.cacheSize);
    this.tokenizationCache = new LRUCache<string, TokenizedOutput>(
      Math.min(this.config.cacheSize, 200),
    );
    this.memoryPool = new EmbeddingMemoryPool();
    this.simdMath = new SIMDMathEngine();
  }

  private resolveRemoteModelArtifact(): PinnedModelArtifact {
    return resolvePinnedModelArtifact(this.config.modelIdentifier, this.config.onnxModelFile);
  }

  private takePendingWorkerMessage(id: number): PendingMessage | undefined {
    const pending = this.pendingMessages.get(id);
    if (!pending) return undefined;
    this.pendingMessages.delete(id);
    clearTimeout(pending.timeoutId);
    return pending;
  }

  private rejectPendingWorkerMessages(error: Error): void {
    const pending = Array.from(this.pendingMessages.values());
    this.pendingMessages.clear();
    for (const callbacks of pending) {
      clearTimeout(callbacks.timeoutId);
      callbacks.reject(error);
    }
  }

  private rejectWorkerTaskWaiters(error: Error): void {
    const waiters = this.workerTaskQueue.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }

  private terminateWorker(error: Error): void {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
    this.rejectPendingWorkerMessages(error);
    this.rejectWorkerTaskWaiters(error);
  }

  private _sendMessageToWorker(
    type: string,
    payload?: WorkerMessagePayload,
    transferList?: Transferable[],
    timeoutMs = semanticWorkerTimeoutMs(type),
    allowDuringDispose = false,
  ): Promise<WorkerResponsePayload> {
    return new Promise((resolve, reject) => {
      if (this.isDisposing && !allowDuringDispose) {
        reject(new Error('Semantic worker is being disposed.'));
        return;
      }
      const worker = this.worker;
      if (!worker) {
        reject(new Error('Worker is not initialized.'));
        return;
      }
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        reject(new Error('Semantic worker timeout must be a positive safe integer.'));
        return;
      }
      if (this.pendingMessages.size >= SEMANTIC_RESOURCE_LIMITS.maxConcurrentRequests + 2) {
        reject(new Error('Too many pending semantic worker messages'));
        return;
      }
      const id = this.nextTokenId++;
      const timeoutId = setTimeout(() => {
        const pending = this.takePendingWorkerMessage(id);
        if (!pending) return;
        const error = new Error(
          `Semantic worker task ${type} timed out after ${timeoutMs}ms`,
        );
        error.name = 'SemanticWorkerTimeoutError';
        pending.reject(error);
      }, timeoutMs);
      this.pendingMessages.set(id, { resolve, reject, type, timeoutId });

      try {
        // Use transferable objects if provided for zero-copy transfer
        if (transferList && transferList.length > 0) {
          worker.postMessage({ id, type, payload }, transferList);
        } else {
          worker.postMessage({ id, type, payload });
        }
      } catch (error) {
        const pending = this.takePendingWorkerMessage(id);
        pending?.reject(error);
      }
    });
  }

  private _setupWorker(): void {
    console.log('SemanticSimilarityEngine: Setting up worker...');

    // Method 1: Chrome extension URL (recommended, most reliable in production)
    try {
      const workerUrl = chrome.runtime.getURL('workers/similarity.worker.js');
      console.log(`SemanticSimilarityEngine: Trying chrome.runtime.getURL ${workerUrl}`);
      this.worker = new Worker(workerUrl);
      console.log(`SemanticSimilarityEngine: Method 1 successful with path`);
    } catch (error) {
      console.warn('Method (chrome.runtime.getURL) failed:', error);
    }

    if (!this.worker) {
      throw new Error('Worker creation failed');
    }

    this.worker.onmessage = (
      event: MessageEvent<{
        id: number;
        type: string;
        status: string;
        payload: WorkerResponsePayload;
        stats?: WorkerStats;
      }>,
    ) => {
      const { id, status, payload, stats } = event.data;
      const promiseCallbacks = this.takePendingWorkerMessage(id);
      if (!promiseCallbacks) return;

      // Update Worker statistics
      if (stats) {
        this.performanceStats.workerStats = stats;
      }

      if (status === 'success') {
        promiseCallbacks.resolve(payload);
      } else {
        const error = new Error(
          payload?.message || `Worker error for task ${promiseCallbacks.type}`,
        );
        (error as any).name = (payload as any)?.name || 'WorkerError';
        (error as any).stack = (payload as any)?.stack || undefined;
        console.error(
          `Error from worker (task ${id}, type ${promiseCallbacks.type}):`,
          error,
          event.data,
        );
        promiseCallbacks.reject(error);
      }
    };

    this.worker.onerror = (error: ErrorEvent) => {
      console.error('==== Unhandled error in SemanticSimilarityEngine Worker ====');
      console.error('Event Message:', error.message);
      console.error('Event Filename:', error.filename);
      console.error('Event Lineno:', error.lineno);
      console.error('Event Colno:', error.colno);
      if (error.error) {
        // Check if event.error exists
        console.error('Actual Error Name:', error.error.name);
        console.error('Actual Error Message:', error.error.message);
        console.error('Actual Error Stack:', error.error.stack);
      } else {
        console.error('Actual Error object (event.error) is not available. Error details:', {
          message: error.message,
          filename: error.filename,
          lineno: error.lineno,
          colno: error.colno,
        });
      }
      console.error('==========================================================');
      this.terminateWorker(
        new Error(`Worker terminated or unhandled error: ${error.message}`),
      );
      this.isInitialized = false;
      this.isInitializing = false;
    };
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) return Promise.resolve();
    if (this.isInitializing && this.initPromise) return this.initPromise;

    this.isInitializing = true;
    this.initPromise = this._doInitialize().finally(() => {
      this.isInitializing = false;
      // this.warmupModel();
    });
    return this.initPromise;
  }

  /**
   * Initialization method with progress callback
   */
  public async initializeWithProgress(
    onProgress?: (progress: { status: string; progress: number; message?: string }) => void,
  ): Promise<void> {
    if (this.isInitialized) return Promise.resolve();
    if (this.isInitializing && this.initPromise) return this.initPromise;

    this.isInitializing = true;
    this.initPromise = this._doInitializeWithProgress(onProgress).finally(() => {
      this.isInitializing = false;
      // this.warmupModel();
    });
    return this.initPromise;
  }

  /**
   * Internal initialization method with progress callback
   */
  private async _doInitializeWithProgress(
    onProgress?: (progress: { status: string; progress: number; message?: string }) => void,
  ): Promise<void> {
    console.log('SemanticSimilarityEngine: Initializing with progress tracking...');
    const startTime = performance.now();

    // Progress reporting helper function
    const reportProgress = (status: string, progress: number, message?: string) => {
      if (onProgress) {
        onProgress({ status, progress, message });
      }
    };

    try {
      reportProgress('initializing', 5, 'Starting initialization...');

      // Detect environment and decide which mode to use
      const workerSupported = this.isWorkerSupported();
      const inOffscreenDocument = this.isInOffscreenDocument();

      // 🛠️ Prevent infinite loop: if already in offscreen document, force direct Worker mode
      if (inOffscreenDocument) {
        this.useOffscreen = false;
        console.log(
          'SemanticSimilarityEngine: Running in offscreen document, using direct Worker mode to prevent recursion',
        );
      } else {
        this.useOffscreen = this.config.forceOffscreen || !workerSupported;
      }

      console.log(
        `SemanticSimilarityEngine: Worker supported: ${workerSupported}, In offscreen: ${inOffscreenDocument}, Using offscreen: ${this.useOffscreen}`,
      );

      reportProgress('initializing', 10, 'Environment detection complete');

      if (this.useOffscreen) {
        // Use offscreen mode - delegate to offscreen document, it will handle its own progress
        reportProgress('initializing', 15, 'Setting up offscreen document...');
        await this.ensureOffscreenDocument();

        const configToSend = {
          modelPreset: this.config.modelPreset,
          modelVersion: this.config.modelVersion,
          modelDimension: this.config.dimension,
        };

        reportProgress('initializing', 20, 'Delegating to offscreen document...');

        const response = await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_INIT,
          config: configToSend,
        });

        if (!response || !response.success) {
          throw new Error(response?.error || 'Failed to initialize engine in offscreen document');
        }

        reportProgress('ready', 100, 'Initialized via offscreen document');
        console.log('SemanticSimilarityEngine: Initialized via offscreen document');
      } else {
        // Use direct Worker mode - here we can provide real progress tracking
        await this._initializeDirectWorkerWithProgress(reportProgress);
      }

      this.isInitialized = true;
      console.log(
        `SemanticSimilarityEngine: Initialization complete in ${(performance.now() - startTime).toFixed(2)}ms`,
      );
    } catch (error) {
      console.error('SemanticSimilarityEngine: Initialization failed.', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      reportProgress('error', 0, `Initialization failed: ${errorMessage}`);
      this.terminateWorker(new Error(`Semantic worker initialization failed: ${errorMessage}`));
      this.isInitialized = false;
      this.isInitializing = false;
      this.initPromise = null;

      // Create a more detailed error object
      const enhancedError = new Error(errorMessage);
      enhancedError.name = 'ModelInitializationError';
      throw enhancedError;
    }
  }

  private async _doInitialize(): Promise<void> {
    console.log('SemanticSimilarityEngine: Initializing...');
    const startTime = performance.now();
    try {
      // Detect environment and decide which mode to use
      const workerSupported = this.isWorkerSupported();
      const inOffscreenDocument = this.isInOffscreenDocument();

      // 🛠️ Prevent infinite loop: if already in offscreen document, force direct Worker mode
      if (inOffscreenDocument) {
        this.useOffscreen = false;
        console.log(
          'SemanticSimilarityEngine: Running in offscreen document, using direct Worker mode to prevent recursion',
        );
      } else {
        this.useOffscreen = this.config.forceOffscreen || !workerSupported;
      }

      console.log(
        `SemanticSimilarityEngine: Worker supported: ${workerSupported}, In offscreen: ${inOffscreenDocument}, Using offscreen: ${this.useOffscreen}`,
      );

      if (this.useOffscreen) {
        // Use offscreen mode
        await this.ensureOffscreenDocument();

        const configToSend = {
          modelPreset: this.config.modelPreset,
          modelVersion: this.config.modelVersion,
          modelDimension: this.config.dimension,
        };

        const response = await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_INIT,
          config: configToSend,
        });

        if (!response || !response.success) {
          throw new Error(response?.error || 'Failed to initialize engine in offscreen document');
        }

        console.log('SemanticSimilarityEngine: Initialized via offscreen document');
      } else {
        // Use direct Worker mode
        this._setupWorker();
        const remoteArtifact = this.config.useLocalFiles ? null : this.resolveRemoteModelArtifact();

        TransformersEnv.allowRemoteModels = !this.config.useLocalFiles;
        TransformersEnv.allowLocalModels = this.config.useLocalFiles;

        console.log(`SemanticSimilarityEngine: TransformersEnv config:`, {
          allowRemoteModels: TransformersEnv.allowRemoteModels,
          allowLocalModels: TransformersEnv.allowLocalModels,
          useLocalFiles: this.config.useLocalFiles,
        });
        if (TransformersEnv.backends?.onnx?.wasm) {
          // Check if the path exists
          TransformersEnv.backends.onnx.wasm.numThreads = this.config.numThreads;
        }

        let tokenizerIdentifier = this.config.modelIdentifier;
        if (this.config.useLocalFiles) {
          // For WXT, resources under the public directory are located in the root path at runtime
          // Using the model identifier directly, transformers.js will automatically add the /models/ prefix
          tokenizerIdentifier = this.config.modelIdentifier;
        }
        console.log(
          `SemanticSimilarityEngine: Loading tokenizer from ${tokenizerIdentifier} (local_files_only: ${this.config.useLocalFiles})`,
        );
        const tokenizerConfig: any = {
          quantized: false,
          local_files_only: this.config.useLocalFiles,
        };
        if (remoteArtifact) {
          tokenizerConfig.revision = remoteArtifact.revision;
        }

        // For models that do not require token_type_ids, set this explicitly in the tokenizer configuration
        if (!this.config.requiresTokenTypeIds) {
          tokenizerConfig.return_token_type_ids = false;
        }

        console.log(`SemanticSimilarityEngine: Full tokenizer config:`, {
          tokenizerIdentifier,
          localModelPathPrefix: this.config.localModelPathPrefix,
          modelIdentifier: this.config.modelIdentifier,
          useLocalFiles: this.config.useLocalFiles,
          local_files_only: this.config.useLocalFiles,
          requiresTokenTypeIds: this.config.requiresTokenTypeIds,
          tokenizerConfig,
        });
        this.tokenizer = await AutoTokenizer.from_pretrained(tokenizerIdentifier, tokenizerConfig);
        console.log('SemanticSimilarityEngine: Tokenizer loaded.');

        if (this.config.useLocalFiles) {
          // Local files mode - use URL path as before
          const onnxModelPathForWorker = chrome.runtime.getURL(
            `models/${this.config.modelIdentifier}/${this.config.onnxModelFile}`,
          );
          console.log(
            `SemanticSimilarityEngine: Instructing worker to load local ONNX model from ${onnxModelPathForWorker}`,
          );
          await this._sendMessageToWorker('init', {
            modelPath: onnxModelPathForWorker,
            numThreads: this.config.numThreads,
            executionProviders: this.config.executionProviders,
          });
        } else {
          // Remote files mode - use cached model data
          if (!remoteArtifact) {
            throw new Error('Pinned remote model artifact was not resolved.');
          }
          console.log(
            `SemanticSimilarityEngine: Getting cached model data from ${remoteArtifact.url}`,
          );

          // Get model data from cache (may download if not cached)
          const modelData = await getCachedModelData(remoteArtifact);

          console.log(
            `SemanticSimilarityEngine: Sending cached model data to worker (${modelData.byteLength} bytes)`,
          );

          // Send ArrayBuffer to worker with transferable objects for zero-copy
          await this._sendMessageToWorker(
            'init',
            {
              modelData: modelData,
              numThreads: this.config.numThreads,
              executionProviders: this.config.executionProviders,
            },
            [modelData],
          );
        }
        console.log('SemanticSimilarityEngine: Worker reported model initialized.');

        // Try to initialize SIMD acceleration
        try {
          console.log('SemanticSimilarityEngine: Checking SIMD support...');
          const simdSupported = await SIMDMathEngine.checkSIMDSupport();

          if (simdSupported) {
            console.log('SemanticSimilarityEngine: SIMD supported, initializing...');
            await this.simdMath!.initialize();
            this.useSIMD = true;
            console.log('SemanticSimilarityEngine: ✅ SIMD acceleration enabled');
          } else {
            console.log(
              'SemanticSimilarityEngine: ❌ SIMD not supported, using JavaScript fallback',
            );
            console.log('SemanticSimilarityEngine: To enable SIMD, please use:');
            console.log('  - Chrome 91+ (May 2021)');
            console.log('  - Firefox 89+ (June 2021)');
            console.log('  - Safari 16.4+ (March 2023)');
            console.log('  - Edge 91+ (May 2021)');
            this.useSIMD = false;
          }
        } catch (simdError) {
          console.warn(
            'SemanticSimilarityEngine: SIMD initialization failed, using JavaScript fallback:',
            simdError,
          );
          this.useSIMD = false;
        }
      }

      this.isInitialized = true;
      console.log(
        `SemanticSimilarityEngine: Initialization complete in ${(performance.now() - startTime).toFixed(2)}ms`,
      );
    } catch (error) {
      console.error('SemanticSimilarityEngine: Initialization failed.', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.terminateWorker(new Error(`Semantic worker initialization failed: ${errorMessage}`));
      this.isInitialized = false;
      this.isInitializing = false;
      this.initPromise = null;

      // Create a more detailed error object
      const enhancedError = new Error(errorMessage);
      enhancedError.name = 'ModelInitializationError';
      throw enhancedError;
    }
  }

  /**
   * Initialization of direct Worker mode, supporting progress callback
   */
  private async _initializeDirectWorkerWithProgress(
    reportProgress: (status: string, progress: number, message?: string) => void,
  ): Promise<void> {
    // Use direct Worker mode
    reportProgress('initializing', 25, 'Setting up worker...');
    this._setupWorker();
    const remoteArtifact = this.config.useLocalFiles ? null : this.resolveRemoteModelArtifact();

    TransformersEnv.allowRemoteModels = !this.config.useLocalFiles;
    TransformersEnv.allowLocalModels = this.config.useLocalFiles;

    console.log(`SemanticSimilarityEngine: TransformersEnv config:`, {
      allowRemoteModels: TransformersEnv.allowRemoteModels,
      allowLocalModels: TransformersEnv.allowLocalModels,
      useLocalFiles: this.config.useLocalFiles,
    });
    if (TransformersEnv.backends?.onnx?.wasm) {
      TransformersEnv.backends.onnx.wasm.numThreads = this.config.numThreads;
    }

    let tokenizerIdentifier = this.config.modelIdentifier;
    if (this.config.useLocalFiles) {
      tokenizerIdentifier = this.config.modelIdentifier;
    }

    reportProgress('downloading', 40, 'Loading tokenizer...');
    console.log(
      `SemanticSimilarityEngine: Loading tokenizer from ${tokenizerIdentifier} (local_files_only: ${this.config.useLocalFiles})`,
    );

    // Using the progress callback functionality of transformers.js 2.17+
    const tokenizerProgressCallback = (progress: any) => {
      if (progress.status === 'downloading') {
        const progressPercent = Math.min(40 + (progress.progress || 0) * 0.3, 70);
        reportProgress(
          'downloading',
          progressPercent,
          `Downloading tokenizer: ${progress.file || ''}`,
        );
      }
    };

    const tokenizerConfig: any = {
      quantized: false,
      local_files_only: this.config.useLocalFiles,
    };
    if (remoteArtifact) {
      tokenizerConfig.revision = remoteArtifact.revision;
    }

    // For models that do not require token_type_ids, set this explicitly in the tokenizer configuration
    if (!this.config.requiresTokenTypeIds) {
      tokenizerConfig.return_token_type_ids = false;
    }

    try {
      if (!this.config.useLocalFiles) {
        tokenizerConfig.progress_callback = tokenizerProgressCallback;
      }
      this.tokenizer = await AutoTokenizer.from_pretrained(tokenizerIdentifier, tokenizerConfig);
    } catch (error) {
      // If progress callback is not supported, fall back to standard method
      console.log(
        'SemanticSimilarityEngine: Progress callback not supported, using standard loading',
      );
      delete tokenizerConfig.progress_callback;
      this.tokenizer = await AutoTokenizer.from_pretrained(tokenizerIdentifier, tokenizerConfig);
    }

    reportProgress('downloading', 70, 'Tokenizer loaded, setting up ONNX model...');
    console.log('SemanticSimilarityEngine: Tokenizer loaded.');

    if (this.config.useLocalFiles) {
      // Local files mode - use URL path as before
      const onnxModelPathForWorker = chrome.runtime.getURL(
        `models/${this.config.modelIdentifier}/${this.config.onnxModelFile}`,
      );
      reportProgress('downloading', 80, 'Loading local ONNX model...');
      console.log(
        `SemanticSimilarityEngine: Instructing worker to load local ONNX model from ${onnxModelPathForWorker}`,
      );
      await this._sendMessageToWorker('init', {
        modelPath: onnxModelPathForWorker,
        numThreads: this.config.numThreads,
        executionProviders: this.config.executionProviders,
      });
    } else {
      // Remote files mode - use cached model data
      if (!remoteArtifact) {
        throw new Error('Pinned remote model artifact was not resolved.');
      }
      reportProgress('downloading', 80, 'Loading cached ONNX model...');
      console.log(`SemanticSimilarityEngine: Getting cached model data from ${remoteArtifact.url}`);

      // Get model data from cache (may download if not cached)
      const modelData = await getCachedModelData(remoteArtifact);

      console.log(
        `SemanticSimilarityEngine: Sending cached model data to worker (${modelData.byteLength} bytes)`,
      );

      // Send ArrayBuffer to worker with transferable objects for zero-copy
      await this._sendMessageToWorker(
        'init',
        {
          modelData: modelData,
          numThreads: this.config.numThreads,
          executionProviders: this.config.executionProviders,
        },
        [modelData],
      );
    }
    console.log('SemanticSimilarityEngine: Worker reported model initialized.');

    reportProgress('initializing', 90, 'Setting up SIMD acceleration...');
    // Try to initialize SIMD acceleration
    try {
      console.log('SemanticSimilarityEngine: Checking SIMD support...');
      const simdSupported = await SIMDMathEngine.checkSIMDSupport();

      if (simdSupported) {
        console.log('SemanticSimilarityEngine: SIMD supported, initializing...');
        await this.simdMath!.initialize();
        this.useSIMD = true;
        console.log('SemanticSimilarityEngine: ✅ SIMD acceleration enabled');
      } else {
        console.log('SemanticSimilarityEngine: ❌ SIMD not supported, using JavaScript fallback');
        this.useSIMD = false;
      }
    } catch (simdError) {
      console.warn(
        'SemanticSimilarityEngine: SIMD initialization failed, using JavaScript fallback:',
        simdError,
      );
      this.useSIMD = false;
    }

    reportProgress('ready', 100, 'Initialization complete');
  }

  public async warmupModel(): Promise<void> {
    if (!this.isInitialized && !this.isInitializing) {
      await this.initialize();
    } else if (this.isInitializing && this.initPromise) {
      await this.initPromise;
    }
    if (!this.isInitialized) throw new Error('Engine not initialized after warmup attempt.');
    console.log('SemanticSimilarityEngine: Warming up model...');

    // More representative warm-up text of varying lengths and languages
    const warmupTexts = [
      // short text
      'Hello',
      'hello',
      'Test',
      // medium length text
      'Hello world, this is a test.',
      'Hello world, this is a test. ',
      'The quick brown fox jumps over the lazy dog.',
      // long text
      'This is a longer text that contains multiple sentences. It helps warm up the model for various text lengths.',
      'This is a longer text containing multiple sentences. It helps warm up the model for various text lengths. ',
    ];

    try {
      // Progressive preheating: single first, then batch
      console.log('SemanticSimilarityEngine: Phase 1 - Individual warmup...');
      for (const text of warmupTexts.slice(0, 4)) {
        await this.getEmbedding(text);
      }

      console.log('SemanticSimilarityEngine: Phase 2 - Batch warmup...');
      await this.getEmbeddingsBatch(warmupTexts.slice(4));

      // Keep the preheating results and do not clear the cache
      console.log('SemanticSimilarityEngine: Model warmup complete. Cache preserved.');
      console.log(`Embedding cache: ${this.cacheStats.embedding.size} items`);
      console.log(`Tokenization cache: ${this.cacheStats.tokenization.size} items`);
    } catch (error) {
      console.warn('SemanticSimilarityEngine: Warmup failed. This might not be critical.', error);
    }
  }

  private async _tokenizeText(text: string | string[]): Promise<TokenizedOutput> {
    if (!this.tokenizer) throw new Error('Tokenizer not initialized.');

    // For a single text, try using caching
    if (typeof text === 'string') {
      const cacheKey = `tokenize:${text}`;
      const cached = this.tokenizationCache.get(cacheKey);
      if (cached) {
        this.cacheStats.tokenization.hits++;
        this.cacheStats.tokenization.size = this.tokenizationCache.size;
        return cached;
      }
      this.cacheStats.tokenization.misses++;

      const startTime = performance.now();
      const tokenizerOptions: any = {
        padding: true,
        truncation: true,
        max_length: this.config.maxLength,
        return_tensors: 'np',
      };

      // For models that do not require token_type_ids, explicitly set return_token_type_ids to false
      if (!this.config.requiresTokenTypeIds) {
        tokenizerOptions.return_token_type_ids = false;
      }

      const result = (await this.tokenizer(text, tokenizerOptions)) as TokenizedOutput;

      // Update performance statistics
      this.performanceStats.totalTokenizationTime += performance.now() - startTime;
      this.performanceStats.averageTokenizationTime =
        this.performanceStats.totalTokenizationTime /
        (this.cacheStats.tokenization.hits + this.cacheStats.tokenization.misses);

      // cache results
      this.tokenizationCache.set(cacheKey, result);
      this.cacheStats.tokenization.size = this.tokenizationCache.size;

      return result;
    }

    // For batches of text, process them directly (batch processing usually does not repeat)
    const startTime = performance.now();
    const tokenizerOptions: any = {
      padding: true,
      truncation: true,
      max_length: this.config.maxLength,
      return_tensors: 'np',
    };

    // For models that do not require token_type_ids, explicitly set return_token_type_ids to false
    if (!this.config.requiresTokenTypeIds) {
      tokenizerOptions.return_token_type_ids = false;
    }

    const result = (await this.tokenizer(text, tokenizerOptions)) as TokenizedOutput;

    this.performanceStats.totalTokenizationTime += performance.now() - startTime;
    return result;
  }

  private _extractEmbeddingFromWorkerOutput(
    workerOutput: WorkerResponsePayload,
    attentionMaskArray: number[],
  ): Float32Array {
    if (!workerOutput.data || !Array.isArray(workerOutput.dims) || workerOutput.dims.length !== 3)
      throw new Error('Invalid worker output for embedding extraction.');

    const [batchSize, seqLength, hiddenSize] = workerOutput.dims;
    if (
      batchSize !== 1 ||
      !Number.isInteger(seqLength) ||
      seqLength <= 0 ||
      seqLength > this.config.maxLength ||
      hiddenSize !== this.config.dimension ||
      attentionMaskArray.length !== seqLength
    ) {
      throw new Error('Worker embedding dimensions exceed the configured limits.');
    }
    const expectedElements = batchSize * seqLength * hiddenSize;
    if (workerOutput.data.length !== expectedElements) {
      throw new Error('Worker embedding element count is invalid.');
    }

    // Optimization: Use Float32Array directly to avoid unnecessary conversions
    const lastHiddenStateData =
      workerOutput.data instanceof Float32Array
        ? workerOutput.data
        : new Float32Array(workerOutput.data);

    // Use memory pool to get embedding array
    const embedding = this.memoryPool.getEmbedding(hiddenSize);
    let validTokens = 0;

    for (let i = 0; i < seqLength; i++) {
      if (attentionMaskArray[i] === 1) {
        const offset = i * hiddenSize;
        for (let j = 0; j < hiddenSize; j++) {
          embedding[j] += lastHiddenStateData[offset + j];
        }
        validTokens++;
      }
    }
    if (validTokens > 0) {
      for (let i = 0; i < hiddenSize; i++) {
        embedding[i] /= validTokens;
      }
    }
    const normalized = this.normalizeVector(embedding);
    validateEmbeddingPayload(normalized, this.config.dimension);
    return normalized;
  }

  private _extractBatchEmbeddingsFromWorkerOutput(
    workerOutput: WorkerResponsePayload,
    attentionMasksBatch: number[][],
  ): Float32Array[] {
    if (!workerOutput.data || !Array.isArray(workerOutput.dims) || workerOutput.dims.length !== 3)
      throw new Error('Invalid worker output for batch embedding extraction.');

    const [batchSize, seqLength, hiddenSize] = workerOutput.dims;
    if (
      !Number.isInteger(batchSize) ||
      batchSize <= 0 ||
      batchSize > SEMANTIC_RESOURCE_LIMITS.maxBatchTexts ||
      batchSize !== attentionMasksBatch.length ||
      !Number.isInteger(seqLength) ||
      seqLength <= 0 ||
      seqLength > this.config.maxLength ||
      hiddenSize !== this.config.dimension
    ) {
      throw new Error('Worker batch embedding dimensions exceed the configured limits.');
    }
    const expectedElements = batchSize * seqLength * hiddenSize;
    if (workerOutput.data.length !== expectedElements) {
      throw new Error('Worker batch embedding element count is invalid.');
    }
    for (let index = 0; index < attentionMasksBatch.length; index++) {
      if (
        !Array.isArray(attentionMasksBatch[index]) ||
        attentionMasksBatch[index].length !== seqLength
      ) {
        throw new Error('Worker batch attention mask dimensions are invalid.');
      }
    }

    // Optimization: Use Float32Array directly to avoid unnecessary conversions
    const lastHiddenStateData =
      workerOutput.data instanceof Float32Array
        ? workerOutput.data
        : new Float32Array(workerOutput.data);

    const embeddings: Float32Array[] = [];

    for (let b = 0; b < batchSize; b++) {
      // Use memory pool to get embedding array
      const embedding = this.memoryPool.getEmbedding(hiddenSize);
      let validTokens = 0;
      const currentAttentionMask = attentionMasksBatch[b];
      for (let i = 0; i < seqLength; i++) {
        if (currentAttentionMask[i] === 1) {
          const offset = (b * seqLength + i) * hiddenSize;
          for (let j = 0; j < hiddenSize; j++) {
            embedding[j] += lastHiddenStateData[offset + j];
          }
          validTokens++;
        }
      }
      if (validTokens > 0) {
        for (let i = 0; i < hiddenSize; i++) {
          embedding[i] /= validTokens;
        }
      }
      const normalized = this.normalizeVector(embedding);
      validateEmbeddingPayload(normalized, this.config.dimension);
      embeddings.push(normalized);
    }
    return embeddings;
  }

  public async getEmbedding(
    text: string,
    options: Record<string, any> = {},
  ): Promise<Float32Array> {
    const validatedText = validateSemanticText(text);
    const validatedOptions = validateSemanticOptions(options);
    if (!this.isInitialized) await this.initialize();

    const cacheKey = this.getCacheKey(validatedText, validatedOptions);
    const cached = this.embeddingCache.get(cacheKey);
    if (cached) {
      this.cacheStats.embedding.hits++;
      this.cacheStats.embedding.size = this.embeddingCache.size;
      return cached;
    }
    this.cacheStats.embedding.misses++;

    // If using offscreen mode, delegate to offscreen document
    if (this.useOffscreen) {
      const response = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_COMPUTE,
        text: validatedText,
        options: validatedOptions,
      });

      if (!response || !response.success) {
        throw new Error(response?.error || 'Failed to get embedding from offscreen document');
      }

      const validatedEmbedding = validateEmbeddingPayload(
        response.embedding,
        this.config.dimension,
      );
      const embedding = new Float32Array(validatedEmbedding);

      this.embeddingCache.set(cacheKey, embedding);
      this.cacheStats.embedding.size = this.embeddingCache.size;

      // Update performance statistics
      this.performanceStats.totalEmbeddingComputations++;

      return embedding;
    }

    if (this.runningWorkerTasks >= this.config.concurrentLimit) {
      await this.waitForWorkerSlot();
    }
    this.runningWorkerTasks++;

    const startTime = performance.now();
    try {
      const tokenized = await this._tokenizeText(validatedText);
      this.validateTokenizedOutput(tokenized, 1);

      const inputIdsData = this.convertTensorDataToNumbers(tokenized.input_ids.data);
      const attentionMaskData = this.convertTensorDataToNumbers(tokenized.attention_mask.data);
      const tokenTypeIdsData = tokenized.token_type_ids
        ? this.convertTensorDataToNumbers(tokenized.token_type_ids.data)
        : undefined;

      const workerPayload: WorkerMessagePayload = {
        input_ids: inputIdsData,
        attention_mask: attentionMaskData,
        token_type_ids: tokenTypeIdsData,
        dims: {
          input_ids: tokenized.input_ids.dims,
          attention_mask: tokenized.attention_mask.dims,
          token_type_ids: tokenized.token_type_ids?.dims,
        },
      };

      const workerOutput = await this._sendMessageToWorker('infer', workerPayload);
      const embedding = this._extractEmbeddingFromWorkerOutput(workerOutput, attentionMaskData);
      this.embeddingCache.set(cacheKey, embedding);
      this.cacheStats.embedding.size = this.embeddingCache.size;

      this.performanceStats.totalEmbeddingComputations++;
      this.performanceStats.totalEmbeddingTime += performance.now() - startTime;
      this.performanceStats.averageEmbeddingTime =
        this.performanceStats.totalEmbeddingTime / this.performanceStats.totalEmbeddingComputations;
      return embedding;
    } finally {
      this.runningWorkerTasks--;
      this.processWorkerQueue();
    }
  }

  public async getEmbeddingsBatch(
    texts: string[],
    options: Record<string, any> = {},
  ): Promise<Float32Array[]> {
    const validatedTexts = validateSemanticTexts(texts);
    const validatedOptions = validateSemanticOptions(options);
    if (!this.isInitialized) await this.initialize();
    if (validatedTexts.length === 0) return [];

    // If using offscreen mode, delegate to offscreen document
    if (this.useOffscreen) {
      // Check cache first
      const results: (Float32Array | undefined)[] = new Array(validatedTexts.length).fill(
        undefined,
      );
      const uncachedTexts: string[] = [];
      const uncachedIndices: number[] = [];

      validatedTexts.forEach((text, index) => {
        const cacheKey = this.getCacheKey(text, validatedOptions);
        const cached = this.embeddingCache.get(cacheKey);
        if (cached) {
          results[index] = cached;
          this.cacheStats.embedding.hits++;
        } else {
          uncachedTexts.push(text);
          uncachedIndices.push(index);
          this.cacheStats.embedding.misses++;
        }
      });

      // If everything is in cache, return directly
      if (uncachedTexts.length === 0) {
        return results as Float32Array[];
      }

      // Request only uncached text
      const response = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_BATCH_COMPUTE,
        texts: uncachedTexts,
        options: validatedOptions,
      });

      if (!response || !response.success) {
        throw new Error(
          response?.error || 'Failed to get embeddings batch from offscreen document',
        );
      }

      const validatedEmbeddings = validateEmbeddingsPayload(
        response.embeddings,
        uncachedTexts.length,
        this.config.dimension,
      );

      // Put the result back into the corresponding location and cache it
      validatedEmbeddings.forEach((embeddingArray, batchIndex) => {
        const embedding = new Float32Array(embeddingArray);
        const originalIndex = uncachedIndices[batchIndex];
        const originalText = uncachedTexts[batchIndex];

        results[originalIndex] = embedding;

        // cache results
        const cacheKey = this.getCacheKey(originalText, validatedOptions);
        this.embeddingCache.set(cacheKey, embedding);
      });

      this.cacheStats.embedding.size = this.embeddingCache.size;
      this.performanceStats.totalEmbeddingComputations += uncachedTexts.length;

      return results as Float32Array[];
    }

    const results: (Float32Array | undefined)[] = new Array(validatedTexts.length).fill(undefined);
    const uncachedTextsMap = new Map<string, number[]>();
    const textsToTokenize: string[] = [];

    validatedTexts.forEach((text, index) => {
      const cacheKey = this.getCacheKey(text, validatedOptions);
      const cached = this.embeddingCache.get(cacheKey);
      if (cached) {
        results[index] = cached;
        this.cacheStats.embedding.hits++;
      } else {
        if (!uncachedTextsMap.has(text)) {
          uncachedTextsMap.set(text, []);
          textsToTokenize.push(text);
        }
        uncachedTextsMap.get(text)!.push(index);
        this.cacheStats.embedding.misses++;
      }
    });
    this.cacheStats.embedding.size = this.embeddingCache.size;

    if (textsToTokenize.length === 0) return results as Float32Array[];

    if (this.runningWorkerTasks >= this.config.concurrentLimit) {
      await this.waitForWorkerSlot();
    }
    this.runningWorkerTasks++;

    const startTime = performance.now();
    try {
      const tokenizedBatch = await this._tokenizeText(textsToTokenize);
      this.validateTokenizedOutput(tokenizedBatch, textsToTokenize.length);
      const workerPayload: WorkerMessagePayload = {
        input_ids: this.convertTensorDataToNumbers(tokenizedBatch.input_ids.data),
        attention_mask: this.convertTensorDataToNumbers(tokenizedBatch.attention_mask.data),
        token_type_ids: tokenizedBatch.token_type_ids
          ? this.convertTensorDataToNumbers(tokenizedBatch.token_type_ids.data)
          : undefined,
        dims: {
          input_ids: tokenizedBatch.input_ids.dims,
          attention_mask: tokenizedBatch.attention_mask.dims,
          token_type_ids: tokenizedBatch.token_type_ids?.dims,
        },
      };

      // Use true batch inference
      const workerOutput = await this._sendMessageToWorker('batchInfer', workerPayload);
      const attentionMasksForBatch: number[][] = [];
      const batchSize = tokenizedBatch.input_ids.dims[0];
      const seqLength = tokenizedBatch.input_ids.dims[1];
      const rawAttentionMaskData = this.convertTensorDataToNumbers(
        tokenizedBatch.attention_mask.data,
      );

      for (let i = 0; i < batchSize; ++i) {
        attentionMasksForBatch.push(rawAttentionMaskData.slice(i * seqLength, (i + 1) * seqLength));
      }

      const batchEmbeddings = this._extractBatchEmbeddingsFromWorkerOutput(
        workerOutput,
        attentionMasksForBatch,
      );
      batchEmbeddings.forEach((embedding, batchIdx) => {
        const originalText = textsToTokenize[batchIdx];
        const cacheKey = this.getCacheKey(originalText, validatedOptions);
        this.embeddingCache.set(cacheKey, embedding);
        const originalResultIndices = uncachedTextsMap.get(originalText)!;
        originalResultIndices.forEach((idx) => {
          results[idx] = embedding;
        });
      });
      this.cacheStats.embedding.size = this.embeddingCache.size;

      this.performanceStats.totalEmbeddingComputations += textsToTokenize.length;
      this.performanceStats.totalEmbeddingTime += performance.now() - startTime;
      this.performanceStats.averageEmbeddingTime =
        this.performanceStats.totalEmbeddingTime / this.performanceStats.totalEmbeddingComputations;
      return results as Float32Array[];
    } finally {
      this.runningWorkerTasks--;
      this.processWorkerQueue();
    }
  }

  public async computeSimilarity(
    text1: string,
    text2: string,
    options: Record<string, any> = {},
  ): Promise<number> {
    const validatedTexts = validateSemanticTexts([text1, text2]);
    const validatedOptions = validateSemanticOptions(options);
    if (!this.isInitialized) await this.initialize();

    const simStartTime = performance.now();
    const [embedding1, embedding2] = await this.getEmbeddingsBatch(
      validatedTexts,
      validatedOptions,
    );
    const similarity = this.cosineSimilarity(embedding1, embedding2);
    console.log('computeSimilarity:', similarity);
    this.performanceStats.totalSimilarityComputations++;
    this.performanceStats.totalSimilarityTime += performance.now() - simStartTime;
    this.performanceStats.averageSimilarityTime =
      this.performanceStats.totalSimilarityTime / this.performanceStats.totalSimilarityComputations;
    return similarity;
  }

  public async computeSimilarityBatch(
    pairs: { text1: string; text2: string }[],
    options: Record<string, any> = {},
  ): Promise<number[]> {
    const validatedPairs = validateSemanticPairs(pairs);
    const validatedOptions = validateSemanticOptions(options);
    if (!this.isInitialized) await this.initialize();
    if (validatedPairs.length === 0) return [];

    // If using offscreen mode, delegate to offscreen document
    if (this.useOffscreen) {
      const response = await chrome.runtime.sendMessage({
        target: 'offscreen',
        type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_BATCH_COMPUTE,
        pairs: validatedPairs,
        options: validatedOptions,
      });

      if (!response || !response.success) {
        throw new Error(response?.error || 'Failed to compute similarities in offscreen document');
      }

      return validateSimilaritiesPayload(response.similarities, validatedPairs.length);
    }

    // Original logic of direct mode
    const simStartTime = performance.now();
    const uniqueTextsSet = new Set<string>();
    validatedPairs.forEach((pair) => {
      uniqueTextsSet.add(pair.text1);
      uniqueTextsSet.add(pair.text2);
    });

    const uniqueTextsArray = Array.from(uniqueTextsSet);
    const embeddingsArray = await this.getEmbeddingsBatch(uniqueTextsArray, validatedOptions);
    const embeddingMap = new Map<string, Float32Array>();
    uniqueTextsArray.forEach((text, index) => {
      embeddingMap.set(text, embeddingsArray[index]);
    });

    const similarities = validatedPairs.map((pair) => {
      const emb1 = embeddingMap.get(pair.text1);
      const emb2 = embeddingMap.get(pair.text2);
      if (!emb1 || !emb2) {
        console.warn('Embeddings not found for pair:', pair);
        return 0;
      }
      return this.cosineSimilarity(emb1, emb2);
    });
    this.performanceStats.totalSimilarityComputations += validatedPairs.length;
    this.performanceStats.totalSimilarityTime += performance.now() - simStartTime;
    this.performanceStats.averageSimilarityTime =
      this.performanceStats.totalSimilarityTime / this.performanceStats.totalSimilarityComputations;
    return similarities;
  }

  public async computeSimilarityMatrix(
    texts1: string[],
    texts2: string[],
    options: Record<string, any> = {},
  ): Promise<number[][]> {
    const validatedTexts1 = validateSemanticTexts(texts1);
    const validatedTexts2 = validateSemanticTexts(texts2);
    const validatedOptions = validateSemanticOptions(options);
    if (
      validatedTexts1.length + validatedTexts2.length > SEMANTIC_RESOURCE_LIMITS.maxBatchTexts ||
      validatedTexts1.length * validatedTexts2.length > SEMANTIC_RESOURCE_LIMITS.maxBatchTexts ** 2
    ) {
      throw new Error('Similarity matrix exceeds the resource limit');
    }
    if (!this.isInitialized) await this.initialize();
    if (validatedTexts1.length === 0 || validatedTexts2.length === 0) return [];

    const simStartTime = performance.now();
    const allTextsSet = new Set<string>();
    validatedTexts1.forEach((text) => allTextsSet.add(text));
    validatedTexts2.forEach((text) => allTextsSet.add(text));

    const allTextsArray = Array.from(allTextsSet);
    const embeddingsArray = await this.getEmbeddingsBatch(allTextsArray, validatedOptions);
    const embeddingMap = new Map<string, Float32Array>();
    allTextsArray.forEach((text, index) => {
      embeddingMap.set(text, embeddingsArray[index]);
    });

    // Use SIMD-optimized matrix calculations (if available)
    if (this.useSIMD && this.simdMath) {
      try {
        const embeddings1 = validatedTexts1.map((text) => embeddingMap.get(text)!).filter(Boolean);
        const embeddings2 = validatedTexts2.map((text) => embeddingMap.get(text)!).filter(Boolean);

        if (
          embeddings1.length === validatedTexts1.length &&
          embeddings2.length === validatedTexts2.length
        ) {
          const matrix = await this.simdMath.similarityMatrix(embeddings1, embeddings2);

          this.performanceStats.totalSimilarityComputations +=
            validatedTexts1.length * validatedTexts2.length;
          this.performanceStats.totalSimilarityTime += performance.now() - simStartTime;
          this.performanceStats.averageSimilarityTime =
            this.performanceStats.totalSimilarityTime /
            this.performanceStats.totalSimilarityComputations;

          return matrix;
        }
      } catch (error) {
        console.warn('SIMD matrix computation failed, falling back to JavaScript:', error);
      }
    }

    // JavaScript Fallback version
    const matrix: number[][] = [];
    for (const textA of validatedTexts1) {
      const row: number[] = [];
      const embA = embeddingMap.get(textA);
      if (!embA) {
        console.warn(`Embedding not found for text1: "${textA}"`);
        validatedTexts2.forEach(() => row.push(0));
        matrix.push(row);
        continue;
      }
      for (const textB of validatedTexts2) {
        const embB = embeddingMap.get(textB);
        if (!embB) {
          console.warn(`Embedding not found for text2: "${textB}"`);
          row.push(0);
          continue;
        }
        row.push(this.cosineSimilarity(embA, embB));
      }
      matrix.push(row);
    }
    this.performanceStats.totalSimilarityComputations +=
      validatedTexts1.length * validatedTexts2.length;
    this.performanceStats.totalSimilarityTime += performance.now() - simStartTime;
    this.performanceStats.averageSimilarityTime =
      this.performanceStats.totalSimilarityTime / this.performanceStats.totalSimilarityComputations;
    return matrix;
  }

  public cosineSimilarity(vecA: Float32Array, vecB: Float32Array): number {
    validateEmbeddingPayload(vecA, this.config.dimension);
    validateEmbeddingPayload(vecB, this.config.dimension);

    // Use SIMD optimized version if available
    if (this.useSIMD && this.simdMath) {
      try {
        // SIMD The version is asynchronous, but to maintain interface compatibility we need a synchronous version
        // Here we fall back to the JavaScript version, or we can consider refactoring to asynchronous
        return this.cosineSimilarityJS(vecA, vecB);
      } catch (error) {
        console.warn('SIMD cosine similarity failed, falling back to JavaScript:', error);
        return this.cosineSimilarityJS(vecA, vecB);
      }
    }

    return this.cosineSimilarityJS(vecA, vecB);
  }

  private cosineSimilarityJS(vecA: Float32Array, vecB: Float32Array): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  // New: Asynchronous SIMD optimized cosine similarity
  public async cosineSimilaritySIMD(vecA: Float32Array, vecB: Float32Array): Promise<number> {
    validateEmbeddingPayload(vecA, this.config.dimension);
    validateEmbeddingPayload(vecB, this.config.dimension);

    if (this.useSIMD && this.simdMath) {
      try {
        return await this.simdMath.cosineSimilarity(vecA, vecB);
      } catch (error) {
        console.warn('SIMD cosine similarity failed, falling back to JavaScript:', error);
      }
    }

    return this.cosineSimilarityJS(vecA, vecB);
  }

  public normalizeVector(vector: Float32Array): Float32Array {
    validateEmbeddingPayload(vector, this.config.dimension);
    let norm = 0;
    for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i];
    norm = Math.sqrt(norm);
    if (norm === 0) return vector;
    const normalized = new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i++) normalized[i] = vector[i] / norm;
    return normalized;
  }

  public validateInput(text1: string, text2: string | 'valid_dummy'): void {
    validateSemanticText(text1, 'text1');
    if (text2 !== 'valid_dummy') validateSemanticText(text2, 'text2');
  }

  private getCacheKey(text: string, _options: Record<string, any> = {}): string {
    return text; // Options currently not used to vary embedding, simplify key
  }

  public getPerformanceStats(): Record<string, any> {
    return {
      ...this.performanceStats,
      cacheStats: {
        ...this.cacheStats,
        embedding: {
          ...this.cacheStats.embedding,
          hitRate:
            this.cacheStats.embedding.hits + this.cacheStats.embedding.misses > 0
              ? this.cacheStats.embedding.hits /
                (this.cacheStats.embedding.hits + this.cacheStats.embedding.misses)
              : 0,
        },
        tokenization: {
          ...this.cacheStats.tokenization,
          hitRate:
            this.cacheStats.tokenization.hits + this.cacheStats.tokenization.misses > 0
              ? this.cacheStats.tokenization.hits /
                (this.cacheStats.tokenization.hits + this.cacheStats.tokenization.misses)
              : 0,
        },
      },
      memoryPool: this.memoryPool.getStats(),
      memoryUsage: this.getMemoryUsage(),
      isInitialized: this.isInitialized,
      isInitializing: this.isInitializing,
      config: this.config,
      pendingWorkerTasks: this.workerTaskQueue.length,
      runningWorkerTasks: this.runningWorkerTasks,
    };
  }

  private async waitForWorkerSlot(): Promise<void> {
    if (this.workerTaskQueue.length >= SEMANTIC_RESOURCE_LIMITS.maxWorkerQueue) {
      throw new Error('Semantic worker queue is full');
    }
    return new Promise((resolve, reject) => {
      this.workerTaskQueue.push({ resolve, reject });
    });
  }

  private processWorkerQueue(): void {
    if (this.workerTaskQueue.length > 0 && this.runningWorkerTasks < this.config.concurrentLimit) {
      const waiter = this.workerTaskQueue.shift();
      waiter?.resolve();
    }
  }

  // New: Get Worker statistics
  public async getWorkerStats(): Promise<WorkerStats | null> {
    if (!this.worker || !this.isInitialized) return null;

    try {
      const response = await this._sendMessageToWorker('getStats');
      return response as WorkerStats;
    } catch (error) {
      console.warn('Failed to get worker stats:', error);
      return null;
    }
  }

  // New: Clean up Worker buffer
  public async clearWorkerBuffers(): Promise<void> {
    await this.clearWorkerBuffersWithin(SEMANTIC_WORKER_CONTROL_TIMEOUT_MS, false);
  }

  private async clearWorkerBuffersWithin(
    timeoutMs: number,
    allowDuringDispose: boolean,
  ): Promise<void> {
    if (!this.worker || !this.isInitialized) return;

    try {
      await this._sendMessageToWorker(
        'clearBuffers',
        undefined,
        undefined,
        timeoutMs,
        allowDuringDispose,
      );
      console.log('SemanticSimilarityEngine: Worker buffers cleared.');
    } catch (error) {
      console.warn('Failed to clear worker buffers:', error);
    }
  }

  // New: Clean all caches
  public clearAllCaches(): void {
    this.embeddingCache.clear();
    this.tokenizationCache.clear();
    this.cacheStats = {
      embedding: { hits: 0, misses: 0, size: 0 },
      tokenization: { hits: 0, misses: 0, size: 0 },
    };
    console.log('SemanticSimilarityEngine: All caches cleared.');
  }

  // New: Get memory usage
  public getMemoryUsage(): {
    embeddingCacheUsage: number;
    tokenizationCacheUsage: number;
    totalCacheUsage: number;
  } {
    const embeddingStats = this.embeddingCache.getStats();
    const tokenizationStats = this.tokenizationCache.getStats();

    return {
      embeddingCacheUsage: embeddingStats.usage,
      tokenizationCacheUsage: tokenizationStats.usage,
      totalCacheUsage: (embeddingStats.usage + tokenizationStats.usage) / 2,
    };
  }

  public dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.isDisposing = true;
    this.disposePromise = this.performDispose().finally(() => {
      this.isDisposing = false;
      this.disposePromise = null;
    });
    return this.disposePromise;
  }

  private async performDispose(): Promise<void> {
    console.log('SemanticSimilarityEngine: Disposing...');

    const disposalError = new Error('Semantic worker was disposed.');
    this.rejectPendingWorkerMessages(disposalError);
    this.rejectWorkerTaskWaiters(disposalError);

    // Best-effort only: a wedged worker must not block model replacement.
    await this.clearWorkerBuffersWithin(
      SEMANTIC_WORKER_DISPOSE_CLEAR_TIMEOUT_MS,
      true,
    );
    this.terminateWorker(disposalError);

    // Clean SIMD engine
    if (this.simdMath) {
      this.simdMath.dispose();
      this.simdMath = null;
    }

    this.tokenizer = null;
    this.embeddingCache.clear();
    this.tokenizationCache.clear();
    this.memoryPool.clear();
    this.isInitialized = false;
    this.isInitializing = false;
    this.initPromise = null;
    this.useSIMD = false;
    console.log('SemanticSimilarityEngine: Disposed.');
  }
}
