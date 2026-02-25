/**
 * @fileoverview Offscreen Keepalive
 * @description Keeps the MV3 service worker alive using an Offscreen Document + Port heartbeat.
 *
 * Architecture:
 * - Offscreen connects to Background (Service Worker) via a named Port.
 * - Offscreen sends periodic `keepalive.ping` messages while keepalive is enabled.
 * - Background replies with `keepalive.pong` to confirm the channel is alive.
 *
 * Contract:
 * - After `stop`, keepalive must fully stop: no ping loop, no Port, and no reconnection attempts.
 * - After `start`, keepalive must (re)connect if needed and resume the ping loop.
 */

import {
  RR_V3_KEEPALIVE_PORT_NAME,
  DEFAULT_KEEPALIVE_PING_INTERVAL_MS,
  type KeepaliveMessage,
} from '@/common/rr-v3-keepalive-protocol';

// ==================== Runtime Control Protocol ====================

const KEEPALIVE_CONTROL_MESSAGE_TYPE = 'rr_v3_keepalive.control' as const;

type KeepaliveControlCommand = 'start' | 'stop';

interface KeepaliveControlMessage {
  type: typeof KEEPALIVE_CONTROL_MESSAGE_TYPE;
  command: KeepaliveControlCommand;
}

function isKeepaliveControlMessage(value: unknown): value is KeepaliveControlMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.type !== KEEPALIVE_CONTROL_MESSAGE_TYPE) return false;
  return v.command === 'start' || v.command === 'stop';
}

// ==================== State ====================

let initialized = false;
let keepalivePort: chrome.runtime.Port | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
/** Whether keepalive is desired (set by start/stop commands from Background) */
let keepaliveDesired = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// ==================== Type Guards ====================

/**
 * Type guard for KeepaliveMessage.
 */
function isKeepaliveMessage(value: unknown): value is KeepaliveMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;

  const type = v.type;
  if (
    type !== 'keepalive.ping' &&
    type !== 'keepalive.pong' &&
    type !== 'keepalive.start' &&
    type !== 'keepalive.stop'
  ) {
    return false;
  }

  return typeof v.timestamp === 'number' && Number.isFinite(v.timestamp);
}

// ==================== Port Management ====================

/**
 * Schedule a reconnect attempt to maintain the Port connection.
 * Only reconnect while keepalive is desired.
 */
function scheduleReconnect(delayMs = 1000): void {
  if (!initialized) return;
  if (!keepaliveDesired) return;
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!initialized) return;
    if (!keepaliveDesired) return;
    if (!keepalivePort) {
      console.log('[rr-keepalive] Attempting scheduled reconnect...');
      keepalivePort = connectToBackground();
    }
  }, delayMs);
}

/**
 * Create a Port connection to Background.
 */
function connectToBackground(): chrome.runtime.Port | null {
  if (typeof chrome === 'undefined' || !chrome.runtime?.connect) {
    console.warn('[rr-keepalive] chrome.runtime.connect not available');
    return null;
  }

  try {
    const port = chrome.runtime.connect({ name: RR_V3_KEEPALIVE_PORT_NAME });

    port.onMessage.addListener((msg: unknown) => {
      if (!isKeepaliveMessage(msg)) return;

      if (msg.type === 'keepalive.start') {
        console.log('[rr-keepalive] Received start command via Port');
        startPingLoop();
      } else if (msg.type === 'keepalive.stop') {
        console.log('[rr-keepalive] Received stop command via Port');
        stopPingLoop();
      } else if (msg.type === 'keepalive.pong') {
        // Background replied to our ping.
        console.debug('[rr-keepalive] Received pong');
      }
    });

    port.onDisconnect.addListener(() => {
      console.log('[rr-keepalive] Port disconnected');
      keepalivePort = null;
      // Only reconnect if keepalive is still desired.
      scheduleReconnect(1000);
    });

    console.log('[rr-keepalive] Connected to background');
    return port;
  } catch (e) {
    console.warn('[rr-keepalive] Failed to connect:', e);
    return null;
  }
}

// ==================== Ping Loop ====================

/**
 * Send a ping message to Background.
 */
function sendPing(): void {
  if (!keepalivePort) {
    keepalivePort = connectToBackground();
  }

  if (!keepalivePort) return;

  const msg: KeepaliveMessage = {
    type: 'keepalive.ping',
    timestamp: Date.now(),
  };

  try {
    keepalivePort.postMessage(msg);
    console.debug('[rr-keepalive] Sent ping');
  } catch (e) {
    console.warn('[rr-keepalive] Failed to send ping:', e);
    keepalivePort = null;
    scheduleReconnect(1000);
  }
}

/**
 * Start the ping loop.
 */
function startPingLoop(): void {
  if (pingTimer) return;

  keepaliveDesired = true;

  // Ensure we have a Port connection.
  if (!keepalivePort) {
    keepalivePort = connectToBackground();
  }

  // Send one ping immediately.
  sendPing();

  // Start the interval timer.
  pingTimer = setInterval(() => {
    sendPing();
  }, DEFAULT_KEEPALIVE_PING_INTERVAL_MS);

  console.log(
    `[rr-keepalive] Ping loop started (interval=${DEFAULT_KEEPALIVE_PING_INTERVAL_MS}ms)`,
  );
}

/**
 * Stop the ping loop.
 * This must fully stop keepalive: no timer, no Port, and no reconnection attempts.
 */
function stopPingLoop(): void {
  keepaliveDesired = false;

  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Disconnect the Port to fully stop keepalive.
  if (keepalivePort) {
    try {
      keepalivePort.disconnect();
    } catch {
      // Ignore
    }
    keepalivePort = null;
  }

  console.log('[rr-keepalive] Ping loop stopped');
}

// ==================== Public API ====================

/**
 * Initialize keepalive control handlers.
 * @description Registers the runtime control listener and waits for start/stop commands.
 */
export function initKeepalive(): void {
  if (initialized) return;
  initialized = true;

  // Check Chrome API availability.
  if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) {
    console.warn('[rr-keepalive] chrome.runtime.onMessage not available');
    return;
  }

  // Listen for runtime control messages from Background.
  // This allows Background to send start/stop even when Port is not connected.
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isKeepaliveControlMessage(msg)) return;

    if (msg.command === 'start') {
      console.log('[rr-keepalive] Received runtime start command');
      startPingLoop();
    } else {
      console.log('[rr-keepalive] Received runtime stop command');
      stopPingLoop();
    }

    try {
      sendResponse({ ok: true });
    } catch {
      // Ignore
    }
  });

  // Also establish initial Port connection for backwards compatibility.
  if (chrome.runtime?.connect) {
    keepalivePort = connectToBackground();
  }

  console.log('[rr-keepalive] Keepalive initialized');
}

/**
 * Check whether keepalive is active.
 */
export function isKeepaliveActive(): boolean {
  return keepaliveDesired && pingTimer !== null && keepalivePort !== null;
}

/**
 * Get the active port count (for debugging).
 * @deprecated Use isKeepaliveActive() instead
 */
export function getActivePortCount(): number {
  return keepalivePort ? 1 : 0;
}

// Re-export for backwards compatibility
export {
  RR_V3_KEEPALIVE_PORT_NAME,
  type KeepaliveMessage,
} from '@/common/rr-v3-keepalive-protocol';
