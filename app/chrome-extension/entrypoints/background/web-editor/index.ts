import {
  BACKGROUND_MESSAGE_TYPES,
  PRIVILEGED_UI_ACTIONS,
} from "@/common/message-types";
import {
  isExtensionPageSender,
  isExtensionRuntimeSender,
} from "@/common/runtime-sender-auth";
import { sanitizeAgentStreamRelayPayload } from "@/common/agent-stream-boundaries";
import {
  WEB_EDITOR_ACTIONS,
  type ElementChangeSummary,
  type WebEditorApplyBatchPayload,
  type WebEditorCancelExecutionResponse,
} from "@/common/web-editor-types";
import { openAgentSetupSidepanel } from "../utils/sidepanel";
import {
  requestAgentRpcFetch,
  subscribeAgentStream,
  unsubscribeAgentStream,
} from "../native-host";
import { consumePrivilegedUiAuthorization } from "../privileged-ui-authorization";
import {
  getDurableAgentRequestOwner,
  listDurableAgentRequestOwners,
  rearmDurableAgentRequestDeadline,
  removeDurableAgentRequestOwner,
  reserveDurableAgentRequestOwner,
  rescheduleDurableAgentRequestOwner,
  requestIdFromDurableAgentAlarm,
  transitionDurableAgentRequestOwner,
  type DurableAgentRequestOwner,
  type DurableAgentRequestPhase,
} from "../agent-request-lifecycle";
import {
  initPropsAgentEarlyInjectionNavigationLifecycle,
  pruneOrphanedPropsAgentEarlyInjections,
  registerPropsAgentEarlyInjection,
  releasePropsAgentEarlyInjection,
} from "./props-early-injection";
import {
  ExecutionStatusCache,
  WEB_EDITOR_STATUS_CACHE_TTL_MS,
  type ExecutionStatusEntry,
} from "./execution-status-cache";
import {
  BoundedPromptBuilder,
  normalizeApplyBatchPayload,
  normalizeApplyPayload,
  normalizeBoundedIdentifier,
  normalizeBoundedPageUrl,
  normalizeCancelExecutionPayload,
  normalizeClearSelectionPayload,
  normalizeHighlightPayload,
  normalizeOpenSourcePayload,
  normalizeRevertPayload,
  normalizeSelectionChangedPayload,
  normalizeSessionStatusIdentifier,
  normalizeStatusQueryMessage,
  normalizeStoredExcludedKeys,
  normalizeTxChangedPayload,
  type NormalizedWebEditorApplyPayload,
} from "./resource-boundaries";

const CONTEXT_MENU_ID = "web_editor_toggle";
const COMMAND_KEY = "toggle_web_editor";

const WEB_EDITOR_CONTENT_MESSAGE_TYPES = new Set<string>([
  BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_PROPS_REGISTER_EARLY_INJECTION,
  BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_OPEN_SOURCE,
  BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED,
  BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_SELECTION_CHANGED,
]);

const WEB_EDITOR_EXTENSION_PAGE_MESSAGE_TYPES = new Set<string>([
  BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TOGGLE,
  BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_CLEAR_SELECTION,
  BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_HIGHLIGHT_ELEMENT,
  BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_REVERT_ELEMENT,
]);

function isWebEditorContentSender(
  sender: chrome.runtime.MessageSender,
): boolean {
  return (
    sender.id === chrome.runtime.id &&
    typeof sender.tab?.id === "number" &&
    sender.frameId === 0
  );
}

function isBackgroundRebroadcast(
  sender: chrome.runtime.MessageSender,
): boolean {
  return (
    sender.id === chrome.runtime.id &&
    sender.tab === undefined &&
    sender.url === undefined &&
    sender.origin === undefined
  );
}

/** Storage key prefix for TX change session data (per-tab isolation) */
const WEB_EDITOR_TX_CHANGED_SESSION_KEY_PREFIX = "web-editor-tx-changed-";
const WEB_EDITOR_SELECTION_SESSION_KEY_PREFIX = "web-editor-selection-";

/** Storage key prefix for excluded element keys (per-tab isolation, managed by sidepanel) */
const WEB_EDITOR_EXCLUDED_KEYS_SESSION_KEY_PREFIX = "web-editor-excluded-keys-";

/** Storage key for the session selected in Agent Setup. */
const STORAGE_KEY_SELECTED_SESSION = "agent-selected-session-id";

// In-memory execution status cache (per requestId)
const executionStatusCache = new ExecutionStatusCache();
const STATUS_CACHE_TTL = WEB_EDITOR_STATUS_CACHE_TTL_MS;
const MAX_EXECUTION_OWNERS = 100;
const MAX_REMOVED_TAB_IDS = 512;
const WEB_EDITOR_CANCEL_RETRY_MS = 30 * 1000;
const WEB_EDITOR_CANCEL_RETRY_MAX_AGE_MS = 30 * 60 * 1000;

interface ExecutionOwner {
  readonly sessionId: string;
  readonly tabId: number;
  readonly frameId: number;
  readonly documentId: string;
  readonly createdAt: number;
  deadlineAt: number;
  phase: DurableAgentRequestPhase;
  status: string;
  message?: string;
  result?: ExecutionStatusEntry["result"];
  updatedAt: number;
}

const executionOwners = new Map<string, ExecutionOwner>();
const removedTabIds = new Set<number>();
const terminalStatusPersistence = new Set<string>();
let initialized = false;
let recoveryPromise: Promise<void> = Promise.resolve();
let recoveryError: Error | null = null;

async function ensureWebEditorRecoveryReady(): Promise<void> {
  await recoveryPromise;
  if (recoveryError) throw recoveryError;
}

function getExecutionSenderScope(
  sender: chrome.runtime.MessageSender,
): Pick<ExecutionOwner, "tabId" | "frameId" | "documentId"> | null {
  const tabId = sender.tab?.id;
  if (
    sender.id !== chrome.runtime.id ||
    typeof tabId !== "number" ||
    sender.frameId !== 0
  ) {
    return null;
  }
  return {
    tabId,
    frameId: 0,
    documentId: typeof sender.documentId === "string" ? sender.documentId : "",
  };
}

function isTerminalExecutionStatus(status: string): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function rememberRemovedTabId(tabId: number): void {
  removedTabIds.add(tabId);
  while (removedTabIds.size > MAX_REMOVED_TAB_IDS) {
    const oldest = removedTabIds.values().next().value as number | undefined;
    if (oldest === undefined) break;
    removedTabIds.delete(oldest);
  }
}

function toDurableWebEditorOwner(
  requestId: string,
  owner: ExecutionOwner,
): DurableAgentRequestOwner {
  return {
    version: 1,
    surface: "web-editor",
    requestId,
    sessionId: owner.sessionId,
    tabId: owner.tabId,
    frameId: owner.frameId,
    documentId: owner.documentId,
    createdAt: owner.createdAt,
    deadlineAt: owner.deadlineAt,
    phase: owner.phase,
    status: owner.status,
    ...(owner.message !== undefined ? { message: owner.message } : {}),
    ...(owner.result !== undefined ? { result: owner.result } : {}),
  };
}

async function rememberExecutionOwner(
  requestId: string,
  sessionId: string,
  sender: chrome.runtime.MessageSender,
): Promise<ExecutionOwner> {
  const scope = getExecutionSenderScope(sender);
  if (!scope) throw new Error("Web Editor request owner is invalid");
  if (
    !executionOwners.has(requestId) &&
    executionOwners.size >= MAX_EXECUTION_OWNERS
  ) {
    throw new Error("Too many active Web Editor request owners");
  }
  const createdAt = Date.now();
  const owner: ExecutionOwner = {
    ...scope,
    sessionId,
    createdAt,
    deadlineAt: createdAt + WEB_EDITOR_SESSION_STATUS_WATCHDOG_MS,
    phase: "reserved",
    status: "starting",
    message: "Preparing Agent request",
    updatedAt: createdAt,
  };

  // The owner and absolute deadline must be durable before /act is sent.
  await reserveDurableAgentRequestOwner(
    toDurableWebEditorOwner(requestId, owner),
  );
  if (removedTabIds.has(scope.tabId)) {
    await removeDurableAgentRequestOwner("web-editor", requestId);
    throw new Error("Web Editor tab closed before the request was sent");
  }

  const previous = executionOwners.get(requestId);
  if (previous && previous.sessionId !== sessionId) {
    void closeSessionStatusSubscription(previous.sessionId, requestId);
  }
  executionOwners.delete(requestId);
  executionOwners.set(requestId, owner);
  executionStatusCache.set(requestId, owner.status, owner.message);
  return owner;
}

function getExecutionOwner(requestId: string): ExecutionOwner | undefined {
  const owner = executionOwners.get(requestId);
  if (owner && owner.deadlineAt <= Date.now()) {
    void handleWebEditorDeadline(requestId);
  }
  return owner;
}

function isExecutionOwner(
  owner: ExecutionOwner,
  sessionId: string,
  sender: chrome.runtime.MessageSender,
): boolean {
  const scope = getExecutionSenderScope(sender);
  return (
    scope !== null &&
    owner.sessionId === sessionId &&
    owner.tabId === scope.tabId &&
    owner.frameId === scope.frameId &&
    owner.documentId === scope.documentId
  );
}

function assertExecutionDispatchable(
  requestId: string,
  sessionId: string,
  sender: chrome.runtime.MessageSender,
): void {
  const owner = executionOwners.get(requestId);
  if (
    !owner ||
    !isExecutionOwner(owner, sessionId, sender) ||
    owner.phase === "terminal" ||
    owner.phase === "cancel-pending"
  ) {
    throw new Error("Web Editor Agent request ended before dispatch.");
  }
}

async function prepareExecutionStreamForDispatch(
  requestId: string,
  sessionId: string,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  let established = false;
  try {
    established = await subscribeToSessionStatus(sessionId, requestId);
  } catch (error) {
    const owner = executionOwners.get(requestId);
    if (
      owner &&
      owner.phase !== "terminal" &&
      owner.phase !== "cancel-pending"
    ) {
      await abandonExecutionOwner(requestId, "stream_subscribe_failed");
    }
    throw error;
  }

  if (!established) {
    const owner = executionOwners.get(requestId);
    if (
      owner &&
      owner.phase !== "terminal" &&
      owner.phase !== "cancel-pending"
    ) {
      await abandonExecutionOwner(requestId, "stream_subscribe_superseded");
    }
    throw new Error("Web Editor Agent stream ended before dispatch.");
  }
  assertExecutionDispatchable(requestId, sessionId, sender);
}

function setExecutionStatus(
  requestId: string,
  status: string,
  message?: string,
  result?: ExecutionStatusEntry["result"],
): void {
  const existing = executionStatusCache.get(requestId);
  if (existing && isTerminalExecutionStatus(existing.status)) return;

  const owner = executionOwners.get(requestId);
  if (owner) {
    const now = Date.now();
    const previousDeadlineAt = owner.deadlineAt;
    owner.updatedAt = now;
    owner.status = status;
    owner.message = message;
    owner.result = result;
    if (isTerminalExecutionStatus(status)) {
      owner.phase = "terminal";
      owner.deadlineAt = now + STATUS_CACHE_TTL;
    } else if (status === "running") {
      owner.phase = "streaming";
    }
    const durableOwner = toDurableWebEditorOwner(requestId, owner);
    const persist =
      owner.deadlineAt === previousDeadlineAt
        ? transitionDurableAgentRequestOwner(durableOwner)
        : rescheduleDurableAgentRequestOwner(durableOwner);
    void persist.catch((error) => {
      console.warn("[WebEditor] Failed to persist execution status", error);
    });
  }
  executionStatusCache.set(requestId, status, message, result);
}

function getExecutionStatus(
  requestId: string,
): ExecutionStatusEntry | undefined {
  return executionStatusCache.get(requestId);
}

export const WEB_EDITOR_MAX_SESSION_STATUS_SUBSCRIPTIONS = 16;
export const WEB_EDITOR_SESSION_STATUS_WATCHDOG_MS = 15 * 60 * 1000;

type SessionStatusWatchdog = ReturnType<typeof globalThis.setTimeout>;

interface SessionStatusConnection {
  readonly subscriptionId: string;
  readonly lastRequestId: string;
  readonly listener: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ) => void;
  readonly watchdog: SessionStatusWatchdog;
}

interface SessionStatusSubscriptionIntent {
  readonly requestId: string;
  readonly subscriptionId: string;
  readonly token: symbol;
  readonly listener: (
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ) => void;
  readonly watchdog: SessionStatusWatchdog;
}

// A session occupies exactly one pending or active lifecycle slot.
const sseConnections = new Map<string, SessionStatusConnection>();
const sseSubscriptionIntents = new Map<
  string,
  SessionStatusSubscriptionIntent
>();

function clearSessionStatusWatchdog(watchdog: SessionStatusWatchdog): void {
  globalThis.clearTimeout(watchdog);
}

function createSessionStatusWatchdog(
  sessionId: string,
  requestId: string,
): SessionStatusWatchdog {
  const deadlineAt =
    executionOwners.get(requestId)?.deadlineAt ??
    Date.now() + WEB_EDITOR_SESSION_STATUS_WATCHDOG_MS;
  return globalThis.setTimeout(
    () => {
      const pending = sseSubscriptionIntents.get(sessionId);
      const active = sseConnections.get(sessionId);
      if (
        pending?.requestId !== requestId &&
        active?.lastRequestId !== requestId
      )
        return;
      if (!executionOwners.has(requestId)) {
        void closeSessionStatusSubscription(sessionId, requestId);
        return;
      }
      void handleWebEditorDeadline(requestId);
    },
    Math.max(1, deadlineAt - Date.now()),
  );
}

export async function closeSessionStatusSubscription(
  sessionId: string,
  requestId?: string,
): Promise<void> {
  const boundedSessionId = normalizeSessionStatusIdentifier(
    sessionId,
    "sessionId",
  );
  const boundedRequestId =
    requestId === undefined
      ? undefined
      : normalizeSessionStatusIdentifier(requestId, "requestId");
  const intent = sseSubscriptionIntents.get(boundedSessionId);
  const subscriptionIds = new Set<string>();
  if (!boundedRequestId || intent?.requestId === boundedRequestId) {
    if (intent) {
      clearSessionStatusWatchdog(intent.watchdog);
      chrome.runtime.onMessage.removeListener(intent.listener);
      subscriptionIds.add(intent.subscriptionId);
    }
    sseSubscriptionIntents.delete(boundedSessionId);
  }

  const existing = sseConnections.get(boundedSessionId);
  if (
    existing &&
    (!boundedRequestId || existing.lastRequestId === boundedRequestId)
  ) {
    // Relinquish ownership before awaiting so a replacement cannot be deleted
    // by this older close operation after it finishes.
    sseConnections.delete(boundedSessionId);
    clearSessionStatusWatchdog(existing.watchdog);
    chrome.runtime.onMessage.removeListener(existing.listener);
    subscriptionIds.add(existing.subscriptionId);
  }

  await Promise.all(
    [...subscriptionIds].map((subscriptionId) =>
      unsubscribeAgentStream(subscriptionId).catch(() => {}),
    ),
  );
}

/** Start a bounded SSE subscription for a session to receive status updates. */
export async function subscribeToSessionStatus(
  sessionId: string,
  requestId: string,
): Promise<boolean> {
  const boundedSessionId = normalizeSessionStatusIdentifier(
    sessionId,
    "sessionId",
  );
  const boundedRequestId = normalizeSessionStatusIdentifier(
    requestId,
    "requestId",
  );
  const hasExistingSlot =
    sseSubscriptionIntents.has(boundedSessionId) ||
    sseConnections.has(boundedSessionId);
  if (
    !hasExistingSlot &&
    sseSubscriptionIntents.size + sseConnections.size >=
      WEB_EDITOR_MAX_SESSION_STATUS_SUBSCRIPTIONS
  ) {
    throw new Error("Too many Web Editor status subscriptions");
  }

  const previousIntent = sseSubscriptionIntents.get(boundedSessionId);
  if (previousIntent) {
    sseSubscriptionIntents.delete(boundedSessionId);
    clearSessionStatusWatchdog(previousIntent.watchdog);
    chrome.runtime.onMessage.removeListener(previousIntent.listener);
  }

  const existing = sseConnections.get(boundedSessionId);
  if (existing) {
    sseConnections.delete(boundedSessionId);
    clearSessionStatusWatchdog(existing.watchdog);
    chrome.runtime.onMessage.removeListener(existing.listener);
  }

  const requestedSubscriptionId = normalizeSessionStatusIdentifier(
    `web-editor-${boundedSessionId}-${boundedRequestId}`,
    "subscriptionId",
    "subscription",
  );
  const onMessage = (
    message: unknown,
    sender: chrome.runtime.MessageSender,
  ): void => {
    if (!isExtensionRuntimeSender(sender)) return;
    const msg = message as {
      type?: string;
      payload?: { subscriptionId?: string; event?: unknown };
    };
    if (msg?.type !== BACKGROUND_MESSAGE_TYPES.AGENT_STREAM_EVENT) return;
    const relay = sanitizeAgentStreamRelayPayload(msg.payload);
    if (relay?.subscriptionId !== requestedSubscriptionId) return;
    handleSseEvent(boundedSessionId, boundedRequestId, relay.event);
  };
  const intent: SessionStatusSubscriptionIntent = {
    requestId: boundedRequestId,
    subscriptionId: requestedSubscriptionId,
    token: Symbol(boundedRequestId),
    listener: onMessage,
    watchdog: createSessionStatusWatchdog(boundedSessionId, boundedRequestId),
  };
  sseSubscriptionIntents.set(boundedSessionId, intent);
  // The ID is deterministic, so the relay listener can be installed before
  // native subscription establishment and cannot miss an immediate event.
  chrome.runtime.onMessage.addListener(onMessage);

  await Promise.all(
    [previousIntent?.subscriptionId, existing?.subscriptionId]
      .filter((value): value is string => typeof value === "string")
      .map((subscriptionId) =>
        unsubscribeAgentStream(subscriptionId).catch(() => {}),
      ),
  );
  if (sseSubscriptionIntents.get(boundedSessionId)?.token !== intent.token)
    return false;

  setExecutionStatus(boundedRequestId, "starting", "Connecting to Agent...");
  let subscriptionId: string | undefined;
  try {
    const subscription = await subscribeAgentStream(boundedSessionId, {
      subscriptionId: requestedSubscriptionId,
    });
    const boundedSubscriptionId = normalizeSessionStatusIdentifier(
      subscription.subscriptionId,
      "subscriptionId",
      "subscription",
    );
    subscriptionId = boundedSubscriptionId;

    if (boundedSubscriptionId !== requestedSubscriptionId) {
      await unsubscribeAgentStream(boundedSubscriptionId).catch(() => {});
      throw new Error("Native stream returned a mismatched subscriptionId");
    }

    if (sseSubscriptionIntents.get(boundedSessionId)?.token !== intent.token) {
      await unsubscribeAgentStream(boundedSubscriptionId).catch(() => {});
      return false;
    }

    sseSubscriptionIntents.delete(boundedSessionId);
    sseConnections.set(boundedSessionId, {
      subscriptionId: boundedSubscriptionId,
      lastRequestId: boundedRequestId,
      listener: onMessage,
      watchdog: intent.watchdog,
    });
    setExecutionStatus(boundedRequestId, "running", "Agent processing...");
    return true;
  } catch (error) {
    let ownedFailure = false;
    const pending = sseSubscriptionIntents.get(boundedSessionId);
    if (pending?.token === intent.token) {
      ownedFailure = true;
      sseSubscriptionIntents.delete(boundedSessionId);
      clearSessionStatusWatchdog(pending.watchdog);
      chrome.runtime.onMessage.removeListener(pending.listener);
    }
    const active = sseConnections.get(boundedSessionId);
    if (subscriptionId && active?.subscriptionId === subscriptionId) {
      ownedFailure = true;
      sseConnections.delete(boundedSessionId);
      clearSessionStatusWatchdog(active.watchdog);
      chrome.runtime.onMessage.removeListener(active.listener);
    }
    await Promise.all(
      [
        ...new Set(
          [requestedSubscriptionId, subscriptionId].filter(Boolean) as string[],
        ),
      ].map((id) => unsubscribeAgentStream(id).catch(() => {})),
    );
    if (!ownedFailure) return false;
    throw error;
  }
}

async function finalizeWebEditorExecution(
  sessionId: string,
  requestId: string,
  status: "completed" | "failed" | "cancelled",
  message: string | undefined,
  result?: ExecutionStatusEntry["result"],
): Promise<void> {
  if (terminalStatusPersistence.has(requestId)) return;
  const owner = executionOwners.get(requestId);
  if (!owner || owner.phase === "terminal") return;

  const previousOwner = { ...owner };
  const previousStatus = executionStatusCache.get(requestId);
  terminalStatusPersistence.add(requestId);
  const now = Date.now();
  owner.phase = "terminal";
  owner.status = status;
  owner.message = message;
  owner.result = result;
  owner.updatedAt = now;
  owner.deadlineAt = now + STATUS_CACHE_TTL;
  executionStatusCache.set(requestId, status, message, result);

  try {
    await rescheduleDurableAgentRequestOwner(
      toDurableWebEditorOwner(requestId, owner),
    );
    await closeSessionStatusSubscription(sessionId, requestId);
  } catch (error) {
    Object.assign(owner, previousOwner);
    executionStatusCache.delete(requestId);
    if (previousStatus) {
      executionStatusCache.set(
        requestId,
        previousStatus.status,
        previousStatus.message,
        previousStatus.result,
      );
    }
    console.warn(
      "[WebEditor] Failed to persist terminal execution status",
      error,
    );
  } finally {
    terminalStatusPersistence.delete(requestId);
  }
}

/**
 * Handle SSE event from Agent stream
 */
function handleSseEvent(
  sessionId: string,
  requestId: string,
  event: unknown,
): void {
  if (!event || typeof event !== "object") return;
  const e = event as Record<string, unknown>;
  const type = e.type;
  const data = e.data as Record<string, unknown> | undefined;

  // Check if this event is for our request
  const eventRequestId = data?.requestId as string | undefined;
  if (eventRequestId !== requestId) return;

  if (type === "status" && data) {
    const status = data.status as string;
    const message = data.message as string | undefined;
    // Map Agent status to our status
    // - 'ready' -> 'running' (ready is a running sub-state)
    // - 'error' -> 'failed' (normalize server 'error' to UI 'failed')
    let mappedStatus = status;
    if (status === "ready") mappedStatus = "running";
    if (status === "error") mappedStatus = "failed";

    if (
      mappedStatus === "completed" ||
      mappedStatus === "failed" ||
      mappedStatus === "cancelled"
    ) {
      void finalizeWebEditorExecution(
        sessionId,
        requestId,
        mappedStatus,
        message,
      );
    } else {
      setExecutionStatus(requestId, mappedStatus, message);
    }
  } else if (type === "message" && data) {
    // Update status to show we're receiving messages
    const cached = getExecutionStatus(requestId);
    if (cached && cached.status === "starting") {
      setExecutionStatus(requestId, "running", "Agent is working...");
    }

    // Check for completion indicators in message content
    const role = data.role as string | undefined;
    const isFinal = data.isFinal as boolean | undefined;
    if (role === "assistant" && isFinal) {
      const content = data.content as string | undefined;
      void finalizeWebEditorExecution(
        sessionId,
        requestId,
        "completed",
        "Completed",
        {
          success: true,
          summary: content?.slice(0, 200),
        },
      );
    }
  } else if (type === "error") {
    const errorMsg = (e.error as string) || "Unknown error";
    void finalizeWebEditorExecution(sessionId, requestId, "failed", errorMsg, {
      success: false,
      error: errorMsg,
    });
  }
}

function createWebEditorRequestId(): string {
  const cryptoApi = globalThis.crypto;
  const id = cryptoApi?.randomUUID?.();
  if (id) return id;
  if (!cryptoApi?.getRandomValues)
    throw new Error("Secure request ID generation is unavailable");
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  return `web-editor-${[...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function cancelWebEditorRequest(
  sessionId: string,
  requestId: string,
): Promise<"confirmed" | "unknown"> {
  try {
    const response = await requestAgentRpcFetch({
      operation: "agent.chat.cancelRequest",
      params: { sessionId, requestId },
    });
    return response.ok || response.statusCode === 404 ? "confirmed" : "unknown";
  } catch {
    return "unknown";
  }
}

async function abandonExecutionOwner(
  requestId: string,
  reason: string,
): Promise<void> {
  const owner = executionOwners.get(requestId);
  executionOwners.delete(requestId);
  executionStatusCache.delete(requestId);
  if (owner) {
    await closeSessionStatusSubscription(owner.sessionId, requestId);
  }
  await removeDurableAgentRequestOwner("web-editor", requestId).catch(() => {});
  console.debug(
    `[WebEditor] Abandoned execution owner ${requestId} (${reason})`,
  );
}

function restoreExecutionOwner(
  owner: DurableAgentRequestOwner,
): ExecutionOwner {
  const restored: ExecutionOwner = {
    sessionId: owner.sessionId,
    tabId: owner.tabId,
    frameId: owner.frameId,
    documentId: owner.documentId,
    createdAt: owner.createdAt,
    deadlineAt: owner.deadlineAt,
    phase: owner.phase,
    status: owner.status,
    message: owner.message,
    result: owner.result,
    updatedAt: Date.now(),
  };
  executionOwners.set(owner.requestId, restored);
  executionStatusCache.set(
    owner.requestId,
    owner.status,
    owner.message,
    owner.result,
  );
  return restored;
}

async function isWebEditorOwnerDocumentAlive(
  owner: DurableAgentRequestOwner,
): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(owner.tabId);
    if (!tab || typeof tab.id !== "number") return false;
    const getFrame = chrome.webNavigation?.getFrame;
    if (!owner.documentId || typeof getFrame !== "function") return false;
    const frame = await getFrame({
      tabId: owner.tabId,
      frameId: owner.frameId,
    });
    const currentDocumentId = (frame as { documentId?: string } | null)
      ?.documentId;
    return currentDocumentId === owner.documentId;
  } catch {
    return false;
  }
}

async function terminalizeExecutionOwner(
  requestId: string,
  status: "failed" | "cancelled",
  message: string,
): Promise<void> {
  const owner = executionOwners.get(requestId);
  if (!owner) return;
  await finalizeWebEditorExecution(
    owner.sessionId,
    requestId,
    status,
    message,
    {
      success: false,
      error: message,
    },
  );
}

async function beginWebEditorCancellation(
  requestId: string,
  reason: string,
  confirmedStatus: "failed" | "cancelled",
  confirmedMessage: string,
): Promise<"confirmed" | "unknown" | "expired"> {
  let owner = executionOwners.get(requestId);
  if (!owner) {
    const durable = await getDurableAgentRequestOwner("web-editor", requestId);
    if (!durable) return "confirmed";
    owner = restoreExecutionOwner(durable);
  }
  if (owner.phase === "terminal") return "confirmed";

  const now = Date.now();
  const hardExpiry = owner.createdAt + WEB_EDITOR_CANCEL_RETRY_MAX_AGE_MS;
  const previousOwner = { ...owner };
  if (now >= hardExpiry) {
    owner.phase = "terminal";
    owner.status = "failed";
    owner.message =
      "Unable to confirm Agent cancellation before the retry deadline.";
    owner.result = { success: false, error: owner.message };
    owner.updatedAt = now;
    owner.deadlineAt = now + STATUS_CACHE_TTL;
    try {
      await rescheduleDurableAgentRequestOwner(
        toDurableWebEditorOwner(requestId, owner),
      );
    } catch (error) {
      Object.assign(owner, previousOwner);
      throw error;
    }
    executionStatusCache.set(
      requestId,
      owner.status,
      owner.message,
      owner.result,
    );
    await closeSessionStatusSubscription(owner.sessionId, requestId);
    return "expired";
  }
  const previousDeadlineAt = owner.deadlineAt;
  owner.phase = "cancel-pending";
  owner.status = "running";
  owner.message = "Agent request was interrupted; cancellation is pending.";
  owner.result = undefined;
  owner.updatedAt = now;
  owner.deadlineAt = Math.min(hardExpiry, now + WEB_EDITOR_CANCEL_RETRY_MS);
  const durableOwner = toDurableWebEditorOwner(requestId, owner);
  try {
    if (owner.deadlineAt === previousDeadlineAt) {
      await transitionDurableAgentRequestOwner(durableOwner);
    } else {
      await rescheduleDurableAgentRequestOwner(durableOwner);
    }
  } catch (error) {
    Object.assign(owner, previousOwner);
    throw error;
  }
  executionStatusCache.set(requestId, owner.status, owner.message);
  await closeSessionStatusSubscription(owner.sessionId, requestId);

  const outcome = await cancelWebEditorRequest(owner.sessionId, requestId);
  if (outcome === "confirmed") {
    await terminalizeExecutionOwner(
      requestId,
      confirmedStatus,
      confirmedMessage,
    );
  } else {
    console.debug(`[WebEditor] Cancellation remains pending (${reason})`);
  }
  return outcome;
}

async function handleWebEditorDeadline(requestId: string): Promise<void> {
  let owner = executionOwners.get(requestId);
  if (!owner) {
    const durable = await getDurableAgentRequestOwner("web-editor", requestId);
    if (!durable) return;
    owner = restoreExecutionOwner(durable);
  }

  if (owner.phase === "terminal") {
    executionOwners.delete(requestId);
    executionStatusCache.delete(requestId);
    await removeDurableAgentRequestOwner("web-editor", requestId);
    return;
  }
  if (owner.deadlineAt > Date.now()) {
    await rearmDurableAgentRequestDeadline(
      toDurableWebEditorOwner(requestId, owner),
    );
    return;
  }

  await beginWebEditorCancellation(
    requestId,
    "deadline",
    "failed",
    "Agent request timed out or was interrupted by a background restart.",
  );
}

async function recoverWebEditorRequests(): Promise<void> {
  const durableOwners = await listDurableAgentRequestOwners("web-editor");
  for (const durable of durableOwners) {
    if (durable.deadlineAt <= Date.now()) {
      if (durable.phase === "terminal") {
        await removeDurableAgentRequestOwner("web-editor", durable.requestId);
        continue;
      }
      restoreExecutionOwner(durable);
      await beginWebEditorCancellation(
        durable.requestId,
        "expired_during_restart",
        "failed",
        "Agent request expired while the background worker was unavailable.",
      );
      continue;
    }

    if (!(await isWebEditorOwnerDocumentAlive(durable))) {
      if (durable.phase !== "terminal") {
        restoreExecutionOwner(durable);
        const outcome = await beginWebEditorCancellation(
          durable.requestId,
          "orphaned_document",
          "failed",
          "Web Editor request owner is no longer available.",
        );
        if (outcome !== "confirmed") continue;
      }
      await removeDurableAgentRequestOwner("web-editor", durable.requestId);
      continue;
    }

    restoreExecutionOwner(durable);
    await rearmDurableAgentRequestDeadline(durable);
    if (durable.phase === "terminal") continue;
    await beginWebEditorCancellation(
      durable.requestId,
      "worker_restart",
      "failed",
      "Agent request was interrupted by a background restart.",
    );
  }
}

/** Script path for the active editor runtime (WXT unlisted script output). */
const WEB_EDITOR_SCRIPT_PATH = "web-editor.js";

/** Script path for Phase 7 props agent (MAIN world) */
const PROPS_AGENT_SCRIPT_PATH = "inject-scripts/props-agent.js";

/**
 * Build a batch prompt for multiple element changes.
 * Designed for Agent session integration to apply multiple visual edits at once.
 */
function buildAgentPromptBatch(
  elements: readonly ElementChangeSummary[],
  pageUrl: string,
): string {
  const lines = new BoundedPromptBuilder();

  // Header
  lines.push("You are a senior frontend engineer working in a local codebase.");
  lines.push(
    "Goal: persist a batch of visual edits from the browser into the source code with minimal changes.",
  );
  lines.push("");

  // Page context
  lines.push(`Page URL: ${pageUrl}`);
  lines.push("");

  lines.push("## Batch Changes");
  lines.push(`Total elements: ${elements.length}`);
  lines.push("");
  lines.push(
    'For each element, prefer "source" (file/line/component) when available; otherwise use selectors/fingerprint to locate it.',
  );
  lines.push("");

  // Element details
  elements.forEach((element, index) => {
    const title = element.fullLabel || element.label || element.elementKey;
    lines.push(`### ${index + 1}. ${title}`);
    lines.push(`- elementKey: ${element.elementKey}`);
    lines.push(`- change type: ${element.type}`);

    // Debug source (high-confidence location)
    const ds = element.debugSource ?? element.locator?.debugSource;
    if (ds?.file) {
      const loc = ds.line
        ? `${ds.file}:${ds.line}${ds.column ? `:${ds.column}` : ""}`
        : ds.file;
      lines.push(
        `- source: ${loc}${ds.componentName ? ` (${ds.componentName})` : ""}`,
      );
    }

    // Locator hints for fallback
    if (element.locator?.selectors?.length) {
      lines.push("- selectors:");
      for (const sel of element.locator.selectors.slice(0, 5)) {
        lines.push(`  - ${sel}`);
      }
    }
    if (element.locator?.fingerprint) {
      lines.push(`- fingerprint: ${element.locator.fingerprint}`);
    }
    if (
      Array.isArray(element.locator?.path) &&
      element.locator.path.length > 0
    ) {
      lines.push(`- path: ${JSON.stringify(element.locator.path)}`);
    }
    if (element.locator?.shadowHostChain?.length) {
      lines.push(
        `- shadowHostChain: ${JSON.stringify(element.locator.shadowHostChain)}`,
      );
    }
    lines.push("");

    // Net effect details
    const net = element.netEffect;
    lines.push("#### Net Effect (apply these final values)");

    if (net.textChange) {
      lines.push("##### Text");
      lines.push(`- before: ${JSON.stringify(net.textChange.before)}`);
      lines.push(`- after: ${JSON.stringify(net.textChange.after)}`);
      lines.push("");
    }

    if (net.classChanges) {
      lines.push("##### Classes");
      lines.push(`- before: ${net.classChanges.before.join(" ")}`);
      lines.push(`- after: ${net.classChanges.after.join(" ")}`);
      lines.push("");
    }

    if (net.styleChanges) {
      lines.push("##### Styles (before → after)");
      const before = net.styleChanges.before ?? {};
      const after = net.styleChanges.after ?? {};
      const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const key of Array.from(allKeys).sort()) {
        const beforeVal = before[key] ?? "(unset)";
        const afterRaw = Object.prototype.hasOwnProperty.call(after, key)
          ? after[key]
          : "(unset)";
        const afterVal = afterRaw === "" ? "(removed)" : afterRaw;
        if (beforeVal !== afterVal) {
          lines.push(`- ${key}: "${beforeVal}" → "${afterVal}"`);
        }
      }
      lines.push("");
    }

    // Fallback message if no specific changes
    if (!net.textChange && !net.classChanges && !net.styleChanges) {
      lines.push(
        "- No net effect details available; use locator hints to inspect the element in code.",
      );
      lines.push("");
    }
  });

  // Instructions
  lines.push("## How to Apply");
  lines.push(
    '1. Use "source" when available to go directly to the component file.',
  );
  lines.push(
    "2. Otherwise, use selectors/fingerprint/path to locate the element in the codebase.",
  );
  lines.push(
    "3. Apply the net effect with minimal changes and correct styling conventions.",
  );
  lines.push("4. Avoid generated/bundled outputs; update source files only.");
  lines.push("");

  // Output format
  lines.push("## Constraints");
  lines.push("- Make the smallest safe edit possible for each element");
  lines.push(
    "- If Tailwind/CSS Modules/styled-components are used, update the correct styling source",
  );
  lines.push("- Do not change unrelated behavior or formatting");
  lines.push("");

  lines.push(
    "## Output\nApply all the changes in the repo, then reply with a short summary of what file(s) you modified and the exact changes made.",
  );

  return lines.build();
}

function buildAgentPrompt(payload: NormalizedWebEditorApplyPayload): string {
  const lines = new BoundedPromptBuilder();

  // Header
  lines.push("You are a senior frontend engineer working in a local codebase.");
  lines.push(
    "Goal: persist a visual edit from the browser into the source code with minimal changes.",
  );
  lines.push("");

  // Page context
  lines.push(`Page URL: ${payload.pageUrl}`);
  lines.push("");

  // == Source Location (high-confidence if debugSource available) ==
  const ds = payload.debugSource;
  if (ds?.file) {
    lines.push("## Source Location (from framework debug info)");
    const loc = ds.line
      ? `${ds.file}:${ds.line}${ds.column ? `:${ds.column}` : ""}`
      : ds.file;
    lines.push(`- file: ${loc}`);
    if (ds.componentName) lines.push(`- component: ${ds.componentName}`);
    lines.push("");
    lines.push(
      "This is high-confidence source location extracted from framework debug info.",
    );
    lines.push(
      "Start your search here. Only fall back to fingerprint if this file is invalid.",
    );
    lines.push("");
  } else if (payload.targetFile) {
    lines.push(`## Target File (best-effort): ${payload.targetFile}`);
    lines.push(
      "If this path is invalid or points to node_modules, fall back to fingerprint search.",
    );
    lines.push("");
  }

  // == Element Fingerprint ==
  lines.push("## Element Fingerprint");
  lines.push(`- tag: ${payload.fingerprint.tag}`);
  if (payload.fingerprint.id) lines.push(`- id: ${payload.fingerprint.id}`);
  if (payload.fingerprint.classes?.length) {
    lines.push(`- classes: ${payload.fingerprint.classes.join(" ")}`);
  }
  if (payload.fingerprint.text)
    lines.push(`- text: ${payload.fingerprint.text}`);
  lines.push("");

  // == CSS Selectors (for precise matching) ==
  if (payload.selectorCandidates?.length) {
    lines.push("## CSS Selectors (ordered by specificity)");
    for (const sel of payload.selectorCandidates.slice(0, 5)) {
      lines.push(`- ${sel}`);
    }
    lines.push("");
    lines.push(
      "Use these selectors to grep the codebase if file location is unavailable.",
    );
    lines.push("");
  }

  // == Tech Stack ==
  if (payload.techStackHint?.length) {
    lines.push(`## Tech Stack: ${payload.techStackHint.join(", ")}`);
    lines.push("");
  }

  // == Requested Change ==
  lines.push("## Requested Change");
  lines.push(`- type: ${payload.instruction.type}`);
  lines.push(`- description: ${payload.instruction.description}`);

  if (
    payload.instruction.type === "update_text" &&
    payload.instruction.text !== undefined
  ) {
    lines.push(`- new text: ${JSON.stringify(payload.instruction.text)}`);
  }

  // For style updates, show detailed before/after diff if available
  if (payload.instruction.type === "update_style") {
    const op = payload.operation;
    if (
      op &&
      (Object.keys(op.before).length > 0 || Object.keys(op.after).length > 0)
    ) {
      lines.push("");
      lines.push("### Style Changes (before → after)");
      const allKeys = new Set([
        ...Object.keys(op.before),
        ...Object.keys(op.after),
      ]);
      for (const key of allKeys) {
        const before = op.before[key] ?? "(unset)";
        const after = op.after[key] ?? "(removed)";
        if (before !== after) {
          lines.push(`  ${key}: "${before}" → "${after}"`);
        }
      }
      if (op.removed.length > 0) {
        lines.push(`  [Removed]: ${op.removed.join(", ")}`);
      }
    } else if (payload.instruction.style) {
      lines.push(
        `- style map: ${JSON.stringify(payload.instruction.style, null, 2)}`,
      );
    }
  }
  lines.push("");

  // == Instructions ==
  lines.push("## How to Apply");
  if (ds?.file) {
    lines.push(`1. Open ${ds.file}${ds.line ? ` around line ${ds.line}` : ""}`);
    if (ds.componentName) {
      lines.push(`2. Locate the "${ds.componentName}" component definition`);
    }
    lines.push(
      `3. Find the element matching tag="${payload.fingerprint.tag}"${payload.fingerprint.classes?.length ? ` with classes including "${payload.fingerprint.classes[0]}"` : ""}`,
    );
    lines.push("4. Apply the requested style/text change");
  } else if (payload.targetFile) {
    lines.push(`1. Open ${payload.targetFile}`);
    lines.push(
      "2. Search for the element by matching fingerprint (tag, classes, text)",
    );
    lines.push(
      "3. If not found, use repo-wide search with selectors or class names",
    );
    lines.push("4. Apply the requested change");
  } else {
    lines.push(
      "1. Use repo-wide search (rg) with class names or text from fingerprint",
    );
    if (payload.selectorCandidates?.length) {
      lines.push(`2. Try searching for: "${payload.selectorCandidates[0]}"`);
    }
    lines.push("3. Locate the component/template containing this element");
    lines.push("4. Apply the requested change");
  }
  lines.push("");

  // == Constraints ==
  lines.push("## Constraints");
  lines.push("- Make the smallest safe edit possible");
  if (payload.techStackHint?.includes("Tailwind")) {
    lines.push(
      "- Tailwind detected: prefer updating className over inline styles",
    );
  }
  if (payload.techStackHint?.includes("React")) {
    lines.push("- Update the component source, not generated/bundled code");
  }
  lines.push(
    "- If CSS Modules or styled-components are used, update the correct styling source",
  );
  lines.push("- Do not change unrelated behavior or formatting");
  lines.push("");

  // == Output ==
  lines.push(
    "## Output\nApply the change in the repo, then reply with a short summary of what file(s) you modified and the exact change made.",
  );

  return lines.build();
}

async function ensureContextMenu(): Promise<void> {
  try {
    if (!(chrome as any).contextMenus?.create) return;
    try {
      await chrome.contextMenus.remove(CONTEXT_MENU_ID);
    } catch {}
    await chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "Switch web page editing mode",
      contexts: ["all"],
    });
  } catch (error) {
    console.warn("[WebEditor] Failed to ensure context menu:", error);
  }
}

/**
 * Ensure the web editor script is injected into the tab
 */
async function ensureEditorInjected(tabId: number): Promise<void> {
  // Try to ping existing instance before injecting a second copy.
  try {
    const pong: { status?: string; version?: number } =
      await chrome.tabs.sendMessage(
        tabId,
        { action: WEB_EDITOR_ACTIONS.PING },
        { frameId: 0 },
      );

    if (pong?.status === "pong") {
      return;
    }
  } catch {
    // No existing instance, fall through to inject.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [WEB_EDITOR_SCRIPT_PATH],
      world: "ISOLATED",
    });
    console.log("[WebEditor] Script injected successfully");
  } catch (error) {
    console.warn("[WebEditor] Failed to inject editor script:", error);
  }
}

/**
 * Inject props agent into MAIN world for Phase 7 Props editing
 */
async function ensurePropsAgentInjected(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [PROPS_AGENT_SCRIPT_PATH],
      world: "MAIN",
    });
  } catch (error) {
    // Best-effort: some pages (chrome://, extensions, PDF) block injection
    console.warn("[WebEditor] Failed to inject props agent:", error);
  }
}

/**
 * Send cleanup event to props agent
 */
async function sendPropsAgentCleanup(tabId: number): Promise<void> {
  try {
    // Dispatch cleanup event in ISOLATED world
    // CustomEvent crosses worlds and is observed by MAIN agent
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          window.dispatchEvent(new CustomEvent("web-editor-props:cleanup"));
        } catch {
          // ignore
        }
      },
      world: "ISOLATED",
    });
  } catch (error) {
    // Best-effort cleanup; ignore failures if tab is gone or injection blocked
    console.warn("[WebEditor] Failed to send props agent cleanup:", error);
  }
}

async function toggleEditorInTab(tabId: number): Promise<{ active?: boolean }> {
  await ensureEditorInjected(tabId);

  try {
    const resp: { active?: boolean } = await chrome.tabs.sendMessage(
      tabId,
      { action: WEB_EDITOR_ACTIONS.TOGGLE },
      { frameId: 0 },
    );
    const active = typeof resp?.active === "boolean" ? resp.active : undefined;

    // Phase 7: Inject props agent on start; cleanup on stop
    if (active === true) {
      await ensurePropsAgentInjected(tabId);
    } else if (active === false) {
      await sendPropsAgentCleanup(tabId);
      await releasePropsAgentEarlyInjection(tabId);
    }

    return { active };
  } catch (error) {
    console.warn("[WebEditor] Failed to toggle editor in tab:", error);
    return {};
  }
}

async function getActiveTabId(): Promise<number | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    return typeof tabId === "number" ? tabId : null;
  } catch {
    return null;
  }
}

export function initWebEditorListeners(): void {
  if (initialized) return;
  initialized = true;

  // MV3 lifecycle events can be dispatched immediately after worker startup;
  // register this listener synchronously before starting async reconciliation.
  initPropsAgentEarlyInjectionNavigationLifecycle();
  ensureContextMenu().catch(() => {});
  pruneOrphanedPropsAgentEarlyInjections().catch(() => {});

  // Clean up session storage when tab is closed to avoid stale data
  chrome.tabs.onRemoved.addListener((tabId) => {
    rememberRemovedTabId(tabId);
    try {
      const keys = [
        `${WEB_EDITOR_TX_CHANGED_SESSION_KEY_PREFIX}${tabId}`,
        `${WEB_EDITOR_SELECTION_SESSION_KEY_PREFIX}${tabId}`,
        `${WEB_EDITOR_EXCLUDED_KEYS_SESSION_KEY_PREFIX}${tabId}`,
      ];
      chrome.storage.session.remove(keys).catch(() => {});
    } catch {}
    void recoveryPromise
      .then(() => listDurableAgentRequestOwners("web-editor"))
      .then(async (owners) => {
        for (const durable of owners.filter((owner) => owner.tabId === tabId)) {
          if (durable.phase === "terminal") {
            await abandonExecutionOwner(
              durable.requestId,
              "tab_removed_terminal",
            );
            continue;
          }
          if (!executionOwners.has(durable.requestId))
            restoreExecutionOwner(durable);
          const outcome = await beginWebEditorCancellation(
            durable.requestId,
            "tab_removed",
            "failed",
            "Web Editor tab closed while the Agent request was running.",
          );
          if (outcome === "confirmed") {
            await abandonExecutionOwner(durable.requestId, "tab_removed");
          }
        }
      })
      .catch((error) => console.warn("[WebEditor] Tab cleanup failed", error));
    void releasePropsAgentEarlyInjection(tabId).catch(() => {});
  });
  chrome.tabs.onCreated?.addListener((tab) => {
    if (typeof tab.id === "number") removedTabIds.delete(tab.id);
  });
  chrome.alarms?.onAlarm?.addListener((alarm) => {
    const requestId = requestIdFromDurableAgentAlarm(alarm.name, "web-editor");
    if (!requestId) return;
    void recoveryPromise
      .then(() => handleWebEditorDeadline(requestId))
      .catch((error) =>
        console.warn("[WebEditor] Deadline handling failed", error),
      );
  });

  recoveryPromise = recoverWebEditorRequests().catch((error) => {
    recoveryError = error instanceof Error ? error : new Error(String(error));
    console.warn(
      "[WebEditor] Failed to recover durable Agent requests",
      recoveryError,
    );
  });

  if ((chrome as any).contextMenus?.onClicked?.addListener) {
    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
      try {
        if (info.menuItemId !== CONTEXT_MENU_ID) return;
        const tabId = tab?.id;
        if (typeof tabId !== "number") return;
        await toggleEditorInTab(tabId);
      } catch {}
    });
  }

  chrome.commands.onCommand.addListener(async (command) => {
    try {
      if (command !== COMMAND_KEY) return;
      const tabId = await getActiveTabId();
      if (typeof tabId !== "number") return;
      await toggleEditorInTab(tabId);
    } catch {}
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      const messageType = typeof message?.type === "string" ? message.type : "";
      if (WEB_EDITOR_CONTENT_MESSAGE_TYPES.has(messageType)) {
        if (
          isBackgroundRebroadcast(_sender) &&
          (messageType === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED ||
            messageType ===
              BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_SELECTION_CHANGED)
        ) {
          return false;
        }
        if (!isWebEditorContentSender(_sender)) {
          sendResponse({
            success: false,
            error: "Web Editor page message sender is not trusted",
          });
          return false;
        }
      }

      if (
        WEB_EDITOR_EXTENSION_PAGE_MESSAGE_TYPES.has(messageType) &&
        !isExtensionPageSender(_sender)
      ) {
        sendResponse({
          success: false,
          error: "Web Editor control requires an extension page",
        });
        return false;
      }

      // Phase 7.1.6: Handle early injection registration request
      if (
        message?.type ===
        BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_PROPS_REGISTER_EARLY_INJECTION
      ) {
        (async () => {
          const senderTab = (_sender as chrome.runtime.MessageSender)?.tab;
          const senderTabId = senderTab?.id;
          const senderTabUrl = senderTab?.url;

          if (
            typeof senderTabId !== "number" ||
            typeof senderTabUrl !== "string"
          ) {
            return sendResponse({
              success: false,
              error: "Sender tab information is required",
            });
          }

          try {
            const result = await registerPropsAgentEarlyInjection(
              senderTabId,
              senderTabUrl,
            );

            // Respond first, then reload (to avoid message port closing during navigation)
            sendResponse({ success: true, ...result });

            // Small delay to ensure response is sent before navigation
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Reload the tab so early injection takes effect
            try {
              await chrome.tabs.reload(senderTabId);
            } catch {
              // Best-effort: some tabs may block reload
            }
          } catch (err) {
            sendResponse({
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
        return true; // Async response
      }

      // =====================================================================
      // WEB_EDITOR_OPEN_SOURCE: Open component source file in VSCode
      // =====================================================================
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_OPEN_SOURCE) {
        (async () => {
          try {
            const source = normalizeOpenSourcePayload(message.payload);

            const stored = await chrome.storage.local.get([
              "agent-selected-project-id",
            ]);
            const projectId = normalizeBoundedIdentifier(
              stored["agent-selected-project-id"],
              "selected Agent project ID",
            );

            if (!projectId) {
              const senderTabId = (_sender as chrome.runtime.MessageSender)?.tab
                ?.id;
              const senderWindowId = (_sender as chrome.runtime.MessageSender)
                ?.tab?.windowId;
              if (typeof senderTabId === "number") {
                void openAgentSetupSidepanel(senderTabId, senderWindowId);
              }
              return sendResponse({
                success: false,
                error:
                  "No project selected. Open Agent Setup and select a project first.",
              });
            }

            // Call mcp-server to open file (server will validate project and path)
            const openResp = await requestAgentRpcFetch({
              operation: "agent.projects.openFile",
              params: { projectId },
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                filePath: source.file,
                line: source.line,
                column: source.column,
              }),
            });

            // Try to parse JSON response for detailed error
            let result: { success: boolean; error?: string };
            try {
              result = (openResp.json || {}) as {
                success: boolean;
                error?: string;
              };
            } catch {
              const text = openResp.body || "";
              result = {
                success: false,
                error: text || `HTTP ${openResp.statusCode}`,
              };
            }

            sendResponse(result);
          } catch (err) {
            sendResponse({
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        })();
        return true; // Async response
      }

      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TOGGLE) {
        getActiveTabId()
          .then(async (tabId) => {
            if (typeof tabId !== "number")
              return sendResponse({ success: false });
            const result = await toggleEditorInTab(tabId);
            sendResponse({ success: true, ...result });
          })
          .catch(() => sendResponse({ success: false }));
        return true;
      }

      // =======================================================================
      // Phase 1.5: Handle TX_CHANGED broadcast from web-editor
      // =======================================================================
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED) {
        (async () => {
          const senderTabId = (_sender as chrome.runtime.MessageSender)?.tab
            ?.id;
          if (
            !Number.isSafeInteger(senderTabId) ||
            (senderTabId as number) <= 0
          ) {
            sendResponse({ success: false, error: "Sender tabId is required" });
            return;
          }

          const payload = normalizeTxChangedPayload(
            message.payload,
            senderTabId as number,
          );
          const storageKey = `${WEB_EDITOR_TX_CHANGED_SESSION_KEY_PREFIX}${senderTabId}`;

          // Persist to session storage for cold-start recovery
          // Remove keys on clear to avoid stale data (rollback still has edits, so keep it)
          if (payload.action === "clear") {
            // Clear TX state and excluded keys together
            const excludedKey = `${WEB_EDITOR_EXCLUDED_KEYS_SESSION_KEY_PREFIX}${senderTabId}`;
            await chrome.storage.session.remove([storageKey, excludedKey]);
          } else {
            await chrome.storage.session.set({ [storageKey]: payload });
          }

          // Broadcast to sidepanel (best-effort, ignore errors if sidepanel is closed)
          chrome.runtime
            .sendMessage({
              type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_TX_CHANGED,
              payload,
            })
            .catch(() => {
              // Ignore errors - sidepanel may be closed
            });

          sendResponse({ success: true });
        })().catch((error) => {
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          });
        });
        return true;
      }

      // =======================================================================
      // Selection sync: Handle SELECTION_CHANGED broadcast from web-editor
      // =======================================================================
      if (
        message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_SELECTION_CHANGED
      ) {
        (async () => {
          const senderTabId = (_sender as chrome.runtime.MessageSender)?.tab
            ?.id;
          if (
            !Number.isSafeInteger(senderTabId) ||
            (senderTabId as number) <= 0
          ) {
            sendResponse({ success: false, error: "Sender tabId is required" });
            return;
          }

          const payload = normalizeSelectionChangedPayload(
            message.payload,
            senderTabId as number,
          );
          const storageKey = `${WEB_EDITOR_SELECTION_SESSION_KEY_PREFIX}${senderTabId}`;

          // Persist to session storage for cold-start recovery
          // Remove key on deselection to avoid stale data
          if (payload.selected === null) {
            await chrome.storage.session.remove(storageKey);
          } else {
            await chrome.storage.session.set({ [storageKey]: payload });
          }

          // Broadcast to sidepanel (best-effort, ignore errors if sidepanel is closed)
          chrome.runtime
            .sendMessage({
              type: BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_SELECTION_CHANGED,
              payload,
            })
            .catch(() => {
              // Ignore errors - sidepanel may be closed
            });

          sendResponse({ success: true });
        })().catch((error) => {
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          });
        });
        return true;
      }

      // =======================================================================
      // Clear selection: Handle CLEAR_SELECTION from sidepanel (after send)
      // =======================================================================
      if (
        message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_CLEAR_SELECTION
      ) {
        (async () => {
          const { tabId: targetTabId } = normalizeClearSelectionPayload(
            message.payload,
          );

          // Forward to content script (web-editor)
          try {
            await chrome.tabs.sendMessage(targetTabId, {
              action: WEB_EDITOR_ACTIONS.CLEAR_SELECTION,
            });
            sendResponse({ success: true });
          } catch (error) {
            // Tab may be closed or web-editor not active - this is expected
            sendResponse({
              success: false,
              error:
                error instanceof Error
                  ? error.message
                  : "Failed to send to tab",
            });
          }
        })().catch((error) => {
          // Catch any unhandled errors in the async IIFE
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          });
        });
        return true;
      }

      // =======================================================================
      // Phase 1.5: Handle APPLY_BATCH from web-editor toolbar
      // =======================================================================
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_APPLY_BATCH) {
        (async () => {
          await ensureWebEditorRecoveryReady();
          const senderTabId = (_sender as chrome.runtime.MessageSender)?.tab
            ?.id;
          const senderWindowId = (_sender as chrome.runtime.MessageSender)?.tab
            ?.windowId;

          if (typeof senderTabId !== "number") {
            sendResponse({
              success: false,
              error: "Web Editor request must originate from a tab.",
            });
            return;
          }

          if (
            !consumePrivilegedUiAuthorization(
              message?.authorizationToken,
              PRIVILEGED_UI_ACTIONS.WEB_EDITOR_APPLY,
              _sender as chrome.runtime.MessageSender,
            )
          ) {
            sendResponse({
              success: false,
              error: "Web Editor authorization is missing or expired.",
            });
            return;
          }

          const payload = normalizeApplyBatchPayload(message.payload);

          const stored = await chrome.storage.local.get([
            STORAGE_KEY_SELECTED_SESSION,
          ]);

          const storedSessionId =
            normalizeBoundedIdentifier(
              stored?.[STORAGE_KEY_SELECTED_SESSION],
              "selected Agent session ID",
            ) ?? "";
          const sessionId = storedSessionId
            ? normalizeSessionStatusIdentifier(
                storedSessionId,
                "selected Agent session ID",
              )
            : "";

          // Best-effort: open Agent Setup so the selected session is visible.
          if (typeof senderTabId === "number") {
            openAgentSetupSidepanel(
              senderTabId,
              senderWindowId,
              sessionId || undefined,
            ).catch(() => {});
          }

          if (!sessionId) {
            // No session selected - sidepanel is already being opened (best-effort)
            // User needs to select or create a session manually
            sendResponse({
              success: false,
              error:
                "No Agent session selected. Open Agent Setup, select or create a session, then try Apply again.",
            });
            return;
          }

          // Hydrate payload with tabId
          const hydratedPayload: WebEditorApplyBatchPayload =
            typeof senderTabId === "number"
              ? { ...payload, tabId: senderTabId }
              : payload;

          // Read excluded keys from session storage (per-tab, managed by sidepanel)
          let sessionExcludedKeys: string[] = [];
          if (typeof senderTabId === "number") {
            const excludedSessionKey = `${WEB_EDITOR_EXCLUDED_KEYS_SESSION_KEY_PREFIX}${senderTabId}`;
            try {
              if (chrome.storage?.session?.get) {
                const stored = (await chrome.storage.session.get(
                  excludedSessionKey,
                )) as Record<string, unknown>;
                sessionExcludedKeys = normalizeStoredExcludedKeys(
                  stored?.[excludedSessionKey],
                );
              }
            } catch {
              // Best-effort: ignore session storage failures
            }
          }

          // Filter out excluded elements (union: payload excludedKeys + session excludedKeys)
          const excluded = new Set([
            ...hydratedPayload.excludedKeys,
            ...sessionExcludedKeys,
          ]);
          const elements = hydratedPayload.elements.filter(
            (e) => !excluded.has(e.elementKey),
          );
          if (elements.length === 0) {
            sendResponse({
              success: false,
              error: "No elements selected to apply.",
            });
            return;
          }

          // Build page URL from payload or sender tab
          const pageUrl =
            normalizeBoundedPageUrl(
              hydratedPayload.pageUrl,
              "payload.pageUrl",
            ) ??
            normalizeBoundedPageUrl(
              (_sender as chrome.runtime.MessageSender)?.tab?.url,
              "sender tab URL",
            ) ??
            "unknown";

          // Build batch prompt and send to agent
          const instruction = buildAgentPromptBatch(elements, pageUrl);

          // Extract element labels for compact display
          const elementLabels = elements.slice(0, 5).map((e) => e.label);

          const requestId = createWebEditorRequestId();
          await rememberExecutionOwner(
            requestId,
            sessionId,
            _sender as chrome.runtime.MessageSender,
          );
          await prepareExecutionStreamForDispatch(
            requestId,
            sessionId,
            _sender as chrome.runtime.MessageSender,
          );

          let resp: Awaited<ReturnType<typeof requestAgentRpcFetch>>;
          try {
            resp = await requestAgentRpcFetch({
              operation: "agent.chat.act",
              params: { sessionId },
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                instruction,
                requestId,
                // Pass dbSessionId so backend loads session-level configuration (engine, model, options)
                dbSessionId: sessionId,
                // Display text for UI (compact representation)
                displayText: `Apply ${elements.length} change${elements.length === 1 ? "" : "s"}`,
                // Client metadata for special message rendering
                clientMeta: {
                  kind: "web_editor_apply_batch",
                  pageUrl,
                  elementCount: elements.length,
                  elementLabels,
                },
              }),
            });
          } catch (error) {
            const outcome = await beginWebEditorCancellation(
              requestId,
              "dispatch_transport_error",
              "failed",
              "Web Editor Agent request dispatch failed.",
            );
            if (outcome === "confirmed") {
              await abandonExecutionOwner(
                requestId,
                "dispatch_transport_error",
              );
            }
            throw error;
          }

          if (!resp.ok) {
            const text = resp.body || "";
            const outcome = await beginWebEditorCancellation(
              requestId,
              "dispatch_rejected",
              "failed",
              text || `HTTP ${resp.statusCode}`,
            );
            if (outcome === "confirmed") {
              await abandonExecutionOwner(requestId, "dispatch_rejected");
            }
            sendResponse({
              success: false,
              error: text || `HTTP ${resp.statusCode}`,
            });
            return;
          }

          setExecutionStatus(requestId, "running", "Agent request accepted");

          sendResponse({ success: true, requestId, sessionId });
        })().catch((error) => {
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          });
        });
        return true;
      }

      // =======================================================================
      // Phase 1.8: Handle HIGHLIGHT_ELEMENT from sidepanel chips hover
      // =======================================================================
      if (
        message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_HIGHLIGHT_ELEMENT
      ) {
        (async () => {
          const payload = normalizeHighlightPayload(message.payload);
          const { tabId, mode } = payload;

          // Clear mode: forward directly without locator/selector validation
          // This prevents overlay residue when sidepanel unmounts
          if (mode === "clear") {
            try {
              const response = await chrome.tabs.sendMessage(tabId, {
                action: WEB_EDITOR_ACTIONS.HIGHLIGHT_ELEMENT,
                mode: "clear",
              });
              sendResponse({ success: true, response });
            } catch (error) {
              sendResponse({
                success: false,
                error: String(error instanceof Error ? error.message : error),
              });
            }
            return;
          }

          const { locator, primarySelector } = payload;

          // Forward to web-editor content script
          try {
            const response = await chrome.tabs.sendMessage(tabId, {
              action: WEB_EDITOR_ACTIONS.HIGHLIGHT_ELEMENT,
              locator, // Full locator for Shadow DOM/iframe support
              selector: primarySelector, // Backward compatibility fallback
              mode,
              elementKey: payload.elementKey,
            });

            sendResponse({ success: true, response });
          } catch (error) {
            // Content script might not be available
            sendResponse({
              success: false,
              error: String(error instanceof Error ? error.message : error),
            });
          }
        })().catch((error) => {
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          });
        });
        return true;
      }

      // =======================================================================
      // Phase 2: Handle REVERT_ELEMENT from sidepanel chips
      // =======================================================================
      if (
        message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_REVERT_ELEMENT
      ) {
        (async () => {
          const { tabId, elementKey } = normalizeRevertPayload(message.payload);

          // Forward to web-editor content script (frameId: 0 for main frame only)
          try {
            const response = await chrome.tabs.sendMessage(
              tabId,
              {
                action: WEB_EDITOR_ACTIONS.REVERT_ELEMENT,
                elementKey,
              },
              { frameId: 0 },
            );

            sendResponse({ success: true, ...response });
          } catch (error) {
            // Content script might not be available
            sendResponse({
              success: false,
              error: String(error instanceof Error ? error.message : error),
            });
          }
        })().catch((error) => {
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          });
        });
        return true;
      }

      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_APPLY) {
        (async () => {
          await ensureWebEditorRecoveryReady();
          const sender = _sender as chrome.runtime.MessageSender;
          const senderTabId = sender.tab?.id;
          const senderWindowId = sender.tab?.windowId;

          if (typeof senderTabId !== "number") {
            sendResponse({
              success: false,
              error: "Web Editor request must originate from a tab.",
            });
            return;
          }

          if (
            !consumePrivilegedUiAuthorization(
              message?.authorizationToken,
              PRIVILEGED_UI_ACTIONS.WEB_EDITOR_APPLY,
              sender,
            )
          ) {
            sendResponse({
              success: false,
              error: "Web Editor authorization is missing or expired.",
            });
            return;
          }

          const payload = normalizeApplyPayload(message.payload);

          const stored = await chrome.storage.local.get([
            STORAGE_KEY_SELECTED_SESSION,
          ]);
          const storedSessionId =
            normalizeBoundedIdentifier(
              stored?.[STORAGE_KEY_SELECTED_SESSION],
              "selected Agent session ID",
            ) ?? "";
          const sessionId = storedSessionId
            ? normalizeSessionStatusIdentifier(
                storedSessionId,
                "selected Agent session ID",
              )
            : "";

          if (typeof senderTabId === "number") {
            openAgentSetupSidepanel(
              senderTabId,
              senderWindowId,
              sessionId || undefined,
            ).catch(() => {});
          }

          if (!sessionId) {
            return sendResponse({
              success: false,
              error:
                "No Agent session selected. Open Agent Setup, select or create a session, then try Apply again.",
            });
          }

          const instruction = buildAgentPrompt(payload);

          const requestId = createWebEditorRequestId();
          await rememberExecutionOwner(requestId, sessionId, sender);
          await prepareExecutionStreamForDispatch(requestId, sessionId, sender);

          let resp: Awaited<ReturnType<typeof requestAgentRpcFetch>>;
          try {
            resp = await requestAgentRpcFetch({
              operation: "agent.chat.act",
              params: { sessionId },
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                instruction,
                requestId,
                dbSessionId: sessionId,
              }),
            });
          } catch (error) {
            const outcome = await beginWebEditorCancellation(
              requestId,
              "dispatch_transport_error",
              "failed",
              "Web Editor Agent request dispatch failed.",
            );
            if (outcome === "confirmed") {
              await abandonExecutionOwner(
                requestId,
                "dispatch_transport_error",
              );
            }
            throw error;
          }

          if (!resp.ok) {
            const text = resp.body || "";
            const outcome = await beginWebEditorCancellation(
              requestId,
              "dispatch_rejected",
              "failed",
              text || `HTTP ${resp.statusCode}`,
            );
            if (outcome === "confirmed") {
              await abandonExecutionOwner(requestId, "dispatch_rejected");
            }
            return sendResponse({
              success: false,
              error: text || `HTTP ${resp.statusCode}`,
            });
          }

          setExecutionStatus(requestId, "running", "Agent request accepted");

          return sendResponse({ success: true, requestId, sessionId });
        })().catch((error) => {
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          });
        });
        return true;
      }
      if (message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_STATUS_QUERY) {
        void (async () => {
          await ensureWebEditorRecoveryReady();
          const { requestId, sessionId } = normalizeStatusQueryMessage(message);
          let owner = getExecutionOwner(requestId);
          if (owner && owner.deadlineAt <= Date.now()) {
            await handleWebEditorDeadline(requestId);
            owner = getExecutionOwner(requestId);
          }
          if (!owner || !isExecutionOwner(owner, sessionId, _sender)) {
            sendResponse({
              success: false,
              error: "Web Editor execution belongs to another document.",
            });
            return;
          }

          const entry = getExecutionStatus(requestId);
          if (!entry) {
            sendResponse({
              success: true,
              status: "pending",
              message: "Waiting for status...",
            });
          } else {
            sendResponse({
              success: true,
              status: entry.status,
              message: entry.message,
              result: entry.result,
            });
          }
        })().catch((error) => {
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          });
        });
        return true;
      }

      // =======================================================================
      // Cancel Execution: Handle WEB_EDITOR_CANCEL_EXECUTION from toolbar/sidepanel
      // =======================================================================
      if (
        message?.type === BACKGROUND_MESSAGE_TYPES.WEB_EDITOR_CANCEL_EXECUTION
      ) {
        (async () => {
          await ensureWebEditorRecoveryReady();
          const { sessionId, requestId } = normalizeCancelExecutionPayload(
            message.payload,
          );

          if (
            !consumePrivilegedUiAuthorization(
              message?.authorizationToken,
              PRIVILEGED_UI_ACTIONS.WEB_EDITOR_CANCEL,
              _sender as chrome.runtime.MessageSender,
            )
          ) {
            sendResponse({
              success: false,
              error:
                "Web Editor cancellation authorization is missing or expired.",
            } as WebEditorCancelExecutionResponse);
            return;
          }

          const owner = getExecutionOwner(requestId);
          if (!owner || !isExecutionOwner(owner, sessionId, _sender)) {
            sendResponse({
              success: false,
              error: "Web Editor execution belongs to another document.",
            } as WebEditorCancelExecutionResponse);
            return;
          }

          const outcome = await beginWebEditorCancellation(
            requestId,
            "cancelled_by_user",
            "cancelled",
            "Execution cancelled by user",
          );
          if (outcome === "confirmed") {
            sendResponse({ success: true } as WebEditorCancelExecutionResponse);
          } else if (outcome === "expired") {
            sendResponse({
              success: false,
              error:
                "Cancellation could not be confirmed before its retry deadline.",
            } as WebEditorCancelExecutionResponse);
          } else {
            sendResponse({
              success: false,
              error:
                "Cancellation is pending because the Agent transport is unavailable.",
            } as WebEditorCancelExecutionResponse);
          }
        })().catch((error) => {
          sendResponse({
            success: false,
            error: String(error instanceof Error ? error.message : error),
          } as WebEditorCancelExecutionResponse);
        });
        return true; // Will respond asynchronously
      }
    } catch (error) {
      sendResponse({
        success: false,
        error: String(error instanceof Error ? error.message : error),
      });
    }
    return false;
  });
}
