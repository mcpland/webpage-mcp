<template>
  <ReactComponentHost :component="AgentTimelineItemReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { TimelineItem } from '../../composables/useAgentThreads';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import AgentTimelineItemReact from './AgentTimelineItem';

const props = defineProps<{
  item: TimelineItem;
  isLast?: boolean;
  serverPort?: number | null;
}>();

const componentProps = computed(() => ({
  item: props.item,
  isLast: props.isLast,
  serverPort: props.serverPort,
}));
</script>
