import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_RESOURCE_LIMITS,
  getStoredSemanticModelSelection,
  normalizeSemanticModelState,
  validateEmbeddingPayload,
  validateEmbeddingsPayload,
  validateSemanticModelSelection,
  validateSemanticOptions,
  validateSemanticPairs,
  validateSemanticText,
  validateSemanticTexts,
} from '@/utils/semantic-similarity-boundaries';

const models = {
  small: { dimension: 384 },
  base: { dimension: 768 },
} as const;

describe('semantic similarity resource boundaries', () => {
  it('accepts only exact catalog-backed model selections', () => {
    expect(
      validateSemanticModelSelection(
        {
          modelPreset: 'small',
          modelVersion: 'quantized',
          modelDimension: 384,
        },
        models,
      ),
    ).toEqual({
      modelPreset: 'small',
      modelVersion: 'quantized',
      modelDimension: 384,
    });

    expect(() =>
      validateSemanticModelSelection(
        {
          modelPreset: 'small',
          modelVersion: 'quantized',
          modelDimension: 384,
          modelIdentifier: 'attacker/model',
        },
        models,
      ),
    ).toThrow(/unsupported fields/i);
    expect(() =>
      validateSemanticModelSelection(
        { modelPreset: 'small', modelVersion: 'latest', modelDimension: 384 },
        models,
      ),
    ).toThrow(/version/i);
    expect(() =>
      validateSemanticModelSelection(
        { modelPreset: 'small', modelVersion: 'full', modelDimension: 768 },
        models,
      ),
    ).toThrow(/dimension/i);
  });

  it('falls back from invalid stored presets and versions', () => {
    expect(getStoredSemanticModelSelection('attacker', 'latest', models, 'small')).toEqual({
      modelPreset: 'small',
      modelVersion: 'quantized',
      modelDimension: 384,
    });
    expect(getStoredSemanticModelSelection('base', 'compressed', models, 'small')).toEqual({
      modelPreset: 'base',
      modelVersion: 'compressed',
      modelDimension: 768,
    });
  });

  it('enforces per-item, batch, total UTF-8, and options limits', () => {
    expect(() =>
      validateSemanticText('😀'.repeat(SEMANTIC_RESOURCE_LIMITS.maxTextBytes / 2)),
    ).toThrow(/UTF-8 byte limit/i);
    expect(() =>
      validateSemanticTexts(
        Array.from({ length: SEMANTIC_RESOURCE_LIMITS.maxBatchTexts + 1 }, () => 'text'),
      ),
    ).toThrow(/batch item limit/i);
    expect(() =>
      validateSemanticPairs(
        Array.from({ length: SEMANTIC_RESOURCE_LIMITS.maxBatchPairs + 1 }, () => ({
          text1: 'a',
          text2: 'b',
        })),
      ),
    ).toThrow(/batch item limit/i);

    const largeText = 'a'.repeat(SEMANTIC_RESOURCE_LIMITS.maxTextBytes);
    expect(() => validateSemanticTexts(Array.from({ length: 17 }, () => largeText))).toThrow(
      /total UTF-8 byte limit/i,
    );
    expect(() => validateSemanticOptions(null)).toThrow(/plain object/i);
    expect(() => validateSemanticOptions({ nested: { attacker: true } })).toThrow(/JSON scalars/i);
    expect(() =>
      validateSemanticOptions({
        value: 'a'.repeat(SEMANTIC_RESOURCE_LIMITS.maxOptionStringBytes + 1),
      }),
    ).toThrow(/JSON scalars/i);
  });

  it('validates response counts, dimensions, and finite values before conversion', () => {
    const embedding = Array.from({ length: 384 }, () => 0.5);
    expect(validateEmbeddingPayload(embedding, 384)).toBe(embedding);
    expect(() => validateEmbeddingPayload(new Array(768).fill(0), 384)).toThrow(/dimension/i);
    expect(() => validateEmbeddingPayload([...embedding.slice(0, -1), Number.NaN], 384)).toThrow(
      /non-finite/i,
    );
    expect(() => validateEmbeddingsPayload([embedding], 2, 384)).toThrow(/batch size/i);
  });

  it('normalizes status enums, progress, derived fields, timestamps, and error size', () => {
    expect(
      normalizeSemanticModelState(
        {
          status: 'downloading',
          downloadProgress: 150.4,
          isDownloading: false,
          lastUpdated: -1,
          errorMessage: 'ignored',
          errorType: 'attacker',
          extra: 'ignored',
        },
        1000,
      ),
    ).toEqual({
      status: 'downloading',
      downloadProgress: 100,
      isDownloading: true,
      lastUpdated: 1000,
      errorMessage: '',
      errorType: '',
    });

    const errorState = normalizeSemanticModelState({
      status: 'error',
      errorMessage: '😀'.repeat(SEMANTIC_RESOURCE_LIMITS.maxStatusErrorBytes),
      errorType: 'attacker',
    });
    expect(new TextEncoder().encode(errorState.errorMessage).byteLength).toBeLessThanOrEqual(
      SEMANTIC_RESOURCE_LIMITS.maxStatusErrorBytes,
    );
    expect(errorState.errorType).toBe('unknown');
  });
});
