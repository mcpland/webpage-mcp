<template>
  <ReactComponentHost :component="AgentTimelineReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed, inject, ref } from 'vue';
import type { AgentThreadState, TimelineItem } from '../../composables/useAgentThreads';
import { AGENT_SERVER_PORT_KEY } from '../../composables';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import AgentTimelineReact from './AgentTimeline';

const props = defineProps<{
  items: TimelineItem[];
  state: AgentThreadState;
}>();

const injectedServerPort = inject(AGENT_SERVER_PORT_KEY, ref<number | null>(null));

const componentProps = computed(() => ({
  items: props.items,
  state: props.state,
  serverPort: injectedServerPort.value,
}));
</script>
