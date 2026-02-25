/**
 * @fileoverview ExecutionKernel 接口定义
 * @description 定义 Record-Replay V3 的核心执行引擎接口
 */

import type { JsonObject } from '../../domain/json';
import type { FlowId, NodeId, RunId } from '../../domain/ids';
import type { RRError } from '../../domain/errors';
import type { FlowV3 } from '../../domain/flow';
import type { DebuggerCommand, DebuggerState } from '../../domain/debug';
import type { RunEvent, RunStatus, Unsubscribe } from '../../domain/events';

/**
 * Run 启动请求
 */
export interface RunStartRequest {
  /** Run ID（由调用方生成） */
  runId: RunId;
  /** Flow ID */
  flowId: FlowId;
  /** Flow 快照（执行时使用的完整 Flow 定义） */
  flowSnapshot: FlowV3;
  /** 运行参数 */
  args?: JsonObject;
  /** 起始节点 ID（默认为 Flow 的 entryNodeId） */
  startNodeId?: NodeId;
  /** Tab ID（必须由调用方分配，每 Run 独占） */
  tabId: number;
  /** 调试配置 */
  debug?: { breakpoints?: NodeId[]; pauseOnStart?: boolean };
}

/**
 * Run 执行结果
 */
export interface RunResult {
  /** Run ID */
  runId: RunId;
  /** 最终状态 */
  status: Extract<RunStatus, 'succeeded' | 'failed' | 'canceled'>;
  /** 总耗时（毫秒） */
  tookMs: number;
  /** 错误信息（如果失败） */
  error?: RRError;
  /** 输出结果 */
  outputs?: JsonObject;
}

/**
 * Run 状态查询结果
 */
export interface RunStatusInfo {
  /** 当前状态 */
  status: RunStatus;
  /** 当前节点 ID */
  currentNodeId?: NodeId;
  /** 开始时间 */
  startedAt?: number;
  /** 最后更新时间 */
  updatedAt: number;
  /** Tab ID */
  tabId?: number;
}

/**
 * ExecutionKernel 接口
 * @description Record-Replay V3 的核心执行引擎
 */
export interface ExecutionKernel {
  /**
   * 订阅事件流
   * @param listener 事件监听器
   * @returns 取消订阅函数
   */
  onEvent(listener: (event: RunEvent) => void): Unsubscribe;

  /**
   * 启动 Run
   * @description 将 Run 加入队列并开始执行
   */
  startRun(req: RunStartRequest): Promise<void>;

  /**
   * 暂停 Run
   * @param runId Run ID
   * @param reason 暂停原因
   */
  pauseRun(runId: RunId, reason?: { kind: 'command' }): Promise<void>;

  /**
   * 恢复 Run
   * @param runId Run ID
   */
  resumeRun(runId: RunId): Promise<void>;

  /**
   * 取消 Run
   * @param runId Run ID
   * @param reason 取消原因
   */
  cancelRun(runId: RunId, reason?: string): Promise<void>;

  /**
   * 执行调试命令
   * @param runId Run ID
   * @param cmd 调试命令
   */
  debug(
    runId: RunId,
    cmd: DebuggerCommand,
  ): Promise<{ ok: true; state?: DebuggerState } | { ok: false; error: string }>;

  /**
   * 获取 Run 状态
   * @param runId Run ID
   * @returns Run 状态信息或 null（如果不存在）
   */
  getRunStatus(runId: RunId): Promise<RunStatusInfo | null>;

  /**
   * 恢复执行
   * @description 在 Service Worker 重启后调用，恢复中断的 Run
   */
  recover(): Promise<void>;
}

/**
 * 创建 NotImplemented 的 ExecutionKernel
 * @description Phase 0 占位实现
 */
export function createNotImplementedKernel(): ExecutionKernel {
  const notImplemented = () => {
    throw new Error('ExecutionKernel not implemented');
  };

  return {
    onEvent: () => {
      notImplemented();
      return () => {};
    },
    startRun: async () => notImplemented(),
    pauseRun: async () => notImplemented(),
    resumeRun: async () => notImplemented(),
    cancelRun: async () => notImplemented(),
    debug: async () => notImplemented(),
    getRunStatus: async () => notImplemented(),
    recover: async () => notImplemented(),
  };
}
