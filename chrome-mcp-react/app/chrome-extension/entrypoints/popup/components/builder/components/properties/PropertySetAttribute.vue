<template>
  <div>
    <SelectorEditor :node="node" :allowPick="true" />
    <div class="form-section">
      <div class="form-group">
        <label class="form-label">属性名</label>
        <input
          class="form-input"
          v-model="(node as any).config.name"
          placeholder="如 value/src/disabled 等"
        />
      </div>
      <div class="form-group">
        <label class="form-label">属性值（留空并勾选删除则移除）</label>
        <input class="form-input" v-model="(node as any).config.value" placeholder="属性值" />
      </div>
      <div class="form-group checkbox-group">
        <label class="checkbox-label"
          ><input type="checkbox" v-model="(node as any).config.remove" /> 删除属性</label
        >
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import type { NodeBase } from '@/entrypoints/background/record-replay/types';
import SelectorEditor from './SelectorEditor.vue';

defineProps<{ node: NodeBase }>();
</script>

<style scoped></style>
