/**
 * Web Editor V2 - Inject Script Entry Point
 *
 * This is the main entry point for the visual editor, injected into web pages
 * via chrome.scripting.executeScript from the background script.
 *
 * Architecture:
 * - Uses WXT's defineUnlistedScript for TypeScript compilation
 * - Exposes API on window.__MCP_WEB_EDITOR_V2__
 * - Communicates with background via chrome.runtime.onMessage
 *
 * Module structure:
 * - web-editor-v2/constants.ts - Configuration values
 * - web-editor-v2/utils/disposables.ts - Resource cleanup
 * - web-editor-v2/ui/shadow-host.ts - Shadow DOM isolation
 * - web-editor-v2/core/editor.ts - Main orchestrator
 * - web-editor-v2/core/message-listener.ts - Background communication
 *
 * Build output: .output/chrome-mv3/web-editor-v2.js
 */

import { WEB_EDITOR_V2_LOG_PREFIX } from './web-editor-v2/constants';
import { createWebEditorV2 } from './web-editor-v2/core/editor';
import { installMessageListener } from './web-editor-v2/core/message-listener';

export default defineUnlistedScript(() => {
  // Phase 1: Only support top frame
  // Phase 4 will add iframe support via content injection
  if (window !== window.top) {
    return;
  }

  // Singleton guard: prevent multiple instances
  if (window.__MCP_WEB_EDITOR_V2__) {
    console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Already installed, skipping initialization`);
    return;
  }

  // Create and expose the API
  const api = createWebEditorV2();
  window.__MCP_WEB_EDITOR_V2__ = api;

  // Install message listener for background communication
  installMessageListener(api);

  console.log(`${WEB_EDITOR_V2_LOG_PREFIX} Installed successfully`);
});
