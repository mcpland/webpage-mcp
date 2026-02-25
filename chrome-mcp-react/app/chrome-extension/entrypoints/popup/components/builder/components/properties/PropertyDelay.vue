<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">延迟 (ms)</label>
      <input class="form-input" type="number" v-model.number="(node as any).config.ms" min="0" />
    </div>
  </div>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import type { NodeBase } from '@/entrypoints/background/record-replay/types';
defineProps<{ node: NodeBase }>();
</script>

<style scoped></style>
