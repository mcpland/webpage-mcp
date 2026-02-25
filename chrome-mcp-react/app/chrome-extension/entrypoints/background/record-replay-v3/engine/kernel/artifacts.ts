/**
 * @fileoverview 工件（Artifacts）接口
 * @description 定义截图等工件的获取和存储接口
 */

import type { NodeId, RunId } from '../../domain/ids';
import type { RRError } from '../../domain/errors';
import { RR_ERROR_CODES, createRRError } from '../../domain/errors';

/**
 * 截图结果
 */
export type ScreenshotResult = { ok: true; base64: string } | { ok: false; error: RRError };

/**
 * 工件服务接口
 * @description 提供工件获取和存储功能
 */
export interface ArtifactService {
  /**
   * 截取页面截图
   * @param tabId Tab ID
   * @param options 截图选项
   */
  screenshot(
    tabId: number,
    options?: {
      format?: 'png' | 'jpeg';
      quality?: number;
    },
  ): Promise<ScreenshotResult>;

  /**
   * 保存截图
   * @param runId Run ID
   * @param nodeId Node ID
   * @param base64 截图数据
   * @param filename 文件名（可选）
   */
  saveScreenshot(
    runId: RunId,
    nodeId: NodeId,
    base64: string,
    filename?: string,
  ): Promise<{ savedAs: string } | { error: RRError }>;
}

/**
 * 创建 NotImplemented 的 ArtifactService
 * @description Phase 0-1 占位实现
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
 * 创建基于 chrome.tabs.captureVisibleTab 的 ArtifactService
 * @description 使用 Chrome API 截取可见标签页
 */
export function createChromeArtifactService(): ArtifactService {
  // In-memory storage for screenshots (could be replaced with IndexedDB)
  const screenshotStore = new Map<string, string>();

  return {
    screenshot: async (tabId, options) => {
      try {
        // Get the window ID for the tab
        const tab = await chrome.tabs.get(tabId);
        if (!tab.windowId) {
          return {
            ok: false,
            error: createRRError(RR_ERROR_CODES.INTERNAL, `Tab ${tabId} has no window`),
          };
        }

        // Capture the visible tab
        const format = options?.format ?? 'png';
        const quality = options?.quality ?? 100;

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
 * 工件策略执行器
 * @description 根据策略配置决定是否获取工件
 */
export interface ArtifactPolicyExecutor {
  /**
   * 执行截图策略
   * @param policy 截图策略
   * @param context 上下文
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
 * 创建默认的工件策略执行器
 */
export function createArtifactPolicyExecutor(service: ArtifactService): ArtifactPolicyExecutor {
  return {
    executeScreenshotPolicy: async (policy, context) => {
      // 根据策略决定是否截图
      const shouldCapture = policy === 'always' || (policy === 'onFailure' && context.failed);

      if (!shouldCapture) {
        return { captured: false };
      }

      // 截图
      const result = await service.screenshot(context.tabId);
      if (!result.ok) {
        return { captured: false, error: result.error };
      }

      // 保存（如果指定了文件名）
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
