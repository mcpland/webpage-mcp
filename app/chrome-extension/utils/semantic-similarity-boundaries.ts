export const SEMANTIC_MODEL_VERSIONS = ['full', 'quantized', 'compressed'] as const;

export type SemanticModelVersion = (typeof SEMANTIC_MODEL_VERSIONS)[number];

export const SEMANTIC_RESOURCE_LIMITS = Object.freeze({
  maxTextBytes: 32 * 1024,
  maxBatchTexts: 64,
  maxBatchPairs: 32,
  maxTotalTextBytes: 512 * 1024,
  maxOptionsBytes: 4 * 1024,
  maxOptionsKeys: 16,
  maxOptionKeyBytes: 64,
  maxOptionStringBytes: 1024,
  maxConcurrentRequests: 4,
  maxEmbeddingDimension: 768,
  maxStatusErrorBytes: 2 * 1024,
  maxWorkerQueue: 16,
  maxPinnedModelBytes: 512 * 1024 * 1024,
  maxModelResponseChunks: 65_536,
});

export interface SemanticModelCatalogEntry {
  dimension: number;
}

export type SemanticModelCatalog = Record<string, SemanticModelCatalogEntry>;

export interface SemanticModelSelection<Preset extends string = string> {
  modelPreset: Preset;
  modelVersion: SemanticModelVersion;
  modelDimension: number;
}

export type SemanticModelStatus = 'idle' | 'initializing' | 'downloading' | 'ready' | 'error';
export type SemanticModelErrorType = '' | 'network' | 'file' | 'unknown';

export interface NormalizedSemanticModelState {
  status: SemanticModelStatus;
  downloadProgress: number;
  isDownloading: boolean;
  lastUpdated: number;
  errorMessage: string;
  errorType: SemanticModelErrorType;
}

const MODEL_SELECTION_KEYS = new Set(['modelPreset', 'modelVersion', 'modelDimension']);
const MODEL_STATUSES = new Set<SemanticModelStatus>([
  'idle',
  'initializing',
  'downloading',
  'ready',
  'error',
]);
const MODEL_ERROR_TYPES = new Set<SemanticModelErrorType>(['', 'network', 'file', 'unknown']);
const MODEL_VERSIONS = new Set<string>(SEMANTIC_MODEL_VERSIONS);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedUtf8Length(value: string, limit: number): number {
  // One UTF-16 code unit always needs at least one UTF-8 byte. Rejecting here avoids
  // allocating an equally unbounded encoded copy merely to measure hostile input.
  if (value.length > limit) return limit + 1;
  return encoder.encode(value).byteLength;
}

export function truncateSemanticText(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || maxBytes <= 0) return '';

  const bounded = value.length > maxBytes ? value.slice(0, maxBytes) : value;
  const bytes = encoder.encode(bounded);
  if (bytes.byteLength <= maxBytes) return bounded;

  // TextDecoder replaces a trailing partial code point; remove only that replacement.
  return decoder.decode(bytes.subarray(0, maxBytes)).replace(/\uFFFD$/, '');
}

export function isSemanticModelVersion(value: unknown): value is SemanticModelVersion {
  return typeof value === 'string' && MODEL_VERSIONS.has(value);
}

export function validateSemanticModelSelection<Preset extends string>(
  value: unknown,
  catalog: Record<Preset, SemanticModelCatalogEntry>,
): SemanticModelSelection<Preset> {
  if (!isPlainRecord(value)) {
    throw new Error('Semantic model config must be a plain object');
  }

  let keyCount = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    keyCount++;
    if (keyCount > MODEL_SELECTION_KEYS.size || !MODEL_SELECTION_KEYS.has(key)) {
      throw new Error('Semantic model config contains unsupported fields');
    }
  }
  if (keyCount !== MODEL_SELECTION_KEYS.size) {
    throw new Error('Semantic model config must contain every required field');
  }

  const preset = value.modelPreset;
  if (typeof preset !== 'string' || !Object.prototype.hasOwnProperty.call(catalog, preset)) {
    throw new Error('Unsupported semantic model preset');
  }

  if (!isSemanticModelVersion(value.modelVersion)) {
    throw new Error('Unsupported semantic model version');
  }

  const expectedDimension = catalog[preset as Preset].dimension;
  if (
    !Number.isInteger(expectedDimension) ||
    expectedDimension <= 0 ||
    expectedDimension > SEMANTIC_RESOURCE_LIMITS.maxEmbeddingDimension
  ) {
    throw new Error('Semantic model catalog has an invalid dimension');
  }
  if (value.modelDimension !== expectedDimension) {
    throw new Error('Semantic model dimension does not match its preset');
  }

  return {
    modelPreset: preset as Preset,
    modelVersion: value.modelVersion,
    modelDimension: expectedDimension,
  };
}

export function getStoredSemanticModelSelection<Preset extends string>(
  storedPreset: unknown,
  storedVersion: unknown,
  catalog: Record<Preset, SemanticModelCatalogEntry>,
  fallbackPreset: Preset,
): SemanticModelSelection<Preset> {
  const preset =
    typeof storedPreset === 'string' && Object.prototype.hasOwnProperty.call(catalog, storedPreset)
      ? (storedPreset as Preset)
      : fallbackPreset;
  const modelVersion = isSemanticModelVersion(storedVersion) ? storedVersion : 'quantized';

  return validateSemanticModelSelection(
    {
      modelPreset: preset,
      modelVersion,
      modelDimension: catalog[preset].dimension,
    },
    catalog,
  );
}

export function validateSemanticText(value: unknown, label = 'text'): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (
    value.length > SEMANTIC_RESOURCE_LIMITS.maxTextBytes ||
    boundedUtf8Length(value, SEMANTIC_RESOURCE_LIMITS.maxTextBytes) >
      SEMANTIC_RESOURCE_LIMITS.maxTextBytes
  ) {
    throw new Error(`${label} exceeds the UTF-8 byte limit`);
  }
  if (value.trim().length === 0) throw new Error(`${label} cannot be empty`);
  return value;
}

export function validateSemanticTexts(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('texts must be an array');
  if (value.length > SEMANTIC_RESOURCE_LIMITS.maxBatchTexts) {
    throw new Error('texts exceeds the batch item limit');
  }

  let totalBytes = 0;
  for (let index = 0; index < value.length; index++) {
    const text = validateSemanticText(value[index], `texts[${index}]`);
    totalBytes += boundedUtf8Length(text, SEMANTIC_RESOURCE_LIMITS.maxTextBytes);
    if (totalBytes > SEMANTIC_RESOURCE_LIMITS.maxTotalTextBytes) {
      throw new Error('texts exceeds the total UTF-8 byte limit');
    }
  }
  return value as string[];
}

export interface SemanticTextPair {
  text1: string;
  text2: string;
}

export function validateSemanticPairs(value: unknown): SemanticTextPair[] {
  if (!Array.isArray(value)) throw new Error('pairs must be an array');
  if (value.length > SEMANTIC_RESOURCE_LIMITS.maxBatchPairs) {
    throw new Error('pairs exceeds the batch item limit');
  }

  let totalBytes = 0;
  for (let index = 0; index < value.length; index++) {
    const pair = value[index];
    if (!isPlainRecord(pair)) throw new Error(`pairs[${index}] must be a plain object`);
    let keyCount = 0;
    let hasText1 = false;
    let hasText2 = false;
    for (const key in pair) {
      if (!Object.prototype.hasOwnProperty.call(pair, key)) continue;
      keyCount++;
      if (key === 'text1') hasText1 = true;
      else if (key === 'text2') hasText2 = true;
      else throw new Error(`pairs[${index}] contains unsupported fields`);
      if (keyCount > 2) throw new Error(`pairs[${index}] contains unsupported fields`);
    }
    if (keyCount !== 2 || !hasText1 || !hasText2) {
      throw new Error(`pairs[${index}] contains unsupported fields`);
    }

    const text1 = validateSemanticText(pair.text1, `pairs[${index}].text1`);
    const text2 = validateSemanticText(pair.text2, `pairs[${index}].text2`);
    totalBytes += boundedUtf8Length(text1, SEMANTIC_RESOURCE_LIMITS.maxTextBytes);
    totalBytes += boundedUtf8Length(text2, SEMANTIC_RESOURCE_LIMITS.maxTextBytes);
    if (totalBytes > SEMANTIC_RESOURCE_LIMITS.maxTotalTextBytes) {
      throw new Error('pairs exceeds the total UTF-8 byte limit');
    }
  }
  return value as SemanticTextPair[];
}

export function validateSemanticOptions(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error('options must be a plain object');

  let keyCount = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    keyCount++;
    if (keyCount > SEMANTIC_RESOURCE_LIMITS.maxOptionsKeys) {
      throw new Error('options contains too many fields');
    }
    if (
      boundedUtf8Length(key, SEMANTIC_RESOURCE_LIMITS.maxOptionKeyBytes) >
      SEMANTIC_RESOURCE_LIMITS.maxOptionKeyBytes
    ) {
      throw new Error('options contains an oversized field name');
    }
    const optionValue = value[key];
    const validScalar =
      optionValue === null ||
      typeof optionValue === 'boolean' ||
      (typeof optionValue === 'number' && Number.isFinite(optionValue)) ||
      (typeof optionValue === 'string' &&
        boundedUtf8Length(optionValue, SEMANTIC_RESOURCE_LIMITS.maxOptionStringBytes) <=
          SEMANTIC_RESOURCE_LIMITS.maxOptionStringBytes);
    if (!validScalar) throw new Error('options values must be bounded JSON scalars');
  }

  const serialized = JSON.stringify(value);
  if (
    boundedUtf8Length(serialized, SEMANTIC_RESOURCE_LIMITS.maxOptionsBytes) >
    SEMANTIC_RESOURCE_LIMITS.maxOptionsBytes
  ) {
    throw new Error('options exceeds the UTF-8 byte limit');
  }
  return value;
}

function validateDimension(expectedDimension: number): void {
  if (
    !Number.isInteger(expectedDimension) ||
    expectedDimension <= 0 ||
    expectedDimension > SEMANTIC_RESOURCE_LIMITS.maxEmbeddingDimension
  ) {
    throw new Error('Invalid expected embedding dimension');
  }
}

export function validateEmbeddingPayload(
  value: unknown,
  expectedDimension: number,
): number[] | Float32Array {
  validateDimension(expectedDimension);
  if (!Array.isArray(value) && !(value instanceof Float32Array)) {
    throw new Error('Invalid embedding data received');
  }
  if (value.length !== expectedDimension) {
    throw new Error('Embedding dimension does not match the active model');
  }
  for (let index = 0; index < value.length; index++) {
    if (typeof value[index] !== 'number' || !Number.isFinite(value[index])) {
      throw new Error('Embedding contains a non-finite value');
    }
  }
  return value;
}

export function validateEmbeddingsPayload(
  value: unknown,
  expectedCount: number,
  expectedDimension: number,
): Array<number[] | Float32Array> {
  if (
    !Number.isInteger(expectedCount) ||
    expectedCount < 0 ||
    expectedCount > SEMANTIC_RESOURCE_LIMITS.maxBatchTexts
  ) {
    throw new Error('Invalid expected embedding batch size');
  }
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new Error('Embedding batch size does not match the request');
  }
  for (let index = 0; index < value.length; index++) {
    validateEmbeddingPayload(value[index], expectedDimension);
  }
  return value as Array<number[] | Float32Array>;
}

export function validateSimilaritiesPayload(value: unknown, expectedCount: number): number[] {
  if (
    !Number.isInteger(expectedCount) ||
    expectedCount < 0 ||
    expectedCount > SEMANTIC_RESOURCE_LIMITS.maxBatchPairs
  ) {
    throw new Error('Invalid expected similarity batch size');
  }
  if (!Array.isArray(value) || value.length !== expectedCount) {
    throw new Error('Similarity batch size does not match the request');
  }
  for (let index = 0; index < value.length; index++) {
    const similarity = value[index];
    if (
      typeof similarity !== 'number' ||
      !Number.isFinite(similarity) ||
      similarity < -1.000001 ||
      similarity > 1.000001
    ) {
      throw new Error('Similarity response contains an invalid value');
    }
  }
  return value as number[];
}

export function normalizeSemanticModelState(
  value: unknown,
  now = Date.now(),
): NormalizedSemanticModelState {
  const input = isPlainRecord(value) ? value : {};
  const status =
    typeof input.status === 'string' && MODEL_STATUSES.has(input.status as SemanticModelStatus)
      ? (input.status as SemanticModelStatus)
      : 'idle';
  const rawProgress =
    typeof input.downloadProgress === 'number' && Number.isFinite(input.downloadProgress)
      ? input.downloadProgress
      : 0;
  const downloadProgress = Math.min(100, Math.max(0, Math.round(rawProgress)));
  const rawTimestamp =
    typeof input.lastUpdated === 'number' && Number.isFinite(input.lastUpdated)
      ? Math.round(input.lastUpdated)
      : now;
  const lastUpdated = rawTimestamp >= 0 && rawTimestamp <= now + 86_400_000 ? rawTimestamp : now;
  const errorMessage =
    status === 'error'
      ? truncateSemanticText(input.errorMessage, SEMANTIC_RESOURCE_LIMITS.maxStatusErrorBytes)
      : '';
  const errorType =
    status !== 'error'
      ? ''
      : typeof input.errorType === 'string' &&
          MODEL_ERROR_TYPES.has(input.errorType as SemanticModelErrorType)
        ? (input.errorType as SemanticModelErrorType)
        : errorMessage
          ? 'unknown'
          : '';

  return {
    status,
    downloadProgress,
    isDownloading: status === 'downloading' || status === 'initializing',
    lastUpdated,
    errorMessage,
    errorType,
  };
}

export function safeSemanticErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
  return truncateSemanticText(message || fallback, SEMANTIC_RESOURCE_LIMITS.maxStatusErrorBytes);
}
