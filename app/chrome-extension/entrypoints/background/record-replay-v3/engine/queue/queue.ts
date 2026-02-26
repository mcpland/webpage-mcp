/**
 * @fileoverview RunQueue Interface definition
 * @description Define the management interface of the Run queue
 */

import type { JsonObject, UnixMillis } from '../../domain/json';
import type { FlowId, NodeId, RunId } from '../../domain/ids';
import type { TriggerFireContext } from '../../domain/triggers';

/**
 * RunQueue Configuration
 */
export interface RunQueueConfig {
  /** Maximum number of parallel runs */
  maxParallelRuns: number;
  /** Lease TTL (milliseconds) */
  leaseTtlMs: number;
  /** Heartbeat interval (milliseconds) */
  heartbeatIntervalMs: number;
}

/**
 * Default queue configuration
 */
export const DEFAULT_QUEUE_CONFIG: RunQueueConfig = {
  maxParallelRuns: 3,
  leaseTtlMs: 15_000,
  heartbeatIntervalMs: 5_000,
};

/**
 * Queue item status
 */
export type QueueItemStatus = 'queued' | 'running' | 'paused';

/**
 * Lease information
 */
export interface Lease {
  /** Holder ID */
  ownerId: string;
  /** Expiration time */
  expiresAt: UnixMillis;
}

/**
 * RunQueue queue item
 */
export interface RunQueueItem {
  /** Run ID */
  id: RunId;
  /** Flow ID */
  flowId: FlowId;
  /** Status */
  status: QueueItemStatus;
  /** creation time */
  createdAt: UnixMillis;
  /** Update time */
  updatedAt: UnixMillis;
  /** Priority (the larger the number, the higher the priority) */
  priority: number;
  /** Current attempts */
  attempt: number;
  /** Maximum number of attempts */
  maxAttempts: number;
  /** Tab ID */
  tabId?: number;
  /** Operating parameters */
  args?: JsonObject;
  /** trigger context */
  trigger?: TriggerFireContext;
  /** Lease information */
  lease?: Lease;
  /** Debug configuration */
  debug?: { breakpoints?: NodeId[]; pauseOnStart?: boolean };
}

/**
 * Enqueue request (without automatically generated fields)
 * - priority Default is 0
 * - maxAttempts Default is 1
 */
export type EnqueueInput = Omit<
  RunQueueItem,
  'status' | 'createdAt' | 'updatedAt' | 'attempt' | 'lease' | 'priority' | 'maxAttempts'
> & {
  id: RunId;
  /** Priority (the larger the number, the higher the priority, default 0) */
  priority?: number;
  /** Maximum number of attempts (default 1) */
  maxAttempts?: number;
};

/**
 * RunQueue interface
 * @description Manage Run queues and scheduling
 */
export interface RunQueue {
  /**
   * Join the team
   * @param input enqueue request
   * @returns queue item
   */
  enqueue(input: EnqueueInput): Promise<RunQueueItem>;

  /**
   * Get the next executable Run
   * @param ownerId Recipient ID
   * @param now current time
   * @returns queue item or null
   */
  claimNext(ownerId: string, now: UnixMillis): Promise<RunQueueItem | null>;

  /**
   * contract renewal heartbeat
   * @param ownerId Recipient ID
   * @param now current time
   */
  heartbeat(ownerId: string, now: UnixMillis): Promise<void>;

  /**
   * Recover expired lease
   * @description Will lease.expiresAt < now The running/paused items are recycled to queued
   * @param now current time
   * @returns List of recycled Run IDs
   */
  reclaimExpiredLeases(now: UnixMillis): Promise<RunId[]>;

  /**
   * Restore orphan leases (called after SW restart)
   * @description
   * - Recycle orphan running items as queued (status -> queued，lease clear)
   * - Take over orphan paused items (keep status=paused, update lease ownerId to new ownerId)
   * @param ownerId new ownerId (current Service Worker instance)
   * @param now current time
   * @returns Affected runId list (including original ownerId for auditing)
   */
  recoverOrphanLeases(
    ownerId: string,
    now: UnixMillis,
  ): Promise<{
    requeuedRunning: Array<{ runId: RunId; prevOwnerId?: string }>;
    adoptedPaused: Array<{ runId: RunId; prevOwnerId?: string }>;
  }>;

  /**
   * Marked as running
   */
  markRunning(runId: RunId, ownerId: string, now: UnixMillis): Promise<void>;

  /**
   * Marked as paused
   */
  markPaused(runId: RunId, ownerId: string, now: UnixMillis): Promise<void>;

  /**
   * Mark as complete (remove from queue)
   */
  markDone(runId: RunId, now: UnixMillis): Promise<void>;

  /**
   * Cancel Run
   */
  cancel(runId: RunId, now: UnixMillis, reason?: string): Promise<void>;

  /**
   * Get queue item
   */
  get(runId: RunId): Promise<RunQueueItem | null>;

  /**
   * List queue items
   */
  list(status?: QueueItemStatus): Promise<RunQueueItem[]>;
}

/**
 * Create a NotImplemented RunQueue
 * @description Phase 0 Placeholder implementation
 */
export function createNotImplementedQueue(): RunQueue {
  const notImplemented = () => {
    throw new Error('RunQueue not implemented');
  };

  return {
    enqueue: async () => notImplemented(),
    claimNext: async () => notImplemented(),
    heartbeat: async () => notImplemented(),
    reclaimExpiredLeases: async () => notImplemented(),
    recoverOrphanLeases: async () => notImplemented(),
    markRunning: async () => notImplemented(),
    markPaused: async () => notImplemented(),
    markDone: async () => notImplemented(),
    cancel: async () => notImplemented(),
    get: async () => notImplemented(),
    list: async () => notImplemented(),
  };
}
