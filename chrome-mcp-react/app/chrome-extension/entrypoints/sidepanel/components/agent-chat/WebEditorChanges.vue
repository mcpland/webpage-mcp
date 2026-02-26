<template>
  <ReactComponentHost :component="WebEditorChangesReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed, inject } from 'vue';
import {
  WEB_EDITOR_TX_STATE_INJECTION_KEY,
  type WebEditorTxStateReturn,
} from '../../composables';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import WebEditorChangesReact from './WebEditorChanges';

const props = defineProps<{
  txState?: WebEditorTxStateReturn;
}>();

function resolveTxState(): WebEditorTxStateReturn {
  if (props.txState) {
    return props.txState;
  }

  const injected = inject<WebEditorTxStateReturn>(WEB_EDITOR_TX_STATE_INJECTION_KEY);
  if (!injected) {
    throw new Error(
      '[WebEditorChanges] WebEditorTxState must be provided by parent component. Ensure parent component provides WEB_EDITOR_TX_STATE_INJECTION_KEY or passes txState prop.',
    );
  }

  return injected;
}

const componentProps = computed(() => ({
  txState: resolveTxState(),
}));
</script>
