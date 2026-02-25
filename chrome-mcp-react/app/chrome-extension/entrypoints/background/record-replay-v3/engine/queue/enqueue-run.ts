/**
 * @fileoverview 共享入队服务
 * @description
 * 提供统一的 Run 入队逻辑，供 RPC Server 和 TriggerManager 共用。
 *
 * 设计理由：
 * - 将原本位于 RpcServer 的入队逻辑抽离为独立服务
 * - 避免 RPC 和 TriggerManager 之间的行为漂移
 * - 统一参数校验、Run 创建、队列入队、事件发布流程
 */

import type { JsonObject, UnixMillis } from '../../domain/json';
import type { FlowId, NodeId, RunId } from '../../domain/ids';
import type { TriggerFireContext } from '../../domain/triggers';
import { RUN_SCHEMA_VERSION, type RunRecordV3 } from '../../domain/events';
import type { StoragePort } from '../storage/storage-port';
import type { EventsBus } from '../transport/events-bus';
import type { RunScheduler } from './scheduler';

// ==================== Types ====================

/**
 * 入队服务依赖
 */
export interface EnqueueRunDeps {
  /** 存储层 (仅需 flows/runs/queue) */
  storage: Pick<StoragePort, 'flows' | 'runs' | 'queue'>;
  /** 事件总线 */
  events: Pick<EventsBus, 'append'>;
  /** 调度器 (可选) */
  scheduler?: Pick<RunScheduler, 'kick'>;
  /** RunId 生成器 (用于测试注入) */
  generateRunId?: () => RunId;
  /** 时间源 (用于测试注入) */
  now?: () => UnixMillis;
}

/**
 * 入队请求参数
 */
export interface EnqueueRunInput {
  /** Flow ID (必选) */
  flowId: FlowId;
  /** 起始节点 ID (可选，默认使用 Flow 的 entryNodeId) */
  startNodeId?: NodeId;
  /** 优先级 (默认 0) */
  priority?: number;
  /** 最大尝试次数 (默认 1) */
  maxAttempts?: number;
  /** 传递给 Flow 的参数 */
  args?: JsonObject;
  /** 触发上下文 (由 TriggerManager 设置) */
  trigger?: TriggerFireContext;
  /** 调试选项 */
  debug?: {
    breakpoints?: NodeId[];
    pauseOnStart?: boolean;
  };
}

/**
 * 入队结果
 */
export interface EnqueueRunResult {
  /** 新创建的 Run ID */
  runId: RunId;
  /** 在队列中的位置 (1-based) */
  position: number;
}

// ==================== Utilities ====================

/**
 * 默认 RunId 生成器
 */
function defaultGenerateRunId(): RunId {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 校验整数参数
 */
function validateInt(
  value: unknown,
  defaultValue: number,
  fieldName: string,
  opts?: { min?: number; max?: number },
): number {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a finite number`);
  }
  const intValue = Math.floor(value);
  if (opts?.min !== undefined && intValue < opts.min) {
    throw new Error(`${fieldName} must be >= ${opts.min}`);
  }
  if (opts?.max !== undefined && intValue > opts.max) {
    throw new Error(`${fieldName} must be <= ${opts.max}`);
  }
  return intValue;
}

/**
 * 计算 Run 在队列中的位置
 * @description 按调度顺序: priority DESC + createdAt ASC
 * @returns 1-based position, or -1 if run not found in queued items
 *
 * Note: Due to race conditions (scheduler may claim the run before this is called),
 * position may be -1. Callers should handle this gracefully.
 */
async function computeQueuePosition(
  storage: Pick<StoragePort, 'queue'>,
  runId: RunId,
): Promise<number> {
  const queueItems = await storage.queue.list('queued');
  queueItems.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.createdAt - b.createdAt;
  });
  const index = queueItems.findIndex((item) => item.id === runId);
  // Return -1 if not found (run may have been claimed already)
  return index === -1 ? -1 : index + 1;
}

// ==================== Main Function ====================

/**
 * 入队执行一个 Run
 * @description
 * 执行步骤：
 * 1. 参数校验
 * 2. 验证 Flow 存在
 * 3. 创建 RunRecordV3 (status=queued)
 * 4. 入队到 RunQueue
 * 5. 发布 run.queued 事件
 * 6. 触发调度 (best-effort)
 * 7. 计算队列位置
 */
export async function enqueueRun(
  deps: EnqueueRunDeps,
  input: EnqueueRunInput,
): Promise<EnqueueRunResult> {
  const { flowId } = input;
  if (!flowId) {
    throw new Error('flowId is required');
  }

  const now = deps.now ?? (() => Date.now());
  const generateRunId = deps.generateRunId ?? defaultGenerateRunId;

  // 参数校验
  const priority = validateInt(input.priority, 0, 'priority');
  const maxAttempts = validateInt(input.maxAttempts, 1, 'maxAttempts', { min: 1 });

  // 验证 Flow 存在
  const flow = await deps.storage.flows.get(flowId);
  if (!flow) {
    throw new Error(`Flow "${flowId}" not found`);
  }

  // 验证 startNodeId 存在于 Flow 中
  if (input.startNodeId) {
    const nodeExists = flow.nodes.some((n) => n.id === input.startNodeId);
    if (!nodeExists) {
      throw new Error(`startNodeId "${input.startNodeId}" not found in flow "${flowId}"`);
    }
  }

  const ts = now();
  const runId = generateRunId();

  // 1. 创建 RunRecordV3
  const runRecord: RunRecordV3 = {
    schemaVersion: RUN_SCHEMA_VERSION,
    id: runId,
    flowId,
    status: 'queued',
    createdAt: ts,
    updatedAt: ts,
    attempt: 0,
    maxAttempts,
    args: input.args,
    trigger: input.trigger,
    debug: input.debug,
    startNodeId: input.startNodeId,
    nextSeq: 0,
  };
  await deps.storage.runs.save(runRecord);

  // 2. 入队
  await deps.storage.queue.enqueue({
    id: runId,
    flowId,
    priority,
    maxAttempts,
    args: input.args,
    trigger: input.trigger,
    debug: input.debug,
  });

  // 3. 发布 run.queued 事件
  await deps.events.append({
    runId,
    type: 'run.queued',
    flowId,
  });

  // 4. 计算队列位置 (在 kick 之前计算，减少竞态条件导致 position=-1 的概率)
  const position = await computeQueuePosition(deps.storage, runId);

  // 5. 触发调度 (best-effort, 不阻塞返回)
  if (deps.scheduler) {
    void deps.scheduler.kick();
  }

  return { runId, position };
}
