/**
 * Quick Panel Commands Handler
 *
 * Handles keyboard shortcuts for Quick Panel functionality.
 * Listens for the 'toggle_quick_panel' command and sends toggle message
 * to the content script in the active tab.
 */

import { PRIVILEGED_UI_SURFACES } from '@/common/message-types';
import {
  startPrivilegedUiSurfaceSession,
  stopPrivilegedUiSurfaceSession,
} from '../privileged-ui-authorization';

// ============================================================
// Constants
// ============================================================

const COMMAND_KEY = 'toggle_quick_panel';
const LOG_PREFIX = '[QuickPanelCommands]';
const quickPanelToggleQueues = new Map<number, Promise<void>>();

// ============================================================
// Helpers
// ============================================================

/**
 * Get the ID of the currently active tab
 */
async function getActiveTabId(): Promise<number | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id ?? null;
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to get active tab:`, err);
    return null;
  }
}

/**
 * Check if a tab can receive content scripts
 */
function isValidTabUrl(url?: string): boolean {
  if (!url) return false;

  // Cannot inject into browser internal pages
  const invalidPrefixes = [
    'chrome://',
    'chrome-extension://',
    'edge://',
    'about:',
    'moz-extension://',
    'devtools://',
    'view-source:',
    'data:',
    // 'file://',
  ];

  return !invalidPrefixes.some((prefix) => url.startsWith(prefix));
}

// ============================================================
// Main Handler
// ============================================================

/**
 * Toggle Quick Panel in the active tab
 */
async function toggleQuickPanelInTabUnlocked(tabId: number): Promise<void> {
  // Get tab info to check URL validity
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isValidTabUrl(tab.url)) {
      console.warn(`${LOG_PREFIX} Cannot inject into tab URL: ${tab.url}`);
      return;
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to get tab info:`, err);
    return;
  }

  // Send toggle message to content script
  let startedSurfaceSessionId: string | null = null;
  try {
    const privilegedSurfaceSessionId = await startPrivilegedUiSurfaceSession(
      PRIVILEGED_UI_SURFACES.QUICK_PANEL,
      tabId,
    );
    startedSurfaceSessionId = privilegedSurfaceSessionId;
    const response = await chrome.tabs.sendMessage(tabId, {
      action: 'toggle_quick_panel',
      privilegedSurfaceSessionId,
    });
    if (response?.success) {
      console.log(`${LOG_PREFIX} Quick Panel toggled, visible: ${response.visible}`);
      if (response.visible !== true) {
        await stopPrivilegedUiSurfaceSession(
          PRIVILEGED_UI_SURFACES.QUICK_PANEL,
          tabId,
          privilegedSurfaceSessionId,
        );
        startedSurfaceSessionId = null;
      }
    } else {
      console.warn(`${LOG_PREFIX} Toggle failed:`, response?.error);
      await stopPrivilegedUiSurfaceSession(
        PRIVILEGED_UI_SURFACES.QUICK_PANEL,
        tabId,
        privilegedSurfaceSessionId,
      );
      startedSurfaceSessionId = null;
    }
  } catch (err) {
    if (startedSurfaceSessionId) {
      await stopPrivilegedUiSurfaceSession(
        PRIVILEGED_UI_SURFACES.QUICK_PANEL,
        tabId,
        startedSurfaceSessionId,
      );
    }
    // Content script may not be loaded yet; this is expected on some pages
    console.warn(
      `${LOG_PREFIX} Failed to send toggle message (content script may not be loaded):`,
      err,
    );
  }
}

async function toggleQuickPanelInActiveTab(): Promise<void> {
  const tabId = await getActiveTabId();
  if (tabId === null) {
    console.warn(`${LOG_PREFIX} No active tab found`);
    return;
  }
  const previous = quickPanelToggleQueues.get(tabId) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(() => toggleQuickPanelInTabUnlocked(tabId));
  const queued = operation.then(
    () => undefined,
    () => undefined,
  );
  quickPanelToggleQueues.set(tabId, queued);
  try {
    await operation;
  } finally {
    if (quickPanelToggleQueues.get(tabId) === queued) quickPanelToggleQueues.delete(tabId);
  }
}

// ============================================================
// Initialization
// ============================================================

/**
 * Initialize Quick Panel keyboard command listener
 */
export function initQuickPanelCommands(): void {
  console.log(`${LOG_PREFIX} initQuickPanelCommands called`);
  chrome.commands.onCommand.addListener(async (command) => {
    console.log(`${LOG_PREFIX} onCommand received:`, command);
    if (command !== COMMAND_KEY) {
      console.log(`${LOG_PREFIX} Command not matched, expected:`, COMMAND_KEY);
      return;
    }
    console.log(`${LOG_PREFIX} Command matched, calling toggleQuickPanelInActiveTab...`);

    try {
      await toggleQuickPanelInActiveTab();
      console.log(`${LOG_PREFIX} toggleQuickPanelInActiveTab completed`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Command handler error:`, err);
    }
  });

  console.log(`${LOG_PREFIX} Command listener registered for: ${COMMAND_KEY}`);
}
