<template>
  <div class="kve">
    <div v-for="(item, i) in rows" :key="i" class="kve-row">
      <input class="kve-key" v-model="item.k" placeholder="变量名" />
      <input class="kve-val" v-model="item.v" placeholder="结果路径（如 data.items[0].id）" />
      <button class="mini" @click="move(i, -1)" :disabled="i === 0">↑</button>
      <button class="mini" @click="move(i, 1)" :disabled="i === rows.length - 1">↓</button>
      <button class="mini danger" @click="remove(i)">删</button>
    </div>
    <button class="mini" @click="add">添加映射</button>
  </div>
</template>

<script lang="ts" setup>
import { watch, reactive } from 'vue';

const props = defineProps<{ modelValue: Record<string, string> | undefined }>();
const emit = defineEmits(['update:modelValue']);

const rows = reactive<Array<{ k: string; v: string }>>([]);

function syncFromModel() {
  rows.splice(0, rows.length);
  const obj = props.modelValue || {};
  for (const [k, v] of Object.entries(obj)) rows.push({ k, v: String(v) });
}
function syncToModel() {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.k) out[r.k] = r.v || '';
  emit('update:modelValue', out);
}
watch(() => props.modelValue, syncFromModel, { immediate: true, deep: true });
watch(rows, syncToModel, { deep: true });

function add() {
  rows.push({ k: '', v: '' });
}
function remove(i: number) {
  rows.splice(i, 1);
}
function move(i: number, d: number) {
  const j = i + d;
  if (j < 0 || j >= rows.length) return;
  const t = rows[i];
  rows[i] = rows[j];
  rows[j] = t;
}
</script>

<style scoped>
.kve {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.kve-row {
  display: grid;
  grid-template-columns: 160px 1fr auto auto auto;
  gap: 6px;
  align-items: center;
}
.kve-key,
.kve-val {
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 6px;
}
.mini {
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid #d1d5db;
  background: #fff;
  border-radius: 6px;
  cursor: pointer;
}
.mini.danger {
  background: #fee2e2;
  border-color: #fecaca;
}
</style>
