<template>
  <div class="var-input-wrap">
    <input
      ref="inputEl"
      class="form-input"
      :placeholder="placeholder"
      :value="modelValue"
      @input="onInput"
      @keydown="onKeydown"
      @blur="onBlur"
      @focus="onFocus"
    />
    <div
      v-if="open && filtered.length"
      class="var-suggest"
      @mouseenter="hover = true"
      @mouseleave="
        hover = false;
        open = false;
      "
    >
      <div
        v-for="(v, i) in filtered"
        :key="v.key + ':' + (v.nodeId || '')"
        class="var-item"
        :class="{ active: i === activeIdx }"
        @mousedown.prevent
        @click="insertVar(v.key)"
        :title="
          v.origin === 'node' ? `${v.key} · from ${v.nodeName || v.nodeId}` : `${v.key} · global`
        "
      >
        <span class="var-key">{{ v.key }}</span>
        <span class="var-origin" :data-origin="v.origin">{{
          v.origin === 'node' ? v.nodeName || v.nodeId || 'node' : 'global'
        }}</span>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref, watch } from 'vue';
import type { VariableOption } from '../model/variables';
import { VAR_PLACEHOLDER, VAR_TOKEN_CLOSE, VAR_TOKEN_OPEN } from '../model/variables';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    variables?: VariableOption[];
    placeholder?: string;
    // insertion format: "{key}" (mustache) or "workflow.key" (workflowDot)
    format?: 'mustache' | 'workflowDot';
  }>(),
  { modelValue: '', variables: () => [], format: 'mustache' },
);
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const inputEl = ref<HTMLInputElement | null>(null);
const open = ref(false);
const hover = ref(false);
const activeIdx = ref(0);

const query = computed(() => {
  const val = String(props.modelValue || '');
  // Extract text after the last '{' up to caret when focused
  const el = inputEl.value;
  const pos = el?.selectionStart ?? val.length;
  const before = val.slice(0, pos);
  const lastOpen = before.lastIndexOf(VAR_TOKEN_OPEN);
  const lastClose = before.lastIndexOf(VAR_TOKEN_CLOSE);
  if (lastOpen >= 0 && lastClose < lastOpen) return before.slice(lastOpen + 1).trim();
  // special case: contains '{}' placeholder
  if (val.includes(VAR_PLACEHOLDER)) return '';
  return '';
});

const filtered = computed<VariableOption[]>(() => {
  const all = props.variables || [];
  const q = query.value.toLowerCase();
  if (!q) return all;
  return all.filter((v) => v.key.toLowerCase().startsWith(q));
});

function showSuggestIfNeeded(next: string) {
  try {
    const el = inputEl.value;
    const pos = el?.selectionStart ?? next.length;
    const before = next.slice(0, pos);
    const shouldOpen = before.endsWith(VAR_TOKEN_OPEN) || next.includes(VAR_PLACEHOLDER);
    open.value = shouldOpen;
    if (shouldOpen) activeIdx.value = 0;
  } catch {
    open.value = false;
  }
}

function onInput(e: Event) {
  const target = e.target as HTMLInputElement;
  const v = target?.value ?? '';
  emit('update:modelValue', v);
  showSuggestIfNeeded(v);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === '{') {
    // Defer until input updates
    setTimeout(() => showSuggestIfNeeded(String(props.modelValue || '')), 0);
  }
  // Manual trigger: Ctrl/Cmd+Space opens suggestions
  if ((e.ctrlKey || e.metaKey) && e.key === ' ') {
    e.preventDefault();
    open.value = (props.variables || []).length > 0;
    activeIdx.value = 0;
    return;
  }
  if (!open.value) return;
  if (e.key === 'Escape') {
    open.value = false;
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIdx.value = (activeIdx.value + 1) % Math.max(1, filtered.value.length);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIdx.value =
      (activeIdx.value - 1 + Math.max(1, filtered.value.length)) %
      Math.max(1, filtered.value.length);
    return;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    if (!filtered.value.length) return;
    e.preventDefault();
    insertVar(
      filtered.value[Math.max(0, Math.min(activeIdx.value, filtered.value.length - 1))].key,
    );
  }
}

function onBlur() {
  // Close after suggestions click handler
  setTimeout(() => (!hover.value ? (open.value = false) : null), 50);
}
function onFocus() {
  showSuggestIfNeeded(String(props.modelValue || ''));
}

function insertVar(key: string) {
  const el = inputEl.value;
  const val = String(props.modelValue || '');
  const token =
    props.format === 'workflowDot'
      ? `workflow.${key}`
      : `${VAR_TOKEN_OPEN}${key}${VAR_TOKEN_CLOSE}`;
  if (!el) {
    emit('update:modelValue', `${val}${token}`);
    open.value = false;
    return;
  }
  const start = el.selectionStart ?? val.length;
  const end = el.selectionEnd ?? start;
  const before = val.slice(0, start);
  const after = val.slice(end);
  const lastOpen = before.lastIndexOf(VAR_TOKEN_OPEN);
  const lastClose = before.lastIndexOf(VAR_TOKEN_CLOSE);

  let next: string;
  if (val.includes(VAR_PLACEHOLDER)) {
    const idx = val.indexOf(VAR_PLACEHOLDER);
    next = val.slice(0, idx) + token + val.slice(idx + 2);
  } else if (lastOpen >= 0 && lastClose < lastOpen) {
    // replace incomplete token {xxx| with {key}
    next = val.slice(0, lastOpen) + token + after;
  } else {
    next = before + token + after;
  }
  emit('update:modelValue', next);
  // move caret after inserted token
  requestAnimationFrame(() => {
    try {
      const pos =
        props.format === 'workflowDot'
          ? before.length + token.length
          : next.indexOf(VAR_TOKEN_CLOSE, lastOpen >= 0 ? lastOpen : start) + 1 || next.length;
      inputEl.value?.setSelectionRange(pos, pos);
    } catch {}
  });
  open.value = false;
}

onMounted(() => {
  // best effort: nothing special
});

watch(
  () => props.modelValue,
  (v) => {
    if (document.activeElement === inputEl.value) showSuggestIfNeeded(String(v || ''));
  },
);
</script>

<style scoped>
.var-input-wrap {
  position: relative;
}
.var-suggest {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 200px;
  overflow: auto;
  background: var(--rr-bg, #fff);
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  z-index: 1000;
}
.var-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  cursor: pointer;
  font-size: 12px;
}
.var-item.active,
.var-item:hover {
  background: var(--rr-hover, #f3f4f6);
}
.var-key {
  color: var(--rr-text, #111);
}
.var-origin {
  color: var(--rr-muted, #666);
}
.var-origin[data-origin='node'] {
  color: #2563eb;
}
.var-origin[data-origin='global'] {
  color: #059669;
}
</style>
