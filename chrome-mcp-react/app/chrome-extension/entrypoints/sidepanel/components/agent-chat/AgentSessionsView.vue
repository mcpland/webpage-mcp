<template>
  <ReactComponentHost :component="AgentSessionsViewReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { AgentProject, AgentSession } from 'webpage-mcp-shared';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import AgentSessionsViewReact from './AgentSessionsView';

const props = defineProps<{
  sessions: AgentSession[];
  selectedSessionId: string;
  isLoading: boolean;
  isCreating: boolean;
  error: string | null;
  runningSessionIds?: Set<string>;
  projectsMap?: Map<string, AgentProject>;
}>();

const emit = defineEmits<{
  'session:select': [sessionId: string];
  'session:new': [];
  'session:delete': [sessionId: string];
  'session:rename': [sessionId: string, name: string];
  'session:open-project': [sessionId: string];
}>();

const componentProps = computed(() => ({
  sessions: props.sessions,
  selectedSessionId: props.selectedSessionId,
  isLoading: props.isLoading,
  isCreating: props.isCreating,
  error: props.error,
  runningSessionIds: props.runningSessionIds,
  projectsMap: props.projectsMap,
  onSessionSelect: (sessionId: string) => emit('session:select', sessionId),
  onSessionNew: () => emit('session:new'),
  onSessionDelete: (sessionId: string) => emit('session:delete', sessionId),
  onSessionRename: (sessionId: string, name: string) => emit('session:rename', sessionId, name),
  onSessionOpenProject: (sessionId: string) => emit('session:open-project', sessionId),
}));
</script>
