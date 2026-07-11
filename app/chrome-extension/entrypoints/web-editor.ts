/**
 * Web Editor inject-script entrypoint.
 *
 * This is the main entry point for the visual editor, injected into web pages
 * via chrome.scripting.executeScript from the background script.
 *
 * Build output: .output/chrome-mv3/web-editor.js
 */

import { WEB_EDITOR_LOG_PREFIX } from "./web-editor/constants";
import { createWebEditor } from "./web-editor/core/editor";
import { installWebEditorCommandHandler } from "./web-editor/core/message-listener";

export default defineUnlistedScript(() => {
  // Phase 1: Only support top frame
  // Phase 4 will add iframe support via content injection
  if (window !== window.top) {
    return;
  }

  // Singleton guard: prevent multiple instances
  if (window.__MCP_WEB_EDITOR__) {
    console.log(
      `${WEB_EDITOR_LOG_PREFIX} Already installed, skipping initialization`,
    );
    return;
  }

  // Create and expose the API
  const api = createWebEditor();
  window.__MCP_WEB_EDITOR__ = api;

  // Background commands enter through chrome.userScripts.execute in this
  // dedicated world. No tab-wide runtime message can disclose the session.
  installWebEditorCommandHandler(api);

  console.log(`${WEB_EDITOR_LOG_PREFIX} Installed successfully`);
});
