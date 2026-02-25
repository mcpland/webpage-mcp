<template>
  <div class="px-4 py-2 border-b border-slate-200 flex items-center justify-between gap-2">
    <div class="flex items-center gap-2 text-xs text-slate-600">
      <span :class="['inline-flex h-2 w-2 rounded-full', statusColor]"></span>
      <span>{{ statusText }}</span>
    </div>
    <button
      class="btn-secondary !px-3 !py-1 text-xs"
      :disabled="connecting"
      @click="$emit('reconnect')"
    >
      {{ connecting ? 'Reconnecting...' : 'Reconnect' }}
    </button>
  </div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';

const props = defineProps<{
  isServerReady: boolean;
  nativeConnected: boolean;
  connecting: boolean;
}>();

defineEmits<{
  reconnect: [];
}>();

const statusColor = computed(() => {
  if (props.isServerReady) return 'bg-green-500';
  if (props.nativeConnected) return 'bg-yellow-500';
  return 'bg-slate-400';
});

const statusText = computed(() => {
  if (props.isServerReady) return 'Agent server connected';
  if (props.nativeConnected) return 'Connecting to agent server...';
  return 'Native host not connected';
});
</script>
