/** Request/response transport shared by code already running inside the service worker. */
export let nativePort: chrome.runtime.Port | null = null;

interface PendingNativeRequest {
  resolve: (payload: any) => void;
  reject: (reason?: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pendingNativeRequests = new Map<string, PendingNativeRequest>();

function makeRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function setNativePort(
  port: chrome.runtime.Port | null,
  reason = "Native host disconnected",
): void {
  if (port === nativePort) return;
  nativePort = port;
  for (const pending of pendingNativeRequests.values()) {
    clearTimeout(pending.timeoutId);
    pending.reject(new Error(reason));
  }
  pendingNativeRequests.clear();
}

export function settleNativeResponse(
  message: {
    responseToRequestId?: string;
    error?: unknown;
    payload?: unknown;
  } | null,
): boolean {
  const requestId = message?.responseToRequestId;
  if (!requestId) return false;
  const pending = pendingNativeRequests.get(requestId);
  if (!pending) return false;
  clearTimeout(pending.timeoutId);
  pendingNativeRequests.delete(requestId);
  if (message.error) pending.reject(new Error(String(message.error)));
  else pending.resolve(message.payload);
  return true;
}

export async function requestNativeHost(
  type: string,
  payload?: unknown,
  timeoutMs: number = 5000,
): Promise<any> {
  const nativeBridgePort = nativePort;
  if (!nativeBridgePort) {
    throw new Error("Native host not connected");
  }

  const requestId = makeRequestId();
  return await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingNativeRequests.delete(requestId);
      reject(new Error(`Native request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingNativeRequests.set(requestId, { resolve, reject, timeoutId });

    try {
      nativeBridgePort.postMessage({ type, requestId, payload });
    } catch (error) {
      clearTimeout(timeoutId);
      pendingNativeRequests.delete(requestId);
      reject(error);
    }
  });
}

type NativeFileOperation =
  | { action: "prepareFile"; base64Data: string; fileName: string }
  | { action: "cleanupFile"; filePath: string }
  | { action: "analyzeTrace"; traceFilePath: string; insightName?: string };

export function requestNativeFile(
  payload: NativeFileOperation,
  timeoutMs = 30_000,
): Promise<{
  success: boolean;
  filePath?: string;
  error?: string;
  summary?: string;
  insight?: string;
}> {
  return requestNativeHost("file_operation", payload, timeoutMs);
}
