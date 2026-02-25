/**
 * Content index manager
 * Responsible for automatically extracting, chunking and indexing tab content
 */

import { TextChunker } from './text-chunker';
import { VectorDatabase, getGlobalVectorDatabase } from './vector-database';
import {
  SemanticSimilarityEngine,
  SemanticSimilarityEngineProxy,
  PREDEFINED_MODELS,
  type ModelPreset,
} from './semantic-similarity-engine';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';

export interface IndexingOptions {
  autoIndex?: boolean;
  maxChunksPerPage?: number;
  skipDuplicates?: boolean;
}

export class ContentIndexer {
  private textChunker: TextChunker;
  private vectorDatabase!: VectorDatabase;
  private semanticEngine!: SemanticSimilarityEngine | SemanticSimilarityEngineProxy;
  private isInitialized = false;
  private isInitializing = false;
  private initPromise: Promise<void> | null = null;
  private indexedPages = new Set<string>();
  private readonly options: Required<IndexingOptions>;

  constructor(options?: IndexingOptions) {
    this.options = {
      autoIndex: true,
      maxChunksPerPage: 50,
      skipDuplicates: true,
      ...options,
    };

    this.textChunker = new TextChunker();
  }

  /**
   * Get current selected model configuration
   */
  private async getCurrentModelConfig() {
    try {
      const result = await chrome.storage.local.get(['selectedModel', 'selectedVersion']);
      const selectedModel = (result.selectedModel as ModelPreset) || 'multilingual-e5-small';
      const selectedVersion =
        (result.selectedVersion as 'full' | 'quantized' | 'compressed') || 'quantized';

      const modelInfo = PREDEFINED_MODELS[selectedModel];

      return {
        modelPreset: selectedModel,
        modelIdentifier: modelInfo.modelIdentifier,
        dimension: modelInfo.dimension,
        modelVersion: selectedVersion,
        useLocalFiles: false,
        maxLength: 256,
        cacheSize: 1000,
        forceOffscreen: true,
      };
    } catch (error) {
      console.error('ContentIndexer: Failed to get current model config, using default:', error);
      return {
        modelPreset: 'multilingual-e5-small' as const,
        modelIdentifier: 'Xenova/multilingual-e5-small',
        dimension: 384,
        modelVersion: 'quantized' as const,
        useLocalFiles: false,
        maxLength: 256,
        cacheSize: 1000,
        forceOffscreen: true,
      };
    }
  }

  /**
   * Initialize content indexer
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.isInitializing && this.initPromise) return this.initPromise;

    this.isInitializing = true;
    this.initPromise = this._doInitialize().finally(() => {
      this.isInitializing = false;
    });

    return this.initPromise;
  }

  private async _doInitialize(): Promise<void> {
    try {
      // Get current selected model configuration
      const engineConfig = await this.getCurrentModelConfig();

      // Use proxy class to reuse engine instance in offscreen
      this.semanticEngine = new SemanticSimilarityEngineProxy(engineConfig);
      await this.semanticEngine.initialize();

      this.vectorDatabase = await getGlobalVectorDatabase({
        dimension: engineConfig.dimension,
        efSearch: 50,
      });
      await this.vectorDatabase.initialize();

      this.setupTabEventListeners();

      this.isInitialized = true;
    } catch (error) {
      console.error('ContentIndexer: Initialization failed:', error);
      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * Index content of specified tab
   */
  public async indexTabContent(tabId: number): Promise<void> {
    // Check if semantic engine is ready before attempting to index
    if (!this.isSemanticEngineReady() && !this.isSemanticEngineInitializing()) {
      console.log(
        `ContentIndexer: Skipping tab ${tabId} - semantic engine not ready and not initializing`,
      );
      return;
    }

    if (!this.isInitialized) {
      // Only initialize if semantic engine is already ready
      if (!this.isSemanticEngineReady()) {
        console.log(
          `ContentIndexer: Skipping tab ${tabId} - ContentIndexer not initialized and semantic engine not ready`,
        );
        return;
      }
      await this.initialize();
    }

    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url || !this.shouldIndexUrl(tab.url)) {
        console.log(`ContentIndexer: Skipping tab ${tabId} - URL not indexable`);
        return;
      }

      const pageKey = `${tab.url}_${tab.title}`;
      if (this.options.skipDuplicates && this.indexedPages.has(pageKey)) {
        console.log(`ContentIndexer: Skipping tab ${tabId} - already indexed`);
        return;
      }

      console.log(`ContentIndexer: Starting to index tab ${tabId}: ${tab.title}`);

      const content = await this.extractTabContent(tabId);
      if (!content) {
        console.log(`ContentIndexer: No content extracted from tab ${tabId}`);
        return;
      }

      const chunks = this.textChunker.chunkText(content.textContent, content.title);
      console.log(`ContentIndexer: Generated ${chunks.length} chunks for tab ${tabId}`);

      const chunksToIndex = chunks.slice(0, this.options.maxChunksPerPage);
      if (chunks.length > this.options.maxChunksPerPage) {
        console.log(
          `ContentIndexer: Limited chunks from ${chunks.length} to ${this.options.maxChunksPerPage}`,
        );
      }

      for (const chunk of chunksToIndex) {
        try {
          const embedding = await this.semanticEngine.getEmbedding(chunk.text);
          const label = await this.vectorDatabase.addDocument(
            tabId,
            tab.url!,
            tab.title || '',
            chunk,
            embedding,
          );
          console.log(`ContentIndexer: Indexed chunk ${chunk.index} with label ${label}`);
        } catch (error) {
          console.error(`ContentIndexer: Failed to index chunk ${chunk.index}:`, error);
        }
      }

      this.indexedPages.add(pageKey);

      console.log(
        `ContentIndexer: Successfully indexed ${chunksToIndex.length} chunks for tab ${tabId}`,
      );
    } catch (error) {
      console.error(`ContentIndexer: Failed to index tab ${tabId}:`, error);
    }
  }

  /**
   * Search content
   */
  public async searchContent(query: string, topK: number = 10) {
    // Check if semantic engine is ready before attempting to search
    if (!this.isSemanticEngineReady() && !this.isSemanticEngineInitializing()) {
      throw new Error(
        'Semantic engine is not ready yet. Please initialize the semantic engine first.',
      );
    }

    if (!this.isInitialized) {
      // Only initialize if semantic engine is already ready
      if (!this.isSemanticEngineReady()) {
        throw new Error(
          'ContentIndexer not initialized and semantic engine not ready. Please initialize the semantic engine first.',
        );
      }
      await this.initialize();
    }

    try {
      const queryEmbedding = await this.semanticEngine.getEmbedding(query);
      const results = await this.vectorDatabase.search(queryEmbedding, topK);

      console.log(`ContentIndexer: Found ${results.length} results for query: "${query}"`);
      return results;
    } catch (error) {
      console.error('ContentIndexer: Search failed:', error);

      if (error instanceof Error && error.message.includes('not initialized')) {
        console.log(
          'ContentIndexer: Attempting to reinitialize semantic engine and retry search...',
        );
        try {
          await this.semanticEngine.initialize();
          const queryEmbedding = await this.semanticEngine.getEmbedding(query);
          const results = await this.vectorDatabase.search(queryEmbedding, topK);

          console.log(
            `ContentIndexer: Retry successful, found ${results.length} results for query: "${query}"`,
          );
          return results;
        } catch (retryError) {
          console.error('ContentIndexer: Retry after reinitialization also failed:', retryError);
          throw retryError;
        }
      }

      throw error;
    }
  }

  /**
   * Remove tab index
   */
  public async removeTabIndex(tabId: number): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    try {
      await this.vectorDatabase.removeTabDocuments(tabId);

      for (const pageKey of this.indexedPages) {
        if (pageKey.includes(`tab_${tabId}_`)) {
          this.indexedPages.delete(pageKey);
        }
      }

      console.log(`ContentIndexer: Removed index for tab ${tabId}`);
    } catch (error) {
      console.error(`ContentIndexer: Failed to remove index for tab ${tabId}:`, error);
    }
  }

  /**
   * Check if semantic engine is ready (checks both local and global state)
   */
  public isSemanticEngineReady(): boolean {
    return this.semanticEngine && this.semanticEngine.isInitialized;
  }

  /**
   * Check if global semantic engine is ready (in background/offscreen)
   */
  public async isGlobalSemanticEngineReady(): Promise<boolean> {
    try {
      // Since ContentIndexer runs in background script, directly call the function instead of sending message
      const { handleGetModelStatus } = await import('@/entrypoints/background/semantic-similarity');
      const response = await handleGetModelStatus();
      return (
        response &&
        response.success &&
        response.status &&
        response.status.initializationStatus === 'ready'
      );
    } catch (error) {
      console.error('ContentIndexer: Failed to check global semantic engine status:', error);
      return false;
    }
  }

  /**
   * Check if semantic engine is initializing
   */
  public isSemanticEngineInitializing(): boolean {
    return (
      this.isInitializing || (this.semanticEngine && (this.semanticEngine as any).isInitializing)
    );
  }

  /**
   * Reinitialize content indexer (for model switching)
   */
  public async reinitialize(): Promise<void> {
    console.log('ContentIndexer: Reinitializing for model switch...');

    this.isInitialized = false;
    this.isInitializing = false;
    this.initPromise = null;

    await this.performCompleteDataCleanupForModelSwitch();

    this.indexedPages.clear();
    console.log('ContentIndexer: Cleared indexed pages cache');

    try {
      console.log('ContentIndexer: Creating new semantic engine proxy...');
      const newEngineConfig = await this.getCurrentModelConfig();
      console.log('ContentIndexer: New engine config:', newEngineConfig);

      this.semanticEngine = new SemanticSimilarityEngineProxy(newEngineConfig);
      console.log('ContentIndexer: New semantic engine proxy created');

      await this.semanticEngine.initialize();
      console.log('ContentIndexer: Semantic engine proxy initialization completed');
    } catch (error) {
      console.error('ContentIndexer: Failed to create new semantic engine proxy:', error);
      throw error;
    }

    console.log(
      'ContentIndexer: New semantic engine proxy is ready, proceeding with initialization',
    );

    await this.initialize();

    console.log('ContentIndexer: Reinitialization completed successfully');
  }

  /**
   * Perform complete data cleanup for model switching
   */
  private async performCompleteDataCleanupForModelSwitch(): Promise<void> {
    console.log('ContentIndexer: Starting complete data cleanup for model switch...');

    try {
      // Clear existing vector database instance
      if (this.vectorDatabase) {
        try {
          console.log('ContentIndexer: Clearing existing vector database instance...');
          await this.vectorDatabase.clear();
          console.log('ContentIndexer: Vector database instance cleared successfully');
        } catch (error) {
          console.warn('ContentIndexer: Failed to clear vector database instance:', error);
        }
      }

      try {
        const { clearAllVectorData } = await import('./vector-database');
        await clearAllVectorData();
        console.log('ContentIndexer: Cleared all vector data for model switch');
      } catch (error) {
        console.warn('ContentIndexer: Failed to clear vector data:', error);
      }

      try {
        const keysToRemove = [
          'hnswlib_document_mappings_tab_content_index.dat',
          'hnswlib_document_mappings_content_index.dat',
          'hnswlib_document_mappings_vector_index.dat',
          'vectorDatabaseStats',
          'lastCleanupTime',
        ];
        await chrome.storage.local.remove(keysToRemove);
        console.log('ContentIndexer: Cleared chrome.storage model-related data');
      } catch (error) {
        console.warn('ContentIndexer: Failed to clear chrome.storage data:', error);
      }

      try {
        const deleteVectorDB = indexedDB.deleteDatabase('VectorDatabaseStorage');
        await new Promise<void>((resolve) => {
          deleteVectorDB.onsuccess = () => {
            console.log('ContentIndexer: VectorDatabaseStorage database deleted');
            resolve();
          };
          deleteVectorDB.onerror = () => {
            console.warn('ContentIndexer: Failed to delete VectorDatabaseStorage database');
            resolve(); // Don't block the process
          };
          deleteVectorDB.onblocked = () => {
            console.warn('ContentIndexer: VectorDatabaseStorage database deletion blocked');
            resolve(); // Don't block the process
          };
        });

        // Clean up hnswlib-index database
        const deleteHnswDB = indexedDB.deleteDatabase('/hnswlib-index');
        await new Promise<void>((resolve) => {
          deleteHnswDB.onsuccess = () => {
            console.log('ContentIndexer: /hnswlib-index database deleted');
            resolve();
          };
          deleteHnswDB.onerror = () => {
            console.warn('ContentIndexer: Failed to delete /hnswlib-index database');
            resolve(); // Don't block the process
          };
          deleteHnswDB.onblocked = () => {
            console.warn('ContentIndexer: /hnswlib-index database deletion blocked');
            resolve(); // Don't block the process
          };
        });

        console.log('ContentIndexer: All IndexedDB databases cleared for model switch');
      } catch (error) {
        console.warn('ContentIndexer: Failed to clear IndexedDB databases:', error);
      }

      console.log('ContentIndexer: Complete data cleanup for model switch finished successfully');
    } catch (error) {
      console.error('ContentIndexer: Complete data cleanup for model switch failed:', error);
      throw error;
    }
  }

  /**
   * Manually trigger semantic engine initialization (async, don't wait for completion)
   * Note: This should only be called after the semantic engine is already initialized
   */
  public startSemanticEngineInitialization(): void {
    if (!this.isInitialized && !this.isInitializing) {
      console.log('ContentIndexer: Checking if semantic engine is ready...');

      // Check if global semantic engine is ready before initializing ContentIndexer
      this.isGlobalSemanticEngineReady()
        .then((isReady) => {
          if (isReady) {
            console.log('ContentIndexer: Starting initialization (semantic engine ready)...');
            this.initialize().catch((error) => {
              console.error('ContentIndexer: Background initialization failed:', error);
            });
          } else {
            console.log('ContentIndexer: Semantic engine not ready, skipping initialization');
          }
        })
        .catch((error) => {
          console.error('ContentIndexer: Failed to check semantic engine status:', error);
        });
    }
  }

  /**
   * Get indexing statistics
   */
  public getStats() {
    const vectorStats = this.vectorDatabase
      ? this.vectorDatabase.getStats()
      : {
          totalDocuments: 0,
          totalTabs: 0,
          indexSize: 0,
        };

    return {
      ...vectorStats,
      indexedPages: this.indexedPages.size,
      isInitialized: this.isInitialized,
      semanticEngineReady: this.isSemanticEngineReady(),
      semanticEngineInitializing: this.isSemanticEngineInitializing(),
    };
  }

  /**
   * Clear all indexes
   */
  public async clearAllIndexes(): Promise<void> {
    if (!this.isInitialized) {
      return;
    }

    try {
      await this.vectorDatabase.clear();
      this.indexedPages.clear();
      console.log('ContentIndexer: All indexes cleared');
    } catch (error) {
      console.error('ContentIndexer: Failed to clear indexes:', error);
    }
  }
  private setupTabEventListeners(): void {
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
      if (this.options.autoIndex && changeInfo.status === 'complete' && tab.url) {
        setTimeout(() => {
          if (!this.isSemanticEngineReady() && !this.isSemanticEngineInitializing()) {
            console.log(
              `ContentIndexer: Skipping auto-index for tab ${tabId} - semantic engine not ready`,
            );
            return;
          }

          this.indexTabContent(tabId).catch((error) => {
            console.error(`ContentIndexer: Auto-indexing failed for tab ${tabId}:`, error);
          });
        }, 2000);
      }
    });

    chrome.tabs.onRemoved.addListener(async (tabId) => {
      await this.removeTabIndex(tabId);
    });

    if (chrome.webNavigation) {
      chrome.webNavigation.onCommitted.addListener(async (details) => {
        if (details.frameId === 0) {
          await this.removeTabIndex(details.tabId);
        }
      });
    }
  }

  private shouldIndexUrl(url: string): boolean {
    const excludePatterns = [
      /^chrome:\/\//,
      /^chrome-extension:\/\//,
      /^edge:\/\//,
      /^about:/,
      /^moz-extension:\/\//,
      /^file:\/\//,
    ];

    return !excludePatterns.some((pattern) => pattern.test(url));
  }

  private async extractTabContent(
    tabId: number,
  ): Promise<{ textContent: string; title: string } | null> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['inject-scripts/web-fetcher-helper.js'],
      });

      const response = await chrome.tabs.sendMessage(tabId, {
        action: TOOL_MESSAGE_TYPES.WEB_FETCHER_GET_TEXT_CONTENT,
      });

      if (response.success && response.textContent) {
        return {
          textContent: response.textContent,
          title: response.title || '',
        };
      } else {
        console.error(
          `ContentIndexer: Failed to extract content from tab ${tabId}:`,
          response.error,
        );
        return null;
      }
    } catch (error) {
      console.error(`ContentIndexer: Error extracting content from tab ${tabId}:`, error);
      return null;
    }
  }
}

let globalContentIndexer: ContentIndexer | null = null;

/**
 * Get global ContentIndexer instance
 */
export function getGlobalContentIndexer(): ContentIndexer {
  if (!globalContentIndexer) {
    globalContentIndexer = new ContentIndexer();
  }
  return globalContentIndexer;
}
