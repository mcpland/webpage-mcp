<template>
  <div class="code">
    <textarea
      class="form-input mono"
      rows="6"
      :placeholder="placeholder"
      :value="text"
      @input="onInput"
    ></textarea>
  </div>
</template>

<script lang="ts" setup>
import { ref, watchEffect } from 'vue';
const props = defineProps<{ modelValue?: string; field?: any }>();
const emit = defineEmits<{ (e: 'update:modelValue', v?: string): void }>();
const text = ref<string>(props.modelValue ?? '');
const placeholder = props.field?.placeholder || '/* code */';
function onInput(ev: any) {
  const v = String(ev?.target?.value ?? '');
  text.value = v;
  emit('update:modelValue', v);
}
watchEffect(() => (text.value = props.modelValue ?? ''));
</script>

<style scoped>
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
}
</style>
