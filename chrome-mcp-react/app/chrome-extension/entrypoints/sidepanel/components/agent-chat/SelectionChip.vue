<template>
  <ReactComponentHost :component="SelectionChipReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { SelectedElementSummary } from '@/common/web-editor-types';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import SelectionChipReact from './SelectionChip';

const props = defineProps<{
  selected: SelectedElementSummary;
}>();

const emit = defineEmits<{
  'hover:start': [selected: SelectedElementSummary];
  'hover:end': [selected: SelectedElementSummary];
}>();

const componentProps = computed(() => ({
  selected: props.selected,
  onHoverStart: (selected: SelectedElementSummary) => emit('hover:start', selected),
  onHoverEnd: (selected: SelectedElementSummary) => emit('hover:end', selected),
}));
</script>
