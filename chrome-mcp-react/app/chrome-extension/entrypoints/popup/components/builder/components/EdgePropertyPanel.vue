<template>
  <aside class="property-panel">
    <div v-if="edge" class="panel-content">
      <div class="panel-header">
        <div>
          <div class="header-title">Edge</div>
          <div class="header-id">{{ edge.id }}</div>
        </div>
        <button class="btn-delete" type="button" title="删除边" @click.stop="onRemove">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="m4 4 8 8M12 4 4 12"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>

      <div class="form-section">
        <div class="form-group">
          <label class="form-label">Source</label>
          <div class="text">{{ srcName }}</div>
        </div>
        <div class="form-group">
          <label class="form-label">Target</label>
          <div class="text">{{ dstName }}</div>
        </div>
        <div class="form-group">
          <label class="form-label">Connection status</label>
          <div class="status" :class="{ ok: isValid, bad: !isValid }">
            {{ isValid ? 'Valid' : 'Invalid' }}
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Branch</label>
          <div class="text">{{ labelPretty }}</div>
        </div>
      </div>
      <div class="divider"></div>

      <div class="form-section">
        <div class="text-xs text-slate-500" style="padding: 0 20px">
          Inspect connection only. Editing of branch/handles will be supported in a later pass.
        </div>
      </div>
    </div>
    <div v-else class="panel-empty">
      <div class="empty-text">未选择边</div>
    </div>
  </aside>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { Edge as EdgeV2, NodeBase } from '@/entrypoints/background/record-replay/types';

const props = defineProps<{ edge: EdgeV2 | null; nodes: NodeBase[] }>();
const emit = defineEmits<{ (e: 'remove-edge', id: string): void }>();

const src = computed(() => props.nodes?.find?.((n) => n.id === (props.edge as any)?.from) || null);
const dst = computed(() => props.nodes?.find?.((n) => n.id === (props.edge as any)?.to) || null);
const srcName = computed(() =>
  src.value ? src.value.name || `${src.value.type} (${src.value.id})` : 'Unknown',
);
const dstName = computed(() =>
  dst.value ? dst.value.name || `${dst.value.type} (${dst.value.id})` : 'Unknown',
);
const isValid = computed(() => !!(src.value && dst.value && src.value.id !== dst.value.id));
const labelPretty = computed(() => {
  const raw = String((props.edge as any)?.label || 'default');
  if (raw === 'default') return 'default';
  if (raw === 'true') return 'true ✓';
  if (raw === 'false') return 'false ✗';
  if (raw === 'onError') return 'onError !';
  if (raw === 'else') return 'else';
  if (raw.startsWith('case:')) {
    const id = raw.slice('case:'.length);
    const ifNode = src.value && (src.value as any).type === 'if' ? (src.value as any) : null;
    const found = ifNode?.config?.branches?.find?.((b: any) => String(b.id) === id);
    if (found) return `case: ${found.name || found.expr || id}`;
    return `case: ${id}`;
  }
  return raw;
});

function onRemove() {
  if (!props.edge) return;
  emit('remove-edge', props.edge.id);
}
</script>

<style scoped>
.property-panel {
  background: var(--rr-card);
  border: 1px solid var(--rr-border);
  border-radius: 16px;
  margin: 16px;
  padding: 0;
  width: 380px;
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 72px);
  overflow-y: auto;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  flex-shrink: 0;
  scrollbar-width: none;
  scrollbar-color: rgba(0, 0, 0, 0.25) transparent;
}
.panel-content {
  display: flex;
  flex-direction: column;
}
.panel-header {
  padding: 12px 12px 12px 20px;
  border-bottom: 1px solid var(--rr-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.header-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--rr-text);
  margin-bottom: 4px;
}
.header-id {
  font-size: 11px;
  color: var(--rr-text-weak);
  font-family: 'Monaco', monospace;
  opacity: 0.7;
}
.btn-delete {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--rr-border);
  background: var(--rr-card);
  color: var(--rr-danger);
  border-radius: 6px;
  cursor: pointer;
}
.btn-delete:hover {
  background: rgba(239, 68, 68, 0.08);
  border-color: rgba(239, 68, 68, 0.3);
}
.form-section {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.form-group {
  display: grid;
  grid-template-columns: 110px 1fr;
  align-items: center;
  gap: 8px;
}
.form-label {
  color: var(--rr-text-secondary);
  font-size: 13px;
  font-weight: 500;
}
.text {
  font-size: 13px;
}
.status.ok {
  color: #059669;
  font-weight: 600;
}
.status.bad {
  color: #ef4444;
  font-weight: 600;
}
.divider {
  height: 1px;
  background: var(--rr-border);
}
.panel-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
}
.empty-text {
  color: var(--rr-text-secondary);
}

/* Hide scrollbars in WebKit while keeping scrollability */
.property-panel :deep(::-webkit-scrollbar) {
  width: 0;
  height: 0;
}
.property-panel :deep(::-webkit-scrollbar-thumb) {
  background-color: rgba(0, 0, 0, 0.25);
  border-radius: 6px;
}
.property-panel :deep(::-webkit-scrollbar-track) {
  background: transparent !important;
}
</style>
