<template>
  <div ref="containerRef" style="display: contents" />
</template>

<script lang="ts" setup>
import { createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

type ReactProps = Record<string, unknown>;

const props = defineProps<{
  component: ComponentType<ReactProps>;
  componentProps?: ReactProps;
}>();

const containerRef = ref<HTMLElement | null>(null);
let root: Root | null = null;

function renderReact(): void {
  if (!root) {
    return;
  }

  root.render(createElement(props.component, props.componentProps ?? {}));
}

onMounted(() => {
  if (!containerRef.value) {
    return;
  }

  root = createRoot(containerRef.value);
  renderReact();
});

watch(
  () => props.component,
  () => {
    renderReact();
  },
);

watch(
  () => props.componentProps,
  () => {
    renderReact();
  },
  { deep: true },
);

onBeforeUnmount(() => {
  root?.unmount();
  root = null;
});
</script>
