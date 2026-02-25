<template>
  <div class="pl-1 space-y-3">
    <!-- Timeline container -->
    <div class="relative pl-5 space-y-4 ml-1">
      <AgentTimelineItem
        v-for="(item, index) in items"
        :key="item.id"
        :item="item"
        :is-last="index === items.length - 1"
      />
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { TimelineItem, AgentThreadState } from '../../composables/useAgentThreads';
import AgentTimelineItem from './AgentTimelineItem.vue';

defineProps<{
  items: TimelineItem[];
  state: AgentThreadState;
}>();
</script>
