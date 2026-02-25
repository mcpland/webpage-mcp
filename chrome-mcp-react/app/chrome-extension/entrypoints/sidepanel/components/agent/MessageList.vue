<template>
  <div class="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-slate-50">
    <div v-if="messages.length === 0" class="text-xs text-slate-500 text-center mt-4">
      Start a conversation with your local agent. Messages stream from the native server via SSE and
      are persisted per project.
    </div>

    <MessageItem v-for="message in messages" :key="message.id" :message="message" />
  </div>
</template>

<script lang="ts" setup>
import type { AgentMessage } from 'webpage-mcp-shared';
import MessageItem from './MessageItem.vue';

defineProps<{
  messages: AgentMessage[];
}>();
</script>
