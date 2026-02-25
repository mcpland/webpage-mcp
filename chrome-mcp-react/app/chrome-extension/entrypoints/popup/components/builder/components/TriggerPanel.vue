/** * @fileoverview Trigger Panel Component for Builder * @description * A floating panel for
managing V3 triggers in the Builder interface. * * Features: * - Lists all triggers for the current
flow * - Enable/disable toggle for all trigger types * - Create/edit/delete for panel-managed
triggers (interval, once) * - Manual trigger support for 'manual' type triggers * * Ownership model:
* - Node-managed triggers (ID prefix: trg_/sch_): Created by trigger node sync, read-only in panel *
- Panel-managed triggers (interval, once): Full CRUD in panel */
<template>
  <aside class="trigger-panel">
    <div class="panel-header">
      <div class="header-left">
        <div class="header-title">Triggers</div>
        <div class="header-sub">{{ flowId }}</div>
      </div>
      <div class="header-right">
        <button class="btn-sm" type="button" :disabled="loading" @click="refresh"> Refresh </button>
        <button class="btn-close" type="button" title="Close" @click="emit('close')">
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
    </div>

    <div class="panel-content">
      <!-- Create Section (interval/once only) -->
      <div class="form-section">
        <div class="section-header">
          <div class="section-title">Add Trigger</div>
          <div class="section-actions">
            <button class="btn-sm" type="button" @click="openCreate('interval')">+ Interval</button>
            <button class="btn-sm" type="button" @click="openCreate('once')">+ Once</button>
          </div>
        </div>
        <div class="hint">
          Other types (url/cron/command/contextMenu/dom) are configured via trigger nodes.
        </div>
      </div>

      <div class="divider"></div>

      <!-- Trigger List -->
      <div class="form-section">
        <div class="section-header">
          <div class="section-title">Current Triggers ({{ triggers.length }})</div>
        </div>

        <div v-if="loading" class="muted">Loading...</div>
        <div v-else-if="triggers.length === 0" class="muted">No triggers configured</div>

        <div v-else class="trigger-list">
          <div v-for="trigger in sortedTriggers" :key="trigger.id" class="trigger-row">
            <div class="trigger-main">
              <div class="trigger-top">
                <span class="badge" :data-kind="trigger.kind">{{ trigger.kind }}</span>
                <span class="trigger-id">{{ trigger.id }}</span>
                <span
                  v-if="ownerOf(trigger) !== 'panel'"
                  class="ownership"
                  :data-owner="ownerOf(trigger)"
                >
                  {{ ownerLabel(ownerOf(trigger)) }}
                </span>
              </div>
              <div class="trigger-desc">{{ describeTrigger(trigger) }}</div>
            </div>

            <div class="trigger-actions">
              <label
                class="toggle"
                :class="{ readonly: ownerOf(trigger) === 'triggerNode' }"
                :title="
                  ownerOf(trigger) === 'triggerNode' ? 'Edit via trigger node in Builder' : ''
                "
              >
                <input
                  type="checkbox"
                  :checked="trigger.enabled"
                  :disabled="busyIds[trigger.id] || ownerOf(trigger) === 'triggerNode'"
                  @change="onToggleEnabled(trigger, ($event.target as HTMLInputElement).checked)"
                />
                <span>Enabled</span>
              </label>

              <button
                v-if="trigger.kind === 'manual'"
                class="btn-sm btn-primary"
                type="button"
                :disabled="busyIds[trigger.id] || !trigger.enabled"
                @click="fireManual(trigger)"
              >
                Fire
              </button>

              <template v-if="isPanelManaged(trigger)">
                <button
                  class="btn-icon-sm"
                  type="button"
                  title="Edit"
                  :disabled="busyIds[trigger.id]"
                  @click="openEdit(trigger)"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
                  </svg>
                </button>
                <button
                  class="btn-icon-sm danger"
                  type="button"
                  title="Delete"
                  :disabled="busyIds[trigger.id]"
                  @click="removePanelTrigger(trigger)"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <path
                      d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"
                    />
                  </svg>
                </button>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Editor Modal -->
    <div v-if="editorOpen" class="rr-modal" @click.self="closeEditor">
      <div class="rr-dialog small">
        <div class="rr-header">
          <div class="title">{{ editorTitle }}</div>
          <button class="close" type="button" @click="closeEditor">
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
        <div class="rr-body">
          <div class="form-group">
            <label class="form-label">Type</label>
            <select class="form-select" v-model="editorKind" :disabled="editorMode === 'edit'">
              <option value="interval">interval</option>
              <option value="once">once</option>
            </select>
          </div>
          <div class="form-group checkbox-group">
            <label class="checkbox-label">
              <input type="checkbox" v-model="editorEnabled" />
              <span>Enabled</span>
            </label>
          </div>

          <template v-if="editorKind === 'interval'">
            <div class="form-group">
              <label class="form-label">Interval (minutes)</label>
              <input
                class="form-input"
                type="number"
                min="1"
                step="1"
                v-model.number="editorPeriodMinutes"
              />
            </div>
            <div class="hint">Uses chrome.alarms.periodInMinutes for repeating triggers.</div>
          </template>

          <template v-else>
            <div class="form-group">
              <label class="form-label">Trigger Time</label>
              <input class="form-input" type="datetime-local" v-model="editorWhenLocal" />
            </div>
            <div class="hint"> Will auto-disable after firing. Time is in local timezone. </div>
          </template>
        </div>
        <div class="rr-footer">
          <button class="btn-cancel" type="button" @click="closeEditor">Cancel</button>
          <button class="btn-primary" type="button" :disabled="editorSaving" @click="submitEditor">
            Save
          </button>
        </div>
      </div>
    </div>
  </aside>
</template>

<script lang="ts" setup>
import { computed, ref, watch } from 'vue';

import type { FlowId, TriggerId } from '@/entrypoints/background/record-replay-v3/domain/ids';
import type { JsonObject } from '@/entrypoints/background/record-replay-v3/domain/json';
import type { TriggerSpec } from '@/entrypoints/background/record-replay-v3/domain/triggers';
import { useRRV3Rpc } from '@/entrypoints/shared/composables';
import { toast } from '@/entrypoints/popup/components/builder/model/toast';

// ==================== Types ====================

type PanelEditableKind = 'interval' | 'once';
type TriggerOwner = 'panel' | 'triggerNode' | 'external';

// ==================== Props & Emits ====================

const props = defineProps<{
  flowId: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

defineOptions({ name: 'TriggerPanel' });

// ==================== RPC & State ====================

const rpc = useRRV3Rpc({ autoConnect: true });

const loading = ref(false);
const triggers = ref<TriggerSpec[]>([]);
const busyIds = ref<Record<string, boolean>>({});

const sortedTriggers = computed(() => {
  return [...triggers.value].sort((a, b) => {
    const kindOrder = a.kind.localeCompare(b.kind);
    if (kindOrder !== 0) return kindOrder;
    return a.id.localeCompare(b.id);
  });
});

// ==================== Editor State ====================

const editorOpen = ref(false);
const editorSaving = ref(false);
const editorMode = ref<'create' | 'edit'>('create');
const editorKind = ref<PanelEditableKind>('interval');
const editorEditingId = ref<TriggerId | null>(null);
const editorEnabled = ref(true);
const editorPeriodMinutes = ref(5);
const editorWhenLocal = ref('');

const editorTitle = computed(() => {
  const mode = editorMode.value === 'create' ? 'Create' : 'Edit';
  return `${mode} ${editorKind.value} Trigger`;
});

// ==================== Utilities ====================

function setBusy(triggerId: string, value: boolean): void {
  busyIds.value = { ...busyIds.value, [triggerId]: value };
}

function formatLocalDateTime(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return String(ms);
  return date.toLocaleString();
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function unixMsToDatetimeLocal(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function datetimeLocalToUnixMs(value: string): number | null {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match;
  const date = new Date(
    Number(yearStr),
    Number(monthStr) - 1,
    Number(dayStr),
    Number(hourStr),
    Number(minuteStr),
    Number(secondStr || 0),
    0,
  );
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

// ==================== Trigger Ownership ====================

function isPanelManaged(trigger: TriggerSpec): boolean {
  return trigger.kind === 'interval' || trigger.kind === 'once';
}

function ownerOf(trigger: TriggerSpec): TriggerOwner {
  const flowId = String(props.flowId || '');
  const trigPrefix = `trg_${flowId}_`;
  const schPrefix = `sch_${flowId}_`;

  if (trigger.id.startsWith(trigPrefix) || trigger.id.startsWith(schPrefix)) {
    return 'triggerNode';
  }
  if (isPanelManaged(trigger)) {
    return 'panel';
  }
  return 'external';
}

function ownerLabel(owner: TriggerOwner): string {
  switch (owner) {
    case 'triggerNode':
      return 'via trigger node';
    case 'external':
      return 'external';
    default:
      return '';
  }
}

// ==================== Trigger Description ====================

function describeTrigger(trigger: TriggerSpec): string {
  switch (trigger.kind) {
    case 'url': {
      const spec = trigger as Extract<TriggerSpec, { kind: 'url' }>;
      const rules = spec.match || [];
      return `URL match rules: ${rules.length}`;
    }
    case 'cron': {
      const spec = trigger as Extract<TriggerSpec, { kind: 'cron' }>;
      return spec.timezone ? `cron: ${spec.cron} (${spec.timezone})` : `cron: ${spec.cron}`;
    }
    case 'interval': {
      const spec = trigger as Extract<TriggerSpec, { kind: 'interval' }>;
      return `Every ${spec.periodMinutes} minute(s)`;
    }
    case 'once': {
      const spec = trigger as Extract<TriggerSpec, { kind: 'once' }>;
      return `At ${formatLocalDateTime(Number(spec.whenMs))}`;
    }
    case 'command': {
      const spec = trigger as Extract<TriggerSpec, { kind: 'command' }>;
      return `commandKey: ${spec.commandKey}`;
    }
    case 'contextMenu': {
      const spec = trigger as Extract<TriggerSpec, { kind: 'contextMenu' }>;
      return `title: ${spec.title}`;
    }
    case 'dom': {
      const spec = trigger as Extract<TriggerSpec, { kind: 'dom' }>;
      return `selector: ${spec.selector}`;
    }
    case 'manual':
      return 'Manual trigger (fire via button)';
    default:
      return '';
  }
}

// ==================== Data Actions ====================

async function refresh(): Promise<void> {
  const flowId = String(props.flowId || '').trim();
  if (!flowId) return;

  loading.value = true;
  try {
    await rpc.ensureConnected();
    const result = (await rpc.request('rr_v3.listTriggers', {
      flowId: flowId as FlowId,
    })) as TriggerSpec[] | null;
    triggers.value = Array.isArray(result) ? result : [];
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    loading.value = false;
  }
}

async function onToggleEnabled(trigger: TriggerSpec, enabled: boolean): Promise<void> {
  if (busyIds.value[trigger.id]) return;
  setBusy(trigger.id, true);

  try {
    // Node-managed triggers have toggle disabled, so this only applies to panel-managed
    await rpc.ensureConnected();
    const method = enabled ? 'rr_v3.enableTrigger' : 'rr_v3.disableTrigger';
    await rpc.request(method, { triggerId: trigger.id as TriggerId });
    await refresh();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    setBusy(trigger.id, false);
  }
}

async function fireManual(trigger: TriggerSpec): Promise<void> {
  if (trigger.kind !== 'manual') return;
  if (busyIds.value[trigger.id]) return;
  setBusy(trigger.id, true);

  try {
    await rpc.ensureConnected();
    const result = (await rpc.request('rr_v3.fireTrigger', {
      triggerId: trigger.id as TriggerId,
    })) as { runId?: string } | null;
    toast(`Triggered: ${result?.runId ?? 'run enqueued'}`, 'info');
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    setBusy(trigger.id, false);
  }
}

// ==================== Editor Actions ====================

function openCreate(kind: PanelEditableKind): void {
  editorMode.value = 'create';
  editorKind.value = kind;
  editorEditingId.value = null;
  editorEnabled.value = true;
  editorPeriodMinutes.value = 5;
  editorWhenLocal.value = unixMsToDatetimeLocal(Date.now() + 5 * 60 * 1000);
  editorOpen.value = true;
}

function openEdit(trigger: TriggerSpec): void {
  if (!isPanelManaged(trigger)) return;
  editorMode.value = 'edit';
  editorKind.value = trigger.kind as PanelEditableKind;
  editorEditingId.value = trigger.id as TriggerId;
  editorEnabled.value = !!trigger.enabled;

  if (trigger.kind === 'interval') {
    const spec = trigger as Extract<TriggerSpec, { kind: 'interval' }>;
    editorPeriodMinutes.value = Number(spec.periodMinutes) || 1;
  } else {
    const spec = trigger as Extract<TriggerSpec, { kind: 'once' }>;
    editorWhenLocal.value = unixMsToDatetimeLocal(Number(spec.whenMs));
  }
  editorOpen.value = true;
}

function closeEditor(): void {
  if (editorSaving.value) return;
  editorOpen.value = false;
}

async function submitEditor(): Promise<void> {
  if (editorSaving.value) return;

  const flowId = String(props.flowId || '').trim();
  if (!flowId) {
    toast('Flow ID is empty', 'error');
    return;
  }

  editorSaving.value = true;
  try {
    await rpc.ensureConnected();

    let payload: Record<string, unknown>;

    if (editorKind.value === 'interval') {
      const periodMinutes = Math.max(1, Math.floor(Number(editorPeriodMinutes.value || 1)));
      payload = {
        kind: 'interval',
        enabled: !!editorEnabled.value,
        flowId: flowId as FlowId,
        periodMinutes,
      };
      if (editorEditingId.value) {
        payload.id = editorEditingId.value;
      }
    } else {
      const whenMs = datetimeLocalToUnixMs(editorWhenLocal.value);
      if (whenMs === null) {
        toast('Invalid trigger time format', 'error');
        return;
      }
      if (whenMs < Date.now()) {
        toast('Trigger time is in the past. It may fire immediately.', 'warn');
      }
      payload = {
        kind: 'once',
        enabled: !!editorEnabled.value,
        flowId: flowId as FlowId,
        whenMs,
      };
      if (editorEditingId.value) {
        payload.id = editorEditingId.value;
      }
    }

    if (editorMode.value === 'create') {
      await rpc.request('rr_v3.createTrigger', { trigger: payload as unknown as JsonObject });
    } else {
      await rpc.request('rr_v3.updateTrigger', { trigger: payload as unknown as JsonObject });
    }

    editorOpen.value = false;
    await refresh();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    editorSaving.value = false;
  }
}

async function removePanelTrigger(trigger: TriggerSpec): Promise<void> {
  if (!isPanelManaged(trigger)) return;

  const confirmed = confirm(`Delete trigger?\n\n${trigger.id}`);
  if (!confirmed) return;

  if (busyIds.value[trigger.id]) return;
  setBusy(trigger.id, true);

  try {
    await rpc.ensureConnected();
    await rpc.request('rr_v3.deleteTrigger', { triggerId: trigger.id });
    await refresh();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'error');
  } finally {
    setBusy(trigger.id, false);
  }
}

// ==================== Lifecycle ====================

watch(
  () => props.flowId,
  () => {
    void refresh();
  },
  { immediate: true },
);
</script>

<style scoped>
.trigger-panel {
  background: var(--rr-card);
  border: 1px solid var(--rr-border);
  border-radius: 16px;
  margin: 16px;
  padding: 0;
  width: 420px;
  max-height: calc(100vh - 72px);
  overflow-y: auto;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  scrollbar-width: none;
}
.trigger-panel::-webkit-scrollbar {
  width: 0;
  height: 0;
}

/* Header */
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
.header-sub {
  font-size: 11px;
  color: var(--rr-text-weak);
  font-family: 'Monaco', monospace;
  opacity: 0.7;
  word-break: break-all;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--rr-border);
  background: var(--rr-card);
  color: var(--rr-text-secondary);
  border-radius: 6px;
  cursor: pointer;
}
.btn-close:hover {
  background: var(--rr-hover);
  border-color: var(--rr-text-weak);
  color: var(--rr-text);
}

/* Content */
.panel-content {
  display: flex;
  flex-direction: column;
}

.form-section {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--rr-text);
}
.section-actions {
  display: flex;
  gap: 8px;
}

.hint {
  font-size: 12px;
  color: var(--rr-text-weak);
  line-height: 1.5;
}
.muted {
  font-size: 12px;
  color: var(--rr-text-weak);
}
.divider {
  height: 1px;
  background: var(--rr-border);
}

/* Trigger List */
.trigger-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.trigger-row {
  border: 1px solid var(--rr-border);
  border-radius: 10px;
  padding: 10px 12px;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  align-items: start;
}
.trigger-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(59, 130, 246, 0.12);
  color: var(--rr-text);
}
.trigger-id {
  font-size: 11px;
  color: var(--rr-text-weak);
  font-family: 'Monaco', monospace;
  opacity: 0.85;
  word-break: break-all;
}
.ownership {
  font-size: 11px;
  color: var(--rr-text-weak);
  padding: 2px 6px;
  border: 1px dashed var(--rr-border);
  border-radius: 999px;
}
.trigger-desc {
  margin-top: 6px;
  font-size: 12px;
  color: var(--rr-text-secondary);
  line-height: 1.5;
  word-break: break-word;
}

.trigger-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--rr-text-secondary);
  user-select: none;
}
.toggle input {
  width: 16px;
  height: 16px;
}
.toggle.readonly {
  opacity: 0.6;
  cursor: not-allowed;
}
.toggle.readonly input {
  cursor: not-allowed;
}

/* Buttons */
.btn-sm {
  padding: 6px 10px;
  border: 1px solid var(--rr-border);
  background: var(--rr-card);
  color: var(--rr-text);
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}
.btn-sm:hover:not(:disabled) {
  background: var(--rr-hover);
  border-color: var(--rr-text-weak);
}
.btn-sm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-sm.btn-primary {
  background: var(--rr-accent);
  color: #fff;
  border-color: var(--rr-accent);
}
.btn-sm.btn-primary:hover:not(:disabled) {
  background: #2563eb;
}

.btn-icon-sm {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--rr-border);
  background: var(--rr-card);
  color: var(--rr-text-secondary);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s;
}
.btn-icon-sm:hover:not(:disabled) {
  background: var(--rr-hover);
  border-color: var(--rr-text-weak);
  color: var(--rr-text);
}
.btn-icon-sm.danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.08);
  border-color: rgba(239, 68, 68, 0.3);
  color: var(--rr-danger);
}
.btn-icon-sm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Modal */
.rr-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.rr-dialog {
  background: var(--rr-card);
  border-radius: 12px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
  min-width: 360px;
  max-width: 90vw;
}
.rr-dialog.small {
  min-width: 320px;
}
.rr-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--rr-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.rr-header .title {
  font-size: 15px;
  font-weight: 600;
  color: var(--rr-text);
}
.rr-header .close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--rr-text-secondary);
  border-radius: 6px;
  cursor: pointer;
}
.rr-header .close:hover {
  background: var(--rr-hover);
  color: var(--rr-text);
}
.rr-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rr-footer {
  padding: 16px 20px;
  border-top: 1px solid var(--rr-border);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* Form Elements */
.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.form-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--rr-text-secondary);
}
.form-input,
.form-select {
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
.form-input:focus,
.form-select:focus {
  border-color: var(--rr-accent);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.1);
}
.checkbox-group {
  flex-direction: row;
  align-items: center;
}
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--rr-text);
  cursor: pointer;
}
.checkbox-label input {
  width: 16px;
  height: 16px;
}

.btn-cancel {
  padding: 8px 16px;
  border: 1px solid var(--rr-border);
  background: var(--rr-card);
  color: var(--rr-text);
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.btn-cancel:hover {
  background: var(--rr-hover);
}
.btn-primary {
  padding: 8px 16px;
  border: none;
  background: var(--rr-accent);
  color: #fff;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.btn-primary:hover:not(:disabled) {
  background: #2563eb;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
