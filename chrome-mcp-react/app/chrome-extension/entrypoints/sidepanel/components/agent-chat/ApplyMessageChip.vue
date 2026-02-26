<template>
  <ReactComponentHost :component="ApplyMessageChipReact" :component-props="componentProps" />
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { ThreadHeader } from '../../composables';
import ReactComponentHost from '@/entrypoints/shared/vue/ReactComponentHost.vue';
import ApplyMessageChipReact from './ApplyMessageChip';

const props = defineProps<{
  header: ThreadHeader;
}>();

const componentProps = computed(() => ({
  header: props.header,
}));
</script>
