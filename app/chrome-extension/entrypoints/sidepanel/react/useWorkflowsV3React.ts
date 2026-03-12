import { useEffect, useState } from "react";

import type { FlowV3 } from "@/entrypoints/background/record-replay-v3/domain/flow";
import type { RunRecordV3 } from "@/entrypoints/background/record-replay-v3/domain/events";
import type {
  FlowId,
  RunId,
} from "@/entrypoints/background/record-replay-v3/domain/ids";
import type { JsonObject } from "@/entrypoints/background/record-replay-v3/domain/json";
import { useRRV3Rpc } from "@/entrypoints/shared/react/useRRV3Rpc";

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
  status: RunRecordV3["status"];
  entries: Array<{
    status?: string;
    stepId?: string;
    tookMs?: number;
  }>;
}

function mapFlowV3ToLite(flow: FlowV3): FlowLite {
  const domainBinding = flow.meta?.bindings?.find(
    (binding) => binding.kind === "domain",
  );
  return {
    id: flow.id,
    name: flow.name,
    description: flow.description,
    meta: {
      domain: flow.meta?.domain || domainBinding?.value,
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
  const inProgressStatuses = ["queued", "running", "paused"];
  const isInProgress = inProgressStatuses.includes(run.status);

  let success: boolean | undefined;
  if (run.status === "succeeded") success = true;
  else if (run.status === "failed" || run.status === "canceled")
    success = false;

  return {
    id: run.id,
    flowId: run.flowId,
    startedAt: run.startedAt
      ? new Date(run.startedAt).toISOString()
      : new Date(run.createdAt).toISOString(),
    finishedAt: run.finishedAt
      ? new Date(run.finishedAt).toISOString()
      : undefined,
    success,
    isInProgress,
    status: run.status,
    entries: [],
  };
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
  refresh: () => Promise<void>;
  refreshFlows: () => Promise<void>;
  refreshRuns: () => Promise<void>;
  runFlow: (flowId: string) => Promise<{ runId: string } | null>;
  deleteFlow: (flowId: string) => Promise<boolean>;
  exportFlow: (flowId: string) => Promise<FlowV3 | null>;
  saveFlow: (flow: FlowV3) => Promise<FlowV3 | null>;
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

  async function refreshFlows(): Promise<void> {
    try {
      const result = (await rpc.request("rr_v3.listFlows")) as FlowV3[] | null;
      setFlows((result || []).map(mapFlowV3ToLite));
    } catch (err) {
      console.warn("[useWorkflowsV3React] Failed to refresh flows:", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refreshRuns(): Promise<void> {
    try {
      const result = (await rpc.request("rr_v3.listRuns")) as
        | RunRecordV3[]
        | null;
      const sorted = (result || [])
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt);
      setRuns(sorted.map(mapRunV3ToLite));
    } catch (err) {
      console.warn("[useWorkflowsV3React] Failed to refresh runs:", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([refreshFlows(), refreshRuns()]);
    } finally {
      setLoading(false);
    }
  }

  async function runFlow(flowId: string): Promise<{ runId: string } | null> {
    try {
      const result = (await rpc.request("rr_v3.enqueueRun", {
        flowId: flowId as FlowId,
      })) as { runId: RunId; position: number } | null;
      void refreshRuns();
      return result ? { runId: result.runId } : null;
    } catch (err) {
      console.warn("[useWorkflowsV3React] Failed to run flow:", err);
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function deleteFlow(flowId: string): Promise<boolean> {
    try {
      await rpc.request("rr_v3.deleteFlow", { flowId: flowId as FlowId });
      void refreshFlows();
      return true;
    } catch (err) {
      console.warn("[useWorkflowsV3React] Failed to delete flow:", err);
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  async function exportFlow(flowId: string): Promise<FlowV3 | null> {
    try {
      const result = (await rpc.request("rr_v3.getFlow", {
        flowId: flowId as FlowId,
      })) as FlowV3 | null;
      return result;
    } catch (err) {
      console.warn("[useWorkflowsV3React] Failed to export flow:", err);
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function saveFlow(flow: FlowV3): Promise<FlowV3 | null> {
    try {
      const result = (await rpc.request("rr_v3.saveFlow", {
        flow: flow as unknown as JsonObject,
      })) as FlowV3 | null;
      void refreshFlows();
      return result;
    } catch (err) {
      console.warn("[useWorkflowsV3React] Failed to save flow:", err);
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function getFlowById(flowId: string): Promise<FlowV3 | null> {
    try {
      return (await rpc.request("rr_v3.getFlow", {
        flowId: flowId as FlowId,
      })) as FlowV3 | null;
    } catch (err) {
      console.warn("[useWorkflowsV3React] Failed to get flow:", err);
      return null;
    }
  }

  async function getRunEvents(runId: string): Promise<unknown[]> {
    try {
      return (await rpc.request("rr_v3.getEvents", {
        runId: runId as RunId,
      })) as unknown[];
    } catch (err) {
      console.warn("[useWorkflowsV3React] Failed to get run events:", err);
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
          "run.queued",
          "run.started",
          "run.succeeded",
          "run.failed",
          "run.canceled",
          "run.paused",
          "run.resumed",
          "run.recovered",
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
    refresh,
    refreshFlows,
    refreshRuns,
    runFlow,
    deleteFlow,
    exportFlow,
    saveFlow,
    getFlowById,
    getRunEvents,
  };
}
