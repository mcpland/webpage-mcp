<template>
  <div>
    <SelectorEditor :node="node" :allowPick="true" />
    <div class="form-section">
      <div class="form-group">
        <label class="form-label">事件类型</label>
        <input
          class="form-input"
          v-model="(node as any).config.event"
          placeholder="如 input/change/mouseover"
        />
      </div>
      <div class="form-group checkbox-group">
        <label class="checkbox-label"
          ><input type="checkbox" v-model="(node as any).config.bubbles" /> 冒泡</label
        >
        <label class="checkbox-label"
          ><input type="checkbox" v-model="(node as any).config.cancelable" /> 可取消</label
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
