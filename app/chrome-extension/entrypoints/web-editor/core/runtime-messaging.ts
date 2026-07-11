import { PRIVILEGED_UI_SURFACES } from "@/common/message-types";
import { getPrivilegedUiSurfaceSessionId } from "@/utils/privileged-ui-authorization";

/** Send a request from the dedicated Web Editor USER_SCRIPT world. */
export async function sendWebEditorRuntimeMessage<T = unknown>(
  message: Record<string, unknown>,
): Promise<T> {
  const configuredSessionId = getPrivilegedUiSurfaceSessionId(
    PRIVILEGED_UI_SURFACES.WEB_EDITOR,
  );
  const declaredSessionId =
    typeof message.surfaceSessionId === "string" &&
    /^[a-f0-9]{64}$/.test(message.surfaceSessionId)
      ? message.surfaceSessionId
      : null;
  if (
    configuredSessionId &&
    declaredSessionId &&
    configuredSessionId !== declaredSessionId
  ) {
    throw new Error(
      "Web Editor surface session does not match the active runtime",
    );
  }
  const surfaceSessionId = configuredSessionId ?? declaredSessionId;
  if (!surfaceSessionId) {
    throw new Error("Privileged Web Editor session is not active");
  }
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    throw new Error("Chrome runtime messaging is unavailable");
  }
  return (await chrome.runtime.sendMessage({
    ...message,
    surfaceSessionId,
  })) as T;
}
