<template>
  <div class="flex flex-col gap-1 rounded-lg px-3 py-2 max-w-full" :class="messageClasses">
    <div class="flex items-center justify-between gap-2 text-[11px] opacity-70">
      <span>{{ senderName }}</span>
      <span v-if="message.createdAt">
        {{ formatTime(message.createdAt) }}
      </span>
    </div>
    <div class="whitespace-pre-wrap break-words text-xs leading-relaxed">
      {{ message.content }}
    </div>
    <div v-if="message.isStreaming && !message.isFinal" class="text-[10px] opacity-60 mt-0.5">
      Streaming...
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { AgentMessage } from 'webpage-mcp-shared';

const props = defineProps<{
  message: AgentMessage;
}>();

const messageClasses = computed(() => {
  return props.message.role === 'user'
    ? 'bg-white border border-slate-200 self-end'
    : 'bg-slate-900 text-slate-50 self-start';
});

const senderName = computed(() => {
  return props.message.role === 'user' ? 'You' : props.message.cliSource || 'Agent';
});

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString();
}
</script>
