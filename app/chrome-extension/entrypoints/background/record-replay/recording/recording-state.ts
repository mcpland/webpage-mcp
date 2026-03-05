import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import type { Flow } from '../types';
import type { RecordingSessionManager, RecordingStatus } from './session-manager';
import { recordingSession } from './session-manager';

export interface RecordingStateSnapshot {
  status: RecordingStatus;
  sessionId: string | null;
  originTabId: number | null;
  originUrl: string | null;
  originTitle: string | null;
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
  const recordingMeta = flow?.meta?.recording;
  const startedAt = recordingMeta?.startedAt || flow?.meta?.createdAt || null;
  const startedAtMs = startedAt ? Date.parse(startedAt) : NaN;
  const recordedDurationMs =
    typeof recordingMeta?.durationMs === 'number' && Number.isFinite(recordingMeta.durationMs)
      ? recordingMeta.durationMs
      : undefined;
  const durationMs =
    recordedDurationMs ??
    (Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0);
  const recordedStepCount =
    typeof recordingMeta?.stepCount === 'number' && Number.isFinite(recordingMeta.stepCount)
      ? recordingMeta.stepCount
      : undefined;

  return {
    status,
    sessionId: session.sessionId || null,
    originTabId: session.originTabId ?? null,
    originUrl: recordingMeta?.originUrl || null,
    originTitle: recordingMeta?.originTitle || null,
    startedAt,
    durationMs,
    stepCount: recordedStepCount ?? countFlowSteps(flow),
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
