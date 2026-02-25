/**
 * Unit tests for Web Editor V2 Selection Engine.
 *
 * These tests focus on deterministic scoring and selection behavior.
 * jsdom has no real layout engine, so we mock:
 * - document.elementsFromPoint / document.elementFromPoint
 * - element.getBoundingClientRect()
 * - window.getComputedStyle()
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSelectionEngine,
  type Modifiers,
  type SelectionCandidate,
  type SelectionEngine,
} from '@/entrypoints/web-editor-v2/selection/selection-engine';

import type { RestoreFn, StyleOverrides } from './test-utils/dom';
import {
  createMockEvent,
  installDomMocks,
  mockBoundingClientRect,
  mockViewport,
} from './test-utils/dom';

// =============================================================================
// Test Utilities
// =============================================================================

const NO_MODIFIERS: Modifiers = { alt: false, shift: false, ctrl: false, meta: false };

/**
 * Check if an element is part of the editor overlay.
 * In tests, elements with data-overlay="true" are considered overlay elements.
 */
function isOverlayElement(node: unknown): boolean {
  return node instanceof Element && node.getAttribute('data-overlay') === 'true';
}

/**
 * Find a candidate by element in the candidates array.
 */
function getCandidate(
  candidates: SelectionCandidate[],
  element: Element,
): SelectionCandidate | undefined {
  return candidates.find((c) => c.element === element);
}

/**
 * Check if any of the candidate's reasons contain a specific substring.
 */
function hasReason(candidate: SelectionCandidate | undefined, substring: string): boolean {
  return candidate?.reasons.some((r) => r.includes(substring)) ?? false;
}

// =============================================================================
// Test Setup
// =============================================================================

let restores: RestoreFn[] = [];
let engine: SelectionEngine | null = null;

beforeEach(() => {
  restores = [];
  document.body.innerHTML = '';
});

afterEach(() => {
  engine?.dispose();
  engine = null;
  for (let i = restores.length - 1; i >= 0; i--) {
    restores[i]!();
  }
  restores = [];
});

// =============================================================================
// getCandidatesAtPoint Tests
// =============================================================================

describe('selection-engine: getCandidatesAtPoint', () => {
  it('returns empty array when no elements are hit', () => {
    restores.push(
      installDomMocks({
        elementsFromPoint: () => [],
        getComputedStyle: () => ({}),
      }),
    );

    engine = createSelectionEngine({ isOverlayElement });
    expect(engine.getCandidatesAtPoint(10, 10)).toEqual([]);
  });

  it('skips overlay elements from hit testing', () => {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-overlay', 'true');

    const button = document.createElement('button');
    button.tabIndex = 0;

    document.body.append(overlay, button);

    restores.push(mockBoundingClientRect(overlay, { left: 0, top: 0, width: 200, height: 200 }));
    restores.push(mockBoundingClientRect(button, { left: 10, top: 10, width: 120, height: 48 }));

    const styleByEl = new Map<Element, StyleOverrides>([[button, { cursor: 'pointer' }]]);

    restores.push(
      installDomMocks({
        elementsFromPoint: () => [overlay, button],
        getComputedStyle: (el) => styleByEl.get(el) ?? {},
      }),
    );

    engine = createSelectionEngine({ isOverlayElement });
    const candidates = engine.getCandidatesAtPoint(12, 12);

    // Overlay should be excluded
    expect(candidates.some((c) => c.element === overlay)).toBe(false);
    // Button should be selected
    expect(candidates.some((c) => c.element === button)).toBe(true);
  });

  it('scores interactive button element highly', () => {
    const wrapper = document.createElement('div');
    const button = document.createElement('button');
    button.tabIndex = 0;
    wrapper.append(button);
    document.body.append(wrapper);

    restores.push(mockBoundingClientRect(wrapper, { left: 0, top: 0, width: 200, height: 120 }));
    restores.push(mockBoundingClientRect(button, { left: 10, top: 10, width: 120, height: 48 }));

    const styleByEl = new Map<Element, StyleOverrides>([[button, { cursor: 'pointer' }]]);

    restores.push(
      installDomMocks({
        elementsFromPoint: () => [button, wrapper],
        getComputedStyle: (el) => styleByEl.get(el) ?? {},
      }),
    );

    engine = createSelectionEngine({ isOverlayElement });
    const candidates = engine.getCandidatesAtPoint(12, 12);

    // Button should have higher score due to interactive tag
    const buttonCandidate = getCandidate(candidates, button);
    expect(buttonCandidate).toBeDefined();
    expect(hasReason(buttonCandidate, 'button') || hasReason(buttonCandidate, 'type')).toBe(true);
  });

  it('prefers elements with visual boundaries', () => {
    const plain = document.createElement('div');
    const bordered = document.createElement('div');
    document.body.append(plain, bordered);

    restores.push(mockBoundingClientRect(plain, { left: 0, top: 0, width: 100, height: 100 }));
    restores.push(mockBoundingClientRect(bordered, { left: 0, top: 0, width: 100, height: 100 }));

    const styleByEl = new Map<Element, StyleOverrides>([
      [
        bordered,
        {
          borderTopWidth: '1px',
          borderRightWidth: '1px',
          borderBottomWidth: '1px',
          borderLeftWidth: '1px',
          borderTopStyle: 'solid',
          borderRightStyle: 'solid',
          borderBottomStyle: 'solid',
          borderLeftStyle: 'solid',
        },
      ],
    ]);

    restores.push(
      installDomMocks({
        elementsFromPoint: () => [plain, bordered],
        getComputedStyle: (el) => styleByEl.get(el) ?? {},
      }),
    );

    engine = createSelectionEngine({ isOverlayElement });
    const candidates = engine.getCandidatesAtPoint(10, 10);

    const borderedCandidate = getCandidate(candidates, bordered);
    expect(borderedCandidate).toBeDefined();
    expect(hasReason(borderedCandidate, 'border')).toBe(true);
  });

  it('penalizes tiny elements', () => {
    const tiny = document.createElement('div');
    const normal = document.createElement('div');
    document.body.append(tiny, normal);

    restores.push(mockBoundingClientRect(tiny, { left: 0, top: 0, width: 2, height: 2 }));
    restores.push(mockBoundingClientRect(normal, { left: 0, top: 0, width: 100, height: 100 }));

    restores.push(
      installDomMocks({
        elementsFromPoint: () => [tiny, normal],
        getComputedStyle: () => ({}),
      }),
    );

    engine = createSelectionEngine({ isOverlayElement });
    const candidates = engine.getCandidatesAtPoint(1, 1);

    const tinyCandidate = getCandidate(candidates, tiny);
    const normalCandidate = getCandidate(candidates, normal);

    expect(tinyCandidate).toBeDefined();
    expect(normalCandidate).toBeDefined();
    // Tiny element should have lower score
    expect((tinyCandidate?.score ?? 0) < (normalCandidate?.score ?? 0)).toBe(true);
  });

  it('penalizes very large elements (viewport-sized)', () => {
    const huge = document.createElement('div');
    const normal = document.createElement('div');
    document.body.append(huge, normal);

    // Mock viewport as 800x600
    restores.push(mockViewport(800, 600));
    // Huge element takes 90% of viewport
    restores.push(mockBoundingClientRect(huge, { left: 0, top: 0, width: 720, height: 540 }));
    restores.push(mockBoundingClientRect(normal, { left: 10, top: 10, width: 100, height: 100 }));

    restores.push(
      installDomMocks({
        elementsFromPoint: () => [normal, huge],
        getComputedStyle: () => ({}),
      }),
    );

    engine = createSelectionEngine({ isOverlayElement });
    const candidates = engine.getCandidatesAtPoint(50, 50);

    const hugeCandidate = getCandidate(candidates, huge);
    const normalCandidate = getCandidate(candidates, normal);
    expect(hugeCandidate).toBeDefined();
    expect(normalCandidate).toBeDefined();
    // Large element should have lower score due to size penalty
    expect((hugeCandidate?.score ?? 0) < (normalCandidate?.score ?? 0)).toBe(true);
  });

  it('excludes invisible elements', () => {
    const hidden = document.createElement('div');
    const visible = document.createElement('div');
    document.body.append(hidden, visible);

    restores.push(mockBoundingClientRect(hidden, { left: 0, top: 0, width: 100, height: 100 }));
    restores.push(mockBoundingClientRect(visible, { left: 0, top: 0, width: 100, height: 100 }));

    const styleByEl = new Map<Element, StyleOverrides>([
      [hidden, { display: 'none' }],
      [visible, { display: 'block' }],
    ]);

    restores.push(
      installDomMocks({
        elementsFromPoint: () => [hidden, visible],
        getComputedStyle: (el) => styleByEl.get(el) ?? {},
      }),
    );

    engine = createSelectionEngine({ isOverlayElement });
    const candidates = engine.getCandidatesAtPoint(50, 50);

    // Hidden element should be excluded
    expect(candidates.some((c) => c.element === hidden)).toBe(false);
    expect(candidates.some((c) => c.element === visible)).toBe(true);
  });
});

// =============================================================================
// findBestTarget Tests
// =============================================================================

describe('selection-engine: findBestTarget', () => {
  it('returns null when no elements are hit', () => {
    restores.push(
      installDomMocks({
        elementsFromPoint: () => [],
        getComputedStyle: () => ({}),
      }),
    );

    engine = createSelectionEngine({ isOverlayElement });
    expect(engine.findBestTarget(10, 10, NO_MODIFIERS)).toBeNull();
  });

  it('returns the best scored element', () => {
    const button = document.createElement('button');
    button.tabIndex = 0;
    document.body.append(button);

    restores.push(mockBoundingClientRect(button, { left: 0, top: 0, width: 120, height: 48 }));

    restores.push(
      installDomMocks({
        elementsFromPoint: () => [button],
        getComputedStyle: () => ({}),
      }),
    );

    engine = createSelectionEngine({ isOverlayElement });
    expect(engine.findBestTarget(10, 10, NO_MODIFIERS)).toBe(button);
  });

  it('Alt modifier drills up to parent element', () => {
    const panel = document.createElement('section');
    panel.id = 'panel';

    const wrapper = document.createElement('div');
    const button = document.createElement('button');
    button.tabIndex = 0;

    wrapper.append(button);
    panel.append(wrapper);
    document.body.append(panel);

    restores.push(mockBoundingClientRect(panel, { left: 0, top: 0, width: 400, height: 300 }));
    restores.push(mockBoundingClientRect(wrapper, { left: 0, top: 0, width: 240, height: 160 }));
    restores.push(mockBoundingClientRect(button, { left: 10, top: 10, width: 120, height: 48 }));

    const styleByEl = new Map<Element, StyleOverrides>([
      [panel, { paddingTop: '8px', paddingLeft: '8px' }],
      [button, { cursor: 'pointer' }],
    ]);

    restores.push(
      installDomMocks({
        elementsFromPoint: () => [button, wrapper, panel],
        getComputedStyle: (el) => styleByEl.get(el) ?? {},
      }),
    );

    engine = createSelectionEngine({ isOverlayElement });
    const target = engine.findBestTarget(12, 12, { ...NO_MODIFIERS, alt: true });

    // Should drill up past wrapper to panel (which has visual boundary via padding)
    expect(target).toBe(panel);
  });
});

// =============================================================================
// findBestTargetFromEvent Tests
// =============================================================================

describe('selection-engine: findBestTargetFromEvent', () => {
  it('Ctrl/Cmd selects the innermost visible element from composedPath', () => {
    const wrapper = document.createElement('div');
    const button = document.createElement('button');
    button.tabIndex = 0;
    const inner = document.createElement('span');
    inner.textContent = 'Inner';

    button.append(inner);
    wrapper.append(button);
    document.body.append(wrapper);

    restores.push(mockBoundingClientRect(wrapper, { left: 0, top: 0, width: 240, height: 160 }));
    restores.push(mockBoundingClientRect(button, { left: 10, top: 10, width: 120, height: 48 }));
    restores.push(mockBoundingClientRect(inner, { left: 14, top: 14, width: 50, height: 20 }));

    const styleByEl = new Map<Element, StyleOverrides>([[button, { cursor: 'pointer' }]]);

    restores.push(
      installDomMocks({
        elementsFromPoint: () => [inner, button, wrapper],
        getComputedStyle: (el) => styleByEl.get(el) ?? {},
      }),
    );

    engine = createSelectionEngine({ isOverlayElement });

    const event = createMockEvent({
      clientX: 16,
      clientY: 16,
      path: [inner, button, wrapper, document.body, document],
    });

    const target = engine.findBestTargetFromEvent(event, { ...NO_MODIFIERS, ctrl: true });
    // Ctrl should select innermost visible element
    expect(target).toBe(inner);
  });

  it('Alt in event-based selection drills up from best target', () => {
    const panel = document.createElement('section');
    panel.id = 'panel';

    const wrapper = document.createElement('div');
    const button = document.createElement('button');
    button.tabIndex = 0;

    wrapper.append(button);
    panel.append(wrapper);
    document.body.append(panel);

    restores.push(mockBoundingClientRect(panel, { left: 0, top: 0, width: 400, height: 300 }));
    restores.push(mockBoundingClientRect(wrapper, { left: 0, top: 0, width: 240, height: 160 }));
    restores.push(mockBoundingClientRect(button, { left: 10, top: 10, width: 120, height: 48 }));

    const styleByEl = new Map<Element, StyleOverrides>([
      [panel, { paddingTop: '8px', paddingLeft: '8px' }],
      [button, { cursor: 'pointer' }],
    ]);

    restores.push(
      installDomMocks({
        elementsFromPoint: () => [button, wrapper, panel],
        getComputedStyle: (el) => styleByEl.get(el) ?? {},
      }),
    );

    engine = createSelectionEngine({ isOverlayElement });

    const event = createMockEvent({
      clientX: 12,
      clientY: 12,
      path: [button, wrapper, panel, document.body, document],
    });

    const target = engine.findBestTargetFromEvent(event, { ...NO_MODIFIERS, alt: true });
    expect(target).toBe(panel);
  });
});

// =============================================================================
// getParentCandidate Tests
// =============================================================================

describe('selection-engine: getParentCandidate', () => {
  it('returns null for body element', () => {
    engine = createSelectionEngine({ isOverlayElement });
    expect(engine.getParentCandidate(document.body)).toBeNull();
  });

  it('returns first non-wrapper ancestor', () => {
    const section = document.createElement('section');
    section.id = 'section';
    const wrapper = document.createElement('div');
    const button = document.createElement('button');

    wrapper.append(button);
    section.append(wrapper);
    document.body.append(section);

    restores.push(mockBoundingClientRect(section, { left: 0, top: 0, width: 400, height: 300 }));
    restores.push(mockBoundingClientRect(wrapper, { left: 0, top: 0, width: 240, height: 160 }));
    restores.push(mockBoundingClientRect(button, { left: 10, top: 10, width: 120, height: 48 }));

    // Section has visual boundary
    const styleByEl = new Map<Element, StyleOverrides>([
      [section, { paddingTop: '8px', paddingLeft: '8px' }],
    ]);

    restores.push(
      installDomMocks({
        elementsFromPoint: () => [],
        getComputedStyle: (el) => styleByEl.get(el) ?? {},
      }),
    );

    engine = createSelectionEngine({ isOverlayElement });
    const parent = engine.getParentCandidate(button);

    // Should skip wrapper and return section
    expect(parent).toBe(section);
  });
});

// =============================================================================
// dispose Tests
// =============================================================================

describe('selection-engine: dispose', () => {
  it('can be called multiple times safely', () => {
    engine = createSelectionEngine({ isOverlayElement });
    expect(() => {
      engine!.dispose();
      engine!.dispose();
    }).not.toThrow();
  });
});
