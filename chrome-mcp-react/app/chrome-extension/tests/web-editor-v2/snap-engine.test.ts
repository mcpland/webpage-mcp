/**
 * Unit tests for Web Editor V2 Snap Engine
 *
 * Tests cover:
 * - mergeAnchors: Anchor collection merging
 * - computeResizeSnap: Snap computation during resize
 * - computeDistanceLabels: Distance label generation
 *
 * All functions tested here are pure functions with no DOM dependencies,
 * making them ideal for unit testing.
 */

import { describe, expect, it } from 'vitest';

import {
  computeDistanceLabels,
  computeResizeSnap,
  mergeAnchors,
  type ComputeDistanceLabelsParams,
  type ComputeResizeSnapParams,
  type SnapAnchors,
  type SnapLockX,
  type SnapLockY,
} from '@/entrypoints/web-editor-v2/core/snap-engine';
import type { ViewportRect } from '@/entrypoints/web-editor-v2/overlay/canvas-overlay';

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Creates a ViewportRect from coordinates and dimensions.
 */
function rect(left: number, top: number, width: number, height: number): ViewportRect {
  return { left, top, width, height };
}

/**
 * Default viewport dimensions for tests.
 */
const VIEWPORT = { width: 800, height: 600 };

/**
 * Creates default params for computeResizeSnap tests.
 */
function createSnapParams(overrides: Partial<ComputeResizeSnapParams>): ComputeResizeSnapParams {
  return {
    rect: rect(100, 100, 200, 150),
    resize: { hasWest: false, hasEast: false, hasNorth: false, hasSouth: false },
    anchors: { x: [], y: [] },
    thresholdPx: 6,
    hysteresisPx: 2,
    minSizePx: 10,
    lockX: null,
    lockY: null,
    viewport: VIEWPORT,
    ...overrides,
  };
}

/**
 * Creates default params for computeDistanceLabels tests.
 */
function createLabelParams(
  overrides: Partial<ComputeDistanceLabelsParams>,
): ComputeDistanceLabelsParams {
  return {
    rect: rect(100, 100, 200, 150),
    lockX: null,
    lockY: null,
    viewport: VIEWPORT,
    minGapPx: 1,
    ...overrides,
  };
}

// =============================================================================
// mergeAnchors Tests
// =============================================================================

describe('snap-engine: mergeAnchors', () => {
  it('returns empty anchors when called with no arguments', () => {
    const result = mergeAnchors();
    expect(result).toEqual({ x: [], y: [] });
  });

  it('returns the same anchors when called with single collection', () => {
    const anchors: SnapAnchors = {
      x: [{ type: 'left', value: 0, source: 'viewport' }],
      y: [{ type: 'top', value: 0, source: 'viewport' }],
    };

    const result = mergeAnchors(anchors);

    expect(result.x).toHaveLength(1);
    expect(result.y).toHaveLength(1);
  });

  it('concatenates anchors from multiple collections in order', () => {
    const collection1: SnapAnchors = {
      x: [{ type: 'left', value: 0, source: 'viewport' }],
      y: [{ type: 'top', value: 0, source: 'viewport' }],
    };

    const collection2: SnapAnchors = {
      x: [{ type: 'center', value: 50, source: 'sibling', sourceRect: rect(40, 0, 20, 20) }],
      y: [],
    };

    const collection3: SnapAnchors = {
      x: [{ type: 'right', value: 100, source: 'sibling', sourceRect: rect(80, 0, 20, 20) }],
      y: [{ type: 'bottom', value: 100, source: 'viewport' }],
    };

    const result = mergeAnchors(collection1, collection2, collection3);

    expect(result.x).toHaveLength(3);
    expect(result.y).toHaveLength(2);

    // Verify order is preserved
    expect(result.x[0]).toMatchObject({ type: 'left', value: 0 });
    expect(result.x[1]).toMatchObject({ type: 'center', value: 50 });
    expect(result.x[2]).toMatchObject({ type: 'right', value: 100 });
  });

  it('handles empty collections gracefully', () => {
    const empty: SnapAnchors = { x: [], y: [] };
    const nonEmpty: SnapAnchors = {
      x: [{ type: 'left', value: 10, source: 'viewport' }],
      y: [],
    };

    const result = mergeAnchors(empty, nonEmpty, empty);

    expect(result.x).toHaveLength(1);
    expect(result.y).toHaveLength(0);
  });
});

// =============================================================================
// computeResizeSnap Tests
// =============================================================================

describe('snap-engine: computeResizeSnap', () => {
  describe('basic snapping', () => {
    it('snaps west edge within threshold and emits vertical guide line', () => {
      const params = createSnapParams({
        rect: rect(103, 100, 197, 150), // left edge at 103
        resize: { hasWest: true, hasEast: false, hasNorth: false, hasSouth: false },
        anchors: {
          x: [{ type: 'left', value: 100, source: 'viewport' }], // anchor at 100
          y: [],
        },
      });

      const result = computeResizeSnap(params);

      // Should snap left edge from 103 to 100 (distance 3 < threshold 6)
      expect(result.snappedRect.left).toBe(100);
      expect(result.snappedRect.width).toBe(200); // width adjusted
      expect(result.lockX).toMatchObject({ type: 'left', value: 100, source: 'viewport' });
      expect(result.lockY).toBeNull();
      expect(result.guideLines).toHaveLength(1);
      expect(result.guideLines[0]).toEqual({ x1: 100, y1: 0, x2: 100, y2: VIEWPORT.height });
    });

    it('snaps east edge within threshold', () => {
      const params = createSnapParams({
        rect: rect(100, 100, 197, 150), // right edge at 297
        resize: { hasWest: false, hasEast: true, hasNorth: false, hasSouth: false },
        anchors: {
          x: [{ type: 'right', value: 300, source: 'viewport' }], // anchor at 300
          y: [],
        },
      });

      const result = computeResizeSnap(params);

      // Should snap right edge from 297 to 300
      expect(result.snappedRect.left).toBe(100); // left unchanged
      expect(result.snappedRect.width).toBe(200);
      expect(result.lockX).toMatchObject({ type: 'right', value: 300 });
    });

    it('snaps north edge within threshold and emits horizontal guide line', () => {
      const params = createSnapParams({
        rect: rect(100, 104, 200, 146), // top edge at 104
        resize: { hasWest: false, hasEast: false, hasNorth: true, hasSouth: false },
        anchors: {
          x: [],
          y: [{ type: 'top', value: 100, source: 'viewport' }],
        },
      });

      const result = computeResizeSnap(params);

      expect(result.snappedRect.top).toBe(100);
      expect(result.snappedRect.height).toBe(150);
      expect(result.lockY).toMatchObject({ type: 'top', value: 100 });
      expect(result.guideLines).toHaveLength(1);
      expect(result.guideLines[0]).toEqual({ x1: 0, y1: 100, x2: VIEWPORT.width, y2: 100 });
    });

    it('snaps south edge within threshold', () => {
      const params = createSnapParams({
        rect: rect(100, 100, 200, 147), // bottom edge at 247
        resize: { hasWest: false, hasEast: false, hasNorth: false, hasSouth: true },
        anchors: {
          x: [],
          y: [{ type: 'bottom', value: 250, source: 'viewport' }],
        },
      });

      const result = computeResizeSnap(params);

      expect(result.snappedRect.top).toBe(100);
      expect(result.snappedRect.height).toBe(150);
      expect(result.lockY).toMatchObject({ type: 'bottom', value: 250 });
    });
  });

  describe('threshold behavior', () => {
    it('does not snap when distance exceeds threshold', () => {
      const params = createSnapParams({
        rect: rect(100, 100, 200, 150),
        resize: { hasWest: true, hasEast: false, hasNorth: false, hasSouth: false },
        anchors: {
          x: [{ type: 'left', value: 90, source: 'viewport' }], // distance 10 > threshold 6
          y: [],
        },
      });

      const result = computeResizeSnap(params);

      expect(result.snappedRect).toEqual(params.rect);
      expect(result.lockX).toBeNull();
      expect(result.guideLines).toEqual([]);
    });

    it('snaps at exactly the threshold distance', () => {
      const params = createSnapParams({
        rect: rect(106, 100, 194, 150),
        resize: { hasWest: true, hasEast: false, hasNorth: false, hasSouth: false },
        anchors: {
          x: [{ type: 'left', value: 100, source: 'viewport' }], // distance exactly 6
          y: [],
        },
      });

      const result = computeResizeSnap(params);

      expect(result.snappedRect.left).toBe(100);
      expect(result.lockX).not.toBeNull();
    });
  });

  describe('anchor priority', () => {
    it('prefers sibling anchors over viewport anchors at equal distance', () => {
      // Both anchors at same value (100), same type (left), same distance from rect.left (103)
      // When hasWest: true, we're moving the left edge, so 'left' type anchors are allowed
      const siblingRect = rect(50, 0, 50, 50);
      const params = createSnapParams({
        rect: rect(103, 100, 197, 150), // left edge at 103
        resize: { hasWest: true, hasEast: false, hasNorth: false, hasSouth: false },
        anchors: {
          x: [
            { type: 'left', value: 100, source: 'viewport' }, // distance 3, left type
            { type: 'left', value: 100, source: 'sibling', sourceRect: siblingRect }, // distance 3, left type
          ],
          y: [],
        },
      });

      const result = computeResizeSnap(params);

      // Sibling should be preferred over viewport at equal distance
      expect(result.lockX?.source).toBe('sibling');
      expect(result.snappedRect.left).toBe(100);
    });

    it('chooses closest anchor regardless of source when distances differ', () => {
      // Both anchors have 'left' type (allowed for hasWest resize), but different distances
      const siblingRect = rect(50, 0, 50, 50);
      const params = createSnapParams({
        rect: rect(103, 100, 197, 150), // left edge at 103
        resize: { hasWest: true, hasEast: false, hasNorth: false, hasSouth: false },
        anchors: {
          x: [
            { type: 'left', value: 102, source: 'viewport' }, // distance 1, left type
            { type: 'left', value: 100, source: 'sibling', sourceRect: siblingRect }, // distance 3, left type
          ],
          y: [],
        },
      });

      const result = computeResizeSnap(params);

      // Closer anchor (viewport at 102) should be chosen despite sibling having priority at equal distance
      expect(result.lockX?.source).toBe('viewport');
      expect(result.snappedRect.left).toBe(102);
    });
  });

  describe('hysteresis (lock stability)', () => {
    it('maintains existing lock within threshold + hysteresis', () => {
      const lockX: SnapLockX = {
        type: 'left',
        value: 100,
        source: 'viewport',
        sourceRect: null,
      };

      const params = createSnapParams({
        rect: rect(107, 100, 193, 150), // distance 7 from lock (threshold 6 + hysteresis 2 = 8)
        resize: { hasWest: true, hasEast: false, hasNorth: false, hasSouth: false },
        anchors: { x: [], y: [] },
        lockX,
      });

      const result = computeResizeSnap(params);

      expect(result.lockX).toMatchObject({ type: 'left', value: 100 });
      expect(result.snappedRect.left).toBe(100); // still snapped
    });

    it('releases lock when distance exceeds threshold + hysteresis', () => {
      const lockX: SnapLockX = {
        type: 'left',
        value: 100,
        source: 'viewport',
        sourceRect: null,
      };

      const params = createSnapParams({
        rect: rect(109, 100, 191, 150), // distance 9 > threshold 6 + hysteresis 2
        resize: { hasWest: true, hasEast: false, hasNorth: false, hasSouth: false },
        anchors: { x: [], y: [] },
        lockX,
      });

      const result = computeResizeSnap(params);

      expect(result.lockX).toBeNull();
      expect(result.snappedRect.left).toBe(109); // no snap
    });
  });

  describe('minimum size constraint', () => {
    it('rejects snap that would violate minimum width', () => {
      const params = createSnapParams({
        rect: rect(100, 100, 20, 150),
        resize: { hasWest: true, hasEast: false, hasNorth: false, hasSouth: false },
        anchors: {
          x: [{ type: 'left', value: 115, source: 'viewport' }], // would make width = 5
          y: [],
        },
        minSizePx: 10,
        thresholdPx: 20, // large threshold to ensure snap would trigger
      });

      const result = computeResizeSnap(params);

      expect(result.lockX).toBeNull();
      expect(result.snappedRect).toEqual(params.rect);
    });

    it('rejects snap that would violate minimum height', () => {
      const params = createSnapParams({
        rect: rect(100, 100, 200, 15),
        resize: { hasWest: false, hasEast: false, hasNorth: true, hasSouth: false },
        anchors: {
          x: [],
          y: [{ type: 'top', value: 110, source: 'viewport' }], // would make height = 5
        },
        minSizePx: 10,
        thresholdPx: 20,
      });

      const result = computeResizeSnap(params);

      expect(result.lockY).toBeNull();
    });
  });

  describe('invalid rect handling', () => {
    it('returns unchanged rect and clears locks for zero-width rect', () => {
      const lockX: SnapLockX = { type: 'left', value: 0, source: 'viewport', sourceRect: null };
      const params = createSnapParams({
        rect: rect(0, 0, 0, 100),
        lockX,
        lockY: null,
      });

      const result = computeResizeSnap(params);

      expect(result.snappedRect).toEqual(params.rect);
      expect(result.lockX).toBeNull();
      expect(result.lockY).toBeNull();
      expect(result.guideLines).toEqual([]);
    });

    it('returns unchanged rect for zero-height rect', () => {
      const params = createSnapParams({
        rect: rect(0, 0, 100, 0),
      });

      const result = computeResizeSnap(params);

      expect(result.snappedRect).toEqual(params.rect);
    });
  });

  describe('multi-direction resize', () => {
    it('snaps both X and Y axes simultaneously', () => {
      const params = createSnapParams({
        rect: rect(103, 97, 197, 153),
        resize: { hasWest: true, hasEast: false, hasNorth: true, hasSouth: false },
        anchors: {
          x: [{ type: 'left', value: 100, source: 'viewport' }],
          y: [{ type: 'top', value: 100, source: 'viewport' }],
        },
      });

      const result = computeResizeSnap(params);

      expect(result.snappedRect.left).toBe(100);
      expect(result.snappedRect.top).toBe(100);
      expect(result.lockX).not.toBeNull();
      expect(result.lockY).not.toBeNull();
      expect(result.guideLines).toHaveLength(2);
    });
  });

  describe('center/middle anchor snapping', () => {
    it('snaps to center anchor when resizing from west (left is fixed)', () => {
      // When hasEast: true, fixedEdgeX = 'left', allowedTypes = ['right', 'center']
      const params = createSnapParams({
        rect: rect(100, 100, 198, 150), // center at 199, right at 298
        resize: { hasWest: false, hasEast: true, hasNorth: false, hasSouth: false },
        anchors: {
          x: [{ type: 'center', value: 200, source: 'viewport' }], // distance 1
          y: [],
        },
      });

      const result = computeResizeSnap(params);

      // Center snapped to 200, so width = (200 - 100) * 2 = 200
      expect(result.snappedRect.left).toBe(100); // left unchanged
      expect(result.snappedRect.width).toBe(200);
      expect(result.lockX).toMatchObject({ type: 'center', value: 200 });
    });

    it('snaps to middle anchor when resizing from south', () => {
      // When hasSouth: true, fixedEdgeY = 'top', allowedTypes = ['bottom', 'middle']
      const params = createSnapParams({
        rect: rect(100, 100, 200, 148), // middle at 174, bottom at 248
        resize: { hasWest: false, hasEast: false, hasNorth: false, hasSouth: true },
        anchors: {
          x: [],
          y: [{ type: 'middle', value: 175, source: 'viewport' }], // distance 1
        },
      });

      const result = computeResizeSnap(params);

      // Middle snapped to 175, so height = (175 - 100) * 2 = 150
      expect(result.snappedRect.top).toBe(100);
      expect(result.snappedRect.height).toBe(150);
      expect(result.lockY).toMatchObject({ type: 'middle', value: 175 });
    });
  });

  describe('lock invalidation', () => {
    it('clears lock when its type is not allowed for current resize direction', () => {
      // Lock was on 'right' but now we're resizing from east (which allows right/center)
      // When hasWest: true, only 'left' and 'center' are allowed
      const lockX: SnapLockX = {
        type: 'right',
        value: 300,
        source: 'viewport',
        sourceRect: null,
      };

      const params = createSnapParams({
        rect: rect(100, 100, 200, 150),
        resize: { hasWest: true, hasEast: false, hasNorth: false, hasSouth: false },
        anchors: { x: [], y: [] },
        lockX,
      });

      const result = computeResizeSnap(params);

      // Lock should be cleared because 'right' is not in allowed types for west resize
      expect(result.lockX).toBeNull();
    });

    it('clears lock when axis is not being resized', () => {
      // X-axis lock but no X resize is happening
      const lockX: SnapLockX = {
        type: 'left',
        value: 100,
        source: 'viewport',
        sourceRect: null,
      };

      const params = createSnapParams({
        rect: rect(100, 100, 200, 150),
        resize: { hasWest: false, hasEast: false, hasNorth: true, hasSouth: false }, // only Y resize
        anchors: { x: [], y: [] },
        lockX,
      });

      const result = computeResizeSnap(params);

      expect(result.lockX).toBeNull();
    });
  });

  describe('sibling guide line extent', () => {
    it('generates guide line spanning from source to target element for sibling snap', () => {
      const siblingRect = rect(50, 20, 50, 60); // right edge at 100, bottom at 80
      const params = createSnapParams({
        rect: rect(103, 100, 197, 150), // top at 100, bottom at 250
        resize: { hasWest: true, hasEast: false, hasNorth: false, hasSouth: false },
        anchors: {
          x: [{ type: 'left', value: 100, source: 'sibling', sourceRect: siblingRect }],
          y: [],
        },
      });

      const result = computeResizeSnap(params);

      expect(result.guideLines).toHaveLength(1);
      // Guide line should span from sibling's vertical extent to target's vertical extent
      // min(sibling.top, target.top) to max(sibling.bottom, target.bottom)
      expect(result.guideLines[0]).toEqual({
        x1: 100,
        y1: Math.min(siblingRect.top, 100), // 20
        x2: 100,
        y2: Math.max(80, 250), // 250
      });
    });
  });
});

// =============================================================================
// computeDistanceLabels Tests
// =============================================================================

describe('snap-engine: computeDistanceLabels', () => {
  describe('sibling gap labels', () => {
    it('computes vertical gap from X-axis sibling lock', () => {
      const sourceRect = rect(100, 30, 50, 50); // bottom at 80
      const lockX: SnapLockX = {
        type: 'left',
        value: 100,
        source: 'sibling',
        sourceRect,
      };

      const params = createLabelParams({
        rect: rect(100, 100, 200, 150), // top at 100, gap = 20
        lockX,
      });

      const labels = computeDistanceLabels(params);

      expect(labels).toHaveLength(1);
      expect(labels[0]).toMatchObject({
        kind: 'sibling',
        axis: 'y',
        value: 20,
        text: '20px',
      });
      expect(labels[0]?.line).toEqual({ x1: 100, y1: 80, x2: 100, y2: 100 });
    });

    it('computes horizontal gap from Y-axis sibling lock', () => {
      const sourceRect = rect(30, 100, 50, 50); // right at 80
      const lockY: SnapLockY = {
        type: 'top',
        value: 100,
        source: 'sibling',
        sourceRect,
      };

      const params = createLabelParams({
        rect: rect(100, 100, 200, 150), // left at 100, gap = 20
        lockY,
      });

      const labels = computeDistanceLabels(params);

      expect(labels).toHaveLength(1);
      expect(labels[0]).toMatchObject({
        kind: 'sibling',
        axis: 'x',
        value: 20,
        text: '20px',
      });
      expect(labels[0]?.line).toEqual({ x1: 80, y1: 100, x2: 100, y2: 100 });
    });

    it('hides labels for gaps below minGapPx', () => {
      const sourceRect = rect(100, 99.5, 50, 0.3); // bottom at 99.8
      const lockX: SnapLockX = {
        type: 'left',
        value: 100,
        source: 'sibling',
        sourceRect,
      };

      const params = createLabelParams({
        rect: rect(100, 100, 200, 150), // gap = 0.2
        lockX,
        minGapPx: 1,
      });

      const labels = computeDistanceLabels(params);

      expect(labels).toEqual([]);
    });

    it('hides labels for zero gap (touching elements)', () => {
      const sourceRect = rect(100, 50, 50, 50); // bottom at 100
      const lockX: SnapLockX = {
        type: 'left',
        value: 100,
        source: 'sibling',
        sourceRect,
      };

      const params = createLabelParams({
        rect: rect(100, 100, 200, 150), // top at 100, gap = 0
        lockX,
      });

      const labels = computeDistanceLabels(params);

      expect(labels).toEqual([]);
    });

    it('computes vertical gap when target is above source (reverse direction)', () => {
      const sourceRect = rect(100, 150, 50, 50); // top at 150
      const lockX: SnapLockX = {
        type: 'left',
        value: 100,
        source: 'sibling',
        sourceRect,
      };

      const params = createLabelParams({
        rect: rect(100, 50, 200, 80), // bottom at 130, gap = 20
        lockX,
      });

      const labels = computeDistanceLabels(params);

      expect(labels).toHaveLength(1);
      expect(labels[0]).toMatchObject({
        kind: 'sibling',
        axis: 'y',
        value: 20,
        text: '20px',
      });
    });

    it('computes horizontal gap when target is left of source (reverse direction)', () => {
      const sourceRect = rect(250, 100, 50, 50); // left at 250
      const lockY: SnapLockY = {
        type: 'top',
        value: 100,
        source: 'sibling',
        sourceRect,
      };

      const params = createLabelParams({
        rect: rect(100, 100, 100, 150), // right at 200, gap = 50
        lockY,
      });

      const labels = computeDistanceLabels(params);

      expect(labels).toHaveLength(1);
      expect(labels[0]).toMatchObject({
        kind: 'sibling',
        axis: 'x',
        value: 50,
        text: '50px',
      });
    });

    it('hides labels for overlapping elements (negative gap)', () => {
      const sourceRect = rect(100, 80, 50, 50); // bottom at 130
      const lockX: SnapLockX = {
        type: 'left',
        value: 100,
        source: 'sibling',
        sourceRect,
      };

      const params = createLabelParams({
        rect: rect(100, 100, 200, 150), // top at 100, overlaps with source
        lockX,
      });

      const labels = computeDistanceLabels(params);

      // Negative gap (overlap) should not produce labels
      expect(labels).toEqual([]);
    });
  });

  describe('viewport margin labels', () => {
    it('shows viewport margin for X-axis viewport lock (left align)', () => {
      const lockX: SnapLockX = {
        type: 'left',
        value: 50,
        source: 'viewport',
        sourceRect: null,
      };

      const params = createLabelParams({
        rect: rect(50, 100, 200, 150), // left=50, right=250, center at y=175
        lockX,
        viewport: { width: 800, height: 600 },
      });

      const labels = computeDistanceLabels(params);

      expect(labels.length).toBeGreaterThanOrEqual(1);
      const viewportLabel = labels.find((l) => l.kind === 'viewport');
      expect(viewportLabel).toBeDefined();
      expect(viewportLabel).toMatchObject({
        kind: 'viewport',
        axis: 'x',
        value: 50, // left margin
        text: '50px',
      });
      // Line should be horizontal from left edge of viewport to left edge of rect
      expect(viewportLabel?.line).toEqual({ x1: 0, y1: 175, x2: 50, y2: 175 });
    });

    it('shows opposite margin when aligned margin is 0', () => {
      const lockX: SnapLockX = {
        type: 'left',
        value: 0,
        source: 'viewport',
        sourceRect: null,
      };

      const params = createLabelParams({
        rect: rect(0, 100, 200, 150), // left margin = 0, right margin = 600
        lockX,
        viewport: { width: 800, height: 600 },
      });

      const labels = computeDistanceLabels(params);

      const viewportLabel = labels.find((l) => l.kind === 'viewport');
      expect(viewportLabel).toBeDefined();
      // Should show the right margin since left is 0
      expect(viewportLabel?.value).toBe(600);
    });

    it('shows viewport margin for Y-axis viewport lock (top align)', () => {
      const lockY: SnapLockY = {
        type: 'top',
        value: 50,
        source: 'viewport',
        sourceRect: null,
      };

      const params = createLabelParams({
        rect: rect(100, 50, 200, 150), // top=50, bottom=200, center at x=200
        lockY,
        viewport: { width: 800, height: 600 },
      });

      const labels = computeDistanceLabels(params);

      expect(labels.length).toBeGreaterThanOrEqual(1);
      const viewportLabel = labels.find((l) => l.kind === 'viewport');
      expect(viewportLabel).toBeDefined();
      expect(viewportLabel).toMatchObject({
        kind: 'viewport',
        axis: 'y',
        value: 50, // top margin
        text: '50px',
      });
    });

    it('shows both margins for center lock (X-axis)', () => {
      const lockX: SnapLockX = {
        type: 'center',
        value: 400, // viewport center
        source: 'viewport',
        sourceRect: null,
      };

      const params = createLabelParams({
        rect: rect(300, 100, 200, 150), // left=300, right=500, center=400
        lockX,
        viewport: { width: 800, height: 600 },
      });

      const labels = computeDistanceLabels(params);

      // Center lock should produce 2 viewport labels (left and right margins)
      const viewportLabels = labels.filter((l) => l.kind === 'viewport');
      expect(viewportLabels).toHaveLength(2);
      expect(viewportLabels.map((l) => l.value).sort()).toEqual([300, 300]);
    });

    it('shows both margins for middle lock (Y-axis)', () => {
      const lockY: SnapLockY = {
        type: 'middle',
        value: 300, // viewport middle
        source: 'viewport',
        sourceRect: null,
      };

      const params = createLabelParams({
        rect: rect(100, 225, 200, 150), // top=225, bottom=375, middle=300
        lockY,
        viewport: { width: 800, height: 600 },
      });

      const labels = computeDistanceLabels(params);

      // Middle lock should produce 2 viewport labels (top and bottom margins)
      const viewportLabels = labels.filter((l) => l.kind === 'viewport');
      expect(viewportLabels).toHaveLength(2);
      expect(viewportLabels.map((l) => l.value).sort()).toEqual([225, 225]);
    });
  });

  describe('invalid rect handling', () => {
    it('returns empty labels for zero-width rect', () => {
      const params = createLabelParams({
        rect: rect(0, 0, 0, 100),
      });

      const labels = computeDistanceLabels(params);

      expect(labels).toEqual([]);
    });

    it('returns empty labels for zero-height rect', () => {
      const params = createLabelParams({
        rect: rect(0, 0, 100, 0),
      });

      const labels = computeDistanceLabels(params);

      expect(labels).toEqual([]);
    });
  });

  describe('no lock state', () => {
    it('returns empty labels when no locks are active', () => {
      const params = createLabelParams({
        lockX: null,
        lockY: null,
      });

      const labels = computeDistanceLabels(params);

      expect(labels).toEqual([]);
    });
  });
});
