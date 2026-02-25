/**
 * @fileoverview 错误类型定义
 * @description 定义 Record-Replay V3 中使用的错误码和错误类型
 */

import type { JsonValue } from './json';

/** 错误码常量 */
export const RR_ERROR_CODES = {
  // ===== 验证错误 =====
  /** 通用验证错误 */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** 不支持的节点类型 */
  UNSUPPORTED_NODE: 'UNSUPPORTED_NODE',
  /** DAG 结构无效 */
  DAG_INVALID: 'DAG_INVALID',
  /** DAG 存在循环 */
  DAG_CYCLE: 'DAG_CYCLE',

  // ===== 运行时错误 =====
  /** 操作超时 */
  TIMEOUT: 'TIMEOUT',
  /** Tab 未找到 */
  TAB_NOT_FOUND: 'TAB_NOT_FOUND',
  /** Frame 未找到 */
  FRAME_NOT_FOUND: 'FRAME_NOT_FOUND',
  /** 目标元素未找到 */
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  /** 元素不可见 */
  ELEMENT_NOT_VISIBLE: 'ELEMENT_NOT_VISIBLE',
  /** 导航失败 */
  NAVIGATION_FAILED: 'NAVIGATION_FAILED',
  /** 网络请求失败 */
  NETWORK_REQUEST_FAILED: 'NETWORK_REQUEST_FAILED',

  // ===== 脚本/工具错误 =====
  /** 脚本执行失败 */
  SCRIPT_FAILED: 'SCRIPT_FAILED',
  /** 权限被拒绝 */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** 工具执行错误 */
  TOOL_ERROR: 'TOOL_ERROR',

  // ===== 控制错误 =====
  /** Run 被取消 */
  RUN_CANCELED: 'RUN_CANCELED',
  /** Run 被暂停 */
  RUN_PAUSED: 'RUN_PAUSED',

  // ===== 内部错误 =====
  /** 内部错误 */
  INTERNAL: 'INTERNAL',
  /** 不变量违规 */
  INVARIANT_VIOLATION: 'INVARIANT_VIOLATION',
} as const;

/** 错误码类型 */
export type RRErrorCode = (typeof RR_ERROR_CODES)[keyof typeof RR_ERROR_CODES];

/**
 * Record-Replay 错误接口
 * @description 统一的错误表示，支持错误链和可重试标记
 */
export interface RRError {
  /** 错误码 */
  code: RRErrorCode;
  /** 错误消息 */
  message: string;
  /** 附加数据 */
  data?: JsonValue;
  /** 是否可重试 */
  retryable?: boolean;
  /** 原因错误（错误链） */
  cause?: RRError;
}

/**
 * 创建 RRError 的工厂函数
 */
export function createRRError(
  code: RRErrorCode,
  message: string,
  options?: { data?: JsonValue; retryable?: boolean; cause?: RRError },
): RRError {
  return {
    code,
    message,
    ...(options?.data !== undefined && { data: options.data }),
    ...(options?.retryable !== undefined && { retryable: options.retryable }),
    ...(options?.cause !== undefined && { cause: options.cause }),
  };
}
