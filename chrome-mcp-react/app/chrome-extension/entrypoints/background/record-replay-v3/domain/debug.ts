/**
 * @fileoverview 调试器类型定义
 * @description 定义 Record-Replay V3 中的调试器状态和协议
 */

import type { JsonValue } from './json';
import type { NodeId, RunId } from './ids';
import type { PauseReason } from './events';

/**
 * 断点定义
 */
export interface Breakpoint {
  /** 断点所在节点 ID */
  nodeId: NodeId;
  /** 是否启用 */
  enabled: boolean;
}

/**
 * 调试器状态
 * @description 描述调试器当前的连接和执行状态
 */
export interface DebuggerState {
  /** 关联的 Run ID */
  runId: RunId;
  /** 调试器连接状态 */
  status: 'attached' | 'detached';
  /** 执行状态 */
  execution: 'running' | 'paused';
  /** 暂停原因（仅当 execution='paused' 时有效） */
  pauseReason?: PauseReason;
  /** 当前节点 ID */
  currentNodeId?: NodeId;
  /** 断点列表 */
  breakpoints: Breakpoint[];
  /** 单步模式 */
  stepMode?: 'none' | 'stepOver';
}

/**
 * 调试器命令
 * @description 客户端发送给调试器的命令
 */
export type DebuggerCommand =
  // ===== 连接控制 =====
  | { type: 'debug.attach'; runId: RunId }
  | { type: 'debug.detach'; runId: RunId }

  // ===== 执行控制 =====
  | { type: 'debug.pause'; runId: RunId }
  | { type: 'debug.resume'; runId: RunId }
  | { type: 'debug.stepOver'; runId: RunId }

  // ===== 断点管理 =====
  | { type: 'debug.setBreakpoints'; runId: RunId; nodeIds: NodeId[] }
  | { type: 'debug.addBreakpoint'; runId: RunId; nodeId: NodeId }
  | { type: 'debug.removeBreakpoint'; runId: RunId; nodeId: NodeId }

  // ===== 状态查询 =====
  | { type: 'debug.getState'; runId: RunId }

  // ===== 变量操作 =====
  | { type: 'debug.getVar'; runId: RunId; name: string }
  | { type: 'debug.setVar'; runId: RunId; name: string; value: JsonValue };

/** 调试器命令类型（从联合类型提取） */
export type DebuggerCommandType = DebuggerCommand['type'];

/**
 * 调试器命令响应
 */
export type DebuggerResponse =
  | { ok: true; state?: DebuggerState; value?: JsonValue }
  | { ok: false; error: string };

/**
 * 创建初始调试器状态
 */
export function createInitialDebuggerState(runId: RunId): DebuggerState {
  return {
    runId,
    status: 'detached',
    execution: 'running',
    breakpoints: [],
    stepMode: 'none',
  };
}
