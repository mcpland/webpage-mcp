<template>
  <ReactComponentHost :component="AgentSessionMenuReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { AgentSession } from 'webpage-mcp-shared';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import AgentSessionMenuReact from './AgentSessionMenu';

const props = defineProps<{
  open: boolean;
  sessions: AgentSession[];
  selectedSessionId: string;
  isLoading: boolean;
  isCreating: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  'session:select': [sessionId: string];
  'session:new': [];
  'session:delete': [sessionId: string];
  'session:rename': [sessionId: string, name: string];
}>();

const componentProps = computed(() => ({
  open: props.open,
  sessions: props.sessions,
  selectedSessionId: props.selectedSessionId,
  isLoading: props.isLoading,
  isCreating: props.isCreating,
  error: props.error,
  onSessionSelect: (sessionId: string) => emit('session:select', sessionId),
  onSessionNew: () => emit('session:new'),
  onSessionDelete: (sessionId: string) => emit('session:delete', sessionId),
  onSessionRename: (sessionId: string, name: string) => emit('session:rename', sessionId, name),
}));
</script>
