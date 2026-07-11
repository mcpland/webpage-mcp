/**
 * Quick Panel Content Script
 *
 * This content script manages the Quick Panel AI Chat feature on web pages.
 * It responds to:
 * - Background messages (toggle_quick_panel from keyboard shortcut)
 * - Direct programmatic calls
 *
 * The Quick Panel provides a floating AI chat interface that:
 * - Uses Shadow DOM for style isolation
 * - Streams AI responses in real-time
 * - Supports keyboard shortcuts (Enter to send, Esc to close)
 * - Collects page context (URL, selection) automatically
 */

import { createQuickPanelController, type QuickPanelController } from '@/shared/quick-panel';
import { PRIVILEGED_UI_SURFACES } from '@/common/message-types';
import {
  closePrivilegedUiSurfaceSession,
  configurePrivilegedUiSurfaceSession,
} from '@/utils/privileged-ui-authorization';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',

  main() {
    console.log('[QuickPanelContentScript] Content script loaded on:', window.location.href);
    let controller: QuickPanelController | null = null;

    /**
     * Ensure controller is initialized (lazy initialization)
     */
    function ensureController(): QuickPanelController {
      if (!controller) {
        controller = createQuickPanelController({
          title: 'Agent',
          subtitle: 'Quick Panel',
          placeholder: 'Ask about this page...',
        });
      }
      return controller;
    }

    /**
     * Handle messages from background script
     */
    function handleMessage(
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): boolean | void {
      const msg = message as
        | { action?: string; privilegedSurfaceSessionId?: unknown }
        | undefined;

      if (msg?.action === 'toggle_quick_panel') {
        console.log('[QuickPanelContentScript] Received toggle_quick_panel message');
        try {
          if (
            typeof msg.privilegedSurfaceSessionId !== 'string' ||
            !configurePrivilegedUiSurfaceSession(
              PRIVILEGED_UI_SURFACES.QUICK_PANEL,
              msg.privilegedSurfaceSessionId,
            )
          ) {
            sendResponse({ success: false, error: 'Privileged Quick Panel session is required' });
            return true;
          }
          const ctrl = ensureController();
          ctrl.toggle();
          const visible = ctrl.isVisible();
          if (!visible) {
            void closePrivilegedUiSurfaceSession(PRIVILEGED_UI_SURFACES.QUICK_PANEL);
          }
          console.log('[QuickPanelContentScript] Toggle completed, visible:', visible);
          sendResponse({ success: true, visible });
        } catch (err) {
          void closePrivilegedUiSurfaceSession(PRIVILEGED_UI_SURFACES.QUICK_PANEL);
          console.error('[QuickPanelContentScript] Toggle error:', err);
          sendResponse({ success: false, error: String(err) });
        }
        return true; // Async response
      }

      if (msg?.action === 'show_quick_panel') {
        try {
          if (
            typeof msg.privilegedSurfaceSessionId !== 'string' ||
            !configurePrivilegedUiSurfaceSession(
              PRIVILEGED_UI_SURFACES.QUICK_PANEL,
              msg.privilegedSurfaceSessionId,
            )
          ) {
            sendResponse({ success: false, error: 'Privileged Quick Panel session is required' });
            return true;
          }
          const ctrl = ensureController();
          ctrl.show();
          const visible = ctrl.isVisible();
          if (!visible) {
            void closePrivilegedUiSurfaceSession(PRIVILEGED_UI_SURFACES.QUICK_PANEL);
            sendResponse({ success: false, visible: false, error: 'Quick Panel failed to open' });
          } else {
            sendResponse({ success: true, visible: true });
          }
        } catch (err) {
          void closePrivilegedUiSurfaceSession(PRIVILEGED_UI_SURFACES.QUICK_PANEL);
          console.error('[QuickPanelContentScript] Show error:', err);
          sendResponse({ success: false, error: String(err) });
        }
        return true;
      }

      if (msg?.action === 'hide_quick_panel') {
        try {
          if (controller) {
            controller.hide();
          }
          void closePrivilegedUiSurfaceSession(PRIVILEGED_UI_SURFACES.QUICK_PANEL);
          sendResponse({ success: true });
        } catch (err) {
          console.error('[QuickPanelContentScript] Hide error:', err);
          sendResponse({ success: false, error: String(err) });
        }
        return true;
      }

      if (msg?.action === 'get_quick_panel_status') {
        sendResponse({
          success: true,
          visible: controller?.isVisible() ?? false,
          initialized: controller !== null,
        });
        return true;
      }

      // Not handled
      return false;
    }

    // Register message listener
    chrome.runtime.onMessage.addListener(handleMessage);

    // Cleanup on page unload
    window.addEventListener('unload', () => {
      chrome.runtime.onMessage.removeListener(handleMessage);
      if (controller) {
        controller.dispose();
        controller = null;
      }
      void closePrivilegedUiSurfaceSession(PRIVILEGED_UI_SURFACES.QUICK_PANEL);
    });
  },
});
