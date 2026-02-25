<template>
  <div class="duration">
    <div class="row">
      <input class="form-input" type="number" :value="val" @input="onNum" min="0" />
      <select class="form-input unit" :value="unit" @change="onUnit">
        <option value="ms">ms</option>
        <option value="s">s</option>
      </select>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, watchEffect } from 'vue';
const props = defineProps<{ modelValue?: number; field?: any }>();
const emit = defineEmits<{ (e: 'update:modelValue', v?: number): void }>();
const unit = ref<'ms' | 's'>('ms');
const val = ref<number>(Number(props.modelValue || 0));
watchEffect(() => {
  const ms = Number(props.modelValue || 0);
  if (ms % 1000 === 0 && ms >= 1000) {
    unit.value = 's';
    val.value = ms / 1000;
  } else {
    unit.value = 'ms';
    val.value = ms;
  }
});
function onNum(ev: any) {
  const n = Number(ev?.target?.value || 0);
  val.value = n;
  emit('update:modelValue', unit.value === 's' ? n * 1000 : n);
}
function onUnit(ev: any) {
  unit.value = ev?.target?.value === 's' ? 's' : 'ms';
  emit('update:modelValue', unit.value === 's' ? val.value * 1000 : val.value);
}
</script>

<style scoped>
.row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.unit {
  width: 84px;
}
</style>
