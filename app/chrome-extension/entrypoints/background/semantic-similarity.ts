import {
  PREDEFINED_MODELS,
  hasAnyModelCache,
  type ModelPreset,
} from '@/utils/semantic-similarity-engine';
import { OffscreenManager } from '@/utils/offscreen-manager';
import { BACKGROUND_MESSAGE_TYPES, OFFSCREEN_MESSAGE_TYPES } from '@/common/message-types';
import { STORAGE_KEYS, ERROR_MESSAGES } from '@/common/constants';
import { isExtensionPageSender, isOffscreenDocumentSender } from '@/common/runtime-sender-auth';
import {
  getStoredSemanticModelSelection,
  normalizeSemanticModelState,
  safeSemanticErrorMessage,
  validateSemanticModelSelection,
  type SemanticModelVersion,
} from '@/utils/semantic-similarity-boundaries';

/**
 * Model configuration state management interface
 */
interface ModelConfig {
  modelPreset: ModelPreset;
  modelVersion: SemanticModelVersion;
  modelDimension: number;
}

let currentBackgroundModelConfig: ModelConfig | null = null;

/**
 * Initialize semantic engine only if model cache exists
 * This is called during plugin startup to avoid downloading models unnecessarily
 */
export async function initializeSemanticEngineIfCached(): Promise<boolean> {
  try {
    console.log('Background: Checking if semantic engine should be initialized from cache...');

    const hasCachedModel = await hasAnyModelCache();
    if (!hasCachedModel) {
      console.log('Background: No cached models found, skipping semantic engine initialization');
      return false;
    }

    console.log('Background: Found cached models, initializing semantic engine...');
    await initializeDefaultSemanticEngine();
    return true;
  } catch (error) {
    console.error('Background: Error during conditional semantic engine initialization:', error);
    return false;
  }
}

/**
 * Initialize default semantic engine model
 */
export async function initializeDefaultSemanticEngine(): Promise<void> {
  try {
    console.log('Background: Initializing default semantic engine...');

    // Update status to initializing
    await updateModelStatus('initializing', 0);

    const result = await chrome.storage.local.get([STORAGE_KEYS.SEMANTIC_MODEL, 'selectedVersion']);
    const selection = getStoredSemanticModelSelection(
      result[STORAGE_KEYS.SEMANTIC_MODEL],
      result.selectedVersion,
      PREDEFINED_MODELS,
      'multilingual-e5-small',
    );

    await OffscreenManager.getInstance().ensureOffscreenDocument();

    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_INIT,
      config: selection,
    });

    if (response && response.success) {
      currentBackgroundModelConfig = selection;
      console.log('Semantic engine initialized successfully:', currentBackgroundModelConfig);

      // Update status to ready
      await updateModelStatus('ready', 100);

      // Also initialize ContentIndexer now that semantic engine is ready
      try {
        const { getGlobalContentIndexer } = await import('@/utils/content-indexer');
        const contentIndexer = getGlobalContentIndexer();
        contentIndexer.startSemanticEngineInitialization();
        console.log('ContentIndexer initialization triggered after semantic engine initialization');
      } catch (indexerError) {
        console.warn(
          'Failed to initialize ContentIndexer after semantic engine initialization:',
          indexerError,
        );
      }
    } else {
      const errorMessage = safeSemanticErrorMessage(
        response?.error,
        ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
      );
      await updateModelStatus('error', 0, errorMessage, 'unknown');
      throw new Error(errorMessage);
    }
  } catch (error: unknown) {
    console.error('Background: Failed to initialize default semantic engine:', error);
    const errorMessage = safeSemanticErrorMessage(
      error,
      'Unknown error during semantic engine initialization',
    );
    await updateModelStatus('error', 0, errorMessage, 'unknown');
    // Don't throw error, let the extension continue running
  }
}

/**
 * Check if model switch is needed
 */
function needsModelSwitch(selection: ModelConfig): boolean {
  if (!currentBackgroundModelConfig) {
    return true;
  }

  return (
    selection.modelPreset !== currentBackgroundModelConfig.modelPreset ||
    selection.modelVersion !== currentBackgroundModelConfig.modelVersion ||
    selection.modelDimension !== currentBackgroundModelConfig.modelDimension
  );
}

/**
 * Handle model switching
 */
export async function handleModelSwitch(
  modelPreset: unknown,
  modelVersion: unknown,
  modelDimension?: unknown,
  previousDimension?: unknown,
): Promise<{ success: boolean; error?: string }> {
  try {
    const selection = validateSemanticModelSelection(
      { modelPreset, modelVersion, modelDimension },
      PREDEFINED_MODELS,
    );
    if (
      previousDimension !== undefined &&
      (!Number.isInteger(previousDimension) ||
        !Object.values(PREDEFINED_MODELS).some(({ dimension }) => dimension === previousDimension))
    ) {
      throw new Error('Invalid previous semantic model dimension');
    }

    const needsSwitch = needsModelSwitch(selection);
    if (!needsSwitch) {
      await updateModelStatus('ready', 100);
      return { success: true };
    }

    await updateModelStatus('downloading', 0);

    try {
      await OffscreenManager.getInstance().ensureOffscreenDocument();
    } catch (offscreenError: unknown) {
      console.error('Background: Failed to create offscreen document:', offscreenError);
      const errorMessage = safeSemanticErrorMessage(
        offscreenError,
        'Failed to create offscreen document',
      );
      await updateModelStatus('error', 0, errorMessage, 'unknown');
      return { success: false, error: errorMessage };
    }

    const response = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: OFFSCREEN_MESSAGE_TYPES.SIMILARITY_ENGINE_INIT,
      config: selection,
    });

    if (response && response.success) {
      currentBackgroundModelConfig = selection;

      // Only reinitialize ContentIndexer when dimension changes
      try {
        if (
          typeof previousDimension === 'number' &&
          selection.modelDimension !== previousDimension
        ) {
          const { getGlobalContentIndexer } = await import('@/utils/content-indexer');
          const contentIndexer = getGlobalContentIndexer();
          await contentIndexer.reinitialize();
        }
      } catch (indexerError) {
        console.warn('Background: Failed to reinitialize ContentIndexer:', indexerError);
      }

      await updateModelStatus('ready', 100);
      return { success: true };
    } else {
      const errorMessage = safeSemanticErrorMessage(response?.error, 'Failed to switch model');
      const errorType = analyzeErrorType(errorMessage);
      await updateModelStatus('error', 0, errorMessage, errorType);
      throw new Error(errorMessage);
    }
  } catch (error: unknown) {
    console.error('Model switch failed:', error);
    const errorMessage = safeSemanticErrorMessage(error);
    const errorType = analyzeErrorType(errorMessage);
    await updateModelStatus('error', 0, errorMessage, errorType);
    return { success: false, error: errorMessage };
  }
}

/**
 * Get model status
 */
export async function handleGetModelStatus(): Promise<{
  success: boolean;
  status?: any;
  error?: string;
}> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      console.error('Background: chrome.storage.local is not available for status query');
      return {
        success: true,
        status: {
          initializationStatus: 'idle',
          downloadProgress: 0,
          isDownloading: false,
          lastUpdated: Date.now(),
        },
      };
    }

    const result = await chrome.storage.local.get(['modelState']);
    const modelState = normalizeSemanticModelState(
      result.modelState || {
        status: 'idle',
        downloadProgress: 0,
        isDownloading: false,
        lastUpdated: Date.now(),
      },
    );

    return {
      success: true,
      status: {
        initializationStatus: modelState.status,
        downloadProgress: modelState.downloadProgress,
        isDownloading: modelState.isDownloading,
        lastUpdated: modelState.lastUpdated,
        errorMessage: modelState.errorMessage,
        errorType: modelState.errorType,
      },
    };
  } catch (error: unknown) {
    console.error('Failed to get model status:', error);
    return { success: false, error: safeSemanticErrorMessage(error) };
  }
}

/**
 * Update model status
 */
export async function updateModelStatus(
  status: unknown,
  progress: unknown,
  errorMessage?: unknown,
  errorType?: unknown,
): Promise<void> {
  try {
    // Check if chrome.storage is available
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      console.error('Background: chrome.storage.local is not available for status update');
      return;
    }

    const modelState = normalizeSemanticModelState({
      status,
      downloadProgress: progress,
      lastUpdated: Date.now(),
      errorMessage,
      errorType,
    });
    await chrome.storage.local.set({ modelState });
  } catch (error) {
    console.error('Failed to update model status:', error);
  }
}

/**
 * Handle model status updates from offscreen document
 */
export async function handleUpdateModelStatus(
  modelState: unknown,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Check if chrome.storage is available
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      console.error('Background: chrome.storage.local is not available');
      return { success: false, error: 'chrome.storage.local is not available' };
    }

    await chrome.storage.local.set({
      modelState: normalizeSemanticModelState(modelState),
    });
    return { success: true };
  } catch (error: unknown) {
    console.error('Background: Failed to update model status:', error);
    return { success: false, error: safeSemanticErrorMessage(error) };
  }
}

/**
 * Analyze error type based on error message
 */
function analyzeErrorType(errorMessage: string): 'network' | 'file' | 'unknown' {
  const message = errorMessage.toLowerCase();

  if (
    message.includes('network') ||
    message.includes('fetch') ||
    message.includes('timeout') ||
    message.includes('connection') ||
    message.includes('cors') ||
    message.includes('failed to fetch')
  ) {
    return 'network';
  }

  if (
    message.includes('corrupt') ||
    message.includes('invalid') ||
    message.includes('format') ||
    message.includes('parse') ||
    message.includes('decode') ||
    message.includes('onnx')
  ) {
    return 'file';
  }

  return 'unknown';
}

/**
 * Initialize semantic similarity module message listeners
 */
export const initSemanticSimilarityListener = () => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const messageType = message?.type;
    const isSemanticControl =
      messageType === BACKGROUND_MESSAGE_TYPES.SWITCH_SEMANTIC_MODEL ||
      messageType === BACKGROUND_MESSAGE_TYPES.GET_MODEL_STATUS ||
      messageType === BACKGROUND_MESSAGE_TYPES.UPDATE_MODEL_STATUS ||
      messageType === BACKGROUND_MESSAGE_TYPES.INITIALIZE_SEMANTIC_ENGINE;

    if (!isSemanticControl) return;

    const isAuthorized =
      messageType === BACKGROUND_MESSAGE_TYPES.UPDATE_MODEL_STATUS
        ? isOffscreenDocumentSender(sender)
        : isExtensionPageSender(sender) && !isOffscreenDocumentSender(sender);
    if (!isAuthorized) {
      sendResponse({
        success: false,
        error: 'Unauthorized semantic engine control request',
      });
      return false;
    }

    if (messageType === BACKGROUND_MESSAGE_TYPES.SWITCH_SEMANTIC_MODEL) {
      handleModelSwitch(
        message.modelPreset,
        message.modelVersion,
        message.modelDimension,
        message.previousDimension,
      )
        .then((result: { success: boolean; error?: string }) => sendResponse(result))
        .catch((error: unknown) =>
          sendResponse({
            success: false,
            error: safeSemanticErrorMessage(error),
          }),
        );
      return true;
    } else if (messageType === BACKGROUND_MESSAGE_TYPES.GET_MODEL_STATUS) {
      handleGetModelStatus()
        .then((result: { success: boolean; status?: any; error?: string }) => sendResponse(result))
        .catch((error: unknown) =>
          sendResponse({
            success: false,
            error: safeSemanticErrorMessage(error),
          }),
        );
      return true;
    } else if (messageType === BACKGROUND_MESSAGE_TYPES.UPDATE_MODEL_STATUS) {
      handleUpdateModelStatus(message.modelState)
        .then((result: { success: boolean; error?: string }) => sendResponse(result))
        .catch((error: unknown) =>
          sendResponse({
            success: false,
            error: safeSemanticErrorMessage(error),
          }),
        );
      return true;
    } else {
      initializeDefaultSemanticEngine()
        .then(() => sendResponse({ success: true }))
        .catch((error: unknown) =>
          sendResponse({
            success: false,
            error: safeSemanticErrorMessage(error),
          }),
        );
      return true;
    }
  });
};
