<template>
  <ReactComponentHost :component="AgentProjectMenuReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { AgentProject, AgentEngineInfo, CodexReasoningEffort } from 'webpage-mcp-shared';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import AgentProjectMenuReact from './AgentProjectMenu';

const props = defineProps<{
  open: boolean;
  projects: AgentProject[];
  selectedProjectId: string;
  selectedCli: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  useCcr: boolean;
  enableWebpageMcp: boolean;
  engines: AgentEngineInfo[];
  isPicking: boolean;
  isSaving: boolean;
  error: string | null;
}>();

const emit = defineEmits<{
  'project:select': [projectId: string];
  'project:new': [];
  'cli:update': [cli: string];
  'model:update': [model: string];
  'reasoning-effort:update': [effort: CodexReasoningEffort];
  'ccr:update': [useCcr: boolean];
  'webpage-mcp:update': [enableWebpageMcp: boolean];
  save: [];
}>();

const componentProps = computed(() => ({
  open: props.open,
  projects: props.projects,
  selectedProjectId: props.selectedProjectId,
  selectedCli: props.selectedCli,
  model: props.model,
  reasoningEffort: props.reasoningEffort,
  useCcr: props.useCcr,
  enableWebpageMcp: props.enableWebpageMcp,
  engines: props.engines,
  isPicking: props.isPicking,
  isSaving: props.isSaving,
  error: props.error,
  onProjectSelect: (projectId: string) => emit('project:select', projectId),
  onProjectNew: () => emit('project:new'),
  onCliUpdate: (cli: string) => emit('cli:update', cli),
  onModelUpdate: (model: string) => emit('model:update', model),
  onReasoningEffortUpdate: (effort: CodexReasoningEffort) => emit('reasoning-effort:update', effort),
  onCcrUpdate: (useCcr: boolean) => emit('ccr:update', useCcr),
  onWebpageMcpUpdate: (enableWebpageMcp: boolean) => emit('webpage-mcp:update', enableWebpageMcp),
  onSave: () => emit('save'),
}));
</script>
