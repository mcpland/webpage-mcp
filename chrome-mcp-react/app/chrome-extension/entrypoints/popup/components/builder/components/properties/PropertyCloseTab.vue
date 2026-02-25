<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">按 URL 关闭（可选）</label>
      <input class="form-input" v-model="(node as any).config.url" placeholder="子串匹配 URL" />
    </div>
    <div class="form-group">
      <label class="form-label">Tab IDs（JSON 数组，可选）</label>
      <textarea class="form-textarea" v-model="tabIdsJson" rows="2" placeholder="[1,2]"></textarea>
    </div>
  </div>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import { computed } from 'vue';
import type { NodeBase } from '@/entrypoints/background/record-replay/types';

const props = defineProps<{ node: NodeBase }>();

const tabIdsJson = computed({
  get() {
    try {
      const arr = (props.node as any).config?.tabIds;
      return Array.isArray(arr) ? JSON.stringify(arr) : '';
    } catch {
      return '';
    }
  },
  set(v: string) {
    try {
      (props.node as any).config.tabIds = v ? JSON.parse(v) : [];
    } catch {}
  },
});
</script>

<style scoped></style>
