<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">元素选择器（可选）</label>
      <input
        class="form-input"
        v-model="(node as any).config.selector"
        placeholder="为空则截取可视区或全页"
      />
    </div>
    <div class="form-group checkbox-group">
      <label class="checkbox-label"
        ><input type="checkbox" v-model="(node as any).config.fullPage" /> 全页截图</label
      >
    </div>
    <div class="form-group">
      <label class="form-label">保存为变量</label>
      <input
        class="form-input"
        v-model="(node as any).config.saveAs"
        placeholder="变量名，例如 shot"
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
