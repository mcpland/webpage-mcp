/**
 * Vectorized tab content search tool
 * Uses vector database for efficient semantic search
 */

import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { ContentIndexer } from '@/utils/content-indexer';
import { LIMITS, ERROR_MESSAGES } from '@/common/constants';
import type { SearchResult } from '@/utils/vector-database';
import { hasDisallowedPublicUrlScheme } from './common';
import {
  measureUtf8Bytes,
  truncateJsonString,
} from './bounded-tool-output';

export const VECTOR_SEARCH_MAX_QUERY_UTF8_BYTES = 4 * 1024;
export const VECTOR_SEARCH_MAX_CONCURRENCY = 2;
export const VECTOR_SEARCH_MAX_OUTPUT_UTF8_BYTES = 512 * 1024;
export const VECTOR_REBUILD_MAX_TAB_SCAN = 1_000;
export const VECTOR_REBUILD_MAX_TABS = 100;
export const VECTOR_REBUILD_MAX_CONCURRENCY = 4;
const VECTOR_SEARCH_INTERNAL_RESULTS = 50;
const VECTOR_SEARCH_RETURNED_TABS = 10;
const VECTOR_SEARCH_MAX_URL_JSON_BYTES = 8 * 1024;
const VECTOR_SEARCH_MAX_TITLE_JSON_BYTES = 4 * 1024;
const VECTOR_SEARCH_MAX_SNIPPET_JSON_BYTES = 8 * 1024;
const VECTOR_SEARCH_MAX_SOURCE_JSON_BYTES = 512;
const VECTOR_SEARCH_MAX_ERROR_JSON_BYTES = 1024;

interface VectorSearchResult {
  tabId: number;
  url: string;
  title: string;
  semanticScore: number;
  matchedSnippet: string;
  chunkSource: string;
  timestamp: number;
}

/**
 * Tool for vectorized search of tab content using semantic similarity
 */
export class VectorSearchTabsContentTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SEARCH_TABS_CONTENT;
  private contentIndexer: ContentIndexer;
  private isInitialized = false;
  private activeSearches = 0;
  private readonly searchIdleWaiters = new Set<() => void>();
  private explicitIndexPromise: Promise<void> | null = null;
  private rebuildPromise: Promise<void> | null = null;

  constructor(contentIndexer?: ContentIndexer) {
    super();
    this.contentIndexer =
      contentIndexer ??
      new ContentIndexer({
        autoIndex: false,
        maxChunksPerPage: LIMITS.MAX_SEARCH_RESULTS,
        skipDuplicates: true,
      });
  }

  private async initializeIndexer(): Promise<void> {
    try {
      await this.contentIndexer.initialize();
      this.isInitialized = true;
      console.log('VectorSearchTabsContentTool: Content indexer initialized successfully');
    } catch (error) {
      console.error('VectorSearchTabsContentTool: Failed to initialize content indexer:', error);
      this.isInitialized = false;
    }
  }

  async execute(args: { query: string }): Promise<ToolResult> {
    let searchAcquired = false;
    try {
      const rawQuery = typeof args?.query === 'string' ? args.query : '';
      if (
        measureUtf8Bytes(rawQuery, VECTOR_SEARCH_MAX_QUERY_UTF8_BYTES) >
        VECTOR_SEARCH_MAX_QUERY_UTF8_BYTES
      ) {
        return createErrorResponse(
          `Vector search query exceeds the ${VECTOR_SEARCH_MAX_QUERY_UTF8_BYTES}-byte limit.`,
        );
      }
      const query = rawQuery.trim();
      if (!query) {
        return createErrorResponse(
          ERROR_MESSAGES.INVALID_PARAMETERS + ': Query parameter is required and cannot be empty',
        );
      }
      if (this.rebuildPromise) {
        return createErrorResponse('Vector index rebuild is in progress. Please retry shortly.');
      }
      if (this.activeSearches >= VECTOR_SEARCH_MAX_CONCURRENCY) {
        return createErrorResponse(
          `Vector search concurrency limit reached (${VECTOR_SEARCH_MAX_CONCURRENCY}).`,
        );
      }
      this.activeSearches += 1;
      searchAcquired = true;

      console.log('VectorSearchTabsContentTool: Starting vector search');

      // Check semantic engine status
      if (!this.contentIndexer.isSemanticEngineReady()) {
        if (this.contentIndexer.isSemanticEngineInitializing()) {
          return createErrorResponse(
            'Vector search engine is still initializing (model downloading). Please wait a moment and try again.',
          );
        } else {
          // Try to initialize
          console.log('VectorSearchTabsContentTool: Initializing content indexer...');
          await this.initializeIndexer();

          // Check semantic engine status again
          if (!this.contentIndexer.isSemanticEngineReady()) {
            return createErrorResponse('Failed to initialize vector search engine');
          }
        }
      }

      // Page text is collected only as a direct consequence of this explicit
      // tool invocation. Concurrent searches share the same bounded indexing
      // pass, and ContentIndexer skips pages already indexed in this session.
      await this.indexCurrentTabsForSearch();

      // Execute vector search, get more results for deduplication
      const searchResults = await this.contentIndexer.searchContent(
        query,
        VECTOR_SEARCH_INTERNAL_RESULTS,
      );

      // Convert search results format
      const vectorSearchResults = this.convertSearchResults(searchResults);

      // Deduplicate by tab, keep only the highest similarity fragment per tab
      const deduplicatedResults = this.deduplicateByTab(vectorSearchResults);

      // Sort by similarity and get top 10 results
      const topResults = deduplicatedResults
        .sort((a, b) => b.semanticScore - a.semanticScore)
        .slice(0, VECTOR_SEARCH_RETURNED_TABS);

      // Get index statistics
      const stats = this.contentIndexer.getStats();

      const result = {
        success: true,
        totalTabsSearched: this.safeCount(stats.totalTabs),
        matchedTabsCount: topResults.length,
        vectorSearchEnabled: true,
        truncated:
          searchResults.length > VECTOR_SEARCH_INTERNAL_RESULTS ||
          deduplicatedResults.length > VECTOR_SEARCH_RETURNED_TABS,
        indexStats: {
          totalDocuments: this.safeCount(stats.totalDocuments),
          totalTabs: this.safeCount(stats.totalTabs),
          indexedPages: this.safeCount(stats.indexedPages),
          semanticEngineReady: stats.semanticEngineReady === true,
          semanticEngineInitializing: stats.semanticEngineInitializing === true,
        },
        matchedTabs: topResults.map((result) => ({
          tabId: result.tabId,
          url: result.url,
          title: result.title,
          semanticScore: result.semanticScore,
          matchedSnippets: [result.matchedSnippet],
          chunkSource: result.chunkSource,
          timestamp: result.timestamp,
        })),
      };

      console.log(
        `VectorSearchTabsContentTool: Found ${topResults.length} results with vector search`,
      );

      let serialized = JSON.stringify(result);
      while (
        measureUtf8Bytes(serialized, VECTOR_SEARCH_MAX_OUTPUT_UTF8_BYTES) >
          VECTOR_SEARCH_MAX_OUTPUT_UTF8_BYTES &&
        result.matchedTabs.length > 0
      ) {
        result.matchedTabs.pop();
        result.matchedTabsCount = result.matchedTabs.length;
        result.truncated = true;
        serialized = JSON.stringify(result);
      }

      return {
        content: [
          {
            type: 'text',
            text: serialized,
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('VectorSearchTabsContentTool: Search failed:', error);
      const message = truncateJsonString(
        error instanceof Error ? error.message : String(error),
        VECTOR_SEARCH_MAX_ERROR_JSON_BYTES,
      );
      return createErrorResponse(
        `Vector search failed: ${message || 'Unknown error'}`,
      );
    } finally {
      if (searchAcquired) this.releaseSearch();
    }
  }

  private safeCount(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.floor(value))
      : 0;
  }

  private releaseSearch(): void {
    this.activeSearches = Math.max(0, this.activeSearches - 1);
    if (this.activeSearches !== 0) return;
    for (const resolve of this.searchIdleWaiters) resolve();
    this.searchIdleWaiters.clear();
  }

  private async waitForSearchesIdle(): Promise<void> {
    if (this.activeSearches === 0) return;
    await new Promise<void>((resolve) => this.searchIdleWaiters.add(resolve));
  }

  /**
   * Ensure all tabs are indexed
   */
  private async ensureTabsIndexed(tabIds: number[]): Promise<void> {
    let nextIndex = 0;
    const workerCount = Math.min(
      VECTOR_REBUILD_MAX_CONCURRENCY,
      tabIds.length,
    );
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < tabIds.length) {
        const tabId = tabIds[nextIndex++];
        try {
          await this.contentIndexer.indexTabContent(tabId);
        } catch (error) {
          console.warn(`VectorSearchTabsContentTool: Failed to index tab ${tabId}:`, error);
        }
      }
    });

    await Promise.allSettled(workers);
  }

  private selectIndexableTabIds(tabs: chrome.tabs.Tab[]): {
    tabIds: number[];
    scannedTabs: number;
  } {
    const tabIds: number[] = [];
    const seenTabIds = new Set<number>();
    const scanLimit = Math.min(tabs.length, VECTOR_REBUILD_MAX_TAB_SCAN);
    let scannedTabs = 0;

    for (let index = 0; index < scanLimit && tabIds.length < VECTOR_REBUILD_MAX_TABS; index += 1) {
      const tab = tabs[index];
      scannedTabs += 1;
      if (
        typeof tab.id !== 'number' ||
        !Number.isSafeInteger(tab.id) ||
        tab.id < 0 ||
        seenTabIds.has(tab.id)
      ) {
        continue;
      }
      seenTabIds.add(tab.id);

      const boundedUrl = truncateJsonString(tab.url, VECTOR_SEARCH_MAX_URL_JSON_BYTES);
      if (
        !boundedUrl ||
        !/^https?:\/\//i.test(boundedUrl) ||
        hasDisallowedPublicUrlScheme(boundedUrl)
      ) {
        continue;
      }
      tabIds.push(tab.id);
    }

    return { tabIds, scannedTabs };
  }

  private indexCurrentTabsForSearch(): Promise<void> {
    if (this.explicitIndexPromise) return this.explicitIndexPromise;

    const operation = this.performExplicitIndexPass();
    const tracked = operation.finally(() => {
      if (this.explicitIndexPromise === tracked) this.explicitIndexPromise = null;
    });
    this.explicitIndexPromise = tracked;
    return tracked;
  }

  private async performExplicitIndexPass(): Promise<void> {
    const tabs = await chrome.tabs.query({});
    const { tabIds, scannedTabs } = this.selectIndexableTabIds(tabs);
    await this.ensureTabsIndexed(tabIds);

    console.log(
      `VectorSearchTabsContentTool: Explicitly indexed ${tabIds.length} tabs ` +
        `(scanned ${scannedTabs}, limits ${VECTOR_REBUILD_MAX_TABS}/${VECTOR_REBUILD_MAX_TAB_SCAN})`,
    );
  }

  /**
   * Convert search results format
   */
  private convertSearchResults(searchResults: SearchResult[]): VectorSearchResult[] {
    const results: VectorSearchResult[] = [];
    const limit = Math.min(searchResults.length, VECTOR_SEARCH_INTERNAL_RESULTS);
    for (let index = 0; index < limit; index += 1) {
      const result = searchResults[index];
      const boundedUrl = truncateJsonString(
        result.document.url,
        VECTOR_SEARCH_MAX_URL_JSON_BYTES,
      );
      if (!boundedUrl || hasDisallowedPublicUrlScheme(boundedUrl)) continue;
      results.push({
        tabId: this.safeCount(result.document.tabId),
        url: boundedUrl,
        title: truncateJsonString(
          result.document.title,
          VECTOR_SEARCH_MAX_TITLE_JSON_BYTES,
        ),
        semanticScore:
          typeof result.similarity === 'number' && Number.isFinite(result.similarity)
            ? result.similarity
            : 0,
        matchedSnippet: this.extractSnippet(result.document.chunk.text),
        chunkSource: truncateJsonString(
          result.document.chunk.source,
          VECTOR_SEARCH_MAX_SOURCE_JSON_BYTES,
        ),
        timestamp:
          typeof result.document.timestamp === 'number' &&
          Number.isFinite(result.document.timestamp)
            ? result.document.timestamp
            : 0,
      });
    }
    return results;
  }

  /**
   * Deduplicate by tab, keep only the highest similarity fragment per tab
   */
  private deduplicateByTab(results: VectorSearchResult[]): VectorSearchResult[] {
    const tabMap = new Map<number, VectorSearchResult>();

    for (const result of results) {
      const existingResult = tabMap.get(result.tabId);

      // If this tab has no result yet, or current result has higher similarity, update it
      if (!existingResult || result.semanticScore > existingResult.semanticScore) {
        tabMap.set(result.tabId, result);
      }
    }

    return Array.from(tabMap.values());
  }

  /**
   * Extract text snippet for display
   */
  private extractSnippet(text: string, maxLength: number = 200): string {
    const boundedText = truncateJsonString(
      text,
      VECTOR_SEARCH_MAX_SNIPPET_JSON_BYTES,
    );
    if (boundedText.length <= maxLength) {
      return boundedText;
    }

    // Try to truncate at sentence boundary
    const truncated = boundedText.substring(0, maxLength);
    const lastSentenceEnd = Math.max(
      truncated.lastIndexOf('.'),
      truncated.lastIndexOf('!'),
      truncated.lastIndexOf('?'),
      truncated.lastIndexOf('\u3002'),
      truncated.lastIndexOf('\uFF01'),
      truncated.lastIndexOf('\uFF1F'),
    );

    if (lastSentenceEnd > maxLength * 0.7) {
      return truncated.substring(0, lastSentenceEnd + 1);
    }

    // If no suitable sentence boundary found, truncate at word boundary
    const lastSpaceIndex = truncated.lastIndexOf(' ');
    if (lastSpaceIndex > maxLength * 0.8) {
      return truncated.substring(0, lastSpaceIndex) + '...';
    }

    return truncated + '...';
  }

  /**
   * Get index statistics
   */
  public async getIndexStats() {
    if (!this.isInitialized) {
      // Don't automatically initialize - just return basic stats
      return {
        totalDocuments: 0,
        totalTabs: 0,
        indexSize: 0,
        indexedPages: 0,
        isInitialized: false,
        semanticEngineReady: false,
        semanticEngineInitializing: false,
      };
    }
    return this.contentIndexer.getStats();
  }

  /**
   * Manually rebuild index
   */
  public rebuildIndex(): Promise<void> {
    if (this.rebuildPromise) return this.rebuildPromise;
    const operation = this.performRebuildIndex();
    const tracked = operation.finally(() => {
      if (this.rebuildPromise === tracked) this.rebuildPromise = null;
    });
    this.rebuildPromise = tracked;
    return tracked;
  }

  private async performRebuildIndex(): Promise<void> {
    await this.waitForSearchesIdle();
    if (!this.isInitialized) {
      await this.initializeIndexer();
    }

    try {
      // Clear existing indexes
      await this.contentIndexer.clearAllIndexes();

      const tabs = await chrome.tabs.query({});
      const { tabIds: validTabIds, scannedTabs } = this.selectIndexableTabIds(tabs);

      await this.ensureTabsIndexed(validTabIds);

      console.log(
        `VectorSearchTabsContentTool: Rebuilt index for ${validTabIds.length} tabs ` +
          `(scanned ${scannedTabs}, limits ${VECTOR_REBUILD_MAX_TABS}/${VECTOR_REBUILD_MAX_TAB_SCAN})`,
      );
    } catch (error) {
      console.error('VectorSearchTabsContentTool: Failed to rebuild index:', error);
      throw error;
    }
  }

  /**
   * Manually index specified tab
   */
  public async indexTab(tabId: number): Promise<void> {
    if (!this.isInitialized) {
      await this.initializeIndexer();
    }

    await this.contentIndexer.indexTabContent(tabId);
  }

  /**
   * Remove index for specified tab
   */
  public async removeTabIndex(tabId: number): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    await this.contentIndexer.removeTabIndex(tabId);
  }
}

// Export tool instance
export const vectorSearchTabsContentTool = new VectorSearchTabsContentTool();
