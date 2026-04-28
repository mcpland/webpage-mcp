import { type CSSProperties, useMemo, useState } from "react";

import type { JsonObject } from "@/entrypoints/background/record-replay-v3/domain/json";
import type {
  TriggerKind,
  TriggerSpec,
} from "@/entrypoints/background/record-replay-v3/domain/triggers";
import { getMessage } from "@/utils/i18n";
import WorkflowListItem, { type WorkflowFlowLite } from "./WorkflowListItem";
import "./WorkflowsView.css";

export type FlowLite = WorkflowFlowLite;

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

export interface RunLite {
  id: string;
  flowId: string;
  startedAt: string;
  finishedAt?: string;
  success?: boolean;
  isInProgress?: boolean;
  status?:
    | "queued"
    | "running"
    | "paused"
    | "succeeded"
    | "failed"
    | "canceled";
  entries: Array<{
    status?: string;
    stepId?: string;
    tookMs?: number;
  }>;
}

export interface RecordingStateLite {
  status: "idle" | "recording" | "paused" | "stopping";
  stepCount: number;
  startedAt?: string | null;
  flowName?: string | null;
}

export interface TimelineStepLite {
  id?: string;
  type?: string;
  target?: { selector?: string };
  value?: unknown;
  url?: string;
  keys?: string;
}

export type WorkflowsViewProps = {
  flows: FlowLite[];
  runs: RunLite[];
  triggers: TriggerSpec[];
  recordingState: RecordingStateLite;
  timelineSteps: TimelineStepLite[];
  recordingAction: "start" | "stop" | null;
  onlyBound: boolean;
  openRunId: string | null;
  onRefresh: () => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCreate: () => void;
  onRun: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onRefreshTriggers: () => void;
  onCreateTrigger: (trigger: TriggerDraft) => Promise<boolean> | boolean;
  onUpdateTrigger: (
    trigger: TriggerDraft & { id: string },
  ) => Promise<boolean> | boolean;
  onToggleTrigger: (id: string, enabled: boolean) => Promise<boolean> | boolean;
  onDeleteTrigger: (id: string) => Promise<boolean> | boolean;
  onFireTrigger: (id: string) => Promise<boolean> | boolean;
  onOnlyBoundChange: (value: boolean) => void;
  onToggleRun: (id: string) => void;
};

const containerStyle: CSSProperties = {
  backgroundColor: "var(--ac-surface)",
};

const headerStyle: CSSProperties = {
  borderColor: "var(--ac-border)",
  backgroundColor: "var(--ac-surface)",
};

const inputStyle: CSSProperties = {
  backgroundColor: "var(--ac-surface-muted)",
  border: "var(--ac-border-width) solid var(--ac-border)",
  borderRadius: "var(--ac-radius-button)",
  color: "var(--ac-text)",
  outline: "none",
};

const refreshButtonStyle: CSSProperties = {
  backgroundColor: "var(--ac-surface-muted)",
  color: "var(--ac-text-muted)",
  borderRadius: "var(--ac-radius-button)",
  border: "none",
};

const newButtonStyle: CSSProperties = {
  backgroundColor: "var(--ac-accent)",
  color: "var(--ac-accent-contrast)",
  borderRadius: "var(--ac-radius-button)",
};

const recordingStartButtonStyle: CSSProperties = {
  backgroundColor: "#dc2626",
  color: "#ffffff",
  borderRadius: "var(--ac-radius-button)",
};

const recordingStopButtonStyle: CSSProperties = {
  backgroundColor: "var(--ac-surface-muted)",
  color: "var(--ac-text)",
  borderRadius: "var(--ac-radius-button)",
};

const dividerStyle: CSSProperties = {
  borderColor: "var(--ac-border)",
};

const sectionStyle: CSSProperties = {
  backgroundColor: "var(--ac-surface)",
  border: "var(--ac-border-width) solid var(--ac-border)",
  borderRadius: "var(--ac-radius-inner)",
};

const sectionHeaderStyle: CSSProperties = {
  color: "var(--ac-text)",
};

const runItemStyle: CSSProperties = {
  backgroundColor: "var(--ac-surface-muted)",
  borderRadius: "var(--ac-radius-button)",
};

function toLocalDateTimeInputValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

const defaultOnceAt = () =>
  toLocalDateTimeInputValue(new Date(Date.now() + 60 * 60_000));

type TriggerFormState = {
  flowId: string;
  kind: TriggerKind;
  enabled: boolean;
  argsText: string;
  urlRulesText: string;
  periodMinutes: string;
  onceAt: string;
  commandKey: string;
  contextMenuTitle: string;
  contextMenuContextsText: string;
  domSelector: string;
  domAppear: boolean;
  domOnce: boolean;
  domDebounceMs: string;
};

function createDefaultTriggerForm(flowId = ""): TriggerFormState {
  return {
    flowId,
    kind: "manual",
    enabled: true,
    argsText: "",
    urlRulesText: "",
    periodMinutes: "60",
    onceAt: defaultOnceAt(),
    commandKey: "",
    contextMenuTitle: "",
    contextMenuContextsText: "page",
    domSelector: "",
    domAppear: true,
    domOnce: true,
    domDebounceMs: "800",
  };
}

export default function WorkflowsView({
  flows,
  runs,
  triggers,
  recordingState,
  timelineSteps,
  recordingAction,
  onlyBound,
  openRunId,
  onRefresh,
  onStartRecording,
  onStopRecording,
  onCreate,
  onRun,
  onEdit,
  onDelete,
  onExport,
  onRefreshTriggers,
  onCreateTrigger,
  onUpdateTrigger,
  onToggleTrigger,
  onDeleteTrigger,
  onFireTrigger,
  onOnlyBoundChange,
  onToggleRun,
}: WorkflowsViewProps) {
  const t = (key: string, fallback: string, substitutions?: string[]): string =>
    getMessage(key, substitutions, fallback);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(),
  );
  const [triggerForm, setTriggerForm] = useState<TriggerFormState>(() =>
    createDefaultTriggerForm(),
  );
  const [triggerFormError, setTriggerFormError] = useState<string | null>(null);
  const [editingTriggerId, setEditingTriggerId] = useState<string | null>(null);

  const filteredFlows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return flows;
    }

    return flows.filter((flow) => {
      const name = (flow.name || "").toLowerCase();
      const desc = (flow.description || "").toLowerCase();
      const domain = (flow.meta?.domain || "").toLowerCase();
      const tags = (flow.meta?.tags || []).join(" ").toLowerCase();
      return (
        name.includes(query) ||
        desc.includes(query) ||
        domain.includes(query) ||
        tags.includes(query)
      );
    });
  }, [flows, searchQuery]);
  const isRecordingActive = recordingState.status !== "idle";
  const canStartRecording = !isRecordingActive && recordingAction === null;
  const canStopRecording = isRecordingActive && recordingAction === null;
  const selectedTriggerFlowId =
    triggerForm.flowId || filteredFlows[0]?.id || flows[0]?.id || "";
  const sortedTriggers = useMemo(
    () =>
      [...triggers].sort((a, b) => {
        const flowCompare = getFlowName(a.flowId).localeCompare(
          getFlowName(b.flowId),
        );
        if (flowCompare !== 0) return flowCompare;
        return a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);
      }),
    [triggers, flows],
  );

  function getFlowName(flowId: string): string {
    const flow = flows.find((item) => item.id === flowId);
    return flow?.name || flowId;
  }

  function formatTriggerDetail(trigger: TriggerSpec): string {
    if (trigger.kind === "manual") {
      return t("workflowsTriggerManualDetail", "Manual run");
    }
    if (trigger.kind === "url") {
      return trigger.match
        .map((rule) => `${rule.kind}:${rule.value}`)
        .join(", ");
    }
    if (trigger.kind === "interval") {
      return t("workflowsTriggerIntervalDetail", "Every {0} minutes", [
        String(trigger.periodMinutes),
      ]);
    }
    if (trigger.kind === "once") {
      return new Date(trigger.whenMs).toLocaleString();
    }
    if (trigger.kind === "command") {
      return trigger.commandKey;
    }
    if (trigger.kind === "contextMenu") {
      return trigger.title;
    }
    if (trigger.kind === "dom") {
      return trigger.selector;
    }
    return String((trigger as { id: string }).id);
  }

  function parseTriggerArgs(): JsonObject | undefined {
    const raw = triggerForm.argsText.trim();
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Trigger args must be a JSON object");
    }
    return parsed as JsonObject;
  }

  function parseContextMenuContexts(): string[] | undefined {
    const contexts = triggerForm.contextMenuContextsText
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return contexts.length > 0 ? contexts : undefined;
  }

  function parseUrlTriggerRules(): Array<{
    kind: "url" | "domain" | "path";
    value: string;
  }> {
    const lines = triggerForm.urlRulesText
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      throw new Error("At least one URL trigger rule is required");
    }

    return lines.map((line, index) => {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex < 1) {
        throw new Error(`URL trigger rule ${index + 1} must use kind:value`);
      }

      const kind = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      if (kind !== "url" && kind !== "domain" && kind !== "path") {
        throw new Error(
          `URL trigger rule ${index + 1} kind must be url, domain, or path`,
        );
      }
      if (!value) {
        throw new Error(`URL trigger rule ${index + 1} value is required`);
      }
      return { kind, value };
    });
  }

  function resetTriggerForm(flowId = selectedTriggerFlowId): void {
    setEditingTriggerId(null);
    setTriggerForm(createDefaultTriggerForm(flowId));
    setTriggerFormError(null);
  }

  function loadTriggerForEdit(trigger: TriggerSpec): void {
    const argsText = trigger.args
      ? JSON.stringify(trigger.args, null, 2)
      : "";
    const next = createDefaultTriggerForm(trigger.flowId);
    next.kind = trigger.kind;
    next.enabled = trigger.enabled;
    next.argsText = argsText;

    if (trigger.kind === "url") {
      next.urlRulesText = trigger.match
        .map((rule) => `${rule.kind}:${rule.value}`)
        .join("\n");
    } else if (trigger.kind === "interval") {
      next.periodMinutes = String(trigger.periodMinutes);
    } else if (trigger.kind === "once") {
      next.onceAt = toLocalDateTimeInputValue(new Date(trigger.whenMs));
    } else if (trigger.kind === "command") {
      next.commandKey = trigger.commandKey;
    } else if (trigger.kind === "contextMenu") {
      next.contextMenuTitle = trigger.title;
      next.contextMenuContextsText = (trigger.contexts ?? ["page"]).join(", ");
    } else if (trigger.kind === "dom") {
      next.domSelector = trigger.selector;
      next.domAppear = trigger.appear !== false;
      next.domOnce = trigger.once !== false;
      next.domDebounceMs = String(trigger.debounceMs ?? 800);
    }

    setTriggerForm(next);
    setEditingTriggerId(trigger.id);
    setTriggerFormError(null);
  }

  async function submitTriggerForm(): Promise<void> {
    setTriggerFormError(null);
    try {
      if (!selectedTriggerFlowId) {
        throw new Error("Select a workflow first");
      }
      const args = parseTriggerArgs();
      const draft: TriggerDraft = {
        kind: triggerForm.kind,
        enabled: triggerForm.enabled,
        flowId: selectedTriggerFlowId,
        ...(args ? { args } : {}),
      };
      if (triggerForm.kind === "url") {
        draft.match = parseUrlTriggerRules();
      } else if (triggerForm.kind === "interval") {
        const periodMinutes = Number(triggerForm.periodMinutes);
        if (!Number.isFinite(periodMinutes) || periodMinutes < 1) {
          throw new Error("Interval must be at least 1 minute");
        }
        draft.periodMinutes = Math.floor(periodMinutes);
      } else if (triggerForm.kind === "once") {
        const whenMs = new Date(triggerForm.onceAt).getTime();
        if (!Number.isFinite(whenMs)) {
          throw new Error("Scheduled time is invalid");
        }
        draft.whenMs = whenMs;
      } else if (triggerForm.kind === "command") {
        const commandKey = triggerForm.commandKey.trim();
        if (!commandKey) throw new Error("Command key is required");
        draft.commandKey = commandKey;
      } else if (triggerForm.kind === "contextMenu") {
        const title = triggerForm.contextMenuTitle.trim();
        if (!title) throw new Error("Context menu title is required");
        draft.title = title;
        draft.contexts = parseContextMenuContexts();
      } else if (triggerForm.kind === "dom") {
        const selector = triggerForm.domSelector.trim();
        if (!selector) throw new Error("DOM selector is required");
        const debounceMs = Number(triggerForm.domDebounceMs);
        if (!Number.isFinite(debounceMs) || debounceMs < 0) {
          throw new Error("DOM debounce must be 0 or greater");
        }
        draft.selector = selector;
        draft.appear = triggerForm.domAppear;
        draft.once = triggerForm.domOnce;
        draft.debounceMs = Math.floor(debounceMs);
      }

      const ok = editingTriggerId
        ? await onUpdateTrigger({ ...draft, id: editingTriggerId })
        : await onCreateTrigger(draft);
      if (ok) {
        resetTriggerForm(selectedTriggerFlowId);
      }
    } catch (error) {
      setTriggerFormError(error instanceof Error ? error.message : String(error));
    }
  }

  async function deleteTriggerFromList(triggerId: string): Promise<void> {
    const ok = await onDeleteTrigger(triggerId);
    if (ok && editingTriggerId === triggerId) {
      resetTriggerForm(selectedTriggerFlowId);
    }
  }

  function getRunStatusColor(run: RunLite): string {
    if (run.isInProgress) {
      return "var(--ac-primary, #3b82f6)";
    }

    if (run.status) {
      if (run.status === "succeeded") return "var(--ac-success, #22c55e)";
      if (run.status === "failed" || run.status === "canceled")
        return "var(--ac-danger, #ef4444)";
      return "var(--ac-primary, #3b82f6)";
    }

    return run.success
      ? "var(--ac-success, #22c55e)"
      : "var(--ac-danger, #ef4444)";
  }

  function getRunStatusText(run: RunLite): string {
    if (run.status) {
      const statusMap: Record<string, string> = {
        queued: t("workflowsRunQueued", "Queued"),
        running: t("workflowsRunRunning", "Running"),
        paused: t("workflowsRunPaused", "Paused"),
        succeeded: t("workflowsRunSucceeded", "Succeeded"),
        failed: t("workflowsRunFailed", "Failed"),
        canceled: t("workflowsRunCanceled", "Canceled"),
      };
      return statusMap[run.status] || run.status;
    }
    return run.success
      ? t("workflowsRunSucceeded", "Succeeded")
      : t("workflowsRunFailed", "Failed");
  }

  function formatTime(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleString();
  }

  function formatTimelineStep(step: TimelineStepLite): string {
    const type = String(step.type || "").trim();
    const selector = step.target?.selector ? String(step.target.selector) : "";
    if (type === "click" || type === "dblclick") {
      return `${type}: ${selector || "(document)"}`;
    }
    if (type === "fill") {
      return `fill ${selector || ""}`;
    }
    if (type === "navigate") {
      return `navigate ${step.url || ""}`;
    }
    if (type === "key") {
      return `key ${String(step.keys || "")}`;
    }
    if (type === "scroll") {
      return "scroll";
    }
    return type || "step";
  }

  function toggleSection(section: string): void {
    setExpandedSections((current) => {
      const next = new Set(current);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }

  return (
    <div className="h-full flex flex-col" style={containerStyle}>
      <div className="flex-shrink-0 px-4 py-3 border-b" style={headerStyle}>
        <div className="workflows-toolbar">
          <div className="workflows-toolbar-search">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
              style={{ color: "var(--ac-text-subtle)" }}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              type="text"
              placeholder={t(
                "workflowsSearchPlaceholder",
                "Search workflows...",
              )}
              className="w-full pl-9 pr-3 py-2 text-sm"
              style={inputStyle}
            />
          </div>

          <div className="workflows-toolbar-actions">
            <button
              className="flex-shrink-0 p-2 workflow-action-button workflow-icon-button"
              style={refreshButtonStyle}
              onClick={onRefresh}
              title={t("workflowsRefreshTitle", "Refresh")}
              type="button"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </button>

            <button
              className={`flex-shrink-0 px-3 py-2 text-sm font-medium workflow-action-button${isRecordingActive ? " workflow-recording-active" : ""}`}
              style={recordingStartButtonStyle}
              onClick={onStartRecording}
              type="button"
              disabled={!canStartRecording}
              title={t("workflowsStartRecordingTitle", "Start recording")}
            >
              <span className="flex items-center justify-center gap-1">
                <span
                  className={`workflow-record-dot${isRecordingActive ? " animate-pulse" : ""}`}
                />
                {recordingAction === "start"
                  ? t("workflowsRecordingStarting", "Starting...")
                  : t("workflowsNewRecordingButton", "New Recording")}
              </span>
            </button>

            <button
              className="flex-shrink-0 px-3 py-2 text-sm font-medium workflow-action-button workflow-record-stop"
              style={recordingStopButtonStyle}
              onClick={onStopRecording}
              type="button"
              disabled={!canStopRecording}
              title={t("workflowsStopRecordingTitle", "Stop recording")}
            >
              {recordingAction === "stop"
                ? t("workflowsRecordingStopping", "Stopping...")
                : t("workflowsStopRecordingButton", "Stop")}
            </button>

            <button
              className="flex-shrink-0 px-3 py-2 text-sm font-medium workflow-action-button"
              style={newButtonStyle}
              onClick={onCreate}
              type="button"
            >
              <span className="flex items-center justify-center gap-1">
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M12 4v16m8-8H4"
                  />
                </svg>
                {t("workflowsCreateButton", "New")}
              </span>
            </button>
          </div>
        </div>

        {isRecordingActive || timelineSteps.length > 0 ? (
          <div className="recording-panel">
            <div className="recording-panel-header">
              <span className="recording-status-chip">
                {recordingState.status === "recording"
                  ? t("workflowsRecordingStatusRecording", "Recording")
                  : recordingState.status === "paused"
                    ? t("workflowsRecordingStatusPaused", "Paused")
                    : recordingState.status === "stopping"
                      ? t("workflowsRecordingStatusStopping", "Stopping")
                      : t("workflowsRecordingStatusIdle", "Idle")}
              </span>
              <span className="recording-meta">
                {t("workflowsRecordingStepCount", "{0} steps", [
                  String(recordingState.stepCount || timelineSteps.length),
                ])}
              </span>
            </div>
            {timelineSteps.length > 0 ? (
              <ol className="recording-timeline-list">
                {timelineSteps.slice(-8).map((step, index) => (
                  <li
                    key={step.id || `${step.type || "step"}-${index}`}
                    className="recording-timeline-item"
                  >
                    <span className="recording-timeline-index">
                      {timelineSteps.length -
                        Math.min(8, timelineSteps.length) +
                        index +
                        1}
                      .
                    </span>
                    <span className="recording-timeline-text">
                      {formatTimelineStep(step)}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="recording-timeline-empty">
                {t("workflowsRecordingWaiting", "Waiting for interaction...")}
              </div>
            )}
          </div>
        ) : null}

        <div className="workflows-summary-row">
          <label
            className="flex items-center gap-2 text-sm cursor-pointer"
            style={{ color: "var(--ac-text-muted)" }}
          >
            <input
              type="checkbox"
              checked={onlyBound}
              onChange={(event) =>
                onOnlyBoundChange(event.currentTarget.checked)
              }
              className="workflow-checkbox"
            />
            <span>{t("workflowsCurrentPageOnly", "Current page only")}</span>
          </label>

          <span className="text-xs" style={{ color: "var(--ac-text-subtle)" }}>
            {filteredFlows.length}{" "}
            {filteredFlows.length !== 1
              ? t("workflowsCountPlural", "workflows")
              : t("workflowsCountSingular", "workflow")}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto ac-scroll">
        {filteredFlows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
              style={{ backgroundColor: "var(--ac-surface-muted)" }}
            >
              <svg
                className="w-8 h-8"
                style={{ color: "var(--ac-text-subtle)" }}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.5"
                  d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
                />
              </svg>
            </div>
            <div
              className="text-sm font-medium mb-1"
              style={{ color: "var(--ac-text)" }}
            >
              {searchQuery
                ? t("workflowsEmptySearchTitle", "No matching workflows")
                : t("workflowsEmptyTitle", "No workflows yet")}
            </div>
            <div
              className="text-xs text-center mb-4"
              style={{ color: "var(--ac-text-muted)" }}
            >
              {searchQuery
                ? t("workflowsEmptySearchDesc", "Try a different search term")
                : t(
                    "workflowsEmptyDesc",
                    "Record your first automation workflow",
                  )}
            </div>
            {!searchQuery ? (
              <button
                className="px-4 py-2 text-sm font-medium"
                style={newButtonStyle}
                onClick={onCreate}
                type="button"
              >
                {t("workflowsCreateWorkflow", "Create workflow")}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="px-4 py-3 space-y-3">
            {filteredFlows.map((flow) => (
              <WorkflowListItem
                key={flow.id}
                flow={flow}
                onRun={onRun}
                onEdit={onEdit}
                onDelete={onDelete}
                onExport={onExport}
              />
            ))}
          </div>
        )}

        <div className="px-4 pb-4">
          <div className="advanced-divider" style={dividerStyle}>
            <span
              style={{
                backgroundColor: "var(--ac-surface)",
                padding: "0 12px",
                color: "var(--ac-text-subtle)",
              }}
            >
              {t("workflowsAdvancedSection", "Advanced")}
            </span>
          </div>

          <div className="advanced-section" style={sectionStyle}>
            <button
              className="advanced-section-header"
              style={sectionHeaderStyle}
              onClick={() => toggleSection("triggers")}
              type="button"
            >
              <div className="flex items-center gap-2">
                <svg
                  className={`w-4 h-4 transition-transform${expandedSections.has("triggers") ? " rotate-90" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 5l7 7-7 7"
                  />
                </svg>
                <span>{t("workflowsTriggersSection", "Triggers")}</span>
              </div>
              <span
                className="text-xs"
                style={{ color: "var(--ac-text-subtle)" }}
              >
                {triggers.length}
              </span>
            </button>

            {expandedSections.has("triggers") ? (
              <div className="advanced-section-content">
                <div className="trigger-manager">
                  <div className="trigger-form-grid">
                    <label className="trigger-field">
                      <span>{t("workflowsTriggerWorkflow", "Workflow")}</span>
                      <select
                        value={selectedTriggerFlowId}
                        onChange={(event) =>
                          setTriggerForm((current) => ({
                            ...current,
                            flowId: event.currentTarget.value,
                          }))
                        }
                      >
                        {flows.length === 0 ? (
                          <option value="">
                            {t("workflowsNoWorkflowsOption", "No workflows")}
                          </option>
                        ) : (
                          flows.map((flow) => (
                            <option key={flow.id} value={flow.id}>
                              {flow.name || flow.id}
                            </option>
                          ))
                        )}
                      </select>
                    </label>

                    <label className="trigger-field">
                      <span>{t("workflowsTriggerType", "Type")}</span>
                      <select
                        value={triggerForm.kind}
                        onChange={(event) =>
                          setTriggerForm((current) => ({
                            ...current,
                            kind: event.currentTarget.value as TriggerKind,
                          }))
                        }
                      >
                        <option value="manual">
                          {t("workflowsTriggerManual", "Manual")}
                        </option>
                        <option value="url">
                          {t("workflowsTriggerUrl", "URL")}
                        </option>
                        <option value="interval">
                          {t("workflowsTriggerInterval", "Interval")}
                        </option>
                        <option value="once">
                          {t("workflowsTriggerOnce", "Once")}
                        </option>
                        <option value="command">
                          {t("workflowsTriggerCommand", "Command")}
                        </option>
                        <option value="contextMenu">
                          {t("workflowsTriggerContextMenu", "Context menu")}
                        </option>
                        <option value="dom">
                          {t("workflowsTriggerDom", "DOM")}
                        </option>
                      </select>
                    </label>

                    {triggerForm.kind === "url" ? (
                      <label className="trigger-field trigger-field-wide">
                        <span>{t("workflowsTriggerRules", "Rules")}</span>
                        <textarea
                          value={triggerForm.urlRulesText}
                          onChange={(event) =>
                            setTriggerForm((current) => ({
                              ...current,
                              urlRulesText: event.currentTarget.value,
                            }))
                          }
                          placeholder={
                            "domain:example.com\npath:/dashboard\nurl:https://example.com/app"
                          }
                          rows={3}
                        />
                      </label>
                    ) : null}

                    {triggerForm.kind === "interval" ? (
                      <label className="trigger-field">
                        <span>{t("workflowsTriggerEvery", "Every minutes")}</span>
                        <input
                          type="number"
                          min={1}
                          value={triggerForm.periodMinutes}
                          onChange={(event) =>
                            setTriggerForm((current) => ({
                              ...current,
                              periodMinutes: event.currentTarget.value,
                            }))
                          }
                        />
                      </label>
                    ) : null}

                    {triggerForm.kind === "once" ? (
                      <label className="trigger-field trigger-field-wide">
                        <span>{t("workflowsTriggerWhen", "When")}</span>
                        <input
                          type="datetime-local"
                          value={triggerForm.onceAt}
                          onChange={(event) =>
                            setTriggerForm((current) => ({
                              ...current,
                              onceAt: event.currentTarget.value,
                            }))
                          }
                        />
                      </label>
                    ) : null}

                    {triggerForm.kind === "command" ? (
                      <label className="trigger-field trigger-field-wide">
                        <span>{t("workflowsTriggerCommandKey", "Command key")}</span>
                        <input
                          value={triggerForm.commandKey}
                          onChange={(event) =>
                            setTriggerForm((current) => ({
                              ...current,
                              commandKey: event.currentTarget.value,
                            }))
                          }
                          placeholder="run-workflow"
                        />
                      </label>
                    ) : null}

                    {triggerForm.kind === "contextMenu" ? (
                      <>
                        <label className="trigger-field trigger-field-wide">
                          <span>
                            {t("workflowsTriggerContextTitle", "Menu title")}
                          </span>
                          <input
                            value={triggerForm.contextMenuTitle}
                            onChange={(event) =>
                              setTriggerForm((current) => ({
                                ...current,
                                contextMenuTitle: event.currentTarget.value,
                              }))
                            }
                            placeholder="Run workflow"
                          />
                        </label>
                        <label className="trigger-field trigger-field-wide">
                          <span>
                            {t(
                              "workflowsTriggerContextScopes",
                              "Contexts",
                            )}
                          </span>
                          <input
                            value={triggerForm.contextMenuContextsText}
                            onChange={(event) =>
                              setTriggerForm((current) => ({
                                ...current,
                                contextMenuContextsText:
                                  event.currentTarget.value,
                              }))
                            }
                            placeholder="page, selection, link"
                          />
                        </label>
                      </>
                    ) : null}

                    {triggerForm.kind === "dom" ? (
                      <>
                        <label className="trigger-field trigger-field-wide">
                          <span>{t("workflowsTriggerDomSelector", "Selector")}</span>
                          <input
                            value={triggerForm.domSelector}
                            onChange={(event) =>
                              setTriggerForm((current) => ({
                                ...current,
                                domSelector: event.currentTarget.value,
                              }))
                            }
                            placeholder=".ready"
                          />
                        </label>
                        <label className="trigger-field">
                          <span>
                            {t("workflowsTriggerDomDebounce", "Debounce ms")}
                          </span>
                          <input
                            type="number"
                            min={0}
                            value={triggerForm.domDebounceMs}
                            onChange={(event) =>
                              setTriggerForm((current) => ({
                                ...current,
                                domDebounceMs: event.currentTarget.value,
                              }))
                            }
                          />
                        </label>
                        <label className="trigger-toggle">
                          <input
                            type="checkbox"
                            checked={triggerForm.domAppear}
                            onChange={(event) =>
                              setTriggerForm((current) => ({
                                ...current,
                                domAppear: event.currentTarget.checked,
                              }))
                            }
                          />
                          <span>{t("workflowsTriggerDomAppear", "Appears")}</span>
                        </label>
                        <label className="trigger-toggle">
                          <input
                            type="checkbox"
                            checked={triggerForm.domOnce}
                            onChange={(event) =>
                              setTriggerForm((current) => ({
                                ...current,
                                domOnce: event.currentTarget.checked,
                              }))
                            }
                          />
                          <span>{t("workflowsTriggerDomOnce", "Once")}</span>
                        </label>
                      </>
                    ) : null}

                    <label className="trigger-field trigger-field-wide">
                      <span>{t("workflowsTriggerArgs", "Args JSON")}</span>
                      <textarea
                        value={triggerForm.argsText}
                        onChange={(event) =>
                          setTriggerForm((current) => ({
                            ...current,
                            argsText: event.currentTarget.value,
                          }))
                        }
                        placeholder='{"query":"value"}'
                        rows={2}
                      />
                    </label>

                    <label className="trigger-toggle">
                      <input
                        type="checkbox"
                        checked={triggerForm.enabled}
                        onChange={(event) =>
                          setTriggerForm((current) => ({
                            ...current,
                            enabled: event.currentTarget.checked,
                          }))
                        }
                      />
                      <span>{t("workflowsTriggerEnabled", "Enabled")}</span>
                    </label>
                  </div>

                  {triggerFormError ? (
                    <div className="trigger-form-error">{triggerFormError}</div>
                  ) : null}

                  <div className="trigger-actions-row">
                    <button type="button" onClick={() => void submitTriggerForm()}>
                      {editingTriggerId
                        ? t("workflowsTriggerSave", "Save trigger")
                        : t("workflowsTriggerCreate", "Create trigger")}
                    </button>
                    {editingTriggerId ? (
                      <button
                        type="button"
                        onClick={() => resetTriggerForm(selectedTriggerFlowId)}
                      >
                        {t("workflowsTriggerCancelEdit", "Cancel edit")}
                      </button>
                    ) : null}
                    <button type="button" onClick={onRefreshTriggers}>
                      {t("workflowsRefreshTitle", "Refresh")}
                    </button>
                  </div>

                  {sortedTriggers.length === 0 ? (
                    <div
                      className="text-sm py-3"
                      style={{ color: "var(--ac-text-muted)" }}
                    >
                      {t("workflowsNoTriggers", "No triggers yet")}
                    </div>
                  ) : (
                    <div className="trigger-list">
                      {sortedTriggers.map((trigger) => (
                        <div key={trigger.id} className="trigger-item">
                          <div className="trigger-item-main">
                            <div className="trigger-item-title">
                              <span className="trigger-kind">{trigger.kind}</span>
                              <span>{getFlowName(trigger.flowId)}</span>
                            </div>
                            <div className="trigger-item-detail">
                              {formatTriggerDetail(trigger)}
                            </div>
                          </div>
                          <div className="trigger-item-actions">
                            {trigger.kind === "manual" ? (
                              <button
                                type="button"
                                disabled={!trigger.enabled}
                                onClick={() => void onFireTrigger(trigger.id)}
                              >
                                {t("workflowsTriggerFire", "Run")}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => loadTriggerForEdit(trigger)}
                            >
                              {t("workflowsEditAction", "Edit")}
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void onToggleTrigger(
                                  trigger.id,
                                  !trigger.enabled,
                                )
                              }
                            >
                              {trigger.enabled
                                ? t("workflowsTriggerDisable", "Disable")
                                : t("workflowsTriggerEnable", "Enable")}
                            </button>
                            <button
                              type="button"
                              className="trigger-danger"
                              onClick={() => void deleteTriggerFromList(trigger.id)}
                            >
                              {t("workflowsDeleteAction", "Delete")}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>

          <div className="advanced-section" style={sectionStyle}>
            <button
              className="advanced-section-header"
              style={sectionHeaderStyle}
              onClick={() => toggleSection("runs")}
              type="button"
            >
              <div className="flex items-center gap-2">
                <svg
                  className={`w-4 h-4 transition-transform${expandedSections.has("runs") ? " rotate-90" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 5l7 7-7 7"
                  />
                </svg>
                <span>{t("workflowsRunHistory", "Run history")}</span>
              </div>
              <span
                className="text-xs"
                style={{ color: "var(--ac-text-subtle)" }}
              >
                {runs.length}
              </span>
            </button>

            {expandedSections.has("runs") ? (
              <div className="advanced-section-content">
                {runs.length === 0 ? (
                  <div
                    className="text-sm py-3"
                    style={{ color: "var(--ac-text-muted)" }}
                  >
                    {t("workflowsNoRunHistory", "No run history yet")}
                  </div>
                ) : (
                  <div className="space-y-2 py-2">
                    {runs.slice(0, 5).map((run) => (
                      <div
                        key={run.id}
                        className="run-item"
                        style={runItemStyle}
                        onClick={() => onToggleRun(run.id)}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span
                              className={`w-2 h-2 rounded-full${run.isInProgress ? " animate-pulse" : ""}`}
                              style={{
                                backgroundColor: getRunStatusColor(run),
                              }}
                            />
                            <span
                              className="text-sm"
                              style={{ color: "var(--ac-text)" }}
                            >
                              {getFlowName(run.flowId)}
                            </span>
                            {run.status ? (
                              <span
                                className="text-xs px-1.5 py-0.5 rounded"
                                style={{
                                  backgroundColor: run.isInProgress
                                    ? "var(--ac-primary-light, #dbeafe)"
                                    : run.success
                                      ? "var(--ac-success-light, #dcfce7)"
                                      : "var(--ac-danger-light, #fee2e2)",
                                  color: getRunStatusColor(run),
                                }}
                              >
                                {getRunStatusText(run)}
                              </span>
                            ) : null}
                          </div>
                          <span
                            className="text-xs"
                            style={{ color: "var(--ac-text-subtle)" }}
                          >
                            {formatTime(run.startedAt)}
                          </span>
                        </div>

                        {openRunId === run.id ? (
                          <div
                            className="mt-2 pt-2 border-t"
                            style={{ borderColor: "var(--ac-border)" }}
                          >
                            {run.entries.length === 0 && run.status ? (
                              <div
                                className="text-xs py-1"
                                style={{ color: "var(--ac-text-muted)" }}
                              >
                                <div className="flex items-center gap-2">
                                  <span>
                                    {t("workflowsRunStatusPrefix", "Status")}:{" "}
                                    {getRunStatusText(run)}
                                  </span>
                                  {run.finishedAt ? (
                                    <span>
                                      •{" "}
                                      {t(
                                        "workflowsRunDurationPrefix",
                                        "Time taken",
                                      )}
                                      :
                                      {Math.round(
                                        (new Date(run.finishedAt).getTime() -
                                          new Date(run.startedAt).getTime()) /
                                          1000,
                                      )}
                                      {t("workflowsSecondsUnit", "s")}
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                            ) : null}

                            {run.entries.map((entry, index) => (
                              <div
                                key={`${run.id}-${index}`}
                                className="text-xs py-1"
                                style={{
                                  color:
                                    entry.status === "failed"
                                      ? "var(--ac-danger)"
                                      : "var(--ac-text-muted)",
                                }}
                              >
                                {t(
                                  "workflowsRunEntrySummary",
                                  "#{0} {1} - step={2}",
                                  [
                                    String(index + 1),
                                    String(entry.status || ""),
                                    String(entry.stepId || ""),
                                  ],
                                )}
                                {entry.tookMs ? (
                                  <span className="ml-2">
                                    {t("workflowsMillisecondsValue", "{0}ms", [
                                      String(entry.tookMs),
                                    ])}
                                  </span>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
