/**
 * @fileoverview RR V3 Keepalive Protocol Constants
 * @description Shared protocol constants for Background-Offscreen keepalive communication
 */

/** Keepalive Port 名称 */
export const RR_V3_KEEPALIVE_PORT_NAME = 'rr_v3_keepalive' as const;

/** Keepalive 消息类型 */
export type KeepaliveMessageType =
  | 'keepalive.ping'
  | 'keepalive.pong'
  | 'keepalive.start'
  | 'keepalive.stop';

/** Keepalive 消息 */
export interface KeepaliveMessage {
  type: KeepaliveMessageType;
  timestamp: number;
}

/** 默认心跳间隔（毫秒） - Offscreen 每隔这个间隔发送 ping */
export const DEFAULT_KEEPALIVE_PING_INTERVAL_MS = 20_000;

/** 最大心跳间隔（毫秒）- Chrome MV3 SW 约 30s 空闲后终止 */
export const MAX_KEEPALIVE_PING_INTERVAL_MS = 25_000;
