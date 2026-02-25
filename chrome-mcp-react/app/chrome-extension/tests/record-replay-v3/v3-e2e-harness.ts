/**
 * @fileoverview Record-Replay V3 service-level E2E test harness
 * @description
 * Assembles a complete V3 runtime (IndexedDB storage + scheduler + runner)
 * and drives it through RpcServer.handleRequest() to avoid Port mocking complexity.
 *
 * Design notes:
 * - Service-level testing: calls internal handler directly, not through Port
 * - Event streaming: reuses RpcServer.broadcastEvent subscription filtering logic
 * - waitForTerminal: uses EventsBus subscription to wait for terminal events, avoiding kick() race
 *
 * WARNING: This harness accesses RpcServer private members (connections/handleRequest/broadcastEvent)
 * via type casting. If RpcServer changes to use ES private fields (#private), these tests will break.
 * All such access is centralized in getRpcServerInternals() for easier maintenance.
 */

import { vi } from 'vitest';
import { z } from 'zod';

import type { JsonObject } from '@/entrypoints/background/record-replay-v3/domain/json';
import type { RunId } from '@/entrypoints/background/record-replay-v3/domain/ids';
import type {
  RunEvent,
  RunRecordV3,
} from '@/entrypoints/background/record-replay-v3/domain/events';
import type {
  RunQueueConfig,
  RunQueueItem,
} from '@/entrypoints/background/record-replay-v3/engine/queue/queue';
import type { StoragePort } from '@/entrypoints/background/record-replay-v3/engine/storage/storage-port';
import type { EventsBus } from '@/entrypoints/background/record-replay-v3/engine/transport/events-bus';
import type {
  RunScheduler,
  RunExecutor,
} from '@/entrypoints/background/record-replay-v3/engine/queue/scheduler';
import type {
  NodeDefinition,
  NodeExecutionResult,
} from '@/entrypoints/background/record-replay-v3/engine/plugins/types';

import { createStoragePort, closeRrV3Db } from '@/entrypoints/background/record-replay-v3';

import { StorageBackedEventsBus } from '@/entrypoints/background/record-replay-v3/engine/transport/events-bus';
import { DEFAULT_QUEUE_CONFIG } from '@/entrypoints/background/record-replay-v3/engine/queue/queue';
import { createLeaseManager } from '@/entrypoints/background/record-replay-v3/engine/queue/leasing';
import { createRunScheduler } from '@/entrypoints/background/record-replay-v3/engine/queue/scheduler';
import { InMemoryKeepaliveController } from '@/entrypoints/background/record-replay-v3/engine/keepalive/offscreen-keepalive';
import { PluginRegistry } from '@/entrypoints/background/record-replay-v3/engine/plugins/registry';
import {
  createRunRunnerFactory,
  type RunRunnerFactory,
} from '@/entrypoints/background/record-replay-v3/engine/kernel/runner';
import {
  createRunnerRegistry,
  type RunnerRegistry,
} from '@/entrypoints/background/record-replay-v3/engine/kernel/debug-controller';
import { createNotImplementedArtifactService } from '@/entrypoints/background/record-replay-v3/engine/kernel/artifacts';
import { RpcServer } from '@/entrypoints/background/record-replay-v3/engine/transport/rpc-server';
import {
  RR_ERROR_CODES,
  createRRError,
} from '@/entrypoints/background/record-replay-v3/domain/errors';
import { isTerminalStatus } from '@/entrypoints/background/record-replay-v3/domain/events';

// ==================== Types ====================

type Logger = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

interface TestNodeConfig {
  action: 'succeed' | 'fail';
  outputs?: JsonObject;
  delayMs?: number;
}

/**
 * E2E Harness 配置选项
 */
export interface V3E2EHarnessOptions {
  /** Owner ID（标识调度器实例） */
  ownerId?: string;
  /** 调度器配置覆盖 */
  schedulerConfig?: Partial<RunQueueConfig>;
  /** 是否自动启动调度器（默认 true） */
  autoStartScheduler?: boolean;
  /** 时间源（用于测试注入） */
  now?: () => number;
  /** 日志器 */
  logger?: Logger;
}

/**
 * RPC 客户端接口
 */
export interface RpcClient {
  /** 收到的所有消息 */
  readonly messages: unknown[];
  /** 调用 RPC 方法 */
  call<T = unknown>(method: string, params?: JsonObject): Promise<T>;
  /** 清空消息 */
  clearMessages(): void;
  /** 获取流式推送的事件 */
  getStreamedEvents(): RunEvent[];
}

/**
 * E2E Harness 接口
 */
export interface V3E2EHarness {
  readonly ownerId: string;
  readonly storage: StoragePort;
  readonly events: EventsBus;
  readonly scheduler: RunScheduler;
  readonly runners: RunnerRegistry;
  readonly rpcServer: RpcServer;

  /** 创建 RPC 客户端 */
  createClient(): RpcClient;

  /** 等待特定事件 */
  waitForEvent(
    runId: RunId,
    predicate: (event: RunEvent) => boolean,
    opts?: { timeoutMs?: number },
  ): Promise<RunEvent>;

  /** 等待 Run 到达终态 */
  waitForTerminal(runId: RunId, opts?: { timeoutMs?: number }): Promise<RunRecordV3>;

  /** 等待队列项被移除 */
  waitForQueueItemGone(runId: RunId, opts?: { timeoutMs?: number }): Promise<void>;

  /** 列出 Run 的所有事件 */
  listEvents(runId: RunId): Promise<RunEvent[]>;

  /** 销毁 harness，释放资源 */
  dispose(): Promise<void>;
}

// ==================== RpcServer Test Internals ====================

/**
 * RpcServer internal access interface for testing.
 * Centralizes all private member access to make maintenance easier.
 */
interface RpcServerInternals {
  connections: Map<string, RpcConnection>;
  handleRequest<T>(req: unknown, conn: RpcConnection): Promise<T>;
  broadcastEvent(event: RunEvent): void;
}

interface RpcConnection {
  port: chrome.runtime.Port;
  subscriptions: Set<RunId | null>;
}

/**
 * Get RpcServer internals for testing.
 * WARNING: This accesses private members via type casting.
 */
function getRpcServerInternals(server: RpcServer): RpcServerInternals {
  const s = server as unknown as {
    connections: Map<string, RpcConnection>;
    handleRequest: <T>(req: unknown, conn: RpcConnection) => Promise<T>;
    broadcastEvent: (event: RunEvent) => void;
  };
  return {
    connections: s.connections,
    handleRequest: s.handleRequest.bind(s),
    broadcastEvent: s.broadcastEvent.bind(s),
  };
}

// ==================== Utilities ====================

function createSilentLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 创建测试用 Node 定义
 * @description 一个简单的测试节点，支持成功/失败/延迟
 */
function createTestNodeDefinition(): NodeDefinition<'test', TestNodeConfig> {
  return {
    kind: 'test',
    schema: z
      .object({
        action: z.enum(['succeed', 'fail']),
        outputs: z.record(z.any()).optional(),
        delayMs: z.number().optional(),
      })
      .passthrough() as z.ZodType<TestNodeConfig>,
    execute: async (_ctx, node): Promise<NodeExecutionResult> => {
      const cfg = node.config as unknown as TestNodeConfig;

      // 模拟延迟
      if (cfg.delayMs && cfg.delayMs > 0) {
        await sleep(cfg.delayMs);
      }

      if (cfg.action === 'fail') {
        return {
          status: 'failed',
          error: createRRError(RR_ERROR_CODES.TOOL_ERROR, 'Test node intentionally failed'),
        };
      }

      return {
        status: 'succeeded',
        ...(cfg.outputs ? { outputs: cfg.outputs } : {}),
      };
    },
  };
}

// ==================== Factory ====================

/**
 * 创建 V3 E2E 测试 harness
 * @description 组装完整的 V3 runtime 用于集成测试
 */
export function createV3E2EHarness(options: V3E2EHarnessOptions = {}): V3E2EHarness {
  const logger = options.logger ?? createSilentLogger();
  const now = options.now ?? (() => Date.now());
  const ownerId = options.ownerId ?? 'e2e-owner';

  // 1) Storage
  const storage = createStoragePort();

  // 2) EventsBus
  const events = new StorageBackedEventsBus(storage.events);

  // 3) Plugins - 注册测试节点
  const plugins = new PluginRegistry();
  plugins.registerNode(createTestNodeDefinition());

  // 4) RunnerRegistry
  const runners = createRunnerRegistry();

  // 5) RunRunnerFactory
  const runnerFactory = createRunRunnerFactory({
    storage,
    events,
    plugins,
    now,
    artifactService: createNotImplementedArtifactService(),
  });

  // 6) RunExecutor - 连接 scheduler 和 runner
  const execute: RunExecutor = createE2EExecutor({
    storage,
    events,
    runnerFactory,
    runners,
    now,
    logger,
  });

  // 7) Scheduler 配置
  const config: RunQueueConfig = {
    ...DEFAULT_QUEUE_CONFIG,
    maxParallelRuns: 1,
    ...options.schedulerConfig,
  };

  // 8) Keepalive + LeaseManager + Scheduler
  const keepalive = new InMemoryKeepaliveController();
  const leaseManager = createLeaseManager(storage.queue, config);

  const scheduler = createRunScheduler({
    queue: storage.queue,
    leaseManager,
    keepalive,
    config,
    ownerId,
    execute,
    now,
    tuning: { pollIntervalMs: 0, reclaimIntervalMs: 0 },
    logger,
  });

  // 9) RpcServer
  const rpcServer = new RpcServer({
    storage,
    events,
    scheduler,
    runners,
    now,
  });

  // Get internals via centralized helper
  const rpcInternals = getRpcServerInternals(rpcServer);

  // 10) Forward EventsBus events to RpcServer.broadcastEvent
  const unsubscribeForward = events.subscribe((event) => {
    try {
      rpcInternals.broadcastEvent(event);
    } catch (e) {
      logger.warn('[V3E2EHarness] broadcastEvent failed:', e);
    }
  });

  // 11) Start scheduler if configured
  if (options.autoStartScheduler ?? true) {
    scheduler.start();
  }

  // Client management
  let clientSeq = 0;
  let requestSeq = 0;
  const clientConnIds = new Set<string>();

  function createClient(): RpcClient {
    const connId = `e2e-conn-${++clientSeq}`;
    const messages: unknown[] = [];

    const port = {
      postMessage: (msg: unknown) => {
        messages.push(msg);
      },
      disconnect: vi.fn(),
    } as unknown as chrome.runtime.Port;

    const connection: RpcConnection = {
      port,
      subscriptions: new Set<RunId | null>(),
    };

    // Inject into RpcServer internals so broadcastEvent() can push to this client
    rpcInternals.connections.set(connId, connection);
    clientConnIds.add(connId);

    return {
      messages,
      call: async <T>(method: string, params?: JsonObject): Promise<T> => {
        const req = {
          type: 'rr_v3.request' as const,
          requestId: `e2e-req-${++requestSeq}`,
          method,
          ...(params ? { params } : {}),
        };
        return rpcInternals.handleRequest<T>(req, connection);
      },
      clearMessages: () => {
        messages.splice(0, messages.length);
      },
      getStreamedEvents: () => {
        return messages
          .filter(
            (m): m is { type: 'rr_v3.event'; event: RunEvent } =>
              typeof m === 'object' &&
              m !== null &&
              (m as { type?: string }).type === 'rr_v3.event',
          )
          .map((m) => m.event);
      },
    };
  }

  async function waitForEvent(
    runId: RunId,
    predicate: (event: RunEvent) => boolean,
    opts?: { timeoutMs?: number },
  ): Promise<RunEvent> {
    const timeoutMs = opts?.timeoutMs ?? 5_000;

    // Fast-path: 检查已持久化的事件
    try {
      const existing = await storage.events.list(runId);
      const found = existing.find(predicate);
      if (found) return found;
    } catch {
      // ignore and fall back to subscription
    }

    return new Promise<RunEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for event (runId=${runId})`));
      }, timeoutMs);

      const unsubscribe = events.subscribe(
        (event) => {
          if (!predicate(event)) return;
          clearTimeout(timer);
          unsubscribe();
          resolve(event);
        },
        { runId },
      );
    });
  }

  async function waitForTerminal(
    runId: RunId,
    opts?: { timeoutMs?: number },
  ): Promise<RunRecordV3> {
    const timeoutMs = opts?.timeoutMs ?? 10_000;

    // 先检查当前状态
    const initial = await storage.runs.get(runId);
    if (!initial) {
      throw new Error(`Run "${runId}" not found`);
    }
    if (isTerminalStatus(initial.status)) {
      return initial;
    }

    // 等待终态事件
    await waitForEvent(
      runId,
      (e) => e.type === 'run.succeeded' || e.type === 'run.failed' || e.type === 'run.canceled',
      { timeoutMs },
    );

    const done = await storage.runs.get(runId);
    if (!done) {
      throw new Error(`Run "${runId}" not found after terminal event`);
    }
    return done;
  }

  async function waitForQueueItemGone(runId: RunId, opts?: { timeoutMs?: number }): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? 5_000;
    const startedAt = Date.now();

    for (;;) {
      const item = await storage.queue.get(runId);
      if (!item) return;

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          `Timed out waiting for queue item to be removed (runId=${runId}, status=${item.status})`,
        );
      }

      await sleep(10);
    }
  }

  async function listEvents(runId: RunId): Promise<RunEvent[]> {
    return storage.events.list(runId);
  }

  async function dispose(): Promise<void> {
    // 取消事件转发
    try {
      unsubscribeForward();
    } catch {
      // ignore
    }

    // 停止 scheduler
    try {
      scheduler.dispose();
    } catch {
      // ignore
    }

    // 释放 lease manager
    try {
      leaseManager.dispose();
    } catch {
      // ignore
    }

    // Remove injected client connections
    for (const connId of clientConnIds) {
      rpcInternals.connections.delete(connId);
    }
    clientConnIds.clear();

    // 关闭 IDB 连接
    closeRrV3Db();
  }

  return {
    ownerId,
    storage,
    events,
    scheduler,
    runners,
    rpcServer,
    createClient,
    waitForEvent,
    waitForTerminal,
    waitForQueueItemGone,
    listEvents,
    dispose,
  };
}

// ==================== Internal Helpers ====================

/**
 * 创建 E2E 测试用的 RunExecutor
 */
function createE2EExecutor(deps: {
  storage: StoragePort;
  events: EventsBus;
  runnerFactory: RunRunnerFactory;
  runners: RunnerRegistry;
  now: () => number;
  logger: Logger;
}): RunExecutor {
  return async (item: RunQueueItem): Promise<void> => {
    const runId = item.id;

    // 1. 获取 RunRecord
    const run = await deps.storage.runs.get(runId);
    if (!run) {
      deps.logger.warn(`[E2E] RunRecord not found for queue item "${runId}", skipping`);
      return;
    }

    // 2. 获取 Flow
    const flow = await deps.storage.flows.get(item.flowId);
    if (!flow) {
      await failRun(deps, runId, `Flow "${item.flowId}" not found`);
      return;
    }

    // 3. 同步 attempt/tabId 到 RunRecord
    const tabId = item.tabId ?? run.tabId ?? 1;
    try {
      await deps.storage.runs.patch(runId, {
        attempt: item.attempt,
        maxAttempts: item.maxAttempts,
        tabId,
      });
    } catch {
      // ignore
    }

    // 4. 创建并运行 Runner
    const runner = deps.runnerFactory.create(runId, {
      flow,
      tabId,
      args: item.args ?? run.args,
      startNodeId: run.startNodeId,
      debug: item.debug ?? run.debug,
    });

    deps.runners.register(runId, runner);
    try {
      await runner.start();
    } finally {
      deps.runners.unregister(runId);
    }
  };
}

/**
 * 将 Run 标记为失败
 */
async function failRun(
  deps: { storage: StoragePort; events: EventsBus; now: () => number },
  runId: RunId,
  message: string,
): Promise<void> {
  const t = deps.now();
  const error = createRRError(RR_ERROR_CODES.VALIDATION_ERROR, message);

  await deps.storage.runs.patch(runId, {
    status: 'failed',
    finishedAt: t,
    tookMs: 0,
    error,
  });

  await deps.events.append({
    runId,
    type: 'run.failed',
    error,
  });
}
