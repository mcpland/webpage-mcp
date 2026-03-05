import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import type { Flow } from '../types';
import type { RecordingSessionManager, RecordingStatus } from './session-manager';
import { recordingSession } from './session-manager';

export interface RecordingStateSnapshot {
  status: RecordingStatus;
  sessionId: string | null;
  originTabId: number | null;
  startedAt: string | null;
  durationMs: number;
  stepCount: number;
  activeTabCount: number;
  flowId: string | null;
  flowName: string | null;
}

function countFlowSteps(flow: Flow | null): number {
  if (!flow) return 0;
  if (Array.isArray(flow.nodes)) return flow.nodes.length;
  if (Array.isArray(flow.steps)) return flow.steps.length;
  return 0;
}

export function buildRecordingStateSnapshot(
  sessionManager: RecordingSessionManager = recordingSession,
): RecordingStateSnapshot {
  const status = sessionManager.getStatus();
  const session = sessionManager.getSession();
  const flow = sessionManager.getFlow();
  const startedAt = flow?.meta?.createdAt || null;
  const startedAtMs = startedAt ? Date.parse(startedAt) : NaN;
  const durationMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0;

  return {
    status,
    sessionId: session.sessionId || null,
    originTabId: session.originTabId ?? null,
    startedAt,
    durationMs,
    stepCount: countFlowSteps(flow),
    activeTabCount: session.activeTabs.size,
    flowId: flow?.id ?? null,
    flowName: flow?.name ?? null,
  };
}

export function broadcastRecordingStateChanged(
  state: RecordingStateSnapshot = buildRecordingStateSnapshot(recordingSession),
): void {
  try {
    void chrome.runtime
      .sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.RR_RECORDING_STATE_CHANGED,
        payload: state,
      })
      .catch(() => {
        // Ignore no-listener and transient delivery failures
      });
  } catch {
    // Ignore runtime send failures (e.g., service worker lifecycle edges)
  }
}
