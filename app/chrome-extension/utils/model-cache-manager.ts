/**
 * Model Cache Manager
 */

import { listPinnedModelArtifacts } from './model-assets';

const CACHE_NAME = 'onnx-model-cache-v1';
const CACHE_EXPIRY_DAYS = 30;
const MAX_CACHE_SIZE_MB = 500;
const MAX_METADATA_BYTES = 4 * 1024;
const MAX_METADATA_CHUNKS = 64;

interface PinnedCacheEntry {
  url: string;
  size: number;
}

const PINNED_CACHE_ENTRIES: PinnedCacheEntry[] = [];
const PINNED_CACHE_ENTRY_BY_URL = new Map<string, PinnedCacheEntry>();
for (const artifact of listPinnedModelArtifacts()) {
  for (const url of [artifact.url, artifact.legacyCacheUrl]) {
    const entry = { url, size: artifact.size };
    PINNED_CACHE_ENTRIES.push(entry);
    PINNED_CACHE_ENTRY_BY_URL.set(url, entry);
  }
}

export interface CacheMetadata {
  timestamp: number;
  modelUrl: string;
  size: number;
  version: string;
}

export interface CacheEntry {
  url: string;
  size: number;
  sizeMB: number;
  timestamp: number;
  age: string;
  expired: boolean;
}

export interface CacheStats {
  totalSize: number;
  totalSizeMB: number;
  entryCount: number;
  entries: CacheEntry[];
}

interface CacheEntryDetails {
  url: string;
  timestamp: number;
  size: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function readBoundedMetadataText(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes =
      contentLength.length <= 16 && /^\d+$/.test(contentLength)
        ? Number(contentLength)
        : Number.NaN;
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_METADATA_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Model cache metadata exceeds the byte limit');
    }
  }
  if (!response.body) throw new Error('Model cache metadata body is unavailable');

  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_METADATA_BYTES);
  let byteCount = 0;
  let chunkCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount += 1;
      if (chunkCount > MAX_METADATA_CHUNKS) {
        await reader.cancel('Model cache metadata exceeded the chunk limit').catch(() => undefined);
        throw new Error('Model cache metadata exceeds the chunk limit');
      }
      if (
        !value ||
        !Number.isSafeInteger(value.byteLength) ||
        value.byteLength > MAX_METADATA_BYTES - byteCount
      ) {
        await reader.cancel('Model cache metadata exceeded the byte limit').catch(() => undefined);
        throw new Error('Model cache metadata exceeds the byte limit');
      }
      bytes.set(value, byteCount);
      byteCount += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, byteCount));
}

async function readCacheMetadata(
  response: Response,
  expectedEntry: PinnedCacheEntry,
): Promise<CacheMetadata> {
  const parsed: unknown = JSON.parse(await readBoundedMetadataText(response));
  if (!isPlainRecord(parsed)) throw new Error('Model cache metadata must be an object');
  if (
    typeof parsed.timestamp !== 'number' ||
    !Number.isSafeInteger(parsed.timestamp) ||
    parsed.timestamp < 0 ||
    parsed.timestamp > Date.now() + 86_400_000 ||
    parsed.modelUrl !== expectedEntry.url ||
    parsed.size !== expectedEntry.size ||
    parsed.version !== CACHE_NAME
  ) {
    throw new Error('Model cache metadata is invalid');
  }
  return {
    timestamp: parsed.timestamp,
    modelUrl: expectedEntry.url,
    size: expectedEntry.size,
    version: CACHE_NAME,
  };
}

export class ModelCacheManager {
  private static instance: ModelCacheManager | null = null;

  public static getInstance(): ModelCacheManager {
    if (!ModelCacheManager.instance) {
      ModelCacheManager.instance = new ModelCacheManager();
    }
    return ModelCacheManager.instance;
  }

  private constructor() {}

  private getCacheMetadataKey(modelUrl: string): string {
    const encodedUrl = encodeURIComponent(modelUrl);
    return `https://cache-metadata.local/${encodedUrl}`;
  }

  private isCacheExpired(metadata: CacheMetadata): boolean {
    const now = Date.now();
    const expiryTime = metadata.timestamp + CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
    return now > expiryTime;
  }

  private getPinnedEntry(modelUrl: string): PinnedCacheEntry | null {
    return PINNED_CACHE_ENTRY_BY_URL.get(modelUrl) ?? null;
  }

  private async collectCacheEntries(): Promise<{
    entries: CacheEntryDetails[];
    totalSize: number;
    entryCount: number;
  }> {
    const cache = await caches.open(CACHE_NAME);
    const entries: CacheEntryDetails[] = [];
    let totalSize = 0;
    let entryCount = 0;

    for (const pinnedEntry of PINNED_CACHE_ENTRIES) {
      const response = await cache.match(pinnedEntry.url);
      if (response) {
        const size = pinnedEntry.size;
        totalSize += size;
        entryCount++;

        const metadataResponse = await cache.match(this.getCacheMetadataKey(pinnedEntry.url));
        let timestamp = 0;

        if (metadataResponse) {
          try {
            const metadata = await readCacheMetadata(metadataResponse, pinnedEntry);
            timestamp = metadata.timestamp;
          } catch (error) {
            console.warn('Failed to parse cache metadata:', error);
          }
        }

        entries.push({
          url: pinnedEntry.url,
          timestamp,
          size,
        });
      }
    }

    return { entries, totalSize, entryCount };
  }

  public async cleanupCacheOnDemand(newDataSize: number = 0): Promise<void> {
    const maxSizeBytes = MAX_CACHE_SIZE_MB * 1024 * 1024;
    if (
      !Number.isSafeInteger(newDataSize) ||
      newDataSize < 0 ||
      newDataSize > maxSizeBytes
    ) {
      throw new Error('New model cache data exceeds the cache size policy');
    }
    const cache = await caches.open(CACHE_NAME);
    const { entries, totalSize } = await this.collectCacheEntries();
    const projectedSize = totalSize + newDataSize;

    if (projectedSize <= maxSizeBytes) {
      return;
    }

    console.log(
      `Cache size (${(totalSize / 1024 / 1024).toFixed(2)}MB) + new data (${(newDataSize / 1024 / 1024).toFixed(2)}MB) exceeds limit (${MAX_CACHE_SIZE_MB}MB), cleaning up...`,
    );

    const expiredEntries: CacheEntryDetails[] = [];
    const validEntries: CacheEntryDetails[] = [];

    for (const entry of entries) {
      const isExpired =
        entry.timestamp <= 0 ||
        this.isCacheExpired({
          timestamp: entry.timestamp,
          modelUrl: entry.url,
          size: entry.size,
          version: CACHE_NAME,
        });

      if (isExpired) {
        expiredEntries.push(entry);
      } else {
        validEntries.push(entry);
      }
    }

    let currentSize = totalSize;
    for (const entry of expiredEntries) {
      await cache.delete(entry.url);
      await cache.delete(this.getCacheMetadataKey(entry.url));
      currentSize -= entry.size;
      console.log(
        `Cleaned up expired cache entry: ${entry.url} (${(entry.size / 1024 / 1024).toFixed(2)}MB)`,
      );
    }

    if (currentSize + newDataSize > maxSizeBytes) {
      validEntries.sort((a, b) => a.timestamp - b.timestamp);

      for (const entry of validEntries) {
        if (currentSize + newDataSize <= maxSizeBytes) break;

        await cache.delete(entry.url);
        await cache.delete(this.getCacheMetadataKey(entry.url));
        currentSize -= entry.size;
        console.log(
          `Cleaned up old cache entry: ${entry.url} (${(entry.size / 1024 / 1024).toFixed(2)}MB)`,
        );
      }
    }

    console.log(`Cache cleanup complete. New size: ${(currentSize / 1024 / 1024).toFixed(2)}MB`);
  }

  public async storeCacheMetadata(modelUrl: string, size: number): Promise<void> {
    const pinnedEntry = this.getPinnedEntry(modelUrl);
    if (!pinnedEntry || size !== pinnedEntry.size) {
      throw new Error('Cannot store metadata for an unpinned model cache entry');
    }
    const cache = await caches.open(CACHE_NAME);
    const metadata: CacheMetadata = {
      timestamp: Date.now(),
      modelUrl,
      size,
      version: CACHE_NAME,
    };

    const serializedMetadata = JSON.stringify(metadata);
    const metadataResponse = new Response(serializedMetadata, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(serializedMetadata.length),
      },
    });

    await cache.put(this.getCacheMetadataKey(modelUrl), metadataResponse);
  }

  public async getCachedModelData(modelUrl: string): Promise<ArrayBuffer | null> {
    const pinnedEntry = this.getPinnedEntry(modelUrl);
    if (!pinnedEntry) return null;
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(modelUrl);

    if (!cachedResponse) {
      return null;
    }

    const metadataResponse = await cache.match(this.getCacheMetadataKey(modelUrl));
    if (metadataResponse) {
      try {
        const metadata = await readCacheMetadata(metadataResponse, pinnedEntry);
        if (!this.isCacheExpired(metadata)) {
          console.log('Model found in cache and not expired. Loading from cache.');
          return cachedResponse.arrayBuffer();
        } else {
          console.log('Cached model is expired, removing...');
          await this.deleteCacheEntry(modelUrl);
          return null;
        }
      } catch (error) {
        console.warn('Failed to parse cache metadata, treating as expired:', error);
        await this.deleteCacheEntry(modelUrl);
        return null;
      }
    } else {
      console.log('Cached model has no metadata, treating as expired...');
      await this.deleteCacheEntry(modelUrl);
      return null;
    }
  }

  public async storeModelData(modelUrl: string, data: ArrayBuffer): Promise<void> {
    const pinnedEntry = this.getPinnedEntry(modelUrl);
    if (!pinnedEntry || data.byteLength !== pinnedEntry.size) {
      throw new Error('Cannot cache an unpinned or incorrectly sized model artifact');
    }
    await this.cleanupCacheOnDemand(data.byteLength);

    const cache = await caches.open(CACHE_NAME);
    const response = new Response(data, {
      headers: { 'Content-Length': String(data.byteLength) },
    });

    await cache.put(modelUrl, response);
    await this.storeCacheMetadata(modelUrl, data.byteLength);

    console.log(
      `Model cached successfully (${(data.byteLength / 1024 / 1024).toFixed(2)}MB): ${modelUrl}`,
    );
  }

  public async deleteCacheEntry(modelUrl: string): Promise<void> {
    if (!this.getPinnedEntry(modelUrl)) return;
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(modelUrl);
    await cache.delete(this.getCacheMetadataKey(modelUrl));
  }

  public async clearAllCache(): Promise<void> {
    await caches.delete(CACHE_NAME);

    console.log('All model cache entries cleared');
  }

  public async getCacheStats(): Promise<CacheStats> {
    const { entries, totalSize, entryCount } = await this.collectCacheEntries();
    const cacheEntries: CacheEntry[] = [];

    for (const entry of entries) {
      const expired =
        entry.timestamp <= 0 ||
        this.isCacheExpired({
          timestamp: entry.timestamp,
          modelUrl: entry.url,
          size: entry.size,
          version: CACHE_NAME,
        });

      const age =
        entry.timestamp > 0
          ? `${Math.round((Date.now() - entry.timestamp) / (1000 * 60 * 60 * 24))} days`
          : 'unknown';

      cacheEntries.push({
        url: entry.url,
        size: entry.size,
        sizeMB: Number((entry.size / 1024 / 1024).toFixed(2)),
        timestamp: entry.timestamp,
        age,
        expired,
      });
    }

    return {
      totalSize,
      totalSizeMB: Number((totalSize / 1024 / 1024).toFixed(2)),
      entryCount,
      entries: cacheEntries.sort((a, b) => b.timestamp - a.timestamp),
    };
  }

  public async manualCleanup(): Promise<void> {
    await this.cleanupCacheOnDemand(0);
    console.log('Manual cache cleanup completed');
  }

  /**
   * Check if a specific model is cached and not expired
   * @param modelUrl The model URL to check
   * @returns Promise<boolean> True if model is cached and valid
   */
  public async isModelCached(modelUrl: string): Promise<boolean> {
    try {
      const pinnedEntry = this.getPinnedEntry(modelUrl);
      if (!pinnedEntry) return false;
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(modelUrl);

      if (!cachedResponse) {
        return false;
      }

      const metadataResponse = await cache.match(this.getCacheMetadataKey(modelUrl));
      if (metadataResponse) {
        try {
          const metadata = await readCacheMetadata(metadataResponse, pinnedEntry);
          return !this.isCacheExpired(metadata);
        } catch (error) {
          console.warn('Failed to parse cache metadata for cache check:', error);
          return false;
        }
      } else {
        // No metadata means expired
        return false;
      }
    } catch (error) {
      console.error('Error checking model cache:', error);
      return false;
    }
  }

  /**
   * Check if any valid (non-expired) model cache exists
   * @returns Promise<boolean> True if at least one valid model cache exists
   */
  public async hasAnyValidCache(): Promise<boolean> {
    try {
      const cache = await caches.open(CACHE_NAME);
      for (const pinnedEntry of PINNED_CACHE_ENTRIES) {
        const cachedResponse = await cache.match(pinnedEntry.url);
        if (!cachedResponse) continue;
        const metadataResponse = await cache.match(this.getCacheMetadataKey(pinnedEntry.url));
        if (metadataResponse) {
          try {
            const metadata = await readCacheMetadata(metadataResponse, pinnedEntry);
            if (!this.isCacheExpired(metadata)) {
              return true; // Found at least one valid cache
            }
          } catch (error) {
            // Skip invalid metadata
            continue;
          }
        }
      }

      return false;
    } catch (error) {
      console.error('Error checking for valid cache:', error);
      return false;
    }
  }
}
