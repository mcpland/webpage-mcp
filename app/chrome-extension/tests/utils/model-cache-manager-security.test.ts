import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listPinnedModelArtifacts } from '@/utils/model-assets';

const CACHE_NAME = 'onnx-model-cache-v1';

function cacheKey(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

class FakeCache {
  readonly entries = new Map<string, Response>();
  readonly keys = vi.fn(async () => {
    throw new Error('cache.keys must not be used');
  });
  readonly match = vi.fn(async (input: RequestInfo | URL) => {
    return this.entries.get(cacheKey(input));
  });
  readonly put = vi.fn(async (input: RequestInfo | URL, response: Response) => {
    this.entries.set(cacheKey(input), response);
  });
  readonly delete = vi.fn(async (input: RequestInfo | URL) => {
    return this.entries.delete(cacheKey(input));
  });

  seed(key: string, response: Response): void {
    this.entries.set(key, response);
  }
}

function metadataKey(modelUrl: string): string {
  return `https://cache-metadata.local/${encodeURIComponent(modelUrl)}`;
}

function validMetadata(modelUrl: string, size: number): Response {
  const body = JSON.stringify({
    timestamp: Date.now(),
    modelUrl,
    size,
    version: CACHE_NAME,
  });
  return new Response(body, {
    headers: { 'Content-Length': String(body.length), 'Content-Type': 'application/json' },
  });
}

describe('ModelCacheManager corruption boundaries', () => {
  let cache: FakeCache;
  let cacheStorageDelete: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    cache = new FakeCache();
    cacheStorageDelete = vi.fn(async () => {
      cache.entries.clear();
      return true;
    });
    vi.stubGlobal('caches', {
      open: vi.fn(async () => cache),
      delete: cacheStorageDelete,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('derives a fixed inventory from the two pinned models under the 500 MiB policy', () => {
    const artifacts = listPinnedModelArtifacts();
    expect(artifacts).toHaveLength(2);
    expect(artifacts.reduce((total, artifact) => total + artifact.size, 0)).toBeLessThan(
      500 * 1024 * 1024,
    );
  });

  it('collects stats from only the fixed pinned URL inventory without keys or blobs', async () => {
    const artifact = listPinnedModelArtifacts()[0];
    cache.seed(artifact.url, new Response('corrupt body intentionally not materialized'));
    cache.seed(metadataKey(artifact.url), validMetadata(artifact.url, artifact.size));
    cache.seed('https://attacker.invalid/unbounded-entry', new Response('ignored'));
    const blobSpy = vi.spyOn(Response.prototype, 'blob');

    const { ModelCacheManager } = await import('@/utils/model-cache-manager');
    const stats = await ModelCacheManager.getInstance().getCacheStats();

    expect(stats).toMatchObject({
      entryCount: 1,
      totalSize: artifact.size,
      entries: [{ url: artifact.url, size: artifact.size, expired: false }],
    });
    expect(cache.keys).not.toHaveBeenCalled();
    expect(blobSpy).not.toHaveBeenCalled();
    expect(cache.match.mock.calls.flat().map(cacheKey)).not.toContain(
      'https://attacker.invalid/unbounded-entry',
    );
  });

  it('rejects oversized metadata before JSON parsing and removes the corrupt pair on load', async () => {
    const artifact = listPinnedModelArtifacts()[0];
    cache.seed(artifact.url, new Response('cached model'));
    cache.seed(
      metadataKey(artifact.url),
      new Response('x'.repeat(5_000), { headers: { 'Content-Length': '5000' } }),
    );

    const { ModelCacheManager } = await import('@/utils/model-cache-manager');
    const manager = ModelCacheManager.getInstance();
    await expect(manager.getCachedModelData(artifact.url)).resolves.toBeNull();
    expect(cache.entries.has(artifact.url)).toBe(false);
    expect(cache.entries.has(metadataKey(artifact.url))).toBe(false);
  });

  it('requires metadata to match the pinned URL and exact artifact size', async () => {
    const artifact = listPinnedModelArtifacts()[0];
    cache.seed(artifact.url, new Response('cached model'));
    cache.seed(metadataKey(artifact.url), validMetadata(artifact.url, artifact.size + 1));

    const { ModelCacheManager } = await import('@/utils/model-cache-manager');
    await expect(ModelCacheManager.getInstance().isModelCached(artifact.url)).resolves.toBe(false);
  });

  it('rejects unpinned and incorrectly sized writes before opening the cache', async () => {
    const artifact = listPinnedModelArtifacts()[0];
    const { ModelCacheManager } = await import('@/utils/model-cache-manager');
    const manager = ModelCacheManager.getInstance();

    await expect(
      manager.storeModelData('https://attacker.invalid/model.onnx', new ArrayBuffer(1)),
    ).rejects.toThrow(/unpinned/i);
    await expect(manager.storeModelData(artifact.url, new ArrayBuffer(1))).rejects.toThrow(
      /incorrectly sized/i,
    );
    expect(caches.open).not.toHaveBeenCalled();
  });

  it('clears a corrupt cache atomically without enumerating its entries', async () => {
    cache.seed('https://attacker.invalid/entry', new Response('ignored'));
    const { ModelCacheManager } = await import('@/utils/model-cache-manager');

    await ModelCacheManager.getInstance().clearAllCache();

    expect(cacheStorageDelete).toHaveBeenCalledWith(CACHE_NAME);
    expect(cache.keys).not.toHaveBeenCalled();
    expect(cache.entries.size).toBe(0);
  });
});
