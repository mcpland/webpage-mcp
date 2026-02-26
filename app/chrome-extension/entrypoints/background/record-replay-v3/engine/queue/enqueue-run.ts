/**
 * @fileoverview Shared queuing service
 * @description
 * Provides unified Run enqueuing logic shared by RPC Server and TriggerManager.
 *
 * Design reasons:
 * - Extract the enqueuing logic originally located in RpcServer into an independent service
 * - Avoid behavioral drift between RPC and TriggerManager
 * - Unified parameter verification, run creation, queue enqueuing, and event release process
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
 * Enqueuing service dependencies
 */
export interface EnqueueRunDeps {
  /** Storage layer (only flows/runs/queue) */
  storage: Pick<StoragePort, 'flows' | 'runs' | 'queue'>;
  /** event bus */
  events: Pick<EventsBus, 'append'>;
  /** Scheduler (optional) */
  scheduler?: Pick<RunScheduler, 'kick'>;
  /** RunId Generator (for test injection) */
  generateRunId?: () => RunId;
  /** Time source (for test injection) */
  now?: () => UnixMillis;
}

/**
 * Enqueue request parameters
 */
export interface EnqueueRunInput {
  /** Flow ID (Required) */
  flowId: FlowId;
  /** Starting node ID (optional, Flow’s entryNodeId is used by default) */
  startNodeId?: NodeId;
  /** priority (default 0) */
  priority?: number;
  /** Maximum number of attempts (default 1) */
  maxAttempts?: number;
  /** Parameters passed to Flow */
  args?: JsonObject;
  /** Trigger context (set by TriggerManager) */
  trigger?: TriggerFireContext;
  /** Debugging options */
  debug?: {
    breakpoints?: NodeId[];
    pauseOnStart?: boolean;
  };
}

/**
 * Joining the team results
 */
export interface EnqueueRunResult {
  /** Newly created Run ID */
  runId: RunId;
  /** position in queue (1-based) */
  position: number;
}

// ==================== Utilities ====================

/**
 * Default RunId generator
 */
function defaultGenerateRunId(): RunId {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Check integer parameters
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
 * Calculate Run's position in the queue
 * @description In scheduling order: priority DESC + createdAt ASC
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
 * Enqueue a Run
 * @description
 * Execution steps:
 * 1. Parameter verification
 * 2. Verify Flow exists
 * 3. Create RunRecordV3 (status=queued)
 * 4. Enqueue to RunQueue
 * 5. Post the run.queued event
 * 6. Trigger scheduling (best-effort)
 * 7. Calculate queue position
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

  // Parameter verification
  const priority = validateInt(input.priority, 0, 'priority');
  const maxAttempts = validateInt(input.maxAttempts, 1, 'maxAttempts', { min: 1 });

  // Verify Flow exists
  const flow = await deps.storage.flows.get(flowId);
  if (!flow) {
    throw new Error(`Flow "${flowId}" not found`);
  }

  // Verify startNodeId exists in Flow
  if (input.startNodeId) {
    const nodeExists = flow.nodes.some((n) => n.id === input.startNodeId);
    if (!nodeExists) {
      throw new Error(`startNodeId "${input.startNodeId}" not found in flow "${flowId}"`);
    }
  }

  const ts = now();
  const runId = generateRunId();

  // 1. Create RunRecordV3
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

  // 2. Join the team
  await deps.storage.queue.enqueue({
    id: runId,
    flowId,
    priority,
    maxAttempts,
    args: input.args,
    trigger: input.trigger,
    debug: input.debug,
  });

  // 3. Post the run.queued event
  await deps.events.append({
    runId,
    type: 'run.queued',
    flowId,
  });

  // 4. Calculate the queue position (calculated before kick to reduce the probability of position=-1 caused by race conditions)
  const position = await computeQueuePosition(deps.storage, runId);

  // 5. Trigger scheduling (best-effort, non-blocking return)
  if (deps.scheduler) {
    void deps.scheduler.kick();
  }

  return { runId, position };
}
