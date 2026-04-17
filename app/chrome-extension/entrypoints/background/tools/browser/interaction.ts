import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { hasDisallowedPublicUrlScheme } from './common';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  getResolvedViewportCoordinates,
  isCompositeSelector,
  resolveFrameIdForMessageResult,
} from './target-resolution';

interface Coordinates {
  x: number;
  y: number;
}

interface HelperClickTarget {
  coordinates?: Coordinates;
  frameId?: number;
  ref?: string;
  selector?: string;
}

interface ResolvedClickTarget {
  helperTarget: HelperClickTarget;
  elementInfo: Record<string, unknown>;
  nativeCoordinates?: Coordinates;
}

const MODIFIER_MASKS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  win: 4,
  windows: 4,
  shift: 8,
};

function toModifierMask(modifiers?: ClickToolParams['modifiers']): number {
  let mask = 0;
  if (modifiers?.altKey) mask |= MODIFIER_MASKS.alt;
  if (modifiers?.ctrlKey) mask |= MODIFIER_MASKS.ctrl;
  if (modifiers?.metaKey) mask |= MODIFIER_MASKS.meta;
  if (modifiers?.shiftKey) mask |= MODIFIER_MASKS.shift;
  return mask;
}

async function dispatchNativeClick(
  tabId: number,
  coordinates: Coordinates,
  options: {
    button?: 'left' | 'right' | 'middle';
    double?: boolean;
    modifiers?: ClickToolParams['modifiers'];
  },
): Promise<void> {
  const button = options.button || 'left';
  const clickCount = options.double === true ? 2 : 1;
  const modifiers = toModifierMask(options.modifiers);
  const buttonMask = button === 'right' ? 2 : button === 'middle' ? 4 : 1;

  await cdpSessionManager.attach(tabId, 'click');
  try {
    await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(coordinates.x),
      y: Math.round(coordinates.y),
      button: 'none',
      buttons: 0,
      modifiers,
    });

    for (let index = 1; index <= clickCount; index += 1) {
      await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: Math.round(coordinates.x),
        y: Math.round(coordinates.y),
        button,
        buttons: buttonMask,
        clickCount: index,
        modifiers,
      });
      await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: Math.round(coordinates.x),
        y: Math.round(coordinates.y),
        button,
        buttons: 0,
        clickCount: index,
        modifiers,
      });
    }
  } finally {
    await cdpSessionManager.detach(tabId, 'click');
  }
}

async function waitForNavigationAfterClick(
  tabId: number,
  beforeUrl: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let sawNavigationSignal = false;

  while (Date.now() < deadline) {
    const current = await chrome.tabs.get(tabId).catch(() => null);
    if (!current) {
      return sawNavigationSignal;
    }

    const pendingUrl =
      (current as chrome.tabs.Tab & { pendingUrl?: string }).pendingUrl || '';
    const currentUrl = current.url || '';
    const observedUrl = pendingUrl || currentUrl;

    if (observedUrl && observedUrl !== beforeUrl) {
      sawNavigationSignal = true;
      if (current.status === 'complete') {
        return true;
      }
    }

    if (current.status !== 'complete') {
      sawNavigationSignal = true;
    }

    if (sawNavigationSignal && current.status === 'complete') {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
}

async function dispatchHelperClick(
  tool: any,
  tabId: number,
  args: ClickToolParams,
  target?: HelperClickTarget,
): Promise<any> {
  const frameId = target?.frameId ?? args.frameId;
  const selector = target ? target.selector : args.selector;
  const coordinates = target ? target.coordinates : args.coordinates;
  const ref = target ? target.ref : args.ref;
  await tool.injectContentScript(
    tabId,
    ['inject-scripts/click-helper.js'],
    false,
    'ISOLATED',
    false,
    typeof frameId === 'number' ? [frameId] : undefined,
  );
  return tool.sendMessageToTab(
    tabId,
    {
      action: TOOL_MESSAGE_TYPES.CLICK_ELEMENT,
      selector,
      coordinates,
      ref,
      waitForNavigation: args.waitForNavigation,
      timeout: args.timeout,
      double: args.double === true,
      button: args.button,
      bubbles: args.bubbles,
      cancelable: args.cancelable,
      modifiers: args.modifiers,
    },
    frameId,
  );
}

interface ClickToolParams {
  selector?: string; // CSS selector or XPath for the element to click
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree (window.__claudeElementMap)
  coordinates?: Coordinates; // Coordinates to click at (x, y relative to viewport)
  waitForNavigation?: boolean; // Whether to wait for navigation to complete after click
  timeout?: number; // Timeout in milliseconds for waiting for the element or navigation
  frameId?: number; // Target frame for ref/selector resolution
  double?: boolean; // Perform double click when true
  button?: 'left' | 'right' | 'middle';
  bubbles?: boolean;
  cancelable?: boolean;
  modifiers?: {
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
  };
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
}

/**
 * Tool for clicking elements on web pages
 */
class ClickTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLICK;

  private async resolveTarget(
    tabId: number,
    args: ClickToolParams,
  ): Promise<ResolvedClickTarget> {
    const { selector, selectorType = 'css', coordinates, frameId } = args;
    let targetFrameId = frameId;

    if (
      coordinates &&
      typeof coordinates.x === 'number' &&
      typeof coordinates.y === 'number'
    ) {
      return {
        helperTarget: {
          coordinates,
          frameId,
        },
        elementInfo: {
          clickMethod: 'coordinates',
          clickPosition: coordinates,
        },
        nativeCoordinates: coordinates,
      };
    }

    await this.injectContentScript(
      tabId,
      ['inject-scripts/accessibility-tree-helper.js'],
      false,
      'ISOLATED',
      false,
      typeof targetFrameId === 'number' ? [targetFrameId] : undefined,
    );

    let ref =
      typeof args.ref === 'string' && args.ref.trim()
        ? args.ref.trim()
        : undefined;
    if (!ref && selector) {
      const selectorFrameId = isCompositeSelector(selector)
        ? undefined
        : targetFrameId;
      const ensured = await this.sendMessageToTab(
        tabId,
        {
          action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
          selector,
          isXPath: selectorType === 'xpath',
        },
        selectorFrameId,
      );
      if (!ensured || ensured.success !== true || !ensured.ref) {
        throw new Error(
          `Failed to resolve ${selectorType === 'xpath' ? 'XPath' : 'selector'} target: ${
            ensured?.error || 'unknown error'
          }`,
        );
      }
      targetFrameId = await resolveFrameIdForMessageResult(
        tabId,
        targetFrameId,
        ensured,
      );
      await this.injectContentScript(
        tabId,
        ['inject-scripts/accessibility-tree-helper.js'],
        false,
        'ISOLATED',
        false,
        typeof targetFrameId === 'number' ? [targetFrameId] : undefined,
      );
      ref = String(ensured.ref);
    }

    if (!ref) {
      throw new Error('No click target could be resolved');
    }

    try {
      await this.sendMessageToTab(
        tabId,
        { action: 'focusByRef', ref },
        targetFrameId,
      );
    } catch {
      // Best effort - some elements do not need explicit focus to click.
    }

    const resolved = await this.sendMessageToTab(
      tabId,
      {
        action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
        ref,
      },
      targetFrameId,
    );

    if (!resolved || resolved.success === false || !resolved.center) {
      throw new Error(`Failed to resolve ref "${ref}" to click coordinates`);
    }

    const rect = resolved.rect || {};
    const nativeCoordinates = getResolvedViewportCoordinates(
      resolved,
      targetFrameId,
    );

    return {
      helperTarget: {
        frameId: targetFrameId,
        ref,
      },
      elementInfo: {
        selector: resolved.selector,
        ref,
        rect,
        frameId: targetFrameId,
        ...(resolved.projectionError
          ? { projectionError: String(resolved.projectionError) }
          : {}),
        clickMethod: args.ref ? 'ref' : 'selector',
      },
      nativeCoordinates,
    };
  }

  /**
   * Execute click operation
   */
  async execute(args: ClickToolParams): Promise<ToolResult> {
    const {
      selector,
      selectorType = 'css',
      coordinates,
      waitForNavigation = false,
      timeout = TIMEOUTS.DEFAULT_WAIT * 5,
      frameId,
      button,
      bubbles,
      cancelable,
      modifiers,
    } = args;

    console.log(`Starting click operation with options:`, args);

    if (!selector && !coordinates && !args.ref) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS +
          ': Provide ref or selector or coordinates',
      );
    }

    try {
      // Resolve tab
      const explicit = await this.tryGetTab(args.tabId);
      const tab =
        explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(
          ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID',
        );
      }
      if (hasDisallowedPublicUrlScheme(String(tab.url || ''))) {
        return createErrorResponse(
          'Only http:// and https:// pages are supported by chrome_click_element',
        );
      }

      const beforeUrl = String(tab.url || '');
      const resolvedTarget = await this.resolveTarget(tab.id, args);
      let navigationOccurred = false;
      let transport: 'cdp' | 'helper' = resolvedTarget.nativeCoordinates
        ? 'cdp'
        : 'helper';
      let elementInfo = resolvedTarget.elementInfo;

      if (resolvedTarget.nativeCoordinates) {
        try {
          await dispatchNativeClick(tab.id, resolvedTarget.nativeCoordinates, {
            button,
            double: args.double === true,
            modifiers,
          });
          if (waitForNavigation) {
            navigationOccurred = await waitForNavigationAfterClick(
              tab.id,
              beforeUrl,
              timeout,
            );
          }
        } catch (cdpError) {
          console.warn(
            '[ClickTool] CDP click failed, falling back to helper',
            cdpError,
          );
          transport = 'helper';
          const helperResult = await dispatchHelperClick(
            this,
            tab.id,
            args,
            resolvedTarget.helperTarget,
          );
          if (helperResult?.error) {
            return createErrorResponse(helperResult.error);
          }
          navigationOccurred = helperResult?.navigationOccurred === true;
          elementInfo = helperResult?.elementInfo || elementInfo;
        }
      } else {
        const helperResult = await dispatchHelperClick(
          this,
          tab.id,
          args,
          resolvedTarget.helperTarget,
        );
        if (helperResult?.error) {
          return createErrorResponse(helperResult.error);
        }
        navigationOccurred = helperResult?.navigationOccurred === true;
        elementInfo = helperResult?.elementInfo || elementInfo;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Click operation successful',
              elementInfo,
              navigationOccurred,
              clickMethod: elementInfo.clickMethod,
              transport,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in click operation:', error);
      return createErrorResponse(
        `Error performing click: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const clickTool = new ClickTool();

interface FillToolParams {
  selector?: string;
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree
  // Accept string | number | boolean for broader form input coverage
  value: string | number | boolean;
  frameId?: number;
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
}

/**
 * Tool for filling form elements on web pages
 */
class FillTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILL;

  /**
   * Execute fill operation
   */
  async execute(args: FillToolParams): Promise<ToolResult> {
    const { selector, selectorType = 'css', ref, value, frameId } = args;

    console.log(`Starting fill operation with options:`, args);

    if (!selector && !ref) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Provide ref or selector',
      );
    }

    if (value === undefined || value === null) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Value must be provided',
      );
    }

    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab =
        explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(
          ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID',
        );
      }
      if (hasDisallowedPublicUrlScheme(String(tab.url || ''))) {
        return createErrorResponse(
          'Only http:// and https:// pages are supported by chrome_fill_or_select',
        );
      }

      let finalRef = ref;
      let finalSelector = selector;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectContentScript(tab.id, [
          'inject-scripts/accessibility-tree-helper.js',
        ]);
        try {
          const resolved = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: true,
            },
            frameId,
          );
          if (resolved && resolved.success && resolved.ref) {
            finalRef = resolved.ref;
            finalSelector = undefined; // Use ref instead of selector
          } else {
            return createErrorResponse(
              `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
            );
          }
        } catch (error) {
          return createErrorResponse(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      await this.injectContentScript(tab.id, ['inject-scripts/fill-helper.js']);

      // Send fill message to content script
      const result = await this.sendMessageToTab(
        tab.id,
        {
          action: TOOL_MESSAGE_TYPES.FILL_ELEMENT,
          selector: finalSelector,
          ref: finalRef,
          value,
        },
        frameId,
      );

      if (result && result.error) {
        return createErrorResponse(result.error);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Fill operation successful',
              elementInfo: result.elementInfo,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in fill operation:', error);
      return createErrorResponse(
        `Error filling element: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const fillTool = new FillTool();
