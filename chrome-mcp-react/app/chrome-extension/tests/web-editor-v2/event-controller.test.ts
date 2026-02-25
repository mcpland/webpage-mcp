/**
 * Unit tests for Web Editor V2 Event Controller.
 *
 * These tests focus on the selecting mode behavior:
 * - Clicking within selection subtree prepares drag candidate
 * - Clicking outside selection triggers reselection (Bug 1 fix)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createEventController,
  type EventController,
  type EventControllerOptions,
  type Modifiers,
} from '@/entrypoints/web-editor-v2/core/event-controller';

import type { RestoreFn } from './test-utils/dom';
import { mockBoundingClientRect } from './test-utils/dom';

// =============================================================================
// Test Utilities
// =============================================================================

const NO_MODIFIERS: Modifiers = { alt: false, shift: false, ctrl: false, meta: false };

/**
 * Check if an element is part of the editor overlay.
 */
function isOverlayElement(node: unknown): boolean {
  return node instanceof Element && node.getAttribute('data-overlay') === 'true';
}

/**
 * Create a minimal mock PointerEvent for testing.
 * jsdom doesn't support PointerEvent, so we create a MouseEvent and extend it.
 */
function createPointerEvent(
  type: string,
  options: {
    clientX?: number;
    clientY?: number;
    button?: number;
    pointerId?: number;
    target?: EventTarget | null;
  } = {},
): MouseEvent & { pointerId: number } {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.clientX ?? 0,
    clientY: options.clientY ?? 0,
    button: options.button ?? 0,
  });

  // Add pointerId property (jsdom doesn't have PointerEvent)
  Object.defineProperty(event, 'pointerId', {
    value: options.pointerId ?? 1,
    writable: false,
  });

  // Mock composedPath to return target path
  if (options.target) {
    vi.spyOn(event, 'composedPath').mockReturnValue([options.target as EventTarget]);
  }

  return event as MouseEvent & { pointerId: number };
}

// =============================================================================
// Test Setup
// =============================================================================

let restores: RestoreFn[] = [];
let controller: EventController | null = null;

beforeEach(() => {
  restores = [];
  document.body.innerHTML = '';
});

afterEach(() => {
  controller?.dispose();
  controller = null;
  for (let i = restores.length - 1; i >= 0; i--) {
    restores[i]!();
  }
  restores = [];
  vi.restoreAllMocks();
});

// =============================================================================
// Selecting Mode Tests (Bug 1 Fix)
// =============================================================================

describe('event-controller: selecting mode click behavior', () => {
  it('clicking within selection subtree prepares drag candidate (does not trigger onSelect)', () => {
    // Setup DOM
    const selected = document.createElement('div');
    selected.id = 'selected';
    const child = document.createElement('span');
    child.id = 'child';
    selected.appendChild(child);
    document.body.appendChild(selected);

    // Mock rect for selected element
    restores.push(mockBoundingClientRect(selected, { left: 0, top: 0, width: 100, height: 100 }));
    restores.push(mockBoundingClientRect(child, { left: 10, top: 10, width: 50, height: 50 }));

    // Setup callbacks
    const onSelect = vi.fn();
    const onStartDrag = vi.fn().mockReturnValue(true);

    const options: EventControllerOptions = {
      isOverlayElement,
      isEditorUiElement: () => false,
      getSelectedElement: () => selected,
      getEditingElement: () => null,
      findTargetForSelect: () => child,
      onHover: vi.fn(),
      onSelect,
      onDeselect: vi.fn(),
      onStartDrag,
    };

    controller = createEventController(options);
    controller.setMode('selecting');

    // Simulate pointerdown within selected element
    const event = createPointerEvent('pointerdown', {
      clientX: 20,
      clientY: 20,
      target: child,
    });

    document.dispatchEvent(event);

    // onSelect should NOT be called (we're preparing drag instead)
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('clicking outside selection triggers reselection (Bug 1 fix)', () => {
    // Setup DOM
    const selected = document.createElement('div');
    selected.id = 'selected';
    document.body.appendChild(selected);

    const other = document.createElement('div');
    other.id = 'other';
    document.body.appendChild(other);

    // Mock rects
    restores.push(mockBoundingClientRect(selected, { left: 0, top: 0, width: 100, height: 100 }));
    restores.push(mockBoundingClientRect(other, { left: 200, top: 0, width: 100, height: 100 }));

    // Setup callbacks
    const onSelect = vi.fn();
    const onStartDrag = vi.fn().mockReturnValue(true);

    const options: EventControllerOptions = {
      isOverlayElement,
      isEditorUiElement: () => false,
      getSelectedElement: () => selected,
      getEditingElement: () => null,
      findTargetForSelect: () => other, // Returns the "other" element as target
      onHover: vi.fn(),
      onSelect,
      onDeselect: vi.fn(),
      onStartDrag,
    };

    controller = createEventController(options);
    controller.setMode('selecting');

    // Simulate mousedown outside selected element (on "other")
    // Use mousedown since jsdom doesn't support PointerEvent
    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: 250, // Outside selected (0-100), inside other (200-300)
      clientY: 50,
      button: 0,
    });

    // Mock composedPath to return a path that does NOT include "selected"
    // This simulates clicking outside the selection
    vi.spyOn(event, 'composedPath').mockReturnValue([other, document.body, document]);

    document.dispatchEvent(event);

    // onSelect SHOULD be called with the new element
    expect(onSelect).toHaveBeenCalledWith(other, expect.any(Object));
  });

  it('clicking outside with no valid target does not trigger onSelect', () => {
    // Setup DOM
    const selected = document.createElement('div');
    selected.id = 'selected';
    document.body.appendChild(selected);

    // Mock rect
    restores.push(mockBoundingClientRect(selected, { left: 0, top: 0, width: 100, height: 100 }));

    // Setup callbacks
    const onSelect = vi.fn();

    const options: EventControllerOptions = {
      isOverlayElement,
      isEditorUiElement: () => false,
      getSelectedElement: () => selected,
      getEditingElement: () => null,
      findTargetForSelect: () => null, // No valid target found
      onHover: vi.fn(),
      onSelect,
      onDeselect: vi.fn(),
      onStartDrag: vi.fn(),
    };

    controller = createEventController(options);
    controller.setMode('selecting');

    // Simulate pointerdown outside selected element
    const event = createPointerEvent('pointerdown', {
      clientX: 500,
      clientY: 500,
      target: document.body,
    });

    document.dispatchEvent(event);

    // onSelect should NOT be called (no valid target)
    expect(onSelect).not.toHaveBeenCalled();
  });
});
