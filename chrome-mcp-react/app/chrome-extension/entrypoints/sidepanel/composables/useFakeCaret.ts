/**
 * Composable for rendering a "fake" caret overlay on top of a textarea.
 *
 * Implementation notes:
 * - We do NOT intercept input; we only compute caret coordinates.
 * - A hidden "mirror" element is used to measure caret position reliably with wrapping.
 * - The actual textarea input/IME/selection behavior is preserved.
 * - When calculation is unreliable (IME/selection/error), we fall back to native caret.
 */
import {
  computed,
  onUnmounted,
  ref,
  watch,
  type CSSProperties,
  type ComputedRef,
  type Ref,
} from 'vue';

// =============================================================================
// Types
// =============================================================================

export interface FakeCaretTrailPoint {
  x: number;
  y: number;
  alpha: number;
}

export interface UseFakeCaretOptions {
  /** Reference to the textarea element */
  textareaRef: Ref<HTMLTextAreaElement | null>;
  /**
   * Feature flag for enabling the fake caret.
   * When false, the composable will report showFakeCaret=false
   * and the caller should display the native caret.
   */
  enabled?: Ref<boolean>;
}

export interface UseFakeCaretReturn {
  /** Style for the overlay container (position: absolute, inset: 0) */
  overlayStyle: ComputedRef<CSSProperties>;
  /** Whether to show the fake caret (false when degraded) */
  showFakeCaret: ComputedRef<boolean>;
  /** Current X position of caret (animated) */
  caretX: Ref<number>;
  /** Current Y position of caret (animated) */
  caretY: Ref<number>;
  /** Trail points for comet tail effect */
  trail: Ref<FakeCaretTrailPoint[]>;
  /** Manually trigger position update */
  updatePosition: () => void;
}

// =============================================================================
// Constants
// =============================================================================

const MAX_TRAIL_POINTS = 24;
const TRAIL_DECAY = 0.86;
const TRAIL_MIN_ALPHA = 0.06;
const TRAIL_MIN_DISTANCE_PX = 0.35;
const SMOOTHING = 0.35;
const SNAP_DISTANCE_PX = 0.2;

// =============================================================================
// Helpers
// =============================================================================

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// =============================================================================
// Main Composable
// =============================================================================

export function useFakeCaret(options: UseFakeCaretOptions): UseFakeCaretReturn {
  // Default to disabled (opt-in) for safer rollout
  const enabled = options.enabled ?? ref(false);

  // Position state (animated values)
  const caretX = ref(0);
  const caretY = ref(0);
  const trail = ref<FakeCaretTrailPoint[]>([]);

  // Internal state
  const isFocused = ref(false);
  const isComposing = ref(false);
  const hasSelection = ref(false);
  const hasValidMeasurement = ref(false);
  const prefersReducedMotion = ref(false);

  // Target position (raw measurement)
  let targetX = 0;
  let targetY = 0;

  // Animation state
  let scheduled = false;
  let rafId: number | null = null;

  // Mirror element for measurement
  let mirrorEl: HTMLDivElement | null = null;
  let lastMirrorKey = '';

  // Resize observer
  let resizeObserver: ResizeObserver | null = null;

  // Trail tracking
  let lastTrailX = 0;
  let lastTrailY = 0;

  // Disposed flag to prevent operations after unmount
  let disposed = false;

  // ---------------------------------------------------------------------------
  // Computed Properties
  // ---------------------------------------------------------------------------

  const overlayStyle = computed<CSSProperties>(() => ({
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    overflow: 'hidden',
  }));

  const showFakeCaret = computed<boolean>(() => {
    if (!enabled.value) return false;
    const el = options.textareaRef.value;
    if (!el) return false;
    if (!isFocused.value) return false;
    if (isComposing.value) return false;
    if (hasSelection.value) return false;
    return hasValidMeasurement.value;
  });

  // ---------------------------------------------------------------------------
  // Mirror Element Management
  // ---------------------------------------------------------------------------

  function ensureMirror(): HTMLDivElement | null {
    if (disposed) return null;
    if (mirrorEl) return mirrorEl;
    if (typeof document === 'undefined' || !document.body) return null;

    const el = document.createElement('div');
    el.setAttribute('data-ac-fake-caret-mirror', 'true');
    el.style.position = 'fixed';
    el.style.top = '0';
    el.style.left = '-10000px';
    el.style.visibility = 'hidden';
    el.style.pointerEvents = 'none';
    el.style.whiteSpace = 'pre-wrap';
    el.style.wordBreak = 'break-word';
    el.style.overflowWrap = 'break-word';
    el.style.overflow = 'auto';
    el.style.contain = 'layout style paint';
    el.style.border = '0';
    el.style.background = 'transparent';

    document.body.appendChild(el);
    mirrorEl = el;
    return mirrorEl;
  }

  function syncMirrorStyle(textarea: HTMLTextAreaElement, mirror: HTMLDivElement): void {
    const cs = window.getComputedStyle(textarea);

    // clientWidth includes padding but excludes scrollbar
    const width = `${textarea.clientWidth}px`;
    const height = `${textarea.clientHeight}px`;
    const tabSize = cs.getPropertyValue('tab-size');

    // Build cache key to avoid unnecessary style updates
    const key = [
      width,
      height,
      cs.font,
      cs.padding,
      cs.letterSpacing,
      cs.lineHeight,
      cs.textTransform,
      cs.textIndent,
      cs.textAlign,
      cs.direction,
      tabSize,
    ].join('|');

    if (key === lastMirrorKey) return;
    lastMirrorKey = key;

    mirror.style.boxSizing = 'border-box';
    mirror.style.width = width;
    mirror.style.height = height;
    mirror.style.padding = cs.padding;
    mirror.style.font = cs.font;
    mirror.style.letterSpacing = cs.letterSpacing;
    mirror.style.lineHeight = cs.lineHeight;
    mirror.style.textTransform = cs.textTransform;
    mirror.style.textIndent = cs.textIndent;
    mirror.style.textAlign = cs.textAlign;
    mirror.style.direction = cs.direction;

    if (tabSize) {
      mirror.style.setProperty('tab-size', tabSize);
    }
  }

  // ---------------------------------------------------------------------------
  // Caret Position Measurement
  // ---------------------------------------------------------------------------

  function measureCaret(textarea: HTMLTextAreaElement): { x: number; y: number } | null {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    if (!isFiniteNumber(start) || !isFiniteNumber(end)) {
      hasSelection.value = false;
      return null;
    }

    hasSelection.value = start !== end;
    if (hasSelection.value) return null;
    if (isComposing.value) return null;
    if (textarea.clientWidth <= 0 || textarea.clientHeight <= 0) return null;

    const mirror = ensureMirror();
    if (!mirror) return null;

    syncMirrorStyle(textarea, mirror);

    // Keep mirror scroll in sync
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;

    // Build mirror DOM: [beforeText][marker]
    mirror.innerHTML = '';
    const beforeText = textarea.value.slice(0, start);
    mirror.appendChild(document.createTextNode(beforeText));

    const marker = document.createElement('span');
    marker.textContent = '\u200b'; // Zero-width space
    marker.style.display = 'inline-block';
    marker.style.width = '1px';
    marker.style.height = '1em';
    mirror.appendChild(marker);

    const markerRect = marker.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();

    const x = markerRect.left - mirrorRect.left;
    const y = markerRect.top - mirrorRect.top;

    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;

    // Clamp to textarea viewport
    const clampedX = clamp(x, 0, textarea.clientWidth + 2);
    const clampedY = clamp(y, 0, textarea.clientHeight + 2);

    // If wildly off, treat as invalid
    if (Math.abs(clampedX - x) > 20 || Math.abs(clampedY - y) > 20) {
      return null;
    }

    return { x: clampedX, y: clampedY };
  }

  // ---------------------------------------------------------------------------
  // Position Updates
  // ---------------------------------------------------------------------------

  function applyTarget(x: number, y: number): void {
    const positionChanged = targetX !== x || targetY !== y;
    targetX = x;
    targetY = y;

    // Skip animation if reduced motion preferred
    if (prefersReducedMotion.value) {
      caretX.value = x;
      caretY.value = y;
      trail.value = [];
      lastTrailX = x;
      lastTrailY = y;
      return;
    }

    // Restart RAF if position changed (may have been stopped when idle)
    if (positionChanged && showFakeCaret.value) {
      startLoop();
    }
  }

  function updateNow(): void {
    const textarea = options.textareaRef.value;
    if (!textarea) {
      hasValidMeasurement.value = false;
      return;
    }

    // Only measure when we intend to show the fake caret
    if (!enabled.value || !isFocused.value || isComposing.value) {
      hasValidMeasurement.value = false;
      return;
    }

    const pos = measureCaret(textarea);
    if (!pos) {
      hasValidMeasurement.value = false;
      return;
    }

    hasValidMeasurement.value = true;
    applyTarget(pos.x, pos.y);
  }

  function scheduleUpdate(): void {
    if (disposed) return;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (!disposed) {
        updateNow();
      }
    });
  }

  function updatePosition(): void {
    scheduleUpdate();
  }

  // ---------------------------------------------------------------------------
  // Animation Loop
  // ---------------------------------------------------------------------------

  function tick(): void {
    if (!showFakeCaret.value) return;
    if (prefersReducedMotion.value) return;

    // Smooth caret position
    const dx = targetX - caretX.value;
    const dy = targetY - caretY.value;

    // Check if caret has snapped to target
    const isSnapped = Math.abs(dx) < SNAP_DISTANCE_PX && Math.abs(dy) < SNAP_DISTANCE_PX;

    if (isSnapped) {
      caretX.value = targetX;
      caretY.value = targetY;
    } else {
      caretX.value = caretX.value + dx * SMOOTHING;
      caretY.value = caretY.value + dy * SMOOTHING;
    }

    // Update trail (comet tail effect)
    const currentTrail = trail.value;
    const nextTrail: FakeCaretTrailPoint[] = [];

    // Fade existing points
    for (const p of currentTrail) {
      const alpha = p.alpha * TRAIL_DECAY;
      if (alpha >= TRAIL_MIN_ALPHA) {
        nextTrail.push({ ...p, alpha });
      }
    }

    // Add new point if moved enough
    const moved =
      Math.abs(caretX.value - lastTrailX) + Math.abs(caretY.value - lastTrailY) >
      TRAIL_MIN_DISTANCE_PX;

    if (moved) {
      nextTrail.push({ x: caretX.value, y: caretY.value, alpha: 1 });
      lastTrailX = caretX.value;
      lastTrailY = caretY.value;
    }

    // Only update trail ref if content changed (avoid triggering watchers)
    // Note: must compare alpha too, otherwise fade animation won't work
    const trailChanged =
      nextTrail.length !== currentTrail.length ||
      nextTrail.some(
        (p, i) =>
          p.x !== currentTrail[i]?.x ||
          p.y !== currentTrail[i]?.y ||
          Math.abs(p.alpha - (currentTrail[i]?.alpha ?? 0)) > 0.001,
      );

    if (trailChanged) {
      // Keep only the last N points
      if (nextTrail.length > MAX_TRAIL_POINTS) {
        trail.value = nextTrail.slice(nextTrail.length - MAX_TRAIL_POINTS);
      } else {
        trail.value = nextTrail;
      }
    }

    // Stop RAF when idle: snapped to target and trail has fully faded
    if (isSnapped && nextTrail.length === 0) {
      stopLoop();
    }
  }

  function startLoop(): void {
    if (disposed) return;
    if (rafId !== null) return;
    const loop = () => {
      if (disposed) {
        rafId = null;
        return;
      }
      rafId = requestAnimationFrame(loop);
      tick();
    };
    rafId = requestAnimationFrame(loop);
  }

  function stopLoop(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Reduced Motion Preference
  // ---------------------------------------------------------------------------

  let media: MediaQueryList | null = null;
  let onMediaChange: ((e: MediaQueryListEvent) => void) | null = null;

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    media = window.matchMedia('(prefers-reduced-motion: reduce)');
    prefersReducedMotion.value = media.matches;
    onMediaChange = (e: MediaQueryListEvent) => {
      prefersReducedMotion.value = e.matches;
      trail.value = [];
      scheduleUpdate();
    };
    try {
      media.addEventListener('change', onMediaChange);
    } catch {
      // Safari < 14 fallback
      media.addListener(onMediaChange as EventListener);
    }
  }

  // ---------------------------------------------------------------------------
  // Textarea Event Binding
  // ---------------------------------------------------------------------------

  watch(
    () => options.textareaRef.value,
    (el, _prev, onCleanup) => {
      if (!el) return;

      const handleFocus = () => {
        isFocused.value = true;
        scheduleUpdate();
      };
      const handleBlur = () => {
        isFocused.value = false;
        hasValidMeasurement.value = false;
        stopLoop();
        trail.value = [];
      };
      const handleInput = () => scheduleUpdate();
      const handleKey = () => scheduleUpdate();
      const handleMouse = () => scheduleUpdate();
      const handleScroll = () => scheduleUpdate();
      const handleSelect = () => scheduleUpdate();
      const handleCompositionStart = () => {
        isComposing.value = true;
        scheduleUpdate();
      };
      const handleCompositionEnd = () => {
        isComposing.value = false;
        scheduleUpdate();
      };

      el.addEventListener('focus', handleFocus);
      el.addEventListener('blur', handleBlur);
      el.addEventListener('input', handleInput);
      el.addEventListener('keydown', handleKey);
      el.addEventListener('keyup', handleKey);
      el.addEventListener('click', handleMouse);
      el.addEventListener('mouseup', handleMouse);
      el.addEventListener('scroll', handleScroll, { passive: true });
      el.addEventListener('select', handleSelect);
      el.addEventListener('compositionstart', handleCompositionStart);
      el.addEventListener('compositionend', handleCompositionEnd);

      // Initialize focus state
      isFocused.value = typeof document !== 'undefined' && document.activeElement === el;

      // Observe size changes
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver?.disconnect();
        resizeObserver = new ResizeObserver(() => scheduleUpdate());
        resizeObserver.observe(el);
      }

      // Initial measurement
      scheduleUpdate();

      onCleanup(() => {
        el.removeEventListener('focus', handleFocus);
        el.removeEventListener('blur', handleBlur);
        el.removeEventListener('input', handleInput);
        el.removeEventListener('keydown', handleKey);
        el.removeEventListener('keyup', handleKey);
        el.removeEventListener('click', handleMouse);
        el.removeEventListener('mouseup', handleMouse);
        el.removeEventListener('scroll', handleScroll);
        el.removeEventListener('select', handleSelect);
        el.removeEventListener('compositionstart', handleCompositionStart);
        el.removeEventListener('compositionend', handleCompositionEnd);
        resizeObserver?.disconnect();
        resizeObserver = null;
      });
    },
    { immediate: true },
  );

  // ---------------------------------------------------------------------------
  // Watchers for State Changes
  // ---------------------------------------------------------------------------

  watch(
    prefersReducedMotion,
    (reduced) => {
      if (reduced) {
        stopLoop();
        trail.value = [];
        scheduleUpdate();
        return;
      }
      if (showFakeCaret.value) {
        startLoop();
      }
    },
    { immediate: true },
  );

  watch(
    showFakeCaret,
    (show) => {
      if (!show) {
        stopLoop();
        trail.value = [];
        return;
      }

      // Start animation when showing
      scheduleUpdate();
      if (!prefersReducedMotion.value) {
        startLoop();
      }
    },
    { immediate: true },
  );

  watch(
    enabled,
    (v) => {
      if (!v) {
        stopLoop();
        trail.value = [];
        hasValidMeasurement.value = false;
      } else {
        scheduleUpdate();
      }
    },
    { immediate: true },
  );

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  onUnmounted(() => {
    disposed = true;
    stopLoop();
    resizeObserver?.disconnect();
    resizeObserver = null;

    if (mirrorEl && mirrorEl.parentNode) {
      mirrorEl.parentNode.removeChild(mirrorEl);
    }
    mirrorEl = null;

    if (media && onMediaChange) {
      try {
        media.removeEventListener('change', onMediaChange);
      } catch {
        media.removeListener(onMediaChange as EventListener);
      }
    }
  });

  return {
    overlayStyle,
    showFakeCaret,
    caretX,
    caretY,
    trail,
    updatePosition,
  };
}
