<template>
  <div
    ref="chipRef"
    class="inline-flex items-center gap-1.5 text-sm leading-none cursor-default"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
  >
    <!-- Icon -->
    <span
      class="inline-flex items-center justify-center w-5 h-5 rounded"
      :style="iconContainerStyle"
    >
      <svg
        class="w-3.5 h-3.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"
        />
      </svg>
    </span>

    <!-- Label -->
    <span class="font-medium" :style="{ color: 'var(--ac-text)' }">
      {{ displayText }}
    </span>

    <!-- Element count badge -->
    <span
      v-if="elementCount"
      class="px-1.5 py-0.5 text-[10px] font-medium rounded"
      :style="badgeStyle"
    >
      {{ elementCount }} element{{ elementCount === 1 ? '' : 's' }}
    </span>

    <!-- Expand icon (hint for hover) -->
    <svg
      class="w-3.5 h-3.5 opacity-50"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      :style="{ color: 'var(--ac-text-subtle)' }"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  </div>

  <!-- Tooltip - Teleported to agent-theme root -->
  <Teleport :to="tooltipTarget" :disabled="!tooltipTarget">
    <Transition name="apply-tooltip-fade">
      <div
        v-if="showTooltip"
        class="fixed"
        :style="tooltipPositionStyle"
        role="tooltip"
        @mouseenter="handleTooltipEnter"
        @mouseleave="handleTooltipLeave"
      >
        <div class="px-3 py-2.5 text-[11px] space-y-2" :style="tooltipStyle">
          <!-- Header -->
          <div class="flex items-center justify-between gap-4">
            <span class="font-semibold" :style="{ color: 'var(--ac-text)' }">
              Web Editor Apply
            </span>
            <span
              v-if="pageUrl"
              class="text-[10px] truncate max-w-[200px]"
              :style="{ color: 'var(--ac-text-subtle)', fontFamily: 'var(--ac-font-mono)' }"
            >
              {{ pageHostname }}
            </span>
          </div>

          <!-- Element labels -->
          <div v-if="elementLabels && elementLabels.length > 0" class="space-y-1">
            <div class="text-[10px]" :style="{ color: 'var(--ac-text-muted)' }">
              Modified elements:
            </div>
            <div class="flex flex-wrap gap-1">
              <span
                v-for="(label, i) in displayLabels"
                :key="i"
                class="px-1.5 py-0.5 text-[10px] rounded"
                :style="elementLabelStyle"
              >
                {{ label }}
              </span>
              <span
                v-if="remainingCount > 0"
                class="px-1.5 py-0.5 text-[10px] rounded"
                :style="{ color: 'var(--ac-text-subtle)' }"
              >
                +{{ remainingCount }} more
              </span>
            </div>
          </div>

          <!-- Prompt preview (truncated) -->
          <div class="space-y-1">
            <div class="text-[10px]" :style="{ color: 'var(--ac-text-muted)' }">
              Prompt preview:
            </div>
            <pre
              class="text-[10px] max-h-[100px] overflow-auto whitespace-pre-wrap break-all p-2 rounded"
              :style="preStyle"
              >{{ truncatedPrompt }}</pre
            >
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script lang="ts" setup>
import { computed, ref, onBeforeUnmount, onMounted } from 'vue';
import type { ThreadHeader, WebEditorApplyMeta } from '../../composables';

const props = defineProps<{
  header: ThreadHeader;
}>();

// Refs
const chipRef = ref<HTMLElement | null>(null);
const chipRect = ref<DOMRect | null>(null);
const tooltipTarget = ref<Element | null>(null);

// Hover/visibility state with delayed hide for better UX
const isTooltipOpen = ref(false);
const isHoveringChip = ref(false);
const isHoveringTooltip = ref(false);

const HIDE_DELAY_MS = 180;
let hideTimeout: ReturnType<typeof setTimeout> | null = null;

// Computed
const webEditorApply = computed<WebEditorApplyMeta | undefined>(() => props.header.webEditorApply);
const displayText = computed(() => props.header.displayText || 'Apply changes');
const elementCount = computed(() => webEditorApply.value?.elementCount);
const elementLabels = computed(() => webEditorApply.value?.elementLabels || []);
const pageUrl = computed(() => webEditorApply.value?.pageUrl);

const pageHostname = computed(() => {
  if (!pageUrl.value) return '';
  try {
    return new URL(pageUrl.value).hostname;
  } catch {
    return pageUrl.value;
  }
});

const displayLabels = computed(() => elementLabels.value.slice(0, 4));
const remainingCount = computed(() => Math.max(0, elementLabels.value.length - 4));

const truncatedPrompt = computed(() => {
  const full = props.header.fullContent;
  const maxLen = 500;
  if (full.length <= maxLen) return full;
  return full.slice(0, maxLen) + '...';
});

const showTooltip = computed(() => isTooltipOpen.value);

// Styles
const iconContainerStyle = computed(() => ({
  backgroundColor: 'var(--ac-accent)',
  color: 'var(--ac-accent-contrast)',
}));

const badgeStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted)',
  color: 'var(--ac-text-muted)',
}));

const tooltipStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface)',
  border: 'var(--ac-border-width) solid var(--ac-border)',
  borderRadius: 'var(--ac-radius-card)',
  boxShadow: 'var(--ac-shadow-float)',
  color: 'var(--ac-text)',
  minWidth: '280px',
  maxWidth: '400px',
}));

const elementLabelStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted)',
  color: 'var(--ac-text)',
  fontFamily: 'var(--ac-font-mono)',
}));

const preStyle = computed(() => ({
  backgroundColor: 'var(--ac-code-bg)',
  color: 'var(--ac-code-text)',
  fontFamily: 'var(--ac-font-mono)',
  border: 'var(--ac-border-width) solid var(--ac-code-border)',
}));

const tooltipPositionStyle = computed(() => {
  const rect = chipRect.value;
  if (!rect) {
    return { opacity: 0, zIndex: 9999 };
  }

  const tooltipWidth = 360;
  const gap = 8;
  let left = rect.left;
  const viewportWidth = window.innerWidth;
  const padding = 8;

  if (left + tooltipWidth > viewportWidth - padding) {
    left = viewportWidth - tooltipWidth - padding;
  }
  if (left < padding) {
    left = padding;
  }

  return {
    left: `${left}px`,
    top: `${rect.bottom + gap}px`,
    zIndex: 9999,
  };
});

// Event handlers
function updateChipRect(): void {
  if (chipRef.value) {
    chipRect.value = chipRef.value.getBoundingClientRect();
  }
}

function clearHideTimeout(): void {
  if (hideTimeout !== null) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }
}

function openTooltip(): void {
  clearHideTimeout();
  isTooltipOpen.value = true;
}

function scheduleCloseTooltip(): void {
  clearHideTimeout();
  hideTimeout = setTimeout(() => {
    if (!isHoveringChip.value && !isHoveringTooltip.value) {
      isTooltipOpen.value = false;
    }
  }, HIDE_DELAY_MS);
}

function handleMouseEnter(): void {
  updateChipRect();
  isHoveringChip.value = true;
  openTooltip();
}

function handleMouseLeave(): void {
  isHoveringChip.value = false;
  scheduleCloseTooltip();
}

function handleTooltipEnter(): void {
  isHoveringTooltip.value = true;
  openTooltip();
}

function handleTooltipLeave(): void {
  isHoveringTooltip.value = false;
  scheduleCloseTooltip();
}

// Lifecycle
onMounted(() => {
  if (chipRef.value) {
    const agentTheme = chipRef.value.closest('.agent-theme');
    tooltipTarget.value = agentTheme ?? document.body;
  }
});

onBeforeUnmount(() => {
  clearHideTimeout();
});
</script>

<style>
/* Tooltip transition - unique name to avoid conflicts with ElementChip */
.apply-tooltip-fade-enter-active,
.apply-tooltip-fade-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.apply-tooltip-fade-enter-from,
.apply-tooltip-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.apply-tooltip-fade-enter-to,
.apply-tooltip-fade-leave-from {
  opacity: 1;
  transform: translateY(0);
}
</style>
