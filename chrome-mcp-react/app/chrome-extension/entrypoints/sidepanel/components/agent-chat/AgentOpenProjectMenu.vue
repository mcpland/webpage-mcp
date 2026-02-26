<template>
  <ReactComponentHost :component="AgentOpenProjectMenuReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { OpenProjectTarget } from 'webpage-mcp-shared';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import AgentOpenProjectMenuReact from './AgentOpenProjectMenu';

const props = defineProps<{
  open: boolean;
  defaultTarget: OpenProjectTarget | null;
}>();

const emit = defineEmits<{
  select: [target: OpenProjectTarget];
  close: [];
}>();

const componentProps = computed(() => ({
  open: props.open,
  defaultTarget: props.defaultTarget,
  onSelect: (target: OpenProjectTarget) => emit('select', target),
  onClose: () => emit('close'),
}));
</script>
