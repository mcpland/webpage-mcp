<template>
  <div>
    <SelectorEditor :node="node" :allowPick="true" />
    <div class="form-section">
      <div class="form-group" data-field="fill.value">
        <label class="form-label">输入值</label>
        <VarInput v-model="value" :variables="variables" placeholder="支持 {变量名} 格式" />
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import { computed } from 'vue';
import type { NodeBase } from '@/entrypoints/background/record-replay/types';
import type { VariableOption } from '@/entrypoints/popup/components/builder/model/variables';
import SelectorEditor from './SelectorEditor.vue';
import VarInput from '@/entrypoints/popup/components/builder/widgets/VarInput.vue';

const props = defineProps<{ node: NodeBase; variables?: VariableOption[] }>();
const variables = computed<VariableOption[]>(() => (props.variables || []).slice());
const value = computed<string>({
  get() {
    return String((props.node as any)?.config?.value ?? '');
  },
  set(v: string) {
    if (!props.node) return;
    if (!(props.node as any).config) (props.node as any).config = {} as any;
    (props.node as any).config.value = v;
  },
});
</script>

<style scoped></style>
