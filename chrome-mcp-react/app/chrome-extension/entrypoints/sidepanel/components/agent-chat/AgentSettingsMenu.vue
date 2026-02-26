<template>
  <ReactComponentHost :component="AgentSettingsMenuReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { AgentThemeId } from '../../composables';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import AgentSettingsMenuReact from './AgentSettingsMenu';

const props = defineProps<{
  open: boolean;
  theme: AgentThemeId;
  fakeCaretEnabled?: boolean;
}>();

const emit = defineEmits<{
  'theme:set': [theme: AgentThemeId];
  reconnect: [];
  'attachments:open': [];
  'fakeCaret:toggle': [enabled: boolean];
}>();

const componentProps = computed(() => ({
  open: props.open,
  theme: props.theme,
  fakeCaretEnabled: props.fakeCaretEnabled,
  onThemeSet: (theme: AgentThemeId) => emit('theme:set', theme),
  onReconnect: () => emit('reconnect'),
  onAttachmentsOpen: () => emit('attachments:open'),
  onFakeCaretToggle: (enabled: boolean) => emit('fakeCaret:toggle', enabled),
}));
</script>
