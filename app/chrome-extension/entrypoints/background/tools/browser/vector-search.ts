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
class VectorSearchTabsContentTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SEARCH_TABS_CONTENT;
  private contentIndexer: ContentIndexer;
  private isInitialized = false;

  constructor() {
    super();
    this.contentIndexer = new ContentIndexer({
      autoIndex: true,
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
    try {
      const { query } = args;

      if (!query || query.trim().length === 0) {
        return createErrorResponse(
          ERROR_MESSAGES.INVALID_PARAMETERS + ': Query parameter is required and cannot be empty',
        );
      }

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

      // Execute vector search, get more results for deduplication
      const searchResults = await this.contentIndexer.searchContent(query, 50);

      // Convert search results format
      const vectorSearchResults = this.convertSearchResults(searchResults);

      // Deduplicate by tab, keep only the highest similarity fragment per tab
      const deduplicatedResults = this.deduplicateByTab(vectorSearchResults);

      // Sort by similarity and get top 10 results
      const topResults = deduplicatedResults
        .sort((a, b) => b.semanticScore - a.semanticScore)
        .slice(0, 10);

      // Get index statistics
      const stats = this.contentIndexer.getStats();

      const result = {
        success: true,
        totalTabsSearched: stats.totalTabs,
        matchedTabsCount: topResults.length,
        vectorSearchEnabled: true,
        indexStats: {
          totalDocuments: stats.totalDocuments,
          totalTabs: stats.totalTabs,
          indexedPages: stats.indexedPages,
          semanticEngineReady: stats.semanticEngineReady,
          semanticEngineInitializing: stats.semanticEngineInitializing,
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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('VectorSearchTabsContentTool: Search failed:', error);
      return createErrorResponse(
        `Vector search failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Ensure all tabs are indexed
   */
  private async ensureTabsIndexed(tabs: chrome.tabs.Tab[]): Promise<void> {
    const indexPromises = tabs
      .filter((tab) => tab.id)
      .map(async (tab) => {
        try {
          await this.contentIndexer.indexTabContent(tab.id!);
        } catch (error) {
          console.warn(`VectorSearchTabsContentTool: Failed to index tab ${tab.id}:`, error);
        }
      });

    await Promise.allSettled(indexPromises);
  }

  /**
   * Convert search results format
   */
  private convertSearchResults(searchResults: SearchResult[]): VectorSearchResult[] {
    return searchResults.map((result) => ({
      tabId: result.document.tabId,
      url: result.document.url,
      title: result.document.title,
      semanticScore: result.similarity,
      matchedSnippet: this.extractSnippet(result.document.chunk.text),
      chunkSource: result.document.chunk.source,
      timestamp: result.document.timestamp,
    }));
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
    if (text.length <= maxLength) {
      return text;
    }

    // Try to truncate at sentence boundary
    const truncated = text.substring(0, maxLength);
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
  public async rebuildIndex(): Promise<void> {
    if (!this.isInitialized) {
      await this.initializeIndexer();
    }

    try {
      // Clear existing indexes
      await this.contentIndexer.clearAllIndexes();

      // Get all tabs and reindex
      const windows = await chrome.windows.getAll({ populate: true });
      const allTabs: chrome.tabs.Tab[] = [];

      for (const window of windows) {
        if (window.tabs) {
          allTabs.push(...window.tabs);
        }
      }

      const validTabs = allTabs.filter(
        (tab) =>
          tab.id &&
          tab.url &&
          !tab.url.startsWith('chrome://') &&
          !tab.url.startsWith('chrome-extension://') &&
          !tab.url.startsWith('edge://') &&
          !tab.url.startsWith('about:'),
      );

      await this.ensureTabsIndexed(validTabs);

      console.log(`VectorSearchTabsContentTool: Rebuilt index for ${validTabs.length} tabs`);
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
