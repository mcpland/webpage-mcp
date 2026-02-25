<template>
  <div ref="shellRef" class="h-full flex flex-col overflow-hidden relative">
    <!-- Header -->
    <header
      class="flex-none px-5 py-3 flex items-center justify-between z-20"
      :style="{
        backgroundColor: 'var(--ac-header-bg)',
        borderBottom: 'var(--ac-border-width) solid var(--ac-header-border)',
        backdropFilter: 'blur(8px)',
      }"
    >
      <slot name="header" />
    </header>

    <!-- Content Area -->
    <main
      ref="contentRef"
      class="flex-1 overflow-y-auto ac-scroll"
      :style="{
        paddingBottom: composerHeight + 'px',
      }"
      @scroll="handleScroll"
    >
      <!-- Stable wrapper for ResizeObserver -->
      <div ref="contentSlotRef">
        <slot name="content" />
      </div>
    </main>

    <!-- Footer / Composer -->
    <footer
      ref="composerRef"
      class="flex-none px-5 pb-5 pt-2"
      :style="{
        background: `linear-gradient(to top, var(--ac-bg), var(--ac-bg), transparent)`,
      }"
    >
      <!-- Error Banner (above input) -->
      <div
        v-if="errorMessage"
        class="mb-2 px-4 py-2 text-xs rounded-lg flex items-start gap-2"
        :style="{
          backgroundColor: 'var(--ac-diff-del-bg)',
          color: 'var(--ac-danger)',
          border: 'var(--ac-border-width) solid var(--ac-diff-del-border)',
          borderRadius: 'var(--ac-radius-inner)',
        }"
      >
        <!-- Error message with scroll for long content -->
        <div
          class="min-w-0 flex-1 whitespace-pre-wrap break-all ac-scroll"
          :style="{ maxHeight: '30vh', overflowY: 'auto', overflowWrap: 'anywhere' }"
        >
          {{ errorMessage }}
        </div>

        <!-- Dismiss button -->
        <button
          type="button"
          class="p-1 flex-shrink-0 ac-btn ac-focus-ring cursor-pointer"
          :style="{
            color: 'var(--ac-danger)',
            borderRadius: 'var(--ac-radius-button)',
          }"
          aria-label="Dismiss error"
          title="Dismiss"
          @click="emit('error:dismiss')"
        >
          <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      <slot name="composer" />

      <!-- Usage & Version label -->
      <div
        class="text-[10px] text-center mt-2 font-medium tracking-wide flex items-center justify-center gap-2"
        :style="{ color: 'var(--ac-text-subtle)' }"
      >
        <template v-if="usage">
          <span
            :title="`Input: ${usage.inputTokens.toLocaleString()}, Output: ${usage.outputTokens.toLocaleString()}`"
          >
            {{ formatTokens(usage.inputTokens + usage.outputTokens) }} tokens
          </span>
          <span class="opacity-50">·</span>
          <span
            :title="`Duration: ${(usage.durationMs / 1000).toFixed(1)}s, Turns: ${usage.numTurns}`"
          >
            ${{ usage.totalCostUsd.toFixed(4) }}
          </span>
          <span class="opacity-50">·</span>
        </template>
        <span>{{ footerLabel || 'Agent Preview' }}</span>
      </div>
    </footer>
  </div>
</template>

<script lang="ts" setup>
import { ref, onMounted, onUnmounted } from 'vue';
import type { AgentUsageStats } from 'webpage-mcp-shared';

defineProps<{
  errorMessage?: string | null;
  usage?: AgentUsageStats | null;
  /** Footer label to display (e.g., "Claude Code Preview", "Codex Preview") */
  footerLabel?: string;
}>();

const emit = defineEmits<{
  /** Emitted when user clicks dismiss button on error banner */
  'error:dismiss': [];
}>();

/**
 * Format token count for display (e.g., 1.2k, 3.5M)
 */
function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return (count / 1_000_000).toFixed(1) + 'M';
  }
  if (count >= 1_000) {
    return (count / 1_000).toFixed(1) + 'k';
  }
  return count.toString();
}

const shellRef = ref<HTMLElement | null>(null);
const contentRef = ref<HTMLElement | null>(null);
const contentSlotRef = ref<HTMLElement | null>(null);
const composerRef = ref<HTMLElement | null>(null);
const composerHeight = ref(120); // Default height

// Auto-scroll state
const isUserScrolledUp = ref(false);
// Threshold should account for padding and some tolerance
const SCROLL_THRESHOLD = 150;

/**
 * Check if scroll position is near bottom
 */
function isNearBottom(el: HTMLElement): boolean {
  const { scrollTop, scrollHeight, clientHeight } = el;
  return scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD;
}

/**
 * Handle user scroll to track if they've scrolled up
 */
function handleScroll(): void {
  if (!contentRef.value) return;
  isUserScrolledUp.value = !isNearBottom(contentRef.value);
}

/**
 * Scroll to bottom of content area
 */
function scrollToBottom(behavior: ScrollBehavior = 'smooth'): void {
  if (!contentRef.value) return;
  contentRef.value.scrollTo({
    top: contentRef.value.scrollHeight,
    behavior,
  });
}

// Observers
let composerResizeObserver: ResizeObserver | null = null;
let contentResizeObserver: ResizeObserver | null = null;

// Scroll scheduling to prevent excessive calls during streaming
let scrollScheduled = false;

/**
 * Auto-scroll when content or composer changes (if user is at bottom)
 * Uses requestAnimationFrame to debounce rapid updates during streaming
 */
function maybeAutoScroll(): void {
  if (scrollScheduled || isUserScrolledUp.value || !contentRef.value) {
    return;
  }
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    if (!isUserScrolledUp.value) {
      scrollToBottom('auto');
    }
  });
}

onMounted(() => {
  // Observe composer height changes
  if (composerRef.value) {
    composerResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        composerHeight.value = entry.contentRect.height + 24; // Add padding
      }
      // Also auto-scroll when composer height changes (e.g., error banner appears)
      maybeAutoScroll();
    });
    composerResizeObserver.observe(composerRef.value);
  }

  // Observe content height changes for auto-scroll using stable wrapper
  if (contentSlotRef.value) {
    contentResizeObserver = new ResizeObserver(() => {
      maybeAutoScroll();
    });
    contentResizeObserver.observe(contentSlotRef.value);
  }
});

onUnmounted(() => {
  composerResizeObserver?.disconnect();
  contentResizeObserver?.disconnect();
});

// Expose scrollToBottom for parent component to call
defineExpose({
  scrollToBottom,
});
</script>
