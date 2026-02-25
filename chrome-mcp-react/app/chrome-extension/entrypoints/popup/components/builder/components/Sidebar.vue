<template>
  <aside class="sidebar">
    <div class="search-box">
      <svg class="search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="7" cy="7" r="4" stroke="currentColor" stroke-width="1.5" />
        <path d="m10 10 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
      <input class="search-input" placeholder="Insert node..." v-model="q" />
    </div>

    <!-- Flow (only show if there are nodes in this category) -->
    <template v-if="filtered.Flow.length > 0">
      <div class="section-divider">
        <span class="divider-label">Flow</span>
      </div>
      <div class="nodes-section">
        <button
          v-for="n in filtered.Flow"
          :key="n.type"
          class="node-btn"
          draggable="true"
          @dragstart="onDragStart(n.type, $event)"
          @click="$emit('addNode', n.type)"
          :title="n.label"
        >
          <div class="btn-icon" :class="n.iconClass">
            <component :is="iconComp(n.type)" />
          </div>
          <span class="btn-label">{{ n.label }}</span>
        </button>
      </div>
    </template>

    <!-- Actions -->
    <div class="nodes-section">
      <button
        v-for="n in filtered.Actions"
        :key="n.type"
        class="node-btn"
        draggable="true"
        @dragstart="onDragStart(n.type, $event)"
        @click="$emit('addNode', n.type)"
        :title="n.label"
      >
        <div class="btn-icon" :class="n.iconClass">
          <component :is="iconComp(n.type)" />
        </div>
        <span class="btn-label">{{ n.label }}</span>
      </button>
    </div>

    <div class="section-divider">
      <span class="divider-label">Tools</span>
    </div>

    <div class="nodes-section">
      <button
        v-for="n in filtered.Tools"
        :key="n.type"
        class="node-btn"
        draggable="true"
        @dragstart="onDragStart(n.type, $event)"
        @click="$emit('addNode', n.type)"
        :title="n.label"
      >
        <div class="btn-icon" :class="n.iconClass">
          <component :is="iconComp(n.type)" />
        </div>
        <span class="btn-label">{{ n.label }}</span>
      </button>
    </div>

    <div class="section-divider">
      <span class="divider-label">Tabs</span>
    </div>

    <div class="nodes-section">
      <button
        v-for="n in filtered.Tabs"
        :key="n.type"
        class="node-btn"
        draggable="true"
        @dragstart="onDragStart(n.type, $event)"
        @click="$emit('addNode', n.type)"
        :title="n.label"
      >
        <div class="btn-icon" :class="n.iconClass">
          <component :is="iconComp(n.type)" />
        </div>
        <span class="btn-label">{{ n.label }}</span>
      </button>
    </div>

    <div class="section-divider">
      <span class="divider-label">Logic</span>
    </div>

    <div class="nodes-section">
      <button
        v-for="n in filtered.Logic"
        :key="n.type"
        class="node-btn"
        draggable="true"
        @dragstart="onDragStart(n.type, $event)"
        @click="$emit('addNode', n.type)"
        :title="n.label"
      >
        <div class="btn-icon" :class="n.iconClass">
          <component :is="iconComp(n.type)" />
        </div>
        <span class="btn-label">{{ n.label }}</span>
      </button>
    </div>
  </aside>
</template>

<script lang="ts" setup>
import { computed, ref } from 'vue';
import type { Flow as FlowV2, NodeBase } from '@/entrypoints/background/record-replay/types';
import { NODE_UI_LIST } from '@/entrypoints/popup/components/builder/model/ui-nodes';
import { iconComp } from './nodes/node-util';

const props = defineProps<{
  flow: FlowV2;
  paletteTypes: NodeBase['type'][];
  subflowIds?: string[];
  currentSubflowId?: string | null;
}>();
defineEmits<{
  (e: 'addNode', t: NodeBase['type']): void;
  (e: 'switchMain'): void;
  (e: 'switchSubflow', id: string): void;
  (e: 'addSubflow', id: string): void;
  (e: 'removeSubflow', id: string): void;
}>();
defineOptions({ name: 'BuilderSidebar' });

function onDragStart(t: NodeBase['type'], e: DragEvent) {
  try {
    const dt = e.dataTransfer;
    if (!dt) return;
    dt.setData('application/node-type', String(t));
    dt.setData('text/node-type', String(t));
    dt.setData('text/plain', String(t));
    dt.effectAllowed = 'copy';
  } catch {}
}

const q = ref('');
const filtered = computed(() => {
  const allow = new Set((props.paletteTypes || []) as string[]);
  const items = NODE_UI_LIST.filter((n) => allow.size === 0 || allow.has(n.type));
  const term = q.value.trim().toLowerCase();
  const list = term
    ? items.filter(
        (n) => n.label.toLowerCase().includes(term) || n.type.toLowerCase().includes(term),
      )
    : items;
  return {
    Flow: list.filter((x) => x.category === 'Flow'),
    Actions: list.filter((x) => x.category === 'Actions'),
    Tools: list.filter((x) => x.category === 'Tools'),
    Tabs: list.filter((x) => x.category === 'Tabs'),
    Logic: list.filter((x) => x.category === 'Logic'),
    Page: list.filter((x) => x.category === 'Page'),
  };
});
</script>

<style scoped>
.sidebar {
  background: var(--rr-card);
  border: 1px solid var(--rr-border);
  border-radius: 16px;
  padding: 16px 12px;
  margin: 16px;
  width: 240px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
  /* Ensure the sidebar never exceeds viewport height; allow internal scroll */
  max-height: calc(100vh - 72px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  flex-shrink: 0;
  /* Always hide scrollbars (Firefox), keep scrolling */
  scrollbar-width: none;
  scrollbar-color: rgba(0, 0, 0, 0.25) transparent;
}

/* 搜索框 */
.search-box {
  position: relative;
  display: flex;
  align-items: center;
}
.search-icon {
  position: absolute;
  left: 10px;
  color: var(--rr-text-weak);
  pointer-events: none;
}
.search-input {
  width: 100%;
  padding: 8px 10px 8px 32px;
  border: 1px solid var(--rr-border);
  border-radius: 8px;
  background: var(--rr-subtle);
  font-size: 13px;
  outline: none;
  transition: all 0.15s;
}
.search-input:focus {
  background: var(--rr-card);
  border-color: var(--rr-text-weak);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.06);
}

/* 节点区域 */
.nodes-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 节点按钮 */
.node-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: none;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s;
  text-align: left;
  position: relative;
}

.node-btn:hover {
  background: var(--rr-hover);
}

.node-btn:active {
  transform: scale(0.98);
}

/* 节点图标 - 彩色圆形 */
.btn-icon {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: #fff;
}

.icon-navigate {
  background: #667eea;
}
.icon-click {
  background: #f5576c;
}
.icon-fill {
  background: #4facfe;
}
.icon-wait {
  background: #43e97b;
}
.icon-extract {
  background: #fa709a;
}
.icon-http {
  background: #30cfd0;
}
.icon-download {
  background: #34d399;
}
.icon-script {
  background: #a8edea;
  color: #111;
}
.icon-screenshot {
  background: #06b6d4;
}
.icon-trigger {
  background: #f59e0b;
}
.icon-attr {
  background: #8b5cf6;
}
.icon-loop {
  background: #22c55e;
}
.icon-frame {
  background: #64748b;
}
.icon-exec {
  background: #111827;
}
.icon-key {
  background: #8ec5fc;
  color: #111;
}
.icon-scroll {
  background: #0ea5e9;
}
.icon-drag {
  background: #f97316;
}
.icon-assert {
  background: #16a34a;
}
.icon-delay {
  background: #f6d365;
  color: #111;
}
.icon-if {
  background: #ff9a56;
}
.icon-foreach,
.icon-while {
  background: #fcb69f;
  color: #111;
}
.icon-openTab,
.icon-switchTab,
.icon-closeTab {
  background: #96fbc4;
  color: #111;
}

/* Always hide scrollbar (WebKit/Blink); still scrollable */
.sidebar :deep(::-webkit-scrollbar) {
  width: 0;
  height: 0;
}
.sidebar :deep(::-webkit-scrollbar-thumb) {
  background-color: rgba(0, 0, 0, 0.25);
  border-radius: 6px;
}
.sidebar :deep(::-webkit-scrollbar-track) {
  background: transparent !important;
}

/* 节点标签 */
.btn-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--rr-text);
  flex: 1;
}

/* 分割线 */
.section-divider {
  display: flex;
  align-items: center;
  margin: 12px 0 8px;
}

.divider-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--rr-text-weak);
  white-space: nowrap;
}
</style>
