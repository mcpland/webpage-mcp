import { describe, expect, it } from 'vitest';
import {
  SemanticSimilarityEngine,
  SemanticSimilarityEngineProxy,
  readPinnedModelResponse,
} from '@/utils/semantic-similarity-engine';
import { SEMANTIC_RESOURCE_LIMITS } from '@/utils/semantic-similarity-boundaries';

describe('SemanticSimilarityEngine security boundaries', () => {
  it('constructs catalog-backed 384/768 configs and rejects tunable resource injection', () => {
    const small = new SemanticSimilarityEngine({
      modelPreset: 'multilingual-e5-small',
      modelVersion: 'quantized',
      dimension: 384,
      useLocalFiles: false,
      forceOffscreen: false,
    });
    const base = new SemanticSimilarityEngine({
      modelPreset: 'multilingual-e5-base',
      modelVersion: 'full',
      dimension: 768,
      useLocalFiles: false,
      forceOffscreen: false,
    });

    expect(small.config).toMatchObject({
      modelIdentifier: 'Xenova/multilingual-e5-small',
      dimension: 384,
      cacheSize: 500,
    });
    expect(base.config).toMatchObject({
      modelIdentifier: 'Xenova/multilingual-e5-base',
      dimension: 768,
      cacheSize: 500,
    });
    expect(
      () =>
        new SemanticSimilarityEngine({
          modelPreset: 'multilingual-e5-small',
          dimension: 384,
          cacheSize: 1_000_000,
        }),
    ).toThrow(/unsupported fields/i);
    expect(
      () =>
        new SemanticSimilarityEngine({
          modelPreset: 'multilingual-e5-small',
          dimension: 768,
        }),
    ).toThrow(/dimension/i);
    expect(
      () =>
        new SemanticSimilarityEngineProxy({
          modelPreset: 'multilingual-e5-small',
          dimension: 384,
          concurrentLimit: 100,
        }),
    ).toThrow(/unsupported fields/i);
  });

  it('rejects invalid input before attempting model initialization', async () => {
    const engine = new SemanticSimilarityEngine({
      modelPreset: 'multilingual-e5-small',
      modelVersion: 'quantized',
      dimension: 384,
    });

    await expect(
      engine.getEmbedding('a'.repeat(SEMANTIC_RESOURCE_LIMITS.maxTextBytes + 1)),
    ).rejects.toThrow(/UTF-8 byte limit/i);
    await expect(engine.getEmbedding('valid', { nested: {} })).rejects.toThrow(/JSON scalars/i);
    await expect(
      engine.getEmbeddingsBatch(
        Array.from({ length: SEMANTIC_RESOURCE_LIMITS.maxBatchTexts + 1 }, () => 'valid'),
      ),
    ).rejects.toThrow(/batch item limit/i);
  });

  it('requires an exact Content-Length before allocating a pinned response', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, { headers: { 'content-length': '4' } });

    await expect(readPinnedModelResponse(response, 3)).rejects.toThrow(/Content-Length/i);
    expect(cancelled).toBe(true);
  });

  it('cancels a streamed model response immediately when it exceeds the pinned size', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readPinnedModelResponse(new Response(body), 3)).rejects.toThrow(/exceeded/i);
    expect(cancelled).toBe(true);
  });

  it('accepts a streamed response that exactly matches the pinned size', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.enqueue(new Uint8Array([2, 3]));
        controller.close();
      },
    });

    const result = await readPinnedModelResponse(
      new Response(body, { headers: { 'content-length': '3' } }),
      3,
    );
    expect(Array.from(new Uint8Array(result))).toEqual([1, 2, 3]);
  });
});
