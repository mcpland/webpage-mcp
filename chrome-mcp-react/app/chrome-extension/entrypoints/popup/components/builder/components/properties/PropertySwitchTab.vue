<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">Tab ID（可选）</label>
      <input
        class="form-input"
        type="number"
        v-model.number="(node as any).config.tabId"
        placeholder="数字"
      />
    </div>
    <div class="form-group" :class="{ invalid: needOne && !hasAny }">
      <label class="form-label">URL 包含（可选）</label>
      <input class="form-input" v-model="(node as any).config.urlContains" placeholder="子串匹配" />
    </div>
    <div class="form-group" :class="{ invalid: needOne && !hasAny }">
      <label class="form-label">标题包含（可选）</label>
      <input
        class="form-input"
        v-model="(node as any).config.titleContains"
        placeholder="子串匹配"
      />
    </div>
    <div
      v-if="needOne && !hasAny"
      class="text-xs text-slate-500"
      style="padding: 0 20px; color: var(--rr-danger)"
      >需提供 tabId 或 URL/标题包含</div
    >
  </div>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import { computed } from 'vue';
import type { NodeBase } from '@/entrypoints/background/record-replay/types';

const props = defineProps<{ node: NodeBase }>();
const needOne = true;
const hasAny = computed(() => {
  const c: any = (props.node as any).config || {};
  return !!(c.tabId || c.urlContains || c.titleContains);
});
</script>

<style scoped></style>
