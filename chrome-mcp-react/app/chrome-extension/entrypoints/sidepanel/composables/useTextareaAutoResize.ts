/**
 * Composable for textarea auto-resize functionality.
 * Automatically adjusts textarea height based on content while respecting min/max constraints.
 */
import { ref, watch, nextTick, onMounted, onUnmounted, type Ref } from 'vue';

export interface UseTextareaAutoResizeOptions {
  /** Ref to the textarea element */
  textareaRef: Ref<HTMLTextAreaElement | null>;
  /** Ref to the textarea value (for watching changes) */
  value: Ref<string>;
  /** Minimum height in pixels */
  minHeight?: number;
  /** Maximum height in pixels */
  maxHeight?: number;
}

export interface UseTextareaAutoResizeReturn {
  /** Current calculated height */
  height: Ref<number>;
  /** Whether content exceeds max height (textarea is overflowing) */
  isOverflowing: Ref<boolean>;
  /** Manually trigger height recalculation */
  recalculate: () => void;
}

const DEFAULT_MIN_HEIGHT = 50;
const DEFAULT_MAX_HEIGHT = 200;

/**
 * Composable for auto-resizing textarea based on content.
 *
 * Features:
 * - Automatically adjusts height on input
 * - Respects min/max height constraints
 * - Handles width changes (line wrapping affects height)
 * - Uses requestAnimationFrame for performance
 */
export function useTextareaAutoResize(
  options: UseTextareaAutoResizeOptions,
): UseTextareaAutoResizeReturn {
  const {
    textareaRef,
    value,
    minHeight = DEFAULT_MIN_HEIGHT,
    maxHeight = DEFAULT_MAX_HEIGHT,
  } = options;

  const height = ref<number>(minHeight);
  const isOverflowing = ref(false);

  let scheduled = false;
  let resizeObserver: ResizeObserver | null = null;
  let lastWidth = 0;

  /**
   * Calculate textarea height based on content.
   * Only updates the reactive `height` and `isOverflowing` refs.
   * The actual DOM height is controlled via :style binding in the template.
   */
  function recalculate(): void {
    const el = textareaRef.value;
    if (!el) return;

    // Temporarily set height to 'auto' to get accurate scrollHeight
    // Save current height to minimize visual flicker
    const currentHeight = el.style.height;
    el.style.height = 'auto';

    const contentHeight = el.scrollHeight;
    const clampedHeight = Math.min(maxHeight, Math.max(minHeight, contentHeight));

    // Restore height immediately (the actual height is controlled by Vue binding)
    el.style.height = currentHeight;

    // Update reactive state
    height.value = clampedHeight;
    // Add small tolerance (1px) to account for rounding
    isOverflowing.value = contentHeight > maxHeight + 1;
  }

  /**
   * Schedule height recalculation using requestAnimationFrame.
   * Batches multiple calls within the same frame for performance.
   */
  function scheduleRecalculate(): void {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      recalculate();
    });
  }

  // Watch value changes
  watch(
    value,
    async () => {
      await nextTick();
      scheduleRecalculate();
    },
    { flush: 'post' },
  );

  // Watch textarea ref changes (in case it's replaced)
  watch(
    textareaRef,
    async (newEl, oldEl) => {
      // Cleanup old observer
      if (resizeObserver && oldEl) {
        resizeObserver.unobserve(oldEl);
      }

      if (!newEl) return;

      await nextTick();
      scheduleRecalculate();

      // Setup new observer for width changes
      if (resizeObserver) {
        lastWidth = newEl.offsetWidth;
        resizeObserver.observe(newEl);
      }
    },
    { immediate: true },
  );

  onMounted(() => {
    const el = textareaRef.value;
    if (!el) return;

    // Initial calculation
    scheduleRecalculate();

    // Setup ResizeObserver for width changes
    // Width changes affect line wrapping, which affects scrollHeight
    if (typeof ResizeObserver !== 'undefined') {
      lastWidth = el.offsetWidth;
      resizeObserver = new ResizeObserver(() => {
        const current = textareaRef.value;
        if (!current) return;

        const currentWidth = current.offsetWidth;
        if (currentWidth !== lastWidth) {
          lastWidth = currentWidth;
          scheduleRecalculate();
        }
      });
      resizeObserver.observe(el);
    }
  });

  onUnmounted(() => {
    resizeObserver?.disconnect();
    resizeObserver = null;
  });

  return {
    height,
    isOverflowing,
    recalculate,
  };
}
