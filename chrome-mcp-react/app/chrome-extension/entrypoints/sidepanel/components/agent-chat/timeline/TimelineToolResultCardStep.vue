<template>
  <ReactComponentHost :component="TimelineToolResultCardStepReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { TimelineItem } from '../../../composables/useAgentThreads';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import TimelineToolResultCardStepReact from './TimelineToolResultCardStep';

const props = defineProps<{
  item: Extract<TimelineItem, { kind: 'tool_result' }>;
}>();

const componentProps = computed(() => ({
  item: props.item,
}));
</script>
