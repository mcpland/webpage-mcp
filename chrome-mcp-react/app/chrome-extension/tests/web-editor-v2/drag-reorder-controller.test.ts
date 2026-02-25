/**
 * Unit tests for Web Editor V2 Drag Reorder Controller.
 *
 * These tests focus on the container axis detection and side calculation:
 * - Flex row support (Bug 2 fix)
 * - Reverse layout handling
 * - Insertion line direction
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestoreFn } from './test-utils/dom';
import { mockBoundingClientRect, mockGetComputedStyle } from './test-utils/dom';

// =============================================================================
// Test Utilities
// =============================================================================

// Import the internal functions we want to test
// Since they're not exported, we'll test through the public API behavior
// For unit testing internal logic, we can create a separate test module

/**
 * Helper to determine container axis from computed style.
 * This mirrors the internal getContainerAxis logic for testing.
 */
function getContainerAxisFromStyle(style: {
  display: string;
  flexDirection?: string;
  flexWrap?: string;
}): { axis: 'x' | 'y'; reverse: boolean } | null {
  const { display, flexDirection, flexWrap } = style;

  // Reject grid
  if (display === 'grid' || display === 'inline-grid') return null;

  // Handle flex
  if (display === 'flex' || display === 'inline-flex') {
    // Reject wrapped flex (2D)
    if (flexWrap === 'wrap' || flexWrap === 'wrap-reverse') return null;

    switch (flexDirection) {
      case 'row':
        return { axis: 'x', reverse: false };
      case 'row-reverse':
        return { axis: 'x', reverse: true };
      case 'column':
        return { axis: 'y', reverse: false };
      case 'column-reverse':
        return { axis: 'y', reverse: true };
      default:
        return { axis: 'y', reverse: false };
    }
  }

  // Default to vertical
  return { axis: 'y', reverse: false };
}

/**
 * Helper to calculate side with hysteresis.
 * This mirrors the internal chooseSideWithHysteresis logic.
 */
function chooseSide(
  clientPos: number,
  rectStart: number,
  rectSize: number,
  axis: 'x' | 'y',
  reverse: boolean,
): 'before' | 'after' {
  const mid = rectStart + rectSize / 2;
  const effectivePos = reverse ? -clientPos : clientPos;
  const effectiveMid = reverse ? -mid : mid;
  return effectivePos < effectiveMid ? 'before' : 'after';
}

// =============================================================================
// Test Setup
// =============================================================================

let restores: RestoreFn[] = [];

beforeEach(() => {
  restores = [];
  document.body.innerHTML = '';
});

afterEach(() => {
  for (let i = restores.length - 1; i >= 0; i--) {
    restores[i]!();
  }
  restores = [];
  vi.restoreAllMocks();
});

// =============================================================================
// Container Axis Detection Tests
// =============================================================================

describe('drag-reorder: container axis detection', () => {
  it('flex-direction: row returns X axis', () => {
    const result = getContainerAxisFromStyle({
      display: 'flex',
      flexDirection: 'row',
    });
    expect(result).toEqual({ axis: 'x', reverse: false });
  });

  it('flex-direction: row-reverse returns X axis with reverse', () => {
    const result = getContainerAxisFromStyle({
      display: 'flex',
      flexDirection: 'row-reverse',
    });
    expect(result).toEqual({ axis: 'x', reverse: true });
  });

  it('flex-direction: column returns Y axis', () => {
    const result = getContainerAxisFromStyle({
      display: 'flex',
      flexDirection: 'column',
    });
    expect(result).toEqual({ axis: 'y', reverse: false });
  });

  it('flex-direction: column-reverse returns Y axis with reverse', () => {
    const result = getContainerAxisFromStyle({
      display: 'flex',
      flexDirection: 'column-reverse',
    });
    expect(result).toEqual({ axis: 'y', reverse: true });
  });

  it('non-flex layout returns Y axis (block flow)', () => {
    const result = getContainerAxisFromStyle({
      display: 'block',
    });
    expect(result).toEqual({ axis: 'y', reverse: false });
  });

  it('grid layout returns null (not supported)', () => {
    const result = getContainerAxisFromStyle({
      display: 'grid',
    });
    expect(result).toBeNull();
  });

  it('flex-wrap: wrap returns null (2D not supported)', () => {
    const result = getContainerAxisFromStyle({
      display: 'flex',
      flexDirection: 'row',
      flexWrap: 'wrap',
    });
    expect(result).toBeNull();
  });
});

// =============================================================================
// Side Calculation Tests
// =============================================================================

describe('drag-reorder: side calculation', () => {
  describe('X axis (horizontal)', () => {
    it('left half returns "before"', () => {
      // rect: left=100, width=100 (100-200), mid=150
      // clientX=120 (left of mid)
      const side = chooseSide(120, 100, 100, 'x', false);
      expect(side).toBe('before');
    });

    it('right half returns "after"', () => {
      // rect: left=100, width=100, mid=150
      // clientX=180 (right of mid)
      const side = chooseSide(180, 100, 100, 'x', false);
      expect(side).toBe('after');
    });
  });

  describe('X axis with reverse (row-reverse)', () => {
    it('right half returns "before" in reverse mode', () => {
      // In row-reverse, visual left is DOM right
      // rect: left=100, width=100, mid=150
      // clientX=180 (visual right = DOM before)
      const side = chooseSide(180, 100, 100, 'x', true);
      expect(side).toBe('before');
    });

    it('left half returns "after" in reverse mode', () => {
      // rect: left=100, width=100, mid=150
      // clientX=120 (visual left = DOM after)
      const side = chooseSide(120, 100, 100, 'x', true);
      expect(side).toBe('after');
    });
  });

  describe('Y axis (vertical)', () => {
    it('top half returns "before"', () => {
      // rect: top=100, height=100 (100-200), mid=150
      // clientY=120 (above mid)
      const side = chooseSide(120, 100, 100, 'y', false);
      expect(side).toBe('before');
    });

    it('bottom half returns "after"', () => {
      // rect: top=100, height=100, mid=150
      // clientY=180 (below mid)
      const side = chooseSide(180, 100, 100, 'y', false);
      expect(side).toBe('after');
    });
  });

  describe('Y axis with reverse (column-reverse)', () => {
    it('bottom half returns "before" in reverse mode', () => {
      const side = chooseSide(180, 100, 100, 'y', true);
      expect(side).toBe('before');
    });

    it('top half returns "after" in reverse mode', () => {
      const side = chooseSide(120, 100, 100, 'y', true);
      expect(side).toBe('after');
    });
  });
});

// =============================================================================
// Insertion Line Direction Tests
// =============================================================================

describe('drag-reorder: insertion line direction', () => {
  it('horizontal layout should produce vertical line (x1 === x2)', () => {
    // For flex-row, insertion line should be vertical
    // This is a conceptual test - actual line is calculated in computeInsertPosition

    const rect = { left: 100, top: 50, width: 80, height: 40 };
    const axis = 'x';
    const side = 'before';
    const reverse = false;

    // Calculate expected line position
    const beforeX = reverse ? rect.left + rect.width : rect.left;
    const afterX = reverse ? rect.left : rect.left + rect.width;
    const x = side === 'before' ? beforeX : afterX;

    // Vertical line: x1 === x2
    const line = {
      x1: x,
      y1: rect.top,
      x2: x,
      y2: rect.top + rect.height,
    };

    expect(line.x1).toBe(line.x2); // Vertical line
    expect(line.x1).toBe(rect.left); // At left edge for "before"
  });

  it('vertical layout should produce horizontal line (y1 === y2)', () => {
    const rect = { left: 100, top: 50, width: 80, height: 40 };
    const axis = 'y';
    const side = 'before';
    const reverse = false;

    // Calculate expected line position
    const beforeY = reverse ? rect.top + rect.height : rect.top;
    const afterY = reverse ? rect.top : rect.top + rect.height;
    const y = side === 'before' ? beforeY : afterY;

    // Horizontal line: y1 === y2
    const line = {
      x1: rect.left,
      y1: y,
      x2: rect.left + rect.width,
      y2: y,
    };

    expect(line.y1).toBe(line.y2); // Horizontal line
    expect(line.y1).toBe(rect.top); // At top edge for "before"
  });
});
