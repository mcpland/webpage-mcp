import type { RecordingSessionManager } from "./session-manager";
import type { Step, TargetLocator } from "../types";
import { TOOL_MESSAGE_TYPES } from "@/common/message-types";
import {
  type RecorderEventAck,
  type RecorderEventMeta,
  type RecorderEventDecision,
  getRecorderEventSource,
  getRecorderSourceKey,
  parseRecorderEventMeta,
} from "./recorder-event-protocol";
import {
  recordingNetworkTracker,
  type RecordedRequest,
} from "./network-tracker";
import {
  sanitizeRecorderStep,
  sanitizeRecorderSteps,
  sanitizeRecorderTarget,
  sanitizeRecorderVariables,
} from "./recorder-step-validator";
import type {
  RecordingRecoveryIngestState,
  RecordingRecoveryPendingFrameStep,
} from "./recording-recovery-store";

const MAX_SOURCES = 200;
const MAX_RECENT_EVENT_IDS_PER_SOURCE = 300;
const MAX_PENDING_FRAME_STEPS = 128;
const MAX_PENDING_FRAME_STEP_BYTES = 2 * 1024 * 1024;
const MAX_LAST_STEP_TABS = 128;
const FRAME_EVENT_ID_PATTERN = /^frame_[a-f0-9]{32}$/;

interface PendingFrameStep {
  step: Step;
  href: string;
  createdAt: number;
}

class PendingFrameStepStore {
  private sessionId = "";
  private readonly entries = new Map<string, PendingFrameStep>();

  alignSession(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.entries.clear();
  }

  put(tabId: number, eventId: string, value: PendingFrameStep): boolean {
    const key = `${tabId}:${eventId}`;
    if (!this.entries.has(key) && this.entries.size >= MAX_PENDING_FRAME_STEPS)
      return false;
    const next = new Map(this.entries);
    next.set(key, value);
    if (
      this.jsonBytes(Array.from(next.values())) > MAX_PENDING_FRAME_STEP_BYTES
    )
      return false;
    this.entries.set(key, value);
    return true;
  }

  take(tabId: number, eventId: string): PendingFrameStep | undefined {
    const key = `${tabId}:${eventId}`;
    const value = this.entries.get(key);
    if (value) this.entries.delete(key);
    return value;
  }

  get(tabId: number, eventId: string): PendingFrameStep | undefined {
    return this.entries.get(`${tabId}:${eventId}`);
  }

  delete(tabId: number, eventId: string): void {
    this.entries.delete(`${tabId}:${eventId}`);
  }

  restore(entries: RecordingRecoveryPendingFrameStep[]): void {
    this.entries.clear();
    for (const entry of entries.slice(0, MAX_PENDING_FRAME_STEPS)) {
      if (
        !this.put(entry.tabId, entry.eventId, {
          step: entry.step,
          href: entry.href,
          createdAt: entry.createdAt,
        })
      ) {
        throw new Error(
          "recovered iframe steps exceed the pending-step capacity",
        );
      }
    }
  }

  snapshot(): RecordingRecoveryPendingFrameStep[] {
    const result: RecordingRecoveryPendingFrameStep[] = [];
    for (const [key, value] of this.entries) {
      const separator = key.indexOf(":");
      const tabId = Number(key.slice(0, separator));
      const eventId = key.slice(separator + 1);
      result.push({ tabId, eventId, ...value });
    }
    return result;
  }

  private jsonBytes(value: unknown): number {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    } catch {
      return MAX_PENDING_FRAME_STEP_BYTES + 1;
    }
  }
}

interface SourceIngestState {
  highWatermarkSeq: number;
  recentEventIds: string[];
  recentEventSet: Set<string>;
  updatedAt: number;
}

class RecorderEventIngestTracker {
  private sessionId = "";
  private readonly sourceStates = new Map<string, SourceIngestState>();

  alignSession(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.sourceStates.clear();
  }

  getHighWatermark(sourceKey: string): number {
    return this.sourceStates.get(sourceKey)?.highWatermarkSeq ?? 0;
  }

  decide(meta: RecorderEventMeta, sourceKey: string): RecorderEventDecision {
    const state = this.getOrCreateSourceState(sourceKey);

    if (state.recentEventSet.has(meta.eventId)) {
      return "duplicate";
    }

    if (meta.seq <= state.highWatermarkSeq) {
      return "stale";
    }

    return "accept";
  }

  commit(meta: RecorderEventMeta, sourceKey: string): void {
    const state = this.getOrCreateSourceState(sourceKey);

    state.highWatermarkSeq = Math.max(state.highWatermarkSeq, meta.seq);
    state.updatedAt = Date.now();
    state.recentEventSet.add(meta.eventId);
    state.recentEventIds.push(meta.eventId);

    if (state.recentEventIds.length > MAX_RECENT_EVENT_IDS_PER_SOURCE) {
      const evicted = state.recentEventIds.shift();
      if (evicted) state.recentEventSet.delete(evicted);
    }
  }

  restore(sources: RecordingRecoveryIngestState["sources"]): void {
    this.sourceStates.clear();
    for (const source of sources.slice(0, MAX_SOURCES)) {
      this.sourceStates.set(source.sourceKey, {
        highWatermarkSeq: source.highWatermarkSeq,
        recentEventIds: [],
        recentEventSet: new Set<string>(),
        updatedAt: source.updatedAt,
      });
    }
  }

  snapshot(): RecordingRecoveryIngestState["sources"] {
    return Array.from(this.sourceStates, ([sourceKey, state]) => ({
      sourceKey,
      highWatermarkSeq: state.highWatermarkSeq,
      updatedAt: state.updatedAt,
    }));
  }

  private getOrCreateSourceState(sourceKey: string): SourceIngestState {
    const existing = this.sourceStates.get(sourceKey);
    if (existing) return existing;

    const created: SourceIngestState = {
      highWatermarkSeq: 0,
      recentEventIds: [],
      recentEventSet: new Set<string>(),
      updatedAt: Date.now(),
    };
    this.sourceStates.set(sourceKey, created);
    this.pruneSourcesIfNeeded();
    return created;
  }

  private pruneSourcesIfNeeded(): void {
    if (this.sourceStates.size <= MAX_SOURCES) return;

    const entries = Array.from(this.sourceStates.entries());
    entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const toDelete = entries.slice(
      0,
      Math.max(1, entries.length - MAX_SOURCES),
    );
    for (const [key] of toDelete) {
      this.sourceStates.delete(key);
    }
  }
}

function buildAck(
  meta: Pick<RecorderEventMeta, "seq" | "eventId">,
  highWatermarkSeq: number,
  decision: RecorderEventDecision,
): RecorderEventAck {
  return {
    seq: meta.seq,
    eventId: meta.eventId,
    highWatermarkSeq,
    decision,
  };
}

function toNetworkContext(requests: RecordedRequest[]) {
  return {
    pendingRequests: requests.slice(0, 10).map((item) => ({
      url: item.url,
      method: item.method,
      status: item.status,
      duration: item.duration,
    })),
    waitForNetworkIdle: true,
  };
}

function patchStepWithNetworkContext(
  step: Step,
  requests: RecordedRequest[],
): Step {
  if (!step || !requests.length) return step;
  if (step.type !== "click" && step.type !== "dblclick" && step.type !== "fill")
    return step;
  const withAfter = {
    ...step,
    after: {
      ...((step as any).after || {}),
      waitForNetworkIdle: true,
    },
    networkContext: toNetworkContext(requests),
  } as unknown as Step;
  return withAfter;
}

function buildStepFromFlowById(
  session: RecordingSessionManager,
  stepId: string,
): Step | null {
  const flow = session.getFlow();
  if (!flow || !stepId) return null;

  if (Array.isArray(flow.nodes)) {
    const node = flow.nodes.find((item) => item.id === stepId);
    if (node) {
      const cfg =
        node.config && typeof node.config === "object"
          ? (node.config as Record<string, unknown>)
          : {};
      return { ...cfg, id: node.id, type: node.type } as Step;
    }
  }

  if (Array.isArray(flow.steps)) {
    const step = flow.steps.find((item) => item.id === stepId);
    if (step) {
      return { ...(step as any) } as Step;
    }
  }

  return null;
}

type PayloadApplyResult =
  | { ok: true }
  | { ok: false; error: string; code?: string };

function appendValidatedSteps(
  steps: Step[],
  session: RecordingSessionManager,
  senderTabId?: number,
  lastStepByTab?: Map<number, string>,
): PayloadApplyResult {
  if (steps.length === 0) return { ok: true };
  if (typeof senderTabId === "number" && senderTabId >= 0 && lastStepByTab) {
    const requests = recordingNetworkTracker.takeRecent(senderTabId);
    const previousStepId = lastStepByTab.get(senderTabId);
    if (previousStepId && requests.length > 0) {
      const previousStep = buildStepFromFlowById(session, previousStepId);
      if (previousStep) {
        const networkPatch = session.appendSteps([
          patchStepWithNetworkContext(previousStep, requests),
        ]);
        if (networkPatch?.truncated) {
          return {
            ok: false,
            code: "RECORDING_LIMIT",
            error: `recording limit reached: ${networkPatch.reason ?? "unknown"}`,
          };
        }
      }
    }
  }
  const appendResult = session.appendSteps(steps);
  if (appendResult?.truncated) {
    return {
      ok: false,
      code: "RECORDING_LIMIT",
      error: `recording limit reached: ${appendResult.reason ?? "unknown"}`,
    };
  }
  if (typeof senderTabId === "number" && senderTabId >= 0 && lastStepByTab) {
    const lastStep = steps[steps.length - 1];
    if (lastStep && typeof lastStep.id === "string" && lastStep.id) {
      lastStepByTab.delete(senderTabId);
      lastStepByTab.set(senderTabId, lastStep.id);
      while (lastStepByTab.size > MAX_LAST_STEP_TABS) {
        const oldestTabId = lastStepByTab.keys().next().value;
        if (typeof oldestTabId !== "number") break;
        lastStepByTab.delete(oldestTabId);
      }
    }
  }
  return { ok: true };
}

function applyPayload(
  payload: any,
  session: RecordingSessionManager,
  senderTabId?: number,
  lastStepByTab?: Map<number, string>,
): PayloadApplyResult {
  if (payload.kind === "steps" || payload.kind === "step") {
    const rawSteps = Array.isArray(payload.steps)
      ? payload.steps
      : payload.step
        ? [payload.step]
        : [];
    const steps = sanitizeRecorderSteps(rawSteps);
    if (!steps.ok) return steps;
    return appendValidatedSteps(
      steps.value,
      session,
      senderTabId,
      lastStepByTab,
    );
  }

  if (payload.kind === "variables") {
    const variables = sanitizeRecorderVariables(payload.variables);
    if (!variables.ok) return variables;
    if (variables.value.length > 0) {
      const appendResult = session.appendVariables(variables.value);
      if (appendResult?.truncated) {
        return {
          ok: false,
          code: "RECORDING_LIMIT",
          error: `recording limit reached: ${appendResult.reason ?? "unknown"}`,
        };
      }
    }
    return { ok: true };
  }

  if (payload.kind === "batch") {
    const steps = sanitizeRecorderSteps(payload.steps ?? []);
    if (!steps.ok) return steps;
    const variables = sanitizeRecorderVariables(payload.variables ?? []);
    if (!variables.ok) return variables;
    const stepResult = appendValidatedSteps(
      steps.value,
      session,
      senderTabId,
      lastStepByTab,
    );
    if (!stepResult.ok) return stepResult;
    if (variables.value.length > 0) {
      const appendResult = session.appendVariables(variables.value);
      if (appendResult?.truncated) {
        return {
          ok: false,
          code: "RECORDING_LIMIT",
          error: `recording limit reached: ${appendResult.reason ?? "unknown"}`,
        };
      }
    }
    return { ok: true };
  }

  return {
    ok: false,
    error: `unsupported recorder payload kind: ${String(payload.kind)}`,
  };
}

function parseFrameEventId(input: unknown): string | null {
  return typeof input === "string" && FRAME_EVENT_ID_PATTERN.test(input)
    ? input
    : null;
}

function composeFrameTargetStep(
  pending: PendingFrameStep,
  rawFrameTarget: unknown,
): PayloadApplyResult & { step?: Step } {
  const parsedFrameTarget = sanitizeRecorderTarget(rawFrameTarget);
  if (!parsedFrameTarget.ok) return parsedFrameTarget;

  const frameSelector = String(parsedFrameTarget.value.selector || "").trim();
  if (!frameSelector)
    return { ok: false, error: "frame target requires a selector" };

  const step = { ...(pending.step as any) } as Step;
  const rawTarget = (pending.step as any).target;
  if (!rawTarget || typeof rawTarget !== "object") {
    return { ok: true, step };
  }

  const target = {
    ...rawTarget,
    candidates: Array.isArray(rawTarget.candidates)
      ? [...rawTarget.candidates]
      : [],
  } as TargetLocator;
  const innerSelector = String(target.selector || "").trim();
  if (!innerSelector)
    return { ok: false, error: "iframe step target requires a selector" };

  const composite = `${frameSelector} |> ${innerSelector}`;
  target.selector = composite;
  target.candidates.unshift({
    type: "css",
    value: composite,
    source: "recorded",
  });
  target.frameContext = {
    kind: "iframe",
    url: pending.href,
    frameSelector,
  };
  (step as any).target = target;
  return { ok: true, step };
}

export function createRecorderEventMessageHandler(
  session: RecordingSessionManager,
): Parameters<typeof chrome.runtime.onMessage.addListener>[0] {
  const tracker = new RecorderEventIngestTracker();
  const pendingFrameSteps = new PendingFrameStepStore();
  const lastStepByTab = new Map<number, string>();
  let ingestSessionId = "";

  const snapshotIngestState = (): RecordingRecoveryIngestState => ({
    sessionId: ingestSessionId,
    sources: tracker.snapshot(),
    pendingFrameSteps: pendingFrameSteps.snapshot(),
    lastStepByTab: Array.from(lastStepByTab),
  });

  const alignIngestSession = (sessionId: string): void => {
    if (ingestSessionId === sessionId) return;
    ingestSessionId = sessionId;
    lastStepByTab.clear();
    tracker.alignSession(sessionId);
    pendingFrameSteps.alignSession(sessionId);

    const recovered = session.getRecoveryIngestState?.();
    if (recovered?.sessionId !== sessionId) return;
    tracker.restore(recovered.sources);
    pendingFrameSteps.restore(recovered.pendingFrameSteps);
    for (const [tabId, stepId] of recovered.lastStepByTab) {
      lastStepByTab.set(tabId, stepId);
    }
  };

  const respondAfterCheckpoint = (
    response: Record<string, unknown>,
    sendResponse: (response?: any) => void,
  ): true => {
    let checkpoint: Promise<void> | undefined;
    try {
      checkpoint = session.persistRecoveryState?.(snapshotIngestState());
    } catch (error) {
      sendResponse({
        ok: false,
        code: "RECOVERY_PERSIST_FAILED",
        error: String((error as Error)?.message || error),
      });
      return true;
    }
    if (!checkpoint) {
      sendResponse(response);
      return true;
    }
    checkpoint
      .then(() => sendResponse(response))
      .catch((error) => {
        sendResponse({
          ok: false,
          code: "RECOVERY_PERSIST_FAILED",
          error: String((error as Error)?.message || error),
        });
      });
    return true;
  };

  const handleMessage = (
    message: any,
    sender: chrome.runtime.MessageSender,
    sendResponse: any,
  ) => {
    try {
      if (!message || message.type !== TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT)
        return false;

      // Accept messages during 'recording' or 'stopping' states
      // 'stopping' allows final steps to arrive during the drain phase
      if (!session.canAcceptSteps()) {
        if (session.getStatus?.() === "paused") {
          sendResponse({
            ok: false,
            code: "RECORDING_PAUSED",
            error: "recording is paused; event was not acknowledged",
          });
          return true;
        }
        sendResponse({ ok: true, ignored: true });
        return true;
      }

      const flow = session.getFlow();
      if (!flow) {
        sendResponse({
          ok: false,
          code: "RECORDING_STATE_UNAVAILABLE",
          error: "active recording flow is unavailable",
        });
        return true;
      }

      const payload = message?.payload || {};
      const sessionId = session.getSession().sessionId;
      alignIngestSession(sessionId);

      const parsedMeta = parseRecorderEventMeta(message?.meta);
      if (!parsedMeta.ok) {
        sendResponse({
          ok: false,
          code: "INVALID_META",
          error: parsedMeta.error,
        });
        return true;
      }

      const meta = parsedMeta.meta;
      const source = getRecorderEventSource(sender, meta);
      const sourceKey = getRecorderSourceKey(source);

      if (source.tabId < 0) {
        sendResponse({
          ok: false,
          code: "INVALID_SOURCE",
          error: "recorder event requires a tab",
        });
        return true;
      }
      if (!session.hasActiveTab(source.tabId)) {
        sendResponse({
          ok: false,
          code: "INVALID_SOURCE",
          error:
            "recorder event source tab is not part of this recording session",
        });
        return true;
      }
      if (
        source.frameId === 0 &&
        source.documentId !== "legacy-document" &&
        typeof session.matchesActiveTabDocument === "function" &&
        !session.matchesActiveTabDocument(source.tabId, source.documentId)
      ) {
        sendResponse({
          ok: false,
          code: "STALE_DOCUMENT",
          error: "recorder event came from a replaced top-frame document",
        });
        return true;
      }

      if (meta.sessionId !== sessionId) {
        sendResponse({
          ok: false,
          code: "SESSION_MISMATCH",
          error: `session mismatch: expected ${sessionId}, got ${meta.sessionId}`,
          ack: buildAck(meta, tracker.getHighWatermark(sourceKey), "stale"),
        });
        return true;
      }

      const decision = tracker.decide(meta, sourceKey);
      const highWatermarkSeq = tracker.getHighWatermark(sourceKey);

      if (decision !== "accept") {
        return respondAfterCheckpoint(
          {
            ok: true,
            deduped: true,
            ack: buildAck(meta, highWatermarkSeq, decision),
          },
          sendResponse,
        );
      }

      let result: PayloadApplyResult = { ok: true };
      if (
        payload.kind === "iframeStep" ||
        payload.kind === "iframeStepUpsert"
      ) {
        if (source.frameId <= 0) {
          result = {
            ok: false,
            error: "iframe steps must come directly from a child frame",
          };
        } else {
          const frameEventId = parseFrameEventId(payload.frameEventId);
          const step = sanitizeRecorderStep(payload.step);
          if (!frameEventId) {
            result = { ok: false, error: "invalid iframe frameEventId" };
          } else if (!step.ok) {
            result = step;
          } else {
            const staged = pendingFrameSteps.put(source.tabId, frameEventId, {
              step: step.value,
              href: String(meta.source?.href || "").slice(0, 16_384),
              createdAt: Date.now(),
            });
            if (!staged) {
              result = {
                ok: false,
                error: "pending iframe step capacity exceeded",
                code: "RECORDING_LIMIT",
              };
            } else
              try {
                chrome.tabs
                  .sendMessage(
                    source.tabId,
                    {
                      action: "rr_register_iframe_event",
                      sessionId,
                      frameEventId,
                    },
                    { frameId: 0 },
                  )
                  .then((registration) => {
                    if (!registration?.ok) {
                      pendingFrameSteps.delete(source.tabId, frameEventId);
                      sendResponse({
                        ok: false,
                        code: "FRAME_REGISTRATION_FAILED",
                        error: "top frame did not register iframe event",
                      });
                      return;
                    }
                    tracker.commit(meta, sourceKey);
                    respondAfterCheckpoint(
                      {
                        ok: true,
                        ack: buildAck(
                          meta,
                          tracker.getHighWatermark(sourceKey),
                          "accept",
                        ),
                      },
                      sendResponse,
                    );
                  })
                  .catch((error) => {
                    pendingFrameSteps.delete(source.tabId, frameEventId);
                    sendResponse({
                      ok: false,
                      code: "FRAME_REGISTRATION_FAILED",
                      error: String((error as Error)?.message || error),
                    });
                  });
                return true;
              } catch (error) {
                pendingFrameSteps.delete(source.tabId, frameEventId);
                result = {
                  ok: false,
                  error: `failed to register iframe event: ${String(
                    (error as Error)?.message || error,
                  )}`,
                };
              }
          }
        }
      } else if (payload.kind === "iframeFrameContext") {
        if (source.frameId !== 0) {
          result = {
            ok: false,
            error: "iframe frame context must come from the top frame",
          };
        } else {
          const frameEventId = parseFrameEventId(payload.frameEventId);
          if (!frameEventId) {
            result = { ok: false, error: "invalid iframe frameEventId" };
          } else {
            const pending = pendingFrameSteps.get(source.tabId, frameEventId);
            if (!pending) {
              result = {
                ok: false,
                error: "unknown or already consumed iframe frameEventId",
              };
            } else {
              const composed = composeFrameTargetStep(
                pending,
                payload.frameTarget,
              );
              if (!composed.ok || !composed.step) {
                result = composed.ok
                  ? { ok: false, error: "failed to compose iframe step" }
                  : composed;
              } else {
                result = appendValidatedSteps(
                  [composed.step],
                  session,
                  source.tabId,
                  lastStepByTab,
                );
                if (result.ok)
                  pendingFrameSteps.delete(source.tabId, frameEventId);
              }
            }
          }
        }
      } else {
        result = applyPayload(payload, session, source.tabId, lastStepByTab);
      }

      if (!result.ok) {
        const response = {
          ok: false,
          code: result.code ?? "INVALID_PAYLOAD",
          error: result.error,
        };
        return result.code === "RECORDING_LIMIT"
          ? respondAfterCheckpoint(response, sendResponse)
          : (sendResponse(response), true);
      }
      tracker.commit(meta, sourceKey);
      return respondAfterCheckpoint(
        {
          ok: true,
          ack: buildAck(meta, tracker.getHighWatermark(sourceKey), "accept"),
        },
        sendResponse,
      );
    } catch (e) {
      console.warn("ContentMessageHandler: processing message failed", e);
      sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      return true;
    }
  };

  return (message, sender, sendResponse) => {
    if (!message || message.type !== TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT)
      return false;
    if (session.isRecoveryReady?.() !== false) {
      return handleMessage(message, sender, sendResponse);
    }
    session
      .waitUntilReady()
      .then(() => handleMessage(message, sender, sendResponse))
      .catch((error) => {
        sendResponse({
          ok: false,
          code: "RECOVERY_UNAVAILABLE",
          error: String((error as Error)?.message || error),
        });
      });
    return true;
  };
}

/**
 * Initialize the content message handler for receiving steps and variables from content scripts.
 *
 * Supports the following payload kinds:
 * - 'steps' | 'step': Append steps to the current flow
 * - 'variables': Append variables to the current flow (for sensitive input handling)
 * - 'batch': Append steps + variables in one message
 * - 'iframeStep' | 'iframeStepUpsert': Stage a child-frame-authenticated step
 * - 'iframeFrameContext': Join staged step with top-frame selector metadata
 */
export function initContentMessageHandler(
  session: RecordingSessionManager,
): void {
  chrome.runtime.onMessage.addListener(
    createRecorderEventMessageHandler(session),
  );
}
