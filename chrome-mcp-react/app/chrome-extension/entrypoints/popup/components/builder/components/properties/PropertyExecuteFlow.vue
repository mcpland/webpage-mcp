<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">目标工作流</label>
      <select class="form-select" v-model="(node as any).config.flowId">
        <option value="">请选择</option>
        <option v-for="f in flows" :key="f.id" :value="f.id">{{ f.name || f.id }}</option>
      </select>
    </div>
    <div class="form-group checkbox-group">
      <label class="checkbox-label"
        ><input type="checkbox" v-model="(node as any).config.inline" />
        内联执行（共享上下文变量）</label
      >
    </div>
    <div class="form-group">
      <label class="form-label">传参 (JSON)</label>
      <textarea
        class="form-textarea"
        v-model="execArgsJson"
        rows="3"
        placeholder='{"k": "v"}'
      ></textarea>
    </div>
  </div>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import { computed, onMounted, ref } from 'vue';
import type { NodeBase } from '@/entrypoints/background/record-replay/types';
import { BACKGROUND_MESSAGE_TYPES } from '@/common/message-types';

const props = defineProps<{ node: NodeBase }>();

type FlowLite = { id: string; name?: string };
const flows = ref<FlowLite[]>([]);
onMounted(async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: BACKGROUND_MESSAGE_TYPES.RR_LIST_FLOWS });
    if (res && res.success) flows.value = res.flows || [];
  } catch {}
});

const execArgsJson = computed({
  get() {
    try {
      return JSON.stringify((props.node as any).config?.args || {}, null, 2);
    } catch {
      return '';
    }
  },
  set(v: string) {
    try {
      (props.node as any).config.args = v ? JSON.parse(v) : {};
    } catch {}
  },
});
</script>

<style scoped></style>
