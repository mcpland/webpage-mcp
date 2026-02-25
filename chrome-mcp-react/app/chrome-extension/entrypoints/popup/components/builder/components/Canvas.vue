<template>
  <section class="canvas rr-dot-grid">
    <VueFlow
      v-model:nodes="vfNodes"
      v-model:edges="vfEdges"
      :min-zoom="0.2"
      :max-zoom="1.5"
      :fit-view-on-init="true"
      :node-types="nodeTypes"
      snap-to-grid
      :snap-grid="[24, 24]"
      @connect="onConnectInternal"
      @node-drag-stop="onNodeDragStopInternal"
      @dragover.prevent="onDragOver"
      @drop="onDrop"
      @pane-click="onPaneClick"
      @edge-click="onEdgeClick"
    >
      <Background patternColor="#cdcdcd" :gap="32" pattern-class="canvas-pattern" />
    </VueFlow>
  </section>
</template>

<script lang="ts" setup>
import { ref, watch, watchEffect, markRaw } from 'vue';
import {
  VueFlow,
  type Node as VFNode,
  type Edge as VFEdge,
  type Connection,
  useVueFlow,
} from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
// Note: background package doesn't expose style.css via exports in Vite 6.
// The component works without its dedicated CSS; keep core/minimap/controls styles.

import type { NodeBase, Edge as EdgeV2 } from '@/entrypoints/background/record-replay/types';
import NodeCard from './nodes/NodeCard.vue';
import NodeIf from './nodes/NodeIf.vue';
import { NODE_UI_LIST, canvasTypeKey } from '@/entrypoints/popup/components/builder/model/ui-nodes';
import { EDGE_LABELS } from 'webpage-mcp-shared';

const props = defineProps<{
  nodes: NodeBase[];
  edges: EdgeV2[];
  nodeErrors?: Record<string, string[]>;
  focusNodeId?: string | null;
  fitSeq?: number;
}>();
const emit = defineEmits<{
  (e: 'selectNode', id: string | null): void;
  (e: 'selectEdge', id: string | null): void;
  (e: 'duplicateNode', id: string): void;
  (e: 'removeNode', id: string): void;
  (e: 'connectFrom', id: string, label: 'default' | 'true' | 'false' | 'onError'): void;
  (e: 'connect', src: string, dst: string, label?: string): void;
  (e: 'nodeDragged', id: string, x: number, y: number): void;
  (e: 'addNodeAt', type: string, x: number, y: number): void;
}>();

const vfNodes = ref<VFNode[]>([]);
const vfEdges = ref<VFEdge[]>([]);
defineOptions({ name: 'BuilderCanvas' });
const api = useVueFlow();
const { fitView, getNodes, project } = api;

// Map our custom types to components for VueFlow via registry
const nodeTypes = (() => {
  const base: Record<string, any> = {};
  for (const n of NODE_UI_LIST) {
    const key = canvasTypeKey(n.type);
    // fallback: if a type doesn't specify a special canvas component, use NodeCard/NodeIf
    const comp = n.canvas || (n.type === 'if' ? (NodeIf as any) : (NodeCard as any));
    // Avoid making component instances reactive; VueFlow expects raw component refs
    base[key] = markRaw(comp);
  }
  return base;
})();

watchEffect(() => {
  // Build VueFlow nodes; attach node + edges to data for custom components
  const list = props.nodes || [];
  const edgesRef = props.edges || [];
  vfNodes.value = list.map((n) => ({
    id: n.id,
    position: { x: n.ui?.x || 0, y: n.ui?.y || 0 },
    type: canvasTypeKey(n.type as any),
    data: {
      node: n,
      edges: edgesRef,
      onSelect: (id: string) => emit('selectNode', id),
      errors: (props.nodeErrors || ({} as any))[n.id] || [],
    },
    class: 'rr-node-plain',
  }));
});
watchEffect(() => {
  // Map edges reactively; tracks length and label/style updates
  const list = props.edges || [];
  const textFor = (lab?: string) => {
    const l = lab || 'default';
    if (l === EDGE_LABELS.TRUE) return '✓';
    if (l === EDGE_LABELS.FALSE) return '✗';
    if (l === EDGE_LABELS.ON_ERROR) return '!';
    return '';
  };
  const labelFor = (e: any) => {
    const raw = String(e?.label || '');
    // Branch label: case:<id> -> resolve to branch name on source node
    if (raw.startsWith('case:')) {
      // For conditional branches, do not render edge labels per UX requirement
      return '';
    }
    if (raw === 'else') return '';
    return textFor(raw);
  };
  vfEdges.value = list.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    // Keep VueFlow aware of which specific handle an edge originates from
    // so that multiple branch edges do not collapse onto the default handle.
    sourceHandle:
      typeof e.label === 'string' && e.label.startsWith('case:') ? String(e.label) : undefined,
    label: labelFor(e),
    labelShowBg: true,
    labelBgPadding: [4, 6],
    labelBgStyle: { fill: '#e5e5e5', fillOpacity: 0.95, stroke: '#ffffff', strokeWidth: 1 },
    labelStyle: { fill: '#666666', fontWeight: 600, fontSize: 11 },
    style: {
      stroke: '#cdcdcd',
      strokeWidth: 1.5,
    },
    animated: false,
    // Use bezier to draw smooth curves between nodes
    type: 'bezier',
  }));
});

watch(
  () => props.focusNodeId,
  (id) => {
    if (!id) return;
    const nd = getNodes.value.find((n) => n.id === id);
    if (!nd) return;
    try {
      fitView({ nodes: [nd.id], duration: 300, padding: 0.2 });
    } catch {}
  },
);

watch(
  () => props.fitSeq,
  () => {
    try {
      fitView({ duration: 300, padding: 0.2 });
    } catch {}
  },
);

// if node helpers (for labeling)
function getIfBranches(node: any): Array<{ id: string; name?: string; expr?: string }> {
  try {
    const arr = (node?.config?.branches || []) as Array<any>;
    return Array.isArray(arr)
      ? arr.map((x: any) => ({ id: String(x.id || ''), name: x.name, expr: x.expr }))
      : [];
  } catch {
    return [];
  }
}
// (no additional helpers required in Canvas after node-type split)

function onNodeDragStopInternal(evt: any) {
  const node = evt?.node as VFNode | undefined;
  if (!node) return;
  emit('nodeDragged', node.id, Math.round(node.position.x), Math.round(node.position.y));
}

function onConnectInternal(conn: Connection) {
  if (!conn.source || !conn.target) return;
  // Prefer sourceHandle as label so conditional branches can be identified
  const lab = (conn as any).sourceHandle || 'default';
  emit('connect', conn.source, conn.target, String(lab));
  // 边更新由上层状态驱动，这里无需直接修改本地 vfEdges
}

function onDragOver(e: DragEvent) {
  // Hint browser/OS we are copying an item into the canvas
  try {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  } catch {}
}

function onDrop(e: DragEvent) {
  // Prevent default to ensure drop is handled by our canvas
  try {
    e.preventDefault();
  } catch {}
  const dt = e.dataTransfer;
  // Read from multiple types for robustness across environments
  const type = (
    dt?.getData('application/node-type') ||
    dt?.getData('text/node-type') ||
    dt?.getData('text/plain') ||
    ''
  ).trim();
  if (!type) return;
  // translate screen to flow coords
  try {
    const pos = project({ x: e.clientX, y: e.clientY } as any) as any;
    emit('addNodeAt', type, Math.round(pos.x || 0), Math.round(pos.y || 0));
  } catch {
    emit('addNodeAt', type, 200, 120);
  }
}

function onPaneClick() {
  // Deselect when clicking empty canvas area
  emit('selectNode', null);
  emit('selectEdge', null);
}

function onEdgeClick(evt: any) {
  try {
    const id = evt?.edge?.id || null;
    emit('selectEdge', id ? String(id) : null);
  } catch {
    emit('selectEdge', null);
  }
}

// Expose zoom helpers for external toolbar
function zoomIn() {
  try {
    (api as any).zoomIn?.();
  } catch {}
}
function zoomOut() {
  try {
    (api as any).zoomOut?.();
  } catch {}
}
function fitAll() {
  try {
    fitView({ duration: 300, padding: 0.2 });
  } catch {}
}
defineExpose({ zoomIn, zoomOut, fitAll });
</script>

<style scoped>
.canvas {
  position: relative;
  overflow: hidden;
  /* Use fixed background as requested */
  background: #ededed;
  /* Ensure VueFlow gets a non-zero layout size */
  width: 100%;
  height: 100%;
}

:deep(.workflow-node) {
  max-width: 400px;
  background: #fff;
  border: 1px solid var(--rr-border);
  border-radius: 16px;
  /* Requested node spacing */
  padding: 10px 16px 10px 10px;
  /* Text look */
  color: #8f8f8f;
  font-size: 12px;
  /* Interaction */
  transition:
    box-shadow 0.15s var(--cubic-enter, cubic-bezier(0.4, 0, 0.2, 1)),
    background-color 1s var(--cubic-enter, cubic-bezier(0.4, 0, 0.2, 1));
  cursor: pointer;
  position: relative;
}

/* Per-node error indicator (shield-x) */
:deep(.node-error) {
  position: absolute;
  top: -12px;
  right: 3px;
  width: 12px;
  height: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--rr-danger, #ef4444);
  cursor: help;
  z-index: 5;
}

/* Tooltip for error details */
:deep(.node-error .tooltip) {
  display: none;
  position: absolute;
  top: 22px;
  right: 0;
  max-width: 280px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--rr-border, #e5e7eb);
  background: var(--rr-card, #fff);
  color: var(--rr-text, #111827);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  font-size: 12px;
  line-height: 1.4;
  white-space: normal;
}
:deep(.node-error:hover .tooltip) {
  display: block;
}
:deep(.node-error .tooltip .item) {
  color: var(--rr-danger, #ef4444);
}

:deep(.workflow-node:hover) {
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  border-color: rgba(0, 0, 0, 0.06);
}

:deep(.workflow-node.selected) {
  /* Remove current border color and use subtle ring */
  border-color: transparent !important;
  box-shadow: 0 0 0 1px #afafaf;
}

/* 节点容器 */
:deep(.node-container) {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  /* Padding moved to .workflow-node to match requested style */
  padding: 0;
}

/* Node icon: keep container size; shrink inner icon via font-size */
:deep(.node-icon) {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: #fff;
  font-size: 14px; /* inner svg is 1em; smaller but container unchanged */
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

/* 图标颜色方案 - 参考图片风格 */
/* Solid color icon backgrounds (no gradients) */
:deep(.icon-navigate) {
  background: #667eea;
}
:deep(.icon-click) {
  background: #f5576c;
}
:deep(.icon-fill) {
  background: #4facfe;
}
:deep(.icon-wait) {
  background: #43e97b;
}
:deep(.icon-extract) {
  background: #fa709a;
}
:deep(.icon-http) {
  background: #30cfd0;
}
:deep(.icon-script) {
  background: #a8edea;
  color: #111;
}
:deep(.icon-screenshot) {
  background: #06b6d4;
}
:deep(.icon-trigger) {
  background: #f59e0b;
}
:deep(.icon-attr) {
  background: #8b5cf6;
}
:deep(.icon-loop) {
  background: #22c55e;
}
:deep(.icon-frame) {
  background: #64748b;
}
:deep(.icon-download) {
  background: #34d399;
}
:deep(.icon-if) {
  background: #ff9a56;
}
:deep(.icon-foreach),
:deep(.icon-while) {
  background: #fcb69f;
  color: #111;
}
:deep(.icon-assert) {
  background: #16a34a;
}
:deep(.icon-key) {
  background: #8ec5fc;
  color: #111;
}
:deep(.icon-dblclick) {
  background: #fe5196;
}
:deep(.icon-drag) {
  background: #f97316;
}
:deep(.icon-scroll) {
  background: #0ea5e9;
}
:deep(.icon-openTab),
:deep(.icon-switchTab),
:deep(.icon-closeTab) {
  background: #96fbc4;
  color: #111;
}
:deep(.icon-delay) {
  background: #f6d365;
  color: #111;
}

/* Missing canvas classes for tool node types whose icon class is based on type */
:deep(.icon-triggerEvent) {
  background: #f59e0b;
}
:deep(.icon-setAttribute) {
  background: #8b5cf6;
}
:deep(.icon-loopElements) {
  background: #22c55e;
}
:deep(.icon-switchFrame) {
  background: #64748b;
}
:deep(.icon-handleDownload) {
  background: #34d399;
}

/* 节点主体 */
:deep(.node-body) {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

:deep(.node-name) {
  font-size: 12px;
  font-weight: 500;
  color: #0d0d0d;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.01em;
  text-align: left;
}

:deep(.node-subtitle) {
  font-size: 10px;
  color: #8f8f8f;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

/* Connection handles */
:deep(.node-handle.vue-flow__handle) {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 0 1px #cdcdcd;
  transition: all 0.15s ease;
  will-change: transform;
}

/* Input (target, left) scales from bottom-right; Output (source, right) scales from bottom-left */
:deep(.vue-flow__handle-left.node-handle) {
  transform-origin: bottom right;
}

:deep(.vue-flow__handle-right.node-handle) {
  transform-origin: bottom left;
}

/* Always show unconnected handles (override default theme) */
:deep(.vue-flow__node .node-handle.unconnected.vue-flow__handle) {
  opacity: 1 !important;
}

/* Hide connected handles by default to ensure they only appear on hover */
:deep(.vue-flow__node .node-handle.connected.vue-flow__handle) {
  opacity: 0 !important;
}

/* Show all handles when hovering the whole vue-flow node wrapper */
:deep(.vue-flow__node:hover .node-handle.vue-flow__handle) {
  opacity: 1 !important;
}

/* Hover style on individual handle */
:deep(.node-handle.vue-flow__handle:hover) {
  box-shadow: 0 0 0 2px #cdcdcd;
  transform: scale(1.4);
}

:deep(.vue-flow__edge.selected .vue-flow__edge-path) {
  stroke: #8f8f8f !important;
}

/* 背景网格 */
:deep(.vue-flow__background) {
  background-color: #ededed;
}

/* Override default VueFlow node box to avoid extra white box behind custom node */
:deep(.vue-flow__node.rr-node-plain) {
  background: transparent !important;
  border: none !important;
  box-shadow: none !important;
  padding: 0 !important;
}

:deep(.vue-flow__node.rr-node-plain.selected) {
  box-shadow: none !important;
}

/* If/else case list inside node */
:deep(.if-cases) {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 6px;
}

:deep(.case-row) {
  position: relative;
  height: 26px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.03);
  color: #8f8f8f;
  display: flex;
  align-items: center;
  padding: 0 8px;
}

:deep(.case-row.else-row) {
  opacity: 0.85;
}

:deep(.case-label) {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
