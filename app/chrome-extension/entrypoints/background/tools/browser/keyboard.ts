import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { hasDisallowedPublicUrlScheme } from './common';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { dispatchKeyStroke, parseKeyboardInput, type KeyboardStep } from '@/utils/cdp-keyboard';
import {
  CdpUnavailableError,
  PageUnresponsiveError,
  isTimeoutError,
  withTimeout,
  pendingDialogHint,
  runCdpInputWithDialogs,
  type CdpInputResult,
} from '@/utils/cdp-input';
import { parseDialogResponse, type DialogResponse } from '@/utils/dialog-tracker';
import {
  isCompositeSelector,
  normalizeBrowserTargetSelector,
  resolveFrameIdForMessageResult,
  resolveRefTarget,
} from './target-resolution';

interface KeyboardToolParams {
  keys: string; // Required: string representing keys or key combinations to simulate (e.g., "Enter", "Ctrl+C")
  selector?: string; // Optional: CSS selector or XPath for target element to send keyboard events to
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Optional element ref from chrome_read_page
  delay?: number; // Optional: delay between keystrokes in milliseconds
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  frameId?: number; // target frame id for iframe support
  background?: boolean; // when true, do not activate tab or focus window
  dialog?: unknown; // how to answer a JavaScript dialog the keys open
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Dispatch `keys` over CDP. Key sequences become real key strokes; any other
 * input is inserted as literal text (see parseKeyboardInput).
 */
export async function dispatchKeySequence(
  tabId: number,
  keys: string,
  delay: number,
  signal?: AbortSignal,
): Promise<void> {
  const steps = parseKeyboardInput(keys);
  const dispatch = (event: Record<string, unknown>) =>
    cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', event);
  for (let index = 0; index < steps.length; index += 1) {
    if (signal?.aborted) return;
    const step = steps[index];
    if (step.kind === 'text') {
      await cdpSessionManager.sendCommand(tabId, 'Input.insertText', {
        text: step.text,
      });
    } else {
      await dispatchKeyStroke(dispatch, step.stroke, { signal });
    }
    if (signal?.aborted) return;
    if (delay > 0 && index < steps.length - 1) {
      await sleep(delay);
    }
  }
}

/**
 * Press `keys` on whatever element has focus (real CDP key events), answering
 * a JavaScript dialog they open as `dialog` says. Used to submit a field
 * right after filling it, in the same tool call.
 */
export function pressKeysOnFocusedElement(
  tabId: number,
  keys: string,
  focusTarget: () => Promise<void>,
  dialog?: DialogResponse,
): Promise<CdpInputResult> {
  return runCdpInputWithDialogs(
    tabId,
    'keyboard',
    async (signal) => {
      await focusTarget();
      if (!signal.aborted) await dispatchKeySequence(tabId, keys, 0, signal);
    },
    { dialog },
  );
}

/**
 * Tool for simulating keyboard input on web pages
 */
class KeyboardTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.KEYBOARD;

  async sendHelperSteps(
    tabId: number,
    keys: string,
    steps: KeyboardStep[],
    delay: number,
    options: { selector?: string; focusedByRef?: boolean; frameId?: number; submitToken?: string; dialog?: DialogResponse } = {},
  ): Promise<ToolResult> {
    const { selector, focusedByRef, frameId, dialog } = options;
    if (dialog) {
      return createErrorResponse('Automatic dialog responses require a debugger connection. No fallback keys were sent.');
    }
    const timeoutMs = 5000 + Math.max(0, delay) * Math.max(0, steps.length - 1);
    const deadline = Date.now() + timeoutMs;
    try {
      const frames = typeof frameId === 'number' ? [frameId] : undefined;
      const dispatch = async () => {
        await this.injectContentScript(tabId, ['inject-scripts/keyboard-helper.js'], false, 'ISOLATED', false, frames);
        if (Date.now() >= deadline) throw new Error('Keyboard helper timed out before dispatch');
        return this.sendMessageToTab(tabId, {
          action: TOOL_MESSAGE_TYPES.SIMULATE_KEYBOARD, keys, steps,
          selector: focusedByRef ? undefined : selector, delay, deadline,
          ...(options.submitToken ? { submitToken: options.submitToken } : {}),
        }, frameId);
      };
      const result = await withTimeout(dispatch(), timeoutMs, 'Keyboard helper');
      if (!result?.success || result.error) {
        return createErrorResponse(result?.error || result?.message || 'Keyboard helper failed');
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: true, message: result.message, transport: 'helper', selector, keys,
        }) }],
        isError: false,
      };
    } catch (error) {
      if (isTimeoutError(error)) {
        return createErrorResponse('Keyboard helper timed out. A dialog may be open; check the page before retrying.');
      }
      return createErrorResponse(`Keyboard helper failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Execute keyboard operation
   */
  async execute(args: KeyboardToolParams): Promise<ToolResult> {
    const {
      keys,
      selector,
      selectorType = 'css',
      delay = TIMEOUTS.KEYBOARD_DELAY,
    } = args;


    if (!keys) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Keys parameter must be provided',
      );
    }
    const dialogResponse = parseDialogResponse(args.dialog);
    if (dialogResponse instanceof Error) {
      return createErrorResponse(
        `${ERROR_MESSAGES.INVALID_PARAMETERS}: ${dialogResponse.message}`,
      );
    }

    try {
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
          'Only http:// and https:// pages are supported by chrome_keyboard',
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

      let finalSelector = normalizeBrowserTargetSelector(selector, selectorType);
      const refTarget = resolveRefTarget(args.ref, args.frameId);
      let refForFocus = refTarget?.ref;
      let targetFrameId = refTarget ? refTarget.frameId : args.frameId;

      // Ensure helper is loaded only when resolving a selector or focusing a ref.
      // Composite selectors (`|>`) bridge from top frame into child iframes.
      if (finalSelector || refForFocus) {
        await this.injectAccessibilityHelper(targetTabId, targetFrameId, {
          allFrames: isCompositeSelector(finalSelector),
        });
      }

      // Resolve any selector to a stable ref first so failures are explicit.
      if (finalSelector) {
        try {
          const selectorFrameId = isCompositeSelector(finalSelector)
            ? undefined
            : targetFrameId;
          const ensured = await this.sendMessageToTab(
            targetTabId,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector: finalSelector,
              isXPath: selectorType === 'xpath',
            },
            selectorFrameId,
          );
          if (!ensured || !ensured.success || !ensured.ref) {
            return createErrorResponse(
              `Failed to resolve ${selectorType === 'xpath' ? 'XPath' : 'selector'}: ${
                ensured?.error || 'unknown error'
              }`,
            );
          }
          targetFrameId = await resolveFrameIdForMessageResult(
            targetTabId,
            targetFrameId,
            ensured,
          );
          await this.injectAccessibilityHelper(targetTabId, targetFrameId);
          refForFocus = ensured.ref;
          // Try to resolve ref to CSS selector
          const resolved = await this.sendMessageToTab(
            targetTabId,
            {
              action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
              ref: ensured.ref,
            },
            targetFrameId,
          );
          if (resolved && resolved.success && resolved.selector) {
            finalSelector = resolved.selector;
          }
        } catch (error) {
          return createErrorResponse(
            `Error resolving ${selectorType === 'xpath' ? 'XPath' : 'selector'}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      if (refForFocus) {
        const focusResult = await this.sendMessageToTab(
          targetTabId,
          {
            action: 'focusByRef',
            ref: refForFocus,
          },
          targetFrameId,
        );
        if (focusResult && !focusResult.success) {
          return createErrorResponse(
            `Failed to focus element by ref: ${focusResult.error || 'unknown error'}`,
          );
        }
      }

      let input: CdpInputResult = {};
      try {
        input = await runCdpInputWithDialogs(
          targetTabId,
          'keyboard',
          (signal) => dispatchKeySequence(targetTabId, keys, delay, signal),
          { dialog: dialogResponse },
        );
      } catch (cdpError) {
        if (cdpError instanceof PageUnresponsiveError) {
          return createErrorResponse(cdpError.message);
        }
        if (!(cdpError instanceof CdpUnavailableError)) {
          return createErrorResponse(
            `CDP keyboard dispatch failed: ${cdpError instanceof Error ? cdpError.message : String(cdpError)}`,
          );
        }
        console.warn(
          '[KeyboardTool] CDP keyboard dispatch unavailable, falling back to helper',
          cdpError,
        );
        return this.sendHelperSteps(
          targetTabId, keys, parseKeyboardInput(keys), delay,
          { selector: finalSelector, focusedByRef: !!refForFocus, frameId: targetFrameId, dialog: dialogResponse },
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message:
                input.dialog && input.dialog.handled === false
                  ? `Keys sent. ${pendingDialogHint(input.dialog)}`
                  : 'Keyboard operation successful',
              transport: 'cdp',
              selector: finalSelector,
              keys,
              ...(input.dialog ? { dialog: input.dialog } : {}),
              ...(input.dialogs ? { dialogs: input.dialogs } : {}),
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in keyboard operation:', error);
      return createErrorResponse(
        `Error simulating keyboard events: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const keyboardTool = new KeyboardTool();
