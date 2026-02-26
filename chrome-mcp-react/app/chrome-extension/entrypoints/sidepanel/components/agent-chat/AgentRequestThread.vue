<template>
  <ReactComponentHost :component="AgentRequestThreadReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed, inject, ref } from 'vue';
import type { AgentThread } from '../../composables/useAgentThreads';
import { AGENT_SERVER_PORT_KEY } from '../../composables';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import AgentRequestThreadReact from './AgentRequestThread';

const props = defineProps<{
  thread: AgentThread;
  serverPort?: number | null;
}>();

const injectedServerPort = inject(AGENT_SERVER_PORT_KEY, ref<number | null>(null));

const componentProps = computed(() => ({
  thread: props.thread,
  serverPort: props.serverPort === undefined ? injectedServerPort.value : props.serverPort,
}));
</script>
