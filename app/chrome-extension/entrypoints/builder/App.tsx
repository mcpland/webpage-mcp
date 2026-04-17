import { useEffect, useRef, useState } from "react";
import { watch } from "@/entrypoints/shared/reactivity";

import type {
  Flow as BuilderFlow,
  NodeBase,
} from "@/common/workflow-compat-types";
import type { FlowV3 } from "@/entrypoints/background/record-replay-v3/domain/flow";
import type {
  FlowId,
  NodeId,
} from "@/entrypoints/background/record-replay-v3/domain/ids";
import type { JsonObject } from "@/entrypoints/background/record-replay-v3/domain/json";
import {
  extractHiddenSensitiveVariables,
  getActiveCurrentWindowTabId,
  flowBuilderToV3ForRpc,
  flowV3ToBuilderForEditor,
  isFlowV3,
  extractFlowCandidates,
  mergeHiddenSensitiveVariables,
} from "@/entrypoints/shared/utils";
import { getV3AuthoringCompatibility } from "@/entrypoints/shared/utils/v3-authoring";

import { validateFlow } from "@/entrypoints/popup/components/builder/model/validation";
import { useBuilderStore } from "@/entrypoints/popup/components/builder/store/useBuilderStore";
import Canvas from "@/entrypoints/popup/components/builder/components/Canvas";
import EdgePropertyPanel from "@/entrypoints/popup/components/builder/components/EdgePropertyPanel";
import Sidebar from "@/entrypoints/popup/components/builder/components/Sidebar";
import PropertyPanel from "@/entrypoints/popup/components/builder/components/PropertyPanel";
import { getMessage } from "@/utils/i18n";
import { useRRV3Rpc } from "../shared/react/useRRV3Rpc";
import "./App.css";

type ToastLevel = "info" | "warn" | "error";
type ToastItem = { id: string; message: string; level: ToastLevel };
type FallbackNotice = { nodeId: string; type: string; prevIndex: number };

function getQuery(): Record<string, string> {
  const q: Record<string, string> = {};
  const url = new URL(location.href);
  url.searchParams.forEach((v, k) => {
    q[k] = v;
  });
  return q;
}

export default function BuilderApp() {
  const storeRef = useRef(useBuilderStore());
  const store = storeRef.current;
  const t = (key: string, fallback: string, substitutions?: string[]) =>
    getMessage(key, substitutions, fallback);
  const pageTitle = t(
    "builderPageTitle",
    "Workflow Builder - Webpage MCP Connector",
  );

  const [title, setTitle] = useState(() =>
    t("builderWorkflowEditorTitle", "Workflow Editor"),
  );
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const persisted = localStorage.getItem("rr-theme") as
        | "light"
        | "dark"
        | null;
      if (persisted === "light" || persisted === "dark") {
        return persisted;
      }
    } catch {
      // ignore
    }
    return matchMedia && matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [highlightField, setHighlightField] = useState<string | null>(null);
  const [fitSeq, setFitSeq] = useState(0);

  const [renameVisible, setRenameVisible] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [renameDesc, setRenameDesc] = useState("");

  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const [fallbackNotice, setFallbackNotice] = useState<FallbackNotice | null>(
    null,
  );

  const [, forceRender] = useState(0);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bootstrapDoneRef = useRef(false);
  const hiddenSensitiveVariablesRef = useRef<FlowV3["variables"]>(undefined);

  const rpc = useRRV3Rpc({
    autoConnect: true,
    onError: (message) => pushToast(message, "error"),
  });

  function pushToast(message: string, level: ToastLevel = "warn") {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const item: ToastItem = { id, message, level };
    setToasts((current) => [...current, item]);
    setTimeout(() => {
      setToasts((current) => current.filter((x) => x.id !== id));
    }, 2500);
  }

  const selectedId = ((store.activeNodeId as any)?.value ?? null) as
    | string
    | null;
  const selectedEdgeId = ((store.activeEdgeId as any)?.value ?? null) as
    | string
    | null;
  const activeNode = store.nodes.find((n) => n.id === selectedId) || null;
  const activeEdge = store.edges.find((e) => e.id === selectedEdgeId) || null;
  const validation = validateFlow(store.nodes);
  const availableVars = store.listAvailableVariables(selectedId || undefined);
  const currentSubflowIdVal = ((store.currentSubflowId as any)?.value ??
    null) as string | null;
  const compatibility = getV3AuthoringCompatibility({
    nodes: store.nodes,
    subflows: (store.flowLocal as any)?.subflows,
  });
  const compatibilityMessage = compatibility.messages.join(" ");

  const saveLabel =
    saveState === "saving"
      ? t("builderSavingStatus", "Saving...")
      : saveState === "saved"
        ? t("builderSavedStatus", "Saved")
        : "";
  const statusLabel = compatibility.isCompatible
    ? saveLabel
    : t("builderUnsupportedV3Status", "Unsupported V3 features");

  function getCurrentCompatibility() {
    return getV3AuthoringCompatibility({
      nodes: store.nodes,
      subflows: (store.flowLocal as any)?.subflows,
    });
  }

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

  function notifyCompatibilityBlocked(actionLabel: string, message?: string) {
    pushToast(
      t(
        "builderV3CompatibilityBlocked",
        "{0} is disabled until unsupported V3 workflow features are removed. {1}",
        [actionLabel, message || getCurrentCompatibility().messages.join(" ")],
      ),
      "warn",
    );
  }

  function notifyImportReadOnly(message: string) {
    pushToast(
      t(
        "builderImportReadOnlyWarning",
        "Imported workflow uses unsupported V3 workflow features. It was loaded without saving. {0}",
        [message],
      ),
      "warn",
    );
  }

  function initEmptyFlow() {
    const now = Date.now();
    const empty: BuilderFlow = {
      id: `flow_${now}`,
      name: t("builderNewWorkflowName", "New workflow"),
      version: 1,
      steps: [],
      variables: [],
      meta: {
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      } as any,
    } as any;
    hiddenSensitiveVariablesRef.current = undefined;
    store.initFromFlow(empty);
    setTitle(t("builderNewWorkflowName", "New workflow"));
  }

  async function bootstrap() {
    const q = getQuery();
    if (q.flowId) {
      try {
        await rpc.ensureConnected();
        const flowV3 = (await rpc.request("rr_v3.getFlow", {
          flowId: q.flowId as FlowId,
        })) as FlowV3 | null;

        if (flowV3) {
          hiddenSensitiveVariablesRef.current =
            extractHiddenSensitiveVariables(flowV3);
          const { flow: flowV2, warnings } = flowV3ToBuilderForEditor(flowV3);
          warnings.forEach((w) => pushToast(w, "warn"));
          store.initFromFlow(flowV2);
          setTitle(
            t("builderEditFlowTitle", "Edit: {0}", [
              String(flowV2.name || flowV2.id),
            ]),
          );

          if (q.focus) {
            setTimeout(() => {
              try {
                store.selectNode(q.focus!);
                setFocusNodeId(q.focus!);
                setTimeout(() => setFocusNodeId(null), 300);
              } catch {
                // ignore
              }
            }, 0);
          }
        } else {
          pushToast(
            t(
              "builderWorkflowNotFoundCreated",
              'Workflow "{0}" not found, created a new workflow.',
              [String(q.flowId || "")],
            ),
            "warn",
          );
          initEmptyFlow();
        }
      } catch (error) {
        pushToast(
          t("builderLoadFlowFailed", "Failed to load workflow: {0}", [
            error instanceof Error ? error.message : String(error),
          ]),
          "error",
        );
        initEmptyFlow();
      }
    } else if (q.new === "1") {
      initEmptyFlow();
    }
  }

  function onAddNodeAt(type: string, x: number, y: number) {
    try {
      store.addNodeAt(type as NodeBase["type"], x, y);
    } catch {
      // ignore
    }
  }

  function fitAll() {
    setFitSeq((n) => n + 1);
  }

  function openRename() {
    setRenameName(store.flowLocal.name || "");
    setRenameDesc((store.flowLocal as any).description || "");
    setRenameVisible(true);
  }

  function applyRename() {
    store.flowLocal.name = renameName.trim();
    (store.flowLocal as any).description = renameDesc;
    setRenameVisible(false);
  }

  async function save(): Promise<FlowV3 | null> {
    try {
      const currentCompatibility = getCurrentCompatibility();
      if (!currentCompatibility.isCompatible) {
        notifyCompatibilityBlocked(
          t("saveButton", "Save"),
          currentCompatibility.messages.join(" "),
        );
        return null;
      }

      const flowV2 = store.exportFlowForSave();
      await rpc.ensureConnected();

      const { flow: flowV3, warnings: convWarnings } = flowBuilderToV3ForRpc(flowV2);
      convWarnings.forEach((w) => pushToast(w, "warn"));
      const flowToSave = mergeHiddenSensitiveVariables(
        flowV3,
        hiddenSensitiveVariablesRef.current,
      );

      const saved = (await rpc.request("rr_v3.saveFlow", {
        flow: flowToSave as unknown as JsonObject,
      })) as unknown as FlowV3;
      hiddenSensitiveVariablesRef.current =
        extractHiddenSensitiveVariables(saved);

      if (!store.flowLocal.meta) {
        (store.flowLocal as any).meta = {};
      }
      (store.flowLocal as any).meta.createdAt = saved.createdAt;
      (store.flowLocal as any).meta.updatedAt = saved.updatedAt;

      return saved;
    } catch (error) {
      pushToast(
        t("builderSaveFailed", "Save failed: {0}", [
          error instanceof Error ? error.message : String(error),
        ]),
        "error",
      );
      return null;
    }
  }

  async function exportFlow() {
    try {
      const currentCompatibility = getCurrentCompatibility();
      if (!currentCompatibility.isCompatible) {
        const compatFlow = store.exportFlowForSave();
        const blob = new Blob([JSON.stringify(compatFlow, null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        await chrome.downloads.download({
          url,
          filename: `${store.flowLocal.name || "flow"}.builder-compat.json`,
          saveAs: true,
        } as chrome.downloads.DownloadOptions);
        URL.revokeObjectURL(url);
        pushToast(
          t(
            "builderLegacyExportNotice",
            "Exported as builder-compatible JSON because this workflow uses unsupported V3 features.",
          ),
          "info",
        );
        return;
      }

      const saved = await save();
      if (!saved) return;

      const blob = new Blob([JSON.stringify(saved, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      await chrome.downloads.download({
        url,
        filename: `${store.flowLocal.name || "flow"}.json`,
        saveAs: true,
      } as chrome.downloads.DownloadOptions);
      URL.revokeObjectURL(url);
    } catch (error) {
      pushToast(
        t("builderExportFailed", "Export failed: {0}", [
          error instanceof Error ? error.message : String(error),
        ]),
        "error",
      );
    }
  }

  async function onImport(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const txt = await file.text();
      const parsed = JSON.parse(txt);
      const candidates = extractFlowCandidates(parsed);

      if (!candidates.length) {
        pushToast(
          t(
            "builderImportDataNotFound",
            "Import failed: workflow data not found.",
          ),
          "error",
        );
        return;
      }

      const first = candidates[0];

      if (isFlowV3(first)) {
        hiddenSensitiveVariablesRef.current =
          extractHiddenSensitiveVariables(first as FlowV3);
        const importedCompatibility = getV3AuthoringCompatibility(first);
        const { flow: flowV2, warnings } = flowV3ToBuilderForEditor(
          first as FlowV3,
        );
        warnings.forEach((w) => pushToast(w, "warn"));
        store.initFromFlow(flowV2);
        setTitle(
          t("builderEditFlowTitle", "Edit: {0}", [
            String(flowV2.name || flowV2.id),
          ]),
        );
        if (importedCompatibility.isCompatible) {
          await rpc.ensureConnected();
          const saved = (await rpc.request("rr_v3.saveFlow", {
            flow: first as unknown as JsonObject,
          })) as unknown as FlowV3;
          if (!store.flowLocal.meta) {
            (store.flowLocal as any).meta = {};
          }
          (store.flowLocal as any).meta.createdAt = saved.createdAt;
          (store.flowLocal as any).meta.updatedAt = saved.updatedAt;
        } else {
          notifyImportReadOnly(importedCompatibility.messages.join(" "));
        }
      } else {
        hiddenSensitiveVariablesRef.current = undefined;
        store.initFromFlow(first as BuilderFlow);

        if (
          Array.isArray((first as any)?.steps) &&
          (!Array.isArray((first as any)?.nodes) ||
            (first as any).nodes.length === 0)
        ) {
          store.importFromSteps();
        }

        setTitle(
          t("builderEditFlowTitle", "Edit: {0}", [
            String(store.flowLocal.name || store.flowLocal.id),
          ]),
        );
        const importedCompatibility = getCurrentCompatibility();
        if (importedCompatibility.isCompatible) {
          await save();
        } else {
          notifyImportReadOnly(importedCompatibility.messages.join(" "));
        }
      }
    } catch (error) {
      pushToast(
        t("builderImportFailed", "Import failed: {0}", [
          error instanceof Error ? error.message : String(error),
        ]),
        "error",
      );
    } finally {
      input.value = "";
    }
  }

  async function runFromSelected() {
    if (!selectedId || !store.flowLocal?.id) return;

    try {
      const currentCompatibility = getCurrentCompatibility();
      if (!currentCompatibility.isCompatible) {
        notifyCompatibilityBlocked(
          t("builderRunFromSelectedButton", "Run from selected"),
          currentCompatibility.messages.join(" "),
        );
        return;
      }

      const saved = await save();
      if (!saved) return;

      await rpc.ensureConnected();

      const node = store.nodes.find((n) => n.id === selectedId) || null;
      const startNodeId = node?.type === "trigger" ? undefined : selectedId;
      const tabId = await getActiveCurrentWindowTabId();

      await rpc.request("rr_v3.enqueueRun", {
        flowId: saved.id as FlowId,
        ...(tabId !== undefined ? { tabId } : {}),
        tabTarget: "current",
        ...(startNodeId ? { startNodeId: startNodeId as NodeId } : {}),
      });
    } catch (error) {
      pushToast(
        t("builderRunFailed", "Run failed: {0}", [
          error instanceof Error ? error.message : String(error),
        ]),
        "error",
      );
    }
  }

  async function runAll() {
    if (!store.flowLocal?.id) return;

    try {
      const currentCompatibility = getCurrentCompatibility();
      if (!currentCompatibility.isCompatible) {
        notifyCompatibilityBlocked(
          t("workflowsRunAction", "Run"),
          currentCompatibility.messages.join(" "),
        );
        return;
      }

      const saved = await save();
      if (!saved) return;

      await rpc.ensureConnected();
      const tabId = await getActiveCurrentWindowTabId();
      await rpc.request("rr_v3.enqueueRun", {
        flowId: saved.id as FlowId,
        ...(tabId !== undefined ? { tabId } : {}),
        tabTarget: "current",
      });
    } catch (error) {
      pushToast(
        t("builderRunFailed", "Run failed: {0}", [
          error instanceof Error ? error.message : String(error),
        ]),
        "error",
      );
    }
  }

  function undoFallbackPromotion() {
    const n = fallbackNotice;
    if (!n) return;
    const node = store.nodes.find((x) => x.id === n.nodeId);
    if (!node || (node.type !== "click" && node.type !== "fill")) {
      setFallbackNotice(null);
      return;
    }
    const cands = (node as any).config?.target?.candidates as Array<{
      type: string;
      value: string;
    }>;
    if (!Array.isArray(cands) || cands.length === 0) {
      setFallbackNotice(null);
      return;
    }
    const currentIdx = cands.findIndex((c) => c.type === n.type);
    if (currentIdx >= 0 && n.prevIndex >= 0 && n.prevIndex < cands.length) {
      const cand = cands.splice(currentIdx, 1)[0];
      cands.splice(n.prevIndex, 0, cand);
    }
    setFallbackNotice(null);
  }

  function scheduleAutoSave() {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    const currentCompatibility = getCurrentCompatibility();
    if (!currentCompatibility.isCompatible) {
      setSaveState("idle");
      return;
    }

    saveTimerRef.current = setTimeout(async () => {
      try {
        setSaveState("saving");
        await new Promise((resolve) => setTimeout(resolve, 0));
        const saved = await save();
        if (!saved) {
          setSaveState("idle");
          return;
        }

        setSaveState("saved");
        if (statusTimerRef.current) {
          clearTimeout(statusTimerRef.current);
        }
        statusTimerRef.current = setTimeout(() => setSaveState("idle"), 1200);
      } catch {
        setSaveState("idle");
      }
    }, 800);
  }

  useEffect(() => {
    const onToast = (ev: Event) => {
      try {
        const customEvent = ev as CustomEvent;
        const msg = String((customEvent as any)?.detail?.message || "");
        const level = ((customEvent as any)?.detail?.level ||
          "warn") as ToastLevel;
        if (msg) pushToast(msg, level);
      } catch {
        // ignore
      }
    };

    const onKey = (e: KeyboardEvent) => {
      const id = selectedId;
      const isMeta = e.metaKey || e.ctrlKey;
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = (t.tagName || "").toLowerCase();
        const inEditable =
          tag === "input" ||
          tag === "textarea" ||
          tag === "select" ||
          t.isContentEditable ||
          !!t.closest(".floating-property");
        if (inEditable) return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && id) {
        e.preventDefault();
        store.removeNode(id);
      } else if (isMeta && e.key.toLowerCase() === "d") {
        if (id) {
          e.preventDefault();
          store.duplicateNode(id);
        }
      } else if (isMeta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      } else if (isMeta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };

    window.addEventListener("rr_toast", onToast as EventListener);
    document.addEventListener("keydown", onKey);

    if (!bootstrapDoneRef.current) {
      bootstrapDoneRef.current = true;
      void bootstrap();
    }

    return () => {
      window.removeEventListener("rr_toast", onToast as EventListener);
      document.removeEventListener("keydown", onKey);

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  });

  useEffect(() => {
    try {
      localStorage.setItem("rr-theme", theme);
    } catch {
      // ignore
    }
  }, [theme]);

  useEffect(() => {
    const stop = watch(
      () => [
        store.nodes,
        store.edges,
        store.flowLocal.name,
        (store.flowLocal as any).description,
        (store.activeNodeId as any).value,
        (store.activeEdgeId as any).value,
        (store.currentSubflowId as any).value,
      ],
      () => {
        forceRender((v) => v + 1);
        scheduleAutoSave();
      },
      { deep: true },
    );

    return () => {
      stop();
    };
  }, [store]);

  const canvasProps = {
    nodes: store.nodes,
    edges: store.edges,
    nodeErrors: validation.nodeErrors,
    selectedNodeId: selectedId,
    selectedEdgeId,
    focusNodeId,
    fitSeq,
    onSelectNode: store.selectNode,
    onSelectEdge: store.selectEdge,
    onDuplicateNode: store.duplicateNode,
    onRemoveNode: store.removeNode,
    onConnectFrom: store.connectFrom,
    onConnect: store.onConnect,
    onNodeDragged: store.setNodePosition,
    onAddNodeAt: onAddNodeAt,
  };

  return (
    <>
      <div className="builder-page rr-theme" data-theme={theme}>
        {fallbackNotice ? (
          <div className="notice-top">
            <span>
              {t(
                "builderFallbackPromotionNotice",
                "Fallback recommendation applied: promoted {0} priority.",
                [fallbackNotice.type],
              )}
            </span>
            <button
              className="mini"
              type="button"
              onClick={undoFallbackPromotion}
            >
              {t("cancelButton", "Cancel")}
            </button>
          </div>
        ) : null}
        {!compatibility.isCompatible ? (
          <div className="notice-top warning">
            <span>
              {t(
                "builderUnsupportedV3Notice",
                "Save and run are disabled for this workflow. {0}",
                [compatibilityMessage],
              )}
            </span>
          </div>
        ) : null}

        <div className="main">
          <Canvas {...canvasProps} />

          <div className="topbar rr-topbar backdrop-blur">
            <div className="left">
              <strong className="text-[var(--rr-text)]">{title}</strong>
              <span className="tip">
                {t(
                  "builderVisualOrchestrationTip",
                  "Workflow visual orchestration",
                )}
              </span>
            </div>
            <div className="right">
              <button
                className="top-btn"
                type="button"
                onClick={() => void exportFlow()}
                title={t("builderExportJsonTitle", "Export JSON")}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                </svg>
                {t("workflowsExportAction", "Export")}
              </button>

              <label
                className="top-btn import"
                title={t("builderImportJsonTitle", "Import JSON")}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
                </svg>
                {t("workflowsImportAction", "Import")}
                <input
                  type="file"
                  accept="application/json"
                  onChange={onImport}
                />
              </label>

              <button
                className="top-btn"
                type="button"
                onClick={openRename}
                title={t("builderRenameWorkflowTitle", "Rename workflow")}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
                </svg>
                {t("agentSessionRenameTitle", "Rename")}
              </button>

              <span className="divider-vert" />

              <button
                className="top-btn"
                type="button"
                disabled={!selectedId || !compatibility.isCompatible}
                onClick={() => void runFromSelected()}
                title={
                  compatibility.isCompatible
                    ? t(
                        "builderRunFromSelectedTitle",
                        "Playback from selected node",
                      )
                    : compatibilityMessage
                }
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                {t("builderRunFromSelectedButton", "Run from selected")}
              </button>

              <button
                className="top-btn primary"
                type="button"
                disabled={!compatibility.isCompatible}
                onClick={() => void runAll()}
                title={
                  compatibility.isCompatible
                    ? t(
                        "builderRunAllTitle",
                        "Playback rectification from the beginning",
                      )
                    : compatibilityMessage
                }
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                {t("workflowsRunAction", "Run")}
              </button>

              <span className="divider-vert" />

              <span className="status" data-state={saveState}>
                {statusLabel}
              </span>

              <button
                className="top-btn success"
                type="button"
                disabled={!compatibility.isCompatible}
                onClick={() => void save()}
                title={
                  compatibility.isCompatible ? undefined : compatibilityMessage
                }
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
                {t("saveButton", "Save")}
              </button>
            </div>
          </div>

          <div className="floating-sidebar">
            <Sidebar
              flow={store.flowLocal}
              paletteTypes={store.paletteTypes}
              subflowIds={store.listSubflowIds()}
              currentSubflowId={currentSubflowIdVal}
              onAddNode={store.addNode}
              onSwitchMain={store.switchToMain}
              onSwitchSubflow={store.switchToSubflow}
              onAddSubflow={store.addSubflow}
              onRemoveSubflow={store.removeSubflow}
            />
          </div>

          {activeNode ? (
            <div className="floating-property">
              <PropertyPanel
                node={activeNode}
                variables={availableVars as any}
                highlightField={highlightField}
                subflowIds={store.listSubflowIds()}
                onRemoveNode={store.removeNode}
                onCreateSubflow={store.addSubflow}
                onSwitchToSubflow={store.switchToSubflow}
              />
            </div>
          ) : null}

          {!activeNode && activeEdge ? (
            <div className="floating-property">
              <EdgePropertyPanel
                edge={activeEdge}
                nodes={store.nodes}
                onRemoveEdge={store.removeEdge}
              />
            </div>
          ) : null}

          <div className="bottom-toolbar">
            <button
              className="toolbar-btn"
              type="button"
              onClick={store.undo}
              title={t("builderUndoTitle", "Undo (⌘/Ctrl+Z)")}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M3 7v6h6M21 17a9 9 0 00-9-9 9 9 0 00-9 9" />
              </svg>
            </button>

            <button
              className="toolbar-btn"
              type="button"
              onClick={store.redo}
              title={t("builderRedoTitle", "Redo (⌘/Ctrl+Shift+Z)")}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M21 7v6h-6M3 17a9 9 0 019-9 9 9 0 019 9" />
              </svg>
            </button>

            <span className="toolbar-divider" />

            <button
              className="toolbar-btn"
              type="button"
              onClick={store.layoutAuto}
              title={t("builderAutoLayoutTitle", "Automatic typesetting")}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
              </svg>
            </button>

            <button
              className="toolbar-btn"
              type="button"
              onClick={fitAll}
              title={t("builderFitViewTitle", "Adaptive view")}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
              </svg>
            </button>
          </div>
        </div>

        <div className="rr-toast-container">
          {toasts.map((t) => (
            <div key={t.id} className="rr-toast" data-level={t.level}>
              {t.message}
            </div>
          ))}
        </div>
      </div>

      {renameVisible ? (
        <div className="rr-modal">
          <div className="rr-dialog small">
            <div className="rr-header">
              <div className="title">
                {t("builderRenameWorkflowTitle", "Rename workflow")}
              </div>
              <button
                className="close"
                type="button"
                onClick={() => setRenameVisible(false)}
              >
                ✕
              </button>
            </div>
            <div className="rr-body">
              <div className="row">
                <label>{t("builderNameLabel", "Name")}</label>
                <input
                  value={renameName}
                  onChange={(event) => setRenameName(event.currentTarget.value)}
                  placeholder={t(
                    "builderWorkflowNamePlaceholder",
                    "Workflow name",
                  )}
                />
              </div>
              <div className="row">
                <label>{t("workflowsDescriptionLabel", "Description")}</label>
                <textarea
                  value={renameDesc}
                  onChange={(event) => setRenameDesc(event.currentTarget.value)}
                  placeholder={t(
                    "workflowsOptionalDescription",
                    "Optional description",
                  )}
                />
              </div>
            </div>
            <div className="rr-footer">
              <button className="primary" type="button" onClick={applyRename}>
                {t("saveButton", "Save")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
