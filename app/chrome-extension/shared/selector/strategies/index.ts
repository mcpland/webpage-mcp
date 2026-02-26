/**
 * Selector Strategies - Strategy exports and default configuration
 */

import type { SelectorStrategy } from '../types';
import { anchorRelpathStrategy } from './anchor-relpath';
import { ariaStrategy } from './aria';
import { cssPathStrategy } from './css-path';
import { cssUniqueStrategy } from './css-unique';
import { testIdStrategy } from './testid';
import { textStrategy } from './text';

/**
 * Default selector strategy list (ordered by priority).
 *
 * Strategy order:
 * 1. testid - Stable test attributes (data-testid, name, title, alt)
 * 2. aria - Accessibility attributes (aria-label, role)
 * 3. css-unique - Unique CSS selectors (id, class combinations)
 * 4. css-path - Structural path selector (nth-of-type)
 * 5. anchor-relpath - Anchor + relative path (fallback for elements without unique attrs)
 * 6. text - Text content selector (lowest priority)
 *
 * Note: Final candidate order is determined by stability scoring,
 * but strategy order affects which candidates are generated first.
 */
export const DEFAULT_SELECTOR_STRATEGIES: ReadonlyArray<SelectorStrategy> = [
  testIdStrategy,
  ariaStrategy,
  cssUniqueStrategy,
  cssPathStrategy,
  anchorRelpathStrategy,
  textStrategy,
];

export { anchorRelpathStrategy } from './anchor-relpath';
export { ariaStrategy } from './aria';
export { cssPathStrategy } from './css-path';
export { cssUniqueStrategy } from './css-unique';
export { testIdStrategy } from './testid';
export { textStrategy } from './text';
