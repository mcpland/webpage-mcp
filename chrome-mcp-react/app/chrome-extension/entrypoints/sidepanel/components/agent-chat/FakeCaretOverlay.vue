<template>
  <div
    v-show="enabled"
    class="ac-fake-caret-overlay"
    :style="fakeCaret.overlayStyle.value"
    aria-hidden="true"
  >
    <!-- Canvas for comet trail -->
    <canvas ref="canvasRef" class="ac-fake-caret-canvas" />
    <!-- Fake caret element -->
    <div ref="caretRef" class="ac-fake-caret-caret" />
  </div>
</template>

<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, ref, watch, toRef } from 'vue';
import { useFakeCaret } from '../../composables';

// =============================================================================
// Props
// =============================================================================

const props = defineProps<{
  /** Reference to the textarea element (passed as template ref) */
  textareaRef: HTMLTextAreaElement | null;
  /** Whether fake caret is enabled */
  enabled: boolean;
  /** Current textarea value (for reactivity) */
  value: string;
}>();

// =============================================================================
// Fake Caret Composable
// =============================================================================

const enabledRef = computed(() => props.enabled);
const textareaRefWrapped = toRef(props, 'textareaRef');

const fakeCaret = useFakeCaret({
  textareaRef: textareaRefWrapped,
  enabled: enabledRef,
});

// =============================================================================
// Refs
// =============================================================================

const canvasRef = ref<HTMLCanvasElement | null>(null);
const caretRef = ref<HTMLDivElement | null>(null);

// =============================================================================
// Canvas State
// =============================================================================

let scheduled = false;
let lastCssWidth = 0;
let lastCssHeight = 0;
let lastDpr = 0;

// Cached style values (refreshed on resize/style change, not every frame)
let cachedAccentColor = '#d97757';
let cachedLineHeight = 18;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get the accent color from CSS variables.
 */
function getAccentColor(): string {
  return cachedAccentColor;
}

/**
 * Get line height in pixels.
 */
function getLineHeightPx(): number {
  return cachedLineHeight;
}

/**
 * Refresh cached style values from textarea.
 * Call this on resize/style change, not every frame.
 */
function refreshCachedStyles(textarea: HTMLTextAreaElement): void {
  if (typeof window === 'undefined') return;

  const cs = window.getComputedStyle(textarea);

  // Cache accent color
  const accent = cs.getPropertyValue('--ac-accent').trim();
  cachedAccentColor = accent || '#d97757';

  // Cache line height
  const lineHeight = Number.parseFloat(cs.lineHeight);
  if (Number.isFinite(lineHeight)) {
    cachedLineHeight = lineHeight;
  } else {
    const fontSize = Number.parseFloat(cs.fontSize);
    cachedLineHeight = Number.isFinite(fontSize) ? Math.round(fontSize * 1.25) : 18;
  }
}

/**
 * Get device pixel ratio.
 */
function getDpr(): number {
  if (typeof window === 'undefined') return 1;
  return window.devicePixelRatio || 1;
}

/**
 * Sync canvas size with textarea dimensions.
 */
function syncCanvas(
  textarea: HTMLTextAreaElement,
): { ctx: CanvasRenderingContext2D; cssWidth: number; cssHeight: number } | null {
  const canvas = canvasRef.value;
  if (!canvas) return null;

  const cssWidth = textarea.clientWidth;
  const cssHeight = textarea.clientHeight;
  if (cssWidth <= 0 || cssHeight <= 0) return null;

  const dpr = getDpr();

  // Only resize if dimensions changed
  if (cssWidth !== lastCssWidth || cssHeight !== lastCssHeight || dpr !== lastDpr) {
    lastCssWidth = cssWidth;
    lastCssHeight = cssHeight;
    lastDpr = dpr;
    canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
    canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, cssWidth, cssHeight };
}

/**
 * Clear the canvas.
 */
function clearCanvas(ctx: CanvasRenderingContext2D, cssWidth: number, cssHeight: number): void {
  ctx.clearRect(0, 0, cssWidth, cssHeight);
}

/**
 * Set native caret visibility.
 */
function setNativeCaretVisible(textarea: HTMLTextAreaElement, visible: boolean): void {
  textarea.style.caretColor = visible ? '' : 'transparent';
}

// =============================================================================
// Draw Frame
// =============================================================================

/**
 * Draw a single animation frame.
 */
function drawFrame(): void {
  try {
    const textarea = props.textareaRef;
    const caretEl = caretRef.value;
    if (!textarea || !caretEl) return;

    const show = fakeCaret.showFakeCaret.value;

    // If not showing, restore native caret and clear canvas
    if (!show) {
      setNativeCaretVisible(textarea, true);
      caretEl.style.opacity = '0';

      const synced = syncCanvas(textarea);
      if (synced) clearCanvas(synced.ctx, synced.cssWidth, synced.cssHeight);
      return;
    }

    // Hide native caret
    setNativeCaretVisible(textarea, false);

    // Position fake caret (use cached values for performance)
    const lineHeight = getLineHeightPx();
    const x = fakeCaret.caretX.value;
    const y = fakeCaret.caretY.value;

    caretEl.style.height = `${lineHeight}px`;
    caretEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    caretEl.style.opacity = '1';

    // Draw comet trail on canvas
    const synced = syncCanvas(textarea);
    if (!synced) return;

    const { ctx, cssWidth, cssHeight } = synced;
    clearCanvas(ctx, cssWidth, cssHeight);

    const points = fakeCaret.trail.value;
    if (points.length <= 0) return;

    const accent = getAccentColor();
    const centerY = lineHeight * 0.55;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;

    // Draw trail segments
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1];
      const curr = points[i];
      const alpha = Math.min(1, Math.max(0, curr.alpha)) * 0.28;

      ctx.globalAlpha = alpha;
      ctx.lineWidth = 0.75 + 2.25 * curr.alpha;

      ctx.beginPath();
      ctx.moveTo(prev.x + 1, prev.y + centerY);
      ctx.lineTo(curr.x + 1, curr.y + centerY);
      ctx.stroke();
    }

    // Draw head glow
    const head = points[points.length - 1];
    ctx.globalAlpha = 0.35;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 10;

    ctx.beginPath();
    ctx.arc(head.x + 1, head.y + centerY, 2.25, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  } catch (error) {
    // On error, restore native caret
    const textarea = props.textareaRef;
    if (textarea) setNativeCaretVisible(textarea, true);
  }
}

/**
 * Schedule a draw frame using requestAnimationFrame.
 */
function scheduleDraw(): void {
  if (scheduled) return;
  scheduled = true;

  if (typeof requestAnimationFrame !== 'function') {
    scheduled = false;
    drawFrame();
    return;
  }

  requestAnimationFrame(() => {
    scheduled = false;
    drawFrame();
  });
}

// =============================================================================
// Event Handlers
// =============================================================================

function handleResize(): void {
  // Refresh cached styles on resize (cheaper than reading every frame)
  const textarea = props.textareaRef;
  if (textarea) {
    refreshCachedStyles(textarea);
  }
  fakeCaret.updatePosition();
  scheduleDraw();
}

function reset(): void {
  const textarea = props.textareaRef;
  if (textarea) setNativeCaretVisible(textarea, true);
}

// =============================================================================
// Watchers
// =============================================================================

// Watch enabled state
watch(
  () => props.enabled,
  (enabled) => {
    if (!enabled) {
      reset();
    } else {
      // Initialize cached styles when enabled
      const textarea = props.textareaRef;
      if (textarea) {
        refreshCachedStyles(textarea);
      }
    }
    fakeCaret.updatePosition();
    scheduleDraw();
  },
  { immediate: true },
);

// Watch textareaRef changes (null -> element) to initialize cached styles
watch(
  () => props.textareaRef,
  (textarea) => {
    if (textarea && props.enabled) {
      refreshCachedStyles(textarea);
    }
  },
);

// Watch value changes
watch(
  () => props.value,
  async () => {
    await nextTick();
    fakeCaret.updatePosition();
    scheduleDraw();
  },
  { flush: 'post' },
);

// Watch showFakeCaret state
watch(
  fakeCaret.showFakeCaret,
  (show, prevShow) => {
    const textarea = props.textareaRef;
    if (textarea) {
      setNativeCaretVisible(textarea, !show);
      // Refresh cached styles when becoming visible (handles theme changes)
      if (show && !prevShow) {
        refreshCachedStyles(textarea);
      }
    }
    scheduleDraw();
  },
  { immediate: true },
);

// Watch position and trail changes
watch([fakeCaret.caretX, fakeCaret.caretY, fakeCaret.trail], scheduleDraw);

// =============================================================================
// Lifecycle
// =============================================================================

// Window resize handler
if (typeof window !== 'undefined') {
  window.addEventListener('resize', handleResize, { passive: true });
}

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', handleResize);
  }
  reset();
});
</script>

<style scoped>
.ac-fake-caret-overlay {
  contain: paint;
}

.ac-fake-caret-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.ac-fake-caret-caret {
  position: absolute;
  left: 0;
  top: 0;
  width: 2px;
  border-radius: 999px;
  background: var(--ac-accent);
  box-shadow:
    0 0 0 1px var(--ac-accent-subtle, rgba(217, 119, 87, 0.2)),
    0 0 14px var(--ac-accent-subtle, rgba(217, 119, 87, 0.3));
  will-change: transform;
  opacity: 0;
  animation: ac-fake-caret-blink 1.15s step-end infinite;
}

@media (prefers-reduced-motion: reduce) {
  .ac-fake-caret-caret {
    animation: none;
  }
}

@keyframes ac-fake-caret-blink {
  0%,
  45% {
    opacity: 1;
  }
  46%,
  100% {
    opacity: 0;
  }
}
</style>
