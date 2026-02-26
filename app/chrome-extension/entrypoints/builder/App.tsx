import { useEffect, useRef, useState } from 'react';
import { watch } from '@/entrypoints/shared/reactivity';

import type { Flow as FlowV2, NodeBase } from '@/entrypoints/background/record-replay/types';
import type { FlowV3 } from '@/entrypoints/background/record-replay-v3/domain/flow';
import type {
  FlowId,
  NodeId,
  TriggerId,
} from '@/entrypoints/background/record-replay-v3/domain/ids';
import type { JsonObject } from '@/entrypoints/background/record-replay-v3/domain/json';
import type { TriggerSpec } from '@/entrypoints/background/record-replay-v3/domain/triggers';
import {
  flowV2ToV3ForRpc,
  flowV3ToV2ForBuilder,
  isFlowV3,
  extractFlowCandidates,
} from '@/entrypoints/shared/utils';

import { validateFlow } from '@/entrypoints/popup/components/builder/model/validation';
import { useBuilderStore } from '@/entrypoints/popup/components/builder/store/useBuilderStore';
import Canvas from '@/entrypoints/popup/components/builder/components/Canvas';
import TriggerPanel from '@/entrypoints/popup/components/builder/components/TriggerPanel';
import EdgePropertyPanel from '@/entrypoints/popup/components/builder/components/EdgePropertyPanel';
import Sidebar from '@/entrypoints/popup/components/builder/components/Sidebar';
import PropertyPanel from '@/entrypoints/popup/components/builder/components/PropertyPanel';
import { useRRV3Rpc } from '../shared/react/useRRV3Rpc';
import './App.css';

type ToastLevel = 'info' | 'warn' | 'error';
type ToastItem = { id: string; message: string; level: ToastLevel };
type FallbackNotice = { nodeId: string; type: string; prevIndex: number };

function trigId(flowId: string, nodeId: string, kind: string): TriggerId {
  return `trg_${flowId}_${nodeId}_${kind}` as TriggerId;
}

function schId(flowId: string, nodeId: string, idx: number): TriggerId {
  return `sch_${flowId}_${nodeId}_${idx}` as TriggerId;
}

function scheduleToCron(schedule: { type?: string; when?: string }): string | null {
  if (!schedule) return null;

  const type = String(schedule.type || '').trim();
  const when = String(schedule.when || '').trim();

  if (type === 'interval') {
    const minutesRaw = Number(when);
    if (!Number.isFinite(minutesRaw)) return null;
    const minutes = Math.max(1, Math.round(minutesRaw));
    if (minutes < 60) return `*/${minutes} * * * *`;
    const hours = Math.max(1, Math.round(minutes / 60));
    return `0 */${hours} * * *`;
  }

  if (type === 'daily') {
    const [hRaw, mRaw] = when.split(':');
    const hourRaw = Number(hRaw);
    const minuteRaw = Number(mRaw);
    if (!Number.isFinite(hourRaw) || !Number.isFinite(minuteRaw)) return null;
    const hour = Math.min(23, Math.max(0, Math.floor(hourRaw)));
    const minute = Math.min(59, Math.max(0, Math.floor(minuteRaw)));
    return `${minute} ${hour} * * *`;
  }

  return null;
}

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

  const [title, setTitle] = useState('Workflow Editor');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const persisted = localStorage.getItem('rr-theme') as 'light' | 'dark' | null;
      if (persisted === 'light' || persisted === 'dark') {
        return persisted;
      }
    } catch {
      // ignore
    }
    return matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const [highlightField, setHighlightField] = useState<string | null>(null);
  const [fitSeq, setFitSeq] = useState(0);
  const [triggerPanelVisible, setTriggerPanelVisible] = useState(false);

  const [renameVisible, setRenameVisible] = useState(false);
  const [renameName, setRenameName] = useState('');
  const [renameDesc, setRenameDesc] = useState('');

  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [fallbackNotice, setFallbackNotice] = useState<FallbackNotice | null>(null);

  const [, forceRender] = useState(0);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bootstrapDoneRef = useRef(false);

  const rpc = useRRV3Rpc({
    autoConnect: true,
    onError: (message) => pushToast(message, 'error'),
  });

  function pushToast(message: string, level: ToastLevel = 'warn') {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const item: ToastItem = { id, message, level };
    setToasts((current) => [...current, item]);
    setTimeout(() => {
      setToasts((current) => current.filter((x) => x.id !== id));
    }, 2500);
  }

  const selectedId = ((store.activeNodeId as any)?.value ?? null) as string | null;
  const selectedEdgeId = ((store.activeEdgeId as any)?.value ?? null) as string | null;
  const activeNode = store.nodes.find((n) => n.id === selectedId) || null;
  const activeEdge = store.edges.find((e) => e.id === selectedEdgeId) || null;
  const validation = validateFlow(store.nodes);
  const availableVars = store.listAvailableVariables(selectedId || undefined);
  const currentSubflowIdVal = ((store.currentSubflowId as any)?.value ?? null) as string | null;

  const saveLabel =
    saveState === 'saving' ? 'Saving...' : saveState === 'saved' ? 'Saved' : '';

  function initEmptyFlow() {
    const now = Date.now();
    const empty: FlowV2 = {
      id: `flow_${now}`,
      name: 'New workflow',
      version: 1,
      steps: [],
      variables: [],
      meta: {
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      } as any,
    } as any;
    store.initFromFlow(empty);
    setTitle('New workflow');
  }

  async function bootstrap() {
    const q = getQuery();
    if (q.flowId) {
      try {
        await rpc.ensureConnected();
        const flowV3 = (await rpc.request('rr_v3.getFlow', {
          flowId: q.flowId as FlowId,
        })) as FlowV3 | null;

        if (flowV3) {
          const { flow: flowV2, warnings } = flowV3ToV2ForBuilder(flowV3);
          warnings.forEach((w) => pushToast(w, 'warn'));
          store.initFromFlow(flowV2);
          setTitle(`Edit: ${flowV2.name || flowV2.id}`);

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
          pushToast(`Workflow "${q.flowId}" Not found, new workflow created`, 'warn');
          initEmptyFlow();
        }
      } catch (error) {
        pushToast(`Failed to load workflow: ${error instanceof Error ? error.message : String(error)}`, 'error');
        initEmptyFlow();
      }
    } else if (q.new === '1') {
      initEmptyFlow();
    }
  }

  function onAddNodeAt(type: string, x: number, y: number) {
    try {
      store.addNodeAt(type as NodeBase['type'], x, y);
    } catch {
      // ignore
    }
  }

  function fitAll() {
    setFitSeq((n) => n + 1);
  }

  function openRename() {
    setRenameName(store.flowLocal.name || '');
    setRenameDesc((store.flowLocal as any).description || '');
    setRenameVisible(true);
  }

  function applyRename() {
    store.flowLocal.name = renameName.trim();
    (store.flowLocal as any).description = renameDesc;
    setRenameVisible(false);
  }

  async function syncTriggersAndSchedules(flowId: string, nodes: unknown[]) {
    const triggersNeeded: TriggerSpec[] = [];
    const tnodes = (nodes || []).filter((n: any) => n && n.type === 'trigger');

    for (const n of tnodes as any[]) {
      const cfg = n.config || {};
      const enabled = cfg.enabled !== false;

      if (cfg.modes?.url && Array.isArray(cfg.url?.rules) && cfg.url.rules.length) {
        triggersNeeded.push({
          id: trigId(flowId, n.id, 'url'),
          kind: 'url',
          enabled,
          flowId: flowId as FlowId,
          match: cfg.url.rules,
        });
      }

      if (cfg.modes?.contextMenu && cfg.contextMenu?.title) {
        triggersNeeded.push({
          id: trigId(flowId, n.id, 'menu'),
          kind: 'contextMenu',
          enabled,
          flowId: flowId as FlowId,
          title: cfg.contextMenu.title,
          contexts: (Array.isArray(cfg.contextMenu.contexts)
            ? cfg.contextMenu.contexts
            : ['all']
          ).map(String),
        });
      }

      if (cfg.modes?.command && cfg.command?.commandKey) {
        triggersNeeded.push({
          id: trigId(flowId, n.id, 'cmd'),
          kind: 'command',
          enabled,
          flowId: flowId as FlowId,
          commandKey: String(cfg.command.commandKey),
        });
      }

      if (cfg.modes?.dom && cfg.dom?.selector) {
        const debounceMsRaw = Number(cfg.dom.debounceMs);
        triggersNeeded.push({
          id: trigId(flowId, n.id, 'dom'),
          kind: 'dom',
          enabled,
          flowId: flowId as FlowId,
          selector: String(cfg.dom.selector),
          appear: cfg.dom.appear !== false,
          once: cfg.dom.once !== false,
          debounceMs: Number.isFinite(debounceMsRaw) ? debounceMsRaw : 800,
        });
      }

      if (cfg.modes?.schedule && Array.isArray(cfg.schedules)) {
        cfg.schedules.forEach((s: any, i: number) => {
          const cron = scheduleToCron(s);
          if (!cron) {
            const scheduleType = String(s?.type || 'unknown');
            if (scheduleType === 'once') {
              pushToast(`Node ${n.id} Timing #${i + 1}: V3 One-time timing (once) is not supported yet, has been skipped`, 'warn');
            } else {
              pushToast(`Node ${n.id} Timing #${i + 1}: Cannot convert to cron(type=${scheduleType}），skipped`, 'warn');
            }
            return;
          }

          triggersNeeded.push({
            id: schId(flowId, n.id, i),
            kind: 'cron',
            enabled: enabled && s?.enabled !== false,
            flowId: flowId as FlowId,
            cron,
          });
        });
      }
    }

    try {
      await rpc.ensureConnected();

      const existing = (await rpc.request('rr_v3.listTriggers', {
        flowId: flowId as FlowId,
      })) as TriggerSpec[] | null;

      const existingById = new Map((existing || []).map((t) => [t.id, t]));
      const neededIds = new Set(triggersNeeded.map((t) => t.id));

      for (const trigger of triggersNeeded) {
        const triggerPayload = trigger as unknown as JsonObject;
        if (existingById.has(trigger.id)) {
          await rpc.request('rr_v3.updateTrigger', { trigger: triggerPayload });
        } else {
          await rpc.request('rr_v3.createTrigger', { trigger: triggerPayload });
        }
      }

      const nodeManagedPrefixes = [`trg_${flowId}_`, `sch_${flowId}_`];
      const isNodeManaged = (triggerId: string) =>
        nodeManagedPrefixes.some((prefix) => triggerId.startsWith(prefix));

      for (const existingItem of existingById.values()) {
        if (!neededIds.has(existingItem.id) && isNodeManaged(existingItem.id)) {
          await rpc.request('rr_v3.deleteTrigger', { triggerId: existingItem.id });
        }
      }
    } catch (error) {
      console.warn('[Builder] Trigger sync failed:', error);
    }
  }

  async function save(): Promise<FlowV3 | null> {
    try {
      const flowV2 = store.exportFlowForSave();
      await rpc.ensureConnected();

      const { flow: flowV3, warnings: convWarnings } = flowV2ToV3ForRpc(flowV2);
      convWarnings.forEach((w) => pushToast(w, 'warn'));

      const saved = (await rpc.request('rr_v3.saveFlow', {
        flow: flowV3 as unknown as JsonObject,
      })) as unknown as FlowV3;

      if (!store.flowLocal.meta) {
        (store.flowLocal as any).meta = {};
      }
      (store.flowLocal as any).meta.createdAt = saved.createdAt;
      (store.flowLocal as any).meta.updatedAt = saved.updatedAt;

      try {
        await syncTriggersAndSchedules(flowV2.id, flowV2.nodes || []);
      } catch {
        // ignore
      }

      return saved;
    } catch (error) {
      pushToast(`Save failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return null;
    }
  }

  async function exportFlow() {
    try {
      const saved = await save();
      if (!saved) return;

      const blob = new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      await chrome.downloads.download({
        url,
        filename: `${store.flowLocal.name || 'flow'}.json`,
        saveAs: true,
      } as chrome.downloads.DownloadOptions);
      URL.revokeObjectURL(url);
    } catch (error) {
      pushToast(`Export failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
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
        pushToast('Import failed: Workflow data not found', 'error');
        return;
      }

      const first = candidates[0];

      if (isFlowV3(first)) {
        await rpc.ensureConnected();
        const saved = (await rpc.request('rr_v3.saveFlow', {
          flow: first as unknown as JsonObject,
        })) as unknown as FlowV3;

        const { flow: flowV2, warnings } = flowV3ToV2ForBuilder(saved);
        warnings.forEach((w) => pushToast(w, 'warn'));
        store.initFromFlow(flowV2);
        setTitle(`Edit: ${flowV2.name || flowV2.id}`);

        try {
          await syncTriggersAndSchedules(flowV2.id, flowV2.nodes || []);
        } catch {
          // ignore
        }
      } else {
        store.initFromFlow(first as FlowV2);

        if (
          Array.isArray((first as any)?.steps) &&
          (!Array.isArray((first as any)?.nodes) || (first as any).nodes.length === 0)
        ) {
          store.importFromSteps();
        }

        setTitle(`Edit: ${store.flowLocal.name || store.flowLocal.id}`);
        await save();
      }
    } catch (error) {
      pushToast(`Import failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      input.value = '';
    }
  }

  async function runFromSelected() {
    if (!selectedId || !store.flowLocal?.id) return;

    try {
      const saved = await save();
      if (!saved) return;

      await rpc.ensureConnected();

      const node = store.nodes.find((n) => n.id === selectedId) || null;
      const startNodeId = node?.type === 'trigger' ? undefined : selectedId;

      await rpc.request('rr_v3.enqueueRun', {
        flowId: saved.id as FlowId,
        ...(startNodeId ? { startNodeId: startNodeId as NodeId } : {}),
      });
    } catch (error) {
      pushToast(`Run failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async function runAll() {
    if (!store.flowLocal?.id) return;

    try {
      const saved = await save();
      if (!saved) return;

      await rpc.ensureConnected();
      await rpc.request('rr_v3.enqueueRun', { flowId: saved.id as FlowId });
    } catch (error) {
      pushToast(`Run failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  function undoFallbackPromotion() {
    const n = fallbackNotice;
    if (!n) return;
    const node = store.nodes.find((x) => x.id === n.nodeId);
    if (!node || (node.type !== 'click' && node.type !== 'fill')) {
      setFallbackNotice(null);
      return;
    }
    const cands = (node as any).config?.target?.candidates as Array<{ type: string; value: string }>;
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

    saveTimerRef.current = setTimeout(async () => {
      try {
        setSaveState('saving');
        await new Promise((resolve) => setTimeout(resolve, 0));
        const saved = await save();
        if (!saved) {
          setSaveState('idle');
          return;
        }

        setSaveState('saved');
        if (statusTimerRef.current) {
          clearTimeout(statusTimerRef.current);
        }
        statusTimerRef.current = setTimeout(() => setSaveState('idle'), 1200);
      } catch {
        setSaveState('idle');
      }
    }, 800);
  }

  useEffect(() => {
    const onToast = (ev: Event) => {
      try {
        const customEvent = ev as CustomEvent;
        const msg = String((customEvent as any)?.detail?.message || '');
        const level = ((customEvent as any)?.detail?.level || 'warn') as ToastLevel;
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
        const tag = (t.tagName || '').toLowerCase();
        const inEditable =
          tag === 'input' ||
          tag === 'textarea' ||
          tag === 'select' ||
          t.isContentEditable ||
          !!t.closest('.floating-property');
        if (inEditable) return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && id) {
        e.preventDefault();
        store.removeNode(id);
      } else if (isMeta && e.key.toLowerCase() === 'd') {
        if (id) {
          e.preventDefault();
          store.duplicateNode(id);
        }
      } else if (isMeta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      } else if (isMeta && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };

    window.addEventListener('rr_toast', onToast as EventListener);
    document.addEventListener('keydown', onKey);

    if (!bootstrapDoneRef.current) {
      bootstrapDoneRef.current = true;
      void bootstrap();
    }

    return () => {
      window.removeEventListener('rr_toast', onToast as EventListener);
      document.removeEventListener('keydown', onKey);

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  });

  useEffect(() => {
    try {
      localStorage.setItem('rr-theme', theme);
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
            <span>Fallback recommendation applied: Promote {fallbackNotice.type} Priority</span>
            <button className="mini" type="button" onClick={undoFallbackPromotion}>
              Cancel
            </button>
          </div>
        ) : null}

        <div className="main">
          <Canvas {...canvasProps} />

          <div className="topbar rr-topbar backdrop-blur">
            <div className="left">
              <strong className="text-[var(--rr-text)]">{title}</strong>
              <span className="tip">Workflow visual orchestration</span>
            </div>
            <div className="right">
              <button className="top-btn" type="button" onClick={() => void exportFlow()} title="Export JSON">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                </svg>
                Export
              </button>

              <label className="top-btn import" title="Import JSON">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
                </svg>
                import
                <input type="file" accept="application/json" onChange={onImport} />
              </label>

              <button className="top-btn" type="button" onClick={openRename} title="Rename workflow">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
                </svg>
                Rename
              </button>

              <button
                className={`top-btn ${triggerPanelVisible ? 'active' : ''}`}
                type="button"
                onClick={() => setTriggerPanelVisible((v) => !v)}
                title="Manage triggers"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                Triggers
              </button>

              <span className="divider-vert" />

              <button className="top-btn" type="button" disabled={!selectedId} onClick={() => void runFromSelected()} title="Playback from selected node">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                Run from selected
              </button>

              <button className="top-btn primary" type="button" onClick={() => void runAll()} title="Playback rectification from the beginning">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
                run
              </button>

              <span className="divider-vert" />

              <span className="status" data-state={saveState}>
                {saveLabel}
              </span>

              <button className="top-btn success" type="button" onClick={() => void save()}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
                save
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
              <EdgePropertyPanel edge={activeEdge} nodes={store.nodes} onRemoveEdge={store.removeEdge} />
            </div>
          ) : null}

          {triggerPanelVisible && store.flowLocal?.id ? (
            <div className="floating-trigger">
              <TriggerPanel flowId={store.flowLocal.id} onClose={() => setTriggerPanelVisible(false)} />
            </div>
          ) : null}

          <div className="bottom-toolbar">
            <button className="toolbar-btn" type="button" onClick={store.undo} title="Undo (⌘/Ctrl+Z)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 7v6h6M21 17a9 9 0 00-9-9 9 9 0 00-9 9" />
              </svg>
            </button>

            <button className="toolbar-btn" type="button" onClick={store.redo} title="redo (⌘/Ctrl+Shift+Z)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 7v6h-6M3 17a9 9 0 019-9 9 9 0 019 9" />
              </svg>
            </button>

            <span className="toolbar-divider" />

            <button className="toolbar-btn" type="button" onClick={store.layoutAuto} title="Automatic typesetting">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
              </svg>
            </button>

            <button className="toolbar-btn" type="button" onClick={fitAll} title="Adaptive view">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
              <div className="title">Rename workflow</div>
              <button className="close" type="button" onClick={() => setRenameVisible(false)}>
                ✕
              </button>
            </div>
            <div className="rr-body">
              <div className="row">
                <label>Name</label>
                <input value={renameName} onChange={(event) => setRenameName(event.currentTarget.value)} placeholder="Workflow name" />
              </div>
              <div className="row">
                <label>Description</label>
                <textarea value={renameDesc} onChange={(event) => setRenameDesc(event.currentTarget.value)} placeholder="Optional description" />
              </div>
            </div>
            <div className="rr-footer">
              <button className="primary" type="button" onClick={applyRename}>
                save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
