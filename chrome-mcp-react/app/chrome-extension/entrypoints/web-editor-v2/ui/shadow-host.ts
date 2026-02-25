/**
 * Shadow DOM Host
 *
 * Creates an isolated container for the Web Editor UI using Shadow DOM.
 * Provides:
 * - Style isolation (no CSS bleed in/out)
 * - Event isolation (UI events don't bubble to page)
 * - Overlay container for Canvas/visual feedback
 * - UI container for panels/controls
 */

import {
  WEB_EDITOR_V2_COLORS,
  WEB_EDITOR_V2_HOST_ID,
  WEB_EDITOR_V2_OVERLAY_ID,
  WEB_EDITOR_V2_UI_ID,
  WEB_EDITOR_V2_Z_INDEX,
} from '../constants';
import { Disposer } from '../utils/disposables';

// =============================================================================
// Types
// =============================================================================

/** Elements exposed by the shadow host */
export interface ShadowHostElements {
  /** The host element attached to the document */
  host: HTMLDivElement;
  /** The shadow root */
  shadowRoot: ShadowRoot;
  /** Container for overlay elements (Canvas, guides, etc.) */
  overlayRoot: HTMLDivElement;
  /** Container for UI elements (panels, toolbar, etc.) */
  uiRoot: HTMLDivElement;
}

/** Options for mounting the shadow host (placeholder for future extension) */
export type ShadowHostOptions = Record<string, never>;

/** Interface for the shadow host manager */
export interface ShadowHostManager {
  /** Get the shadow host elements (null if not mounted) */
  getElements(): ShadowHostElements | null;
  /** Check if a node is part of the editor overlay */
  isOverlayElement(node: unknown): boolean;
  /** Check if an event originated from the editor UI */
  isEventFromUi(event: Event): boolean;
  /** Dispose and unmount the shadow host */
  dispose(): void;
}

// =============================================================================
// Styles
// =============================================================================

const SHADOW_HOST_STYLES = /* css */ `
  :host {
    all: initial;

    /* Design tokens aligned with attr-ui.html design spec */
    /* Surface colors */
    --we-surface-bg: #ffffff;
    --we-surface-secondary: #fafafa;

    /* Control colors - input containers use gray bg */
    --we-control-bg: #f3f3f3;
    --we-control-bg-hover: #e8e8e8;
    --we-control-border-hover: #e0e0e0;
    --we-control-bg-focus: #ffffff;
    --we-control-border-focus: #3b82f6;

    /* Border colors */
    --we-border-subtle: #e5e5e5;
    --we-border-strong: #d4d4d4;
    --we-border-section: #f3f3f3;

    /* Text colors */
    --we-text-primary: #333333;
    --we-text-secondary: #737373;
    --we-text-muted: #a3a3a3;

    /* Accent surfaces (used by CSS/Props panels) */
    --we-accent-info-bg: rgba(59, 130, 246, 0.08);
    --we-accent-brand-bg: rgba(99, 102, 241, 0.12);
    --we-accent-brand-border: rgba(99, 102, 241, 0.25);
    --we-accent-warning-bg: rgba(251, 191, 36, 0.14);
    --we-accent-warning-border: rgba(251, 191, 36, 0.25);
    --we-accent-danger-bg: rgba(248, 113, 113, 0.12);
    --we-accent-danger-border: rgba(248, 113, 113, 0.25);

    /* Shadows - Tailwind-like shadow-xl */
    --we-shadow-subtle: 0 1px 2px rgba(0, 0, 0, 0.05);
    --we-shadow-panel: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
    --we-shadow-tab: 0 1px 2px rgba(0, 0, 0, 0.05);

    /* Radii */
    --we-radius-panel: 8px;
    --we-radius-control: 6px;
    --we-radius-tab: 4px;

    /* Sizes */
    --we-icon-btn-size: 24px;

    /* Focus ring - blue inset border style */
    --we-focus-ring: #3b82f6;

    /* Motion - bounce easing for toolbar animations */
    --we-ease-bounce: cubic-bezier(0.68, -0.55, 0.265, 1.55);
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  /* Overlay container - for Canvas and visual feedback */
  #${WEB_EDITOR_V2_OVERLAY_ID} {
    position: fixed;
    inset: 0;
    pointer-events: none;
    contain: layout style;
  }

  /* ==========================================================================
   * Resize Handles (Phase 4.9)
   * ========================================================================== */

  /* Handles layer - covers viewport, pass-through by default */
  .we-handles-layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    contain: layout style paint;
  }

  /* Selection frame - positioned by selection rect */
  .we-selection-frame {
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
    transform: translate3d(0, 0, 0);
    pointer-events: none;
    will-change: transform, width, height;
  }

  /* Individual resize handle */
  .we-resize-handle {
    position: absolute;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.98);
    border: 1px solid ${WEB_EDITOR_V2_COLORS.selectionBorder};
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
    pointer-events: auto;
    touch-action: none;
    user-select: none;
    transition: background-color 0.1s ease, border-color 0.1s ease, transform 0.1s ease;
  }

  .we-resize-handle:hover {
    background: ${WEB_EDITOR_V2_COLORS.selectionBorder};
    border-color: ${WEB_EDITOR_V2_COLORS.selectionBorder};
    transform: translate(-50%, -50%) scale(1.15);
  }

  .we-resize-handle:active {
    transform: translate(-50%, -50%) scale(1.0);
  }

  /* Handle positions - all use translate(-50%, -50%) as base */
  .we-resize-handle[data-dir="n"]  { left: 50%; top: 0; transform: translate(-50%, -50%); cursor: ns-resize; }
  .we-resize-handle[data-dir="s"]  { left: 50%; top: 100%; transform: translate(-50%, -50%); cursor: ns-resize; }
  .we-resize-handle[data-dir="e"]  { left: 100%; top: 50%; transform: translate(-50%, -50%); cursor: ew-resize; }
  .we-resize-handle[data-dir="w"]  { left: 0; top: 50%; transform: translate(-50%, -50%); cursor: ew-resize; }
  .we-resize-handle[data-dir="nw"] { left: 0; top: 0; transform: translate(-50%, -50%); cursor: nwse-resize; }
  .we-resize-handle[data-dir="ne"] { left: 100%; top: 0; transform: translate(-50%, -50%); cursor: nesw-resize; }
  .we-resize-handle[data-dir="sw"] { left: 0; top: 100%; transform: translate(-50%, -50%); cursor: nesw-resize; }
  .we-resize-handle[data-dir="se"] { left: 100%; top: 100%; transform: translate(-50%, -50%); cursor: nwse-resize; }

  /* Size HUD - shows W×H while resizing */
  .we-size-hud {
    position: absolute;
    left: 50%;
    top: 0;
    transform: translate(-50%, calc(-100% - 8px));
    padding: 3px 8px;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 11px;
    font-weight: 600;
    line-height: 1.2;
    color: rgba(255, 255, 255, 0.98);
    background: rgba(15, 23, 42, 0.92);
    border: 1px solid rgba(51, 65, 85, 0.5);
    border-radius: 4px;
    pointer-events: none;
    user-select: none;
    white-space: nowrap;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }

  /* ==========================================================================
   * Performance HUD (Phase 5.3)
   * ========================================================================== */

  .we-perf-hud {
    position: fixed;
    left: 12px;
    bottom: 12px;
    padding: 8px 10px;
    border-radius: 10px;
    background: rgba(15, 23, 42, 0.78);
    border: 1px solid rgba(51, 65, 85, 0.45);
    color: rgba(255, 255, 255, 0.96);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 12px;
    line-height: 1.25;
    pointer-events: none;
    user-select: none;
    white-space: nowrap;
    z-index: 10;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    font-variant-numeric: tabular-nums;
  }

  .we-perf-hud-line + .we-perf-hud-line {
    margin-top: 4px;
  }

  /* UI container - for panels and controls */
  /* Position below toolbar: 16px (toolbar top) + 40px (toolbar height) + 8px (gap) = 64px */
  #${WEB_EDITOR_V2_UI_ID} {
    position: fixed;
    top: 64px;
    right: 16px;
    pointer-events: auto;
    /* Inter font with system fallbacks (aligned with design spec) */
    font-family: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 11px;
    line-height: 1.4;
    color: var(--we-text-primary);
    -webkit-font-smoothing: antialiased;
  }

  /* Panel styles */
  /* max-height: 100vh - 64px (top offset) - 16px (bottom margin) = 100vh - 80px */
  .we-panel {
    width: 280px;
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 80px);
    background: var(--we-surface-bg);
    border: 1px solid var(--we-border-subtle);
    border-radius: var(--we-radius-panel);
    box-shadow: var(--we-shadow-panel);
    overflow: hidden;
    contain: layout style paint;
  }

  .we-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    background: var(--we-surface-bg);
    border-bottom: 1px solid var(--we-border-subtle);
    user-select: none;
  }

  .we-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
    color: var(--we-text-primary);
  }

  .we-badge {
    font-size: 10px;
    font-weight: 500;
    padding: 2px 6px;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    color: white;
    border-radius: 4px;
  }

  .we-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 500;
    color: #475569;
    background: white;
    border: 1px solid rgba(148, 163, 184, 0.5);
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .we-btn:hover {
    background: #f8fafc;
    border-color: rgba(148, 163, 184, 0.7);
  }

  .we-btn:active {
    background: #f1f5f9;
  }

  .we-btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--we-focus-ring);
  }

  .we-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .we-btn--primary {
    background: linear-gradient(135deg, #0f172a, #1e293b);
    color: #ffffff;
    border-color: rgba(15, 23, 42, 0.5);
  }

  .we-btn--primary:hover:not(:disabled) {
    background: linear-gradient(135deg, #1e293b, #334155);
    border-color: rgba(15, 23, 42, 0.65);
  }

  .we-btn--danger {
    color: #b91c1c;
    border-color: rgba(248, 113, 113, 0.45);
  }

  .we-btn--danger:hover:not(:disabled) {
    background: rgba(248, 113, 113, 0.08);
    border-color: rgba(248, 113, 113, 0.6);
  }

  /* Icon button (28x28) - used for window controls (close/minimize, etc.) */
  .we-icon-btn {
    width: var(--we-icon-btn-size);
    height: var(--we-icon-btn-size);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: var(--we-control-bg);
    border: 0;
    border-radius: var(--we-radius-control);
    color: var(--we-text-secondary);
    cursor: pointer;
    transition: background 0.15s ease, box-shadow 0.15s ease;
  }

  .we-icon-btn:hover {
    background: var(--we-control-bg-hover);
    color: var(--we-text-primary);
  }

  .we-icon-btn:active {
    background: var(--we-control-bg-hover);
  }

  .we-icon-btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--we-focus-ring);
  }

  .we-icon-btn svg {
    width: 16px;
    height: 16px;
    display: block;
  }

  /* Drag handle (grip) - used for repositioning floating UI */
  .we-drag-handle {
    width: var(--we-icon-btn-size);
    height: var(--we-icon-btn-size);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: 0;
    background: transparent;
    border: 0;
    border-radius: var(--we-radius-control);
    color: var(--we-text-muted);
    cursor: grab;
    touch-action: none;
    user-select: none;
    transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
  }

  .we-drag-handle:hover {
    background: var(--we-control-bg);
    color: var(--we-text-secondary);
  }

  .we-drag-handle:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--we-focus-ring);
  }

  .we-drag-handle:active,
  .we-drag-handle[data-dragging="true"] {
    cursor: grabbing;
    background: var(--we-control-bg-hover);
    color: var(--we-text-primary);
  }

  .we-drag-handle svg {
    width: 14px;
    height: 14px;
    display: block;
  }

  /* ==========================================================================
   * Toolbar (Redesigned per toolbar-ui.html design spec)
   * - Bounce easing animations
   * - Collapsible pill (580x40 <-> 40x40)
   * - Grip icon rotation on collapse
   * ========================================================================== */

  .we-toolbar {
    position: fixed;
    left: 50%;
    top: 16px;
    transform: translateX(-50%);
    width: 580px;
    height: 40px;
    max-width: calc(100vw - 32px);
    display: flex;
    align-items: center;
    background: #ffffff;
    border-radius: 999px;
    box-shadow: 0 -4px 10px -6px rgba(15, 23, 42, 0.18),
      0 10px 15px -3px rgba(203, 213, 225, 0.5),
      0 4px 6px -4px rgba(203, 213, 225, 0.5);
    pointer-events: auto;
    user-select: none;
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    font-size: 11px;
    color: #475569;
    transition: width 500ms var(--we-ease-bounce), height 500ms var(--we-ease-bounce);
    overflow: visible;
    will-change: width, height;
  }

  .we-toolbar[data-position="bottom"] {
    top: auto;
    bottom: 16px;
  }

  /* Dragged toolbar: use left/top (inline styles) instead of docked centering */
  .we-toolbar[data-dragged="true"] {
    left: auto;
    right: auto;
    top: auto;
    bottom: auto;
    transform: none;
  }

  /* Collapsed toolbar - 40x40 circle */
  .we-toolbar[data-minimized="true"] {
    width: 40px;
    height: 40px;
  }

  /* Toolbar content row (collapses with toolbar) */
  .we-toolbar-content {
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    gap: 10px;
    white-space: nowrap;
    padding-right: 8px;
    transition: opacity 350ms ease, transform 400ms var(--we-ease-bounce);
    will-change: opacity, transform;
  }

  .we-toolbar[data-minimized="true"] .we-toolbar-content {
    opacity: 0;
    transform: translateX(-16px) scale(0.95);
    pointer-events: none;
  }

  .we-toolbar[data-minimized="false"] .we-toolbar-content {
    opacity: 1;
    transform: translateX(0) scale(1);
    pointer-events: auto;
  }

  /* Grip toggle button (40x40, hover slate-50, active scale-90) */
  .we-toolbar .we-drag-handle {
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    border-radius: 999px;
    cursor: pointer;
    transition: background-color 150ms ease, transform 150ms ease;
  }

  .we-toolbar .we-drag-handle:hover {
    background: #f8fafc;
  }

  .we-toolbar .we-drag-handle:active {
    transform: scale(0.9);
  }

  /* Grip icon rotation (collapsed 90deg -> expanded 0deg) */
  .we-toolbar .we-drag-handle svg {
    width: 16px;
    height: 16px;
    color: #94a3b8;
    transition: transform 500ms var(--we-ease-bounce);
    transform: rotate(0deg);
  }

  .we-toolbar[data-minimized="true"] .we-drag-handle svg {
    transform: rotate(90deg);
  }

  /* Status indicator: green dot + "Editor" label */
  .we-toolbar-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: #f1f5f9;
    border-radius: 999px;
  }

  .we-toolbar-indicator-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: #10b981;
  }

  .we-toolbar-indicator-label {
    font-size: 11px;
    font-weight: 700;
    color: #334155;
    letter-spacing: 0.04em;
  }

  /* Status-driven dot color + pulse */
  .we-toolbar[data-status="progress"] .we-toolbar-indicator-dot {
    background: #6366f1;
    animation: we-toolbar-dot-pulse 1.5s ease-in-out infinite;
  }

  .we-toolbar[data-status="success"] .we-toolbar-indicator-dot {
    background: #10b981;
  }

  .we-toolbar[data-status="error"] .we-toolbar-indicator-dot {
    background: #ef4444;
  }

  @keyframes we-toolbar-dot-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }

  /* Undo/Redo counts */
  .we-toolbar-history {
    display: flex;
    gap: 10px;
    font-size: 10px;
    font-weight: 500;
    color: #94a3b8;
    font-variant-numeric: tabular-nums;
  }

  .we-toolbar-history-value {
    color: #475569;
    font-weight: 700;
  }

  /* Divider */
  .we-toolbar-divider {
    width: 1px;
    height: 16px;
    background: #e2e8f0;
  }

  /* Structure group (Structure button + divider + Undo/Redo icons) */
  .we-toolbar-structure-group {
    display: inline-flex;
    align-items: center;
    background: #f1f5f9;
    border-radius: 999px;
    padding: 2px;
  }

  .we-toolbar-structure-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    font-size: 11px;
    font-weight: 500;
    color: #64748b;
    background: transparent;
    border: 0;
    border-radius: 999px;
    cursor: pointer;
    transition: color 150ms ease, background-color 150ms ease;
  }

  .we-toolbar-structure-btn:hover:not(:disabled) {
    color: #1e293b;
    background: #ffffff;
  }

  .we-toolbar-structure-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .we-toolbar-structure-btn svg {
    width: 10px;
    height: 10px;
    opacity: 0.5;
    display: block;
  }

  .we-toolbar-structure-separator {
    width: 1px;
    height: 12px;
    background: #e2e8f0;
  }

  .we-toolbar-group-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    background: transparent;
    border: 0;
    border-radius: 999px;
    color: #94a3b8;
    cursor: pointer;
    transition: color 150ms ease, background-color 150ms ease;
  }

  .we-toolbar-group-icon-btn:hover:not(:disabled) {
    color: #334155;
    background: #ffffff;
  }

  .we-toolbar-group-icon-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .we-toolbar-group-icon-btn svg {
    width: 14px;
    height: 14px;
    display: block;
  }

  /* End actions container: pushes apply + close to far right */
  .we-toolbar-end-actions {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }

  /* Apply button (indigo-500) */
  .we-toolbar-apply-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px 16px;
    font-size: 11px;
    font-weight: 700;
    color: #ffffff;
    background: #6366f1;
    border: 0;
    border-radius: 999px;
    cursor: pointer;
    transition: background-color 150ms ease, transform 150ms ease, box-shadow 150ms ease;
    box-shadow: 0 4px 6px -1px rgba(99, 102, 241, 0.25),
      0 2px 4px -2px rgba(99, 102, 241, 0.25);
  }

  .we-toolbar-apply-btn:hover:not(:disabled) {
    background: #4f46e5;
  }

  .we-toolbar-apply-btn:active:not(:disabled) {
    transform: scale(0.95);
  }

  .we-toolbar-apply-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
    box-shadow: none;
  }

  /* Close button (red hover) */
  .we-toolbar-close-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px;
    background: transparent;
    border: 0;
    border-radius: 999px;
    color: #94a3b8;
    cursor: pointer;
    transition: color 150ms ease, background-color 150ms ease;
  }

  .we-toolbar-close-btn:hover:not(:disabled) {
    color: #ef4444;
    background: #fef2f2;
  }

  .we-toolbar-close-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .we-toolbar-close-btn svg {
    width: 14px;
    height: 14px;
    display: block;
  }

  /* Screen-reader-only utility */
  .we-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Respect reduced motion preference */
  @media (prefers-reduced-motion: reduce) {
    .we-toolbar,
    .we-toolbar-content,
    .we-toolbar .we-drag-handle,
    .we-toolbar .we-drag-handle svg,
    .we-toolbar-structure-btn,
    .we-toolbar-group-icon-btn,
    .we-toolbar-apply-btn,
    .we-toolbar-close-btn {
      transition: none;
    }
  }

  /* ==========================================================================
     Breadcrumbs (Phase 2.2) - Anchored to selection element
     ========================================================================== */
  .we-breadcrumbs {
    position: fixed;
    /* left/top set dynamically via JS based on selection rect */
    left: 16px;
    top: 72px;
    width: auto;
    max-width: min(600px, calc(100vw - 400px));
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 12px;
    background: #5494D7;
    border: none;
    border-radius: 0;
    box-shadow: 0 2px 8px rgba(84, 148, 215, 0.3);
    pointer-events: auto;
    user-select: none;
    overflow-x: auto;
    white-space: nowrap;
    scrollbar-width: none;
    z-index: 5;
  }

  .we-breadcrumbs[data-hidden="true"] {
    display: none;
  }

  .we-breadcrumbs[data-position="bottom"] {
    top: auto;
    bottom: 72px;
  }

  .we-breadcrumbs::-webkit-scrollbar {
    display: none;
  }

  .we-crumb {
    display: inline-flex;
    align-items: center;
    max-width: 220px;
    padding: 2px 6px;
    border-radius: 3px;
    border: none;
    background: transparent;
    color: #ffffff;
    font-size: 12px;
    font-weight: 500;
    line-height: 1.2;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    transition: background 0.15s ease;
  }

  .we-crumb:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  .we-crumb:active {
    background: rgba(255, 255, 255, 0.25);
  }

  .we-crumb:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.5);
  }

  .we-crumb--current {
    background: rgba(255, 255, 255, 0.2);
  }

  .we-crumb-sep {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    flex: 0 0 auto;
    color: rgba(255, 255, 255, 0.7);
    font-size: 12px;
  }

  .we-crumb-sep--shadow {
    color: rgba(255, 255, 255, 0.9);
  }

  .we-body {
    padding: 14px;
    color: #475569;
    font-size: 12px;
  }

  .we-status {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(34, 197, 94, 0.1);
    border-radius: 6px;
    color: #15803d;
    font-size: 12px;
  }

  .we-status-dot {
    width: 8px;
    height: 8px;
    background: #22c55e;
    border-radius: 50%;
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  /* ==========================================================================
     Property Panel (Phase 3)
     ========================================================================== */

  .we-prop-panel {
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 80px);
  }

  /* Dragged property panel: becomes a floating fixed panel positioned via left/top (inline styles) */
  .we-prop-panel[data-dragged="true"][data-minimized="false"] {
    position: fixed;
    left: auto;
    right: auto;
    top: auto;
    bottom: auto;
  }

  /* Minimized property panel - becomes a small icon button fixed at top-right */
  .we-prop-panel[data-minimized="true"] {
    position: fixed;
    top: 16px;
    right: 16px;
    width: auto;
    max-height: none;
    background: transparent;
    border: 0;
    box-shadow: none;
    overflow: visible;
    z-index: 10;
  }

  .we-prop-panel[data-minimized="true"] .we-header {
    padding: 0;
    background: transparent;
    border-bottom: 0;
  }

  /* Symmetric header layout: drag (left) | tabs (center) | minimize (right) */
  .we-prop-panel .we-header {
    padding: 8px;
    gap: 4px;
  }

  .we-prop-panel .we-header .we-prop-tabs {
    flex: 1;
    justify-content: center;
  }

  /* Minimize button chevron rotation */
  .we-minimize-btn svg {
    transition: transform 200ms ease;
  }

  .we-prop-panel[data-minimized="true"] .we-minimize-btn svg {
    transform: rotate(180deg);
  }

  /* Header tooltips: show below to avoid being clipped by panel overflow */
  .we-prop-panel .we-header [data-tooltip]::after {
    bottom: auto;
    top: calc(100% + 6px);
  }

  .we-prop-panel .we-header [data-tooltip]::before {
    bottom: auto;
    top: calc(100% + 2px);
    border-top-color: transparent;
    border-bottom-color: var(--we-text-primary);
  }

  /* Tab container with pill/segmented style (aligned with design spec) */
  .we-prop-tabs {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    background: var(--we-control-bg);
    border-radius: var(--we-radius-tab);
  }

  .we-tab {
    border: 0;
    background: transparent;
    color: var(--we-text-secondary);
    padding: 4px 10px;
    border-radius: var(--we-radius-tab);
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    transition: all 0.1s ease;
  }

  .we-tab:hover {
    color: var(--we-text-primary);
  }

  .we-tab:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--we-focus-ring);
  }

  /* Active tab: white background with subtle shadow */
  .we-tab[aria-selected="true"] {
    background: var(--we-surface-bg);
    color: var(--we-text-primary);
    box-shadow: var(--we-shadow-tab);
  }

  .we-prop-body {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 12px;
    padding-bottom: 80px; /* Extra space for scrolling (design spec: pb-20) */
    display: flex;
    flex-direction: column;
    gap: 12px;
    scrollbar-width: none; /* Firefox */
    -ms-overflow-style: none; /* IE 10+ */
  }

  /* Hide scrollbar for webkit browsers */
  .we-prop-body::-webkit-scrollbar {
    width: 0;
    height: 0;
  }

  /* Force hidden state for property panel sections during minimization */
  .we-prop-body[hidden],
  .we-prop-tabs[hidden] {
    display: none;
  }

  .we-prop-tab-content {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .we-prop-tab-content[hidden] {
    display: none;
  }

  .we-prop-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px 12px;
    color: #64748b;
    font-size: 12px;
    text-align: center;
  }

  .we-prop-empty[hidden] {
    display: none;
  }

  .we-prop-panel[data-empty="true"] .we-prop-tab-content {
    display: none;
  }

  /* ==========================================================================
     Components Tree (Phase 3.2)
     ========================================================================== */

  .we-tree {
    font-size: 12px;
    line-height: 1.4;
  }

  .we-tree-empty {
    padding: 24px 12px;
    color: #64748b;
    text-align: center;
  }

  .we-tree-empty[hidden] {
    display: none;
  }

  .we-tree-list {
    display: flex;
    flex-direction: column;
  }

  .we-tree-list[hidden] {
    display: none;
  }

  .we-tree-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    cursor: pointer;
    border-radius: 4px;
    transition: background 0.12s;
    color: #475569;
  }

  .we-tree-item:hover {
    background: rgba(59, 130, 246, 0.08);
  }

  .we-tree-item--selected {
    background: rgba(59, 130, 246, 0.12);
    color: #1d4ed8;
    font-weight: 500;
  }

  .we-tree-item--selected:hover {
    background: rgba(59, 130, 246, 0.16);
  }

  .we-tree-item--ancestor {
    color: #64748b;
  }

  .we-tree-item--child {
    color: #64748b;
    font-size: 11px;
  }

  .we-tree-indent {
    color: #94a3b8;
    font-family: monospace;
    user-select: none;
  }

  .we-tree-icon {
    flex-shrink: 0;
    color: #94a3b8;
    font-size: 10px;
  }

  .we-tree-item--selected .we-tree-icon {
    color: #3b82f6;
  }

  .we-tree-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }

  /* ==========================================================================
     Control Groups (Section style - aligned with design spec)
     Uses separator lines instead of card borders
     ========================================================================== */

  .we-group {
    /* No card-style border, use separator lines between sections */
    border: 0;
    border-radius: 0;
    overflow: visible;
    background: transparent;
  }

  /* Section separator - top border for non-first groups */
  .we-group + .we-group {
    border-top: 1px solid var(--we-border-section);
    padding-top: 12px;
    margin-top: 4px;
  }

  .we-group-header {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 0 0 8px 0;
    background: transparent;
  }

  .we-group-toggle {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 0;
    background: transparent;
    border: 0;
    cursor: pointer;
    color: #333333;
    font-size: 11px;
    font-weight: 600;
    text-align: left;
    transition: color 0.1s ease;
  }

  .we-group-toggle:hover {
    color: var(--we-text-primary);
  }

  .we-group-toggle:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--we-focus-ring);
    border-radius: 2px;
  }

  .we-group-toggle--static {
    cursor: default;
    pointer-events: none;
  }

  .we-group-header-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 0 0 auto;
  }

  .we-group-body {
    padding: 0;
    background: transparent;
    border-top: 0;
  }

  .we-group[data-collapsed="true"] .we-group-body {
    display: none;
  }

  .we-chevron {
    width: 12px;
    height: 12px;
    flex: 0 0 auto;
    color: var(--we-text-muted);
    transition: transform 0.1s ease;
  }

  .we-group[data-collapsed="true"] .we-chevron {
    transform: rotate(-90deg);
  }

  /* ==========================================================================
     Form Controls (for Design controls)
     ========================================================================== */

  /* Field row: vertical stack (label on top, control below) */
  .we-field {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
  }

  /* Horizontal field variant (label left, control right) */
  .we-field--horizontal {
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }

  .we-field-label {
    flex: 0 0 auto;
    width: auto;
    font-size: 10px;
    font-weight: 500;
    color: var(--we-text-secondary);
  }

  /* Fixed width label for horizontal layout */
  .we-field--horizontal .we-field-label {
    width: 48px;
  }

  .we-field-label--short {
    width: 20px;
  }

  /* Hint text (small label above icon groups for H/V distinction) */
  .we-field-hint {
    font-size: 9px;
    color: var(--we-text-muted);
    text-align: center;
    line-height: 1;
  }

  /* Content container for complex controls (icon groups, grids, etc.) */
  .we-field-content {
    width: 100%;
    min-width: 0;
  }

  /* Input styling aligned with design spec:
   * - Gray background by default
   * - Inset border on hover
   * - White background + blue inset border on focus
   */
  .we-input {
    flex: 1 1 auto;
    flex-shrink: 0; /* Prevent height shrinking in column flex containers */
    min-width: 0;
    height: 28px; /* Design spec: h-[28px] */
    padding: 0 8px;
    font-size: 11px;
    line-height: 26px; /* Ensure vertical centering: 28px - 2px border */
    font-family: inherit;
    color: var(--we-text-primary);
    background: var(--we-control-bg);
    border: 1px solid transparent;
    border-radius: var(--we-radius-control);
    outline: none;
    transition: background 0.1s ease, border-color 0.1s ease, box-shadow 0.1s ease;
  }

  .we-input::placeholder {
    color: var(--we-text-muted);
  }

  .we-input:hover:not(:focus) {
    border-color: var(--we-control-border-hover);
  }

  .we-input:focus {
    background: var(--we-control-bg-focus);
    border-color: var(--we-control-border-focus);
  }

  /* ==========================================================================
   * Input Container (Phase 2.1)
   *
   * A wrapper for inputs with prefix/suffix support.
   * Container handles hover/focus-within styling instead of input itself.
   * ========================================================================== */
  .we-input-container {
    min-width: 0;
    display: flex;
    align-items: center;
    height: 28px; /* Design spec: h-[28px] - must be explicit, not flex-controlled */
    flex-shrink: 0; /* Prevent height shrinking in column flex containers */
    padding: 0 8px;
    gap: 4px;
    background: var(--we-control-bg);
    border: 1px solid transparent;
    border-radius: var(--we-radius-control);
    transition: background 0.1s ease, border-color 0.1s ease, box-shadow 0.1s ease;
  }

  /* In row flex containers, allow input-container to grow horizontally */
  .we-field-row > .we-input-container,
  .we-radius-control .we-field-row > .we-input-container {
    flex: 1 1 0;
  }

  .we-input-container:hover:not(:focus-within) {
    border-color: var(--we-control-border-hover);
  }

  .we-input-container:focus-within {
    background: var(--we-control-bg-focus);
    border-color: var(--we-control-border-focus);
  }

  .we-input-container__input {
    flex: 1;
    min-width: 0;
    height: 100%;
    padding: 0;
    font-size: 11px;
    line-height: 26px; /* Ensure vertical centering within 28px container */
    font-family: inherit;
    color: var(--we-text-primary);
    background: transparent;
    border: none;
    outline: none;
  }

  .we-input-container__input::placeholder {
    color: var(--we-text-muted);
  }

  /* Number inputs: right-aligned text in containers */
  .we-input-container__input[inputmode="decimal"],
  .we-input-container__input[inputmode="numeric"] {
    text-align: right;
  }

  /* Prefix and suffix elements */
  .we-input-container__prefix,
  .we-input-container__suffix {
    flex: 0 0 auto;
    font-size: 10px;
    color: var(--we-text-muted);
    user-select: none;
    pointer-events: none;
  }

  .we-input-container__prefix {
    margin-right: 2px;
  }

  .we-input-container__suffix {
    margin-left: 2px;
  }

  /* Icon in prefix/suffix */
  .we-input-container__prefix svg,
  .we-input-container__suffix svg {
    width: 12px;
    height: 12px;
    display: block;
  }

  /* ==========================================================================
   * Slider Input (Opacity and other numeric ranges)
   * ========================================================================== */
  .we-slider-input {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
  }

  .we-slider-input__slider {
    flex: 1 1 auto;
    min-width: 0;
    height: 28px;
    margin: 0;
    padding: 0;
    background: transparent;
    -webkit-appearance: none;
    appearance: none;
    cursor: pointer;
  }

  .we-slider-input__slider:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .we-slider-input__slider::-webkit-slider-runnable-track {
    height: 4px;
    background: linear-gradient(
      to right,
      var(--we-control-border-focus) 0%,
      var(--we-control-border-focus) var(--progress, 0%),
      var(--we-control-bg) var(--progress, 0%),
      var(--we-control-bg) 100%
    );
    border: 1px solid var(--we-control-border-hover);
    border-radius: 999px;
  }

  .we-slider-input__slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    margin-top: -5px; /* (12px thumb - 4px track) / 2 + border */
    border-radius: 999px;
    background: var(--we-control-bg-focus);
    border: 1px solid var(--we-border-strong);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
  }

  .we-slider-input__slider:focus-visible {
    outline: none;
  }

  .we-slider-input__slider:focus-visible::-webkit-slider-thumb {
    border-color: var(--we-control-border-focus);
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
  }

  .we-slider-input__slider::-moz-range-track {
    height: 4px;
    background: linear-gradient(
      to right,
      var(--we-control-border-focus) 0%,
      var(--we-control-border-focus) var(--progress, 0%),
      var(--we-control-bg) var(--progress, 0%),
      var(--we-control-bg) 100%
    );
    border: 1px solid var(--we-control-border-hover);
    border-radius: 999px;
  }

  .we-slider-input__slider::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border-radius: 999px;
    background: var(--we-control-bg-focus);
    border: 1px solid var(--we-border-strong);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
  }

  .we-slider-input__slider:focus-visible::-moz-range-thumb {
    border-color: var(--we-control-border-focus);
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
  }

  .we-slider-input__number {
    flex: 0 0 auto;
  }

  /* ==========================================================================
   * Icon Button Group (Phase 4.1)
   *
   * A single-select grid of icon buttons (e.g. flex-direction control).
   * ========================================================================== */
  .we-icon-button-group {
    display: grid;
    gap: 4px;
  }

  .we-icon-button-group__btn {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 28px; /* Design spec: h-[28px] */
    padding: 4px;
    background: var(--we-control-bg);
    border: 1px solid transparent;
    border-radius: var(--we-radius-control);
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease;
  }

  .we-icon-button-group__btn:hover:not(:disabled) {
    background: var(--we-control-bg-hover);
  }

  .we-icon-button-group__btn:focus-visible {
    outline: none;
    border-color: var(--we-control-border-focus);
    box-shadow: inset 0 0 0 2px var(--we-control-border-focus); /* Design spec: 2px inset */
  }

  .we-icon-button-group__btn[data-selected="true"] {
    background: var(--we-control-bg-focus);
    border-color: var(--we-control-border-focus);
  }

  .we-icon-button-group__btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .we-icon-button-group__btn svg {
    width: 14px;
    height: 14px;
    color: var(--we-text-secondary);
  }

  .we-icon-button-group__btn[data-selected="true"] svg {
    color: var(--we-control-border-focus);
  }

  /* ==========================================================================
   * Toggle Button
   *
   * A pressable toggle button (e.g. flip X/Y controls).
   * ========================================================================== */
  .we-toggle-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 4px;
    background: var(--we-control-bg);
    border: 1px solid transparent;
    border-radius: var(--we-radius-control);
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease;
  }

  .we-toggle-btn:hover:not(:disabled) {
    background: var(--we-control-bg-hover);
  }

  .we-toggle-btn[aria-pressed="true"] {
    background: var(--we-control-bg-focus);
    border-color: var(--we-control-border-focus);
  }

  .we-toggle-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .we-toggle-btn svg {
    width: 14px;
    height: 14px;
    color: var(--we-text-secondary);
  }

  .we-toggle-btn[aria-pressed="true"] svg {
    color: var(--we-control-border-focus);
  }

  /* ==========================================================================
   * Alignment Grid (Phase 4.2)
   *
   * 3×3 single-select grid for justify-content + align-items.
   * ========================================================================== */
  .we-alignment-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    padding: 8px;
    min-height: 90px;
    background: #f9f9f9;
    border: 1px solid #f0f0f0;
    border-radius: var(--we-radius-control);
    place-items: center;
  }

  .we-alignment-grid__cell {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 2px;
    cursor: pointer;
    transition: background-color 0.1s ease;
  }

  .we-alignment-grid__cell:hover:not(:disabled) {
    background: rgba(0, 0, 0, 0.05);
  }

  .we-alignment-grid__cell:focus-visible {
    outline: 2px solid var(--we-control-border-focus);
    outline-offset: 1px;
  }

  .we-alignment-grid__cell:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Inactive dot */
  .we-alignment-grid__dot {
    width: 2px;
    height: 2px;
    background: var(--we-text-muted);
    border-radius: 50%;
  }

  /* Active marker (3 bars showing alignment) */
  .we-alignment-grid__marker {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    width: 12px;
    height: 12px;
  }

  .we-alignment-grid__bar {
    height: 2px;
    background: var(--we-control-border-focus);
    border-radius: 1px;
  }

  .we-alignment-grid__bar--1 { width: 8px; }
  .we-alignment-grid__bar--2 { width: 12px; }
  .we-alignment-grid__bar--3 { width: 4px; }

  /* ==========================================================================
   * Grid + Gap Two Column Layout (Layout Control)
   * ========================================================================== */

  .we-grid-gap-row {
    display: flex;
    gap: 8px;
  }

  .we-grid-gap-col {
    flex: 1;
    min-width: 0;
  }

  /* Keep Grid label space for alignment; hide text only when both columns are visible (grid mode) */
  .we-grid-gap-col--grid:not([hidden]):has(+ .we-grid-gap-col--gap:not([hidden])) .we-field-label {
    visibility: hidden;
  }

  .we-grid-gap-col .we-field-content {
    width: 100%;
    overflow: visible;
  }

  /* Gap inputs vertical layout */
  .we-grid-gap-inputs {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* ==========================================================================
   * Grid Dimensions Picker (Layout Control)
   * ========================================================================== */

  .we-grid-dimensions-preview {
    width: 100%;
    height: 64px; /* Match two rows of gap inputs: 28px + 8px gap + 28px */
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    font-size: 12px;
    font-family: inherit;
    color: var(--we-text-primary);
    background: var(--we-control-bg);
    border: 1px solid transparent;
    border-radius: var(--we-radius-control);
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease;
  }

  .we-grid-dimensions-preview:hover:not(:disabled) {
    background: var(--we-control-bg-hover);
  }

  .we-grid-dimensions-preview:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .we-grid-dimensions-popover {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 220px;
    padding: 10px;
    background: var(--we-surface-bg);
    border: 1px solid var(--we-border-subtle);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
    z-index: 60;
  }

  .we-grid-dimensions-popover[hidden] {
    display: none;
  }

  .we-grid-dimensions-inputs {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-bottom: 10px;
  }

  .we-grid-dimensions-times {
    font-size: 12px;
    color: var(--we-text-muted);
    user-select: none;
  }

  .we-grid-dimensions-matrix {
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    gap: 3px;
    padding: 6px;
    background: var(--we-surface-secondary);
    border: 1px solid var(--we-border-subtle);
    border-radius: var(--we-radius-control);
  }

  .we-grid-dimensions-cell {
    width: 100%;
    aspect-ratio: 1 / 1;
    background: transparent;
    border: 1px solid rgba(0, 0, 0, 0.10);
    border-radius: 2px;
    padding: 0;
    cursor: pointer;
    transition: background-color 0.08s ease, border-color 0.08s ease;
  }

  .we-grid-dimensions-cell[data-active="true"] {
    border-color: rgba(59, 130, 246, 0.65);
    background: rgba(59, 130, 246, 0.10);
  }

  .we-grid-dimensions-cell[data-selected="true"] {
    border-color: rgba(59, 130, 246, 0.9);
    background: rgba(59, 130, 246, 0.16);
  }

  .we-grid-dimensions-tooltip {
    margin-top: 8px;
    text-align: center;
    font-size: 11px;
    color: var(--we-text-secondary);
  }

  .we-grid-dimensions-tooltip[hidden] {
    display: none;
  }

  .we-input--short {
    width: 56px;
    flex: 0 0 auto;
  }

  /* Number inputs: right-aligned text */
  .we-input[type="text"][inputmode="decimal"],
  .we-input[type="number"] {
    text-align: right;
  }

  .we-select {
    flex: 1 1 auto;
    flex-shrink: 0; /* Prevent height shrinking in column flex containers */
    min-width: 0;
    height: 28px; /* Design spec: h-[28px] */
    padding: 0 24px 0 8px;
    font-size: 11px;
    line-height: 26px; /* Ensure vertical centering: 28px - 2px border */
    font-family: inherit;
    color: var(--we-text-primary);
    background: var(--we-control-bg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath fill='%23737373' d='M2.5 3.5l2.5 3 2.5-3'/%3E%3C/svg%3E") no-repeat right 8px center;
    border: 1px solid transparent;
    border-radius: var(--we-radius-control);
    outline: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    cursor: pointer;
    transition: background-color 0.1s ease, border-color 0.1s ease, box-shadow 0.1s ease;
  }

  .we-select:hover:not(:focus) {
    border-color: var(--we-control-border-hover);
  }

  .we-select:focus {
    background-color: var(--we-control-bg-focus);
    border-color: var(--we-control-border-focus);
  }

  /* Field row for multiple inputs side by side */
  .we-field-row {
    display: flex;
    align-items: stretch;
    gap: 8px;
  }

  /* Size field with mode select + input stacked vertically */
  .we-size-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 0;
  }

  .we-size-mode-select {
    width: 100%;
  }

  .we-field-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* ==========================================================================
     Effects (Box Shadow List)
     ========================================================================== */

  .we-effects-toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 6px;
  }

  .we-effects-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .we-effects-item-wrap {
    position: relative;
  }

  .we-effects-item {
    height: 28px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px;
    background: var(--we-control-bg);
    border: 1px solid transparent;
    border-radius: var(--we-radius-control);
    transition: background-color 0.1s ease, border-color 0.1s ease, opacity 0.1s ease;
  }

  .we-effects-item:hover {
    background: var(--we-control-bg-hover);
  }

  .we-effects-item[data-open="true"] {
    background: var(--we-control-bg-focus);
    border-color: var(--we-control-border-focus);
  }

  .we-effects-item[data-enabled="false"] {
    opacity: 0.55;
  }

  .we-effects-name {
    flex: 1;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    text-align: left;
    font-size: 11px;
    color: var(--we-text-primary);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .we-effects-name:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--we-focus-ring);
    border-radius: 4px;
  }

  .we-effects-icon-btn {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 0;
    border-radius: var(--we-radius-control);
    color: var(--we-text-secondary);
    cursor: pointer;
    padding: 0;
    transition: background-color 0.1s ease, color 0.1s ease;
  }

  .we-effects-icon-btn:hover:not(:disabled) {
    background: rgba(0, 0, 0, 0.06);
    color: var(--we-text-primary);
  }

  .we-effects-icon-btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--we-focus-ring);
  }

  .we-effects-icon-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .we-effects-icon-btn svg {
    width: 14px;
    height: 14px;
  }

  .we-effects-popover {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    width: 220px;
    max-width: 220px;
    padding: 10px;
    background: var(--we-surface-bg);
    border: 1px solid var(--we-border-subtle);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
    z-index: 60;
  }

  .we-effects-popover[hidden] {
    display: none;
  }

  .we-effects-popover-content {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* ==========================================================================
     Gradient Preview Bar (Phase 4B)
     ========================================================================== */

  .we-gradient-bar-row {
    width: 100%;
    padding: 4px 0 8px;
  }

  .we-gradient-bar {
    position: relative;
    width: 100%;
    height: 60px;
    border-radius: 14px;
    border: 1px solid var(--we-border-subtle);
    background-color: var(--we-control-bg);
    background-image: none; /* set inline by GradientControl */
    box-shadow:
      inset 0 1px 2px rgba(0, 0, 0, 0.08),
      inset 0 0 0 1px rgba(255, 255, 255, 0.5);
    overflow: hidden;
  }

  /* Gradient thumbs container */
  .we-gradient-bar-thumbs {
    position: absolute;
    inset: 0;
    pointer-events: none; /* thumbs enable pointer events individually */
  }

  /* Gradient thumb (color stop marker) */
  .we-gradient-thumb {
    pointer-events: auto;
    position: absolute;
    top: 50%;
    left: 0;
    transform: translate(-50%, -50%);
    z-index: 1;
    width: 32px;
    height: 32px;
    border-radius: 6px;
    border: 2px solid rgba(255, 255, 255, 0.98);
    background-color: transparent; /* set inline */
    cursor: pointer;
    padding: 0;
    box-sizing: border-box;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
    touch-action: none;
    user-select: none;
    transition: box-shadow 0.15s ease, z-index 0s;
  }

  .we-gradient-thumb:hover {
    box-shadow:
      0 0 0 2px rgba(59, 130, 246, 0.25),
      0 1px 3px rgba(0, 0, 0, 0.2);
  }

  .we-gradient-thumb:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 3px rgba(59, 130, 246, 0.4),
      0 1px 3px rgba(0, 0, 0, 0.2);
  }

  /* Selected thumb state - raise above unselected thumbs */
  .we-gradient-thumb--active {
    z-index: 2;
    box-shadow:
      0 0 0 3px rgba(59, 130, 246, 0.4),
      0 1px 3px rgba(0, 0, 0, 0.2);
  }

  /* Dragging thumb - always on top when overlapping at same position */
  .we-gradient-thumb--dragging {
    z-index: 3;
  }

  /* Dragging state - cursor feedback on entire bar */
  .we-gradient-bar--dragging {
    cursor: grabbing;
  }

  .we-gradient-bar--dragging .we-gradient-thumb {
    cursor: grabbing;
  }

  /* ==========================================================================
     Gradient Stops List (Phase 4D)
     ========================================================================== */

  .we-gradient-stops-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 0 4px;
  }

  .we-gradient-stops-title {
    font-size: 10px;
    font-weight: 600;
    color: var(--we-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .we-gradient-stops-add,
  .we-gradient-stop-remove {
    font-size: 14px;
    font-weight: 500;
    line-height: 1;
  }

  .we-gradient-stops-add:disabled,
  .we-gradient-stop-remove:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .we-gradient-stops-list {
    border: 1px solid var(--we-border-subtle);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.6);
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 180px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .we-gradient-stop-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 6px;
    border-radius: 8px;
    border: 1px solid transparent;
    background: rgba(255, 255, 255, 0.85);
    cursor: pointer;
    user-select: none;
    transition: border-color 0.15s ease, background 0.15s ease;
  }

  .we-gradient-stop-row:hover {
    background: rgba(59, 130, 246, 0.06);
  }

  .we-gradient-stop-row:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.35);
  }

  .we-gradient-stop-row--active {
    border-color: rgba(59, 130, 246, 0.6);
    box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.2);
  }

  .we-gradient-stop-pos {
    flex: 0 0 auto;
    min-width: 44px;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    color: var(--we-text-secondary);
    padding: 3px 6px;
    border-radius: 6px;
    background: var(--we-control-bg);
    cursor: pointer;
    transition: box-shadow 0.15s ease;
  }

  .we-gradient-stop-pos:hover {
    background: var(--we-control-bg-hover, var(--we-control-bg));
  }

  .we-gradient-stop-pos:focus-within {
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
  }

  /* Static position display (visible when row is not selected) */
  .we-gradient-stop-pos-static {
    display: block;
    width: 100%;
    text-align: right;
  }

  /* Position editor slot (visible when row is selected) */
  .we-gradient-stop-pos-editor {
    display: none;
    width: 100%;
  }

  /* Show editor and hide static in active row */
  .we-gradient-stop-row--active .we-gradient-stop-pos-static {
    display: none;
  }

  .we-gradient-stop-row--active .we-gradient-stop-pos-editor {
    display: block;
  }

  /* Position input styling */
  .we-gradient-stop-pos-input {
    width: 100%;
    border: 0;
    padding: 0;
    margin: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: right;
    outline: none;
    cursor: text;
  }

  .we-gradient-stop-pos-input::placeholder {
    color: var(--we-text-muted);
  }

  .we-gradient-stop-color {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    border-radius: 6px;
    background: var(--we-control-bg);
  }

  /* Static color display (visible when row is not selected) */
  .we-gradient-stop-color-static {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
  }

  .we-gradient-stop-color-static:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
    border-radius: 4px;
  }

  /* Color editor slot (visible when row is selected) */
  .we-gradient-stop-color-editor {
    flex: 1;
    min-width: 0;
    display: none;
  }

  /* When row is active: hide static, show editor */
  .we-gradient-stop-row--active .we-gradient-stop-color {
    padding: 0;
    background: transparent;
  }

  .we-gradient-stop-row--active .we-gradient-stop-color-static {
    display: none;
  }

  .we-gradient-stop-row--active .we-gradient-stop-color-editor {
    display: block;
  }

  .we-gradient-stop-swatch {
    flex: 0 0 auto;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    border: 1px solid rgba(0, 0, 0, 0.12);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2);
    background: transparent;
  }

  .we-gradient-stop-color-text {
    flex: 1;
    min-width: 0;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    color: var(--we-text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Spacing section (Padding / Margin) */
  .we-spacing-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .we-spacing-section + .we-spacing-section {
    margin-top: 10px;
  }

  .we-spacing-header {
    font-size: 10px;
    font-weight: 600;
    color: #6b7280;
  }

  /* Spacing 2x2 grid layout */
  .we-spacing-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  /* ==========================================================================
   * Border Radius Control
   * ========================================================================== */

  .we-radius-control {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .we-radius-corners-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  /* ==========================================================================
     CSS Panel (Phase 4.6)
     ========================================================================== */

  .we-css-panel {
    font-size: 11px;
    line-height: 1.5;
  }

  /* Code-semantic elements use monospace font */
  .we-css-rule-selector,
  .we-css-decl-name,
  .we-css-decl-value,
  .we-css-decl-colon,
  .we-css-decl-semi,
  .we-css-decl-important,
  .we-css-rule-source,
  .we-css-rule-spec {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }

  /* ==========================================================================
     Class Editor (Phase 4.7)
     ========================================================================== */

  .we-css-class-editor-mount {
    margin-bottom: 12px;
  }

  .we-class-editor {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border: 1px solid var(--we-border-subtle);
    border-radius: var(--we-radius-panel);
    background: var(--we-surface-bg);
    font-family: system-ui, -apple-system, sans-serif;
  }

  .we-class-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    flex: 0 1 auto;
  }

  .we-class-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: 999px;
    background: var(--we-accent-brand-bg);
    border: 1px solid var(--we-accent-brand-border);
    color: #4338ca;
    font-size: 11px;
    line-height: 1.2;
  }

  .we-class-chip-text {
    word-break: break-all;
  }

  .we-class-chip-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: rgba(67, 56, 202, 0.8);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    transition: background-color 0.15s ease;
  }

  .we-class-chip-remove:hover {
    background: rgba(99, 102, 241, 0.15);
    color: #4338ca;
  }

  .we-class-input {
    flex: 1 1 100px;
    min-width: 80px;
    padding: 5px 8px;
    font-size: 12px;
    border: 1px solid var(--we-border-subtle);
    border-radius: var(--we-radius-control);
    background: var(--we-control-bg-focus);
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }

  .we-class-input:focus {
    border-color: var(--we-control-border-focus);
    box-shadow: 0 0 0 2px var(--we-focus-ring);
  }

  .we-class-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .we-class-input::placeholder {
    color: #94a3b8;
  }

  .we-class-suggestions {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    background: var(--we-surface-bg);
    border: 1px solid var(--we-border-subtle);
    border-radius: var(--we-radius-panel);
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
    overflow: hidden;
    z-index: 20;
  }

  .we-class-suggestions[hidden] {
    display: none;
  }

  .we-class-suggestion {
    display: block;
    width: 100%;
    text-align: left;
    padding: 8px 10px;
    border: none;
    background: transparent;
    cursor: pointer;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    color: #0f172a;
    transition: background-color 0.1s ease;
  }

  .we-class-suggestion:hover {
    background: rgba(99, 102, 241, 0.08);
  }

  .we-class-suggestion:focus {
    outline: none;
    background: rgba(99, 102, 241, 0.12);
  }

  .we-css-info {
    padding: 8px 10px;
    background: var(--we-accent-info-bg);
    border-radius: var(--we-radius-control);
    color: var(--we-text-secondary);
    font-size: 10px;
    margin-bottom: 8px;
  }

  .we-css-info[hidden] {
    display: none;
  }

  .we-css-warnings {
    margin-bottom: 8px;
  }

  .we-css-warnings[hidden] {
    display: none;
  }

  .we-css-warning {
    padding: 6px 10px;
    background: var(--we-accent-warning-bg);
    border: 1px solid var(--we-accent-warning-border);
    border-radius: var(--we-radius-control);
    color: #92400e;
    font-size: 10px;
    margin-bottom: 4px;
  }

  .we-css-warning-more {
    padding: 4px 10px;
    color: #92400e;
    font-size: 10px;
    font-style: italic;
  }

  .we-css-empty {
    padding: 24px 12px;
    color: #64748b;
    text-align: center;
    font-family: system-ui, sans-serif;
    font-size: 12px;
  }

  .we-css-empty[hidden] {
    display: none;
  }

  .we-css-sections {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .we-css-section {
    border: 0;
    border-radius: 0;
    overflow: visible;
    background: transparent;
  }

  .we-css-section + .we-css-section {
    border-top: 1px solid var(--we-border-section);
    padding-top: 12px;
    margin-top: 4px;
  }

  .we-css-section[data-kind="inherited"] {
    background: transparent;
  }

  .we-css-section-header {
    padding: 0 0 8px 0;
    background: transparent;
    border-bottom: 0;
    font-weight: 600;
    color: var(--we-text-primary);
    font-size: 11px;
    text-transform: none;
    letter-spacing: normal;
  }

  .we-css-section-rules {
    padding: 0;
  }

  /* Flat list style (computed-like view) */
  .we-css-rule {
    margin: 0;
    padding: 0;
    background: transparent;
    border: 0;
    border-radius: 0;
  }

  .we-css-rule + .we-css-rule {
    border-top: 1px solid var(--we-border-section);
    padding-top: 10px;
    margin-top: 10px;
  }

  .we-css-rule[data-origin="inline"] {
    background: transparent;
  }

  .we-css-rule-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: nowrap;
    margin-bottom: 8px;
    padding-bottom: 0;
    border-bottom: 0;
  }

  .we-css-rule-selector {
    flex: 1 1 auto;
    min-width: 0;
    font-weight: 500;
    color: var(--we-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .we-css-rule[data-origin="inline"] .we-css-rule-selector {
    color: #92400e;
    font-style: italic;
  }

  .we-css-rule-source {
    flex-shrink: 0;
    color: var(--we-text-muted);
    font-size: 10px;
    margin-left: auto;
    max-width: 45%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .we-css-rule-spec {
    flex-shrink: 0;
    color: var(--we-text-muted);
    font-size: 9px;
    padding: 1px 4px;
    background: var(--we-control-bg);
    border-radius: 3px;
  }

  .we-css-decls {
    padding-left: 0;
  }

  /* Two-column grid layout for declarations */
  .we-css-decl {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
    column-gap: 12px;
    align-items: baseline;
    padding: 5px 0;
    color: var(--we-text-primary);
  }


  .we-css-decl[data-status="overridden"] {
    text-decoration: line-through;
    color: var(--we-text-muted);
  }

  .we-css-decl-name {
    color: var(--we-text-secondary);
    overflow-wrap: anywhere;
  }

  /* Hide punctuation for computed-like view */
  .we-css-decl-colon,
  .we-css-decl-semi {
    display: none;
  }

  /* Value container for flex layout with !important */
  .we-css-decl-value-container {
    display: flex;
    align-items: baseline;
    gap: 4px;
    min-width: 0;
  }

  .we-css-decl-value {
    color: var(--we-text-primary);
    margin-left: 0;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .we-css-decl[data-status="overridden"] .we-css-decl-name,
  .we-css-decl[data-status="overridden"] .we-css-decl-value {
    color: var(--we-text-muted);
  }

  .we-css-decl-important {
    flex-shrink: 0;
    color: #dc2626;
    font-weight: 600;
    font-size: 10px;
  }

  .we-css-decl[data-status="overridden"] .we-css-decl-important {
    color: #b8c4d0;
  }

  /* ==========================================================================
   * Token Picker (Phase 5.4)
   * ========================================================================== */

  .we-token-picker {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    background: white;
    border: 1px solid rgba(226, 232, 240, 0.95);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
    overflow: hidden;
    z-index: 30;
  }

  .we-token-picker[hidden] {
    display: none;
  }

  .we-token-filter {
    width: 100%;
    padding: 8px 10px;
    border: none;
    border-bottom: 1px solid rgba(226, 232, 240, 0.8);
    background: transparent;
    font-family: inherit;
    font-size: 11px;
    color: #0f172a;
    outline: none;
  }

  .we-token-filter::placeholder {
    color: #94a3b8;
  }

  .we-token-toggle-row {
    padding: 6px 10px;
    border-bottom: 1px solid rgba(226, 232, 240, 0.6);
    background: rgba(248, 250, 252, 0.5);
  }

  .we-token-toggle-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    color: #64748b;
    cursor: pointer;
  }

  .we-token-toggle-checkbox {
    width: 12px;
    height: 12px;
    margin: 0;
    cursor: pointer;
  }

  .we-token-list {
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .we-token-list[hidden] {
    display: none;
  }

  .we-token-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 8px 10px;
    border: none;
    background: transparent;
    cursor: pointer;
    transition: background-color 0.1s ease;
  }

  .we-token-item:hover {
    background: rgba(99, 102, 241, 0.06);
  }

  .we-token-item--selected,
  .we-token-item:focus {
    outline: none;
    background: rgba(99, 102, 241, 0.1);
  }

  .we-token-swatch {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2);
  }

  .we-token-name {
    flex: 1;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    color: #0f172a;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .we-token-value {
    flex-shrink: 0;
    max-width: 80px;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 10px;
    color: #64748b;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .we-token-empty {
    padding: 16px 10px;
    text-align: center;
    color: #94a3b8;
    font-size: 11px;
  }

  .we-token-empty[hidden] {
    display: none;
  }

  /* Token button for input fields */
  .we-token-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: rgba(99, 102, 241, 0.08);
    color: #6366f1;
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .we-token-btn:hover {
    background: rgba(99, 102, 241, 0.15);
  }

  .we-token-btn:focus {
    outline: none;
    box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.3);
  }

  .we-token-btn-icon {
    width: 12px;
    height: 12px;
  }

  /* ==========================================================================
   * Token Pill (Phase 5.3)
   *
   * Compact pill UI for displaying a CSS var() reference in input fields.
   * Used when ColorField value is a standalone var(--token) expression.
   * ========================================================================== */

  .we-token-pill {
    flex: 1;
    min-width: 0;
    height: 28px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px 0 4px;
    background: var(--we-control-bg);
    border: 1px solid transparent;
    border-radius: var(--we-radius-control);
    transition: background 0.1s ease, border-color 0.1s ease;
  }

  .we-token-pill:hover:not([data-disabled="true"]) {
    border-color: var(--we-control-border-hover);
  }

  .we-token-pill:focus-within {
    background: var(--we-control-bg-focus);
    border-color: var(--we-control-border-focus);
  }

  .we-token-pill[data-disabled="true"] {
    opacity: 0.5;
    pointer-events: none;
  }

  .we-token-pill[hidden] {
    display: none;
  }

  /* Leading slot: holds external element (ColorField swatch) or internal swatch */
  .we-token-pill__leading {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
  }

  /* Internal swatch (used when no external leading element provided) */
  .we-token-pill__swatch {
    width: 16px;
    height: 16px;
    border-radius: 4px;
    border: 1px solid rgba(0, 0, 0, 0.1);
    background: transparent;
  }

  /* Main clickable area */
  .we-token-pill__main {
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--we-text-primary);
    cursor: pointer;
    font-size: 11px;
    text-align: left;
  }

  .we-token-pill__main:focus {
    outline: none;
  }

  .we-token-pill__main:disabled {
    cursor: default;
  }

  /* Token name with ellipsis */
  .we-token-pill__name {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11px;
  }

  /* Link icon (rotated 45° to indicate variable binding) */
  .we-token-pill__icon {
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
    color: var(--we-text-muted);
    transform: rotate(45deg);
  }

  /* Clear button (hover to reveal) */
  .we-token-pill__clear {
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--we-text-muted);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease;
  }

  .we-token-pill:hover .we-token-pill__clear {
    opacity: 1;
    pointer-events: auto;
  }

  .we-token-pill__clear:hover {
    background: rgba(15, 23, 42, 0.06);
    color: var(--we-text-primary);
  }

  .we-token-pill__clear:focus {
    outline: none;
    opacity: 1;
    pointer-events: auto;
  }

  .we-token-pill__clear:disabled {
    cursor: default;
  }

  /* ==========================================================================
     Props Panel (Phase 7.3)
     ========================================================================== */

  .we-props-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .we-props-meta {
    padding: 0 0 8px 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .we-props-meta-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    color: var(--we-text-primary);
    font-size: 11px;
    font-weight: 600;
  }

  .we-props-component {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .we-props-badge {
    flex: 0 0 auto;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 999px;
    background: var(--we-accent-brand-bg);
    color: #1d4ed8;
  }

  .we-props-status {
    font-size: 11px;
    color: #64748b;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }

  .we-props-warning {
    font-size: 11px;
    color: #92400e;
    background: var(--we-accent-warning-bg);
    border: 1px solid var(--we-accent-warning-border);
    border-radius: var(--we-radius-control);
    padding: 6px 8px;
  }

  .we-props-error {
    font-size: 11px;
    color: #b91c1c;
    background: var(--we-accent-danger-bg);
    border: 1px solid var(--we-accent-danger-border);
    border-radius: var(--we-radius-control);
    padding: 6px 8px;
  }

  .we-props-source {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    padding: 4px 0;
  }

  .we-props-source[hidden] {
    display: none;
  }

  .we-props-source-label {
    flex: 0 0 auto;
    color: #64748b;
    font-weight: 500;
  }

  .we-props-source-path {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--we-text-primary);
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }

  .we-btn-small {
    padding: 2px 8px;
    font-size: 11px;
  }

  /* Source open button - minimal link style */
  .we-props-source-btn {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    margin-left: 2px;
    border: none;
    background: none;
    color: #64748b;
    cursor: pointer;
    transition: color 0.12s ease;
  }

  .we-props-source-btn:hover:not(:disabled) {
    color: #3b82f6;
  }

  .we-props-source-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .we-props-source-btn svg {
    display: block;
  }

  /* Tooltip - fixed position, mounted at shadow root level */
  .we-tooltip {
    position: fixed;
    transform: translateX(-50%);
    padding: 4px 8px;
    font-size: 11px;
    font-weight: 500;
    line-height: 1.2;
    color: #fff;
    background: rgba(15, 23, 42, 0.92);
    border-radius: 4px;
    white-space: nowrap;
    pointer-events: none;
    z-index: 10000;
  }

  .we-tooltip[hidden] {
    display: none;
  }

  .we-props-title-left {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .we-props-title-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
  }

  /* Action button - minimal icon style for title bar */
  .we-props-action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    border: none;
    background: none;
    color: var(--we-text-secondary);
    cursor: pointer;
    transition: color 0.12s ease;
  }

  .we-props-action-btn:hover:not(:disabled) {
    color: var(--we-text-primary);
  }

  .we-props-action-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .we-props-action-btn svg {
    display: block;
  }

  .we-props-list {
    overflow: hidden;
  }

  .we-props-empty {
    padding: 16px 12px;
    color: #64748b;
    font-size: 12px;
    text-align: center;
  }

  .we-props-empty[hidden] {
    display: none;
  }

  /* Loading animations */
  @keyframes we-shimmer {
    to {
      background-position: 200% center;
    }
  }

  @keyframes we-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .we-props-empty.we-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .we-props-empty.we-loading svg {
    flex-shrink: 0;
    color: #94a3b8;
  }

  .we-props-empty.we-loading span {
    background: linear-gradient(
      90deg,
      #64748b 0%,
      #94a3b8 50%,
      #64748b 100%
    );
    background-size: 200% auto;
    color: transparent;
    -webkit-background-clip: text;
    background-clip: text;
    animation: we-shimmer 2s linear infinite;
  }

  .we-props-group {
    padding: 0 0 8px 0;
    margin-top: 4px;
    color: var(--we-text-primary);
    font-size: 11px;
    font-weight: 600;
    border-top: 1px solid var(--we-border-section);
    padding-top: 12px;
  }

  .we-props-group:first-child {
    border-top: 0;
    margin-top: 0;
    padding-top: 0;
  }

  .we-props-group + .we-props-row {
    border-top: 0;
  }

  .we-props-rows {
    display: flex;
    flex-direction: column;
  }

  .we-props-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    border-top: 1px solid var(--we-border-section);
  }

  .we-props-row:first-child {
    border-top: 0;
  }

  .we-props-key {
    flex: 0 0 110px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    color: #334155;
  }

  .we-props-value {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }

  .we-props-value--readonly {
    justify-content: flex-start;
    color: #475569;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .we-props-input {
    width: 140px;
    max-width: 100%;
  }

  .we-props-input--invalid {
    border-color: rgba(248, 113, 113, 0.85);
  }

  .we-props-bool {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: #475569;
    cursor: pointer;
  }

  .we-props-checkbox {
    width: 14px;
    height: 14px;
    accent-color: #6366f1;
    cursor: pointer;
  }

  .we-props-checkbox:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* ==========================================================================
   * Color Field (Phase 4.4)
   * ========================================================================== */

  .we-color-field {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .we-color-swatch {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    padding: 0;
    position: relative;
    border: 1px solid var(--we-border-subtle);
    border-radius: var(--we-radius-control);
    background: var(--we-control-bg);
    cursor: pointer;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
    overflow: hidden;
  }

  .we-color-swatch:hover {
    border-color: var(--we-border-strong);
  }

  .we-color-swatch:focus-visible,
  .we-color-swatch:focus-within {
    outline: none;
    box-shadow: 0 0 0 2px var(--we-focus-ring);
  }

  .we-color-swatch:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Native color input overlays the swatch for direct click interaction */
  .we-color-native-input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
    border: none;
    padding: 0;
    margin: 0;
  }

  .we-color-text {
    flex: 1;
    min-width: 0;
  }

  /* ==========================================================================
   * Tooltip (data-tooltip)
   *
   * CSS-only tooltips using the data-tooltip attribute.
   * Shows on hover/focus with minimal delay.
   * ========================================================================== */

  [data-tooltip] {
    position: relative;
  }

  [data-tooltip]::after {
    content: attr(data-tooltip);
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 8px;
    font-size: 11px;
    font-family: inherit;
    font-weight: 400;
    line-height: 1.3;
    white-space: nowrap;
    color: var(--we-surface-bg);
    background-color: var(--we-text-primary);
    border-radius: var(--we-radius-control);
    opacity: 0;
    visibility: hidden;
    transition:
      opacity 100ms ease,
      visibility 100ms ease;
    pointer-events: none;
    z-index: 99999;
  }

  [data-tooltip]::before {
    content: '';
    position: absolute;
    bottom: calc(100% + 2px);
    left: 50%;
    transform: translateX(-50%);
    border: 4px solid transparent;
    border-top-color: var(--we-text-primary);
    opacity: 0;
    visibility: hidden;
    transition:
      opacity 100ms ease,
      visibility 100ms ease;
    pointer-events: none;
    z-index: 99999;
  }

  [data-tooltip]:hover::after,
  [data-tooltip]:focus-visible::after,
  [data-tooltip]:focus-within::after {
    opacity: 1;
    visibility: visible;
  }

  [data-tooltip]:hover::before,
  [data-tooltip]:focus-visible::before,
  [data-tooltip]:focus-within::before {
    opacity: 1;
    visibility: visible;
  }

  /* ==========================================================================
   * Global Hidden Rule
   * Ensures [hidden] attribute always hides elements, even when they have
   * explicit display values (flex, inline-flex, etc.)
   * ========================================================================== */
  [hidden] {
    display: none !important;
  }
`;

// =============================================================================
// Implementation
// =============================================================================

/**
 * Set a CSS property with !important flag
 */
function setImportantStyle(element: HTMLElement, property: string, value: string): void {
  element.style.setProperty(property, value, 'important');
}

// Note: The legacy createPanelContent has been replaced by createPropertyPanel (Phase 3)

/**
 * Mount the Shadow DOM host and return a manager interface
 */
export function mountShadowHost(options: ShadowHostOptions = {}): ShadowHostManager {
  const disposer = new Disposer();
  let elements: ShadowHostElements | null = null;

  // Clean up any existing host (from crash/reload)
  const existing = document.getElementById(WEB_EDITOR_V2_HOST_ID);
  if (existing) {
    try {
      existing.remove();
    } catch {
      // Best-effort cleanup
    }
  }

  // Create host element
  const host = document.createElement('div');
  host.id = WEB_EDITOR_V2_HOST_ID;
  host.setAttribute('data-mcp-web-editor', 'v2');

  // Apply host styles with !important to resist page CSS
  setImportantStyle(host, 'position', 'fixed');
  setImportantStyle(host, 'inset', '0');
  setImportantStyle(host, 'z-index', String(WEB_EDITOR_V2_Z_INDEX));
  setImportantStyle(host, 'pointer-events', 'none');
  setImportantStyle(host, 'contain', 'layout style paint');
  setImportantStyle(host, 'isolation', 'isolate');

  // Create shadow root
  const shadowRoot = host.attachShadow({ mode: 'open' });

  // Add styles
  const styleEl = document.createElement('style');
  styleEl.textContent = SHADOW_HOST_STYLES;
  shadowRoot.append(styleEl);

  // Create overlay container (for Canvas)
  const overlayRoot = document.createElement('div');
  overlayRoot.id = WEB_EDITOR_V2_OVERLAY_ID;

  // Create UI container (for panels)
  // Note: Property Panel is now created separately by editor.ts (Phase 3)
  const uiRoot = document.createElement('div');
  uiRoot.id = WEB_EDITOR_V2_UI_ID;

  shadowRoot.append(overlayRoot, uiRoot);

  // Mount to document
  const mountPoint = document.documentElement ?? document.body;
  mountPoint.append(host);
  disposer.add(() => host.remove());

  elements = { host, shadowRoot, overlayRoot, uiRoot };

  // Event isolation: prevent UI events from bubbling to page
  const blockedEvents = [
    'pointerdown',
    'pointerup',
    'pointermove',
    'pointerenter',
    'pointerleave',
    'mousedown',
    'mouseup',
    'mousemove',
    'mouseenter',
    'mouseleave',
    'click',
    'dblclick',
    'contextmenu',
    'keydown',
    'keyup',
    'keypress',
    'wheel',
    'touchstart',
    'touchmove',
    'touchend',
    'touchcancel',
    'focus',
    'blur',
    'input',
    'change',
  ];

  const stopPropagation = (event: Event) => {
    event.stopPropagation();
  };

  for (const eventType of blockedEvents) {
    disposer.listen(uiRoot, eventType, stopPropagation);
    // Also block overlay interactions (handles, guides) from bubbling to page
    // Note: capture-phase listeners on the page cannot be fully prevented
    disposer.listen(overlayRoot, eventType, stopPropagation);
  }

  // Helper: check if a node is part of the editor
  const isOverlayElement = (node: unknown): boolean => {
    if (!(node instanceof Node)) return false;
    if (node === host) return true;

    const root = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
    return root instanceof ShadowRoot && root.host === host;
  };

  // Helper: check if an event came from the editor UI
  const isEventFromUi = (event: Event): boolean => {
    try {
      if (typeof event.composedPath === 'function') {
        return event.composedPath().some((el) => isOverlayElement(el));
      }
    } catch {
      // Fallback to target
    }
    return isOverlayElement(event.target);
  };

  return {
    getElements: () => elements,
    isOverlayElement,
    isEventFromUi,
    dispose: () => {
      elements = null;
      disposer.dispose();
    },
  };
}
