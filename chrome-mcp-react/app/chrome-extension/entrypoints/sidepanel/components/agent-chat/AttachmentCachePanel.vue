<template>
  <ReactComponentHost :component="AttachmentCachePanelReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed, inject, ref } from 'vue';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import { AGENT_SERVER_PORT_KEY } from '../../composables';
import AttachmentCachePanelReact from './AttachmentCachePanel';

const props = defineProps<{
  open: boolean;
  serverPort?: number | null;
}>();

const emit = defineEmits<{
  close: [];
}>();

const injectedServerPort = inject(AGENT_SERVER_PORT_KEY, ref<number | null>(null));

const resolvedServerPort = computed(() =>
  props.serverPort === undefined ? injectedServerPort.value : props.serverPort,
);

const componentProps = computed(() => ({
  open: props.open,
  serverPort: resolvedServerPort.value,
  onClose: () => emit('close'),
}));
</script>
