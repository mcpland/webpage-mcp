/**
 * Vue composable for floating drag functionality.
 * Wraps the installFloatingDrag utility for use in Vue components.
 */

import { ref, onMounted, onUnmounted, type Ref } from 'vue';
import {
  installFloatingDrag,
  type FloatingPosition,
} from '@/entrypoints/web-editor-v2/ui/floating-drag';

const STORAGE_KEY = 'sidepanel_navigator_position';

export interface UseFloatingDragOptions {
  /** Storage key for position persistence */
  storageKey?: string;
  /** Margin from viewport edges in pixels */
  clampMargin?: number;
  /** Threshold for distinguishing click vs drag (ms) */
  clickThresholdMs?: number;
  /** Movement threshold for drag activation (px) */
  moveThresholdPx?: number;
  /** Default position calculator (called when no saved position exists) */
  getDefaultPosition?: () => FloatingPosition;
}

export interface UseFloatingDragReturn {
  /** Current position (reactive) */
  position: Ref<FloatingPosition>;
  /** Whether dragging is in progress */
  isDragging: Ref<boolean>;
  /** Reset position to default */
  resetToDefault: () => void;
  /** Computed style object for binding */
  positionStyle: Ref<{ left: string; top: string }>;
}

/**
 * Calculate default position (bottom-right corner with margin)
 */
function getDefaultBottomRightPosition(
  buttonSize: number = 40,
  margin: number = 12,
): FloatingPosition {
  return {
    left: window.innerWidth - buttonSize - margin,
    top: window.innerHeight - buttonSize - margin,
  };
}

/**
 * Load position from chrome.storage.local
 */
async function loadPosition(storageKey: string): Promise<FloatingPosition | null> {
  try {
    const result = await chrome.storage.local.get(storageKey);
    const saved = result[storageKey];
    if (
      saved &&
      typeof saved.left === 'number' &&
      typeof saved.top === 'number' &&
      Number.isFinite(saved.left) &&
      Number.isFinite(saved.top)
    ) {
      return saved as FloatingPosition;
    }
  } catch (e) {
    console.warn('Failed to load navigator position:', e);
  }
  return null;
}

/**
 * Save position to chrome.storage.local
 */
async function savePosition(storageKey: string, position: FloatingPosition): Promise<void> {
  try {
    await chrome.storage.local.set({ [storageKey]: position });
  } catch (e) {
    console.warn('Failed to save navigator position:', e);
  }
}

/**
 * Vue composable for making an element draggable with position persistence.
 */
export function useFloatingDrag(
  handleRef: Ref<HTMLElement | null>,
  targetRef: Ref<HTMLElement | null>,
  options: UseFloatingDragOptions = {},
): UseFloatingDragReturn {
  const {
    storageKey = STORAGE_KEY,
    clampMargin = 12,
    clickThresholdMs = 150,
    moveThresholdPx = 5,
    getDefaultPosition = () => getDefaultBottomRightPosition(40, clampMargin),
  } = options;

  const position = ref<FloatingPosition>(getDefaultPosition());
  const isDragging = ref(false);
  const positionStyle = ref({ left: `${position.value.left}px`, top: `${position.value.top}px` });

  let cleanup: (() => void) | null = null;

  function updatePositionStyle(): void {
    positionStyle.value = {
      left: `${position.value.left}px`,
      top: `${position.value.top}px`,
    };
  }

  function resetToDefault(): void {
    position.value = getDefaultPosition();
    updatePositionStyle();
    savePosition(storageKey, position.value);
  }

  async function initPosition(): Promise<void> {
    const saved = await loadPosition(storageKey);
    if (saved) {
      // Validate position is within current viewport
      const maxLeft = window.innerWidth - 40 - clampMargin;
      const maxTop = window.innerHeight - 40 - clampMargin;
      position.value = {
        left: Math.min(Math.max(clampMargin, saved.left), maxLeft),
        top: Math.min(Math.max(clampMargin, saved.top), maxTop),
      };
    } else {
      position.value = getDefaultPosition();
    }
    updatePositionStyle();
  }

  onMounted(async () => {
    await initPosition();

    // Wait for refs to be available
    await new Promise((resolve) => setTimeout(resolve, 0));

    if (!handleRef.value || !targetRef.value) {
      console.warn('useFloatingDrag: handleRef or targetRef is null');
      return;
    }

    cleanup = installFloatingDrag({
      handleEl: handleRef.value,
      targetEl: targetRef.value,
      onPositionChange: (pos) => {
        position.value = pos;
        updatePositionStyle();
        savePosition(storageKey, pos);
      },
      clampMargin,
      clickThresholdMs,
      moveThresholdPx,
    });

    // Monitor dragging state via data attribute
    const observer = new MutationObserver(() => {
      isDragging.value = handleRef.value?.dataset.dragging === 'true';
    });
    if (handleRef.value) {
      observer.observe(handleRef.value, { attributes: true, attributeFilter: ['data-dragging'] });
    }
  });

  onUnmounted(() => {
    cleanup?.();
  });

  return {
    position,
    isDragging,
    resetToDefault,
    positionStyle,
  };
}
