<template>
  <ReactComponentHost :component="AgentSessionListItemReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { AgentSession } from 'webpage-mcp-shared';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import AgentSessionListItemReact from './AgentSessionListItem';

const props = defineProps<{
  session: AgentSession;
  selected?: boolean;
  isRunning?: boolean;
  projectPath?: string;
}>();

const emit = defineEmits<{
  click: [sessionId: string];
  rename: [sessionId: string, name: string];
  delete: [sessionId: string];
  'open-project': [sessionId: string];
}>();

const componentProps = computed(() => ({
  session: props.session,
  selected: props.selected,
  isRunning: props.isRunning,
  projectPath: props.projectPath,
  onClick: (sessionId: string) => emit('click', sessionId),
  onRename: (sessionId: string, name: string) => emit('rename', sessionId, name),
  onDelete: (sessionId: string) => emit('delete', sessionId),
  onOpenProject: (sessionId: string) => emit('open-project', sessionId),
}));
</script>
