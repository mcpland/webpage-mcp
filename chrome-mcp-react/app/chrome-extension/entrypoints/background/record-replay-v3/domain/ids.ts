/**
 * @fileoverview ID 类型定义
 * @description 定义 Record-Replay V3 中使用的各种 ID 类型
 */

/** Flow 唯一标识符 */
export type FlowId = string;

/** Node 唯一标识符 */
export type NodeId = string;

/** Edge 唯一标识符 */
export type EdgeId = string;

/** Run 唯一标识符 */
export type RunId = string;

/** Trigger 唯一标识符 */
export type TriggerId = string;

/** Edge 标签类型 */
export type EdgeLabel = string;

/** 预定义的 Edge 标签常量 */
export const EDGE_LABELS = {
  /** 默认边 */
  DEFAULT: 'default',
  /** 错误处理边 */
  ON_ERROR: 'onError',
  /** 条件为真时的边 */
  TRUE: 'true',
  /** 条件为假时的边 */
  FALSE: 'false',
} as const;

/** Edge 标签类型（从常量推导） */
export type EdgeLabelValue = (typeof EDGE_LABELS)[keyof typeof EDGE_LABELS];
