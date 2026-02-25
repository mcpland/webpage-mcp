<template>
  <div
    ref="chipRef"
    class="relative inline-flex items-center gap-1.5 text-[11px] leading-none flex-shrink-0 select-none"
    :style="chipStyle"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
  >
    <!-- Selection Icon -->
    <span class="inline-flex items-center justify-center w-3.5 h-3.5" :style="iconStyle">
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
          d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122"
        />
      </svg>
    </span>

    <!-- Element Label (tagName only) -->
    <span class="truncate max-w-[140px] px-1 py-0.5" :style="labelStyle">
      {{ chipTagName }}
    </span>

    <!-- "Selected" Indicator -->
    <span class="px-1 py-0.5 text-[9px] uppercase tracking-wider" :style="pillStyle"> sel </span>
  </div>
</template>

<script lang="ts" setup>
import { computed, ref, onUnmounted } from 'vue';
import type { SelectedElementSummary } from '@/common/web-editor-types';

// =============================================================================
// Props & Emits
// =============================================================================

const props = defineProps<{
  /** Selected element summary to display */
  selected: SelectedElementSummary;
}>();

const emit = defineEmits<{
  /** Mouse enter - start highlight */
  'hover:start': [selected: SelectedElementSummary];
  /** Mouse leave - clear highlight */
  'hover:end': [selected: SelectedElementSummary];
}>();

// =============================================================================
// Local State
// =============================================================================

const chipRef = ref<HTMLDivElement | null>(null);
const isHovering = ref(false);

// =============================================================================
// Computed: UI State
// =============================================================================

/**
 * Use tagName for compact chip display.
 * Falls back to extracting from label if tagName is not available.
 */
const chipTagName = computed(() => {
  // First try explicit tagName
  if (props.selected.tagName) {
    return props.selected.tagName.toLowerCase();
  }
  // Fallback: extract from label
  const label = (props.selected.label || '').trim();
  const match = label.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  return match?.[1]?.toLowerCase() || 'element';
});

// =============================================================================
// Computed: Styles
// =============================================================================

const chipStyle = computed(() => ({
  backgroundColor: isHovering.value ? 'var(--ac-hover-bg)' : 'var(--ac-surface)',
  border: `var(--ac-border-width) solid ${isHovering.value ? 'var(--ac-accent)' : 'var(--ac-border)'}`,
  borderRadius: 'var(--ac-radius-button)',
  boxShadow: isHovering.value ? 'var(--ac-shadow-card)' : 'none',
  color: 'var(--ac-text)',
  cursor: 'default',
}));

const iconStyle = computed(() => ({
  color: 'var(--ac-accent)',
}));

const labelStyle = computed(() => ({
  fontFamily: 'var(--ac-font-mono)',
}));

const pillStyle = computed(() => ({
  backgroundColor: 'var(--ac-accent)',
  color: 'var(--ac-accent-contrast)',
  borderRadius: 'var(--ac-radius-button)',
  fontFamily: 'var(--ac-font-mono)',
  fontWeight: '600',
}));

// =============================================================================
// Event Handlers
// =============================================================================

function handleMouseEnter(): void {
  isHovering.value = true;
  emit('hover:start', props.selected);
}

function handleMouseLeave(): void {
  isHovering.value = false;
  emit('hover:end', props.selected);
}

// =============================================================================
// Lifecycle
// =============================================================================

onUnmounted(() => {
  // Clear any active highlight when chip is unmounted
  // (e.g., when selection changes or element appears in edits)
  if (isHovering.value) {
    emit('hover:end', props.selected);
  }
});
</script>
