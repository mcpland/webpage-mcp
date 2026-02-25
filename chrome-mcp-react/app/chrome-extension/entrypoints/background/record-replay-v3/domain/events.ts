/**
 * @fileoverview 事件类型定义
 * @description 定义 Record-Replay V3 中的运行事件和状态
 */

import type { JsonObject, JsonValue, UnixMillis } from './json';
import type { EdgeLabel, FlowId, NodeId, RunId } from './ids';
import type { RRError } from './errors';
import type { TriggerFireContext } from './triggers';

/** 取消订阅函数类型 */
export type Unsubscribe = () => void;

/** Run 状态 */
export type RunStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'canceled';

/**
 * 事件基础接口
 * @description 所有事件的公共字段
 */
export interface EventBase {
  /** 所属 Run ID */
  runId: RunId;
  /** 事件时间戳 */
  ts: UnixMillis;
  /** 单调递增序列号 */
  seq: number;
}

/**
 * 暂停原因
 * @description 描述 Run 暂停的原因
 */
export type PauseReason =
  | { kind: 'breakpoint'; nodeId: NodeId }
  | { kind: 'step'; nodeId: NodeId }
  | { kind: 'command' }
  | { kind: 'policy'; nodeId: NodeId; reason: string };

/** 恢复原因 */
export type RecoveryReason = 'sw_restart' | 'lease_expired';

/**
 * Run 事件联合类型
 * @description 所有可能的运行时事件
 */
export type RunEvent =
  // ===== Run 生命周期事件 =====
  | (EventBase & { type: 'run.queued'; flowId: FlowId })
  | (EventBase & { type: 'run.started'; flowId: FlowId; tabId: number })
  | (EventBase & { type: 'run.paused'; reason: PauseReason; nodeId?: NodeId })
  | (EventBase & { type: 'run.resumed' })
  | (EventBase & {
      type: 'run.recovered';
      /** 恢复原因 */
      reason: RecoveryReason;
      /** 恢复前状态 */
      fromStatus: 'running' | 'paused';
      /** 恢复后状态 */
      toStatus: 'queued';
      /** 原 ownerId（用于审计） */
      prevOwnerId?: string;
    })
  | (EventBase & { type: 'run.canceled'; reason?: string })
  | (EventBase & { type: 'run.succeeded'; tookMs: number; outputs?: JsonObject })
  | (EventBase & { type: 'run.failed'; error: RRError; nodeId?: NodeId })

  // ===== Node 执行事件 =====
  | (EventBase & { type: 'node.queued'; nodeId: NodeId })
  | (EventBase & { type: 'node.started'; nodeId: NodeId; attempt: number })
  | (EventBase & {
      type: 'node.succeeded';
      nodeId: NodeId;
      tookMs: number;
      next?: { kind: 'edgeLabel'; label: EdgeLabel } | { kind: 'end' };
    })
  | (EventBase & {
      type: 'node.failed';
      nodeId: NodeId;
      attempt: number;
      error: RRError;
      decision: 'retry' | 'continue' | 'stop' | 'goto';
    })
  | (EventBase & { type: 'node.skipped'; nodeId: NodeId; reason: 'disabled' | 'unreachable' })

  // ===== 变量和日志事件 =====
  | (EventBase & {
      type: 'vars.patch';
      patch: Array<{ op: 'set' | 'delete'; name: string; value?: JsonValue }>;
    })
  | (EventBase & { type: 'artifact.screenshot'; nodeId: NodeId; data: string; savedAs?: string })
  | (EventBase & {
      type: 'log';
      level: 'debug' | 'info' | 'warn' | 'error';
      message: string;
      data?: JsonValue;
    });

/** Run 事件类型（从联合类型提取） */
export type RunEventType = RunEvent['type'];

/**
 * 分布式 Omit（保留联合类型）
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * Run 事件输入类型
 * @description seq 必须由 storage 层原子分配（通过 RunRecordV3.nextSeq）
 * ts 可选，默认为 Date.now()
 */
export type RunEventInput = DistributiveOmit<RunEvent, 'seq' | 'ts'> & {
  ts?: UnixMillis;
};

/** Run Schema 版本 */
export const RUN_SCHEMA_VERSION = 3 as const;

/**
 * Run 记录 V3
 * @description 存储在 IndexedDB 中的 Run 摘要记录
 */
export interface RunRecordV3 {
  /** Schema 版本 */
  schemaVersion: typeof RUN_SCHEMA_VERSION;
  /** Run 唯一标识符 */
  id: RunId;
  /** 关联的 Flow ID */
  flowId: FlowId;

  /** 当前状态 */
  status: RunStatus;
  /** 创建时间 */
  createdAt: UnixMillis;
  /** 最后更新时间 */
  updatedAt: UnixMillis;

  /** 开始执行时间 */
  startedAt?: UnixMillis;
  /** 结束时间 */
  finishedAt?: UnixMillis;
  /** 总耗时（毫秒） */
  tookMs?: number;

  /** 绑定的 Tab ID（每 Run 独占） */
  tabId?: number;
  /** 起始节点 ID（如果不是默认入口） */
  startNodeId?: NodeId;
  /** 当前执行节点 ID */
  currentNodeId?: NodeId;

  /** 当前尝试次数 */
  attempt: number;
  /** 最大尝试次数 */
  maxAttempts: number;

  /** 运行参数 */
  args?: JsonObject;
  /** 触发器上下文 */
  trigger?: TriggerFireContext;
  /** 调试配置 */
  debug?: { breakpoints?: NodeId[]; pauseOnStart?: boolean };

  /** 错误信息（如果失败） */
  error?: RRError;
  /** 输出结果 */
  outputs?: JsonObject;

  /** 下一个事件序列号（缓存字段） */
  nextSeq: number;
}

/**
 * 判断 Run 是否已终止
 */
export function isTerminalStatus(status: RunStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

/**
 * 判断 Run 是否正在执行
 */
export function isActiveStatus(status: RunStatus): boolean {
  return status === 'running' || status === 'paused';
}
