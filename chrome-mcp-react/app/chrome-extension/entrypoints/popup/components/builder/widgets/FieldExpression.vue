<template>
  <div class="expr">
    <input class="form-input mono" :placeholder="placeholder" :value="text" @input="onInput" />
    <div v-if="err" class="error-item">{{ err }}</div>
  </div>
</template>

<script lang="ts" setup>
import { ref, watchEffect } from 'vue';
import { evalExpression } from '@/entrypoints/background/record-replay/engine/utils/expression';

const props = defineProps<{ modelValue?: string; field?: any }>();
const emit = defineEmits<{ (e: 'update:modelValue', v?: string): void }>();
const text = ref<string>(props.modelValue ?? '');
const err = ref<string>('');
const placeholder = props.field?.placeholder || 'e.g. vars.a > 0 && vars.flag';

function onInput(ev: any) {
  const v = String(ev?.target?.value ?? '');
  text.value = v;
  try {
    // just validate; allow empty
    if (v.trim()) {
      evalExpression(v, { vars: {} as any });
    }
    err.value = '';
  } catch (e: any) {
    err.value = '表达式解析错误';
  }
  emit('update:modelValue', v);
}

watchEffect(() => {
  text.value = props.modelValue ?? '';
});
</script>

<style scoped>
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
}
</style>
