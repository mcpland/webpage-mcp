/**
 * @fileoverview Artifacts interface
 * @description Define the acquisition and storage interface for artifacts such as screenshots
 */

import type { NodeId, RunId } from '../../domain/ids';
import type { RRError } from '../../domain/errors';
import { RR_ERROR_CODES, createRRError } from '../../domain/errors';
import {
  createIndexedDbArtifactStore,
  type ArtifactRetentionPolicy,
  type ArtifactStore,
} from '../../storage/artifacts';

/**
 * Screenshot results
 */
export type ScreenshotResult = { ok: true; base64: string } | { ok: false; error: RRError };

/**
 * Artifact service interface
 * @description Provide artifact acquisition and storage functions
 */
export interface ArtifactService {
  /**
   * Take a screenshot of the page
   * @param tabId Tab ID
   * @param options Screenshot options
   */
  screenshot(
    tabId: number,
    options?: {
      format?: 'png' | 'jpeg';
      quality?: number;
      background?: boolean;
    },
  ): Promise<ScreenshotResult>;

  /**
   * Save screenshot
   * @param runId Run ID
   * @param nodeId Node ID
   * @param base64 Screenshot data
   * @param filename File name (optional)
   */
  saveScreenshot(
    runId: RunId,
    nodeId: NodeId,
    base64: string,
    filename?: string,
  ): Promise<{ savedAs: string; artifactId?: string } | { error: RRError }>;

  /**
   * List persisted artifacts for a run.
   */
  listArtifacts?(runId: RunId): Promise<Array<{ id: string; savedAs: string; sizeBytes: number }>>;

  /**
   * Delete all artifacts for a run.
   */
  deleteRunArtifacts?(runId: RunId): Promise<{ deleted: number } | { error: RRError }>;

  /**
   * Apply artifact TTL and size retention.
   */
  cleanupArtifacts?(): Promise<{ deleted: number } | { error: RRError }>;
}

/**
 * Create NotImplemented ArtifactService
 * @description Phase 0-1 Placeholder implementation
 */
export function createNotImplementedArtifactService(): ArtifactService {
  return {
    screenshot: async () => ({
      ok: false,
      error: createRRError(RR_ERROR_CODES.INTERNAL, 'ArtifactService.screenshot not implemented'),
    }),
    saveScreenshot: async () => ({
      error: createRRError(
        RR_ERROR_CODES.INTERNAL,
        'ArtifactService.saveScreenshot not implemented',
      ),
    }),
    listArtifacts: async () => [],
    deleteRunArtifacts: async () => ({ deleted: 0 }),
    cleanupArtifacts: async () => ({ deleted: 0 }),
  };
}

/**
 * Create an ArtifactService based on chrome.tabs.captureVisibleTab
 * @description Use Chrome API to capture visible tabs
 */
export function createChromeArtifactService(options: {
  store?: ArtifactStore;
  retention?: Partial<ArtifactRetentionPolicy>;
  now?: () => number;
} = {}): ArtifactService {
  const artifactStore =
    options.store ?? createIndexedDbArtifactStore(options.retention, options.now);

  return {
    screenshot: async (tabId, options) => {
      try {
        const format = options?.format ?? 'png';
        const quality = options?.quality ?? 100;
        if (options?.background === true) {
          const { cdpSessionManager } = await import('@/utils/cdp-session-manager');
          const shot = await cdpSessionManager.withSession(tabId, 'rr-v3-artifact-screenshot', async () => {
            return (await cdpSessionManager.sendCommand(tabId, 'Page.captureScreenshot', {
              format,
              ...(format === 'jpeg' ? { quality } : {}),
            })) as { data?: unknown };
          });
          const base64 = typeof shot?.data === 'string' ? shot.data : '';
          if (!base64) {
            return {
              ok: false,
              error: createRRError(RR_ERROR_CODES.INTERNAL, 'CDP screenshot returned empty data'),
            };
          }
          return { ok: true, base64 };
        }

        // Get the window ID for the tab
        const tab = await chrome.tabs.get(tabId);
        if (!tab.windowId) {
          return {
            ok: false,
            error: createRRError(RR_ERROR_CODES.INTERNAL, `Tab ${tabId} has no window`),
          };
        }

        // Capture the visible tab
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format,
          quality: format === 'jpeg' ? quality : undefined,
        });

        // Extract base64 from data URL
        const base64Match = dataUrl.match(/^data:image\/\w+;base64,(.+)$/);
        if (!base64Match) {
          return {
            ok: false,
            error: createRRError(RR_ERROR_CODES.INTERNAL, 'Invalid screenshot data URL'),
          };
        }

        return { ok: true, base64: base64Match[1] };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          error: createRRError(RR_ERROR_CODES.INTERNAL, `Screenshot failed: ${message}`),
        };
      }
    },

    saveScreenshot: async (runId, nodeId, base64, filename) => {
      try {
        const record = await artifactStore.saveScreenshot({
          runId,
          nodeId,
          base64,
          filename,
          mimeType: 'image/png',
          metadata: { source: 'rr-v3-artifact-service' },
        });

        return { savedAs: record.filename, artifactId: record.id };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          error: createRRError(RR_ERROR_CODES.INTERNAL, `Save screenshot failed: ${message}`),
        };
      }
    },

    listArtifacts: async (runId) => {
      const records = await artifactStore.listByRun(runId);
      return records.map((record) => ({
        id: record.id,
        savedAs: record.filename,
        sizeBytes: record.sizeBytes,
      }));
    },

    deleteRunArtifacts: async (runId) => {
      try {
        return { deleted: await artifactStore.deleteByRun(runId) };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          error: createRRError(RR_ERROR_CODES.INTERNAL, `Delete artifacts failed: ${message}`),
        };
      }
    },

    cleanupArtifacts: async () => {
      try {
        const expired = await artifactStore.cleanupExpired();
        const overLimit = await artifactStore.enforceRetention();
        return { deleted: expired + overLimit };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          error: createRRError(RR_ERROR_CODES.INTERNAL, `Cleanup artifacts failed: ${message}`),
        };
      }
    },
  };
}

/**
 * Artifact Policy Executor
 * @description Decide whether to obtain artifacts based on policy configuration
 */
export interface ArtifactPolicyExecutor {
  /**
   * Implement a screenshot strategy
   * @param policy Screenshot strategy
   * @param context context
   */
  executeScreenshotPolicy(
    policy: 'never' | 'onFailure' | 'always',
    context: {
      tabId: number;
      runId: RunId;
      nodeId: NodeId;
      failed: boolean;
      saveAs?: string;
    },
  ): Promise<{ captured: boolean; savedAs?: string; artifactId?: string; error?: RRError }>;
}

/**
 * Create a default artifact policy executor
 */
export function createArtifactPolicyExecutor(service: ArtifactService): ArtifactPolicyExecutor {
  return {
    executeScreenshotPolicy: async (policy, context) => {
      // Decide whether to take screenshots based on strategy
      const shouldCapture = policy === 'always' || (policy === 'onFailure' && context.failed);

      if (!shouldCapture) {
        return { captured: false };
      }

      // screenshot
      const result = await service.screenshot(context.tabId);
      if (!result.ok) {
        return { captured: false, error: result.error };
      }

      const saveResult = await service.saveScreenshot(
        context.runId,
        context.nodeId,
        result.base64,
        context.saveAs,
      );
      if ('error' in saveResult) {
        return { captured: true, error: saveResult.error };
      }

      return {
        captured: true,
        savedAs: saveResult.savedAs,
        artifactId: saveResult.artifactId,
      };
    },
  };
}
