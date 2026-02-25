/**
 * @fileoverview Offscreen Keepalive Controller
 * @description Keeps the MV3 service worker alive using an Offscreen Document + Port heartbeat.
 *
 * Architecture:
 * - Background (this module) listens for an Offscreen Port connection.
 * - Offscreen connects and sends heartbeat pings.
 * - Background replies with pong and controls the heartbeat via `start`/`stop`.
 *
 * Contract:
 * - When at least one keepalive reference is held, keepalive must be running.
 * - When the reference count drops to zero, keepalive must fully stop (no ping loop, no Port, no reconnect).
 */

import { offscreenManager } from '@/utils/offscreen-manager';
import {
  RR_V3_KEEPALIVE_PORT_NAME,
  type KeepaliveMessage,
} from '@/common/rr-v3-keepalive-protocol';

// ==================== Runtime Control Protocol ====================

const KEEPALIVE_CONTROL_MESSAGE_TYPE = 'rr_v3_keepalive.control' as const;

type KeepaliveControlCommand = 'start' | 'stop';

interface KeepaliveControlMessage {
  type: typeof KEEPALIVE_CONTROL_MESSAGE_TYPE;
  command: KeepaliveControlCommand;
}

// ==================== Types ====================

/**
 * Keepalive controller interface.
 * @description Manages Service Worker keepalive state.
 */
export interface KeepaliveController {
  /**
   * Acquire (increment reference count).
   * @param tag Tag used for debugging.
   * @returns Release function.
   */
  acquire(tag: string): () => void;

  /** Whether any keepalive reference is currently held. */
  isActive(): boolean;

  /** Current reference count. */
  getRefCount(): number;

  /** Release all references (primarily for testing). */
  releaseAll(): void;
}

/**
 * Offscreen keepalive options.
 */
export interface OffscreenKeepaliveOptions {
  /** Logger. */
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

// ==================== Factory ====================

/**
 * Create an Offscreen keepalive controller.
 * @description Reuses the global OffscreenManager to avoid creating multiple Offscreen Documents concurrently.
 */
export function createOffscreenKeepaliveController(
  options: OffscreenKeepaliveOptions = {},
): KeepaliveController {
  return new OffscreenKeepaliveControllerImpl(options);
}

/**
 * Create a NotImplemented KeepaliveController.
 * @description Placeholder implementation.
 */
export function createNotImplementedKeepaliveController(): KeepaliveController {
  return {
    acquire: () => {
      console.warn('[KeepaliveController] Not implemented, returning no-op release');
      return () => {};
    },
    isActive: () => false,
    getRefCount: () => 0,
    releaseAll: () => {},
  };
}

// ==================== Implementation ====================

/**
 * Offscreen keepalive controller implementation.
 */
class OffscreenKeepaliveControllerImpl implements KeepaliveController {
  private readonly refs = new Map<string, number>();
  private totalRefs = 0;

  private offscreenPort: chrome.runtime.Port | null = null;
  private connectionListenerRegistered = false;

  // Used to serialize async operations to avoid races.
  private syncPromise: Promise<void> = Promise.resolve();

  private readonly logger: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

  constructor(options: OffscreenKeepaliveOptions) {
    this.logger = options.logger ?? console;
    // Register listener eagerly to avoid missing Offscreen connect events.
    // This prevents race conditions where Offscreen connects before we start listening.
    this.ensureConnectionListener();
  }

  acquire(tag: string): () => void {
    this.totalRefs += 1;

    const count = this.refs.get(tag) ?? 0;
    this.refs.set(tag, count + 1);

    this.logger.debug(`[OffscreenKeepalive] acquire(${tag}), totalRefs=${this.totalRefs}`);

    // Start keepalive when the first reference is acquired.
    if (this.totalRefs === 1) {
      this.scheduleSync();
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;

      if (this.totalRefs > 0) {
        this.totalRefs -= 1;
      }

      const currentCount = this.refs.get(tag) ?? 0;
      if (currentCount <= 1) {
        this.refs.delete(tag);
      } else {
        this.refs.set(tag, currentCount - 1);
      }

      this.logger.debug(`[OffscreenKeepalive] release(${tag}), totalRefs=${this.totalRefs}`);

      // Stop keepalive when the reference count drops to zero.
      if (this.totalRefs === 0) {
        this.scheduleSync();
      }
    };
  }

  isActive(): boolean {
    return this.totalRefs > 0;
  }

  getRefCount(): number {
    return this.totalRefs;
  }

  releaseAll(): void {
    if (this.totalRefs === 0) return;

    this.logger.debug('[OffscreenKeepalive] releaseAll()');
    this.refs.clear();
    this.totalRefs = 0;
    this.scheduleSync();
  }

  /**
   * Get the current reference counts grouped by tag.
   * @description Useful for debugging.
   */
  getRefsByTag(): Record<string, number> {
    return Object.fromEntries(this.refs);
  }

  // ==================== Private Methods ====================

  /**
   * Schedule a sync operation.
   * @description Serializes async operations to avoid races.
   */
  private scheduleSync(): void {
    this.syncPromise = this.syncPromise
      .catch(() => {
        // Ignore previous operation errors.
      })
      .then(() => this.syncOnce())
      .catch((e) => {
        this.logger.warn('[OffscreenKeepalive] sync failed:', e);
      });
  }

  /**
   * Perform a single sync step based on the current ref count.
   */
  private async syncOnce(): Promise<void> {
    if (this.totalRefs > 0) {
      // Ensure listener exists before Offscreen connects (race prevention).
      this.ensureConnectionListener();

      // Ensure the Offscreen document exists.
      await offscreenManager.ensureOffscreenDocument();

      // Re-check after await: state may have changed while we were creating the document.
      if (this.totalRefs === 0) {
        await this.teardown();
        return;
      }

      // Send start command via runtime message (works even if Port is not connected).
      await this.sendRuntimeControl('start');
      // Also send via Port if connected.
      this.sendStartCommand();
    } else {
      // Send stop via Port first (if connected).
      this.sendStopCommand();
      // Then send via runtime message to ensure Offscreen stops.
      await this.sendRuntimeControl('stop');
      await this.teardown();
    }
  }

  /**
   * Clean up resources.
   */
  private async teardown(): Promise<void> {
    this.disconnectPort();
    // Note: We do not close the Offscreen Document here because it may be used by other modules.
    // If Offscreen Document lifecycle needs ref-counting, it should be implemented in OffscreenManager.
  }

  /**
   * Ensure the Port connection listener is registered.
   */
  private ensureConnectionListener(): void {
    if (this.connectionListenerRegistered) return;

    if (typeof chrome === 'undefined' || !chrome.runtime?.onConnect) {
      this.logger.warn('[OffscreenKeepalive] chrome.runtime.onConnect not available');
      return;
    }

    chrome.runtime.onConnect.addListener(this.handleConnect);
    this.connectionListenerRegistered = true;

    this.logger.debug('[OffscreenKeepalive] Connection listener registered');
  }

  /**
   * Handle Port connections from Offscreen.
   */
  private handleConnect = (port: chrome.runtime.Port): void => {
    if (port.name !== RR_V3_KEEPALIVE_PORT_NAME) return;

    this.logger.debug('[OffscreenKeepalive] Offscreen connected');

    // Store Port reference.
    this.offscreenPort = port;

    // Listen to messages.
    port.onMessage.addListener(this.handlePortMessage);

    // Listen to disconnect.
    port.onDisconnect.addListener(() => {
      this.logger.debug('[OffscreenKeepalive] Offscreen disconnected');
      if (this.offscreenPort === port) {
        this.offscreenPort = null;
      }
    });

    // If active, send the start command.
    if (this.totalRefs > 0) {
      this.sendStartCommand();
    }
  };

  /**
   * Handle messages from Offscreen.
   */
  private handlePortMessage = (msg: unknown): void => {
    const m = msg as Partial<KeepaliveMessage> | null;
    if (!m || typeof m !== 'object') return;

    if (m.type === 'keepalive.ping') {
      this.logger.debug('[OffscreenKeepalive] Received ping, sending pong');
      this.sendPong();
    }
  };

  /**
   * Disconnect the Port.
   */
  private disconnectPort(): void {
    if (!this.offscreenPort) return;

    const port = this.offscreenPort;
    this.offscreenPort = null;

    try {
      port.disconnect();
    } catch {
      // Port may already be disconnected.
    }

    this.logger.debug('[OffscreenKeepalive] Port disconnected');
  }

  /**
   * Send the start command to Offscreen (Port channel).
   */
  private sendStartCommand(): void {
    if (!this.offscreenPort) return;

    const msg: KeepaliveMessage = {
      type: 'keepalive.start',
      timestamp: Date.now(),
    };

    try {
      this.offscreenPort.postMessage(msg);
      this.logger.debug('[OffscreenKeepalive] Sent start command via Port');
    } catch (e) {
      this.logger.warn('[OffscreenKeepalive] Failed to send start command:', e);
    }
  }

  /**
   * Send the stop command to Offscreen (Port channel).
   */
  private sendStopCommand(): void {
    if (!this.offscreenPort) return;

    const msg: KeepaliveMessage = {
      type: 'keepalive.stop',
      timestamp: Date.now(),
    };

    try {
      this.offscreenPort.postMessage(msg);
      this.logger.debug('[OffscreenKeepalive] Sent stop command via Port');
    } catch (e) {
      this.logger.warn('[OffscreenKeepalive] Failed to send stop command:', e);
    }
  }

  /**
   * Send a pong response.
   */
  private sendPong(): void {
    if (!this.offscreenPort) return;

    const msg: KeepaliveMessage = {
      type: 'keepalive.pong',
      timestamp: Date.now(),
    };

    try {
      this.offscreenPort.postMessage(msg);
    } catch (e) {
      this.logger.warn('[OffscreenKeepalive] Failed to send pong:', e);
    }
  }

  /**
   * Send a runtime control command to Offscreen.
   * This is the control plane used to start/stop keepalive even when the Port is not connected.
   */
  private async sendRuntimeControl(command: KeepaliveControlCommand): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      this.logger.warn('[OffscreenKeepalive] chrome.runtime.sendMessage not available');
      return;
    }

    const msg: KeepaliveControlMessage = {
      type: KEEPALIVE_CONTROL_MESSAGE_TYPE,
      command,
    };

    // Retry with delays for start command (Offscreen document may not be ready yet).
    const delaysMs = command === 'start' ? [0, 50, 200] : [0];
    for (const delayMs of delaysMs) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      try {
        await chrome.runtime.sendMessage(msg);
        this.logger.debug(`[OffscreenKeepalive] Sent runtime ${command} command`);
        return;
      } catch {
        // Best-effort: Offscreen document may not be ready yet.
      }
    }

    this.logger.warn(`[OffscreenKeepalive] Failed to send runtime ${command} command`);
  }
}

// ==================== Test Utilities ====================

/**
 * In-memory keepalive controller.
 * @description For tests only: tracks reference counts without using Offscreen.
 */
export class InMemoryKeepaliveController implements KeepaliveController {
  private refs = new Map<string, number>();

  acquire(tag: string): () => void {
    const count = this.refs.get(tag) ?? 0;
    this.refs.set(tag, count + 1);

    let released = false;
    return () => {
      if (released) return;
      released = true;

      const currentCount = this.refs.get(tag) ?? 0;
      if (currentCount <= 1) {
        this.refs.delete(tag);
      } else {
        this.refs.set(tag, currentCount - 1);
      }
    };
  }

  isActive(): boolean {
    return this.refs.size > 0;
  }

  getRefCount(): number {
    let total = 0;
    for (const count of this.refs.values()) {
      total += count;
    }
    return total;
  }

  releaseAll(): void {
    this.refs.clear();
  }

  /**
   * Get the current reference counts grouped by tag.
   * @description Useful for debugging.
   */
  getRefsByTag(): Record<string, number> {
    return Object.fromEntries(this.refs);
  }
}
