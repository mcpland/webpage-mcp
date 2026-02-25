<template>
  <div v-if="visible" class="rr-modal">
    <div class="rr-dialog">
      <div class="rr-header">
        <div class="title">定时执行</div>
        <button class="close" @click="$emit('close')">✕</button>
      </div>
      <div class="rr-body">
        <div class="row">
          <label>启用</label>
          <label class="chk"><input type="checkbox" v-model="enabled" />启用定时</label>
        </div>
        <div class="row">
          <label>类型</label>
          <select v-model="type">
            <option value="interval">每隔 N 分钟</option>
            <option value="daily">每天固定时间</option>
            <option value="once">只执行一次</option>
          </select>
        </div>
        <div class="row" v-if="type === 'interval'">
          <label>间隔(分钟)</label>
          <input type="number" v-model.number="intervalMinutes" />
        </div>
        <div class="row" v-if="type === 'daily'">
          <label>时间(HH:mm)</label>
          <input v-model="dailyTime" placeholder="例如 09:30" />
        </div>
        <div class="row" v-if="type === 'once'">
          <label>时间(ISO)</label>
          <input v-model="onceAt" placeholder="例如 2025-10-05T10:00:00" />
        </div>
        <div class="row">
          <label>参数(JSON)</label>
          <textarea v-model="argsJson" placeholder='{ "username": "xx" }'></textarea>
        </div>
        <div class="section">
          <div class="section-title">已有计划</div>
          <div class="sched-list">
            <div class="sched-row" v-for="s in schedules" :key="s.id">
              <div class="meta">
                <span class="badge" :class="{ on: s.enabled, off: !s.enabled }">{{ s.type }}</span>
                <span class="desc">{{ describe(s) }}</span>
              </div>
              <div class="actions">
                <button class="small danger" @click="$emit('remove', s.id)">删除</button>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="rr-footer">
        <button class="primary" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, watch } from 'vue';

const props = defineProps<{ visible: boolean; flowId: string | null; schedules: any[] }>();
const emit = defineEmits(['close', 'save', 'remove']);

const enabled = ref(true);
const type = ref<'interval' | 'daily' | 'once'>('interval');
const intervalMinutes = ref(30);
const dailyTime = ref('09:00');
const onceAt = ref('');
const argsJson = ref('');

watch(
  () => props.visible,
  (v) => {
    if (v) {
      enabled.value = true;
      type.value = 'interval';
      intervalMinutes.value = 30;
      dailyTime.value = '09:00';
      onceAt.value = '';
      argsJson.value = '';
    }
  },
);

function save() {
  if (!props.flowId) return;
  const schedule = {
    id: `sch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    flowId: props.flowId,
    type: type.value,
    enabled: enabled.value,
    when:
      type.value === 'interval'
        ? String(intervalMinutes.value)
        : type.value === 'daily'
          ? dailyTime.value
          : onceAt.value,
    args: safeParse(argsJson.value),
  } as any;
  emit('save', schedule);
}

function safeParse(s: string) {
  if (!s || !s.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function describe(s: any) {
  if (s.type === 'interval') return `每 ${s.when} 分钟`;
  if (s.type === 'daily') return `每天 ${s.when}`;
  if (s.type === 'once') return `一次 ${s.when}`;
  return '';
}
</script>

<style scoped>
.rr-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 2147483646;
  display: flex;
  align-items: center;
  justify-content: center;
}
.rr-dialog {
  background: #fff;
  border-radius: 8px;
  max-width: 720px;
  width: 96vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}
.rr-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #e5e7eb;
}
.rr-header .title {
  font-weight: 600;
}
.rr-header .close {
  border: none;
  background: #f3f4f6;
  border-radius: 6px;
  padding: 4px 8px;
  cursor: pointer;
}
.rr-body {
  padding: 12px 16px;
  overflow: auto;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 6px 0;
}
.row > label {
  width: 120px;
  color: #374151;
}
.row > input,
.row > textarea,
.row > select {
  flex: 1;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 6px 8px;
}
.row > textarea {
  min-height: 64px;
}
.chk {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.sched-list .sched-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 8px;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  margin: 4px 0;
}
.badge {
  padding: 2px 6px;
  border-radius: 6px;
  background: #e5e7eb;
}
.badge.on {
  background: #dcfce7;
}
.badge.off {
  background: #fee2e2;
}
.small {
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid #d1d5db;
  background: #fff;
  border-radius: 6px;
  cursor: pointer;
}
.danger {
  background: #fee2e2;
  border-color: #fecaca;
}
.primary {
  background: #111;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  cursor: pointer;
}
.rr-footer {
  padding: 12px 16px;
  border-top: 1px solid #e5e7eb;
  display: flex;
  justify-content: flex-end;
}
</style>
