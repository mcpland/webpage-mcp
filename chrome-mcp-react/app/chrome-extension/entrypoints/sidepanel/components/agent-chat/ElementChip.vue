<template>
  <ReactComponentHost :component="ElementChipReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { ElementChangeSummary, WebEditorElementKey } from '@/common/web-editor-types';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import ElementChipReact from './ElementChip';

const props = withDefaults(
  defineProps<{
    element: ElementChangeSummary;
    excluded: boolean;
    selected?: boolean;
    scrollResizeTrigger?: number;
  }>(),
  {
    selected: false,
    scrollResizeTrigger: 0,
  },
);

const emit = defineEmits<{
  'toggle:exclude': [elementKey: WebEditorElementKey];
  revert: [elementKey: WebEditorElementKey];
  'hover:start': [element: ElementChangeSummary];
  'hover:end': [element: ElementChangeSummary];
}>();

const componentProps = computed(() => ({
  element: props.element,
  excluded: props.excluded,
  selected: props.selected,
  scrollResizeTrigger: props.scrollResizeTrigger,
  onToggleExclude: (elementKey: WebEditorElementKey) => emit('toggle:exclude', elementKey),
  onRevert: (elementKey: WebEditorElementKey) => emit('revert', elementKey),
  onHoverStart: (element: ElementChangeSummary) => emit('hover:start', element),
  onHoverEnd: (element: ElementChangeSummary) => emit('hover:end', element),
}));
</script>
