/**
 * Action Handlers Registry
 *
 * Central registration point for all action handlers.
 * Provides factory function to create a fully-configured ActionRegistry
 * with all replay handlers registered.
 */

import { ActionRegistry, createActionRegistry } from '../registry';
import { assertHandler } from './assert';
import { clickHandler, dblclickHandler } from './click';
import { foreachHandler, ifHandler, switchFrameHandler, whileHandler } from './control-flow';
import { delayHandler } from './delay';
import { setAttributeHandler, triggerEventHandler } from './dom';
import { dragHandler } from './drag';
import { extractHandler } from './extract';
import { fillHandler } from './fill';
import { httpHandler } from './http';
import { keyHandler } from './key';
import { navigateHandler } from './navigate';
import { screenshotHandler } from './screenshot';
import { scriptHandler } from './script';
import { scrollHandler } from './scroll';
import { closeTabHandler, handleDownloadHandler, openTabHandler, switchTabHandler } from './tabs';
import { waitHandler } from './wait';

// Re-export individual handlers for direct access
export { assertHandler } from './assert';
export { clickHandler, dblclickHandler } from './click';
export { foreachHandler, ifHandler, switchFrameHandler, whileHandler } from './control-flow';
export { delayHandler } from './delay';
export { setAttributeHandler, triggerEventHandler } from './dom';
export { dragHandler } from './drag';
export { extractHandler } from './extract';
export { fillHandler } from './fill';
export { httpHandler } from './http';
export { keyHandler } from './key';
export { navigateHandler } from './navigate';
export { screenshotHandler } from './screenshot';
export { scriptHandler } from './script';
export { scrollHandler } from './scroll';
export { closeTabHandler, handleDownloadHandler, openTabHandler, switchTabHandler } from './tabs';
export { waitHandler } from './wait';

// Re-export common utilities
export * from './common';

/**
 * All available action handlers for replay
 *
 * Organized by category:
 * - Navigation: navigate
 * - Interaction: click, dblclick, fill, key, scroll, drag
 * - Timing: wait, delay
 * - Validation: assert
 * - Data: extract, script, http, screenshot
 * - DOM Tools: triggerEvent, setAttribute
 * - Tabs: openTab, switchTab, closeTab, handleDownload
 * - Control Flow: if, foreach, while, switchFrame
 *
 * TODO: Add remaining handlers:
 * - loopElements, executeFlow (advanced control flow)
 */
const ALL_HANDLERS = [
  // Navigation
  navigateHandler,
  // Interaction
  clickHandler,
  dblclickHandler,
  fillHandler,
  keyHandler,
  scrollHandler,
  dragHandler,
  // Timing
  waitHandler,
  delayHandler,
  // Validation
  assertHandler,
  // Data
  extractHandler,
  scriptHandler,
  httpHandler,
  screenshotHandler,
  // DOM Tools
  triggerEventHandler,
  setAttributeHandler,
  // Tabs
  openTabHandler,
  switchTabHandler,
  closeTabHandler,
  handleDownloadHandler,
  // Control Flow
  ifHandler,
  foreachHandler,
  whileHandler,
  switchFrameHandler,
] as const;

/**
 * Register all replay handlers to an ActionRegistry instance
 */
export function registerReplayHandlers(registry: ActionRegistry): void {
  // Register each handler individually to satisfy TypeScript's type checker
  registry.register(navigateHandler, { override: true });
  registry.register(clickHandler, { override: true });
  registry.register(dblclickHandler, { override: true });
  registry.register(fillHandler, { override: true });
  registry.register(keyHandler, { override: true });
  registry.register(scrollHandler, { override: true });
  registry.register(dragHandler, { override: true });
  registry.register(waitHandler, { override: true });
  registry.register(delayHandler, { override: true });
  registry.register(assertHandler, { override: true });
  registry.register(extractHandler, { override: true });
  registry.register(scriptHandler, { override: true });
  registry.register(httpHandler, { override: true });
  registry.register(screenshotHandler, { override: true });
  registry.register(triggerEventHandler, { override: true });
  registry.register(setAttributeHandler, { override: true });
  registry.register(openTabHandler, { override: true });
  registry.register(switchTabHandler, { override: true });
  registry.register(closeTabHandler, { override: true });
  registry.register(handleDownloadHandler, { override: true });
  registry.register(ifHandler, { override: true });
  registry.register(foreachHandler, { override: true });
  registry.register(whileHandler, { override: true });
  registry.register(switchFrameHandler, { override: true });
}

/**
 * Create a new ActionRegistry with all replay handlers registered
 *
 * This is the primary entry point for creating an action execution context.
 *
 * @example
 * ```ts
 * const registry = createReplayActionRegistry();
 *
 * const result = await registry.execute(ctx, {
 *   id: 'action-1',
 *   type: 'click',
 *   params: { target: { candidates: [...] } },
 * });
 * ```
 */
export function createReplayActionRegistry(): ActionRegistry {
  const registry = createActionRegistry();
  registerReplayHandlers(registry);
  return registry;
}

/**
 * Get list of supported action types
 */
export function getSupportedActionTypes(): ReadonlyArray<string> {
  return ALL_HANDLERS.map((h) => h.type);
}

/**
 * Check if an action type is supported
 */
export function isActionTypeSupported(type: string): boolean {
  return ALL_HANDLERS.some((h) => h.type === type);
}
