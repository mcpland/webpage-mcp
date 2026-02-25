<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">按 URL 包含匹配（优先）</label>
      <input
        class="form-input"
        v-model="(node as any).config.frame.urlContains"
        placeholder="frame URL 包含的字符串"
      />
    </div>
    <div class="form-group">
      <label class="form-label">按索引匹配（从 0 起，仅子 frame）</label>
      <input class="form-input" v-model="(node as any).config.frame.index" placeholder="索引数字" />
    </div>
    <div class="text-xs text-slate-500" style="padding: 0 20px"
      >同源/可注入 frame 可用；留空则回到顶级页面</div
    >
  </div>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import type { NodeBase } from '@/entrypoints/background/record-replay/types';
defineProps<{ node: NodeBase }>();
</script>

<style scoped></style>
