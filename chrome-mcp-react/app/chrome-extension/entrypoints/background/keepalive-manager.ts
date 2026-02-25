/**
 * @fileoverview Keepalive Manager
 * @description Global singleton service for managing Service Worker keepalive.
 *
 * This module provides a unified interface for acquiring and releasing keepalive
 * references. Multiple modules can acquire keepalive independently using tags,
 * and the underlying keepalive mechanism will remain active as long as at least
 * one reference is held.
 */

import {
  createOffscreenKeepaliveController,
  type KeepaliveController,
} from './record-replay-v3/engine/keepalive/offscreen-keepalive';

const LOG_PREFIX = '[KeepaliveManager]';

/**
 * Singleton keepalive controller instance.
 * Created lazily to avoid initialization issues during module loading.
 */
let controller: KeepaliveController | null = null;

/**
 * Get or create the singleton keepalive controller.
 */
function getController(): KeepaliveController {
  if (!controller) {
    controller = createOffscreenKeepaliveController({ logger: console });
    console.debug(`${LOG_PREFIX} Controller initialized`);
  }
  return controller;
}

/**
 * Acquire a keepalive reference with a tag.
 *
 * @param tag - Identifier for the reference (e.g., 'native-host', 'rr-engine')
 * @returns A release function to call when keepalive is no longer needed
 *
 * @example
 * ```typescript
 * const release = acquireKeepalive('native-host');
 * // ... do work that needs SW to stay alive ...
 * release(); // Release when done
 * ```
 */
export function acquireKeepalive(tag: string): () => void {
  try {
    const release = getController().acquire(tag);
    console.debug(`${LOG_PREFIX} Acquired keepalive for tag: ${tag}`);
    return () => {
      try {
        release();
        console.debug(`${LOG_PREFIX} Released keepalive for tag: ${tag}`);
      } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to release keepalive for ${tag}:`, error);
      }
    };
  } catch (error) {
    console.warn(`${LOG_PREFIX} Failed to acquire keepalive for ${tag}:`, error);
    return () => {};
  }
}

/**
 * Check if keepalive is currently active (any references held).
 */
export function isKeepaliveActive(): boolean {
  try {
    return getController().isActive();
  } catch {
    return false;
  }
}

/**
 * Get the current keepalive reference count.
 * Useful for debugging.
 */
export function getKeepaliveRefCount(): number {
  try {
    return getController().getRefCount();
  } catch {
    return 0;
  }
}
