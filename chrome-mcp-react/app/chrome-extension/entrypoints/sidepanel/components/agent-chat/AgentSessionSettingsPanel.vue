<template>
  <ReactComponentHost :component="AgentSessionSettingsPanelReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type {
  AgentManagementInfo,
  AgentSession,
  AgentSessionOptionsConfig,
  AgentSystemPromptConfig,
} from 'webpage-mcp-shared';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import AgentSessionSettingsPanelReact from './AgentSessionSettingsPanel';

export interface SessionSettings {
  model: string;
  permissionMode: string;
  systemPromptConfig: AgentSystemPromptConfig | null;
  optionsConfig?: AgentSessionOptionsConfig;
}

const props = defineProps<{
  open: boolean;
  session: AgentSession | null;
  managementInfo: AgentManagementInfo | null;
  isLoading: boolean;
  isSaving: boolean;
}>();

const emit = defineEmits<{
  close: [];
  save: [settings: SessionSettings];
}>();

const componentProps = computed(() => ({
  open: props.open,
  session: props.session,
  managementInfo: props.managementInfo,
  isLoading: props.isLoading,
  isSaving: props.isSaving,
  onClose: () => emit('close'),
  onSave: (settings: SessionSettings) => emit('save', settings),
}));
</script>
