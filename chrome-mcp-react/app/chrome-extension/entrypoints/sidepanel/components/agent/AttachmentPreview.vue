<template>
  <div class="flex flex-wrap gap-2 mb-2">
    <div
      v-for="(att, idx) in attachments"
      :key="idx"
      class="flex items-center gap-1 bg-slate-100 px-2 py-1 rounded text-xs max-w-[150px]"
    >
      <span class="truncate" :title="att.name">{{ att.name }}</span>
      <button
        type="button"
        class="text-red-500 hover:text-red-700 flex-shrink-0"
        @click="$emit('remove', idx)"
      >
        &times;
      </button>
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { AgentAttachment } from 'webpage-mcp-shared';

defineProps<{
  attachments: AgentAttachment[];
}>();

defineEmits<{
  remove: [index: number];
}>();
</script>
