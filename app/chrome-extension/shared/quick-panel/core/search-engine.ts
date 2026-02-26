/**
 * Quick Panel Search Engine
 *
 * Aggregates results from multiple SearchProviders.
 *
 * Responsibilities:
 * - Provider registry (add/remove/list)
 * - Scope-based provider selection (including "all")
 * - Result aggregation + sorting + caps
 * - Debounced scheduling with cancellation
 * - Short-lived LRU caching to avoid repeat work
 */

import LRUCache from '@/utils/lru-cache';
import {
  normalizeQuickPanelScope,
  normalizeSearchQuery,
  type QuickPanelScope,
  type SearchProvider,
  type SearchProviderContext,
  type SearchQuery,
  type SearchResult,
} from './types';

// ============================================================
// Types
// ============================================================

export interface SearchEngineOptions {
  /** Initial providers to register */
  providers?: readonly SearchProvider[];
  /** Debounce delay in ms. Default: 120 */
  debounceMs?: number;
  /** Cache size. Default: 200 */
  cacheSize?: number;
  /** Cache TTL in ms. Default: 2000 */
  cacheTtlMs?: number;
  /** Per-provider result limit. Default: 8 */
  perProviderLimit?: number;
  /** Total result limit. Default: 20 */
  totalLimit?: number;
}

export interface SearchEngineRequest {
  scope: QuickPanelScope;
  query: string;
  limit?: number;
}

export interface SearchProviderError {
  providerId: string;
  error: string;
}

export interface SearchEngineResponse {
  /** Unique request identifier */
  requestId: number;
  /** Original request parameters */
  request: {
    scope: QuickPanelScope;
    query: SearchQuery;
    limit: number;
  };
  /** Aggregated and sorted results */
  results: SearchResult[];
  /** Errors from individual providers */
  providerErrors: SearchProviderError[];
  /** Whether the request was cancelled */
  cancelled: boolean;
  /** Whether results came from cache */
  fromCache: boolean;
  /** Time elapsed in ms */
  elapsedMs: number;
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_DEBOUNCE_MS = 120;
const DEFAULT_CACHE_SIZE = 200;
const DEFAULT_CACHE_TTL_MS = 2000;
const DEFAULT_PER_PROVIDER_LIMIT = 8;
const DEFAULT_TOTAL_LIMIT = 20;

// ============================================================
// Helpers
// ============================================================

interface CacheEntry {
  createdAt: number;
  response: SearchEngineResponse;
}

function normalizeInt(value: unknown, fallback: number): number {
  const num = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.floor(num));
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

function coerceScore(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : 0;
}

// ============================================================
// SearchEngine Class
// ============================================================

export class SearchEngine {
  private readonly providersById = new Map<string, SearchProvider>();
  private readonly cache: LRUCache<string, CacheEntry>;

  private readonly debounceMs: number;
  private readonly cacheTtlMs: number;
  private readonly perProviderLimit: number;
  private readonly totalLimit: number;

  private disposed = false;
  private seq = 0;
  private latestRequestId = 0;
  private activeAbort: AbortController | null = null;

  private scheduled: {
    requestId: number;
    request: SearchEngineRequest;
    abort: AbortController;
    timer: ReturnType<typeof setTimeout>;
    resolve: (value: SearchEngineResponse) => void;
  } | null = null;

  constructor(options: SearchEngineOptions = {}) {
    this.debounceMs = normalizeInt(options.debounceMs, DEFAULT_DEBOUNCE_MS);
    this.cacheTtlMs = normalizeInt(options.cacheTtlMs, DEFAULT_CACHE_TTL_MS);
    this.perProviderLimit = normalizeInt(options.perProviderLimit, DEFAULT_PER_PROVIDER_LIMIT);
    this.totalLimit = normalizeInt(options.totalLimit, DEFAULT_TOTAL_LIMIT);
    this.cache = new LRUCache<string, CacheEntry>(
      normalizeInt(options.cacheSize, DEFAULT_CACHE_SIZE),
    );

    // Register initial providers
    for (const provider of options.providers ?? []) {
      this.registerProvider(provider);
    }
  }

  // --------------------------------------------------------
  // Provider Management
  // --------------------------------------------------------

  /**
   * Register a search provider.
   * If a provider with the same ID exists, it will be replaced.
   */
  registerProvider(provider: SearchProvider): void {
    if (this.disposed) return;

    const id = String(provider?.id ?? '').trim();
    if (!id) return;

    // Dispose existing provider with same ID
    const existing = this.providersById.get(id);
    if (existing && existing !== provider) {
      try {
        existing.dispose?.();
      } catch {
        // Best-effort
      }
    }

    this.providersById.set(id, provider);
    // Clear cache when providers change
    this.cache.clear();
  }

  /**
   * Unregister a provider by ID.
   */
  unregisterProvider(providerId: string): void {
    if (this.disposed) return;

    const id = String(providerId ?? '').trim();
    if (!id) return;

    const existing = this.providersById.get(id);
    if (!existing) return;

    this.providersById.delete(id);
    this.cache.clear();

    try {
      existing.dispose?.();
    } catch {
      // Best-effort
    }
  }

  /**
   * List all registered providers.
   */
  listProviders(): SearchProvider[] {
    return [...this.providersById.values()];
  }

  // --------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------

  /**
   * Dispose the engine and all providers.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Cancel scheduled search
    if (this.scheduled) {
      clearTimeout(this.scheduled.timer);
      this.scheduled.abort.abort();
      this.scheduled.resolve(
        this.createCancelledResponse(this.scheduled.requestId, this.scheduled.request),
      );
      this.scheduled = null;
    }

    // Cancel active search
    if (this.activeAbort) {
      this.activeAbort.abort();
      this.activeAbort = null;
    }

    // Dispose all providers
    for (const provider of this.providersById.values()) {
      try {
        provider.dispose?.();
      } catch {
        // Best-effort
      }
    }

    this.providersById.clear();
    this.cache.clear();
  }

  /**
   * Cancel any active or scheduled search.
   */
  cancelActive(): void {
    if (this.scheduled) {
      clearTimeout(this.scheduled.timer);
      this.scheduled.abort.abort();
      this.scheduled.resolve(
        this.createCancelledResponse(this.scheduled.requestId, this.scheduled.request),
      );
      this.scheduled = null;
    }
    this.activeAbort?.abort();
  }

  // --------------------------------------------------------
  // Search Methods
  // --------------------------------------------------------

  /**
   * Schedule a search with debouncing.
   * Cancels any pending search and returns the result after the debounce delay.
   */
  schedule(request: SearchEngineRequest): Promise<SearchEngineResponse> {
    if (this.disposed) {
      return Promise.resolve(this.createCancelledResponse(0, request));
    }

    // Cancel any pending scheduled search
    if (this.scheduled) {
      clearTimeout(this.scheduled.timer);
      this.scheduled.abort.abort();
      this.scheduled.resolve(
        this.createCancelledResponse(this.scheduled.requestId, this.scheduled.request),
      );
      this.scheduled = null;
    }

    // Cancel any active search
    if (this.activeAbort) {
      this.activeAbort.abort();
      this.activeAbort = null;
    }

    const requestId = ++this.seq;
    this.latestRequestId = requestId;
    const abort = new AbortController();

    return new Promise<SearchEngineResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.scheduled = null;
        this.activeAbort = abort;

        void this.execute(requestId, request, abort.signal)
          .then(resolve)
          .catch((err) => {
            resolve(this.createEngineErrorResponse(requestId, request, abort.signal, err));
          });
      }, this.debounceMs);

      this.scheduled = { requestId, request, abort, timer, resolve };
    });
  }

  /**
   * Execute a search immediately without debouncing.
   * Cancels any pending or active search.
   */
  async search(request: SearchEngineRequest): Promise<SearchEngineResponse> {
    if (this.disposed) {
      return this.createCancelledResponse(0, request);
    }

    // Cancel scheduled search
    if (this.scheduled) {
      clearTimeout(this.scheduled.timer);
      this.scheduled.abort.abort();
      this.scheduled.resolve(
        this.createCancelledResponse(this.scheduled.requestId, this.scheduled.request),
      );
      this.scheduled = null;
    }

    // Cancel active search
    if (this.activeAbort) {
      this.activeAbort.abort();
      this.activeAbort = null;
    }

    const requestId = ++this.seq;
    this.latestRequestId = requestId;
    const abort = new AbortController();
    this.activeAbort = abort;

    try {
      return await this.execute(requestId, request, abort.signal);
    } catch (err) {
      return this.createEngineErrorResponse(requestId, request, abort.signal, err);
    }
  }

  // --------------------------------------------------------
  // Internal Methods
  // --------------------------------------------------------

  private createCancelledResponse(
    requestId: number,
    request: SearchEngineRequest,
  ): SearchEngineResponse {
    const scope = normalizeQuickPanelScope(request?.scope);
    const query = normalizeSearchQuery(request?.query ?? '');
    const limit = normalizeInt(request?.limit, this.totalLimit);

    return {
      requestId,
      request: { scope, query, limit },
      results: [],
      providerErrors: [],
      cancelled: true,
      fromCache: false,
      elapsedMs: 0,
    };
  }

  private createEngineErrorResponse(
    requestId: number,
    request: SearchEngineRequest,
    signal: AbortSignal,
    err: unknown,
  ): SearchEngineResponse {
    const scope = normalizeQuickPanelScope(request?.scope);
    const query = normalizeSearchQuery(request?.query ?? '');
    const limit = normalizeInt(request?.limit, this.totalLimit);
    const cancelled = signal.aborted || requestId !== this.latestRequestId;

    return {
      requestId,
      request: { scope, query, limit },
      results: [],
      providerErrors: [{ providerId: 'engine', error: safeErrorMessage(err) }],
      cancelled,
      fromCache: false,
      elapsedMs: 0,
    };
  }

  /**
   * Get providers that should handle the given scope.
   */
  private getProvidersForScope(scope: QuickPanelScope): SearchProvider[] {
    const providers = [...this.providersById.values()];

    if (scope === 'all') {
      // Include providers that opt into 'all' meta-scope
      return providers.filter((p) => (p.includeInAll ?? true) === true);
    }

    // Match providers that explicitly list this scope
    return providers.filter((p) => Array.isArray(p.scopes) && p.scopes.includes(scope));
  }

  /**
   * Build cache key from request parameters.
   */
  private buildCacheKey(
    scope: QuickPanelScope,
    query: SearchQuery,
    limit: number,
    providers: SearchProvider[],
  ): string {
    const providerSig = providers
      .map((p) => p.id)
      .filter(Boolean)
      .sort()
      .join(',');
    return `${scope}::${query.text}::${limit}::${providerSig}`;
  }

  /**
   * Try to get a valid cached response.
   */
  private tryGetCached(key: string, now: number): SearchEngineResponse | null {
    if (this.cacheTtlMs <= 0) return null;

    const entry = this.cache.get(key);
    if (!entry) return null;
    if (now - entry.createdAt > this.cacheTtlMs) return null;

    return entry.response;
  }

  /**
   * Store a response in the cache.
   */
  private setCached(key: string, response: SearchEngineResponse): void {
    if (this.cacheTtlMs <= 0) return;
    this.cache.set(key, { createdAt: Date.now(), response });
  }

  /**
   * Execute the search against matching providers.
   */
  private async execute(
    requestId: number,
    request: SearchEngineRequest,
    signal: AbortSignal,
  ): Promise<SearchEngineResponse> {
    const startedAt = Date.now();

    const scope = normalizeQuickPanelScope(request?.scope);
    const query = normalizeSearchQuery(request?.query ?? '');
    const limit = normalizeInt(request?.limit, this.totalLimit);

    const providers = this.getProvidersForScope(scope);
    const cacheKey = this.buildCacheKey(scope, query, limit, providers);

    // Try cache first
    const cached = this.tryGetCached(cacheKey, startedAt);
    if (cached) {
      return {
        ...cached,
        requestId,
        request: { scope, query, limit },
        cancelled: signal.aborted || requestId !== this.latestRequestId,
        fromCache: true,
        elapsedMs: Date.now() - startedAt,
      };
    }

    // Filter providers based on empty query support
    const eligibleProviders =
      query.text.length === 0 ? providers.filter((p) => p.supportsEmptyQuery === true) : providers;

    // Build priority map for tie-breaking
    const priorityById = new Map<string, number>();
    for (const p of eligibleProviders) {
      priorityById.set(p.id, typeof p.priority === 'number' ? p.priority : 0);
    }

    const providerErrors: SearchProviderError[] = [];
    const results: SearchResult[] = [];

    const perProviderCap = Math.min(limit, this.perProviderLimit);
    const now = startedAt;

    // Execute all providers in parallel
    const outcomes = await Promise.all(
      eligibleProviders.map(async (provider) => {
        if (signal.aborted) {
          return {
            provider,
            results: [] as SearchResult[],
            error: undefined as string | undefined,
          };
        }

        // Calculate provider-specific limit
        const providerMax =
          typeof provider.maxResults === 'number' && Number.isFinite(provider.maxResults)
            ? Math.max(0, Math.floor(provider.maxResults))
            : perProviderCap;
        const providerLimit = Math.min(perProviderCap, providerMax);

        const ctx: SearchProviderContext = {
          requestedScope: scope,
          query,
          limit: providerLimit,
          signal,
          now,
        };

        try {
          const providerResults = await provider.search(ctx);
          const safeList = Array.isArray(providerResults) ? providerResults : [];

          // Normalize results
          const normalized = safeList.slice(0, providerLimit).map((item, index) => {
            const id =
              typeof item?.id === 'string' && item.id ? item.id : `${provider.id}_${index}`;
            return {
              ...(item as SearchResult),
              id,
              provider: provider.id,
              score: coerceScore((item as SearchResult).score),
            };
          });

          return { provider, results: normalized, error: undefined as string | undefined };
        } catch (err) {
          return { provider, results: [] as SearchResult[], error: safeErrorMessage(err) };
        }
      }),
    );

    // Collect results and errors
    for (const out of outcomes) {
      results.push(...out.results);
      if (out.error) {
        providerErrors.push({ providerId: out.provider.id, error: out.error });
      }
    }

    // Sort by score (desc), then by priority (desc), then by title (asc)
    results.sort((a, b) => {
      const scoreDelta = coerceScore(b.score) - coerceScore(a.score);
      if (scoreDelta !== 0) return scoreDelta;

      const priA = priorityById.get(a.provider) ?? 0;
      const priB = priorityById.get(b.provider) ?? 0;
      if (priA !== priB) return priB - priA;

      return String(a.title ?? '').localeCompare(String(b.title ?? ''));
    });

    // Apply total limit
    const sliced = results.slice(0, limit);
    const cancelled = signal.aborted || requestId !== this.latestRequestId;

    // Filter out abort-related errors when cancelled to avoid UI noise
    const filteredErrors = cancelled
      ? providerErrors.filter(
          (e) =>
            !e.error.toLowerCase().includes('abort') && !e.error.toLowerCase().includes('cancel'),
        )
      : providerErrors;

    const response: SearchEngineResponse = {
      requestId,
      request: { scope, query, limit },
      results: sliced,
      providerErrors: filteredErrors,
      cancelled,
      fromCache: false,
      elapsedMs: Date.now() - startedAt,
    };

    // Cache successful non-cancelled response
    if (!cancelled) {
      this.setCached(cacheKey, response);
    }

    // Clean up active abort reference
    if (this.activeAbort?.signal === signal) {
      this.activeAbort = null;
    }

    return response;
  }
}
