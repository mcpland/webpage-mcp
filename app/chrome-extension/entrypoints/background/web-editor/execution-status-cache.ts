export interface ExecutionStatusEntry {
  status: string;
  message?: string;
  updatedAt: number;
  result?: { success: boolean; summary?: string; error?: string };
}

export const WEB_EDITOR_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
export const WEB_EDITOR_STATUS_CACHE_MAX_ENTRIES = 100;

interface ExecutionStatusCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

/** Bounded write-ordered cache for Web Editor Agent execution status. */
export class ExecutionStatusCache {
  private readonly entries = new Map<string, ExecutionStatusEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: ExecutionStatusCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? WEB_EDITOR_STATUS_CACHE_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? WEB_EDITOR_STATUS_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive safe integer");
    }
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError("ttlMs must be positive");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  set(
    requestId: string,
    status: string,
    message?: string,
    result?: ExecutionStatusEntry["result"],
  ): void {
    const now = this.now();
    this.pruneExpired(now);
    // Updating an entry also refreshes its eviction position.
    this.entries.delete(requestId);
    this.entries.set(requestId, { status, message, result, updatedAt: now });
    while (this.entries.size > this.maxEntries) {
      const oldestRequestId = this.entries.keys().next().value as
        | string
        | undefined;
      if (!oldestRequestId) break;
      this.entries.delete(oldestRequestId);
    }
  }

  get(requestId: string): ExecutionStatusEntry | undefined {
    const entry = this.entries.get(requestId);
    if (entry && this.now() - entry.updatedAt > this.ttlMs) {
      this.entries.delete(requestId);
      return undefined;
    }
    return entry;
  }

  delete(requestId: string): boolean {
    return this.entries.delete(requestId);
  }

  pruneExpired(now = this.now()): void {
    for (const [requestId, entry] of this.entries) {
      if (now - entry.updatedAt > this.ttlMs) this.entries.delete(requestId);
    }
  }
}
