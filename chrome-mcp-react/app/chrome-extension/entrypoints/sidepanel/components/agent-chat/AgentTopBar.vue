<template>
  <ReactComponentHost :component="AgentTopBarReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import AgentTopBarReact from './AgentTopBar';

type ConnectionState = 'ready' | 'connecting' | 'disconnected';

const props = defineProps<{
  projectLabel: string;
  sessionLabel: string;
  connectionState: ConnectionState;
  showBackButton?: boolean;
  brandLabel?: string;
}>();

const emit = defineEmits<{
  'toggle:projectMenu': [];
  'toggle:sessionMenu': [];
  'toggle:settingsMenu': [];
  'toggle:openProjectMenu': [];
  back: [];
}>();

const componentProps = computed(() => ({
  projectLabel: props.projectLabel,
  sessionLabel: props.sessionLabel,
  connectionState: props.connectionState,
  showBackButton: props.showBackButton,
  brandLabel: props.brandLabel,
  onToggleProjectMenu: () => emit('toggle:projectMenu'),
  onToggleSessionMenu: () => emit('toggle:sessionMenu'),
  onToggleSettingsMenu: () => emit('toggle:settingsMenu'),
  onToggleOpenProjectMenu: () => emit('toggle:openProjectMenu'),
  onBack: () => emit('back'),
}));
</script>
