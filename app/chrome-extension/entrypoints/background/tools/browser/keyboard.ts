import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { hasDisallowedPublicUrlScheme } from './common';

interface KeyboardToolParams {
  keys: string; // Required: string representing keys or key combinations to simulate (e.g., "Enter", "Ctrl+C")
  selector?: string; // Optional: CSS selector or XPath for target element to send keyboard events to
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  delay?: number; // Optional: delay between keystrokes in milliseconds
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  frameId?: number; // target frame id for iframe support
}

/**
 * Tool for simulating keyboard input on web pages
 */
class KeyboardTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.KEYBOARD;

  /**
   * Execute keyboard operation
   */
  async execute(args: KeyboardToolParams): Promise<ToolResult> {
    const { keys, selector, selectorType = 'css', delay = TIMEOUTS.KEYBOARD_DELAY } = args;

    console.log(`Starting keyboard operation with options:`, args);

    if (!keys) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Keys parameter must be provided',
      );
    }

    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }
      if (hasDisallowedPublicUrlScheme(String(tab.url || ''))) {
        return createErrorResponse(
          'Only http:// and https:// pages are supported by chrome_keyboard',
        );
      }

      let finalSelector = selector;
      let refForFocus: string | undefined = undefined;

      // Ensure helper is loaded for XPath or potential focus operations
      await this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);

      // If selector is XPath, convert to ref then try to get CSS selector
      if (selector && selectorType === 'xpath') {
        try {
          // First convert XPath to ref
          const ensured = await this.sendMessageToTab(tab.id, {
            action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
            selector,
            isXPath: true,
          });
          if (!ensured || !ensured.success || !ensured.ref) {
            return createErrorResponse(
              `Failed to resolve XPath selector: ${ensured?.error || 'unknown error'}`,
            );
          }
          refForFocus = ensured.ref;
          // Try to resolve ref to CSS selector
          const resolved = await this.sendMessageToTab(tab.id, {
            action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
            ref: ensured.ref,
          });
          if (resolved && resolved.success && resolved.selector) {
            finalSelector = resolved.selector;
            refForFocus = undefined; // Prefer CSS selector if available
          }
          // If no CSS selector available, we'll use ref to focus below
        } catch (error) {
          return createErrorResponse(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // If we have a ref but no CSS selector, focus the element via helper
      if (refForFocus) {
        const focusResult = await this.sendMessageToTab(tab.id, {
          action: 'focusByRef',
          ref: refForFocus,
        });
        if (focusResult && !focusResult.success) {
          return createErrorResponse(
            `Failed to focus element by ref: ${focusResult.error || 'unknown error'}`,
          );
        }
        // Clear selector so keyboard events go to the focused element
        finalSelector = undefined;
      }

      const frameIds = typeof args.frameId === 'number' ? [args.frameId] : undefined;
      await this.injectContentScript(
        tab.id,
        ['inject-scripts/keyboard-helper.js'],
        false,
        'ISOLATED',
        false,
        frameIds,
      );

      // Send keyboard simulation message to content script
      const result = await this.sendMessageToTab(
        tab.id,
        {
          action: TOOL_MESSAGE_TYPES.SIMULATE_KEYBOARD,
          keys,
          selector: finalSelector,
          delay,
        },
        args.frameId,
      );

      if (result.error) {
        return createErrorResponse(result.error);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Keyboard operation successful',
              targetElement: result.targetElement,
              results: result.results,
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
