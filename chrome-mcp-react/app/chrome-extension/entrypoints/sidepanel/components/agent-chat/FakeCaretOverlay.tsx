import { useEffect, useRef } from 'react';

type TrailPoint = {
  x: number;
  y: number;
  alpha: number;
};

type FakeCaretOverlayProps = {
  textareaRef: HTMLTextAreaElement | null;
  enabled: boolean;
  value: string;
};

const TRAIL_DECAY = 0.86;
const TRAIL_MIN_ALPHA = 0.06;
const TRAIL_MIN_DISTANCE_PX = 0.35;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export default function FakeCaretOverlay({ textareaRef, enabled, value }: FakeCaretOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const caretRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const lastMirrorKeyRef = useRef('');

  const isFocusedRef = useRef(false);
  const isComposingRef = useRef(false);
  const hasSelectionRef = useRef(false);
  const showRef = useRef(false);
  const trailRef = useRef<TrailPoint[]>([]);

  const caretXRef = useRef(0);
  const caretYRef = useRef(0);
  const lastTrailXRef = useRef(0);
  const lastTrailYRef = useRef(0);

  const lastCssWidthRef = useRef(0);
  const lastCssHeightRef = useRef(0);
  const lastDprRef = useRef(0);

  const cachedAccentColorRef = useRef('#d97757');
  const cachedLineHeightRef = useRef(18);

  const scheduledRef = useRef(false);
  const decayLoopRef = useRef<number | null>(null);

  const prefersReducedMotionRef = useRef(false);

  function setNativeCaretVisible(textarea: HTMLTextAreaElement, visible: boolean): void {
    textarea.style.caretColor = visible ? '' : 'transparent';
  }

  function refreshCachedStyles(textarea: HTMLTextAreaElement): void {
    const styles = window.getComputedStyle(textarea);
    const accent = styles.getPropertyValue('--ac-accent').trim();
    cachedAccentColorRef.current = accent || '#d97757';

    const lineHeight = Number.parseFloat(styles.lineHeight);
    if (Number.isFinite(lineHeight)) {
      cachedLineHeightRef.current = lineHeight;
      return;
    }

    const fontSize = Number.parseFloat(styles.fontSize);
    cachedLineHeightRef.current = Number.isFinite(fontSize) ? Math.round(fontSize * 1.25) : 18;
  }

  function ensureMirror(): HTMLDivElement {
    if (mirrorRef.current) {
      return mirrorRef.current;
    }

    const mirror = document.createElement('div');
    mirror.setAttribute('data-ac-fake-caret-mirror', 'true');
    mirror.style.position = 'fixed';
    mirror.style.top = '0';
    mirror.style.left = '-10000px';
    mirror.style.visibility = 'hidden';
    mirror.style.pointerEvents = 'none';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordBreak = 'break-word';
    mirror.style.overflowWrap = 'break-word';
    mirror.style.overflow = 'auto';
    mirror.style.contain = 'layout style paint';
    mirror.style.border = '0';
    mirror.style.background = 'transparent';
    document.body.appendChild(mirror);

    mirrorRef.current = mirror;
    return mirror;
  }

  function syncMirrorStyle(textarea: HTMLTextAreaElement, mirror: HTMLDivElement): void {
    const styles = window.getComputedStyle(textarea);
    const width = `${textarea.clientWidth}px`;
    const height = `${textarea.clientHeight}px`;
    const tabSize = styles.getPropertyValue('tab-size');

    const key = [
      width,
      height,
      styles.font,
      styles.padding,
      styles.letterSpacing,
      styles.lineHeight,
      styles.textTransform,
      styles.textIndent,
      styles.textAlign,
      styles.direction,
      tabSize,
    ].join('|');

    if (key === lastMirrorKeyRef.current) {
      return;
    }

    lastMirrorKeyRef.current = key;
    mirror.style.boxSizing = 'border-box';
    mirror.style.width = width;
    mirror.style.height = height;
    mirror.style.padding = styles.padding;
    mirror.style.font = styles.font;
    mirror.style.letterSpacing = styles.letterSpacing;
    mirror.style.lineHeight = styles.lineHeight;
    mirror.style.textTransform = styles.textTransform;
    mirror.style.textIndent = styles.textIndent;
    mirror.style.textAlign = styles.textAlign;
    mirror.style.direction = styles.direction;
    if (tabSize) {
      mirror.style.setProperty('tab-size', tabSize);
    }
  }

  function measureCaret(textarea: HTMLTextAreaElement): { x: number; y: number } | null {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    if (typeof start !== 'number' || typeof end !== 'number') {
      hasSelectionRef.current = false;
      return null;
    }

    hasSelectionRef.current = start !== end;
    if (hasSelectionRef.current || isComposingRef.current) {
      return null;
    }

    if (textarea.clientWidth <= 0 || textarea.clientHeight <= 0) {
      return null;
    }

    const mirror = ensureMirror();
    syncMirrorStyle(textarea, mirror);
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
    mirror.innerHTML = '';
    mirror.appendChild(document.createTextNode(textarea.value.slice(0, start)));

    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    marker.style.display = 'inline-block';
    marker.style.width = '1px';
    marker.style.height = '1em';
    mirror.appendChild(marker);

    const markerRect = marker.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const x = markerRect.left - mirrorRect.left;
    const y = markerRect.top - mirrorRect.top;

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }

    const clampedX = clamp(x, 0, textarea.clientWidth + 2);
    const clampedY = clamp(y, 0, textarea.clientHeight + 2);
    if (Math.abs(clampedX - x) > 20 || Math.abs(clampedY - y) > 20) {
      return null;
    }

    return { x: clampedX, y: clampedY };
  }

  function syncCanvas(
    textarea: HTMLTextAreaElement,
  ): { ctx: CanvasRenderingContext2D; cssWidth: number; cssHeight: number } | null {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }

    const cssWidth = textarea.clientWidth;
    const cssHeight = textarea.clientHeight;
    if (cssWidth <= 0 || cssHeight <= 0) {
      return null;
    }

    const dpr = window.devicePixelRatio || 1;
    if (
      cssWidth !== lastCssWidthRef.current ||
      cssHeight !== lastCssHeightRef.current ||
      dpr !== lastDprRef.current
    ) {
      lastCssWidthRef.current = cssWidth;
      lastCssHeightRef.current = cssHeight;
      lastDprRef.current = dpr;
      canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
      canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, cssWidth, cssHeight };
  }

  function drawFrame(): void {
    const textarea = textareaRef;
    const caretEl = caretRef.current;
    if (!textarea || !caretEl) {
      return;
    }

    const synced = syncCanvas(textarea);
    if (!synced) {
      return;
    }

    const { ctx, cssWidth, cssHeight } = synced;
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (!showRef.current) {
      setNativeCaretVisible(textarea, true);
      caretEl.style.opacity = '0';
      return;
    }

    setNativeCaretVisible(textarea, false);
    const lineHeight = cachedLineHeightRef.current;
    const x = caretXRef.current;
    const y = caretYRef.current;
    const accent = cachedAccentColorRef.current;

    caretEl.style.height = `${lineHeight}px`;
    caretEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    caretEl.style.opacity = '1';
    caretEl.style.background = accent;

    const points = trailRef.current;
    if (points.length === 0) {
      return;
    }

    const centerY = lineHeight * 0.55;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = accent;
    ctx.fillStyle = accent;

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

    const head = points[points.length - 1];
    ctx.globalAlpha = 0.35;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(head.x + 1, head.y + centerY, 2.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function scheduleDraw(): void {
    if (scheduledRef.current) {
      return;
    }

    scheduledRef.current = true;
    requestAnimationFrame(() => {
      scheduledRef.current = false;
      drawFrame();
    });
  }

  function tickTrail(): void {
    const faded = trailRef.current
      .map((point) => ({ ...point, alpha: point.alpha * TRAIL_DECAY }))
      .filter((point) => point.alpha >= TRAIL_MIN_ALPHA);

    trailRef.current = faded;
    scheduleDraw();

    if (showRef.current || trailRef.current.length > 0) {
      decayLoopRef.current = requestAnimationFrame(tickTrail);
    } else {
      decayLoopRef.current = null;
    }
  }

  function ensureDecayLoop(): void {
    if (decayLoopRef.current !== null || prefersReducedMotionRef.current) {
      return;
    }

    decayLoopRef.current = requestAnimationFrame(tickTrail);
  }

  function stopDecayLoop(): void {
    if (decayLoopRef.current !== null) {
      cancelAnimationFrame(decayLoopRef.current);
      decayLoopRef.current = null;
    }
  }

  function updatePosition(): void {
    const textarea = textareaRef;
    if (!textarea || !enabled || !isFocusedRef.current || isComposingRef.current) {
      showRef.current = false;
      scheduleDraw();
      return;
    }

    refreshCachedStyles(textarea);
    const position = measureCaret(textarea);
    if (!position) {
      showRef.current = false;
      scheduleDraw();
      return;
    }

    showRef.current = true;
    const moved =
      Math.abs(position.x - lastTrailXRef.current) + Math.abs(position.y - lastTrailYRef.current) >
      TRAIL_MIN_DISTANCE_PX;

    caretXRef.current = position.x;
    caretYRef.current = position.y;

    if (!prefersReducedMotionRef.current && moved) {
      trailRef.current.push({ x: position.x, y: position.y, alpha: 1 });
      lastTrailXRef.current = position.x;
      lastTrailYRef.current = position.y;
      ensureDecayLoop();
    }

    scheduleDraw();
  }

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    prefersReducedMotionRef.current = media.matches;

    const handler = (event: MediaQueryListEvent): void => {
      prefersReducedMotionRef.current = event.matches;
      if (event.matches) {
        trailRef.current = [];
        stopDecayLoop();
      }
      updatePosition();
    };

    try {
      media.addEventListener('change', handler);
      return () => media.removeEventListener('change', handler);
    } catch {
      media.addListener(handler as EventListener);
      return () => media.removeListener(handler as EventListener);
    }
  });

  useEffect(() => {
    const textarea = textareaRef;
    if (!textarea) {
      showRef.current = false;
      scheduleDraw();
      return;
    }

    const handleFocus = (): void => {
      isFocusedRef.current = true;
      updatePosition();
    };
    const handleBlur = (): void => {
      isFocusedRef.current = false;
      showRef.current = false;
      setNativeCaretVisible(textarea, true);
      scheduleDraw();
    };
    const handleInput = (): void => updatePosition();
    const handleKey = (): void => updatePosition();
    const handleMouse = (): void => updatePosition();
    const handleScroll = (): void => updatePosition();
    const handleSelect = (): void => updatePosition();
    const handleCompositionStart = (): void => {
      isComposingRef.current = true;
      updatePosition();
    };
    const handleCompositionEnd = (): void => {
      isComposingRef.current = false;
      updatePosition();
    };

    textarea.addEventListener('focus', handleFocus);
    textarea.addEventListener('blur', handleBlur);
    textarea.addEventListener('input', handleInput);
    textarea.addEventListener('keydown', handleKey);
    textarea.addEventListener('keyup', handleKey);
    textarea.addEventListener('click', handleMouse);
    textarea.addEventListener('mouseup', handleMouse);
    textarea.addEventListener('scroll', handleScroll, { passive: true });
    textarea.addEventListener('select', handleSelect);
    textarea.addEventListener('compositionstart', handleCompositionStart);
    textarea.addEventListener('compositionend', handleCompositionEnd);

    isFocusedRef.current = document.activeElement === textarea;
    refreshCachedStyles(textarea);
    updatePosition();

    return () => {
      textarea.removeEventListener('focus', handleFocus);
      textarea.removeEventListener('blur', handleBlur);
      textarea.removeEventListener('input', handleInput);
      textarea.removeEventListener('keydown', handleKey);
      textarea.removeEventListener('keyup', handleKey);
      textarea.removeEventListener('click', handleMouse);
      textarea.removeEventListener('mouseup', handleMouse);
      textarea.removeEventListener('scroll', handleScroll);
      textarea.removeEventListener('select', handleSelect);
      textarea.removeEventListener('compositionstart', handleCompositionStart);
      textarea.removeEventListener('compositionend', handleCompositionEnd);
      setNativeCaretVisible(textarea, true);
    };
  }, [textareaRef, enabled]);

  useEffect(() => {
    if (!enabled) {
      showRef.current = false;
      trailRef.current = [];
      stopDecayLoop();
      if (textareaRef) {
        setNativeCaretVisible(textareaRef, true);
      }
      scheduleDraw();
      return;
    }

    updatePosition();
  }, [enabled, textareaRef]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      updatePosition();
    });

    return () => {
      cancelAnimationFrame(frame);
    };
  }, [value, textareaRef]);

  useEffect(() => {
    const handleResize = (): void => {
      if (textareaRef) {
        refreshCachedStyles(textareaRef);
      }
      updatePosition();
    };

    window.addEventListener('resize', handleResize, { passive: true });
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [textareaRef]);

  useEffect(() => {
    return () => {
      stopDecayLoop();
      if (textareaRef) {
        setNativeCaretVisible(textareaRef, true);
      }

      const mirror = mirrorRef.current;
      if (mirror && mirror.parentNode) {
        mirror.parentNode.removeChild(mirror);
      }
      mirrorRef.current = null;
    };
  }, [textareaRef]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        contain: 'paint',
        display: enabled ? 'block' : 'none',
      }}
      aria-hidden="true"
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
        }}
      />
      <div
        ref={caretRef}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: '2px',
          borderRadius: '999px',
          background: 'var(--ac-accent)',
          boxShadow:
            '0 0 0 1px var(--ac-accent-subtle, rgba(217, 119, 87, 0.2)), 0 0 14px var(--ac-accent-subtle, rgba(217, 119, 87, 0.3))',
          willChange: 'transform',
          opacity: 0,
        }}
      />
    </div>
  );
}
