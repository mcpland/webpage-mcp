import { reactive, ref } from 'vue';
import type {
  Flow as FlowV2,
  NodeBase,
  Edge as EdgeV2,
} from '@/entrypoints/background/record-replay/types';
import {
  autoChainEdges,
  cloneFlow,
  newId,
  stepsToNodes,
  summarizeNode,
  topoOrder,
} from '../model/transforms';
import { defaultConfigOf, getIoConstraint } from '../model/ui-nodes';
import { toast } from '../model/toast';

export function useBuilderStore(initial?: FlowV2 | null) {
  const flowLocal = reactive<FlowV2>({ id: '', name: '', version: 1, steps: [], variables: [] });
  const nodes = reactive<NodeBase[]>([]);
  const edges = reactive<EdgeV2[]>([]);
  const activeNodeId = ref<string | null>(null);
  const activeEdgeId = ref<string | null>(null);
  const pendingFrom = ref<string | null>(null);
  const pendingLabel = ref<string>('default');
  const paletteTypes = [
    'trigger',
    'click',
    'drag',
    'scroll',
    'fill',
    'if',
    'foreach',
    'while',
    'key',
    'wait',
    'assert',
    'navigate',
    'script',
    'delay',
    'http',
    'extract',
    'screenshot',
    'triggerEvent',
    'setAttribute',
    'loopElements',
    'switchFrame',
    'handleDownload',
    'executeFlow',
    'openTab',
    'switchTab',
    'closeTab',
  ] as NodeBase['type'][];

  // --- history (undo/redo) ---
  type Snapshot = {
    flow: Pick<FlowV2, 'name' | 'description'>;
    nodes: NodeBase[];
    edges: EdgeV2[];
  };
  const HISTORY_MAX = 50;
  const past: Snapshot[] = [];
  const future: Snapshot[] = [];
  function takeSnapshot(): Snapshot {
    return {
      flow: { name: flowLocal.name, description: flowLocal.description } as any,
      nodes: JSON.parse(JSON.stringify(nodes)),
      edges: JSON.parse(JSON.stringify(edges)),
    };
  }
  function applySnapshot(s: Snapshot) {
    flowLocal.name = (s.flow as any).name || '';
    (flowLocal as any).description = (s.flow as any).description || '';
    nodes.splice(0, nodes.length, ...JSON.parse(JSON.stringify(s.nodes)));
    edges.splice(0, edges.length, ...JSON.parse(JSON.stringify(s.edges)));
  }
  function recordChange() {
    past.push(takeSnapshot());
    // clear redo stack on new change
    future.length = 0;
    if (past.length > HISTORY_MAX) past.splice(0, past.length - HISTORY_MAX);
  }
  function undo() {
    if (past.length === 0) return;
    const current = takeSnapshot();
    const prev = past.pop()!;
    future.push(current);
    applySnapshot(prev);
  }
  function redo() {
    if (future.length === 0) return;
    const current = takeSnapshot();
    const next = future.pop()!;
    past.push(current);
    applySnapshot(next);
  }

  function layoutIfNeeded() {
    const startX = 120,
      startY = 80,
      gapY = 120;
    nodes.forEach((n, i) => {
      if (!n.ui || isNaN(n.ui.x) || isNaN(n.ui.y)) n.ui = { x: startX, y: startY + i * gapY };
    });
  }

  function initFromFlow(flow: FlowV2) {
    const deep = cloneFlow(flow);
    Object.assign(flowLocal, deep);
    // DAG is required - flow-store guarantees nodes/edges via normalization
    // steps fallback removed (deprecated field no longer returned)
    nodes.splice(0, nodes.length, ...(Array.isArray(deep.nodes) ? deep.nodes : []));
    edges.splice(
      0,
      edges.length,
      ...(Array.isArray(deep.edges) && deep.edges.length ? deep.edges : autoChainEdges(nodes)),
    );
    layoutIfNeeded();
    activeNodeId.value = nodes[0]?.id || null;
    activeEdgeId.value = null;
    // reset history
    past.length = 0;
    future.length = 0;
    past.push(takeSnapshot());
  }

  function selectNode(id: string | null) {
    // When click on empty canvas, id can be null => deselect
    if (id && pendingFrom.value && pendingFrom.value !== id) {
      onConnect(pendingFrom.value, id, pendingLabel.value);
      pendingFrom.value = null;
    }
    activeNodeId.value = id || null;
    // selecting a node should clear edge selection
    if (id) activeEdgeId.value = null;
  }

  function selectEdge(id: string | null) {
    activeEdgeId.value = id || null;
    if (id) activeNodeId.value = null;
  }

  function addNode(t: NodeBase['type']) {
    const id = newId(t);
    const n: NodeBase = {
      id,
      type: t,
      name: '',
      config: defaultConfigOf(t),
      ui: { x: 200 + nodes.length * 24, y: 120 + nodes.length * 96 },
    };
    nodes.push(n);
    if (nodes.length > 1) {
      const prev = nodes[nodes.length - 2];
      edges.push({ id: newId('e'), from: prev.id, to: id, label: 'default' });
    }
    activeNodeId.value = id;
    recordChange();
  }

  function addNodeAt(t: NodeBase['type'], x: number, y: number) {
    const id = newId(t);
    const n: NodeBase = {
      id,
      type: t,
      name: '',
      config: defaultConfigOf(t),
      ui: { x: Math.round(x), y: Math.round(y) },
    };
    nodes.push(n);
    activeNodeId.value = id;
    recordChange();
  }

  function duplicateNode(id: string) {
    const src = nodes.find((n) => n.id === id);
    if (!src) return;
    const cp: NodeBase = JSON.parse(JSON.stringify(src));
    cp.id = newId(src.type);
    cp.name = src.name ? `${src.name} Copy` : '';
    const baseX = cp.ui && typeof cp.ui.x === 'number' ? cp.ui.x : 200;
    const baseY = cp.ui && typeof cp.ui.y === 'number' ? cp.ui.y : 120;
    cp.ui = { x: baseX + 40, y: baseY + 40 };
    nodes.push(cp);
    activeNodeId.value = cp.id;
    recordChange();
  }

  function removeNode(id: string) {
    const idx = nodes.findIndex((n) => n.id === id);
    if (idx < 0) return;
    nodes.splice(idx, 1);
    for (let i = edges.length - 1; i >= 0; i--) {
      const e = edges[i];
      if (e.from === id || e.to === id) edges.splice(i, 1);
    }
    // After removal, do not auto-select another node to avoid accidental batch deletes
    activeNodeId.value = null;
    activeEdgeId.value = null;
    recordChange();
  }

  function removeEdge(id: string) {
    const idx = edges.findIndex((e) => e.id === id);
    if (idx < 0) return;
    edges.splice(idx, 1);
    if (activeEdgeId.value === id) activeEdgeId.value = null;
    recordChange();
  }

  function setNodePosition(id: string, x: number, y: number) {
    const n = nodes.find((n) => n.id === id);
    if (!n) return;
    n.ui = { x: Math.round(x), y: Math.round(y) };
    // 不计入历史栈，避免频繁记录；由用户触发操作（连接/新增/删除等）记录。
  }

  function connectFrom(id: string, label: string = 'default') {
    pendingFrom.value = id;
    pendingLabel.value = label;
  }

  function onConnect(sourceId: string, targetId: string, label: string = 'default') {
    // prevent self-loop
    if (sourceId === targetId) {
      toast('不能连接到自身', 'warn');
      return;
    }
    // IO constraints
    try {
      const src = nodes.find((n) => n.id === sourceId);
      const dst = nodes.find((n) => n.id === targetId);
      if (!src || !dst) return;
      const srcIo = getIoConstraint(src.type as any);
      const dstIo = getIoConstraint(dst.type as any);
      // Inputs: respect numeric maximum; 'any' means unlimited
      const incoming = edges.filter((e) => e.to === targetId).length;
      if (dstIo.inputs !== 'any' && incoming >= (dstIo.inputs as number)) {
        toast(`该节点最多允许 ${dstIo.inputs} 条入边`, 'warn');
        return;
      }
      // Outputs: respect numeric maximum when defined
      if (srcIo.outputs !== 'any') {
        const outgoing = edges.filter((e) => e.from === sourceId).length;
        if (outgoing >= (srcIo.outputs as number)) {
          toast(`该节点最多允许 ${srcIo.outputs} 条出边`, 'warn');
          return;
        }
      }
    } catch {}
    // 单一同标签出边：删除同源 + 同标签的已有边
    for (let i = edges.length - 1; i >= 0; i--) {
      const e = edges[i];
      const lab = e.label || 'default';
      if (e.from === sourceId && lab === label) edges.splice(i, 1);
    }
    // avoid duplicate for same pair+label
    if (
      edges.some(
        (e) => e.from === sourceId && e.to === targetId && (e.label || 'default') === label,
      )
    )
      return;
    edges.push({ id: newId('e'), from: sourceId, to: targetId, label });
    recordChange();
    // auto select the newly created edge
    try {
      const last = edges[edges.length - 1];
      activeEdgeId.value = last?.id || null;
      activeNodeId.value = null;
    } catch {}
  }

  /**
   * Derive available variables for the property panel.
   * - Includes declared flow variables (global)
   * - Includes variables produced by preceding nodes (saveAs/assign/itemVar etc.)
   * If currentId is provided, only nodes before it in topological order are considered.
   */
  function listAvailableVariables(currentId?: string): Array<{
    key: string;
    origin: 'global' | 'node';
    nodeId?: string;
    nodeName?: string;
  }> {
    const result: Array<{
      key: string;
      origin: 'global' | 'node';
      nodeId?: string;
      nodeName?: string;
    }> = [];
    const seen = new Set<string>();

    // 1) Flow-declared variables
    const declared = (flowLocal.variables || []) as Array<{ key: string }>;
    for (const v of declared) {
      const k = String(v?.key || '').trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      result.push({ key: k, origin: 'global' });
    }

    // 2) Variables derived from previous nodes
    const ordered = topoOrder(nodes as any, edges as any);
    let cutoffIndex =
      typeof currentId === 'string' ? ordered.findIndex((n) => n.id === currentId) : -1;
    if (cutoffIndex < 0) cutoffIndex = ordered.length; // include all if not found
    const prevNodes = ordered.slice(0, cutoffIndex);
    for (const n of prevNodes) {
      const cfg: any = (n as any).config || {};
      const nodeName = String((n as any).name || n.id || 'node');
      const pushVar = (k: string) => {
        const key = String(k || '').trim();
        if (!key || seen.has(key)) return;
        seen.add(key);
        result.push({ key, origin: 'node', nodeId: n.id, nodeName });
      };
      // Generic saveAs
      if (typeof cfg.saveAs === 'string') pushVar(cfg.saveAs);
      // assign mapping (keys are variable names)
      if (cfg.assign && typeof cfg.assign === 'object') {
        for (const k of Object.keys(cfg.assign)) pushVar(k);
      }
      // loop elements: list var + item var
      if ((n as any).type === 'loopElements') {
        if (typeof cfg.saveAs === 'string') pushVar(cfg.saveAs);
        if (typeof cfg.itemVar === 'string') pushVar(cfg.itemVar);
      }
    }

    return result;
  }

  function importFromSteps() {
    const arr = stepsToNodes(flowLocal.steps || []);
    nodes.splice(0, nodes.length, ...arr);
    edges.splice(0, edges.length, ...autoChainEdges(arr));
    layoutIfNeeded();
    recordChange();
  }

  // --- subflow management ---
  const currentSubflowId = ref<string | null>(null);
  function ensureSubflows() {
    if (!flowLocal.subflows) (flowLocal as any).subflows = {} as any;
  }
  function listSubflowIds(): string[] {
    ensureSubflows();
    return Object.keys((flowLocal as any).subflows || {});
  }
  function addSubflow(id: string) {
    ensureSubflows();
    const sf = (flowLocal as any).subflows as any;
    if (!id || sf[id]) return;
    sf[id] = { nodes: [], edges: [] };
    recordChange();
  }
  function removeSubflow(id: string) {
    ensureSubflows();
    const sf = (flowLocal as any).subflows as any;
    if (!sf[id]) return;
    delete sf[id];
    if (currentSubflowId.value === id) switchToMain();
    recordChange();
  }
  function flushCurrent() {
    if (!currentSubflowId.value) {
      // write back main
      (flowLocal as any).nodes = JSON.parse(JSON.stringify(nodes));
      (flowLocal as any).edges = JSON.parse(JSON.stringify(edges));
      return;
    }
    ensureSubflows();
    (flowLocal as any).subflows[currentSubflowId.value] = {
      nodes: JSON.parse(JSON.stringify(nodes)),
      edges: JSON.parse(JSON.stringify(edges)),
    };
  }
  function switchToMain() {
    flushCurrent();
    currentSubflowId.value = null;
    nodes.splice(0, nodes.length, ...JSON.parse(JSON.stringify((flowLocal.nodes || []) as any)));
    edges.splice(0, edges.length, ...JSON.parse(JSON.stringify((flowLocal.edges || []) as any)));
    layoutIfNeeded();
  }
  function switchToSubflow(id: string) {
    flushCurrent();
    currentSubflowId.value = id;
    ensureSubflows();
    const sf = (flowLocal as any).subflows[id] || { nodes: [], edges: [] };
    nodes.splice(0, nodes.length, ...JSON.parse(JSON.stringify(sf.nodes || [])));
    edges.splice(0, edges.length, ...JSON.parse(JSON.stringify(sf.edges || [])));
    layoutIfNeeded();
  }
  const isEditingMain = () => currentSubflowId.value == null;

  /**
   * Export flow for saving. This properly handles subflow editing:
   * 1. Flushes current canvas state back to flowLocal
   * 2. Returns a deep copy to avoid reference issues
   *
   * IMPORTANT: Always use this method for saving instead of directly
   * accessing store.nodes/edges, which may contain subflow data.
   *
   * NOTE: flow.steps is no longer written here. The storage layer (flow-store.ts)
   * will strip steps on save. Only nodes/edges are the source of truth.
   */
  function exportFlowForSave(): FlowV2 {
    // Step 1: Flush current canvas state to flowLocal
    flushCurrent();

    // Step 2: Return deep copy to prevent mutation
    return JSON.parse(JSON.stringify(flowLocal));
  }

  function summarize(id?: string) {
    const n = nodes.find((x) => x.id === id);
    return summarizeNode(n || null);
  }

  // 备用布局：分层 + 重心排序（不依赖外部库）
  function layoutFallback() {
    const idMap = new Map<string, NodeBase>();
    nodes.forEach((n) => idMap.set(n.id, n));

    // Build graph using all edges (include branches like case:/else/onError)
    const inEdges = new Map<string, EdgeV2[]>();
    const outEdges = new Map<string, EdgeV2[]>();
    for (const n of nodes) {
      inEdges.set(n.id, []);
      outEdges.set(n.id, []);
    }
    for (const e of edges) {
      if (!idMap.has(e.from) || !idMap.has(e.to)) continue;
      inEdges.get(e.to)!.push(e);
      outEdges.get(e.from)!.push(e);
    }

    // Kahn topo with all edges; fall back to original order on cycles
    const indeg = new Map<string, number>();
    nodes.forEach((n) => indeg.set(n.id, inEdges.get(n.id)!.length));
    const q: string[] = [];
    // Prefer trigger and existing left-most nodes first for stability
    const roots = nodes
      .filter((n) => (indeg.get(n.id) || 0) === 0)
      .sort(
        (a, b) =>
          (a.type === ('trigger' as any) ? -1 : 0) - (b.type === ('trigger' as any) ? -1 : 0),
      );
    roots.forEach((r) => q.push(r.id));
    const topo: string[] = [];
    const indegMut = new Map(indeg);
    while (q.length) {
      const v = q.shift()!;
      topo.push(v);
      for (const e of outEdges.get(v) || []) {
        const d = (indegMut.get(e.to) || 0) - 1;
        indegMut.set(e.to, d);
        if (d === 0) q.push(e.to);
      }
    }
    if (topo.length < nodes.length) {
      // Graph may contain cycles; append remaining nodes in original order
      for (const n of nodes) if (!topo.includes(n.id)) topo.push(n.id);
    }

    // Level assignment: level = max(parent.level + 1)
    const level = new Map<string, number>();
    for (const id of topo) {
      const parents = inEdges.get(id) || [];
      let lv = 0;
      for (const e of parents) lv = Math.max(lv, (level.get(e.from) || 0) + 1);
      // Ensure trigger stays at level 0
      const node = idMap.get(id)!;
      if ((node.type as any) === 'trigger') lv = 0;
      level.set(id, lv);
    }

    // Group nodes by level
    const maxLevel = Math.max(0, ...Array.from(level.values()));
    const layers: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
    for (const id of topo) layers[level.get(id) || 0].push(id);

    // Barycenter/median ordering per layer based on parent y-index
    const yIndex = new Map<string, number>();
    // initialize first layer stable order
    layers[0].forEach((id, i) => yIndex.set(id, i));
    for (let lv = 1; lv < layers.length; lv++) {
      const arr = layers[lv];
      const scored = arr.map((id) => {
        const ps = inEdges.get(id) || [];
        const parentIdx = ps
          .map((e) => yIndex.get(e.from))
          .filter((v): v is number => typeof v === 'number');
        const score = parentIdx.length
          ? parentIdx.reduce((a, b) => a + b, 0) / parentIdx.length
          : 1e9;
        return { id, score };
      });
      scored.sort((a, b) => a.score - b.score);
      scored.forEach((s, i) => yIndex.set(s.id, i));
      layers[lv] = scored.map((s) => s.id);
    }

    // Place nodes
    const startX = 120;
    const startY = 80;
    const stepX = 280; // tighter than 300 to reduce wide gaps
    const stepY = 110;
    for (let lv = 0; lv < layers.length; lv++) {
      const arr = layers[lv];
      for (let i = 0; i < arr.length; i++) {
        const id = arr[i];
        const n = idMap.get(id)!;
        n.ui = { x: startX + lv * stepX, y: startY + i * stepY } as any;
      }
    }
    recordChange();
  }

  // 自动排版（ELK 优先）：
  // - 动态引入 elkjs，避免常驻体积
  // - 失败则回退到 layoutFallback()
  async function layoutAuto() {
    try {
      // Dynamic import of bundled build to avoid 'web-worker' resolution issues
      const mod: any = await import('elkjs/lib/elk.bundled.js');
      const ELK = mod.default || mod.ELK || mod;
      const elk = new ELK();

      // Estimate node sizes (px). Keep close to actual NodeCard dimensions.
      const estimateSize = (n: NodeBase) => {
        const baseW = 280;
        let baseH = 72;
        if ((n.type as any) === 'if') baseH = 110;
        return { width: baseW, height: baseH };
      };

      const children = nodes.map((n) => ({ id: n.id, ...estimateSize(n) }));
      const elkEdges = edges
        .filter((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to))
        .map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] }));

      const graph = {
        id: 'root',
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': 'RIGHT',
          'elk.layered.spacing.nodeNodeBetweenLayers': '80',
          'elk.spacing.nodeNode': '40',
          'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
        },
        children,
        edges: elkEdges,
      } as any;

      const res = await elk.layout(graph);
      const pos = new Map<string, { x: number; y: number }>();
      for (const c of res.children || []) {
        pos.set(String(c.id), { x: Math.round(c.x || 0), y: Math.round(c.y || 0) });
      }
      // anchor
      const startX = 120;
      const startY = 80;
      for (const n of nodes) {
        const p = pos.get(n.id);
        if (p) n.ui = { x: startX + p.x, y: startY + p.y } as any;
      }
      recordChange();
    } catch (e) {
      // Fallback without dependency
      try {
        layoutFallback();
        toast('ELK 自动布局不可用，已使用备用布局', 'warn');
      } catch {}
    }
  }

  if (initial) initFromFlow(initial);

  return {
    flowLocal,
    nodes,
    edges,
    activeNodeId,
    activeEdgeId,
    pendingFrom,
    pendingLabel,
    currentSubflowId,
    paletteTypes,
    undo,
    redo,
    initFromFlow,
    selectNode,
    selectEdge,
    addNode,
    duplicateNode,
    removeNode,
    removeEdge,
    setNodePosition,
    addNodeAt,
    connectFrom,
    onConnect,
    listAvailableVariables,
    listSubflowIds,
    addSubflow,
    removeSubflow,
    switchToMain,
    switchToSubflow,
    isEditingMain,
    importFromSteps,
    exportFlowForSave,
    summarize,
    layoutAuto,
  };
}
