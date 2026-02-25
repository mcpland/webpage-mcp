/**
 * @fileoverview 租约管理
 * @description 管理 Run 的租约续约和过期回收
 */

import type { UnixMillis } from '../../domain/json';
import type { RunId } from '../../domain/ids';
import type { RunQueue, RunQueueConfig, Lease } from './queue';

/**
 * 租约管理器
 * @description 管理租约续约和过期检测
 */
export interface LeaseManager {
  /**
   * 开始心跳
   * @param ownerId 持有者 ID
   */
  startHeartbeat(ownerId: string): void;

  /**
   * 停止心跳
   * @param ownerId 持有者 ID
   */
  stopHeartbeat(ownerId: string): void;

  /**
   * 检查并回收过期租约
   * @param now 当前时间
   * @returns 被回收的 Run ID 列表
   */
  reclaimExpiredLeases(now: UnixMillis): Promise<RunId[]>;

  /**
   * 判断租约是否过期
   */
  isLeaseExpired(lease: Lease, now: UnixMillis): boolean;

  /**
   * 创建新租约
   */
  createLease(ownerId: string, now: UnixMillis): Lease;

  /**
   * 停止所有心跳
   */
  dispose(): void;
}

/**
 * 创建租约管理器
 */
export function createLeaseManager(queue: RunQueue, config: RunQueueConfig): LeaseManager {
  const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

  return {
    startHeartbeat(ownerId: string): void {
      // 如果已有定时器，先停止
      this.stopHeartbeat(ownerId);

      // 创建新的心跳定时器
      const timer = setInterval(async () => {
        try {
          await queue.heartbeat(ownerId, Date.now());
        } catch (error) {
          console.error(`[LeaseManager] Heartbeat failed for ${ownerId}:`, error);
        }
      }, config.heartbeatIntervalMs);

      heartbeatTimers.set(ownerId, timer);
    },

    stopHeartbeat(ownerId: string): void {
      const timer = heartbeatTimers.get(ownerId);
      if (timer) {
        clearInterval(timer);
        heartbeatTimers.delete(ownerId);
      }
    },

    async reclaimExpiredLeases(now: UnixMillis): Promise<RunId[]> {
      // Delegate to the queue implementation which uses the lease_expiresAt index
      // for efficient scanning and updates storage atomically.
      return queue.reclaimExpiredLeases(now);
    },

    isLeaseExpired(lease: Lease, now: UnixMillis): boolean {
      return lease.expiresAt < now;
    },

    createLease(ownerId: string, now: UnixMillis): Lease {
      return {
        ownerId,
        expiresAt: now + config.leaseTtlMs,
      };
    },

    dispose(): void {
      for (const timer of heartbeatTimers.values()) {
        clearInterval(timer);
      }
      heartbeatTimers.clear();
    },
  };
}

/**
 * 生成唯一的 owner ID
 * @description 用于标识当前 Service Worker 实例
 */
export function generateOwnerId(): string {
  return `sw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
