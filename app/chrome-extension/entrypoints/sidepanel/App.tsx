import { useEffect, useMemo, useState } from "react";

import {
  BACKGROUND_MESSAGE_TYPES,
  TOOL_MESSAGE_TYPES,
} from "@/common/message-types";
import type {
  ElementMarker,
  UpsertMarkerRequest,
} from "@/common/element-marker-types";
import { openWorkflowBuilder } from "@/entrypoints/shared/utils";
import { getMessage } from "@/utils/i18n";
import type { AgentThemeId } from "./composables/useAgentTheme";
import SidepanelNavigator from "./components/SidepanelNavigator";
import { WorkflowsView } from "./components/workflows";
import {
  useWorkflowsV3React,
  type FlowLite,
} from "./react/useWorkflowsV3React";
import "./App.css";

type TabType = "workflows" | "element-markers";

type RecordingStatus = "idle" | "recording" | "paused" | "stopping";

type RecordingState = {
  status: RecordingStatus;
  sessionId: string | null;
  originTabId: number | null;
  startedAt: string | null;
  durationMs: number;
  stepCount: number;
  activeTabCount: number;
  flowId: string | null;
  flowName: string | null;
};

type TimelineStep = {
  id?: string;
  type?: string;
  target?: { selector?: string };
  value?: unknown;
  url?: string;
  keys?: string;
};

type MarkerFormState = UpsertMarkerRequest & {
  selectorType: "css" | "xpath";
  matchType: "exact" | "prefix" | "host";
};

const THEME_STORAGE_KEY = "agentTheme";
const DEFAULT_THEME: AgentThemeId = "warm-editorial";
const VALID_THEMES: AgentThemeId[] = [
  "warm-editorial",
  "blueprint-architect",
  "zen-journal",
  "neo-pop",
  "dark-console",
  "swiss-grid",
];

const DEFAULT_RECORDING_STATE: RecordingState = {
  status: "idle",
  sessionId: null,
  originTabId: null,
  startedAt: null,
  durationMs: 0,
  stepCount: 0,
  activeTabCount: 0,
  flowId: null,
  flowName: null,
};

function isValidTheme(theme: unknown): theme is AgentThemeId {
  return (
    typeof theme === "string" && VALID_THEMES.includes(theme as AgentThemeId)
  );
}

function getThemeFromDocument(): AgentThemeId {
  const theme = document.documentElement.dataset.agentTheme;
  return isValidTheme(theme) ? theme : DEFAULT_THEME;
}

function getCurrentUrlFromLocation(): string {
  try {
    return window.location.href;
  } catch {
    return "";
  }
}

export default function SidepanelApp() {
  const t = (key: string, fallback: string, substitutions?: string[]): string =>
    getMessage(key, substitutions, fallback);

  const [currentTheme, setCurrentTheme] = useState<AgentThemeId>(() =>
    getThemeFromDocument(),
  );
  const [activeTab, setActiveTab] = useState<TabType>("workflows");

  const workflows = useWorkflowsV3React({ autoConnect: true });
  const { flows, runs } = workflows;

  const [onlyBound, setOnlyBound] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState("");
  const [recordingState, setRecordingState] = useState<RecordingState>(
    DEFAULT_RECORDING_STATE,
  );
  const [timelineSteps, setTimelineSteps] = useState<TimelineStep[]>([]);
  const [recordingAction, setRecordingAction] = useState<
    "start" | "stop" | null
  >(null);

  const [currentPageUrl, setCurrentPageUrl] = useState("");
  const [markers, setMarkers] = useState<ElementMarker[]>([]);
  const [editingMarkerId, setEditingMarkerId] = useState<string | null>(null);
  const [markerForm, setMarkerForm] = useState<MarkerFormState>({
    url: "",
    name: "",
    selector: "",
    selectorType: "css",
    matchType: "prefix",
  });
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(
    new Set(),
  );
  const [markerSearch, setMarkerSearch] = useState("");
  const [markerEditorOpen, setMarkerEditorOpen] = useState(false);

  const filteredMarkers = useMemo(() => {
    const query = markerSearch.trim().toLowerCase();
    if (!query) {
      return markers;
    }

    return markers.filter((marker) => {
      const name = (marker.name || "").toLowerCase();
      const selector = (marker.selector || "").toLowerCase();
      const url = (marker.url || "").toLowerCase();
      return (
        name.includes(query) || selector.includes(query) || url.includes(query)
      );
    });
  }, [markerSearch, markers]);

  const groupedMarkers = useMemo(() => {
    const groups = new Map<string, Map<string, ElementMarker[]>>();

    for (const marker of filteredMarkers) {
      const domain = marker.host || "(local file)";
      const fullUrl = marker.url || "(Unknown URL)";

      if (!groups.has(domain)) {
        groups.set(domain, new Map());
      }

      const domainGroup = groups.get(domain)!;
      if (!domainGroup.has(fullUrl)) {
        domainGroup.set(fullUrl, []);
      }

      domainGroup.get(fullUrl)!.push(marker);
    }

    return Array.from(groups.entries())
      .map(([domain, urlMap]) => ({
        domain,
        count: Array.from(urlMap.values()).reduce(
          (sum, item) => sum + item.length,
          0,
        ),
        urls: Array.from(urlMap.entries())
          .map(([url, grouped]) => ({ url, markers: grouped }))
          .sort((a, b) => a.url.localeCompare(b.url)),
      }))
      .sort((a, b) => a.domain.localeCompare(b.domain));
  }, [filteredMarkers]);

  const filteredFlows = useMemo(() => {
    if (!onlyBound) {
      return flows;
    }
    return flows.filter(isBoundToCurrentUrl);
  }, [flows, onlyBound, currentUrl]);

  function normalizeRecordingState(payload: unknown): RecordingState {
    if (!payload || typeof payload !== "object") {
      return DEFAULT_RECORDING_STATE;
    }
    const data = payload as Partial<RecordingState>;
    const status: RecordingStatus =
      data.status === "recording" ||
      data.status === "paused" ||
      data.status === "stopping"
        ? data.status
        : "idle";
    return {
      ...DEFAULT_RECORDING_STATE,
      ...data,
      status,
      sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
      originTabId:
        typeof data.originTabId === "number" ? data.originTabId : null,
      startedAt: typeof data.startedAt === "string" ? data.startedAt : null,
      durationMs:
        typeof data.durationMs === "number" && Number.isFinite(data.durationMs)
          ? data.durationMs
          : 0,
      stepCount:
        typeof data.stepCount === "number" && Number.isFinite(data.stepCount)
          ? data.stepCount
          : 0,
      activeTabCount:
        typeof data.activeTabCount === "number" &&
        Number.isFinite(data.activeTabCount)
          ? data.activeTabCount
          : 0,
      flowId: typeof data.flowId === "string" ? data.flowId : null,
      flowName: typeof data.flowName === "string" ? data.flowName : null,
    };
  }

  function normalizeTimelineSteps(raw: unknown): TimelineStep[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter(
      (step) => step && typeof step === "object",
    ) as TimelineStep[];
  }

  function isBoundToCurrentUrl(flow: FlowLite): boolean {
    try {
      const bindings = flow?.meta?.bindings || [];
      if (!bindings.length) {
        return false;
      }

      if (!currentUrl) {
        return true;
      }

      const parsed = new URL(currentUrl);
      return bindings.some((binding) => {
        const type = binding.kind || binding.type;
        if (type === "domain") return parsed.hostname.includes(binding.value);
        if (type === "path") return parsed.pathname.startsWith(binding.value);
        if (type === "url") return parsed.href.startsWith(binding.value);
        return false;
      });
    } catch {
      return false;
    }
  }

  function handleTabChange(tab: TabType): void {
    setActiveTab(tab);

    const url = new URL(getCurrentUrlFromLocation());
    url.searchParams.set("tab", tab);
    history.replaceState(null, "", url.toString());
  }

  async function handleWorkflowRefresh(): Promise<void> {
    await workflows.refresh();
  }

  async function refreshRecordingState(): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.RR_GET_RECORDING_STATUS,
      });
      if (!response?.success) return;
      setRecordingState(normalizeRecordingState(response.state));
    } catch (error) {
      console.warn("Failed to load recording status:", error);
    }
  }

  async function startRecording(): Promise<void> {
    if (recordingAction || recordingState.status !== "idle") return;
    setRecordingAction("start");
    try {
      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.RR_START_RECORDING,
      });
      if (response?.success) {
        setRecordingState(normalizeRecordingState(response.state));
      }
    } catch (error) {
      console.warn("Failed to start recording:", error);
    } finally {
      setRecordingAction(null);
    }
  }

  async function stopRecording(): Promise<void> {
    if (recordingAction || recordingState.status === "idle") return;
    setRecordingAction("stop");
    try {
      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.RR_STOP_RECORDING,
      });
      if (response?.success) {
        setRecordingState(normalizeRecordingState(response.state));
      }
      if (response?.flow) {
        await workflows.refresh();
      }
      if (response?.error) {
        console.warn("Recording stop warning:", response.error);
      }
    } catch (error) {
      console.warn("Failed to stop recording:", error);
    } finally {
      setRecordingAction(null);
    }
  }

  async function exportFlow(id: string): Promise<void> {
    try {
      const flowData = await workflows.exportFlow(id);
      if (!flowData) {
        return;
      }

      const blob = new Blob([JSON.stringify(flowData, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `workflow-${id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.warn("Export failed:", error);
    }
  }

  function toggleRun(id: string): void {
    setOpenRunId((current) => (current === id ? null : id));
  }

  async function run(id: string): Promise<void> {
    try {
      const result = await workflows.runFlow(id);
      if (!result) {
        console.warn("Playback failed");
      }
    } catch {
      // ignore
    }
  }

  async function edit(id: string): Promise<void> {
    try {
      await openWorkflowBuilder({ flowId: id });
    } catch (error) {
      console.warn("Failed to open workflow builder:", error);
    }
  }

  async function createFlow(): Promise<void> {
    try {
      await openWorkflowBuilder({ createNew: true });
    } catch (error) {
      console.warn("Failed to open workflow builder:", error);
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      const ok = confirm(
        t(
          "sidepanelConfirmDeleteWorkflow",
          "Are you sure you want to delete this workflow? This action cannot be undone.",
        ),
      );
      if (!ok) {
        return;
      }
      await workflows.deleteFlow(id);
    } catch {
      // ignore
    }
  }

  function resetForm(nextUrl?: string): void {
    setMarkerForm({
      url: nextUrl ?? currentPageUrl,
      name: "",
      selector: "",
      selectorType: "css",
      matchType: "prefix",
    });
    setEditingMarkerId(null);
  }

  function openMarkerEditor(marker?: ElementMarker): void {
    if (marker) {
      setEditingMarkerId(marker.id);
      setMarkerForm({
        url: marker.url,
        name: marker.name,
        selector: marker.selector,
        selectorType: marker.selectorType || "css",
        listMode: marker.listMode,
        matchType: marker.matchType || "prefix",
        action: marker.action,
      });
    } else {
      resetForm();
    }
    setMarkerEditorOpen(true);
  }

  function closeMarkerEditor(): void {
    setMarkerEditorOpen(false);
    resetForm();
  }

  async function loadMarkers(): Promise<void> {
    try {
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const tab = tabs[0];
      const url = String(tab?.url || "");
      setCurrentPageUrl(url);

      if (!editingMarkerId) {
        setMarkerForm((current) => ({ ...current, url }));
      }

      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_LIST_ALL,
      });

      if (response?.success) {
        setMarkers(response.markers || []);
      }
    } catch (error) {
      console.error("Failed to load markers:", error);
    }
  }

  async function saveMarker(): Promise<void> {
    try {
      if (!markerForm.selector) {
        return;
      }

      const isEditing = Boolean(editingMarkerId);
      let response: any = null;

      if (isEditing) {
        const existingMarker = markers.find(
          (marker) => marker.id === editingMarkerId,
        );

        if (existingMarker && editingMarkerId) {
          const updatedMarker: ElementMarker = {
            ...existingMarker,
            ...markerForm,
            id: editingMarkerId,
          };

          response = await chrome.runtime.sendMessage({
            type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_UPDATE,
            marker: updatedMarker,
          });
        } else {
          response = await chrome.runtime.sendMessage({
            type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_SAVE,
            marker: { ...markerForm, id: editingMarkerId || undefined },
          });
        }
      } else {
        response = await chrome.runtime.sendMessage({
          type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_SAVE,
          marker: { ...markerForm, url: currentPageUrl },
        });
      }

      if (response?.success) {
        closeMarkerEditor();
        await loadMarkers();
      }
    } catch (error) {
      console.error("Failed to save marker:", error);
    }
  }

  async function deleteMarker(marker: ElementMarker): Promise<void> {
    try {
      const confirmed = confirm(
        t("sidepanelConfirmDeleteMarker", 'Delete marker "{0}"?', [
          marker.name,
        ]),
      );
      if (!confirmed) {
        return;
      }

      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_DELETE,
        id: marker.id,
      });

      if (response?.success) {
        await loadMarkers();
      }
    } catch (error) {
      console.error("Failed to delete marker:", error);
    }
  }

  async function validateMarker(marker: ElementMarker): Promise<void> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: BACKGROUND_MESSAGE_TYPES.ELEMENT_MARKER_VALIDATE,
        selector: marker.selector,
        selectorType: marker.selectorType || "css",
        action: "hover",
        listMode: Boolean(marker.listMode),
      });

      if (response?.tool?.ok !== false) {
        await highlightInTab(marker);
      }
    } catch (error) {
      console.error("Failed to validate marker:", error);
    }
  }

  async function isMarkerInjected(tabId: number): Promise<boolean> {
    try {
      const response = await Promise.race([
        chrome.tabs.sendMessage(tabId, { action: "element_marker_ping" }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 300)),
      ]);
      return (response as any)?.status === "pong";
    } catch {
      return false;
    }
  }

  async function highlightInTab(marker: ElementMarker): Promise<void> {
    try {
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const tabId = tabs[0]?.id;
      if (!tabId) {
        return;
      }

      const alreadyInjected = await isMarkerInjected(tabId);
      if (!alreadyInjected) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: ["inject-scripts/element-marker.js"],
            world: "ISOLATED",
          });
        } catch {
          // ignore
        }
      }

      await chrome.tabs.sendMessage(tabId, {
        action: "element_marker_highlight",
        selector: marker.selector,
        selectorType: marker.selectorType || "css",
        listMode: Boolean(marker.listMode),
      });
    } catch (error) {
      console.error("Failed to highlight in tab:", error);
    }
  }

  function toggleDomain(domain: string): void {
    setExpandedDomains((current) => {
      const next = new Set(current);
      if (next.has(domain)) {
        next.delete(domain);
      } else {
        next.add(domain);
      }
      return next;
    });
  }

  useEffect(() => {
    if (!markerSearch.trim()) {
      return;
    }

    const domains = new Set<string>();
    for (const group of groupedMarkers) {
      domains.add(group.domain);
    }
    setExpandedDomains(domains);
  }, [markerSearch, groupedMarkers]);

  useEffect(() => {
    if (activeTab !== "element-markers") {
      return;
    }

    void loadMarkers();
  }, [activeTab]);

  useEffect(() => {
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== "local") {
        return;
      }

      const themeChange = changes[THEME_STORAGE_KEY];
      if (themeChange && isValidTheme(themeChange.newValue)) {
        setCurrentTheme(themeChange.newValue);
      }
    };

    const onRuntimeMessage = (message: {
      type?: string;
      payload?: unknown;
      steps?: unknown;
    }) => {
      if (
        message.type === BACKGROUND_MESSAGE_TYPES.RR_RECORDING_STATE_CHANGED
      ) {
        setRecordingState(normalizeRecordingState(message.payload));
        return;
      }
      if (message.type === TOOL_MESSAGE_TYPES.RR_TIMELINE_UPDATE) {
        const steps = normalizeTimelineSteps(
          message.steps ?? (message.payload as any)?.steps,
        );
        setTimelineSteps(steps);
      }
    };

    chrome.storage.onChanged.addListener(onStorageChanged);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);

    void (async () => {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        setCurrentUrl(String(tab?.url || ""));
      } catch {
        // ignore
      }
      await refreshRecordingState();

      const params = new URLSearchParams(window.location.search);
      const tabParam = params.get("tab");
      if (tabParam === "element-markers" || tabParam === "workflows") {
        setActiveTab(tabParam);
        if (tabParam === "element-markers") {
          await loadMarkers();
        }
      }
    })();

    return () => {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    };
  }, []);

  const workflowsProps = {
    flows: filteredFlows,
    runs,
    recordingState,
    timelineSteps,
    recordingAction,
    onlyBound,
    openRunId,
    onRefresh: () => void handleWorkflowRefresh(),
    onStartRecording: () => void startRecording(),
    onStopRecording: () => void stopRecording(),
    onCreate: createFlow,
    onRun: (id: string) => void run(id),
    onEdit: (id: string) => void edit(id),
    onDelete: (id: string) => void remove(id),
    onExport: (id: string) => void exportFlow(id),
    onOnlyBoundChange: (value: boolean) => setOnlyBound(value),
    onToggleRun: (id: string) => toggleRun(id),
  };

  return (
    <div
      className="h-full w-full bg-slate-50 relative agent-theme"
      data-agent-theme={currentTheme}
    >
      <SidepanelNavigator activeTab={activeTab} onChange={handleTabChange} />

      {activeTab === "workflows" ? (
        <div className="h-full">
          <WorkflowsView {...workflowsProps} />
        </div>
      ) : null}

      {activeTab === "element-markers" ? (
        <div className="element-markers-content">
          <div className="px-4 py-4">
            <div className="em-toolbar">
              <div className="em-search-wrapper">
                <svg
                  className="em-search-icon"
                  viewBox="0 0 20 20"
                  width="16"
                  height="16"
                >
                  <path
                    fill="currentColor"
                    d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
                  />
                </svg>
                <input
                  value={markerSearch}
                  onChange={(event) =>
                    setMarkerSearch(event.currentTarget.value)
                  }
                  className="em-search-input"
                  placeholder={t(
                    "sidepanelMarkerSearchPlaceholder",
                    "Search marker name or selector...",
                  )}
                  type="text"
                />
                {markerSearch ? (
                  <button
                    className="em-search-clear"
                    type="button"
                    onClick={() => setMarkerSearch("")}
                  >
                    <svg viewBox="0 0 20 20" width="14" height="14">
                      <path
                        fill="currentColor"
                        d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
                      />
                    </svg>
                  </button>
                ) : null}
              </div>

              <button
                className="em-add-btn"
                onClick={() => openMarkerEditor()}
                title={t("sidepanelAddMarkerTitle", "Add new marker")}
                type="button"
              >
                <svg viewBox="0 0 20 20" width="18" height="18">
                  <path
                    fill="currentColor"
                    d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
                  />
                </svg>
              </button>
            </div>

            {markerEditorOpen ? (
              <div className="em-modal-overlay" onClick={closeMarkerEditor}>
                <div
                  className="em-modal"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="em-modal-header">
                    <h3 className="em-modal-title">
                      {editingMarkerId
                        ? t("sidepanelEditMarkerTitle", "Edit marker")
                        : t("sidepanelCreateMarkerTitle", "Create marker")}
                    </h3>
                    <button
                      className="em-modal-close"
                      onClick={closeMarkerEditor}
                      type="button"
                    >
                      <svg viewBox="0 0 20 20" width="18" height="18">
                        <path
                          fill="currentColor"
                          d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
                        />
                      </svg>
                    </button>
                  </div>

                  <form
                    className="em-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveMarker();
                    }}
                  >
                    <div className="em-form-row">
                      <div className="em-field">
                        <label className="em-field-label">
                          {t("sidepanelMarkerFieldName", "Name")}
                        </label>
                        <input
                          value={markerForm.name}
                          onChange={(event) =>
                            setMarkerForm((current) => ({
                              ...current,
                              name: event.currentTarget.value,
                            }))
                          }
                          className="em-input"
                          placeholder={t(
                            "sidepanelMarkerFieldNamePlaceholder",
                            "For example: Login button",
                          )}
                          required
                        />
                      </div>
                    </div>

                    <div className="em-form-row em-form-row-multi">
                      <div className="em-field">
                        <label className="em-field-label">
                          {t(
                            "sidepanelMarkerFieldSelectorType",
                            "Selector type",
                          )}
                        </label>
                        <div className="em-select-wrapper">
                          <select
                            value={markerForm.selectorType}
                            onChange={(event) =>
                              setMarkerForm((current) => ({
                                ...current,
                                selectorType: event.currentTarget.value as
                                  | "css"
                                  | "xpath",
                              }))
                            }
                            className="em-select"
                          >
                            <option value="css">
                              {t("sidepanelMarkerSelectorCss", "CSS selector")}
                            </option>
                            <option value="xpath">
                              {t("sidepanelMarkerSelectorXpath", "XPath")}
                            </option>
                          </select>
                        </div>
                      </div>

                      <div className="em-field">
                        <label className="em-field-label">
                          {t("sidepanelMarkerFieldMatchType", "Match type")}
                        </label>
                        <div className="em-select-wrapper">
                          <select
                            value={markerForm.matchType}
                            onChange={(event) =>
                              setMarkerForm((current) => ({
                                ...current,
                                matchType: event.currentTarget.value as
                                  | "prefix"
                                  | "exact"
                                  | "host",
                              }))
                            }
                            className="em-select"
                          >
                            <option value="prefix">
                              {t("sidepanelMarkerMatchPrefix", "Path prefix")}
                            </option>
                            <option value="exact">
                              {t("sidepanelMarkerMatchExact", "Exact match")}
                            </option>
                            <option value="host">
                              {t("sidepanelMarkerMatchHost", "Hostname")}
                            </option>
                          </select>
                        </div>
                      </div>
                    </div>

                    <div className="em-form-row">
                      <div className="em-field">
                        <label className="em-field-label">
                          {t("sidepanelMarkerFieldSelector", "Selector")}
                        </label>
                        <textarea
                          value={markerForm.selector}
                          onChange={(event) =>
                            setMarkerForm((current) => ({
                              ...current,
                              selector: event.currentTarget.value,
                            }))
                          }
                          className="em-textarea"
                          placeholder={t(
                            "sidepanelMarkerSelectorPlaceholder",
                            "CSS selector or XPath",
                          )}
                          rows={3}
                          required
                        />
                      </div>
                    </div>

                    <div className="em-modal-actions">
                      <button
                        type="button"
                        className="em-btn em-btn-ghost"
                        onClick={closeMarkerEditor}
                      >
                        {t("cancelButton", "Cancel")}
                      </button>
                      <button type="submit" className="em-btn em-btn-primary">
                        {editingMarkerId
                          ? t("sidepanelUpdateButton", "Update")
                          : t("saveButton", "Save")}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            ) : null}

            {filteredMarkers.length > 0 ? (
              <div className="em-list">
                <div className="em-stats-bar">
                  <span className="em-stats-text">
                    {markerSearch ? (
                      <>
                        {t(
                          "sidepanelMarkerStatsFiltered",
                          "Showing {0} markers (out of {1}) across {2} domains",
                          [
                            String(filteredMarkers.length),
                            String(markers.length),
                            String(groupedMarkers.length),
                          ],
                        )}
                      </>
                    ) : (
                      <>
                        {t(
                          "sidepanelMarkerStatsTotal",
                          "Total {0} markers across {1} domains",
                          [
                            String(markers.length),
                            String(groupedMarkers.length),
                          ],
                        )}
                      </>
                    )}
                  </span>
                </div>

                {groupedMarkers.map((domainGroup) => (
                  <div key={domainGroup.domain} className="em-domain-group">
                    <div
                      className="em-domain-header"
                      onClick={() => toggleDomain(domainGroup.domain)}
                    >
                      <div className="em-domain-info">
                        <svg
                          className={`em-domain-icon ${expandedDomains.has(domainGroup.domain) ? "em-domain-icon-expanded" : ""}`}
                          viewBox="0 0 20 20"
                          width="16"
                          height="16"
                        >
                          <path fill="currentColor" d="M6 8l4 4 4-4" />
                        </svg>
                        <h3 className="em-domain-name">{domainGroup.domain}</h3>
                        <span className="em-domain-count">
                          {t("sidepanelMarkerDomainCount", "{0} markers", [
                            String(domainGroup.count),
                          ])}
                        </span>
                      </div>
                    </div>

                    {expandedDomains.has(domainGroup.domain) ? (
                      <div className="em-domain-content">
                        <div className="em-content-wrapper">
                          {domainGroup.urls.map((urlGroup) => (
                            <div key={urlGroup.url} className="em-url-group">
                              <div className="em-url-header">
                                <svg
                                  className="em-url-icon"
                                  viewBox="0 0 16 16"
                                  width="12"
                                  height="12"
                                >
                                  <path
                                    fill="currentColor"
                                    d="M4 4a1 1 0 011-1h6a1 1 0 011 1v8a1 1 0 01-1 1H5a1 1 0 01-1-1V4zm2 1v1h4V5H6zm0 3v1h4V8H6z"
                                  />
                                </svg>
                                <span className="em-url-path">
                                  {urlGroup.url}
                                </span>
                              </div>

                              <div className="em-markers-list">
                                {urlGroup.markers.map((marker) => (
                                  <div
                                    key={marker.id}
                                    className="em-marker-item"
                                  >
                                    <div className="em-marker-row-top">
                                      <span className="em-marker-name">
                                        {marker.name}
                                      </span>
                                      <div className="em-marker-actions">
                                        <button
                                          className="em-action-btn em-action-verify"
                                          onClick={() =>
                                            void validateMarker(marker)
                                          }
                                          title={t(
                                            "sidepanelMarkerActionVerify",
                                            "Verify",
                                          )}
                                          type="button"
                                        >
                                          <svg
                                            viewBox="0 0 24 24"
                                            width="14"
                                            height="14"
                                          >
                                            <path
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                                            />
                                          </svg>
                                        </button>
                                        <button
                                          className="em-action-btn em-action-edit"
                                          onClick={() =>
                                            openMarkerEditor(marker)
                                          }
                                          title={t(
                                            "sidepanelMarkerActionEdit",
                                            "Edit",
                                          )}
                                          type="button"
                                        >
                                          <svg
                                            viewBox="0 0 24 24"
                                            width="14"
                                            height="14"
                                          >
                                            <path
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                            />
                                          </svg>
                                        </button>
                                        <button
                                          className="em-action-btn em-action-delete"
                                          onClick={() =>
                                            void deleteMarker(marker)
                                          }
                                          title={t(
                                            "sidepanelMarkerActionDelete",
                                            "Delete",
                                          )}
                                          type="button"
                                        >
                                          <svg
                                            viewBox="0 0 24 24"
                                            width="14"
                                            height="14"
                                          >
                                            <path
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                            />
                                          </svg>
                                        </button>
                                      </div>
                                    </div>
                                    <div className="em-marker-row-bottom">
                                      <code
                                        className="em-marker-selector"
                                        title={marker.selector}
                                      >
                                        {marker.selector}
                                      </code>
                                      <div className="em-marker-tags">
                                        <span className="em-tag">
                                          {marker.selectorType || "css"}
                                        </span>
                                        <span className="em-tag">
                                          {marker.matchType}
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="em-empty">
                {markerSearch ? (
                  <span>
                    {t(
                      "sidepanelNoMatchingMarkers",
                      "No matching markers found",
                    )}
                  </span>
                ) : (
                  <>
                    <span>
                      {t(
                        "sidepanelNoMarkers",
                        "No markers yet. Click + in the top-right corner to create the first marker.",
                      )}
                    </span>
                    <button
                      className="em-btn em-btn-primary em-empty-btn"
                      onClick={() => openMarkerEditor()}
                      type="button"
                    >
                      {t("sidepanelCreateMarkerButton", "Create marker")}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
