import { ToolExecutor } from '@/common/tool-handler';
import type { ToolResult } from '@/common/tool-handler';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';

const PING_TIMEOUT_MS = 300;
const TOP_FRAME_ID = 0;
const ACCESSIBILITY_HELPER = 'inject-scripts/accessibility-tree-helper.js';

/**
 * Ping action answered by each injected helper once it has initialized.
 *
 * Pings identify the script being injected rather than the calling tool:
 * several tools inject the same helper, and a pong from one helper must never
 * be taken as proof that a different helper is present. Scripts without an
 * entry are always (re)injected; every helper guards its own initialization.
 */
export const INJECTED_SCRIPT_PING_ACTIONS: Readonly<Record<string, string>> =
  Object.freeze({
    'inject-scripts/accessibility-tree-helper.js': 'chrome_read_page_ping',
    'inject-scripts/click-helper.js': 'chrome_click_element_ping',
    'inject-scripts/dom-observer.js': 'dom_observer_ping',
    'inject-scripts/element-marker.js': 'element_marker_ping',
    'inject-scripts/element-picker.js': 'chrome_request_element_selection_ping',
    'inject-scripts/fill-helper.js': 'chrome_fill_or_select_ping',
    'inject-scripts/interactive-elements-helper.js':
      'chrome_get_interactive_elements_ping',
    'inject-scripts/keyboard-helper.js': 'chrome_keyboard_ping',
    'inject-scripts/network-helper.js': 'chrome_network_request_ping',
    'inject-scripts/recorder.js': 'rr_recorder_ping',
    'inject-scripts/screenshot-helper.js': 'chrome_screenshot_ping',
    'inject-scripts/wait-helper.js': 'wait_helper_ping',
    'inject-scripts/web-fetcher-helper.js': 'chrome_web_fetcher_ping',
  });

/**
 * Base class for browser tool executors
 */
export abstract class BaseBrowserToolExecutor implements ToolExecutor {
  abstract name: string;
  abstract execute(args: any): Promise<ToolResult>;

  /**
   * Resolve to true only when the helper answering `action` in `frameId`
   * reports that it is initialized.
   */
  private async pingInjectedScript(
    tabId: number,
    action: string,
    frameId: number,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        chrome.tabs.sendMessage(tabId, { action }, { frameId }),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), PING_TIMEOUT_MS);
        }),
      ]);
      return (response as { status?: unknown } | undefined)?.status === 'pong';
    } catch {
      // No listener in that frame yet: the helper has to be injected.
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Inject content script into tab
   */
  protected async injectContentScript(
    tabId: number,
    files: string[],
    injectImmediately = false,
    world: 'MAIN' | 'ISOLATED' = 'ISOLATED',
    allFrames: boolean = false,
    frameIds?: number[],
  ): Promise<void> {
    // A single ping cannot vouch for several frames, and MAIN-world scripts
    // cannot answer runtime messages; those injections rely on the helpers'
    // own initialization guards instead.
    const targetsSingleFrame =
      frameIds && frameIds.length > 0 ? frameIds.length === 1 : !allFrames;
    const canPing = world === 'ISOLATED' && targetsSingleFrame;
    let pendingFiles = files;
    if (canPing) {
      const pingFrameId = frameIds?.[0] ?? TOP_FRAME_ID;
      pendingFiles = [];
      for (const file of files) {
        const action = INJECTED_SCRIPT_PING_ACTIONS[file];
        if (!action || !(await this.pingInjectedScript(tabId, action, pingFrameId))) {
          pendingFiles.push(file);
        }
      }
      if (pendingFiles.length === 0) return;
    }

    try {
      const target: {
        tabId: number;
        allFrames?: boolean;
        frameIds?: number[];
      } = { tabId };
      if (frameIds && frameIds.length > 0) {
        target.frameIds = frameIds;
      } else if (allFrames) {
        target.allFrames = true;
      }
      await chrome.scripting.executeScript({
        target,
        files: pendingFiles,
        injectImmediately,
        world,
      } as any);
    } catch (injectionError) {
      const errorMessage =
        injectionError instanceof Error
          ? injectionError.message
          : String(injectionError);
      console.error(
        `Content script '${files.join(', ')}' injection failed for tab ${tabId}: ${errorMessage}`,
      );
      throw new Error(
        `${ERROR_MESSAGES.TOOL_EXECUTION_FAILED}: Failed to inject content script in tab ${tabId}: ${errorMessage}`,
      );
    }
  }

  /**
   * Inject the accessibility helper into `frameId` (top frame by default) and
   * every ancestor frame. Child frames project ref coordinates into the top
   * viewport through their parents' helpers. Pass `{ allFrames: true }` for
   * cross-frame composite selectors (`|>`) whose target iframe is not known yet.
   */
  protected async injectAccessibilityHelper(
    tabId: number,
    frameId?: number,
    options?: { allFrames?: boolean },
  ): Promise<void> {
    if (options?.allFrames) {
      await this.injectContentScript(tabId, [ACCESSIBILITY_HELPER], false, 'ISOLATED', true);
      return;
    }
    const targetFrameId = typeof frameId === 'number' ? frameId : TOP_FRAME_ID;
    const chain = await this.getFrameAncestry(tabId, targetFrameId);
    for (const id of chain) {
      if (id !== targetFrameId) {
        // Ancestors only assist with viewport coordinate projection; a
        // sandboxed or opaque intermediate frame must not block targetFrameId.
        try {
          await this.injectContentScript(
            tabId,
            [ACCESSIBILITY_HELPER],
            false,
            'ISOLATED',
            false,
            [id],
          );
        } catch {
          // Projection will degrade cleanly to DOM fallback if needed.
        }
      } else {
        await this.injectContentScript(
          tabId,
          [ACCESSIBILITY_HELPER],
          false,
          'ISOLATED',
          false,
          [id],
        );
      }
    }
  }

  /**
   * Frame ids from the top frame down to `frameId` (inclusive). Falls back to
   * just the target when the frame tree cannot be read.
   */
  protected async getFrameAncestry(tabId: number, frameId: number): Promise<number[]> {
    if (frameId === TOP_FRAME_ID) return [TOP_FRAME_ID];
    try {
      const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
      const parentOf = new Map<number, number>();
      for (const frame of frames) parentOf.set(frame.frameId, frame.parentFrameId);
      const chain: number[] = [];
      let current: number | undefined = frameId;
      while (typeof current === 'number' && current >= 0 && chain.length < 32) {
        chain.unshift(current);
        if (current === TOP_FRAME_ID) break;
        current = parentOf.get(current);
      }
      return chain.length > 0 ? chain : [frameId];
    } catch {
      return [frameId];
    }
  }

  /**
   * Send message to tab. Messages go to the top frame unless a frameId is
   * given: broadcasting to every frame lets whichever frame answers first win,
   * and frame-local refs collide across frames. Pass 'all' only when any
   * frame's answer is acceptable.
   */
  protected async sendMessageToTab(
    tabId: number,
    message: any,
    frameId?: number | 'all',
  ): Promise<any> {
    try {
      const response =
        frameId === 'all'
          ? await chrome.tabs.sendMessage(tabId, message)
          : await chrome.tabs.sendMessage(tabId, message, {
              frameId: typeof frameId === 'number' ? frameId : TOP_FRAME_ID,
            });

      if (response && response.error) {
        throw new Error(String(response.error));
      }

      return response;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        `Error sending message to tab ${tabId} for action ${message?.action || 'unknown'}: ${errorMessage}`,
      );

      if (error instanceof Error) {
        throw error;
      }
      throw new Error(errorMessage);
    }
  }

  /**
   * Try to get an existing tab by id. Returns null when not found.
   */
  protected async tryGetTab(tabId?: number): Promise<chrome.tabs.Tab | null> {
    if (typeof tabId !== 'number') return null;
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  /**
   * Get the active tab in the current window. Throws when not found.
   */
  protected async getActiveTabOrThrow(): Promise<chrome.tabs.Tab> {
    const [active] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!active || !active.id) throw new Error('Active tab not found');
    return active;
  }

  /**
   * Optionally focus window and/or activate tab. Defaults preserve current behavior
   * when caller sets activate/focus flags explicitly.
   */
  protected async ensureFocus(
    tab: chrome.tabs.Tab,
    options: { activate?: boolean; focusWindow?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    const activate = options.activate === true;
    const focusWindow = options.focusWindow === true;
    options.signal?.throwIfAborted();
    if (focusWindow && typeof tab.windowId === 'number') {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    options.signal?.throwIfAborted();
    if (activate && typeof tab.id === 'number') {
      await chrome.tabs.update(tab.id, { active: true });
    }
  }

  /**
   * Activate a target tab before viewport-dependent operations. Inactive tabs can
   * report a 0x0 viewport, which makes accessibility trees and coordinate
   * interaction unreliable.
   */
  protected async activateTabIfNeeded(
    tab: chrome.tabs.Tab,
  ): Promise<chrome.tabs.Tab> {
    if (tab.active === true || typeof tab.id !== 'number') {
      return tab;
    }

    await this.ensureFocus(tab, { activate: true, focusWindow: true });

    try {
      return await chrome.tabs.get(tab.id);
    } catch {
      return { ...tab, active: true };
    }
  }

  /**
   * Get the active tab. When windowId provided, search within that window; otherwise currentWindow.
   */
  protected async getActiveTabInWindow(
    windowId?: number,
  ): Promise<chrome.tabs.Tab | null> {
    if (typeof windowId === 'number') {
      const tabs = await chrome.tabs.query({ active: true, windowId });
      return tabs && tabs[0] ? tabs[0] : null;
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  }

  /**
   * Same as getActiveTabInWindow, but throws if not found.
   */
  protected async getActiveTabOrThrowInWindow(
    windowId?: number,
  ): Promise<chrome.tabs.Tab> {
    const tab = await this.getActiveTabInWindow(windowId);
    if (!tab || !tab.id) throw new Error('Active tab not found');
    return tab;
  }
}
