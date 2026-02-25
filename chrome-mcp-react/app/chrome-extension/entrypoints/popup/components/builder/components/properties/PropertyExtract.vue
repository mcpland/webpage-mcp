<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">元素选择器（可选）</label>
      <input class="form-input" v-model="(node as any).config.selector" placeholder="CSS 选择器" />
    </div>
    <div class="form-group">
      <label class="form-label">属性</label>
      <input
        class="form-input"
        v-model="(node as any).config.attr"
        placeholder="text/textContent 或属性名"
      />
    </div>
    <div class="form-group">
      <label class="form-label">自定义 JS（返回值）</label>
      <textarea
        class="form-textarea"
        v-model="(node as any).config.js"
        rows="3"
        placeholder="return document.title"
      ></textarea>
    </div>
    <div class="form-group" :class="{ invalid: !(node as any).config?.saveAs }">
      <label class="form-label">保存为变量</label>
      <input class="form-input" v-model="(node as any).config.saveAs" placeholder="变量名" />
    </div>
  </div>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import type { NodeBase } from '@/entrypoints/background/record-replay/types';
defineProps<{ node: NodeBase }>();
</script>

<style scoped></style>
