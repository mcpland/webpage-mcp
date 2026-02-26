<template>
  <ReactComponentHost :component="TimelineStatusStepReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { TimelineItem } from '../../../composables/useAgentThreads';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import TimelineStatusStepReact from './TimelineStatusStep';

const props = defineProps<{
  item: Extract<TimelineItem, { kind: 'status' }>;
  hideIcon?: boolean;
}>();

const componentProps = computed(() => ({
  item: props.item,
  hideIcon: props.hideIcon,
}));
</script>
