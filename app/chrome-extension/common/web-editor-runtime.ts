/** Dedicated Chrome USER_SCRIPT world used by the privileged Web Editor runtime. */
export const WEB_EDITOR_RUNTIME_WORLD_ID = "webpage_mcp_web_editor_v1";

/** Global command entrypoint. It is visible only inside the dedicated world. */
export const WEB_EDITOR_RUNTIME_COMMAND_GLOBAL =
  "__MCP_WEB_EDITOR_COMMAND_V1__";

/** WXT unlisted bundle executed inside the dedicated world on demand. */
export const WEB_EDITOR_RUNTIME_SCRIPT_PATH = "web-editor.js";

export const WEB_EDITOR_RUNTIME_ENABLEMENT_ERROR =
  "Web Editor requires Chrome User Scripts. In Chrome 135–137 enable Developer mode; in Chrome 138+ enable Allow User Scripts on the extension details page.";

export type WebEditorRuntimeCommandHandler = (
  request: unknown,
) => Promise<unknown>;

declare global {
  // A string index is used because the same declaration must work for Window
  // and the USER_SCRIPT global without exposing the command to page scripts.
  var __MCP_WEB_EDITOR_COMMAND_V1__: WebEditorRuntimeCommandHandler | undefined;
}
