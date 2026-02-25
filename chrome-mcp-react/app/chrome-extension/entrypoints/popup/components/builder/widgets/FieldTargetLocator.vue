<template>
  <div class="target-locator">
    <!-- Reuse FieldSelector UI for picking/typing a selector -->
    <FieldSelector v-model="text" :field="{ placeholder }" />
  </div>
</template>

<script lang="ts" setup>
import { ref, watch, nextTick } from 'vue';
import FieldSelector from './FieldSelector.vue';

type Candidate = { type: 'css' | 'attr' | 'aria' | 'text' | 'xpath'; value: string };
type TargetLocator = { ref?: string; candidates?: Candidate[] };

const props = defineProps<{ modelValue?: TargetLocator | string; field?: any }>();
const emit = defineEmits<{ (e: 'update:modelValue', v?: TargetLocator): void }>();

const placeholder = props.field?.placeholder || '.btn.primary';
const text = ref<string>('');
// guard to prevent emitting during initial/prop-driven sync
const updatingFromProps = ref<boolean>(false);

// derive text from incoming modelValue (supports string or structured object)
watch(
  () => props.modelValue,
  (mv: any) => {
    updatingFromProps.value = true;
    if (!mv) {
      text.value = '';
      nextTick(() => (updatingFromProps.value = false));
      return;
    }
    if (typeof mv === 'string') {
      text.value = mv;
      nextTick(() => (updatingFromProps.value = false));
      return;
    }
    try {
      const arr: Candidate[] = Array.isArray(mv.candidates) ? mv.candidates : [];
      const prefer = ['css', 'attr', 'aria', 'text', 'xpath'];
      let val = '';
      for (const t of prefer) {
        const c = arr.find((x) => x && x.type === t && x.value);
        if (c) {
          val = String(c.value || '');
          break;
        }
      }
      if (!val) val = arr[0]?.value ? String(arr[0].value) : '';
      text.value = val;
    } catch {
      text.value = '';
    }
    nextTick(() => (updatingFromProps.value = false));
  },
  { immediate: true, deep: true },
);

// whenever text changes, emit structured TargetLocator (skip when syncing from props)
watch(
  () => text.value,
  (v) => {
    if (updatingFromProps.value) return;
    const s = String(v || '').trim();
    if (!s) {
      emit('update:modelValue', { candidates: [] });
    } else {
      emit('update:modelValue', {
        ...(typeof props.modelValue === 'object' && props.modelValue
          ? (props.modelValue as any)
          : {}),
        candidates: [{ type: 'css', value: s }],
      });
    }
  },
);
</script>

<style scoped>
.target-locator {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
