import type { RecordingSessionManager } from './session-manager';
import type { Step, VariableDef } from '../types';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import {
  type RecorderEventAck,
  type RecorderEventMeta,
  type RecorderEventDecision,
  getRecorderEventSource,
  getRecorderSourceKey,
  parseRecorderEventMeta,
} from './recorder-event-protocol';

const MAX_SOURCES = 200;
const MAX_RECENT_EVENT_IDS_PER_SOURCE = 300;

interface SourceIngestState {
  highWatermarkSeq: number;
  recentEventIds: string[];
  recentEventSet: Set<string>;
  updatedAt: number;
}

class RecorderEventIngestTracker {
  private sessionId = '';
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
      return 'duplicate';
    }

    if (meta.seq <= state.highWatermarkSeq) {
      return 'stale';
    }

    state.highWatermarkSeq = meta.seq;
    state.updatedAt = Date.now();
    state.recentEventSet.add(meta.eventId);
    state.recentEventIds.push(meta.eventId);

    if (state.recentEventIds.length > MAX_RECENT_EVENT_IDS_PER_SOURCE) {
      const evicted = state.recentEventIds.shift();
      if (evicted) state.recentEventSet.delete(evicted);
    }

    return 'accept';
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
    const toDelete = entries.slice(0, Math.max(1, entries.length - MAX_SOURCES));
    for (const [key] of toDelete) {
      this.sourceStates.delete(key);
    }
  }
}

function buildAck(
  meta: Pick<RecorderEventMeta, 'seq' | 'eventId'>,
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

function applyPayload(payload: any, session: RecordingSessionManager): void {
  // Handle steps
  if (payload.kind === 'steps' || payload.kind === 'step') {
    const steps: Step[] = Array.isArray(payload.steps)
      ? (payload.steps as Step[])
      : payload.step
        ? [payload.step as Step]
        : [];
    if (steps.length > 0) {
      session.appendSteps(steps);
    }
  }

  // Handle variables (for sensitive input handling)
  if (payload.kind === 'variables') {
    const variables: VariableDef[] = Array.isArray(payload.variables)
      ? (payload.variables as VariableDef[])
      : [];
    if (variables.length > 0) {
      session.appendVariables(variables);
    }
  }

  // Handle combined payload (steps + variables in one message)
  if (payload.kind === 'batch') {
    const steps: Step[] = Array.isArray(payload.steps) ? (payload.steps as Step[]) : [];
    const variables: VariableDef[] = Array.isArray(payload.variables)
      ? (payload.variables as VariableDef[])
      : [];
    if (steps.length > 0) {
      session.appendSteps(steps);
    }
    if (variables.length > 0) {
      session.appendVariables(variables);
    }
  }
}

export function createRecorderEventMessageHandler(
  session: RecordingSessionManager,
): Parameters<typeof chrome.runtime.onMessage.addListener>[0] {
  const tracker = new RecorderEventIngestTracker();

  return (message, sender, sendResponse) => {
    try {
      if (!message || message.type !== TOOL_MESSAGE_TYPES.RR_RECORDER_EVENT) return false;

      // Accept messages during 'recording' or 'stopping' states
      // 'stopping' allows final steps to arrive during the drain phase
      if (!session.canAcceptSteps()) {
        sendResponse({ ok: true, ignored: true });
        return true;
      }

      const flow = session.getFlow();
      if (!flow) {
        sendResponse({ ok: true, ignored: true });
        return true;
      }

      const payload = message?.payload || {};
      const sessionId = session.getSession().sessionId;
      tracker.alignSession(sessionId);

      const parsedMeta = parseRecorderEventMeta(message?.meta);
      if (!parsedMeta.ok) {
        // Backward compatibility path for older recorder scripts.
        applyPayload(payload, session);
        sendResponse({
          ok: true,
          legacy: true,
          warning: `Recorder meta missing or invalid: ${parsedMeta.error}`,
        });
        return true;
      }

      const meta = parsedMeta.meta;
      const source = getRecorderEventSource(sender);
      const sourceKey = getRecorderSourceKey(source);

      if (meta.sessionId !== sessionId) {
        sendResponse({
          ok: false,
          code: 'SESSION_MISMATCH',
          error: `session mismatch: expected ${sessionId}, got ${meta.sessionId}`,
          ack: buildAck(meta, tracker.getHighWatermark(sourceKey), 'stale'),
        });
        return true;
      }

      const decision = tracker.decide(meta, sourceKey);
      const highWatermarkSeq = tracker.getHighWatermark(sourceKey);

      if (decision !== 'accept') {
        sendResponse({
          ok: true,
          deduped: true,
          ack: buildAck(meta, highWatermarkSeq, decision),
        });
        return true;
      }

      applyPayload(payload, session);
      sendResponse({ ok: true, ack: buildAck(meta, highWatermarkSeq, 'accept') });
      return true;
    } catch (e) {
      console.warn('ContentMessageHandler: processing message failed', e);
      sendResponse({ ok: false, error: String((e as Error)?.message || e) });
      return true;
    }
  };
}

/**
 * Initialize the content message handler for receiving steps and variables from content scripts.
 *
 * Supports the following payload kinds:
 * - 'steps' | 'step': Append steps to the current flow
 * - 'variables': Append variables to the current flow (for sensitive input handling)
 * - 'batch': Append steps + variables in one message
 */
export function initContentMessageHandler(session: RecordingSessionManager): void {
  chrome.runtime.onMessage.addListener(createRecorderEventMessageHandler(session));
}
