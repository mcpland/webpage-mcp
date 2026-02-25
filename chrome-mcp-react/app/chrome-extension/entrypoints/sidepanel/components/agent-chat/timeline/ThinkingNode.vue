<template>
  <!-- Use span-based structure to avoid invalid DOM when rendered inside <p> -->
  <span class="thinking-section">
    <button
      type="button"
      class="thinking-header"
      :class="{ 'thinking-header--expandable': canExpand }"
      :aria-expanded="canExpand ? expanded : undefined"
      :disabled="!canExpand"
      @click="toggle"
    >
      <svg
        class="thinking-icon"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
      </svg>

      <span v-if="isLoading" class="thinking-loading">
        <span class="thinking-pulse" aria-hidden="true" />
        Thinking...
      </span>
      <template v-else>
        <span class="thinking-summary" v-html="formatLine(firstLine)" />
        <span v-if="canExpand" class="thinking-toggle">
          <svg
            :class="{ 'thinking-toggle--expanded': expanded }"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
          {{ moreCount }} more {{ moreCount === 1 ? 'line' : 'lines' }}
        </span>
      </template>
    </button>

    <Transition name="thinking-expand">
      <span v-if="expanded && !isLoading && restLines.length > 0" class="thinking-content">
        <template v-for="(line, idx) in restLines" :key="idx">
          <span v-html="formatLine(line)" />
          <br v-if="idx < restLines.length - 1" />
        </template>
      </span>
    </Transition>
  </span>
</template>

<script lang="ts" setup>
import { computed, ref } from 'vue';

/**
 * Node type from markstream-vue for custom HTML tags.
 * When customHtmlTags=['thinking'] is set, the parser produces nodes with type='thinking'.
 */
interface ThinkingNodeType {
  type: 'thinking';
  tag?: string;
  content: string;
  raw: string;
  loading?: boolean;
  autoClosed?: boolean;
  attrs?: Array<[string, string]>;
}

const props = defineProps<{
  node: ThinkingNodeType;
  loading?: boolean;
  indexKey?: string;
  customId?: string;
  isDark?: boolean;
  typewriter?: boolean;
}>();

const expanded = ref(false);

/** Whether the node is still loading (streaming, tag not closed yet) */
const isLoading = computed(() => props.loading ?? props.node.loading ?? false);

/**
 * Extract inner text from the thinking node.
 * Prefer node.raw over node.content as content may lose line breaks in some cases.
 */
const innerText = computed(() => {
  // Try raw first (more reliable for preserving line breaks)
  const rawSrc = String(props.node.raw ?? '');
  if (rawSrc) {
    const rawMatch = rawSrc.match(/<thinking\b[^>]*>([\s\S]*?)<\/thinking>/i);
    if (rawMatch) {
      return rawMatch[1].trim();
    }
  }

  // Fallback to content
  const src = String(props.node.content ?? '');
  const match = src.match(/<thinking\b[^>]*>([\s\S]*?)<\/thinking>/i);
  if (match) {
    return match[1].trim();
  }

  // Strip opening/closing tags if present
  return src
    .replace(/^<thinking\b[^>]*>/i, '')
    .replace(/<\/thinking>\s*$/i, '')
    .trim();
});

/** Split content into lines, filtering empty ones */
const lines = computed(() => {
  return innerText.value.split('\n').filter((line) => line.trim());
});

/** First line shown as summary */
const firstLine = computed(() => {
  const line = lines.value[0] ?? '';
  // Strip leading/trailing ** for cleaner display
  return line.replace(/^\*\*/, '').replace(/\*\*$/, '');
});

/** Remaining lines for expanded view */
const restLines = computed(() => lines.value.slice(1));

/** Number of additional lines */
const moreCount = computed(() => restLines.value.length);

/** Whether the section can be expanded */
const canExpand = computed(() => !isLoading.value && moreCount.value > 0);

function toggle(): void {
  if (canExpand.value) {
    expanded.value = !expanded.value;
  }
}

/**
 * Format a line for display, converting **text** to <strong> tags.
 * Used with v-html for both summary and expanded content.
 */
function formatLine(text: string): string {
  // Escape HTML entities first
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  // Convert **text** to <strong>text</strong>
  return escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}
</script>

<style scoped>
.thinking-section {
  display: block;
  margin: 8px 0;
  padding-left: 12px;
  background: var(--ac-surface-muted);
  border-radius: var(--ac-radius-inner);
}

.thinking-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px;
  border: none;
  background: transparent;
  color: var(--ac-text-muted);
  font-size: 13px;
  font-style: italic;
  font-family: inherit;
  text-align: left;
  cursor: default;
}

.thinking-header--expandable {
  cursor: pointer;
  transition: color 0.15s ease;
}

.thinking-header--expandable:hover {
  color: var(--ac-text);
}

.thinking-header--expandable:focus-visible {
  outline: 2px solid var(--ac-accent);
  outline-offset: -2px;
  border-radius: var(--ac-radius-inner);
}

.thinking-icon {
  flex-shrink: 0;
  opacity: 0.7;
}

.thinking-loading {
  display: flex;
  align-items: center;
  gap: 6px;
}

.thinking-pulse {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ac-accent);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.4;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}

.thinking-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thinking-summary :deep(strong) {
  font-weight: 600;
  color: var(--ac-text-muted);
}

.thinking-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--ac-text-subtle);
}

.thinking-toggle svg {
  transition: transform 0.2s ease;
}

.thinking-toggle--expanded {
  transform: rotate(180deg);
}

.thinking-content {
  display: block;
  padding: 0 8px 8px;
  color: var(--ac-text-subtle);
  font-size: 13px;
  font-style: italic;
  line-height: 1.6;
}

.thinking-content :deep(strong) {
  font-weight: 600;
  color: var(--ac-text-muted);
}

/* Expand animation */
.thinking-expand-enter-active,
.thinking-expand-leave-active {
  transition:
    opacity 0.2s ease,
    max-height 0.2s ease;
  overflow: hidden;
}

.thinking-expand-enter-from,
.thinking-expand-leave-to {
  opacity: 0;
  max-height: 0;
}

.thinking-expand-enter-to,
.thinking-expand-leave-from {
  opacity: 1;
  max-height: 500px;
}
</style>
