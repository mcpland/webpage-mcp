<template>
  <ReactComponentHost :component="ThinkingNodeReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import ThinkingNodeReact from './ThinkingNode';

type ThinkingNodeData = {
  type: 'thinking';
  tag?: string;
  content: string;
  raw: string;
  loading?: boolean;
  autoClosed?: boolean;
  attrs?: Array<[string, string]>;
};

const props = defineProps<{
  node: ThinkingNodeData;
  loading?: boolean;
  indexKey?: string | number;
  customId?: string;
  isDark?: boolean;
  typewriter?: boolean;
}>();

const componentProps = computed(() => ({
  node: props.node,
  loading: props.loading,
  indexKey: props.indexKey,
  customId: props.customId,
  isDark: props.isDark,
  typewriter: props.typewriter,
}));
</script>
