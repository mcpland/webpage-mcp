/**
 * @fileoverview Strategy type definition
 * @description Define timeouts, retries, error handling and artifact strategies used in Record-Replay V3
 */

import type { EdgeLabel, NodeId } from './ids';
import type { RRErrorCode } from './errors';
import type { UnixMillis } from './json';

/**
 * timeout policy
 * @description Define the timeout and scope of the operation
 */
export interface TimeoutPolicy {
  /** Timeout (milliseconds) */
  ms: UnixMillis;
  /** Timeout range: attempt=each attempt, node=execute on the entire node */
  scope?: 'attempt' | 'node';
}

/**
 * Retry strategy
 * @description Define retry behavior after failure
 */
export interface RetryPolicy {
  /** Maximum number of retries */
  retries: number;
  /** Retry interval (milliseconds) */
  intervalMs: UnixMillis;
  /** Backoff strategy: none=fixed interval, exp=exponential backoff, linear=linear growth */
  backoff?: 'none' | 'exp' | 'linear';
  /** Maximum retry interval (milliseconds) */
  maxIntervalMs?: UnixMillis;
  /** Jitter strategy: none=no jitter, full=completely random */
  jitter?: 'none' | 'full';
  /** Only retry on these error codes */
  retryOn?: ReadonlyArray<RRErrorCode>;
}

/**
 * Error handling strategy
 * @description Define how to handle node execution failure
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
 * artifact strategy
 * @description Define the behavior of screenshot and log collection
 */
export interface ArtifactPolicy {
  /** Screenshot strategy: never=never, onFailure=on failure, always=always */
  screenshot?: 'never' | 'onFailure' | 'always';
  /** Screenshot saving path template */
  saveScreenshotAs?: string;
  /** Whether to include console logs */
  includeConsole?: boolean;
  /** Whether to include network requests */
  includeNetwork?: boolean;
}

/**
 * Node level policy
 * @description Execution policy configuration for a single node
 */
export interface NodePolicy {
  /** timeout policy */
  timeout?: TimeoutPolicy;
  /** Retry strategy */
  retry?: RetryPolicy;
  /** Error handling strategy */
  onError?: OnErrorPolicy;
  /** artifact strategy */
  artifacts?: ArtifactPolicy;
}

/**
 * Flow level strategy
 * @description Execution strategy configuration of the entire Flow
 */
export interface FlowPolicy {
  /** Default node policy */
  defaultNodePolicy?: NodePolicy;
  /** Node processing strategy is not supported */
  unsupportedNodePolicy?: OnErrorPolicy;
  /** Run Total timeout (milliseconds) */
  runTimeoutMs?: UnixMillis;
}

/**
 * Merge node strategy
 * @description Merge flow-level default policy with node-level policy
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
