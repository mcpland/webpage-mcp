<template>
  <ReactComponentHost :component="TimelineToolCallStepReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { TimelineItem } from '../../../composables/useAgentThreads';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import TimelineToolCallStepReact from './TimelineToolCallStep';

const props = defineProps<{
  item: Extract<TimelineItem, { kind: 'tool_use' }>;
}>();

const componentProps = computed(() => ({
  item: props.item,
}));
</script>
