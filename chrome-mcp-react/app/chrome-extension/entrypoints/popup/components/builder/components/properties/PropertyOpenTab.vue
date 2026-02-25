<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">URL 地址（可选）</label>
      <input
        class="form-input"
        v-model="(node as any).config.url"
        placeholder="https://example.com"
      />
    </div>
    <div class="form-group checkbox-group">
      <label class="checkbox-label"
        ><input type="checkbox" v-model="(node as any).config.newWindow" /> 新窗口</label
      >
    </div>
  </div>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import type { NodeBase } from '@/entrypoints/background/record-replay/types';
defineProps<{ node: NodeBase }>();
</script>

<style scoped></style>
