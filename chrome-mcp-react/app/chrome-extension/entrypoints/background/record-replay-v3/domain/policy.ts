/**
 * @fileoverview 策略类型定义
 * @description 定义 Record-Replay V3 中使用的超时、重试、错误处理和工件策略
 */

import type { EdgeLabel, NodeId } from './ids';
import type { RRErrorCode } from './errors';
import type { UnixMillis } from './json';

/**
 * 超时策略
 * @description 定义操作的超时时间和作用范围
 */
export interface TimeoutPolicy {
  /** 超时时间（毫秒） */
  ms: UnixMillis;
  /** 超时范围：attempt=每次尝试, node=整个节点执行 */
  scope?: 'attempt' | 'node';
}

/**
 * 重试策略
 * @description 定义失败后的重试行为
 */
export interface RetryPolicy {
  /** 最大重试次数 */
  retries: number;
  /** 重试间隔（毫秒） */
  intervalMs: UnixMillis;
  /** 退避策略：none=固定间隔, exp=指数退避, linear=线性增长 */
  backoff?: 'none' | 'exp' | 'linear';
  /** 最大重试间隔（毫秒） */
  maxIntervalMs?: UnixMillis;
  /** 抖动策略：none=无抖动, full=完全随机 */
  jitter?: 'none' | 'full';
  /** 仅在这些错误码时重试 */
  retryOn?: ReadonlyArray<RRErrorCode>;
}

/**
 * 错误处理策略
 * @description 定义节点执行失败后的处理方式
 */
export type OnErrorPolicy =
  | { kind: 'stop' }
  | { kind: 'continue'; as?: 'warning' | 'error' }
  | {
      kind: 'goto';
      target: { kind: 'edgeLabel'; label: EdgeLabel } | { kind: 'node'; nodeId: NodeId };
    }
  | { kind: 'retry'; override?: Partial<RetryPolicy> };

/**
 * 工件策略
 * @description 定义截图和日志收集的行为
 */
export interface ArtifactPolicy {
  /** 截图策略：never=从不, onFailure=失败时, always=总是 */
  screenshot?: 'never' | 'onFailure' | 'always';
  /** 截图保存路径模板 */
  saveScreenshotAs?: string;
  /** 是否包含控制台日志 */
  includeConsole?: boolean;
  /** 是否包含网络请求 */
  includeNetwork?: boolean;
}

/**
 * 节点级策略
 * @description 单个节点的执行策略配置
 */
export interface NodePolicy {
  /** 超时策略 */
  timeout?: TimeoutPolicy;
  /** 重试策略 */
  retry?: RetryPolicy;
  /** 错误处理策略 */
  onError?: OnErrorPolicy;
  /** 工件策略 */
  artifacts?: ArtifactPolicy;
}

/**
 * Flow 级策略
 * @description 整个 Flow 的执行策略配置
 */
export interface FlowPolicy {
  /** 默认节点策略 */
  defaultNodePolicy?: NodePolicy;
  /** 不支持节点的处理策略 */
  unsupportedNodePolicy?: OnErrorPolicy;
  /** Run 总超时时间（毫秒） */
  runTimeoutMs?: UnixMillis;
}

/**
 * 合并节点策略
 * @description 将 Flow 级默认策略与节点级策略合并
 */
export function mergeNodePolicy(
  flowDefault: NodePolicy | undefined,
  nodePolicy: NodePolicy | undefined,
): NodePolicy {
  if (!flowDefault) return nodePolicy ?? {};
  if (!nodePolicy) return flowDefault;

  return {
    timeout: nodePolicy.timeout ?? flowDefault.timeout,
    retry: nodePolicy.retry ?? flowDefault.retry,
    onError: nodePolicy.onError ?? flowDefault.onError,
    artifacts: nodePolicy.artifacts
      ? { ...flowDefault.artifacts, ...nodePolicy.artifacts }
      : flowDefault.artifacts,
  };
}
