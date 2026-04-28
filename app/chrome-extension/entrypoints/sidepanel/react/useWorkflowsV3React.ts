import { useEffect, useState } from "react";

import type { FlowV3 } from "@/entrypoints/background/record-replay-v3/domain/flow";
import type { RunRecordV3 } from "@/entrypoints/background/record-replay-v3/domain/events";
import type {
  TriggerKind,
  TriggerSpec,
} from "@/entrypoints/background/record-replay-v3/domain/triggers";
import type {
  FlowId,
  RunId,
  TriggerId,
} from "@/entrypoints/background/record-replay-v3/domain/ids";
import type { JsonObject } from "@/entrypoints/background/record-replay-v3/domain/json";
import { useRRV3Rpc } from "@/entrypoints/shared/react/useRRV3Rpc";
import {
  getActiveCurrentWindowTab,
  getActiveCurrentWindowTabId,
} from "@/entrypoints/shared/utils";

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

export type TriggerDraft = {
  id?: string;
  kind: TriggerKind;
  enabled: boolean;
  flowId: string;
  args?: JsonObject;
  match?: Array<{ kind: "url" | "domain" | "path"; value: string }>;
  periodMinutes?: number;
  whenMs?: number;
  commandKey?: string;
  title?: string;
  contexts?: string[];
  selector?: string;
  appear?: boolean;
  once?: boolean;
  debounceMs?: number;
};

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

async function getActiveTriggerContext(): Promise<{
  sourceTabId?: number;
  sourceUrl?: string;
}> {
  const tab = await getActiveCurrentWindowTab();
  const sourceTabId =
    typeof tab?.id === "number" && Number.isFinite(tab.id)
      ? Math.floor(tab.id)
      : undefined;
  const sourceUrl = typeof tab?.url === "string" ? tab.url : undefined;

  return {
    ...(sourceTabId !== undefined ? { sourceTabId } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
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
  triggers: TriggerSpec[];
  refresh: () => Promise<void>;
  refreshFlows: () => Promise<void>;
  refreshRuns: () => Promise<void>;
  refreshTriggers: (flowId?: string) => Promise<void>;
  runFlow: (flowId: string) => Promise<{ runId: string } | null>;
  deleteFlow: (flowId: string) => Promise<boolean>;
  exportFlow: (flowId: string) => Promise<FlowV3 | null>;
  saveFlow: (flow: FlowV3) => Promise<FlowV3 | null>;
  getFlowById: (flowId: string) => Promise<FlowV3 | null>;
  getRunEvents: (runId: string) => Promise<unknown[]>;
  createTrigger: (trigger: TriggerDraft) => Promise<TriggerSpec | null>;
  updateTrigger: (
    trigger: TriggerDraft & { id: string },
  ) => Promise<TriggerSpec | null>;
  deleteTrigger: (triggerId: string) => Promise<boolean>;
  setTriggerEnabled: (triggerId: string, enabled: boolean) => Promise<boolean>;
  fireTrigger: (triggerId: string) => Promise<{ runId: string } | null>;
  clearError: () => void;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return String((error as { message: string }).message);
  }
  return fallback;
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error
    ? error
    : new Error(errorMessage(error, fallback));
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
  const [triggers, setTriggers] = useState<TriggerSpec[]>([]);

  function clearError(): void {
    setError(null);
  }

  function captureError(error: unknown, fallback: string): Error {
    const normalized = toError(error, fallback);
    setError(errorMessage(normalized, fallback));
    return normalized;
  }

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

  async function refreshTriggers(flowId?: string): Promise<void> {
    try {
      const result = (await rpc.request("rr_v3.listTriggers", {
        ...(flowId ? { flowId: flowId as FlowId } : {}),
      })) as TriggerSpec[] | null;
      setTriggers(result || []);
    } catch (err) {
      console.warn("[useWorkflowsV3React] Failed to refresh triggers:", err);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refresh(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([refreshFlows(), refreshRuns(), refreshTriggers()]);
    } finally {
      setLoading(false);
    }
  }

  async function runFlow(flowId: string): Promise<{ runId: string } | null> {
    try {
      const tabId = await getActiveCurrentWindowTabId();
      const result = (await rpc.request("rr_v3.enqueueRun", {
        flowId: flowId as FlowId,
        ...(tabId !== undefined ? { tabId } : {}),
        tabTarget: "current",
      })) as { runId: RunId; position: number } | null;
      clearError();
      void refreshRuns();
      return result ? { runId: result.runId } : null;
    } catch (err) {
      console.warn("[useWorkflowsV3React] Failed to run flow:", err);
      throw captureError(err, "Failed to run workflow");
    }
  }

  async function deleteFlow(flowId: string): Promise<boolean> {
    try {
      await rpc.request("rr_v3.deleteFlow", { flowId: flowId as FlowId });
      clearError();
      void refreshFlows();
      return true;
    } catch (err) {
      console.warn("[useWorkflowsV3React] Failed to delete flow:", err);
      throw captureError(err, "Failed to delete workflow");
    }
  }

  async function exportFlow(flowId: string): Promise<FlowV3 | null> {
    try {
      const result = (await rpc.request("rr_v3.getFlow", {
        flowId: flowId as FlowId,
      })) as FlowV3 | null;
      clearError();
      return result;
    } catch (err) {
      console.warn("[useWorkflowsV3React] Failed to export flow:", err);
      throw captureError(err, "Failed to export workflow");
    }
  }

  async function saveFlow(flow: FlowV3): Promise<FlowV3 | null> {
    try {
      const result = (await rpc.request("rr_v3.saveFlow", {
        flow: flow as unknown as JsonObject,
      })) as FlowV3 | null;
      clearError();
      void refreshFlows();
      return result;
    } catch (err) {
      console.warn("[useWorkflowsV3React] Failed to save flow:", err);
      throw captureError(err, "Failed to save workflow");
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

  async function createTrigger(
    trigger: TriggerDraft,
  ): Promise<TriggerSpec | null> {
    try {
      const result = (await rpc.request("rr_v3.createTrigger", {
        trigger: trigger as unknown as JsonObject,
      })) as TriggerSpec | null;
      clearError();
      void refreshTriggers();
      return result;
    } catch (err) {
      console.warn("[useWorkflowsV3React] Failed to create trigger:", err);
      throw captureError(err, "Failed to create trigger");
    }
  }

  async function updateTrigger(
    trigger: TriggerDraft & { id: string },
  ): Promise<TriggerSpec | null> {
    try {
      const result = (await rpc.request("rr_v3.updateTrigger", {
        trigger: trigger as unknown as JsonObject,
      })) as TriggerSpec | null;
      clearError();
      void refreshTriggers();
      return result;
    } catch (err) {
      console.warn("[useWorkflowsV3React] Failed to update trigger:", err);
      throw captureError(err, "Failed to update trigger");
    }
  }

  async function deleteTrigger(triggerId: string): Promise<boolean> {
    try {
      await rpc.request("rr_v3.deleteTrigger", {
        triggerId: triggerId as TriggerId,
      });
      clearError();
      void refreshTriggers();
      return true;
    } catch (err) {
      console.warn("[useWorkflowsV3React] Failed to delete trigger:", err);
      throw captureError(err, "Failed to delete trigger");
    }
  }

  async function setTriggerEnabled(
    triggerId: string,
    enabled: boolean,
  ): Promise<boolean> {
    try {
      await rpc.request(
        enabled ? "rr_v3.enableTrigger" : "rr_v3.disableTrigger",
        {
          triggerId: triggerId as TriggerId,
        },
      );
      clearError();
      void refreshTriggers();
      return true;
    } catch (err) {
      console.warn(
        "[useWorkflowsV3React] Failed to update trigger state:",
        err,
      );
      throw captureError(err, "Failed to update trigger state");
    }
  }

  async function fireTrigger(
    triggerId: string,
  ): Promise<{ runId: string } | null> {
    try {
      const triggerContext = await getActiveTriggerContext();
      const result = (await rpc.request("rr_v3.fireTrigger", {
        triggerId: triggerId as TriggerId,
        ...triggerContext,
      })) as { runId: RunId } | null;
      clearError();
      void refreshRuns();
      return result ? { runId: result.runId } : null;
    } catch (err) {
      console.warn("[useWorkflowsV3React] Failed to fire trigger:", err);
      throw captureError(err, "Failed to run trigger");
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
    triggers,
    refresh,
    refreshFlows,
    refreshRuns,
    refreshTriggers,
    runFlow,
    deleteFlow,
    exportFlow,
    saveFlow,
    getFlowById,
    getRunEvents,
    createTrigger,
    updateTrigger,
    deleteTrigger,
    setTriggerEnabled,
    fireTrigger,
    clearError,
  };
}
