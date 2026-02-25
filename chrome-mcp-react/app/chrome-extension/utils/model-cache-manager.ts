/**
 * Model Cache Manager
 */

const CACHE_NAME = 'onnx-model-cache-v1';
const CACHE_EXPIRY_DAYS = 30;
const MAX_CACHE_SIZE_MB = 500;

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

  private isMetadataUrl(url: string): boolean {
    return url.startsWith('https://cache-metadata.local/');
  }

  private async collectCacheEntries(): Promise<{
    entries: CacheEntryDetails[];
    totalSize: number;
    entryCount: number;
  }> {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    const entries: CacheEntryDetails[] = [];
    let totalSize = 0;
    let entryCount = 0;

    for (const request of keys) {
      if (this.isMetadataUrl(request.url)) continue;

      const response = await cache.match(request);
      if (response) {
        const blob = await response.blob();
        const size = blob.size;
        totalSize += size;
        entryCount++;

        const metadataResponse = await cache.match(this.getCacheMetadataKey(request.url));
        let timestamp = 0;

        if (metadataResponse) {
          try {
            const metadata: CacheMetadata = await metadataResponse.json();
            timestamp = metadata.timestamp;
          } catch (error) {
            console.warn('Failed to parse cache metadata:', error);
          }
        }

        entries.push({
          url: request.url,
          timestamp,
          size,
        });
      }
    }

    return { entries, totalSize, entryCount };
  }

  public async cleanupCacheOnDemand(newDataSize: number = 0): Promise<void> {
    const cache = await caches.open(CACHE_NAME);
    const { entries, totalSize } = await this.collectCacheEntries();
    const maxSizeBytes = MAX_CACHE_SIZE_MB * 1024 * 1024;
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
      const metadataResponse = await cache.match(this.getCacheMetadataKey(entry.url));
      let isExpired = false;

      if (metadataResponse) {
        try {
          const metadata: CacheMetadata = await metadataResponse.json();
          isExpired = this.isCacheExpired(metadata);
        } catch (error) {
          isExpired = true;
        }
      } else {
        isExpired = true;
      }

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
    const cache = await caches.open(CACHE_NAME);
    const metadata: CacheMetadata = {
      timestamp: Date.now(),
      modelUrl,
      size,
      version: CACHE_NAME,
    };

    const metadataResponse = new Response(JSON.stringify(metadata), {
      headers: { 'Content-Type': 'application/json' },
    });

    await cache.put(this.getCacheMetadataKey(modelUrl), metadataResponse);
  }

  public async getCachedModelData(modelUrl: string): Promise<ArrayBuffer | null> {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(modelUrl);

    if (!cachedResponse) {
      return null;
    }

    const metadataResponse = await cache.match(this.getCacheMetadataKey(modelUrl));
    if (metadataResponse) {
      try {
        const metadata: CacheMetadata = await metadataResponse.json();
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
    await this.cleanupCacheOnDemand(data.byteLength);

    const cache = await caches.open(CACHE_NAME);
    const response = new Response(data);

    await cache.put(modelUrl, response);
    await this.storeCacheMetadata(modelUrl, data.byteLength);

    console.log(
      `Model cached successfully (${(data.byteLength / 1024 / 1024).toFixed(2)}MB): ${modelUrl}`,
    );
  }

  public async deleteCacheEntry(modelUrl: string): Promise<void> {
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(modelUrl);
    await cache.delete(this.getCacheMetadataKey(modelUrl));
  }

  public async clearAllCache(): Promise<void> {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();

    for (const request of keys) {
      await cache.delete(request);
    }

    console.log('All model cache entries cleared');
  }

  public async getCacheStats(): Promise<CacheStats> {
    const { entries, totalSize, entryCount } = await this.collectCacheEntries();
    const cache = await caches.open(CACHE_NAME);

    const cacheEntries: CacheEntry[] = [];

    for (const entry of entries) {
      const metadataResponse = await cache.match(this.getCacheMetadataKey(entry.url));
      let expired = false;

      if (metadataResponse) {
        try {
          const metadata: CacheMetadata = await metadataResponse.json();
          expired = this.isCacheExpired(metadata);
        } catch (error) {
          expired = true;
        }
      } else {
        expired = true;
      }

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
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(modelUrl);

      if (!cachedResponse) {
        return false;
      }

      const metadataResponse = await cache.match(this.getCacheMetadataKey(modelUrl));
      if (metadataResponse) {
        try {
          const metadata: CacheMetadata = await metadataResponse.json();
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
      const keys = await cache.keys();

      for (const request of keys) {
        if (this.isMetadataUrl(request.url)) continue;

        const metadataResponse = await cache.match(this.getCacheMetadataKey(request.url));
        if (metadataResponse) {
          try {
            const metadata: CacheMetadata = await metadataResponse.json();
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
