<template>
  <ReactComponentHost :component="AgentChatShellReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { createElement, type ReactNode } from 'react';
import type { AgentUsageStats } from 'webpage-mcp-shared';
import {
  computed,
  defineComponent,
  inject,
  ref,
  useSlots,
  type InjectionKey,
  type Ref,
} from 'vue';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import {
  VueComponentHost,
  type VueProvideEntry,
} from '@/entrypoints/shared/react/mount-vue-in-react';
import AgentChatShellReact from './AgentChatShell';
import {
  AGENT_SERVER_PORT_KEY,
  WEB_EDITOR_TX_STATE_INJECTION_KEY,
  type WebEditorTxStateReturn,
} from '../../composables';

const props = defineProps<{
  errorMessage?: string | null;
  usage?: AgentUsageStats | null;
  footerLabel?: string;
}>();

const emit = defineEmits<{
  'error:dismiss': [];
}>();

const slots = useSlots();
const injectedServerPort = inject(AGENT_SERVER_PORT_KEY, ref<number | null>(null));
const injectedWebEditorTxState = inject<WebEditorTxStateReturn | undefined>(
  WEB_EDITOR_TX_STATE_INJECTION_KEY,
  undefined,
);

const slotProvides: VueProvideEntry[] = [
  {
    key: AGENT_SERVER_PORT_KEY as InjectionKey<Ref<number | null>>,
    value: injectedServerPort,
  },
];

if (injectedWebEditorTxState !== undefined) {
  slotProvides.push({
    key: WEB_EDITOR_TX_STATE_INJECTION_KEY as InjectionKey<WebEditorTxStateReturn>,
    value: injectedWebEditorTxState,
  });
}

function createSlotNode(slotName: 'header' | 'content' | 'composer'): ReactNode | null {
  const slotContent = slots[slotName];
  if (!slotContent) {
    return null;
  }

  const SlotBridge = defineComponent({
    name: `AgentChatShell${slotName}SlotBridge`,
    setup() {
      return () => slotContent();
    },
  });

  return createElement(VueComponentHost, {
    component: SlotBridge,
    componentProvides: slotProvides,
  });
}

const componentProps = computed(() => ({
  errorMessage: props.errorMessage,
  usage: props.usage,
  footerLabel: props.footerLabel,
  header: createSlotNode('header'),
  content: createSlotNode('content'),
  composer: createSlotNode('composer'),
  onErrorDismiss: () => emit('error:dismiss'),
}));
</script>
