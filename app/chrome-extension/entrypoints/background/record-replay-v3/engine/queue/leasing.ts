/**
 * @fileoverview Lease management
 * @description Manage Run's lease renewal and expired recycling
 */

import type { UnixMillis } from '../../domain/json';
import type { RunId } from '../../domain/ids';
import type { RunQueue, RunQueueConfig, Lease } from './queue';

/**
 * lease manager
 * @description Manage lease renewal and expiration detection
 */
export interface LeaseManager {
  /**
   * Start heartbeat
   * @param ownerId Holder ID
   */
  startHeartbeat(ownerId: string): void;

  /**
   * stop heartbeat
   * @param ownerId Holder ID
   */
  stopHeartbeat(ownerId: string): void;

  /**
   * Check and reclaim expired leases
   * @param now current time
   * @returns List of recycled Run IDs
   */
  reclaimExpiredLeases(now: UnixMillis): Promise<RunId[]>;

  /**
   * Determine whether the lease has expired
   */
  isLeaseExpired(lease: Lease, now: UnixMillis): boolean;

  /**
   * Create new lease
   */
  createLease(ownerId: string, now: UnixMillis): Lease;

  /**
   * stop all heartbeats
   */
  dispose(): void;
}

/**
 * Create a lease manager
 */
export function createLeaseManager(queue: RunQueue, config: RunQueueConfig): LeaseManager {
  const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();

  return {
    startHeartbeat(ownerId: string): void {
      // If there is a timer, stop it first
      this.stopHeartbeat(ownerId);

      // Create a new heartbeat timer
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
 * Generate unique owner ID
 * @description Used to identify the current Service Worker instance
 */
export function generateOwnerId(): string {
  return `sw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
