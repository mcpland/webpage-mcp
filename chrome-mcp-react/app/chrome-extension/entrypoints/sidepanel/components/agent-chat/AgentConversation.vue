<template>
  <ReactComponentHost :component="AgentConversationReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed, inject, ref } from 'vue';
import type { AgentThread } from '../../composables/useAgentThreads';
import { AGENT_SERVER_PORT_KEY } from '../../composables';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import AgentConversationReact from './AgentConversation';

const props = defineProps<{
  threads: AgentThread[];
}>();

const injectedServerPort = inject(AGENT_SERVER_PORT_KEY, ref<number | null>(null));

const componentProps = computed(() => ({
  threads: props.threads,
  serverPort: injectedServerPort.value,
}));
</script>
