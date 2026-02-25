<template>
  <div class="form-section">
    <div class="form-group" data-field="navigate.url">
      <label class="form-label">URL 地址</label>
      <input
        class="form-input"
        v-model="(node as any).config.url"
        placeholder="https://example.com"
      />
    </div>
  </div>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import type { NodeBase } from '@/entrypoints/background/record-replay/types';
defineProps<{ node: NodeBase }>();
</script>

<style scoped></style>
