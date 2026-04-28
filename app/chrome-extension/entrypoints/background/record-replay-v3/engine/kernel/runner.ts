/**
 * @fileoverview RunRunner Interface and implementation
 * @description Define and implement a sequential executor for a single Run
 */

import type { NodeId, RunId } from '../../domain/ids';
import { EDGE_LABELS } from '../../domain/ids';
import type { FlowV3, NodeV3 } from '../../domain/flow';
import { findNodeById } from '../../domain/flow';
import type {
  PauseReason,
  RunEvent,
  RunEventInput,
  RunRecordV3,
  Unsubscribe,
} from '../../domain/events';
import { RUN_SCHEMA_VERSION } from '../../domain/events';
import type { JsonObject, JsonValue } from '../../domain/json';
import { RR_ERROR_CODES, createRRError, type RRError } from '../../domain/errors';
import type { NodePolicy, RetryPolicy } from '../../domain/policy';
import { mergeNodePolicy } from '../../domain/policy';
import {
  normalizeWorkflowNodeSideEffectProfile,
  workflowSideEffectAllowsRetry,
  type WorkflowRetrySource,
} from 'webpage-mcp-shared';

import type { EventsBus } from '../transport/events-bus';
import type { StoragePort } from '../storage/storage-port';
import type { PluginRegistry } from '../plugins/registry';
import { getPluginRegistry } from '../plugins/registry';
import type { NodeExecutionContext, NodeExecutionResult, VarsPatchOp } from '../plugins/types';

import type { ArtifactService } from './artifacts';
import { createNotImplementedArtifactService } from './artifacts';
import { getBreakpointRegistry, type BreakpointManager } from './breakpoints';
import { findEdgeByLabel, findNextNode, validateFlowDAG } from './traversal';
import type { RunResult } from './kernel';

// ==================== Types ====================

const RUNTIME_TAB_ID_VAR = '__rr_runtime__tabId';

/**
 * RunRunner runtime status
 */
export interface RunnerRuntimeState {
  /** Run ID */
  runId: RunId;
  /** Current node ID */
  currentNodeId: NodeId | null;
  /** Current attempts */
  attempt: number;
  /** variable table */
  vars: Record<string, JsonValue>;
  /** Whether to pause */
  paused: boolean;
  /** Cancel or not */
  canceled: boolean;
}

/**
 * RunRunner Configuration
 */
export interface RunnerConfig {
  /** Flow Snapshot */
  flow: FlowV3;
  /** Tab ID */
  tabId: number;
  /** initial parameters */
  args?: JsonObject;
  /** Run-scoped execution restrictions forwarded to handlers */
  execution?: RunRecordV3['execution'];
  /** Start node ID */
  startNodeId?: NodeId;
  /** Debug configuration */
  debug?: { breakpoints?: NodeId[]; pauseOnStart?: boolean };
}

/**
 * RunRunner interface
 */
export interface RunRunner {
  /** Run ID */
  readonly runId: RunId;
  /** Current status */
  readonly state: RunnerRuntimeState;
  /** Subscribe to events */
  onEvent(listener: (event: RunEvent) => void): Unsubscribe;
  /** Start execution */
  start(): Promise<RunResult>;
  /** Suspend execution */
  pause(): void;
  /** Resume execution */
  resume(): void;
  /** Cancel execution */
  cancel(reason?: string): void;
  /** Get variable value */
  getVar(name: string): JsonValue | undefined;
  /** Set variable value */
  setVar(name: string, value: JsonValue): void;
}

/**
 * RunRunner Factory interface
 */
export interface RunRunnerFactory {
  create(runId: RunId, config: RunnerConfig): RunRunner;
}

/**
 * RunRunner factory dependency
 */
export interface RunRunnerFactoryDeps {
  storage: StoragePort;
  events: EventsBus;
  plugins?: PluginRegistry;
  artifactService?: ArtifactService;
  now?: () => number;
}

// ==================== Helpers ====================

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err)
    return String((err as { message: unknown }).message);
  return String(err);
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number | undefined,
  onTimeout: () => RRError,
): Promise<T> {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    return p;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function computeRetryDelayMs(policy: RetryPolicy, attempt: number): number {
  const base = Math.max(0, policy.intervalMs);
  let delay = base;
  const backoff = policy.backoff ?? 'none';

  if (backoff === 'linear') {
    delay = base * attempt;
  } else if (backoff === 'exp') {
    delay = base * Math.pow(2, Math.max(0, attempt - 1));
  }

  if (policy.maxIntervalMs !== undefined) {
    delay = Math.min(delay, Math.max(0, policy.maxIntervalMs));
  }

  if (policy.jitter === 'full') {
    delay = Math.floor(Math.random() * (delay + 1));
  }

  return Math.max(0, Math.floor(delay));
}

function applyVarsPatch(vars: Record<string, JsonValue>, patch: VarsPatchOp[]): void {
  for (const op of patch) {
    if (op.op === 'set') {
      vars[op.name] = op.value ?? null;
    } else {
      delete vars[op.name];
    }
  }
}

function readRuntimeTabId(vars: Record<string, JsonValue>): number | undefined {
  const value = vars[RUNTIME_TAB_ID_VAR];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function toRRError(err: unknown, fallback: { code: string; message: string }): RRError {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    return err as RRError;
  }
  return createRRError(
    fallback.code as RRError['code'],
    `${fallback.message}: ${errorMessage(err)}`,
  );
}

/**
 * Serial queue for write operations
 * Ensures event ordering and reduces write races
 */
class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

// ==================== Factory ====================

/**
 * Create NotImplemented RunRunnerFactory
 */
export function createNotImplementedRunnerFactory(): RunRunnerFactory {
  return {
    create: () => {
      throw new Error('RunRunnerFactory not implemented');
    },
  };
}

/**
 * Create a RunRunner factory
 */
export function createRunRunnerFactory(deps: RunRunnerFactoryDeps): RunRunnerFactory {
  const plugins = deps.plugins ?? getPluginRegistry();
  const artifactService = deps.artifactService ?? createNotImplementedArtifactService();
  const now = deps.now ?? Date.now;

  return {
    create: (runId, config) =>
      new StorageBackedRunRunner(runId, config, {
        storage: deps.storage,
        events: deps.events,
        plugins,
        artifactService,
        now,
      }),
  };
}

// ==================== Implementation ====================

interface RunnerEnv {
  storage: StoragePort;
  events: EventsBus;
  plugins: PluginRegistry;
  artifactService: ArtifactService;
  now: () => number;
}

type OnErrorDecision =
  | { kind: 'stop' }
  | { kind: 'continue' }
  | {
      kind: 'goto';
      target: { kind: 'edgeLabel'; label: string } | { kind: 'node'; nodeId: NodeId };
    }
  | { kind: 'retry'; retryPolicy: RetryPolicy | null };

type NodeRunResult =
  | { nextNodeId: NodeId | null }
  | { terminal: 'failed'; error: RRError }
  | { terminal: 'canceled' };

/**
 * Storage-backed RunRunner implementation
 */
class StorageBackedRunRunner implements RunRunner {
  readonly runId: RunId;
  readonly state: RunnerRuntimeState;

  private readonly config: RunnerConfig;
  private readonly env: RunnerEnv;
  private readonly queue = new SerialQueue();
  private readonly breakpoints: BreakpointManager;

  private startPromise: Promise<RunResult> | null = null;
  private outputs: JsonObject = {};
  private cancelReason: string | undefined;
  private pauseWaiter: Deferred<void> | null = null;

  constructor(runId: RunId, config: RunnerConfig, env: RunnerEnv) {
    this.runId = runId;
    this.config = config;
    this.env = env;

    this.state = {
      runId,
      currentNodeId: null,
      attempt: 0,
      vars: this.buildInitialVars(),
      paused: false,
      canceled: false,
    };

    this.breakpoints = getBreakpointRegistry().getOrCreate(runId, config.debug?.breakpoints);
  }

  onEvent(listener: (event: RunEvent) => void): Unsubscribe {
    return this.env.events.subscribe(listener, { runId: this.runId });
  }

  start(): Promise<RunResult> {
    if (!this.startPromise) {
      this.startPromise = this.run();
    }
    return this.startPromise;
  }

  pause(): void {
    this.requestPause({ kind: 'command' });
  }

  resume(): void {
    if (!this.state.paused) return;
    this.state.paused = false;
    this.pauseWaiter?.resolve(undefined);
    this.pauseWaiter = null;

    void this.queue
      .run(async () => {
        await this.env.storage.runs.patch(this.runId, { status: 'running' });
        await this.env.events.append({ runId: this.runId, type: 'run.resumed' } as RunEventInput);
      })
      .catch((e) => {
        console.error('[RunRunner] resume persistence failed:', e);
      });
  }

  cancel(reason?: string): void {
    if (this.state.canceled) return;
    this.state.canceled = true;
    this.cancelReason = reason;

    if (this.state.paused) {
      this.state.paused = false;
      this.pauseWaiter?.resolve(undefined);
      this.pauseWaiter = null;
    }
  }

  getVar(name: string): JsonValue | undefined {
    return this.state.vars[name];
  }

  setVar(name: string, value: JsonValue): void {
    this.state.vars[name] = value;

    // Best-effort: emit vars.patch event
    void this.queue
      .run(() =>
        this.env.events.append({
          runId: this.runId,
          type: 'vars.patch',
          patch: [{ op: 'set', name, value }],
        } as RunEventInput),
      )
      .catch(() => {});
  }

  // ==================== Private Methods ====================

  private buildInitialVars(): Record<string, JsonValue> {
    const vars: Record<string, JsonValue> = { ...(this.config.args ?? {}) };
    for (const def of this.config.flow.variables ?? []) {
      if (vars[def.name] === undefined && def.default !== undefined) {
        vars[def.name] = def.default;
      }
    }
    return vars;
  }

  private requestPause(reason: PauseReason): void {
    if (this.state.canceled) return;
    if (this.state.paused) return;

    this.state.paused = true;
    if (!this.pauseWaiter) {
      this.pauseWaiter = createDeferred<void>();
    }

    const nodeId = this.state.currentNodeId ?? undefined;
    void this.queue
      .run(async () => {
        await this.env.storage.runs.patch(this.runId, {
          status: 'paused',
          ...(nodeId ? { currentNodeId: nodeId } : {}),
        });
        await this.env.events.append({
          runId: this.runId,
          type: 'run.paused',
          reason,
          ...(nodeId ? { nodeId } : {}),
        } as RunEventInput);
      })
      .catch((e) => {
        console.error('[RunRunner] pause persistence failed:', e);
      });
  }

  private async waitIfPaused(): Promise<void> {
    while (this.state.paused && !this.state.canceled) {
      if (!this.pauseWaiter) {
        this.pauseWaiter = createDeferred<void>();
      }
      await this.pauseWaiter.promise;
    }
  }

  private async ensureRunRecord(startNodeId: NodeId, startedAt: number): Promise<void> {
    await this.queue.run(async () => {
      const existing = await this.env.storage.runs.get(this.runId);
      if (!existing) {
        const record: RunRecordV3 = {
          schemaVersion: RUN_SCHEMA_VERSION,
          id: this.runId,
          flowId: this.config.flow.id,
          status: 'running',
          createdAt: startedAt,
          updatedAt: startedAt,
          startedAt,
          tabId: this.config.tabId,
          startNodeId: this.config.startNodeId,
          currentNodeId: startNodeId,
          attempt: 0,
          maxAttempts: 1,
          args: this.config.args,
          debug: this.config.debug,
          execution: this.config.execution,
          nextSeq: 1,
        };
        await this.env.storage.runs.save(record);
        return;
      }

      if (!Number.isSafeInteger(existing.nextSeq) || existing.nextSeq < 0) {
        throw createRRError(
          RR_ERROR_CODES.INVARIANT_VIOLATION,
          `Invalid nextSeq for run "${this.runId}": ${String(existing.nextSeq)}`,
        );
      }

      const patch: Partial<RunRecordV3> = {
        status: 'running',
        tabId: this.config.tabId,
        currentNodeId: startNodeId,
      };
      if (existing.startedAt === undefined) patch.startedAt = startedAt;
      if (this.config.startNodeId !== undefined) patch.startNodeId = this.config.startNodeId;
      if (this.config.args !== undefined) patch.args = this.config.args;
      if (this.config.debug !== undefined) patch.debug = this.config.debug;
      if (this.config.execution !== undefined) patch.execution = this.config.execution;
      await this.env.storage.runs.patch(this.runId, patch);
    });
  }

  private async run(): Promise<RunResult> {
    const startedAt = this.env.now();
    const { flow } = this.config;

    const startNodeId = (this.config.startNodeId ?? flow.entryNodeId) as NodeId;

    // Ensure Run record exists FIRST (before DAG validation)
    // so that finishFailed can safely patch the record
    await this.ensureRunRecord(startNodeId, startedAt);

    // Validate DAG
    const validation = validateFlowDAG(flow);
    if (!validation.ok) {
      const error =
        validation.errors[0] ?? createRRError(RR_ERROR_CODES.DAG_INVALID, 'Invalid DAG');
      return this.finishFailed(startedAt, error, undefined);
    }

    if (this.state.canceled) {
      return this.finishCanceled(startedAt);
    }

    // Emit run.started
    await this.queue.run(() =>
      this.env.events.append({
        runId: this.runId,
        type: 'run.started',
        flowId: flow.id,
        tabId: this.config.tabId,
      } as RunEventInput),
    );

    // Handle pauseOnStart
    if (this.config.debug?.pauseOnStart) {
      this.requestPause({ kind: 'policy', nodeId: startNodeId, reason: 'pauseOnStart' });
    }

    // Main execution loop
    let currentNodeId: NodeId | null = startNodeId;
    while (currentNodeId) {
      this.state.currentNodeId = currentNodeId;

      // Only update currentNodeId, not status (to preserve paused state)
      const nodeIdToUpdate = currentNodeId; // Capture for closure
      await this.queue.run(() =>
        this.env.storage.runs.patch(this.runId, { currentNodeId: nodeIdToUpdate }),
      );

      if (this.state.canceled) break;
      await this.waitIfPaused();
      if (this.state.canceled) break;

      const node = findNodeById(flow, currentNodeId);
      if (!node) {
        const error = createRRError(
          RR_ERROR_CODES.DAG_INVALID,
          `Node "${currentNodeId}" not found in flow`,
        );
        return this.finishFailed(startedAt, error, currentNodeId);
      }

      // Skip disabled nodes
      if (node.disabled) {
        await this.queue.run(() =>
          this.env.events.append({
            runId: this.runId,
            type: 'node.skipped',
            nodeId: node.id,
            reason: 'disabled',
          } as RunEventInput),
        );
        currentNodeId = findNextNode(flow, node.id);
        continue;
      }

      // Check breakpoints
      if (this.breakpoints.shouldPauseAt(node.id)) {
        const reason: PauseReason =
          this.breakpoints.getStepMode() === 'stepOver'
            ? { kind: 'step', nodeId: node.id }
            : { kind: 'breakpoint', nodeId: node.id };

        // Clear step mode after hitting (to avoid infinite pause loop)
        if (this.breakpoints.getStepMode() === 'stepOver') {
          this.breakpoints.setStepMode('none');
        }

        this.requestPause(reason);
        await this.waitIfPaused();
        // After resume, proceed to execute the node (don't continue loop)
      }

      // Emit node.queued
      await this.queue.run(() =>
        this.env.events.append({
          runId: this.runId,
          type: 'node.queued',
          nodeId: node.id,
        } as RunEventInput),
      );

      // Execute node
      const nodeStartAt = this.env.now();
      const next = await this.runNode(flow, node, nodeStartAt);
      if ('terminal' in next) {
        if (next.terminal === 'canceled') break;
        if (next.terminal === 'failed') {
          return this.finishFailed(startedAt, next.error, node.id);
        }
        break;
      }

      currentNodeId = next.nextNodeId;
    }

    if (this.state.canceled) {
      return this.finishCanceled(startedAt);
    }

    return this.finishSucceeded(startedAt);
  }

  private async runNode(flow: FlowV3, node: NodeV3, nodeStartAt: number): Promise<NodeRunResult> {
    let attempt = 1;

    for (;;) {
      if (this.state.canceled) return { terminal: 'canceled' };
      await this.waitIfPaused();
      if (this.state.canceled) return { terminal: 'canceled' };

      this.state.attempt = attempt;

      // Emit node.started
      await this.queue.run(() =>
        this.env.events.append({
          runId: this.runId,
          type: 'node.started',
          nodeId: node.id,
          attempt,
        } as RunEventInput),
      );

      const exec = await this.executeNodeAttempt(flow, node);
      const policy = this.resolveNodePolicy(flow, node);
      if (exec.status === 'succeeded') {
        const tookMs = this.env.now() - nodeStartAt;

        // Apply vars patch
        if (exec.varsPatch && exec.varsPatch.length > 0) {
          applyVarsPatch(this.state.vars, exec.varsPatch);
          await this.queue.run(() =>
            this.env.events.append({
              runId: this.runId,
              type: 'vars.patch',
              patch: exec.varsPatch,
            } as RunEventInput),
          );
        }

        // Merge outputs
        if (exec.outputs) {
          this.outputs = { ...this.outputs, ...exec.outputs };
        }

        await this.captureNodeArtifact(node, policy, false);

        // Emit node.succeeded
        await this.queue.run(() =>
          this.env.events.append({
            runId: this.runId,
            type: 'node.succeeded',
            nodeId: node.id,
            tookMs,
            ...(exec.next ? { next: exec.next } : {}),
          } as RunEventInput),
        );

        if (exec.next?.kind === 'end') {
          return { nextNodeId: null };
        }

        const label = exec.next?.kind === 'edgeLabel' ? exec.next.label : undefined;
        return { nextNodeId: findNextNode(flow, node.id, label) };
      }

      // Handle failure
      const error = exec.error;
      const decision = this.decideOnError(flow, node, policy, error);

      // Emit node.failed
      await this.queue.run(() =>
        this.env.events.append({
          runId: this.runId,
          type: 'node.failed',
          nodeId: node.id,
          attempt,
          error,
          decision: decision.kind,
        } as RunEventInput),
      );

      await this.captureNodeArtifact(node, policy, true);

      if (decision.kind === 'retry' && decision.retryPolicy) {
        const maxAttempts = 1 + Math.max(0, decision.retryPolicy.retries);
        const canRetry =
          attempt < maxAttempts &&
          (decision.retryPolicy.retryOn
            ? decision.retryPolicy.retryOn.includes(
                error.code as (typeof decision.retryPolicy.retryOn)[number],
              )
            : true);

        if (!canRetry) {
          return { terminal: 'failed', error };
        }

        const delay = computeRetryDelayMs(decision.retryPolicy, attempt);
        if (delay > 0) {
          await sleep(delay);
        }
        attempt++;
        continue;
      }

      if (decision.kind === 'continue') {
        return { nextNodeId: findNextNode(flow, node.id) };
      }

      if (decision.kind === 'goto') {
        if (decision.target.kind === 'node') {
          return { nextNodeId: decision.target.nodeId };
        }
        return { nextNodeId: findNextNode(flow, node.id, decision.target.label) };
      }

      return { terminal: 'failed', error };
    }
  }

  private async captureNodeArtifact(
    node: NodeV3,
    policy: NodePolicy,
    failed: boolean,
  ): Promise<void> {
    const artifactPolicy = policy.artifacts;
    const screenshotPolicy = artifactPolicy?.screenshot ?? 'never';
    const shouldCapture =
      screenshotPolicy === 'always' || (screenshotPolicy === 'onFailure' && failed);
    if (!shouldCapture) {
      return;
    }

    const result = await this.captureScreenshotForCurrentTab(node);
    if (!result.ok) {
      await this.queue.run(() =>
        this.env.events.append({
          runId: this.runId,
          type: 'log',
          level: 'warn',
          message: `Failed to capture screenshot artifact for node "${node.id}": ${result.error.message}`,
        } as RunEventInput),
      );
      return;
    }

    const saveResult = await this.env.artifactService.saveScreenshot(
      this.runId,
      node.id,
      result.base64,
      artifactPolicy?.saveScreenshotAs,
    );
    if (!saveResult || 'error' in saveResult) {
      const message =
        saveResult && 'error' in saveResult
          ? saveResult.error.message
          : 'ArtifactService.saveScreenshot returned no result';
      await this.queue.run(() =>
        this.env.events.append({
          runId: this.runId,
          type: 'log',
          level: 'warn',
          message: `Failed to save screenshot artifact for node "${node.id}": ${message}`,
        } as RunEventInput),
      );
      return;
    }

    await this.queue.run(() =>
      this.env.events.append({
        runId: this.runId,
        type: 'artifact.screenshot',
        nodeId: node.id,
        ...(saveResult.artifactId ? { artifactId: saveResult.artifactId } : {}),
        ...(saveResult.savedAs ? { savedAs: saveResult.savedAs } : {}),
      } as RunEventInput),
    );
  }

  private getCurrentTabId(): number {
    return readRuntimeTabId(this.state.vars) ?? this.config.tabId;
  }

  private nodePrefersBackgroundScreenshot(node: NodeV3): boolean {
    return node.config.background === true;
  }

  private async shouldCaptureInBackground(tabId: number, node: NodeV3): Promise<boolean> {
    if (
      this.config.execution?.backgroundTabs === true ||
      this.nodePrefersBackgroundScreenshot(node)
    ) {
      return true;
    }

    if (typeof chrome === 'undefined' || !chrome.tabs?.get) {
      return false;
    }

    try {
      const tab = await chrome.tabs.get(tabId);
      return tab?.active === false;
    } catch {
      return false;
    }
  }

  private async captureScreenshotForCurrentTab(node: NodeV3) {
    const tabId = this.getCurrentTabId();
    return this.env.artifactService.screenshot(tabId, {
      background: await this.shouldCaptureInBackground(tabId, node),
    });
  }

  private resolveNodePolicy(flow: FlowV3, node: NodeV3): NodePolicy {
    const def = this.env.plugins.getNode(node.kind);
    const flowDefault = flow.policy?.defaultNodePolicy;
    const pluginDefault = def?.defaultPolicy;
    const merged1 = mergeNodePolicy(flowDefault, pluginDefault);
    const merged = mergeNodePolicy(merged1, node.policy);
    const retrySource = this.resolveRetrySource(flowDefault, pluginDefault, node.policy);
    return this.applySideEffectRetryGuard(node, merged, retrySource);
  }

  private resolveRetrySource(
    flowDefault: NodePolicy | undefined,
    pluginDefault: NodePolicy | undefined,
    nodePolicy: NodePolicy | undefined,
  ): WorkflowRetrySource | undefined {
    if (nodePolicy?.retry || nodePolicy?.onError?.kind === 'retry') return 'node';
    if (pluginDefault?.retry || pluginDefault?.onError?.kind === 'retry') return 'pluginDefault';
    if (flowDefault?.retry || flowDefault?.onError?.kind === 'retry') return 'flowDefault';
    return undefined;
  }

  private applySideEffectRetryGuard(
    node: NodeV3,
    policy: NodePolicy,
    retrySource: WorkflowRetrySource | undefined,
  ): NodePolicy {
    if (!retrySource || (!policy.retry && policy.onError?.kind !== 'retry')) {
      return policy;
    }

    const profile = normalizeWorkflowNodeSideEffectProfile(
      node.kind,
      node.config,
      node.sideEffect,
    );
    if (workflowSideEffectAllowsRetry(profile, retrySource)) {
      return policy;
    }

    const guarded: NodePolicy = { ...policy };
    if (guarded.retry) {
      delete guarded.retry;
    }
    if (guarded.onError?.kind === 'retry') {
      guarded.onError = { kind: 'stop' };
    }
    return guarded;
  }

  private decideOnError(
    flow: FlowV3,
    node: NodeV3,
    policy: NodePolicy,
    _error: RRError,
  ): OnErrorDecision {
    const configured = policy.onError;

    // Default: if there's an ON_ERROR edge, use it
    if (!configured) {
      const onErrorEdge = findEdgeByLabel(flow, node.id, EDGE_LABELS.ON_ERROR);
      if (onErrorEdge) {
        return { kind: 'goto', target: { kind: 'edgeLabel', label: EDGE_LABELS.ON_ERROR } };
      }
      if (policy.retry) {
        return { kind: 'retry', retryPolicy: policy.retry };
      }
      return { kind: 'stop' };
    }

    if (configured.kind === 'stop') return { kind: 'stop' };
    if (configured.kind === 'continue') return { kind: 'continue' };
    if (configured.kind === 'goto') {
      return {
        kind: 'goto',
        target: configured.target as
          | { kind: 'edgeLabel'; label: string }
          | { kind: 'node'; nodeId: NodeId },
      };
    }

    // retry
    const base: RetryPolicy = policy.retry ?? { retries: 1, intervalMs: 0 };
    const retryPolicy: RetryPolicy = configured.override
      ? { ...base, ...configured.override }
      : base;
    return { kind: 'retry', retryPolicy };
  }

  private async executeNodeAttempt(flow: FlowV3, node: NodeV3): Promise<NodeExecutionResult> {
    const def = this.env.plugins.getNode(node.kind);
    if (!def) {
      return {
        status: 'failed',
        error: createRRError(
          RR_ERROR_CODES.UNSUPPORTED_NODE,
          `Node kind "${node.kind}" is not registered`,
        ),
      };
    }

    let parsedConfig: unknown = node.config;
    try {
      parsedConfig = def.schema.parse(node.config);
    } catch (e) {
      return {
        status: 'failed',
        error: createRRError(
          RR_ERROR_CODES.VALIDATION_ERROR,
          `Invalid node config: ${errorMessage(e)}`,
        ),
      };
    }

    const ctx: NodeExecutionContext = {
      runId: this.runId,
      flow,
      nodeId: node.id,
      tabId: this.config.tabId,
      vars: this.state.vars,
      execution: this.config.execution,
      log: (level, message, data) => {
        void this.queue
          .run(() =>
            this.env.events.append({
              runId: this.runId,
              type: 'log',
              level,
              message,
              ...(data !== undefined ? { data } : {}),
            } as RunEventInput),
          )
          .catch(() => {});
      },
      chooseNext: (label) => ({ kind: 'edgeLabel', label }),
      artifacts: {
        screenshot: () => this.captureScreenshotForCurrentTab(node),
      },
      persistent: {
        get: async (name) => (await this.env.storage.persistentVars.get(name))?.value,
        set: async (name, value) => {
          await this.env.storage.persistentVars.set(name, value);
        },
        delete: async (name) => {
          await this.env.storage.persistentVars.delete(name);
        },
      },
    };

    const policy = this.resolveNodePolicy(flow, node);
    const timeoutMs = policy.timeout?.ms;
    const scope = policy.timeout?.scope ?? 'attempt';
    const attemptTimeoutMs = scope === 'attempt' && timeoutMs !== undefined ? timeoutMs : undefined;

    try {
      const nodeWithConfig = { ...node, config: parsedConfig } as Parameters<typeof def.execute>[1];
      const execPromise = def.execute(ctx, nodeWithConfig);
      const result = await withTimeout(execPromise, attemptTimeoutMs, () =>
        createRRError(RR_ERROR_CODES.TIMEOUT, `Node "${node.id}" timed out`),
      );
      return result;
    } catch (e) {
      return {
        status: 'failed',
        error: toRRError(e, { code: RR_ERROR_CODES.INTERNAL, message: 'Node execution threw' }),
      };
    }
  }

  private async finishSucceeded(startedAt: number): Promise<RunResult> {
    const tookMs = this.env.now() - startedAt;
    await this.queue.run(async () => {
      await this.env.storage.runs.patch(this.runId, {
        status: 'succeeded',
        finishedAt: this.env.now(),
        tookMs,
        outputs: this.outputs,
      });
      await this.env.events.append({
        runId: this.runId,
        type: 'run.succeeded',
        tookMs,
        outputs: this.outputs,
      } as RunEventInput);
    });

    return { runId: this.runId, status: 'succeeded', tookMs, outputs: this.outputs };
  }

  private async finishFailed(
    startedAt: number,
    error: RRError,
    nodeId?: NodeId,
  ): Promise<RunResult> {
    const tookMs = this.env.now() - startedAt;
    await this.queue.run(async () => {
      await this.env.storage.runs.patch(this.runId, {
        status: 'failed',
        finishedAt: this.env.now(),
        tookMs,
        error,
        ...(nodeId ? { currentNodeId: nodeId } : {}),
      });
      await this.env.events.append({
        runId: this.runId,
        type: 'run.failed',
        error,
        ...(nodeId ? { nodeId } : {}),
      } as RunEventInput);
    });

    return { runId: this.runId, status: 'failed', tookMs, error };
  }

  private async finishCanceled(startedAt: number): Promise<RunResult> {
    const tookMs = this.env.now() - startedAt;
    await this.queue.run(async () => {
      await this.env.storage.runs.patch(this.runId, {
        status: 'canceled',
        finishedAt: this.env.now(),
        tookMs,
      });
      await this.env.events.append({
        runId: this.runId,
        type: 'run.canceled',
        ...(this.cancelReason ? { reason: this.cancelReason } : {}),
      } as RunEventInput);
    });

    return { runId: this.runId, status: 'canceled', tookMs };
  }
}
