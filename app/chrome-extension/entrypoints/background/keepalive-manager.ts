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
  InMemoryKeepaliveController,
  type KeepaliveController,
} from './record-replay-v3/engine/keepalive/offscreen-keepalive';

const LOG_PREFIX = '[KeepaliveManager]';
let didLogFallbackReason = false;

/**
 * Singleton keepalive controller instance.
 * Created lazily to avoid initialization issues during module loading.
 */
let controller: KeepaliveController | null = null;

function resolveKeepaliveControllerFactory(): {
  kind: 'offscreen' | 'passive' | 'unsupported';
  reason?: string;
} {
  if (typeof chrome === 'undefined' || !chrome.runtime?.getManifest) {
    return {
      kind: 'passive',
      reason: 'chrome.runtime.getManifest is unavailable',
    };
  }

  const manifestVersion = chrome.runtime.getManifest().manifest_version;
  if (manifestVersion !== 3) {
    return {
      kind: 'passive',
      reason: `manifest_version ${manifestVersion} uses a persistent background runtime`,
    };
  }

  if (!chrome.offscreen) {
    return {
      kind: 'unsupported',
      reason: 'chrome.offscreen is unavailable in this MV3 runtime',
    };
  }

  if (!chrome.runtime.onConnect) {
    return {
      kind: 'unsupported',
      reason: 'chrome.runtime.onConnect is unavailable in this MV3 runtime',
    };
  }

  return { kind: 'offscreen' };
}

function createUnsupportedKeepaliveController(reason: string): KeepaliveController {
  return {
    acquire: () => {
      throw new Error(`No runtime keepalive is available: ${reason}`);
    },
    isActive: () => false,
    getRefCount: () => 0,
    releaseAll: () => {},
  };
}

/**
 * Get or create the singleton keepalive controller.
 */
function getController(): KeepaliveController {
  if (!controller) {
    const resolution = resolveKeepaliveControllerFactory();
    controller =
      resolution.kind === 'offscreen'
        ? createOffscreenKeepaliveController({ logger: console })
        : resolution.kind === 'passive'
          ? new InMemoryKeepaliveController()
          : createUnsupportedKeepaliveController(
              resolution.reason ?? 'MV3 runtime keepalive APIs are unavailable',
            );

    if (resolution.kind !== 'offscreen' && resolution.reason && !didLogFallbackReason) {
      const message =
        resolution.kind === 'passive'
          ? `${LOG_PREFIX} Using passive keepalive controller: ${resolution.reason}`
          : `${LOG_PREFIX} No runtime keepalive available: ${resolution.reason}`;
      const log = resolution.kind === 'unsupported' ? console.warn : console.info;
      log(message);
      didLogFallbackReason = true;
    }

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
