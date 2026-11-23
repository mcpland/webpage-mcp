import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { hasDisallowedPublicUrlScheme } from './common';
import { runInNativeMouseQueue } from '../../tab-queue';
import { CANCEL_MOUSE_COORDINATE } from '@/utils/cancelled-mouse';
import { inputSignal, withInputPermit, type BrowserInputContext } from '@/utils/browser-input';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  CdpUnavailableError,
  isTimeoutError,
  PageUnresponsiveError,
  pendingDialogHint,
  runCdpInputWithDialogs,
  withTimeout,
  type CdpInputResult,
  type DialogOutcome,
} from '@/utils/cdp-input';
import { parseDialogResponse, type DialogResponse } from '@/utils/dialog-tracker';
import { parseKeyboardInput } from '@/utils/cdp-keyboard';
import { waitForDownload } from './download';
import { keyboardTool, pressKeysOnFocusedElement } from './keyboard';
import {
  getResolvedViewportCoordinates,
  isCompositeSelector,
  normalizeBrowserTargetSelector,
  qualifyFrameRef,
  resolveFrameIdForMessageResult,
  resolveRefTarget,
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
    dialog?: DialogResponse;
    signal?: AbortSignal;
  },
): Promise<CdpInputResult> {
  const button = options.button || 'left';
  const clickCount = options.double === true ? 2 : 1;
  const modifiers = toModifierMask(options.modifiers);
  const buttonMask = button === 'right' ? 2 : button === 'middle' ? 4 : 1;

  return runCdpInputWithDialogs(
    tabId,
    'click',
    async (dialogSignal) => {
      const signal = options.signal ? AbortSignal.any([options.signal, dialogSignal]) : dialogSignal;
      return runInNativeMouseQueue(tabId, async () => {
        if (signal.aborted) return;
        await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(coordinates.x),
          y: Math.round(coordinates.y),
          button: 'none',
          buttons: 0,
          modifiers,
        }, signal);

        for (let index = 1; index <= clickCount; index += 1) {
          if (signal.aborted) return;
          const position = { x: Math.round(coordinates.x), y: Math.round(coordinates.y), button, modifiers };
          let pressSent = false;
          let releaseSent = false;
          try {
            await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
              ...position, type: 'mousePressed', buttons: buttonMask, clickCount: index,
            }, signal, () => { pressSent = true; });
            signal.throwIfAborted();
            await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
              ...position, type: 'mouseReleased', buttons: 0, clickCount: index,
            }, signal, () => { releaseSent = true; });
          } finally {
            if (pressSent && !releaseSent && signal.aborted) {
              // A cancelled acknowledgement can still represent a delivered press.
              // The document-start observer suppresses activation at this reserved position.
              await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
                x: CANCEL_MOUSE_COORDINATE, y: CANCEL_MOUSE_COORDINATE, button, modifiers,
                type: 'mouseReleased', buttons: 0, clickCount: 0,
              }, AbortSignal.timeout(1_000)).catch(() => {});
            }
          }
        }
      }, signal);
    },
    { dialog: options.dialog },
  );
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
  context?: { signal?: AbortSignal; deadlineAt?: number },
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
  context?.signal?.throwIfAborted();
  return withInputPermit(tabId, frameId, context?.signal, (permit) => tool.sendMessageToTab(
    tabId,
    {
      action: TOOL_MESSAGE_TYPES.CLICK_ELEMENT,
      ...(permit ? { permit } : {}),
      ...(context?.deadlineAt !== undefined ? { deadlineAt: context.deadlineAt } : {}),
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
  ));
}

const HELPER_CLICK_RESPONSE_MARGIN_MS = 2000;

class HelperClickError extends Error {}

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
  background?: boolean; // when true, do not activate tab or focus window
  dialog?: unknown; // how to answer a JavaScript dialog the click opens
  waitForDownload?: unknown; // true | { timeoutMs, filenameContains }
}

const DEFAULT_CLICK_DOWNLOAD_TIMEOUT_MS = 30_000;

function parseWaitForDownload(
  value: unknown,
): { timeoutMs: number; filenameContains?: string } | undefined | Error {
  if (value === undefined || value === null || value === false) return undefined;
  if (value === true) return { timeoutMs: DEFAULT_CLICK_DOWNLOAD_TIMEOUT_MS };
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const timeoutMs =
      record.timeoutMs === undefined ? DEFAULT_CLICK_DOWNLOAD_TIMEOUT_MS : Number(record.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000) {
      return new Error('waitForDownload.timeoutMs must be between 1000 and 300000');
    }
    if (record.filenameContains !== undefined && typeof record.filenameContains !== 'string') {
      return new Error('waitForDownload.filenameContains must be a string');
    }
    return {
      timeoutMs,
      ...(record.filenameContains ? { filenameContains: record.filenameContains } : {}),
    };
  }
  return new Error('waitForDownload must be true or { timeoutMs, filenameContains }');
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
    const { selectorType = 'css', coordinates, frameId } = args;
    const selector = normalizeBrowserTargetSelector(args.selector, selectorType);
    const refTarget = resolveRefTarget(args.ref, frameId);
    let ref = refTarget?.ref;
    let targetFrameId = refTarget ? refTarget.frameId : frameId;

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

    await this.injectAccessibilityHelper(tabId, targetFrameId, {
      allFrames: !ref && isCompositeSelector(selector),
    });

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
      await this.injectAccessibilityHelper(tabId, targetFrameId);
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
        ref: qualifyFrameRef(ref, targetFrameId),
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
  async execute(
    args: ClickToolParams,
    context?: { signal?: AbortSignal; deadlineAt?: number },
  ): Promise<ToolResult> {
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


    if (!selector && !coordinates && !args.ref) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS +
          ': Provide ref or selector or coordinates',
      );
    }
    const dialogResponse = parseDialogResponse(args.dialog);
    if (dialogResponse instanceof Error) {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: ${dialogResponse.message}`,
      );
    }
    const downloadWait = parseWaitForDownload(args.waitForDownload);
    if (downloadWait instanceof Error) {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: ${downloadWait.message}`,
      );
    }
    // Armed right before the click so the download it triggers is caught
    // without racing a separate chrome_handle_download call.
    const downloadAbort = new AbortController();
    const onCallerAbort = () => downloadAbort.abort();
    if (context?.signal) {
      if (context.signal.aborted) downloadAbort.abort();
      else context.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
      const deadline = context?.deadlineAt;
      const signal = inputSignal(context);
      signal?.throwIfAborted();
      // Resolve tab
      const explicit = await this.tryGetTab(args.tabId);
      let tab =
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
      if (args.background !== true) {
        tab = await this.activateTabIfNeeded(tab);
      }
      const targetTabId = tab.id;
      if (!targetTabId) {
        return createErrorResponse(
          ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID',
        );
      }

      const beforeUrl = String(tab.url || '');
      const resolvedTarget = await this.resolveTarget(targetTabId, args);
      signal?.throwIfAborted();
      let navigationOccurred = false;
      let transport: 'cdp' | 'helper' = resolvedTarget.nativeCoordinates
        ? 'cdp'
        : 'helper';
      let elementInfo = resolvedTarget.elementInfo;
      let dialog: DialogOutcome | undefined;
      let dialogs: DialogOutcome[] | undefined;
      let pageUnresponsive = false;

      // The DOM fallback cannot observe dialogs. Bound its wait so a click that
      // opens a modal dialog reports an unresponsive page instead of hanging.
      const runHelperClick = async (): Promise<void> => {
        if (dialogResponse) {
          throw new HelperClickError(
            'Automatic dialog responses require a debugger connection. No fallback click was dispatched.',
          );
        }
        transport = 'helper';
        let helperResult: any;
        try {
          helperResult = await withTimeout(
            dispatchHelperClick(this, targetTabId, args, resolvedTarget.helperTarget, { signal, deadlineAt: deadline }),
            Math.max(Number(timeout) || 0, 0) + HELPER_CLICK_RESPONSE_MARGIN_MS,
            'Page response to the click',
          );
        } catch (error) {
          if (!isTimeoutError(error)) throw error;
          pageUnresponsive = true;
          return;
        }
        if (helperResult?.error) throw new HelperClickError(String(helperResult.error));
        navigationOccurred = helperResult?.navigationOccurred === true;
        if (helperResult?.elementInfo) {
          elementInfo = {
            ...elementInfo,
            ...helperResult.elementInfo,
            ...(elementInfo.ref !== undefined ? { ref: elementInfo.ref } : {}),
            ...(elementInfo.frameId !== undefined ? { frameId: elementInfo.frameId } : {}),
          };
        }
      };

      const pendingDownload = downloadWait
        ? waitForDownload({
            ...downloadWait,
            waitForComplete: true,
            onlyNew: true,
            signal: downloadAbort.signal,
          }).then(
            (download) => ({ download }),
            (error: Error) => ({ downloadError: error.message }),
          )
        : undefined;

      try {
        if (resolvedTarget.nativeCoordinates) {
          try {
            const input = await dispatchNativeClick(
              targetTabId,
              resolvedTarget.nativeCoordinates,
              {
                button,
                double: args.double === true,
                modifiers,
                dialog: dialogResponse,
                signal,
              },
            );
            signal?.throwIfAborted();
            dialog = input.dialog;
            dialogs = input.dialogs;
            if (waitForNavigation && !(dialog && dialog.handled === false)) {
              navigationOccurred = await waitForNavigationAfterClick(
                targetTabId,
                beforeUrl,
                timeout,
              );
            }
          } catch (cdpError) {
            if (cdpError instanceof PageUnresponsiveError) {
              return createErrorResponse(cdpError.message);
            }
            if (!(cdpError instanceof CdpUnavailableError)) {
              return createErrorResponse(
                `CDP click failed: ${cdpError instanceof Error ? cdpError.message : String(cdpError)}`,
              );
            }
            console.warn(
              '[ClickTool] CDP click unavailable, falling back to helper',
              cdpError,
            );
            await runHelperClick();
          }
        } else {
          await runHelperClick();
        }
      } catch (error) {
        if (error instanceof HelperClickError) return createErrorResponse(error.message);
        throw error;
      }

      const warnings: string[] = [];
      if (waitForNavigation && !navigationOccurred && !dialog) {
        warnings.push(
          'waitForNavigation was requested, but the page URL/status did not change before timeout.',
        );
      }
      if (pageUnresponsive) {
        warnings.push(
          'The page stopped responding after the click, which usually means a JavaScript dialog opened. It could not be observed because the debugger was unavailable; ask the user to close it or reload the tab.',
        );
      }
      const pendingDialog = dialog && dialog.handled === false ? dialog : undefined;
      // A dialog or frozen page blocks the tab; don't wait for a download behind it.
      if (pendingDialog || pageUnresponsive) downloadAbort.abort();
      const downloadOutcome =
        pendingDownload && !pendingDialog && !pageUnresponsive ? await pendingDownload : undefined;
      if (downloadOutcome && 'downloadError' in downloadOutcome) {
        warnings.push(`waitForDownload: ${downloadOutcome.downloadError}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: pendingDialog
                ? `Click dispatched. ${pendingDialogHint(pendingDialog)}`
                : waitForNavigation && !navigationOccurred && !dialog
                  ? 'Click dispatched; no navigation was observed before timeout'
                  : 'Click operation successful',
              elementInfo,
              navigationOccurred,
              ...(dialog ? { dialog } : {}),
              ...(dialogs ? { dialogs } : {}),
              ...(downloadOutcome && 'download' in downloadOutcome
                ? { download: downloadOutcome.download }
                : {}),
              warnings: warnings.length > 0 ? warnings : undefined,
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
    } finally {
      // Release the download listener on every exit path (a no-op once settled).
      context?.signal?.removeEventListener('abort', onCallerAbort);
      downloadAbort.abort();
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
  background?: boolean; // when true, do not activate tab or focus window
  submit?: boolean; // press Enter in the field after filling it
  dialog?: unknown; // how to answer a JavaScript dialog the submit opens
  /** Internal: leave the field focused for a following key press (implied by submit). */
  keepFocus?: boolean;
  submitToken?: string;
}

/**
 * Tool for filling form elements on web pages
 */
class FillTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILL;

  async submitFilledElement(tabId: number, frameId: number | undefined, token: string, dialog?: DialogResponse, context?: BrowserInputContext): Promise<CdpInputResult & { submitted: boolean }> {
    const focusTarget = async () => {
      const result = await this.sendMessageToTab(tabId, { action: 'focusFilledTarget', submitToken: token }, frameId);
      if (!result?.success) throw new Error('The filled field could not retain focus for submit');
    };
    try {
      return await pressKeysOnFocusedElement(tabId, 'Enter', focusTarget, dialog, context?.signal);
    } catch (error) {
      if (!(error instanceof CdpUnavailableError) || dialog) throw error;
      const fallback = await keyboardTool.sendHelperSteps(tabId, 'Enter', parseKeyboardInput('Enter'), 0, {
        ...context, frameId, submitToken: token,
      });
      if (fallback.isError) throw new Error(fallback.content.find((block) => block.type === 'text')?.text || 'submit failed');
      return { submitted: true };
    }
  }

  /**
   * Execute fill operation
   */
  async execute(args: FillToolParams, context?: BrowserInputContext): Promise<ToolResult> {
    const { selectorType = 'css', value } = args;
    let selector: string | undefined;
    let ref: string | undefined;
    let frameId = args.frameId;
    try {
      selector = normalizeBrowserTargetSelector(args.selector, selectorType);
      const refTarget = resolveRefTarget(args.ref, args.frameId);
      ref = refTarget?.ref;
      if (refTarget) frameId = refTarget.frameId;
    } catch (error) {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }


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

    const dialogResponse = parseDialogResponse(args.dialog);
    if (dialogResponse instanceof Error) {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: ${dialogResponse.message}`,
      );
    }

    try {
      const signal = inputSignal(context);
      signal?.throwIfAborted();
      const explicit = await this.tryGetTab(args.tabId);
      let tab =
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
      signal?.throwIfAborted();
      if (args.background !== true) {
        tab = await this.activateTabIfNeeded(tab);
      }
      const targetTabId = tab.id;
      if (!targetTabId) {
        return createErrorResponse(
          ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID',
        );
      }

      let finalRef = ref;
      let finalSelector = selector;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectAccessibilityHelper(targetTabId, frameId);
        try {
          const resolved = await this.sendMessageToTab(
            targetTabId,
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

      // The fill helper must live in the frame that owns the target element.
      await this.injectContentScript(
        targetTabId,
        ['inject-scripts/fill-helper.js'],
        false,
        'ISOLATED',
        false,
        typeof frameId === 'number' ? [frameId] : undefined,
      );

      const submitToken = args.submit === true ? crypto.randomUUID() : args.submitToken;
      // Send fill message to content script
      const result = await withInputPermit(targetTabId, frameId, signal, permit => this.sendMessageToTab(
        targetTabId,
        {
          action: TOOL_MESSAGE_TYPES.FILL_ELEMENT,
          ...(permit ? { permit } : {}),
          ...(context?.deadlineAt !== undefined ? { deadlineAt: context.deadlineAt } : {}),
          selector: finalSelector,
          ref: finalRef,
          value,
          ...(submitToken ? { submitToken } : {}),
          ...(args.submit === true || args.keepFocus === true ? { keepFocus: true } : {}),
        },
        frameId,
      ));

      signal?.throwIfAborted();
      if (result && result.error) {
        return createErrorResponse(result.error);
      }

      let submitInput: Awaited<ReturnType<typeof this.submitFilledElement>> | undefined;
      if (args.submit === true && submitToken) {
        try {
          submitInput = await this.submitFilledElement(targetTabId, frameId, submitToken, dialogResponse, { signal, deadlineAt: context?.deadlineAt });
        } catch (error) {
          return createErrorResponse(`The field was filled, but pressing Enter to submit failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const pendingDialog =
        submitInput?.dialog && submitInput.dialog.handled === false ? submitInput.dialog : undefined;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: pendingDialog
                ? `${submitInput?.submitted ? 'Filled and submitted.' : 'Filled without submitting.'} ${pendingDialogHint(pendingDialog)}`
                : result.message || 'Fill operation successful',
              elementInfo: result.elementInfo,
              ...(submitInput ? { submitted: submitInput.submitted } : {}),
              ...(submitInput?.dialog ? { dialog: submitInput.dialog } : {}),
              ...(submitInput?.dialogs ? { dialogs: submitInput.dialogs } : {}),
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
