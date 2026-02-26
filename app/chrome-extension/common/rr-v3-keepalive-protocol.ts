/**
 * @fileoverview RR V3 Keepalive Protocol Constants
 * @description Shared protocol constants for Background-Offscreen keepalive communication
 */

/** Keepalive Port Name */
export const RR_V3_KEEPALIVE_PORT_NAME = 'rr_v3_keepalive' as const;

/** Keepalive Message type */
export type KeepaliveMessageType =
  | 'keepalive.ping'
  | 'keepalive.pong'
  | 'keepalive.start'
  | 'keepalive.stop';

/** Keepalive news */
export interface KeepaliveMessage {
  type: KeepaliveMessageType;
  timestamp: number;
}

/** Default heartbeat interval (milliseconds) - Offscreen sends a ping every this interval */
export const DEFAULT_KEEPALIVE_PING_INTERVAL_MS = 20_000;

/** Maximum heartbeat interval (milliseconds) - Chrome MV3 SW terminates after approximately 30s of idle time */
export const MAX_KEEPALIVE_PING_INTERVAL_MS = 25_000;
