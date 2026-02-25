/**
 * @fileoverview V3 Workflows Data Layer Composable
 * @description Provides V3 workflows data management for Sidepanel UI
 *
 * This composable wraps the V3 RPC client and provides:
 * - Flow listing, running, and deletion
 * - Run listing and event subscription
 * - Trigger management
 * - Data mapping from V3 types to UI types
 */

import { onMounted, onUnmounted, ref, type Ref } from 'vue';

import type { FlowV3 } from '@/entrypoints/background/record-replay-v3/domain/flow';
import type { RunRecordV3 } from '@/entrypoints/background/record-replay-v3/domain/events';
import type { TriggerSpec } from '@/entrypoints/background/record-replay-v3/domain/triggers';
import type { FlowId, RunId } from '@/entrypoints/background/record-replay-v3/domain/ids';
import { useRRV3Rpc } from './useRRV3Rpc';

// ==================== UI Types ====================

/** Flow type for UI display (compatible with existing WorkflowsView) */
export interface FlowLite {
  id: string;
  name: string;
  description?: string;
  meta?: {
    domain?: string;
    tags?: string[];
    bindings?: Array<{
      kind?: string; // V3 uses 'kind'
      type?: string; // V2 uses 'type'
      value: string;
    }>;
  };
}

/** Run type for UI display (compatible with existing WorkflowsView) */
export interface RunLite {
  id: string;
  flowId: string;
  startedAt: string;
  finishedAt?: string;
  /**
   * Terminal success status: true=succeeded, false=failed/canceled, undefined=in progress
   * UI should check `isInProgress` first to distinguish in-progress from failed
   */
  success?: boolean;
  /** Whether the run is still in progress (queued/running/paused) */
  isInProgress: boolean;
  status: RunRecordV3['status'];
  entries: unknown[];
}

/** Trigger type for UI display */
export interface TriggerLite {
  id: string;
  type: string; // UI uses 'type', V3 uses 'kind'
  kind: string; // V3 uses 'kind'
  flowId: string;
  enabled?: boolean;
  match?: Array<{ kind: string; value: string }>; // For URL triggers
  [key: string]: unknown;
}

// ==================== Mappers ====================

/** Convert V3 FlowV3 to UI FlowLite */
function mapFlowV3ToLite(flow: FlowV3): FlowLite {
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    meta: {
      tags: flow.meta?.tags,
      bindings: flow.meta?.bindings?.map((b) => ({
        kind: b.kind,
        type: b.kind, // For V2 compatibility
        value: b.value,
      })),
    },
  };
}

/** Convert V3 RunRecordV3 to UI RunLite */
function mapRunV3ToLite(run: RunRecordV3): RunLite {
  // Determine if run is in progress
  const inProgressStatuses = ['queued', 'running', 'paused'];
  const isInProgress = inProgressStatuses.includes(run.status);

  // Map V3 status to success boolean for terminal states only
  let success: boolean | undefined;
  if (run.status === 'succeeded') success = true;
  else if (run.status === 'failed' || run.status === 'canceled') success = false;
  // For in-progress states, success remains undefined

  return {
    id: run.id,
    flowId: run.flowId,
    startedAt: run.startedAt
      ? new Date(run.startedAt).toISOString()
      : new Date(run.createdAt).toISOString(),
    finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : undefined,
    success,
    isInProgress,
    status: run.status,
    entries: [], // V3 doesn't have entries in RunRecord, use getEvents for details
  };
}

/** Convert V3 TriggerSpec to UI TriggerLite */
function mapTriggerV3ToLite(trigger: TriggerSpec): TriggerLite {
  return {
    ...trigger,
    type: trigger.kind, // Map 'kind' to 'type' for UI compatibility
    kind: trigger.kind,
  } as TriggerLite;
}

// ==================== Composable ====================

export interface UseWorkflowsV3Options {
  /** Auto-refresh interval in ms (0 = disabled) */
  autoRefreshMs?: number;
  /** Auto-connect on mount */
  autoConnect?: boolean;
}

export interface UseWorkflowsV3Return {
  // Connection state
  connected: Ref<boolean>;
  loading: Ref<boolean>;
  error: Ref<string | null>;

  // Data
  flows: Ref<FlowLite[]>;
  runs: Ref<RunLite[]>;
  triggers: Ref<TriggerLite[]>;

  // Actions
  refresh: () => Promise<void>;
  refreshFlows: () => Promise<void>;
  refreshRuns: () => Promise<void>;
  refreshTriggers: () => Promise<void>;
  runFlow: (flowId: string) => Promise<{ runId: string } | null>;
  deleteFlow: (flowId: string) => Promise<boolean>;
  exportFlow: (flowId: string) => Promise<FlowV3 | null>;
  deleteTrigger: (triggerId: string) => Promise<boolean>;

  // V3-specific
  getFlowById: (flowId: string) => Promise<FlowV3 | null>;
  getRunEvents: (runId: string) => Promise<unknown[]>;
}

/**
 * V3 Workflows data layer composable
 */
export function useWorkflowsV3(options: UseWorkflowsV3Options = {}): UseWorkflowsV3Return {
  const { autoRefreshMs = 0, autoConnect = true } = options;

  // RPC client
  const rpc = useRRV3Rpc({ autoConnect });

  // State
  const loading = ref(false);
  const error = ref<string | null>(null);
  const flows = ref<FlowLite[]>([]);
  const runs = ref<RunLite[]>([]);
  const triggers = ref<TriggerLite[]>([]);

  // Auto-refresh timer
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  // Event subscription cleanup function
  let eventUnsubscribe: (() => void) | null = null;

  // ==================== Actions ====================

  async function refreshFlows(): Promise<void> {
    try {
      const result = (await rpc.request('rr_v3.listFlows')) as FlowV3[] | null;
      flows.value = (result || []).map(mapFlowV3ToLite);
    } catch (e) {
      console.warn('[useWorkflowsV3] Failed to refresh flows:', e);
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  async function refreshRuns(): Promise<void> {
    try {
      const result = (await rpc.request('rr_v3.listRuns')) as RunRecordV3[] | null;
      // Sort by createdAt descending (newest first)
      const sorted = (result || []).slice().sort((a, b) => b.createdAt - a.createdAt);
      runs.value = sorted.map(mapRunV3ToLite);
    } catch (e) {
      console.warn('[useWorkflowsV3] Failed to refresh runs:', e);
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  async function refreshTriggers(): Promise<void> {
    try {
      const result = (await rpc.request('rr_v3.listTriggers')) as TriggerSpec[] | null;
      triggers.value = (result || []).map(mapTriggerV3ToLite);
    } catch (e) {
      console.warn('[useWorkflowsV3] Failed to refresh triggers:', e);
      error.value = e instanceof Error ? e.message : String(e);
    }
  }

  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      await Promise.all([refreshFlows(), refreshRuns(), refreshTriggers()]);
    } finally {
      loading.value = false;
    }
  }

  async function runFlow(flowId: string): Promise<{ runId: string } | null> {
    try {
      const result = (await rpc.request('rr_v3.enqueueRun', {
        flowId: flowId as FlowId,
      })) as { runId: RunId; position: number } | null;
      // Refresh runs to show the new run
      void refreshRuns();
      return result ? { runId: result.runId } : null;
    } catch (e) {
      console.warn('[useWorkflowsV3] Failed to run flow:', e);
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async function deleteFlow(flowId: string): Promise<boolean> {
    try {
      await rpc.request('rr_v3.deleteFlow', { flowId: flowId as FlowId });
      // Refresh flows after deletion
      void refreshFlows();
      return true;
    } catch (e) {
      console.warn('[useWorkflowsV3] Failed to delete flow:', e);
      error.value = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async function exportFlow(flowId: string): Promise<FlowV3 | null> {
    try {
      const result = (await rpc.request('rr_v3.getFlow', {
        flowId: flowId as FlowId,
      })) as FlowV3 | null;
      return result;
    } catch (e) {
      console.warn('[useWorkflowsV3] Failed to export flow:', e);
      error.value = e instanceof Error ? e.message : String(e);
      return null;
    }
  }

  async function deleteTrigger(triggerId: string): Promise<boolean> {
    try {
      await rpc.request('rr_v3.deleteTrigger', { triggerId });
      // Refresh triggers after deletion
      void refreshTriggers();
      return true;
    } catch (e) {
      console.warn('[useWorkflowsV3] Failed to delete trigger:', e);
      error.value = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  async function getFlowById(flowId: string): Promise<FlowV3 | null> {
    try {
      return (await rpc.request('rr_v3.getFlow', {
        flowId: flowId as FlowId,
      })) as FlowV3 | null;
    } catch (e) {
      console.warn('[useWorkflowsV3] Failed to get flow:', e);
      return null;
    }
  }

  async function getRunEvents(runId: string): Promise<unknown[]> {
    try {
      return (await rpc.request('rr_v3.getEvents', {
        runId: runId as RunId,
      })) as unknown[];
    } catch (e) {
      console.warn('[useWorkflowsV3] Failed to get run events:', e);
      return [];
    }
  }

  // ==================== Lifecycle ====================

  onMounted(async () => {
    if (autoConnect) {
      await rpc.ensureConnected();
      await refresh();
    }

    // Setup auto-refresh
    if (autoRefreshMs > 0) {
      refreshTimer = setInterval(() => {
        void refresh();
      }, autoRefreshMs);
    }

    // Subscribe to all run events for real-time updates
    void rpc.subscribe(null);
    eventUnsubscribe = rpc.onEvent((event) => {
      // Refresh runs when run status changes
      const runStatusEvents = [
        'run.queued',
        'run.started',
        'run.succeeded',
        'run.failed',
        'run.canceled',
        'run.paused',
        'run.resumed',
        'run.recovered',
      ];
      if (runStatusEvents.includes(event.type)) {
        void refreshRuns();
      }
    });
  });

  onUnmounted(() => {
    // Cleanup auto-refresh timer
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    // Cleanup event subscription
    if (eventUnsubscribe) {
      eventUnsubscribe();
      eventUnsubscribe = null;
    }
    // Unsubscribe from run events
    void rpc.unsubscribe(null);
  });

  return {
    connected: rpc.connected,
    loading,
    error,
    flows,
    runs,
    triggers,
    refresh,
    refreshFlows,
    refreshRuns,
    refreshTriggers,
    runFlow,
    deleteFlow,
    exportFlow,
    deleteTrigger,
    getFlowById,
    getRunEvents,
  };
}
