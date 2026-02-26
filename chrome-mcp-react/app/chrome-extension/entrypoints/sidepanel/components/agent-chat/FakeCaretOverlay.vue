<template>
  <ReactComponentHost :component="FakeCaretOverlayReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import FakeCaretOverlayReact from './FakeCaretOverlay';

const props = defineProps<{
  textareaRef: HTMLTextAreaElement | null;
  enabled: boolean;
  value: string;
}>();

const componentProps = computed(() => ({
  textareaRef: props.textareaRef,
  enabled: props.enabled,
  value: props.value,
}));
</script>
