<template>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" :class="className">
    <circle cx="12" cy="12" r="8" :fill="recording ? '#ef4444' : 'currentColor'" />
  </svg>
</template>

<script lang="ts" setup>
interface Props {
  className?: string;
  recording?: boolean;
}

withDefaults(defineProps<Props>(), {
  className: 'icon-default',
  recording: false,
});
</script>
