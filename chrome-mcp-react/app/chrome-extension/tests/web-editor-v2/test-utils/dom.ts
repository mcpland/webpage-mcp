/**
 * DOM Mocking Utilities for Web Editor V2 Unit Tests
 *
 * These helpers patch DOM APIs that are missing or non-deterministic in jsdom
 * (e.g. elementsFromPoint, layout-dependent getBoundingClientRect).
 *
 * Usage:
 *   const restore = mockElementsFromPoint((x, y) => [element1, element2]);
 *   // run test
 *   restore();
 *
 * Or use installDomMocks() for batch installation with automatic cleanup.
 */

// =============================================================================
// Types
// =============================================================================

/** Function to restore original state */
export type RestoreFn = () => void;

/** Initialization data for a DOMRect */
export interface RectInit {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Handler for elementsFromPoint mock */
export type ElementsFromPointHandler = (x: number, y: number) => Element[];

/** CSS property overrides for computed style mock */
export type StyleOverrides = Record<string, string | undefined>;

/** Handler for getComputedStyle mock */
export type ComputedStyleHandler = (element: Element) => StyleOverrides | CSSStyleDeclaration;

/** Options for creating a mock event with composedPath */
export interface MockEventOptions {
  clientX?: number;
  clientY?: number;
  path: EventTarget[];
}

/** Batch mock configuration */
export interface DomMocks {
  elementsFromPoint?: ElementsFromPointHandler;
  getComputedStyle?: ComputedStyleHandler;
}

// =============================================================================
// Default Style Values
// =============================================================================

/**
 * Default computed style values that match browser defaults.
 * These cover properties commonly accessed by SelectionEngine and PositionTracker.
 */
const DEFAULT_STYLE: Record<string, string> = {
  // Display & visibility
  display: 'block',
  visibility: 'visible',
  opacity: '1',
  contentVisibility: 'visible',

  // Background
  backgroundColor: 'transparent',
  backgroundImage: 'none',

  // Border
  borderTopWidth: '0px',
  borderRightWidth: '0px',
  borderBottomWidth: '0px',
  borderLeftWidth: '0px',
  borderTopStyle: 'none',
  borderRightStyle: 'none',
  borderBottomStyle: 'none',
  borderLeftStyle: 'none',

  // Effects
  boxShadow: 'none',
  outlineStyle: 'none',
  outlineWidth: '0px',

  // Spacing
  paddingTop: '0px',
  paddingRight: '0px',
  paddingBottom: '0px',
  paddingLeft: '0px',

  // Cursor & position
  cursor: 'auto',
  position: 'static',

  // Flex
  flexDirection: 'row',
};

// =============================================================================
// Internal Utilities
// =============================================================================

/**
 * Creates a DOMRectReadOnly-like object from init data.
 */
function createRect(init: RectInit): DOMRectReadOnly {
  const { left, top, width, height } = init;
  const right = left + width;
  const bottom = top + height;

  return {
    left,
    top,
    width,
    height,
    right,
    bottom,
    x: left,
    y: top,
    toJSON() {
      return { left, top, width, height, right, bottom, x: left, y: top };
    },
  } as DOMRectReadOnly;
}

/**
 * Patches a property on an object and returns a restore function.
 */
function patchProperty(target: object, key: string, value: unknown): RestoreFn {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);

  Object.defineProperty(target, key, {
    value,
    configurable: true,
    writable: true,
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(target, key, descriptor);
    } else {
      delete (target as Record<string, unknown>)[key];
    }
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Creates a CSSStyleDeclaration-like object with the given overrides.
 */
export function createComputedStyle(overrides: StyleOverrides = {}): CSSStyleDeclaration {
  const values: Record<string, string> = { ...DEFAULT_STYLE };

  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string') {
      values[key] = value;
    }
  }

  const style = {
    ...values,
    getPropertyValue(prop: string): string {
      return values[prop] ?? '';
    },
    // Add commonly accessed methods to prevent errors
    getPropertyPriority(): string {
      return '';
    },
    length: 0,
    item(): string {
      return '';
    },
  };

  return style as unknown as CSSStyleDeclaration;
}

/**
 * Patches an element's getBoundingClientRect() to return a fixed rect.
 *
 * @example
 * const restore = mockBoundingClientRect(element, { left: 10, top: 20, width: 100, height: 50 });
 * expect(element.getBoundingClientRect().left).toBe(10);
 * restore();
 */
export function mockBoundingClientRect(element: Element, rect: RectInit): RestoreFn {
  const domRect = createRect(rect);
  return patchProperty(element, 'getBoundingClientRect', () => domRect);
}

/**
 * Patches document.elementsFromPoint and document.elementFromPoint.
 *
 * SelectionEngine prefers elementsFromPoint when available, so both must be mocked.
 *
 * @example
 * const restore = mockElementsFromPoint((x, y) => {
 *   if (x < 100) return [elementA, elementB];
 *   return [elementC];
 * });
 */
export function mockElementsFromPoint(handler: ElementsFromPointHandler): RestoreFn {
  const restoreElements = patchProperty(document, 'elementsFromPoint', (x: number, y: number) =>
    handler(x, y),
  );

  const restoreElement = patchProperty(document, 'elementFromPoint', (x: number, y: number) => {
    const elements = handler(x, y);
    return elements[0] ?? null;
  });

  return () => {
    restoreElement();
    restoreElements();
  };
}

/**
 * Patches window.getComputedStyle.
 *
 * The handler can return either StyleOverrides (merged with defaults) or a full CSSStyleDeclaration.
 *
 * @example
 * const restore = mockGetComputedStyle((el) => ({
 *   display: 'flex',
 *   backgroundColor: 'rgb(255, 0, 0)',
 * }));
 */
export function mockGetComputedStyle(handler: ComputedStyleHandler): RestoreFn {
  return patchProperty(window, 'getComputedStyle', (element: Element) => {
    const result = handler(element);

    // If handler returned a full CSSStyleDeclaration, use it directly
    if (result && typeof (result as CSSStyleDeclaration).getPropertyValue === 'function') {
      return result as CSSStyleDeclaration;
    }

    // Otherwise, merge with defaults
    return createComputedStyle(result as StyleOverrides);
  });
}

/**
 * Creates a minimal Event-like object with composedPath() support.
 *
 * Useful for testing findBestTargetFromEvent() which relies on composedPath()
 * to access Shadow DOM internals.
 *
 * @example
 * const event = createMockEvent({ clientX: 100, clientY: 200, path: [button, div, document] });
 */
export function createMockEvent(options: MockEventOptions): Event {
  const { clientX = 0, clientY = 0, path } = options;

  return {
    clientX,
    clientY,
    composedPath: () => path,
    // Add common event properties to prevent errors
    type: 'click',
    target: path[0] ?? null,
    currentTarget: null,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    eventPhase: 0,
    isTrusted: false,
    timeStamp: Date.now(),
    preventDefault: () => {},
    stopPropagation: () => {},
    stopImmediatePropagation: () => {},
  } as unknown as Event;
}

/**
 * Installs multiple DOM mocks at once and returns a single restore function.
 *
 * Restores are called in reverse order to handle dependencies correctly.
 *
 * @example
 * const restore = installDomMocks({
 *   elementsFromPoint: (x, y) => [element],
 *   getComputedStyle: (el) => ({ display: 'block' }),
 * });
 *
 * // In afterEach:
 * restore();
 */
export function installDomMocks(mocks: DomMocks): RestoreFn {
  const restores: RestoreFn[] = [];

  if (mocks.elementsFromPoint) {
    restores.push(mockElementsFromPoint(mocks.elementsFromPoint));
  }

  if (mocks.getComputedStyle) {
    restores.push(mockGetComputedStyle(mocks.getComputedStyle));
  }

  return () => {
    // Restore in reverse order
    for (let i = restores.length - 1; i >= 0; i--) {
      restores[i]!();
    }
  };
}

/**
 * Sets up mock viewport dimensions.
 *
 * Useful for snap-engine tests that rely on window.innerWidth/innerHeight.
 */
export function mockViewport(width: number, height: number): RestoreFn {
  const restoreWidth = patchProperty(window, 'innerWidth', width);
  const restoreHeight = patchProperty(window, 'innerHeight', height);

  return () => {
    restoreHeight();
    restoreWidth();
  };
}
