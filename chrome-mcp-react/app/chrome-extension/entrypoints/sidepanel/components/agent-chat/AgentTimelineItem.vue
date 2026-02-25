<template>
  <div class="relative group/step">
    <!-- Timeline Node: Loading icon for running status, colored dot otherwise -->
    <template v-if="showLoadingIcon">
      <!-- Loading scribble icon for running/starting status -->
      <svg
        class="absolute loading-scribble flex-shrink-0"
        :style="{
          left: '-24px',
          top: nodeTopOffset,
          width: '14px',
          height: '14px',
        }"
        viewBox="0 0 100 100"
        fill="none"
      >
        <path
          d="M50 50 C50 48, 52 46, 54 46 C58 46, 60 50, 60 54 C60 60, 54 64, 48 64 C40 64, 36 56, 36 48 C36 38, 44 32, 54 32 C66 32, 74 42, 74 54 C74 68, 62 78, 48 78 C32 78, 22 64, 22 48 C22 30, 36 18, 54 18 C74 18, 88 34, 88 54 C88 76, 72 92, 50 92"
          stroke="var(--ac-accent, #D97757)"
          stroke-width="8"
          stroke-linecap="round"
        />
      </svg>
    </template>
    <template v-else>
      <!-- Colored dot -->
      <span
        class="absolute w-2 h-2 rounded-full transition-colors"
        :style="{
          left: '-20px',
          top: nodeTopOffset,
          backgroundColor: nodeColor,
          boxShadow: isStreaming ? 'var(--ac-timeline-node-pulse-shadow)' : 'none',
        }"
        :class="{ 'ac-pulse': isStreaming }"
      />
    </template>

    <!-- Content based on item kind -->
    <TimelineUserPromptStep v-if="item.kind === 'user_prompt'" :item="item" />
    <TimelineNarrativeStep v-else-if="item.kind === 'assistant_text'" :item="item" />
    <TimelineToolCallStep v-else-if="item.kind === 'tool_use'" :item="item" />
    <TimelineToolResultCardStep v-else-if="item.kind === 'tool_result'" :item="item" />
    <TimelineStatusStep
      v-else-if="item.kind === 'status'"
      :item="item"
      :hide-icon="showLoadingIcon"
    />
  </div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { TimelineItem } from '../../composables/useAgentThreads';
import TimelineUserPromptStep from './timeline/TimelineUserPromptStep.vue';
import TimelineNarrativeStep from './timeline/TimelineNarrativeStep.vue';
import TimelineToolCallStep from './timeline/TimelineToolCallStep.vue';
import TimelineToolResultCardStep from './timeline/TimelineToolResultCardStep.vue';
import TimelineStatusStep from './timeline/TimelineStatusStep.vue';

const props = defineProps<{
  item: TimelineItem;
  /** Whether this is the last item in the timeline */
  isLast?: boolean;
}>();

const isStreaming = computed(() => {
  if (props.item.kind === 'assistant_text' || props.item.kind === 'tool_use') {
    return props.item.isStreaming;
  }
  if (props.item.kind === 'status') {
    return props.item.status === 'running' || props.item.status === 'starting';
  }
  return false;
});

// Show loading icon for status items that are running/starting
const showLoadingIcon = computed(() => {
  if (props.item.kind === 'status') {
    return props.item.status === 'running' || props.item.status === 'starting';
  }
  return false;
});

// Calculate top offset based on item type to align with first line of text
const nodeTopOffset = computed(() => {
  // user_prompt and assistant_text have py-1 (4px) + text-sm leading-relaxed
  if (props.item.kind === 'user_prompt' || props.item.kind === 'assistant_text') {
    return '12px';
  }
  // tool_use/tool_result have items-baseline with text-[11px]
  if (props.item.kind === 'tool_use' || props.item.kind === 'tool_result') {
    return '6px';
  }
  // status has flex items-center with text-xs (12px line-height ~18px)
  // For loading icon (14px), center it: (18-14)/2 = 2px
  if (props.item.kind === 'status') {
    return '2px';
  }
  return '7px';
});

const nodeColor = computed(() => {
  // Active/streaming node
  if (isStreaming.value) {
    return 'var(--ac-timeline-node-active)';
  }

  // Tool result nodes - success/error colors
  if (props.item.kind === 'tool_result') {
    if (props.item.isError) {
      return 'var(--ac-danger)';
    }
    return 'var(--ac-success)';
  }

  // Tool use nodes - use tool color
  if (props.item.kind === 'tool_use') {
    return 'var(--ac-timeline-node-tool)';
  }

  // Assistant text - use accent color
  if (props.item.kind === 'assistant_text') {
    return 'var(--ac-timeline-node-active)';
  }

  // User prompt - slightly stronger than default node for visual distinction
  if (props.item.kind === 'user_prompt') {
    return 'var(--ac-timeline-node-hover)';
  }

  // Status nodes (completed/error/cancelled) - use muted color
  if (props.item.kind === 'status') {
    return 'var(--ac-timeline-node)';
  }

  // Default node color
  return 'var(--ac-timeline-node)';
});
</script>
