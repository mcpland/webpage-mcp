<template>
  <ReactComponentHost :component="TimelineUserPromptStepReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed, inject, ref } from 'vue';
import { AGENT_SERVER_PORT_KEY, type TimelineItem } from '../../../composables';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import TimelineUserPromptStepReact from './TimelineUserPromptStep';

const props = defineProps<{
  item: Extract<TimelineItem, { kind: 'user_prompt' }>;
  serverPort?: number | null;
}>();

const injectedServerPort = inject(AGENT_SERVER_PORT_KEY, ref<number | null>(null));

const componentProps = computed(() => ({
  item: props.item,
  serverPort: props.serverPort === undefined ? injectedServerPort.value : props.serverPort,
}));
</script>
