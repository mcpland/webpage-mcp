import { useEffect, useState } from 'react';

import type { FlowV3 } from '@/entrypoints/background/record-replay-v3/domain/flow';
import type { RunRecordV3 } from '@/entrypoints/background/record-replay-v3/domain/events';
import type { TriggerSpec } from '@/entrypoints/background/record-replay-v3/domain/triggers';
import type { FlowId, RunId } from '@/entrypoints/background/record-replay-v3/domain/ids';
import { useRRV3Rpc } from '@/entrypoints/shared/react/useRRV3Rpc';

// Route A scope: trigger/schedule management is out of connector surface.
const ENABLE_TRIGGER_MANAGEMENT = false;
const TRIGGER_SCOPE_DISABLED_ERROR = 'Triggers are disabled in Connector scope.';

export interface FlowLite {
  id: string;
  name: string;
  description?: string;
  meta?: {
    domain?: string;
    tags?: string[];
    bindings?: Array<{
      kind?: string;
      type?: string;
      value: string;
    }>;
  };
}

export interface RunLite {
  id: string;
  flowId: string;
  startedAt: string;
  finishedAt?: string;
  success?: boolean;
  isInProgress: boolean;
  status: RunRecordV3['status'];
  entries: Array<{
    status?: string;
    stepId?: string;
    tookMs?: number;
  }>;
}

export interface TriggerLite {
  id: string;
  type: string;
  kind: string;
  flowId: string;
  enabled?: boolean;
  match?: Array<{ kind: string; value: string }>;
  [key: string]: unknown;
}

function mapFlowV3ToLite(flow: FlowV3): FlowLite {
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    meta: {
      tags: flow.meta?.tags,
      bindings: flow.meta?.bindings?.map((binding) => ({
        kind: binding.kind,
        type: binding.kind,
        value: binding.value,
      })),
    },
  };
}

function mapRunV3ToLite(run: RunRecordV3): RunLite {
  const inProgressStatuses = ['queued', 'running', 'paused'];
  const isInProgress = inProgressStatuses.includes(run.status);

  let success: boolean | undefined;
  if (run.status === 'succeeded') success = true;
  else if (run.status === 'failed' || run.status === 'canceled') success = false;

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
    entries: [],
  };
}

function mapTriggerV3ToLite(trigger: TriggerSpec): TriggerLite {
  return {
    ...trigger,
    type: trigger.kind,
    kind: trigger.kind,
  } as TriggerLite;
}

export interface UseWorkflowsV3ReactOptions {
  autoRefreshMs?: number;
  autoConnect?: boolean;
}

export interface UseWorkflowsV3ReactReturn {
  connected: boolean;
  loading: boolean;
  error: string | null;
  flows: FlowLite[];
  runs: RunLite[];
  triggers: TriggerLite[];
  refresh: () => Promise<void>;
  refreshFlows: () => Promise<void>;
  refreshRuns: () => Promise<void>;
  refreshTriggers: () => Promise<void>;
  runFlow: (flowId: string) => Promise<{ runId: string } | null>;
  deleteFlow: (flowId: string) => Promise<boolean>;
  exportFlow: (flowId: string) => Promise<FlowV3 | null>;
  deleteTrigger: (triggerId: string) => Promise<boolean>;
  getFlowById: (flowId: string) => Promise<FlowV3 | null>;
  getRunEvents: (runId: string) => Promise<unknown[]>;
}

export function useWorkflowsV3React(
  options: UseWorkflowsV3ReactOptions = {},
): UseWorkflowsV3ReactReturn {
  const { autoRefreshMs = 0, autoConnect = true } = options;

  const rpc = useRRV3Rpc({ autoConnect });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flows, setFlows] = useState<FlowLite[]>([]);
  const [runs, setRuns] = useState<RunLite[]>([]);
  const [triggers, setTriggers] = useState<TriggerLite[]>([]);

  async function refreshFlows(): Promise<void> {
    try {
      const result = (await rpc.request('rr_v3.listFlows')) as FlowV3[] | null;
      setFlows((result || []).map(mapFlowV3ToLite));
    } catch (err) {
      console.warn('[useWorkflowsV3React] Failed to refresh flows:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refreshRuns(): Promise<void> {
    try {
      const result = (await rpc.request('rr_v3.listRuns')) as RunRecordV3[] | null;
      const sorted = (result || []).slice().sort((a, b) => b.createdAt - a.createdAt);
      setRuns(sorted.map(mapRunV3ToLite));
    } catch (err) {
      console.warn('[useWorkflowsV3React] Failed to refresh runs:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refreshTriggers(): Promise<void> {
    if (!ENABLE_TRIGGER_MANAGEMENT) {
      setTriggers([]);
      return;
    }
    try {
      const result = (await rpc.request('rr_v3.listTriggers')) as TriggerSpec[] | null;
      setTriggers((result || []).map(mapTriggerV3ToLite));
    } catch (err) {
      console.warn('[useWorkflowsV3React] Failed to refresh triggers:', err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      if (ENABLE_TRIGGER_MANAGEMENT) {
        await Promise.all([refreshFlows(), refreshRuns(), refreshTriggers()]);
      } else {
        await Promise.all([refreshFlows(), refreshRuns()]);
        setTriggers([]);
      }
    } finally {
      setLoading(false);
    }
  }

  async function runFlow(flowId: string): Promise<{ runId: string } | null> {
    try {
      const result = (await rpc.request('rr_v3.enqueueRun', {
        flowId: flowId as FlowId,
      })) as { runId: RunId; position: number } | null;
      void refreshRuns();
      return result ? { runId: result.runId } : null;
    } catch (err) {
      console.warn('[useWorkflowsV3React] Failed to run flow:', err);
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function deleteFlow(flowId: string): Promise<boolean> {
    try {
      await rpc.request('rr_v3.deleteFlow', { flowId: flowId as FlowId });
      void refreshFlows();
      return true;
    } catch (err) {
      console.warn('[useWorkflowsV3React] Failed to delete flow:', err);
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async function exportFlow(flowId: string): Promise<FlowV3 | null> {
    try {
      const result = (await rpc.request('rr_v3.getFlow', {
        flowId: flowId as FlowId,
      })) as FlowV3 | null;
      return result;
    } catch (err) {
      console.warn('[useWorkflowsV3React] Failed to export flow:', err);
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function deleteTrigger(triggerId: string): Promise<boolean> {
    if (!ENABLE_TRIGGER_MANAGEMENT) {
      setError(TRIGGER_SCOPE_DISABLED_ERROR);
      return false;
    }
    try {
      await rpc.request('rr_v3.deleteTrigger', { triggerId });
      void refreshTriggers();
      return true;
    } catch (err) {
      console.warn('[useWorkflowsV3React] Failed to delete trigger:', err);
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async function getFlowById(flowId: string): Promise<FlowV3 | null> {
    try {
      return (await rpc.request('rr_v3.getFlow', {
        flowId: flowId as FlowId,
      })) as FlowV3 | null;
    } catch (err) {
      console.warn('[useWorkflowsV3React] Failed to get flow:', err);
      return null;
    }
  }

  async function getRunEvents(runId: string): Promise<unknown[]> {
    try {
      return (await rpc.request('rr_v3.getEvents', {
        runId: runId as RunId,
      })) as unknown[];
    } catch (err) {
      console.warn('[useWorkflowsV3React] Failed to get run events:', err);
      return [];
    }
  }

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    let unsubscribeEvent: (() => void) | null = null;

    void (async () => {
      if (autoConnect) {
        await rpc.ensureConnected();
        await refresh();
      }

      if (autoRefreshMs > 0) {
        refreshTimer = setInterval(() => {
          void refresh();
        }, autoRefreshMs);
      }

      void rpc.subscribe(null);
      unsubscribeEvent = rpc.onEvent((event) => {
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
    })();

    return () => {
      if (refreshTimer) {
        clearInterval(refreshTimer);
      }
      if (unsubscribeEvent) {
        unsubscribeEvent();
      }
      void rpc.unsubscribe(null);
    };
  }, []);

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
