<template>
  <div class="space-y-1">
    <div class="flex items-baseline gap-2 flex-wrap">
      <!-- Label -->
      <span
        class="text-[11px] font-bold uppercase tracking-wider flex-shrink-0"
        :style="{
          color: labelColor,
        }"
      >
        {{ item.tool.label }}
      </span>

      <!-- Content based on tool kind -->
      <code
        v-if="item.tool.kind === 'grep' || item.tool.kind === 'read'"
        class="text-xs px-1.5 py-0.5 cursor-pointer ac-chip-hover"
        :style="{
          fontFamily: 'var(--ac-font-mono)',
          backgroundColor: 'var(--ac-chip-bg)',
          color: 'var(--ac-chip-text)',
          borderRadius: 'var(--ac-radius-button)',
        }"
        :title="item.tool.filePath || item.tool.pattern"
      >
        {{ item.tool.title }}
      </code>

      <span
        v-else
        class="text-xs"
        :style="{
          fontFamily: 'var(--ac-font-mono)',
          color: 'var(--ac-text-muted)',
        }"
        :title="item.tool.filePath || item.tool.command"
      >
        {{ item.tool.title }}
      </span>

      <!-- Diff Stats Preview (for edit) -->
      <span
        v-if="hasDiffStats"
        class="text-[10px] px-1.5 py-0.5"
        :style="{
          backgroundColor: 'var(--ac-chip-bg)',
          color: 'var(--ac-text-muted)',
          fontFamily: 'var(--ac-font-mono)',
          borderRadius: 'var(--ac-radius-button)',
        }"
      >
        <span v-if="item.tool.diffStats?.addedLines" class="text-green-600 dark:text-green-400">
          +{{ item.tool.diffStats.addedLines }}
        </span>
        <span v-if="item.tool.diffStats?.addedLines && item.tool.diffStats?.deletedLines">/</span>
        <span v-if="item.tool.diffStats?.deletedLines" class="text-red-600 dark:text-red-400">
          -{{ item.tool.diffStats.deletedLines }}
        </span>
      </span>

      <!-- Streaming indicator -->
      <span
        v-if="item.isStreaming"
        class="text-xs italic"
        :style="{ color: 'var(--ac-text-subtle)' }"
      >
        ...
      </span>
    </div>

    <!-- Subtitle (command description or search path) -->
    <div
      v-if="subtitle"
      class="text-[10px] pl-10 truncate"
      :style="{ color: 'var(--ac-text-subtle)' }"
      :title="subtitleFull"
    >
      {{ subtitle }}
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import type { TimelineItem } from '../../../composables/useAgentThreads';

const props = defineProps<{
  item: Extract<TimelineItem, { kind: 'tool_use' }>;
}>();

const labelColor = computed(() => {
  if (props.item.tool.kind === 'edit') {
    return 'var(--ac-accent)';
  }
  return 'var(--ac-text-subtle)';
});

const hasDiffStats = computed(() => {
  const stats = props.item.tool.diffStats;
  if (!stats) return false;
  return stats.addedLines !== undefined || stats.deletedLines !== undefined;
});

const subtitle = computed(() => {
  const tool = props.item.tool;

  // For commands: show the actual command if title is description
  if (tool.kind === 'run' && tool.commandDescription && tool.command) {
    return tool.command.length > 60 ? tool.command.slice(0, 57) + '...' : tool.command;
  }

  // For file operations: show full path if title is just filename
  if ((tool.kind === 'edit' || tool.kind === 'read') && tool.filePath) {
    if (tool.filePath !== tool.title && !tool.title.includes('/')) {
      return tool.filePath;
    }
  }

  // For search: show search path if provided
  if (tool.kind === 'grep' && tool.searchPath) {
    return `in ${tool.searchPath}`;
  }

  return undefined;
});

const subtitleFull = computed(() => {
  const tool = props.item.tool;
  if (tool.kind === 'run' && tool.command) return tool.command;
  if (tool.filePath) return tool.filePath;
  if (tool.searchPath) return tool.searchPath;
  return undefined;
});
</script>
