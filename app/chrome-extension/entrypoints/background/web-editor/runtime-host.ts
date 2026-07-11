import {
  WEB_EDITOR_RUNTIME_COMMAND_GLOBAL,
  WEB_EDITOR_RUNTIME_ENABLEMENT_ERROR,
  WEB_EDITOR_RUNTIME_SCRIPT_PATH,
  WEB_EDITOR_RUNTIME_WORLD_ID,
} from "@/common/web-editor-runtime";
import {
  WEB_EDITOR_ACTIONS,
  type WebEditorPingResponse,
} from "@/common/web-editor-types";

const MAX_RUNTIME_RESPONSE_BYTES = 512 * 1024;
const MAX_RUNTIME_COMMAND_BYTES = 512 * 1024;

interface RuntimeEnvelope {
  kind: "missing" | "response" | "error";
  value?: unknown;
  error?: string;
}

export interface WebEditorRuntimeHandle {
  documentId: string;
  status: WebEditorPingResponse;
}

type UserScriptsApi = Pick<
  typeof chrome.userScripts,
  "configureWorld" | "execute"
>;

let worldConfiguration: Promise<void> | null = null;

function getUserScriptsApi(): UserScriptsApi {
  const api = (
    chrome as typeof chrome & { userScripts?: Partial<UserScriptsApi> }
  ).userScripts;
  if (
    typeof api?.configureWorld !== "function" ||
    typeof api.execute !== "function" ||
    typeof chrome.runtime.onUserScriptMessage?.addListener !== "function"
  ) {
    throw new Error(WEB_EDITOR_RUNTIME_ENABLEMENT_ERROR);
  }
  return api as UserScriptsApi;
}

async function configureRuntimeWorld(): Promise<void> {
  if (!worldConfiguration) {
    worldConfiguration = getUserScriptsApi()
      .configureWorld({
        worldId: WEB_EDITOR_RUNTIME_WORLD_ID,
        messaging: true,
        csp: "script-src 'self'",
      })
      .catch((error) => {
        worldConfiguration = null;
        const detail = error instanceof Error ? error.message.trim() : "";
        throw new Error(
          detail
            ? `${WEB_EDITOR_RUNTIME_ENABLEMENT_ERROR} (${detail})`
            : WEB_EDITOR_RUNTIME_ENABLEMENT_ERROR,
        );
      });
  }
  await worldConfiguration;
}

function serializeCommand(request: unknown): string {
  const serialized = JSON.stringify(request);
  if (serialized === undefined) {
    throw new Error("Web Editor runtime command must be JSON serializable");
  }
  if (
    new TextEncoder().encode(serialized).byteLength > MAX_RUNTIME_COMMAND_BYTES
  ) {
    throw new Error("Web Editor runtime command exceeded the size limit");
  }
  return serialized
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function buildCommandSource(request: unknown): string {
  const serialized = serializeCommand(request);
  return `(async () => {
    const handler = globalThis[${JSON.stringify(WEB_EDITOR_RUNTIME_COMMAND_GLOBAL)}];
    if (typeof handler !== 'function') return { kind: 'missing' };
    try {
      return { kind: 'response', value: await handler(${serialized}) };
    } catch (error) {
      return { kind: 'error', error: String(error?.message || error) };
    }
  })()`;
}

function normalizeInjectionResult(
  results: chrome.userScripts.InjectionResult[],
): chrome.userScripts.InjectionResult {
  if (
    !Array.isArray(results) ||
    results.length !== 1 ||
    results[0]?.frameId !== 0 ||
    typeof results[0]?.documentId !== "string" ||
    !results[0].documentId ||
    results[0].documentId.length > 512
  ) {
    throw new Error("Chrome returned an invalid Web Editor runtime result");
  }
  const result = results[0];
  if (typeof result.error === "string" && result.error.trim()) {
    throw new Error(result.error);
  }
  return result;
}

function normalizeEnvelope(value: unknown): RuntimeEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Web Editor runtime returned an invalid response");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Web Editor runtime returned a non-serializable response");
  }
  if (
    new TextEncoder().encode(serialized).byteLength > MAX_RUNTIME_RESPONSE_BYTES
  ) {
    throw new Error("Web Editor runtime response exceeded the size limit");
  }
  const envelope = value as Partial<RuntimeEnvelope>;
  if (
    envelope.kind !== "missing" &&
    envelope.kind !== "response" &&
    envelope.kind !== "error"
  ) {
    throw new Error("Web Editor runtime returned an invalid response");
  }
  return envelope as RuntimeEnvelope;
}

async function executeCommand(
  tabId: number,
  request: unknown,
  documentId?: string,
): Promise<{ documentId: string; envelope: RuntimeEnvelope }> {
  if (!Number.isSafeInteger(tabId) || tabId < 0) {
    throw new Error("Web Editor runtime requires a valid tab ID");
  }
  await configureRuntimeWorld();
  const results = await getUserScriptsApi().execute({
    target:
      documentId === undefined
        ? { tabId, frameIds: [0] }
        : { tabId, documentIds: [documentId] },
    world: "USER_SCRIPT",
    worldId: WEB_EDITOR_RUNTIME_WORLD_ID,
    injectImmediately: true,
    js: [{ code: buildCommandSource(request) }],
  });
  const result = normalizeInjectionResult(results);
  return {
    documentId: result.documentId,
    envelope: normalizeEnvelope(result.result),
  };
}

function normalizePing(value: unknown): WebEditorPingResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<WebEditorPingResponse>;
  if (
    candidate.status !== "pong" ||
    typeof candidate.active !== "boolean" ||
    !Number.isSafeInteger(candidate.version) ||
    (candidate.version as number) < 0
  ) {
    return null;
  }
  return candidate as WebEditorPingResponse;
}

async function injectRuntime(tabId: number): Promise<string> {
  await configureRuntimeWorld();
  const result = normalizeInjectionResult(
    await getUserScriptsApi().execute({
      target: { tabId, frameIds: [0] },
      world: "USER_SCRIPT",
      worldId: WEB_EDITOR_RUNTIME_WORLD_ID,
      injectImmediately: true,
      js: [{ file: WEB_EDITOR_RUNTIME_SCRIPT_PATH }],
    }),
  );
  return result.documentId;
}

/** Ensure the dedicated runtime exists in the current top-frame document. */
export async function ensureWebEditorRuntime(
  tabId: number,
): Promise<WebEditorRuntimeHandle> {
  const first = await executeCommand(tabId, {
    action: WEB_EDITOR_ACTIONS.PING,
  });
  if (first.envelope.kind === "response") {
    const status = normalizePing(first.envelope.value);
    if (status) return { documentId: first.documentId, status };
  } else if (first.envelope.kind === "error") {
    throw new Error(first.envelope.error || "Web Editor runtime ping failed");
  }

  const documentId = await injectRuntime(tabId);
  const second = await executeCommand(
    tabId,
    { action: WEB_EDITOR_ACTIONS.PING },
    documentId,
  );
  if (second.envelope.kind === "error") {
    throw new Error(second.envelope.error || "Web Editor runtime ping failed");
  }
  const status =
    second.envelope.kind === "response"
      ? normalizePing(second.envelope.value)
      : null;
  if (!status) throw new Error("Web Editor runtime failed to initialize");
  return { documentId: second.documentId, status };
}

/** Execute a bounded background-owned command in the dedicated runtime world. */
export async function sendWebEditorRuntimeCommand<T = unknown>(
  tabId: number,
  request: unknown,
  documentId?: string,
): Promise<T> {
  const result = await executeCommand(tabId, request, documentId);
  if (result.envelope.kind === "missing") {
    throw new Error("Web Editor runtime is not active in this document");
  }
  if (result.envelope.kind === "error") {
    throw new Error(
      result.envelope.error || "Web Editor runtime command failed",
    );
  }
  return result.envelope.value as T;
}
