<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">列表变量</label>
      <input
        class="form-input"
        v-model="(node as any).config.listVar"
        placeholder="workflow.list"
      />
    </div>
    <div class="form-group">
      <label class="form-label">循环项变量名</label>
      <input class="form-input" v-model="(node as any).config.itemVar" placeholder="默认 item" />
    </div>
    <div class="form-group">
      <label class="form-label">子流 ID</label>
      <input
        class="form-input"
        v-model="(node as any).config.subflowId"
        placeholder="选择或新建子流"
      />
      <button class="btn-sm" style="margin-top: 8px" @click="onCreateSubflow">新建子流</button>
    </div>
  </div>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import type { NodeBase } from '@/entrypoints/background/record-replay/types';

const props = defineProps<{ node: NodeBase }>();
const emit = defineEmits<{ (e: 'create-subflow', id: string): void }>();

function onCreateSubflow() {
  const id = prompt('请输入新子流ID');
  if (!id) return;
  emit('create-subflow', id);
  const n = props.node as any;
  if (n && n.config) n.config.subflowId = id;
}
</script>

<style scoped></style>
