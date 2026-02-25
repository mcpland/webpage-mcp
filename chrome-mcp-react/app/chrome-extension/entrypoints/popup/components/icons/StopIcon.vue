<template>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" :class="className">
    <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" />
  </svg>
</template>

<script lang="ts" setup>
interface Props {
  className?: string;
}

withDefaults(defineProps<Props>(), {
  className: 'icon-default',
});
</script>
