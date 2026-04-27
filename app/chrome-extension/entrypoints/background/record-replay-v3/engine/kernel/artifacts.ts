/**
 * @fileoverview Artifacts interface
 * @description Define the acquisition and storage interface for artifacts such as screenshots
 */

import type { NodeId, RunId } from '../../domain/ids';
import type { RRError } from '../../domain/errors';
import { RR_ERROR_CODES, createRRError } from '../../domain/errors';

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
  ): Promise<{ savedAs: string } | { error: RRError }>;
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
  };
}

/**
 * Create an ArtifactService based on chrome.tabs.captureVisibleTab
 * @description Use Chrome API to capture visible tabs
 */
export function createChromeArtifactService(): ArtifactService {
  // In-memory storage for screenshots (could be replaced with IndexedDB)
  const screenshotStore = new Map<string, string>();

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
        // Generate filename if not provided
        const savedAs = filename ?? `${runId}_${nodeId}_${Date.now()}.png`;
        const key = `${runId}/${savedAs}`;

        // Store in memory (in production, this would go to IndexedDB or cloud storage)
        screenshotStore.set(key, base64);

        return { savedAs };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
          error: createRRError(RR_ERROR_CODES.INTERNAL, `Save screenshot failed: ${message}`),
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
  ): Promise<{ captured: boolean; savedAs?: string; error?: RRError }>;
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

      // Save (if filename specified)
      if (context.saveAs) {
        const saveResult = await service.saveScreenshot(
          context.runId,
          context.nodeId,
          result.base64,
          context.saveAs,
        );
        if ('error' in saveResult) {
          return { captured: true, error: saveResult.error };
        }
        return { captured: true, savedAs: saveResult.savedAs };
      }

      return { captured: true };
    },
  };
}
