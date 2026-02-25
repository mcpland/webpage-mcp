<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">文件名包含（可选）</label>
      <input
        class="form-input"
        v-model="(node as any).config.filenameContains"
        placeholder="子串匹配文件名或URL"
      />
    </div>
    <div class="form-group">
      <label class="form-label">超时(ms)</label>
      <input class="form-input" v-model="(node as any).config.timeoutMs" placeholder="默认 60000" />
    </div>
    <div class="form-group checkbox-group">
      <label class="checkbox-label"
        ><input type="checkbox" v-model="(node as any).config.waitForComplete" />
        等待下载完成</label
      >
    </div>
    <div class="form-group">
      <label class="form-label">保存到变量</label>
      <input class="form-input" v-model="(node as any).config.saveAs" placeholder="默认 download" />
    </div>
  </div>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import type { NodeBase } from '@/entrypoints/background/record-replay/types';
defineProps<{ node: NodeBase }>();
</script>

<style scoped></style>
