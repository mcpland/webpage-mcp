<template>
  <div
    ref="chipRef"
    class="relative inline-flex items-center gap-1.5 text-[11px] leading-none flex-shrink-0 select-none transition-colors"
    :style="chipContainerStyle"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
  >
    <!-- Main Toggle Area (click to include/exclude) -->
    <button
      type="button"
      class="inline-flex items-center gap-1.5 px-2 py-1 bg-transparent border-none cursor-pointer"
      :aria-pressed="!excluded"
      :aria-label="ariaLabel"
      @click="handleToggle"
      @focus="handleFocus"
      @blur="handleBlur"
    >
      <!-- Change Type Icon -->
      <span class="inline-flex items-center justify-center w-3.5 h-3.5" :style="typeIconStyle">
        <!-- Style Icon -->
        <svg
          v-if="element.type === 'style'"
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

        <!-- Text Icon -->
        <svg
          v-else-if="element.type === 'text'"
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
            d="M4 6h16M4 12h10M4 18h12"
          />
        </svg>

        <!-- Class Icon -->
        <svg
          v-else-if="element.type === 'class'"
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
            d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"
          />
        </svg>

        <!-- Mixed Icon (layers) -->
        <svg
          v-else
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
            d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
          />
        </svg>
      </span>

      <!-- Element Label (tagName only) -->
      <span class="truncate max-w-[140px]" :style="labelStyle">
        {{ chipTagName }}
      </span>

      <!-- Include/Exclude State Pill -->
      <span class="ml-0.5 px-1 py-0.5 text-[9px] uppercase tracking-wider" :style="statePillStyle">
        {{ excluded ? 'ex' : 'in' }}
      </span>
    </button>

    <!-- Revert Button (visible on hover) -->
    <button
      v-show="isHovering"
      type="button"
      class="flex items-center justify-center w-4 h-4 -ml-1 mr-1 rounded-full transition-colors cursor-pointer"
      :style="revertButtonStyle"
      :aria-label="`Revert changes to ${element.label}`"
      :title="`Revert all changes to ${element.label}`"
      @click.stop.prevent="handleRevert"
    >
      <svg
        class="w-2.5 h-2.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        stroke-width="2.5"
        aria-hidden="true"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>

  <!-- Tooltip - Teleported to agent-theme root to avoid overflow clipping while preserving theme -->
  <Teleport :to="tooltipTarget" :disabled="!tooltipTarget">
    <Transition name="tooltip-fade">
      <div
        v-if="showTooltip"
        class="fixed pointer-events-none"
        :style="tooltipPositionStyle"
        role="tooltip"
      >
        <div class="px-3 py-2 text-[11px] space-y-1.5" :style="tooltipStyle">
          <!-- Full Label -->
          <div class="font-medium truncate max-w-[320px]" :style="tooltipLabelStyle">
            {{ element.fullLabel || element.label }}
          </div>

          <!-- Meta Info -->
          <div class="text-[10px] flex items-center gap-2" :style="tooltipMetaStyle">
            <span :style="tooltipMonoStyle">{{ element.type }}</span>
            <span class="opacity-50">&middot;</span>
            <span>{{ excluded ? 'Excluded' : 'Included' }}</span>
            <span class="opacity-50">&middot;</span>
            <span
              >{{ element.transactionIds.length }} change{{
                element.transactionIds.length !== 1 ? 's' : ''
              }}</span
            >
          </div>

          <!-- Style Changes -->
          <div v-if="element.changes.style" class="text-[10px] space-y-0.5">
            <div class="flex items-center gap-2">
              <span class="font-medium">Style</span>
              <span :style="tooltipMutedMonoStyle">
                <template v-if="element.changes.style.added > 0">
                  <span :style="{ color: 'var(--ac-success, #10b981)' }"
                    >+{{ element.changes.style.added }}</span
                  >
                </template>
                <template v-if="element.changes.style.modified > 0">
                  <span v-if="element.changes.style.added > 0" class="mx-0.5">/</span>
                  <span :style="{ color: 'var(--ac-warning, #f59e0b)' }"
                    >~{{ element.changes.style.modified }}</span
                  >
                </template>
                <template v-if="element.changes.style.removed > 0">
                  <span
                    v-if="element.changes.style.added > 0 || element.changes.style.modified > 0"
                    class="mx-0.5"
                    >/</span
                  >
                  <span :style="{ color: 'var(--ac-danger, #ef4444)' }"
                    >-{{ element.changes.style.removed }}</span
                  >
                </template>
              </span>
            </div>
            <div v-if="styleDetailsText" :style="tooltipDetailsStyle">
              {{ styleDetailsText }}
            </div>
          </div>

          <!-- Text Changes -->
          <div v-if="element.changes.text" class="text-[10px] space-y-0.5">
            <div class="font-medium">Text</div>
            <div class="flex items-start gap-2">
              <span class="opacity-60 w-10 flex-shrink-0">before</span>
              <code class="truncate max-w-[260px]" :style="codeStyle">
                {{ element.changes.text.beforePreview || '(empty)' }}
              </code>
            </div>
            <div class="flex items-start gap-2">
              <span class="opacity-60 w-10 flex-shrink-0">after</span>
              <code class="truncate max-w-[260px]" :style="codeStyle">
                {{ element.changes.text.afterPreview || '(empty)' }}
              </code>
            </div>
          </div>

          <!-- Class Changes -->
          <div v-if="element.changes.class && hasClassChanges" class="text-[10px] space-y-0.5">
            <div class="font-medium">Class</div>
            <div v-if="classAddedText" :style="tooltipDetailsStyle">
              <span :style="{ color: 'var(--ac-success, #10b981)' }">+</span> {{ classAddedText }}
            </div>
            <div v-if="classRemovedText" :style="tooltipDetailsStyle">
              <span :style="{ color: 'var(--ac-danger, #ef4444)' }">-</span> {{ classRemovedText }}
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script lang="ts" setup>
import { computed, ref, onMounted, onUnmounted, inject, watch, type Ref } from 'vue';
import type { ElementChangeSummary, WebEditorElementKey } from '@/common/web-editor-types';

// =============================================================================
// Props & Emits
// =============================================================================

const props = withDefaults(
  defineProps<{
    /** Element change summary to display */
    element: ElementChangeSummary;
    /** Whether this element is excluded from Apply */
    excluded: boolean;
    /** Whether this element is currently selected in web-editor */
    selected?: boolean;
  }>(),
  {
    selected: false,
  },
);

const emit = defineEmits<{
  /** Toggle include/exclude state */
  'toggle:exclude': [elementKey: WebEditorElementKey];
  /** Revert element to original state (Phase 2 - Selective Undo) */
  revert: [elementKey: WebEditorElementKey];
  /** Mouse enter - start highlight */
  'hover:start': [element: ElementChangeSummary];
  /** Mouse leave - clear highlight */
  'hover:end': [element: ElementChangeSummary];
}>();

// =============================================================================
// Local State
// =============================================================================

const chipRef = ref<HTMLDivElement | null>(null);
const isHovering = ref(false);
const isFocused = ref(false);

/** Cached chip position for tooltip placement */
const chipRect = ref<DOMRect | null>(null);

/** Teleport target - find .agent-theme ancestor for theme variable inheritance */
const tooltipTarget = ref<Element | null>(null);

/**
 * Inject scroll/resize trigger from parent WebEditorChanges component.
 * This centralizes event listeners for better performance.
 */
const scrollResizeTrigger = inject<Ref<number>>('scrollResizeTrigger');

// =============================================================================
// Computed: UI State
// =============================================================================

/**
 * Extract tagName from label for compact chip display.
 * Label format is usually "tagName#id.class" or "tagName.class"
 */
const chipTagName = computed(() => {
  const label = (props.element.label || '').trim();
  // Extract tagName (first part before #, ., or space)
  const match = label.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  return match?.[1]?.toLowerCase() || 'element';
});

const showTooltip = computed(() => isHovering.value || isFocused.value);

/** Calculate tooltip position based on chip element position */
const tooltipPositionStyle = computed(() => {
  const rect = chipRect.value;
  if (!rect) {
    return {
      opacity: 0,
      zIndex: 9999,
    };
  }

  // Position tooltip centered above the chip
  const tooltipWidth = 300; // Approximate max width
  const gap = 8; // Gap between chip and tooltip

  // Calculate left position, clamped to viewport
  let left = rect.left + rect.width / 2 - tooltipWidth / 2;
  const viewportWidth = window.innerWidth;
  const padding = 8;

  if (left < padding) {
    left = padding;
  } else if (left + tooltipWidth > viewportWidth - padding) {
    left = viewportWidth - tooltipWidth - padding;
  }

  return {
    left: `${left}px`,
    top: `${rect.top - gap}px`,
    transform: 'translateY(-100%)',
    zIndex: 9999,
  };
});

const ariaLabel = computed(() => {
  const state = props.excluded ? 'excluded' : 'included';
  return `${props.element.label} (${props.element.type} change, ${state}). Click to toggle.`;
});

// =============================================================================
// Computed: Styles
// =============================================================================

const chipContainerStyle = computed(() => {
  const active = showTooltip.value;
  const isSelected = props.selected;

  // Selected elements get accent border
  const borderColor = isSelected
    ? 'var(--ac-accent)'
    : active
      ? 'var(--ac-border-strong)'
      : 'var(--ac-border)';

  return {
    backgroundColor: active ? 'var(--ac-hover-bg)' : 'var(--ac-surface)',
    border: `var(--ac-border-width) solid ${borderColor}`,
    borderRadius: 'var(--ac-radius-button)',
    boxShadow: active ? 'var(--ac-shadow-card)' : 'none',
    color: props.excluded ? 'var(--ac-text-subtle)' : 'var(--ac-text-muted)',
    opacity: props.excluded ? 0.7 : 1,
  };
});

const revertButtonStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface-muted)',
  color: 'var(--ac-text-subtle)',
  cursor: 'pointer',
  // Hover state handled via CSS :hover
}));

const typeIconStyle = computed(() => ({
  color: props.excluded ? 'var(--ac-text-subtle)' : 'var(--ac-accent)',
}));

const labelStyle = computed(() => ({
  fontFamily: 'var(--ac-font-mono)',
}));

const statePillStyle = computed(() => ({
  backgroundColor: props.excluded ? 'var(--ac-surface-muted)' : 'var(--ac-accent)',
  color: props.excluded ? 'var(--ac-text-subtle)' : 'var(--ac-accent-contrast)',
  borderRadius: 'var(--ac-radius-button)',
  fontFamily: 'var(--ac-font-mono)',
  fontWeight: '600',
}));

const tooltipStyle = computed(() => ({
  backgroundColor: 'var(--ac-surface)',
  border: 'var(--ac-border-width) solid var(--ac-border)',
  borderRadius: 'var(--ac-radius-inner)',
  boxShadow: 'var(--ac-shadow-float)',
  color: 'var(--ac-text)',
  minWidth: '240px',
  maxWidth: '360px',
}));

const tooltipLabelStyle = computed(() => ({
  fontFamily: 'var(--ac-font-mono)',
}));

const tooltipMetaStyle = computed(() => ({
  color: 'var(--ac-text-subtle)',
}));

const tooltipMonoStyle = computed(() => ({
  fontFamily: 'var(--ac-font-mono)',
}));

const tooltipMutedMonoStyle = computed(() => ({
  fontFamily: 'var(--ac-font-mono)',
  color: 'var(--ac-text-muted)',
}));

const tooltipDetailsStyle = computed(() => ({
  fontFamily: 'var(--ac-font-mono)',
  color: 'var(--ac-text-subtle)',
}));

const codeStyle = computed(() => ({
  fontFamily: 'var(--ac-font-mono)',
  backgroundColor: 'var(--ac-surface-muted)',
  borderRadius: 'var(--ac-radius-button)',
  padding: '1px 4px',
  color: 'var(--ac-text)',
}));

// =============================================================================
// Computed: Content Formatting
// =============================================================================

const styleDetailsText = computed(() => {
  const details = props.element.changes.style?.details;
  if (!details || details.length === 0) return '';
  return formatListWithLimit(details, 6);
});

const hasClassChanges = computed(() => {
  const cls = props.element.changes.class;
  if (!cls) return false;
  return (cls.added?.length ?? 0) > 0 || (cls.removed?.length ?? 0) > 0;
});

const classAddedText = computed(() => {
  const added = props.element.changes.class?.added;
  if (!added || added.length === 0) return '';
  return formatListWithLimit(added, 4);
});

const classRemovedText = computed(() => {
  const removed = props.element.changes.class?.removed;
  if (!removed || removed.length === 0) return '';
  return formatListWithLimit(removed, 4);
});

// =============================================================================
// Helpers
// =============================================================================

/**
 * Format a list of items with a display limit.
 * @param items - Array of strings to format
 * @param limit - Maximum number of items to show
 * @returns Formatted string with overflow indicator
 */
function formatListWithLimit(items: readonly string[], limit: number): string {
  const cleaned = items.map((s) => String(s ?? '').trim()).filter(Boolean);

  if (cleaned.length === 0) return '';

  const visible = cleaned.slice(0, limit);
  const overflow = cleaned.length - visible.length;

  if (overflow > 0) {
    return `${visible.join(', ')} (+${overflow} more)`;
  }

  return visible.join(', ');
}

// =============================================================================
// Event Handlers
// =============================================================================

/** Update cached chip position for tooltip placement */
function updateChipRect(): void {
  if (chipRef.value) {
    chipRect.value = chipRef.value.getBoundingClientRect();
  }
}

function handleToggle(): void {
  emit('toggle:exclude', props.element.elementKey);
}

function handleRevert(): void {
  emit('revert', props.element.elementKey);
}

function handleMouseEnter(): void {
  updateChipRect();
  isHovering.value = true;
  emit('hover:start', props.element);
}

function handleMouseLeave(): void {
  isHovering.value = false;
  emit('hover:end', props.element);
}

function handleFocus(): void {
  updateChipRect();
  isFocused.value = true;
}

function handleBlur(): void {
  isFocused.value = false;
}

// =============================================================================
// Lifecycle - Handle scroll/resize updates
// =============================================================================

/**
 * Watch for scroll/resize trigger changes from parent component.
 * This replaces per-instance event listeners with a centralized approach.
 */
watch(
  () => scrollResizeTrigger?.value,
  () => {
    if (showTooltip.value) {
      updateChipRect();
    }
  },
);

onMounted(() => {
  // Find .agent-theme ancestor for tooltip teleport (preserves theme CSS variables)
  if (chipRef.value) {
    const agentTheme = chipRef.value.closest('.agent-theme');
    tooltipTarget.value = agentTheme;
  }
});

onUnmounted(() => {
  // Clear any active highlight when chip is unmounted (e.g., when toggling include/exclude)
  if (isHovering.value) {
    emit('hover:end', props.element);
  }
});
</script>

<style>
/* Tooltip transition styles - not scoped because tooltip is teleported to body */
.tooltip-fade-enter-active,
.tooltip-fade-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
}

.tooltip-fade-enter-from,
.tooltip-fade-leave-to {
  opacity: 0;
  transform: translateY(calc(-100% + 4px));
}

.tooltip-fade-enter-to,
.tooltip-fade-leave-from {
  opacity: 1;
  transform: translateY(-100%);
}
</style>

<style scoped>
/* Revert button hover effect */
button[aria-label^='Revert']:hover {
  background-color: var(--ac-danger, #ef4444) !important;
  color: white !important;
}
</style>
