<template>
  <div class="space-y-2">
    <!-- Label + Title + Diff Stats -->
    <div class="flex items-baseline gap-2 flex-wrap">
      <span
        class="text-[11px] font-bold uppercase tracking-wider w-8 flex-shrink-0"
        :style="{ color: labelColor }"
      >
        {{ item.tool.label }}
      </span>
      <code
        class="text-xs font-semibold"
        :style="{
          fontFamily: 'var(--ac-font-mono)',
          color: 'var(--ac-text)',
        }"
        :title="item.tool.filePath"
      >
        {{ item.tool.title }}
      </code>
      <!-- Diff Stats Badge -->
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
        <span
          v-if="
            !item.tool.diffStats?.addedLines &&
            !item.tool.diffStats?.deletedLines &&
            item.tool.diffStats?.totalLines
          "
        >
          {{ item.tool.diffStats.totalLines }} lines
        </span>
      </span>
    </div>

    <!-- File Path (if different from title) -->
    <div
      v-if="showFilePath"
      class="text-[10px] pl-10 truncate"
      :style="{ color: 'var(--ac-text-subtle)' }"
      :title="item.tool.filePath"
    >
      {{ item.tool.filePath }}
    </div>

    <!-- Result Card -->
    <div
      v-if="showCard"
      class="overflow-hidden text-xs leading-5"
      :style="{
        fontFamily: 'var(--ac-font-mono)',
        border: 'var(--ac-border-width) solid var(--ac-code-border)',
        boxShadow: 'var(--ac-shadow-card)',
        borderRadius: 'var(--ac-radius-inner)',
      }"
    >
      <!-- File list for edit -->
      <template v-if="item.tool.kind === 'edit' && item.tool.files?.length">
        <div
          v-for="(file, idx) in item.tool.files.slice(0, 5)"
          :key="file"
          class="px-3 py-1"
          :style="{
            backgroundColor: 'var(--ac-surface)',
            borderBottom:
              idx === Math.min(item.tool.files.length, 5) - 1
                ? 'none'
                : 'var(--ac-border-width) solid var(--ac-border)',
            color: 'var(--ac-text-muted)',
          }"
        >
          {{ file }}
        </div>
        <div
          v-if="item.tool.files.length > 5"
          class="px-3 py-1 text-[10px]"
          :style="{
            backgroundColor: 'var(--ac-surface-muted)',
            color: 'var(--ac-text-subtle)',
          }"
        >
          +{{ item.tool.files.length - 5 }} more files
        </div>
      </template>

      <!-- Command output -->
      <template v-else-if="item.tool.kind === 'run' && item.tool.details">
        <div
          class="px-3 py-2 whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto ac-scroll"
          :style="{
            backgroundColor: 'var(--ac-code-bg)',
            color: 'var(--ac-code-text)',
          }"
        >
          {{ truncatedDetails }}
        </div>
        <button
          v-if="isDetailsTruncated"
          class="w-full px-3 py-1 text-[10px] text-left cursor-pointer"
          :style="{
            backgroundColor: 'var(--ac-surface-muted)',
            color: 'var(--ac-link)',
          }"
          @click="expanded = !expanded"
        >
          {{ expanded ? 'Show less' : 'Show more...' }}
        </button>
      </template>

      <!-- Generic details -->
      <template v-else-if="item.tool.details">
        <div
          class="px-3 py-2 whitespace-pre-wrap break-words max-h-[150px] overflow-y-auto ac-scroll"
          :style="{
            backgroundColor: 'var(--ac-code-bg)',
            color: 'var(--ac-code-text)',
          }"
        >
          {{ truncatedDetails }}
        </div>
        <button
          v-if="isDetailsTruncated"
          class="w-full px-3 py-1 text-[10px] text-left cursor-pointer"
          :style="{
            backgroundColor: 'var(--ac-surface-muted)',
            color: 'var(--ac-link)',
          }"
          @click="expanded = !expanded"
        >
          {{ expanded ? 'Show less' : 'Show more...' }}
        </button>
      </template>
    </div>

    <!-- Error indicator -->
    <div v-if="item.isError" class="text-[11px]" :style="{ color: 'var(--ac-danger)' }">
      Error occurred
    </div>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed } from 'vue';
import type { TimelineItem } from '../../../composables/useAgentThreads';

const props = defineProps<{
  item: Extract<TimelineItem, { kind: 'tool_result' }>;
}>();

const expanded = ref(false);
const MAX_LINES = 10;
const MAX_CHARS = 500;

const labelColor = computed(() => {
  if (props.item.isError) {
    return 'var(--ac-danger)';
  }
  if (props.item.tool.kind === 'edit') {
    return 'var(--ac-accent)';
  }
  return 'var(--ac-success)';
});

const hasDiffStats = computed(() => {
  const stats = props.item.tool.diffStats;
  if (!stats) return false;
  return (
    stats.addedLines !== undefined ||
    stats.deletedLines !== undefined ||
    stats.totalLines !== undefined
  );
});

const showFilePath = computed(() => {
  const tool = props.item.tool;
  // Show full path if title is just the filename
  if (!tool.filePath) return false;
  return tool.filePath !== tool.title && !tool.title.includes('/');
});

const showCard = computed(() => {
  const tool = props.item.tool;
  return (
    (tool.kind === 'edit' && tool.files?.length) ||
    (tool.kind === 'run' && tool.details) ||
    tool.details
  );
});

const isDetailsTruncated = computed(() => {
  const details = props.item.tool.details ?? '';
  const lines = details.split('\n');
  return lines.length > MAX_LINES || details.length > MAX_CHARS;
});

const truncatedDetails = computed(() => {
  const details = props.item.tool.details ?? '';
  if (expanded.value) {
    return details;
  }

  const lines = details.split('\n');
  if (lines.length > MAX_LINES) {
    return lines.slice(0, MAX_LINES).join('\n');
  }
  if (details.length > MAX_CHARS) {
    return details.slice(0, MAX_CHARS);
  }
  return details;
});
</script>
