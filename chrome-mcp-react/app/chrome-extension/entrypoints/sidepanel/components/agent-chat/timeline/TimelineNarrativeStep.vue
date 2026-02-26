<template>
  <ReactComponentHost :component="TimelineNarrativeStepReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { TimelineItem } from '../../../composables/useAgentThreads';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import TimelineNarrativeStepReact from './TimelineNarrativeStep';

const props = defineProps<{
  item: Extract<TimelineItem, { kind: 'assistant_text' }>;
}>();

const componentProps = computed(() => ({
  item: props.item,
}));
</script>
