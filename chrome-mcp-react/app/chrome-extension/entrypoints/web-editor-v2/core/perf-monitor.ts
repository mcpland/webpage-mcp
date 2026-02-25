/**
 * Performance Monitor (Phase 5.3)
 *
 * Lightweight FPS + JS heap monitor for debugging.
 *
 * Design:
 * - Disabled by default (no persistent rAF)
 * - Uses a single rAF loop only when enabled
 * - Updates UI at low frequency (FPS: 500ms, heap: 1s)
 * - Pauses automatically when the document is hidden
 *
 * Notes:
 * - Heap metrics rely on Chrome's non-standard `performance.memory` API.
 */

import { Disposer } from '../utils/disposables';

// =============================================================================
// Types
// =============================================================================

/** Options for creating the perf monitor */
export interface PerfMonitorOptions {
  /** Container element (should be overlayRoot from ShadowHost) */
  container: HTMLElement;
  /** UI update interval for FPS (ms). Default: 500 */
  fpsUiIntervalMs?: number;
  /** Sampling interval for heap memory (ms). Default: 1000 */
  memorySampleIntervalMs?: number;
}

/** Perf monitor public interface */
export interface PerfMonitor {
  /** Whether monitor is currently enabled */
  isEnabled(): boolean;
  /** Enable/disable monitor */
  setEnabled(enabled: boolean): void;
  /** Toggle monitor and return new state */
  toggle(): boolean;
  /** Cleanup */
  dispose(): void;
}

/** Non-standard Chrome memory API shape */
interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_FPS_UI_INTERVAL_MS = 500;
const DEFAULT_MEMORY_SAMPLE_INTERVAL_MS = 1000;

// =============================================================================
// Helpers
// =============================================================================

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function bytesToMb(bytes: number): number {
  return bytes / (1024 * 1024);
}

function formatMb(bytes: number, digits: number): string {
  const mb = bytesToMb(bytes);
  return Number.isFinite(mb) ? mb.toFixed(digits) : 'N/A';
}

function readPerformanceMemory(): PerformanceMemory | null {
  try {
    const perf = performance as unknown as { memory?: unknown };
    const memory = perf.memory as Partial<PerformanceMemory> | undefined;
    if (!memory) return null;

    const used = memory.usedJSHeapSize;
    const limit = memory.jsHeapSizeLimit;
    const total = memory.totalJSHeapSize;

    if (!isFiniteNumber(used)) return null;
    if (!isFiniteNumber(limit)) return null;
    if (!isFiniteNumber(total)) return null;

    return {
      usedJSHeapSize: used,
      totalJSHeapSize: total,
      jsHeapSizeLimit: limit,
    };
  } catch {
    return null;
  }
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a perf monitor HUD.
 *
 * The HUD is appended to `overlayRoot` and is `pointer-events: none`.
 * It is hidden by default and only starts rAF when enabled.
 */
export function createPerfMonitor(options: PerfMonitorOptions): PerfMonitor {
  const disposer = new Disposer();
  const container = options.container;

  const fpsUiIntervalMs = Math.max(
    100,
    Math.floor(options.fpsUiIntervalMs ?? DEFAULT_FPS_UI_INTERVAL_MS),
  );
  const memorySampleIntervalMs = Math.max(
    250,
    Math.floor(options.memorySampleIntervalMs ?? DEFAULT_MEMORY_SAMPLE_INTERVAL_MS),
  );

  // ==========================================================================
  // DOM
  // ==========================================================================

  const root = document.createElement('div');
  root.className = 'we-perf-hud';
  root.hidden = true;
  root.setAttribute('aria-hidden', 'true');

  const fpsEl = document.createElement('div');
  fpsEl.className = 'we-perf-hud-line';
  fpsEl.textContent = 'FPS: --';

  const heapEl = document.createElement('div');
  heapEl.className = 'we-perf-hud-line';
  heapEl.textContent = 'Heap: --';

  root.append(fpsEl, heapEl);
  container.append(root);
  disposer.add(() => root.remove());

  // ==========================================================================
  // State
  // ==========================================================================

  let enabled = false;
  let rafId: number | null = null;

  let frameCount = 0;
  let lastFpsUiTime = 0;
  let lastMemorySampleTime = 0;

  let lastFpsText = fpsEl.textContent ?? '';
  let lastHeapText = heapEl.textContent ?? '';

  // ==========================================================================
  // RAF Management
  // ==========================================================================

  function cancelRaf(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }
  disposer.add(cancelRaf);

  function setText(el: HTMLElement, next: string, cache: 'fps' | 'heap'): void {
    if (cache === 'fps') {
      if (next === lastFpsText) return;
      lastFpsText = next;
    } else {
      if (next === lastHeapText) return;
      lastHeapText = next;
    }
    el.textContent = next;
  }

  function updateHeapText(): void {
    const memory = readPerformanceMemory();
    if (!memory) {
      setText(heapEl, 'Heap: N/A', 'heap');
      return;
    }

    const used = formatMb(memory.usedJSHeapSize, 1);
    const limit = formatMb(memory.jsHeapSizeLimit, 0);
    setText(heapEl, `Heap: ${used} / ${limit} MB`, 'heap');
  }

  function resetSampling(now: number): void {
    frameCount = 0;
    lastFpsUiTime = now;
    // Force an immediate memory sample on next frame
    lastMemorySampleTime = now - memorySampleIntervalMs;
    setText(fpsEl, 'FPS: --', 'fps');
    updateHeapText();
  }

  function scheduleNextFrame(): void {
    if (disposer.isDisposed) return;
    if (!enabled) return;
    if (rafId !== null) return;
    if (document.visibilityState !== 'visible') return;

    rafId = requestAnimationFrame(onFrame);
  }

  function onFrame(now: number): void {
    rafId = null;
    if (disposer.isDisposed) return;
    if (!enabled) return;
    if (document.visibilityState !== 'visible') return;

    frameCount += 1;

    const fpsElapsed = now - lastFpsUiTime;
    if (fpsElapsed >= fpsUiIntervalMs) {
      const fps = fpsElapsed > 0 ? (frameCount * 1000) / fpsElapsed : 0;
      const rounded = Math.max(0, Math.round(fps));
      setText(fpsEl, `FPS: ${rounded}`, 'fps');
      frameCount = 0;
      lastFpsUiTime = now;
    }

    if (now - lastMemorySampleTime >= memorySampleIntervalMs) {
      lastMemorySampleTime = now;
      updateHeapText();
    }

    scheduleNextFrame();
  }

  // ==========================================================================
  // Visibility Handling
  // ==========================================================================

  function handleVisibilityChange(): void {
    if (!enabled) return;

    if (document.visibilityState !== 'visible') {
      cancelRaf();
      return;
    }

    // Resume with fresh sampling window to avoid low FPS spikes after tab hidden.
    resetSampling(performance.now());
    scheduleNextFrame();
  }

  disposer.listen(document, 'visibilitychange', handleVisibilityChange);

  // ==========================================================================
  // Public API
  // ==========================================================================

  function setEnabled(next: boolean): void {
    if (enabled === next) return;
    enabled = next;

    if (!enabled) {
      root.hidden = true;
      cancelRaf();
      return;
    }

    root.hidden = false;

    if (document.visibilityState !== 'visible') {
      // Stay paused until visible again
      return;
    }

    resetSampling(performance.now());
    scheduleNextFrame();
  }

  function toggle(): boolean {
    setEnabled(!enabled);
    return enabled;
  }

  return {
    isEnabled: () => enabled,
    setEnabled,
    toggle,
    dispose: () => {
      // Ensure rAF is stopped before cleanup
      enabled = false;
      root.hidden = true;
      disposer.dispose();
    },
  };
}
