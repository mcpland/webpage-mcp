<template>
  <!-- eslint-disable vue/no-mutating-props -->
  <aside class="property-panel">
    <div v-if="node" class="panel-content">
      <div class="panel-header">
        <div>
          <div class="header-title">节点属性</div>
          <div class="header-id">{{ node.id }}</div>
        </div>
        <button class="btn-delete" type="button" title="删除节点" @click.stop="onRemove">
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
          <label class="form-label">节点名称</label>
          <input class="form-input" v-model="node.name" placeholder="输入节点名称" />
        </div>
      </div>

      <div class="divider"></div>

      <!-- 属性表单：统一使用 NodeSpec 驱动的表单引擎渲染 -->
      <PropertyFromSpec
        v-if="node"
        :key="node.type + ':' + node.id"
        :node="node"
        :variables="variables"
      />
      <div class="divider"></div>

      <!-- 通用设置 -->
      <div class="form-section">
        <div class="section-title">通用设置</div>
        <div class="form-group">
          <label class="form-label">超时 (ms)</label>
          <input
            class="form-input"
            type="number"
            v-model.number="(node.config as any).timeoutMs"
            min="0"
            placeholder="默认使用全局超时"
          />
        </div>
        <div class="form-group checkbox-group">
          <label class="checkbox-label">
            <input type="checkbox" v-model="(node.config as any).screenshotOnFail" />
            <span>失败时截图</span>
          </label>
        </div>
      </div>

      <div v-if="nodeErrors.length > 0" class="error-box">
        <div class="error-title">⚠️ 配置错误</div>
        <div v-for="e in nodeErrors" :key="e" class="error-item">{{ e }}</div>
      </div>
    </div>
    <div v-else class="panel-empty">
      <svg class="empty-icon" width="48" height="48" viewBox="0 0 48 48" fill="none">
        <rect
          x="8"
          y="8"
          width="32"
          height="32"
          rx="4"
          stroke="currentColor"
          stroke-width="2"
          opacity="0.3"
        />
        <path
          d="M18 20h12M18 24h12M18 28h8"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          opacity="0.3"
        />
      </svg>
      <div class="empty-text">选择一个节点<br />查看和编辑属性</div>
    </div>
  </aside>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import { computed, watch, onMounted, ref } from 'vue';
import type { NodeBase } from '@/entrypoints/background/record-replay/types';
import { validateNodeWithRegistry } from '@/entrypoints/popup/components/builder/model/ui-nodes';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';
import PropertyFromSpec from '@/entrypoints/popup/components/builder/components/properties/PropertyFromSpec.vue';

const props = defineProps<{
  node: NodeBase | null;
  highlightField?: string | null;
  subflowIds?: string[];
  variables?: Array<{ key: string }>;
}>();
const emit = defineEmits<{
  // Use kebab-case event names to match parent listeners
  (e: 'create-subflow', id: string): void;
  (e: 'switch-to-subflow', id: string): void;
  (e: 'remove-node', id: string): void;
}>();

function onRemove() {
  // Emit remove event only when node exists
  const n = props.node;
  if (!n) return;
  // Emit kebab-case event to match parent template listener
  emit('remove-node', n.id);
}

const waitJson = computed({
  get() {
    const n = props.node;
    if (!n || n.type !== 'wait') return '';
    try {
      return JSON.stringify(n.config?.condition || {}, null, 2);
    } catch {
      return '';
    }
  },
  set(v: string) {
    const n = props.node;
    if (!n || n.type !== 'wait') return;
    try {
      n.config = { ...(n.config || {}), condition: JSON.parse(v || '{}') };
    } catch {}
  },
});

const assertJson = computed({
  get() {
    const n = props.node;
    if (!n || n.type !== 'assert') return '';
    try {
      return JSON.stringify(n.config?.assert || {}, null, 2);
    } catch {
      return '';
    }
  },
  set(v: string) {
    const n = props.node;
    if (!n || n.type !== 'assert') return;
    try {
      n.config = { ...(n.config || {}), assert: JSON.parse(v || '{}') };
    } catch {}
  },
});

const ifJson = computed({
  get() {
    const n = props.node;
    if (!n || n.type !== 'if') return '';
    try {
      return JSON.stringify((n as any).config?.condition || {}, null, 2);
    } catch {
      return '';
    }
  },
  set(v: string) {
    const n = props.node;
    if (!n || n.type !== 'if') return;
    try {
      (n as any).config = { ...((n as any).config || {}), condition: JSON.parse(v || '{}') };
    } catch {}
  },
});

// --- if node helpers ---
const variables = computed(() => props.variables || []);
const ops = ['==', '!=', '>', '>=', '<', '<=', '&&', '||'];
const ifBranches = computed<any[]>({
  get() {
    const n = props.node as any;
    if (!n || n.type !== 'if') return [];
    if (!n.config) n.config = {};
    if (!Array.isArray(n.config.branches))
      n.config.branches = [
        { id: `c_${Math.random().toString(36).slice(2, 6)}`, name: '', expr: '' },
      ];
    return n.config.branches;
  },
  set(v: any[]) {
    const n = props.node as any;
    if (!n || n.type !== 'if') return;
    n.config.branches = v;
  },
});
const elseEnabled = computed({
  get() {
    const n = props.node as any;
    if (!n || n.type !== 'if') return true;
    return n.config?.else !== false;
  },
  set(v: boolean) {
    const n = props.node as any;
    if (!n || n.type !== 'if') return;
    n.config = { ...(n.config || {}), else: !!v };
  },
});
function addIfCase() {
  ifBranches.value = [
    ...ifBranches.value,
    { id: `c_${Math.random().toString(36).slice(2, 6)}`, name: '', expr: '' },
  ];
}
function removeIfCase(i: number) {
  const arr = [...ifBranches.value];
  if (arr.length <= 1) {
    arr[0] = arr[0] || { id: `c_${Math.random().toString(36).slice(2, 6)}` };
    arr[0].expr = '';
    arr[0].name = '';
    ifBranches.value = arr;
    return;
  }
  arr.splice(i, 1);
  ifBranches.value = arr;
}
function insertVar(key: string, idx: number) {
  if (!key) return;
  const arr = ifBranches.value;
  const c = arr[idx];
  if (!c) return;
  const token = `workflow.${key}`;
  c.expr = (c.expr ? c.expr + ' ' : '') + token;
}
function insertOp(op: string, idx: number) {
  if (!op) return;
  const arr = ifBranches.value;
  const c = arr[idx];
  if (!c) return;
  c.expr = (c.expr ? c.expr + ' ' : '') + op + ' ';
}

const whileJson = computed({
  get() {
    const n = props.node;
    if (!n || n.type !== 'while') return '';
    try {
      return JSON.stringify((n as any).config?.condition || {}, null, 2);
    } catch {
      return '';
    }
  },
  set(v: string) {
    const n = props.node;
    if (!n || n.type !== 'while') return;
    try {
      (n as any).config = { ...((n as any).config || {}), condition: JSON.parse(v || '{}') };
    } catch {}
  },
});

function onCreateSubflow() {
  const id = prompt('请输入新子流ID');
  if (!id) return;
  // Emit kebab-case event to match parent template listener
  emit('create-subflow', id);
  const n = props.node as any;
  if (n && n.config) n.config.subflowId = id;
}

const nodeErrors = computed(() => (props.node ? validateNodeWithRegistry(props.node) : []));
const extractErrors = computed(() => {
  const n = props.node;
  if (!n || n.type !== 'extract') return [] as string[];
  const errs: string[] = [];
  if (!n.config?.saveAs) errs.push('需填写保存变量名');
  if (!n.config?.selector && !n.config?.js) errs.push('需提供 selector 或 js');
  return errs;
});
const switchTabError = computed(() => {
  const n = props.node;
  if (!n || n.type !== 'switchTab') return false;
  return !(n.config?.tabId || n.config?.urlContains || n.config?.titleContains);
});

// retry helpers mapped into node.config.retry
const retryCount = computed(() => Number((props.node as any)?.config?.retry?.count ?? 0));
const retryInterval = computed(() => Number((props.node as any)?.config?.retry?.intervalMs ?? 0));
const retryBackoff = computed(() => String((props.node as any)?.config?.retry?.backoff ?? 'none'));
function ensureRetry() {
  const n = props.node;
  if (!n) return;
  if (!n.config) n.config = {};
  if (!n.config.retry) n.config.retry = { count: 0, intervalMs: 0, backoff: 'none' };
}
function onRetryCount(v: string) {
  const n = props.node as any;
  if (!n) return;
  ensureRetry();
  n.config.retry.count = Math.max(0, Number(v || 0));
}
function onRetryInterval(v: string) {
  const n = props.node as any;
  if (!n) return;
  ensureRetry();
  n.config.retry.intervalMs = Math.max(0, Number(v || 0));
}
function onRetryBackoff(v: string) {
  const n = props.node as any;
  if (!n) return;
  ensureRetry();
  n.config.retry.backoff = v === 'exp' ? 'exp' : 'none';
}

function swapCand(arr: any[], i: number, j: number) {
  if (j < 0 || j >= arr.length) return;
  const t = arr[i];
  arr[i] = arr[j];
  arr[j] = t;
}

// Element picker integration
async function ensurePickerInjected(tabId: number) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { action: 'chrome_read_page_ping' } as any);
    if (pong && pong.status === 'pong') return;
  } catch {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['inject-scripts/accessibility-tree-helper.js'],
      world: 'ISOLATED',
    } as any);
  } catch (e) {
    console.warn('inject picker helper failed:', e);
  }
}

async function pickFromPage() {
  try {
    if (!props.node) return;
    const t = props.node.type;
    if (t !== 'click' && t !== 'fill' && t !== 'triggerEvent' && t !== 'setAttribute') return;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if (typeof tabId !== 'number') return;
    await ensurePickerInjected(tabId);
    const resp: any = await chrome.tabs.sendMessage(tabId, { action: 'rr_picker_start' } as any);
    if (!resp || !resp.success) return;
    const n: any = props.node;
    if (!n.config) n.config = {};
    if (!n.config.target) n.config.target = { candidates: [] };
    if (!Array.isArray(n.config.target.candidates)) n.config.target.candidates = [];
    const arr = Array.isArray(resp.candidates) ? resp.candidates : [];
    const seen = new Set<string>();
    const merged: any[] = [];
    for (const c of arr) {
      if (!c || !c.type || !c.value) continue;
      const key = `${c.type}|${c.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({ type: String(c.type), value: String(c.value) });
      }
    }
    n.config.target.candidates = merged;
  } catch (e) {
    console.warn('pickFromPage failed:', e);
  }
}

// http json helpers
const headersJson = computed({
  get() {
    const n = props.node;
    if (!n || n.type !== 'http') return '';
    try {
      return JSON.stringify(n.config?.headers || {}, null, 2);
    } catch {
      return '';
    }
  },
  set(v: string) {
    const n = props.node;
    if (!n || n.type !== 'http') return;
    try {
      n.config.headers = JSON.parse(v || '{}');
    } catch {}
  },
});
const bodyJson = computed({
  get() {
    const n = props.node;
    if (!n || n.type !== 'http') return '';
    try {
      return JSON.stringify(n.config?.body ?? null, null, 2);
    } catch {
      return '';
    }
  },
  set(v: string) {
    const n = props.node;
    if (!n || n.type !== 'http') return;
    try {
      n.config.body = v ? JSON.parse(v) : null;
    } catch {}
  },
});

const formDataJson = computed({
  get() {
    const n = props.node;
    if (!n || n.type !== 'http') return '';
    try {
      return (n as any).config?.formData ? JSON.stringify((n as any).config.formData, null, 2) : '';
    } catch {
      return '';
    }
  },
  set(v: string) {
    const n = props.node;
    if (!n || n.type !== 'http') return;
    try {
      (n as any).config.formData = v ? JSON.parse(v) : undefined;
    } catch {}
  },
});

// script assign json helper
const scriptAssignJson = computed({
  get() {
    const n = props.node;
    if (!n || n.type !== 'script') return '';
    try {
      return JSON.stringify(n.config?.assign || {}, null, 2);
    } catch {
      return '';
    }
  },
  set(v: string) {
    const n = props.node;
    if (!n || n.type !== 'script') return;
    try {
      n.config.assign = JSON.parse(v || '{}');
    } catch {}
  },
});

// executeFlow args json
const execArgsJson = computed({
  get() {
    const n = props.node;
    if (!n || n.type !== 'executeFlow') return '';
    try {
      return JSON.stringify((n as any).config?.args || {}, null, 2);
    } catch {
      return '';
    }
  },
  set(v: string) {
    const n = props.node;
    if (!n || n.type !== 'executeFlow') return;
    try {
      (n as any).config.args = v ? JSON.parse(v) : {};
    } catch {}
  },
});

// flows for selection
type FlowLite = { id: string; name?: string };
const flows = ref<FlowLite[]>([]);
onMounted(async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: BACKGROUND_MESSAGE_TYPES.RR_LIST_FLOWS });
    if (res && res.success) flows.value = res.flows || [];
  } catch {}
});
// 高亮并滚动到指定字段
watch(
  () => props.highlightField,
  (field) => {
    if (!field) return;
    try {
      const root = (document?.querySelector?.('.panel') as HTMLElement) || null;
      const esc =
        (globalThis as any).CSS && typeof (globalThis as any).CSS.escape === 'function'
          ? (globalThis as any).CSS.escape(field)
          : String(field).replace(/["\\]/g, '\\$&');
      const el = (root || document).querySelector(`[data-field="${esc}"]`) as HTMLElement | null;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (el) {
        el.classList.add('hl');
        setTimeout(() => el.classList.remove('hl'), 1200);
      }
    } catch {}
  },
);

// Scrollbars remain hidden but content is scrollable; no runtime handling needed.
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
  /* Cap panel height to viewport to avoid overflow; scroll internally */
  max-height: calc(100vh - 72px);
  overflow-y: auto;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  flex-shrink: 0;
  /* Always hide scrollbars (Firefox), keep scrolling */
  scrollbar-width: none;
  scrollbar-color: rgba(0, 0, 0, 0.25) transparent;
}

/* 头部 */
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

/* 内容区 */
.panel-content {
  display: flex;
  flex-direction: column;
}

.panel-content :deep(.if-case-list) {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px;
}
.panel-content :deep(.if-case-item) {
  border: 1px solid var(--rr-border);
  background: var(--rr-card);
  border-radius: 8px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.panel-content :deep(.if-case-header) {
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel-content :deep(.if-case-expr) {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.panel-content :deep(.if-toolbar) {
  display: flex;
  gap: 8px;
}
.panel-content :deep(.if-case-else) {
  padding: 6px 12px;
  color: var(--rr-text-secondary);
}

/* 表单区域 */
.panel-content :deep(.form-section) {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 区域头部 */
.panel-content :deep(.section-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.panel-content :deep(.section-title) {
  font-size: 13px;
  font-weight: 600;
  color: var(--rr-text);
}

/* 表单组 */
.panel-content :deep(.form-group) {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.panel-content :deep(.form-label) {
  font-size: 13px;
  font-weight: 500;
  color: var(--rr-text-secondary);
}

/* 表单输入 */
.panel-content :deep(.form-input),
.panel-content :deep(.form-select),
.panel-content :deep(.form-textarea) {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--rr-border);
  border-radius: 8px;
  background: var(--rr-card);
  font-size: 14px;
  color: var(--rr-text);
  outline: none;
  transition: all 0.15s;
}
.panel-content :deep(.form-input:focus),
.panel-content :deep(.form-select:focus),
.panel-content :deep(.form-textarea:focus) {
  border-color: var(--rr-accent);
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.08);
}
.panel-content :deep(.form-input::placeholder),
.panel-content :deep(.form-textarea::placeholder) {
  color: var(--rr-text-weak);
}
.panel-content :deep(.form-textarea) {
  resize: vertical;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 13px;
  line-height: 1.5;
}
.panel-content :deep(.form-group.invalid .form-input),
.panel-content :deep(.form-group.invalid .form-select) {
  border-color: var(--rr-danger);
  background: rgba(239, 68, 68, 0.04);
}

/* Checkbox */
.panel-content :deep(.checkbox-group) {
  padding: 4px 0;
}
.panel-content :deep(.checkbox-label) {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 14px;
  color: var(--rr-text);
}
.panel-content :deep(.checkbox-label input[type='checkbox']) {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

/* 选择器列表 */
.panel-content :deep(.selector-list) {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.panel-content :deep(.selector-item) {
  display: grid;
  grid-template-columns: 100px 1fr auto auto auto;
  gap: 6px;
  align-items: center;
}
.panel-content :deep(.form-input-sm),
.panel-content :deep(.form-select-sm) {
  padding: 6px 10px;
  border: 1px solid var(--rr-border);
  border-radius: 6px;
  background: var(--rr-card);
  font-size: 13px;
  outline: none;
  transition: all 0.15s;
}
.panel-content :deep(.form-input-sm:focus),
.panel-content :deep(.form-select-sm:focus) {
  border-color: var(--rr-accent);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.08);
}
.flex-1 {
  flex: 1;
}

/* 按钮 */
.panel-content :deep(.btn-sm) {
  padding: 6px 12px;
  border: 1px solid var(--rr-border);
  background: var(--rr-card);
  color: var(--rr-text);
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}
.panel-content :deep(.btn-sm:hover) {
  background: var(--rr-hover);
  border-color: var(--rr-text-weak);
}
.panel-content :deep(.btn-sm.btn-primary) {
  background: var(--rr-accent);
  color: #fff;
  border-color: var(--rr-accent);
}
.panel-content :deep(.btn-sm.btn-primary:hover) {
  background: #2563eb;
  box-shadow: 0 2px 4px rgba(59, 130, 246, 0.2);
}
.panel-content :deep(.btn-icon-sm) {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--rr-border);
  background: var(--rr-card);
  color: var(--rr-text-secondary);
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
}
.panel-content :deep(.btn-icon-sm:hover:not(:disabled)) {
  background: var(--rr-hover);
  border-color: var(--rr-text-weak);
  color: var(--rr-text);
}
.panel-content :deep(.btn-icon-sm:disabled) {
  opacity: 0.4;
  cursor: not-allowed;
}
.panel-content :deep(.btn-icon-sm.danger:hover:not(:disabled)) {
  background: rgba(239, 68, 68, 0.08);
  border-color: rgba(239, 68, 68, 0.3);
  color: var(--rr-danger);
}

/* 分割线 */
.divider {
  height: 1px;
  background: var(--rr-border);
}

/* 错误提示 */
.error-box {
  margin: 0 20px 20px;
  padding: 12px;
  background: rgba(239, 68, 68, 0.06);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 8px;
}
.error-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--rr-danger);
  margin-bottom: 6px;
}
.error-item {
  font-size: 12px;
  color: var(--rr-danger);
  line-height: 1.5;
  margin: 4px 0;
}

/* 空状态 */
.panel-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
}
.empty-icon {
  color: var(--rr-text-weak);
  margin-bottom: 16px;
}
.empty-text {
  font-size: 14px;
  color: var(--rr-text-secondary);
  line-height: 1.6;
}

/* 高亮字段 */
.panel-content :where([data-field].hl) {
  outline: 2px solid var(--rr-warn);
  background: rgba(245, 158, 11, 0.08);
  border-radius: 6px;
  transition: all 0.3s ease;
}

/* Always hide scrollbar (WebKit/Blink); still scrollable */
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
