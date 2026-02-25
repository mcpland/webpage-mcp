<template>
  <div class="px-5 py-6 space-y-8">
    <!-- Empty State -->
    <div v-if="threads.length === 0" class="py-10 text-center">
      <p
        class="text-2xl italic opacity-40"
        :style="{
          fontFamily: 'var(--ac-font-heading)',
          color: 'var(--ac-text-subtle)',
        }"
      >
        How can I help you code today?
      </p>
    </div>

    <!-- Request Threads -->
    <AgentRequestThread v-for="thread in threads" :key="thread.id" :thread="thread" />
  </div>
</template>

<script lang="ts" setup>
import type { AgentThread } from '../../composables/useAgentThreads';
import AgentRequestThread from './AgentRequestThread.vue';

defineProps<{
  threads: AgentThread[];
}>();
</script>
