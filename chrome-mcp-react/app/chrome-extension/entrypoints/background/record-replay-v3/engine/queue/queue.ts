/**
 * @fileoverview RunQueue 接口定义
 * @description 定义 Run 队列的管理接口
 */

import type { JsonObject, UnixMillis } from '../../domain/json';
import type { FlowId, NodeId, RunId } from '../../domain/ids';
import type { TriggerFireContext } from '../../domain/triggers';

/**
 * RunQueue 配置
 */
export interface RunQueueConfig {
  /** 最大并行 Run 数量 */
  maxParallelRuns: number;
  /** 租约 TTL（毫秒） */
  leaseTtlMs: number;
  /** 心跳间隔（毫秒） */
  heartbeatIntervalMs: number;
}

/**
 * 默认队列配置
 */
export const DEFAULT_QUEUE_CONFIG: RunQueueConfig = {
  maxParallelRuns: 3,
  leaseTtlMs: 15_000,
  heartbeatIntervalMs: 5_000,
};

/**
 * 队列项状态
 */
export type QueueItemStatus = 'queued' | 'running' | 'paused';

/**
 * 租约信息
 */
export interface Lease {
  /** 持有者 ID */
  ownerId: string;
  /** 过期时间 */
  expiresAt: UnixMillis;
}

/**
 * RunQueue 队列项
 */
export interface RunQueueItem {
  /** Run ID */
  id: RunId;
  /** Flow ID */
  flowId: FlowId;
  /** 状态 */
  status: QueueItemStatus;
  /** 创建时间 */
  createdAt: UnixMillis;
  /** 更新时间 */
  updatedAt: UnixMillis;
  /** 优先级（数字越大优先级越高） */
  priority: number;
  /** 当前尝试次数 */
  attempt: number;
  /** 最大尝试次数 */
  maxAttempts: number;
  /** Tab ID */
  tabId?: number;
  /** 运行参数 */
  args?: JsonObject;
  /** 触发器上下文 */
  trigger?: TriggerFireContext;
  /** 租约信息 */
  lease?: Lease;
  /** 调试配置 */
  debug?: { breakpoints?: NodeId[]; pauseOnStart?: boolean };
}

/**
 * 入队请求（不含自动生成的字段）
 * - priority 默认为 0
 * - maxAttempts 默认为 1
 */
export type EnqueueInput = Omit<
  RunQueueItem,
  'status' | 'createdAt' | 'updatedAt' | 'attempt' | 'lease' | 'priority' | 'maxAttempts'
> & {
  id: RunId;
  /** 优先级（数字越大优先级越高，默认 0） */
  priority?: number;
  /** 最大尝试次数（默认 1） */
  maxAttempts?: number;
};

/**
 * RunQueue 接口
 * @description 管理 Run 的队列和调度
 */
export interface RunQueue {
  /**
   * 入队
   * @param input 入队请求
   * @returns 队列项
   */
  enqueue(input: EnqueueInput): Promise<RunQueueItem>;

  /**
   * 领取下一个可执行的 Run
   * @param ownerId 领取者 ID
   * @param now 当前时间
   * @returns 队列项或 null
   */
  claimNext(ownerId: string, now: UnixMillis): Promise<RunQueueItem | null>;

  /**
   * 续约心跳
   * @param ownerId 领取者 ID
   * @param now 当前时间
   */
  heartbeat(ownerId: string, now: UnixMillis): Promise<void>;

  /**
   * 回收过期租约
   * @description 将 lease.expiresAt < now 的 running/paused 项回收为 queued
   * @param now 当前时间
   * @returns 被回收的 Run ID 列表
   */
  reclaimExpiredLeases(now: UnixMillis): Promise<RunId[]>;

  /**
   * 恢复孤儿租约（SW 重启后调用）
   * @description
   * - 将孤儿 running 项回收为 queued（status -> queued，租约清除）
   * - 将孤儿 paused 项接管（保持 status=paused，租约 ownerId 更新为新 ownerId）
   * @param ownerId 新的 ownerId（当前 Service Worker 实例）
   * @param now 当前时间
   * @returns 受影响的 runId 列表（含原 ownerId 用于审计）
   */
  recoverOrphanLeases(
    ownerId: string,
    now: UnixMillis,
  ): Promise<{
    requeuedRunning: Array<{ runId: RunId; prevOwnerId?: string }>;
    adoptedPaused: Array<{ runId: RunId; prevOwnerId?: string }>;
  }>;

  /**
   * 标记为 running
   */
  markRunning(runId: RunId, ownerId: string, now: UnixMillis): Promise<void>;

  /**
   * 标记为 paused
   */
  markPaused(runId: RunId, ownerId: string, now: UnixMillis): Promise<void>;

  /**
   * 标记为完成（从队列移除）
   */
  markDone(runId: RunId, now: UnixMillis): Promise<void>;

  /**
   * 取消 Run
   */
  cancel(runId: RunId, now: UnixMillis, reason?: string): Promise<void>;

  /**
   * 获取队列项
   */
  get(runId: RunId): Promise<RunQueueItem | null>;

  /**
   * 列出队列项
   */
  list(status?: QueueItemStatus): Promise<RunQueueItem[]>;
}

/**
 * 创建 NotImplemented 的 RunQueue
 * @description Phase 0 占位实现
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
