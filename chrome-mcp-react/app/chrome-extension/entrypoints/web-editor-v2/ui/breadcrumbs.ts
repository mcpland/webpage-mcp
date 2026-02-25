/**
 * Breadcrumbs UI (Phase 2.2)
 *
 * Displays the composed ancestor chain for the currently selected element.
 * Supports Shadow DOM boundaries by walking getRootNode() and shadowRoot.host.
 *
 * Design:
 * - Anchored to the selected element's bounding box (above-left preferred)
 * - Uses CSS classes defined in shadow-host.ts
 * - Buttons select ancestor elements
 * - "⬡" separator marks Shadow DOM boundaries
 */

import type { ViewportRect } from '../overlay/canvas-overlay';
import { Disposer } from '../utils/disposables';

// =============================================================================
// Types
// =============================================================================

/** Position of the breadcrumbs bar */
export type BreadcrumbsDock = 'top' | 'bottom';

/** Options for creating the breadcrumbs component */
export interface BreadcrumbsOptions {
  /** Container element to append breadcrumbs to */
  container: HTMLElement;
  /** Position of the breadcrumbs bar */
  dock?: BreadcrumbsDock;
  /** Callback when a breadcrumb item is clicked */
  onSelect: (element: Element) => void;
}

/** Breadcrumbs public interface */
export interface Breadcrumbs {
  /** Set the target element to show breadcrumbs for */
  setTarget(element: Element | null): void;
  /** Set the anchor rectangle (viewport coordinates) for positioning */
  setAnchorRect(rect: ViewportRect | null): void;
  /** Cleanup */
  dispose(): void;
}

/** Internal representation of a breadcrumb item */
interface BreadcrumbItem {
  /** The actual DOM element */
  element: Element;
  /** Short display label */
  label: string;
  /** Full label for tooltip */
  fullLabel: string;
  /** True if there's a Shadow DOM boundary before this item */
  boundaryBefore: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/** Max depth to traverse the composed tree */
const MAX_COMPOSED_DEPTH = 64;

/** Max characters for a truncated label */
const MAX_LABEL_CHARS = 36;

/** Max class parts to include in label */
const MAX_CLASS_PARTS = 2;

/** Separator between normal parent-child relationships */
const NORMAL_SEPARATOR = '›';

/** Separator when crossing Shadow DOM boundary */
const SHADOW_SEPARATOR = '⬡';

/** Gap between anchor element and breadcrumbs bar */
const ANCHOR_GAP_PX = 10;

/** Padding from viewport edges */
const SAFE_PADDING_PX = 8;

/** Assumed property panel width for safe area calculation */
const PROPERTY_PANEL_WIDTH = 320;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Truncate a label string with ellipsis
 */
function truncateLabel(text: string, maxChars: number): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Format an element's display label (tag + id or classes)
 */
function formatElementLabel(element: Element): { label: string; fullLabel: string } {
  const tag = element.tagName.toLowerCase();
  const id = element.id?.trim();

  let suffix = '';
  if (id) {
    suffix = `#${id}`;
  } else {
    const classes = Array.from(element.classList ?? [])
      .map((c) => c.trim())
      .filter(Boolean)
      .slice(0, MAX_CLASS_PARTS);
    if (classes.length > 0) {
      suffix = `.${classes.join('.')}`;
    }
  }

  const fullLabel = `${tag}${suffix}`;
  return { fullLabel, label: truncateLabel(fullLabel, MAX_LABEL_CHARS) };
}

/**
 * Build breadcrumb items from target element to composed tree root.
 * Returns items in outer-to-inner order (root first, target last).
 */
function buildComposedBreadcrumbs(target: Element): BreadcrumbItem[] {
  const raw: Array<{ element: Element; crossToParent: boolean }> = [];

  let current: Element | null = target;
  for (let i = 0; current && i < MAX_COMPOSED_DEPTH; i++) {
    const tag = current.tagName.toUpperCase();
    // Stop at document root elements
    if (tag === 'HTML' || tag === 'BODY') break;

    const parent: Element | null = current.parentElement;
    if (parent) {
      raw.push({ element: current, crossToParent: false });
      current = parent;
      continue;
    }

    // Check for Shadow DOM boundary
    const rootNode = current.getRootNode?.();
    if (rootNode instanceof ShadowRoot && rootNode.host instanceof Element) {
      // Mark that we're crossing a Shadow DOM boundary to reach parent
      raw.push({ element: current, crossToParent: true });
      current = rootNode.host;
      continue;
    }

    // Reached document root or a non-element root
    raw.push({ element: current, crossToParent: false });
    break;
  }

  // Reverse to get outer-to-inner order
  // crossToParent indicates we crossed a Shadow DOM boundary to reach the parent
  // After reverse, this means the edge FROM THIS ITEM to its visual predecessor
  // has a boundary, so we mark boundaryBefore on this item
  return raw.reverse().map(({ element, crossToParent }) => {
    const { label, fullLabel } = formatElementLabel(element);
    return {
      element,
      label,
      fullLabel,
      // boundaryBefore: true means there's a Shadow DOM boundary between this item
      // and the previous item in the breadcrumb list
      boundaryBefore: crossToParent,
    };
  });
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a breadcrumbs component for displaying element ancestry.
 */
export function createBreadcrumbs(options: BreadcrumbsOptions): Breadcrumbs {
  const disposer = new Disposer();
  const dock = options.dock ?? 'top';

  let currentTarget: Element | null = null;
  let items: BreadcrumbItem[] = [];
  let anchorRect: ViewportRect | null = null;

  // Cached bar dimensions (measured only after content changes)
  let barW = 0;
  let barH = 0;

  // Create root nav element
  const root = document.createElement('nav');
  root.className = 'we-breadcrumbs';
  root.dataset.position = dock;
  root.dataset.hidden = 'true';
  root.setAttribute('aria-label', 'Selection breadcrumbs');

  options.container.append(root);
  disposer.add(() => root.remove());

  // ==========================================================================
  // Positioning Logic
  // ==========================================================================

  /**
   * Clamp a number between min and max
   */
  function clampNumber(value: number, min: number, max: number): number {
    if (max < min) return min;
    return Math.min(max, Math.max(min, value));
  }

  /**
   * Get the safe right boundary X (avoiding property panel)
   */
  function getSafeRightX(viewportW: number): number {
    // Reserve space for property panel on the right (16px margin + 320px panel + 16px gap)
    const panelReserved = 16 + PROPERTY_PANEL_WIDTH + 16;
    return viewportW - panelReserved;
  }

  /**
   * Measure bar dimensions after content change
   */
  function measureBarDimensions(): void {
    const rect = root.getBoundingClientRect();
    barW = rect.width;
    barH = rect.height;
  }

  /**
   * Update position based on anchor rect
   */
  function updatePosition(): void {
    if (!currentTarget) return;
    if (!anchorRect) return;
    if (!(barW > 0 && barH > 0)) return;

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const safeRightX = getSafeRightX(viewportW);

    // Prefer placing at the anchor's left edge, but clamp within safe area
    const maxLeft = Math.min(viewportW - SAFE_PADDING_PX - barW, safeRightX - barW);
    const left = clampNumber(anchorRect.left, SAFE_PADDING_PX, maxLeft);

    // Prefer above-left; if not enough room, switch to below-left
    const aboveTop = anchorRect.top - ANCHOR_GAP_PX - barH;
    const belowTop = anchorRect.top + anchorRect.height + ANCHOR_GAP_PX;
    const preferredTop = aboveTop >= SAFE_PADDING_PX ? aboveTop : belowTop;
    const top = clampNumber(preferredTop, SAFE_PADDING_PX, viewportH - SAFE_PADDING_PX - barH);

    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
  }

  /**
   * Render breadcrumb items to DOM
   */
  function render(): void {
    root.textContent = '';

    if (!currentTarget) {
      root.dataset.hidden = 'true';
      return;
    }
    root.dataset.hidden = 'false';

    const frag = document.createDocumentFragment();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Add separator before each item (except first)
      if (i > 0) {
        const sep = document.createElement('span');
        const isShadowBoundary = item.boundaryBefore;
        sep.className = isShadowBoundary ? 'we-crumb-sep we-crumb-sep--shadow' : 'we-crumb-sep';
        sep.textContent = isShadowBoundary ? SHADOW_SEPARATOR : NORMAL_SEPARATOR;
        sep.setAttribute('aria-hidden', 'true');
        frag.append(sep);
      }

      // Create button for this crumb
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'we-crumb';
      btn.dataset.index = String(i);
      btn.textContent = item.label;
      btn.title = item.fullLabel;

      // Mark current (last) item
      if (i === items.length - 1) {
        btn.classList.add('we-crumb--current');
        btn.setAttribute('aria-current', 'page');
      }

      frag.append(btn);
    }

    root.append(frag);

    // Measure bar dimensions after content change and update position
    measureBarDimensions();
    updatePosition();
  }

  // Event delegation for crumb clicks
  disposer.listen(root, 'click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const btn = target.closest('button.we-crumb');
    if (!(btn instanceof HTMLButtonElement)) return;

    event.preventDefault();

    const rawIndex = btn.dataset.index ?? '';
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0) return;

    const item = items[index];
    if (!item) return;

    // Only select if element is still connected
    if (item.element.isConnected) {
      options.onSelect(item.element);
    }
  });

  /**
   * Set the target element to build breadcrumbs for
   */
  function setTarget(element: Element | null): void {
    if (disposer.isDisposed) return;

    currentTarget = element;
    items = element ? buildComposedBreadcrumbs(element) : [];
    render();
  }

  /**
   * Set the anchor rectangle for positioning (called by editor on position updates)
   */
  function setAnchorRect(rect: ViewportRect | null): void {
    if (disposer.isDisposed) return;
    anchorRect = rect;
    updatePosition();
  }

  return {
    setTarget,
    setAnchorRect,
    dispose: () => disposer.dispose(),
  };
}
