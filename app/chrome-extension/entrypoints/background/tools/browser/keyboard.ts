import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { hasDisallowedPublicUrlScheme } from './common';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  isCompositeSelector,
  normalizeBrowserTargetRef,
  normalizeBrowserTargetSelector,
  resolveFrameIdForMessageResult,
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
}

const KEY_MODIFIER_MASKS: Record<string, number> = {
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

const KEY_ALIASES: Record<
  string,
  { key: string; code?: string; text?: string }
> = {
  enter: { key: 'Enter', code: 'Enter' },
  return: { key: 'Enter', code: 'Enter' },
  backspace: { key: 'Backspace', code: 'Backspace' },
  delete: { key: 'Delete', code: 'Delete' },
  tab: { key: 'Tab', code: 'Tab' },
  escape: { key: 'Escape', code: 'Escape' },
  esc: { key: 'Escape', code: 'Escape' },
  space: { key: ' ', code: 'Space', text: ' ' },
  pageup: { key: 'PageUp', code: 'PageUp' },
  pagedown: { key: 'PageDown', code: 'PageDown' },
  home: { key: 'Home', code: 'Home' },
  end: { key: 'End', code: 'End' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp' },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown' },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft' },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight' },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTokens(keys: string): string[] {
  return keys
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function resolveKeyDef(token: string): {
  key: string;
  code?: string;
  text?: string;
} {
  const normalized = token.trim().toLowerCase();
  if (KEY_ALIASES[normalized]) {
    return KEY_ALIASES[normalized];
  }
  if (/^f([1-9]|1[0-2])$/.test(normalized)) {
    return { key: normalized.toUpperCase(), code: normalized.toUpperCase() };
  }
  if (normalized.length === 1) {
    const upper = normalized.toUpperCase();
    return { key: upper, code: `Key${upper}`, text: normalized };
  }
  return { key: token.trim() };
}

function getModifierMask(modifiers: string[]): number {
  return modifiers.reduce(
    (mask, modifier) => mask | (KEY_MODIFIER_MASKS[modifier] || 0),
    0,
  );
}

async function dispatchSimpleKey(tabId: number, token: string): Promise<void> {
  const def = resolveKeyDef(token);
  if (def.text && def.text.length === 1) {
    await cdpSessionManager.sendCommand(tabId, 'Input.insertText', {
      text: def.text,
    });
    return;
  }
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: def.key,
    code: def.code,
    text: def.text,
  });
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: def.key,
    code: def.code,
  });
}

async function dispatchChord(tabId: number, chord: string): Promise<void> {
  const parts = chord
    .split('+')
    .map((item) => item.trim())
    .filter(Boolean);
  const modifiers: string[] = [];
  let keyToken = '';

  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (normalized in KEY_MODIFIER_MASKS) {
      modifiers.push(normalized);
    } else {
      keyToken = part;
    }
  }

  const def = resolveKeyDef(keyToken);
  const mask = getModifierMask(modifiers);
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: def.key,
    code: def.code,
    text: def.text,
    modifiers: mask,
  });
  await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: def.key,
    code: def.code,
    modifiers: mask,
  });
}

async function dispatchKeySequence(
  tabId: number,
  keys: string,
  delay: number,
): Promise<void> {
  const tokens = normalizeTokens(keys);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.includes('+')) {
      await dispatchChord(tabId, token);
    } else {
      await dispatchSimpleKey(tabId, token);
    }
    if (delay > 0 && index < tokens.length - 1) {
      await sleep(delay);
    }
  }
}

async function dispatchHelperKeySequence(
  tool: any,
  tabId: number,
  keys: string,
  delay: number,
  selector: string | undefined,
  frameId: number | undefined,
): Promise<any> {
  const frameIds = typeof frameId === 'number' ? [frameId] : undefined;
  await tool.injectContentScript(
    tabId,
    ['inject-scripts/keyboard-helper.js'],
    false,
    'ISOLATED',
    false,
    frameIds,
  );

  return tool.sendMessageToTab(
    tabId,
    {
      action: TOOL_MESSAGE_TYPES.SIMULATE_KEYBOARD,
      keys,
      selector,
      delay,
    },
    frameId,
  );
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
      let refForFocus = normalizeBrowserTargetRef(args.ref);
      let targetFrameId = args.frameId;

      // Ensure helper is loaded for XPath or potential focus operations
      await this.injectContentScript(
        targetTabId,
        ['inject-scripts/accessibility-tree-helper.js'],
        false,
        'ISOLATED',
        false,
        typeof targetFrameId === 'number' ? [targetFrameId] : undefined,
      );

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
          await this.injectContentScript(
            targetTabId,
            ['inject-scripts/accessibility-tree-helper.js'],
            false,
            'ISOLATED',
            false,
            typeof targetFrameId === 'number' ? [targetFrameId] : undefined,
          );
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

      try {
        await cdpSessionManager.attach(targetTabId, 'keyboard');
        try {
          await dispatchKeySequence(targetTabId, keys, delay);
        } finally {
          await cdpSessionManager.detach(targetTabId, 'keyboard');
        }
      } catch (cdpError) {
        console.warn(
          '[KeyboardTool] CDP keyboard dispatch failed, falling back to helper',
          cdpError,
        );
        const helperResult = await dispatchHelperKeySequence(
          this,
          targetTabId,
          keys,
          delay,
          refForFocus ? undefined : finalSelector,
          targetFrameId,
        );

        if (helperResult?.error) {
          return createErrorResponse(helperResult.error);
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message:
                  helperResult.message || 'Keyboard operation successful',
                transport: 'helper',
                selector: finalSelector,
                keys,
              }),
            },
          ],
          isError: false,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Keyboard operation successful',
              transport: 'cdp',
              selector: finalSelector,
              keys,
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
