import { STEP_TYPES, TOOL_NAMES } from 'webpage-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { handleCallTool } from '@/entrypoints/background/tools';
import type { Edge, Flow, NodeBase, RunLogEntry, RunResult, Step } from '../types';
import {
  mapDagNodeToStep,
  topoOrder,
  ensureTab,
  expandTemplatesDeep,
  defaultEdgesOnly,
} from '../rr-utils';
import type { ExecCtx } from '../nodes';
import { RunLogger } from './logging/run-logger';
import { PluginManager } from './plugins/manager';
import type { RunPlugin } from './plugins/types';
import { breakpointPlugin } from './plugins/breakpoint';
import { evalExpression } from './utils/expression';
import { runState } from './state-manager';
import { AfterScriptQueue } from './runners/after-script-queue';
import { type StepExecutionEvent, StepRunner } from './runners/step-runner';
import { ControlFlowRunner } from './runners/control-flow-runner';
import { SubflowRunner } from './runners/subflow-runner';
import { ENGINE_CONSTANTS, LOG_STEP_IDS } from './constants';
import {
  DEFAULT_EXECUTION_MODE_CONFIG,
  createActionsOnlyConfig,
  createHybridConfig,
  type ExecutionMode,
  type ExecutionModeConfig,
} from './execution-mode';
import { createExecutor, type StepExecutorInterface } from './runners/step-executor';
import { createReplayActionRegistry } from '../actions/handlers';
import { evaluateCondition as evaluateActionCondition } from '../actions/handlers/control-flow';
import { compareScreenshotBase64 } from './utils/screenshot-compare';
import type { Condition, ExecutionFlags } from '../actions/types';

export interface RunOptions {
  tabTarget?: 'current' | 'new';
  tabId?: number;
  refresh?: boolean;
  captureNetwork?: boolean;
  returnLogs?: boolean;
  timeoutMs?: number;
  startUrl?: string;
  args?: Record<string, any>;
  execution?: ExecutionFlags;
  startNodeId?: string;
  plugins?: RunPlugin[];

  /**
   * Step execution mode switch.
   * - 'legacy': Use existing nodes/executeStep (default, safest)
   * - 'hybrid': Try ActionRegistry first, fall back to legacy
   * - 'actions': Use ActionRegistry exclusively (strict mode)
   */
  executionMode?: ExecutionMode;

  /**
   * Hybrid mode only: allowlist of step types executed via ActionRegistry.
   * - undefined: use MINIMAL_HYBRID_ACTION_TYPES (safest default)
   * - []: disable allowlist, fall back to MIGRATED_ACTION_TYPES policy
   * - ['fill', 'key', ...]: only these types use actions
   */
  actionsAllowlist?: string[];

  /**
   * Hybrid mode only: denylist of step types forced to legacy.
   * When omitted, createHybridConfig defaults to LEGACY_ONLY_TYPES.
   */
  legacyOnlyTypes?: string[];

  /**
   * Include step-by-step trace in the run result.
   */
  debugStepByStep?: boolean;

  /**
   * Optional delay between steps in debug mode (milliseconds).
   */
  stepDelayMs?: number;

  /**
   * Capture screenshot after each step and include base64 in debug trace.
   */
  captureStepScreenshots?: boolean;

  /**
   * Capture screenshot after each step and return as baseline map by stepId.
   */
  recordStepScreenshotBaselines?: boolean;

  /**
   * Baseline screenshots keyed by stepId for visual comparison.
   */
  screenshotBaselines?: Record<string, string>;

  /**
   * Similarity threshold in [0,1] for screenshot baseline match.
   * Default: 0.92
   */
  screenshotDiffThreshold?: number;
}

interface StepDebugRecord {
  stepId: string;
  type: string;
  status: 'success' | 'failed' | 'paused';
  tookMs: number;
  tabId?: number;
  error?: string;
  nextLabel?: string;
  nextNodeId?: string;
  screenshotBase64?: string;
  screenshotSimilarity?: number | null;
  screenshotMatched?: boolean;
}

interface RunDebugPayload {
  steps: StepDebugRecord[];
  screenshotBaselines?: Record<string, string>;
}

/**
 * Type guard for ExecutionMode
 */
function isExecutionMode(value: unknown): value is ExecutionMode {
  return value === 'legacy' || value === 'hybrid' || value === 'actions';
}

/**
 * Convert array to Set<string>, filtering invalid values
 */
function toStringSet(value: unknown): Set<string> {
  const result = new Set<string>();
  if (!Array.isArray(value)) return result;
  for (const item of value) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) result.add(trimmed);
    }
  }
  return result;
}

/**
 * Build ExecutionModeConfig from RunOptions.
 * Defaults to legacy mode if executionMode is not specified.
 *
 * Note: Only array inputs for actionsAllowlist/legacyOnlyTypes are accepted.
 * Non-array values are ignored to prevent accidental misconfiguration
 * (e.g., passing a string instead of array would unexpectedly widen the allowlist).
 */
function buildExecutionModeConfig(options: RunOptions): ExecutionModeConfig {
  const mode: ExecutionMode = isExecutionMode(options.executionMode)
    ? options.executionMode
    : DEFAULT_EXECUTION_MODE_CONFIG.mode;

  if (mode === 'hybrid') {
    const overrides: Partial<ExecutionModeConfig> = {};
    // Only apply override if it's a valid array
    // This prevents misconfiguration from widening the actions scope
    if (Array.isArray(options.actionsAllowlist)) {
      overrides.actionsAllowlist = toStringSet(options.actionsAllowlist);
    }
    if (Array.isArray(options.legacyOnlyTypes)) {
      overrides.legacyOnlyTypes = toStringSet(options.legacyOnlyTypes);
    }
    return createHybridConfig(overrides);
  }

  if (mode === 'actions') {
    return createActionsOnlyConfig();
  }

  // Default: legacy mode
  return { ...DEFAULT_EXECUTION_MODE_CONFIG };
}

function normalizeScreenshotBaselines(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const normalized: Record<string, string> = {};
  for (const [key, baseline] of Object.entries(value)) {
    if (typeof key !== 'string' || !key.trim()) continue;
    if (typeof baseline !== 'string' || !baseline.trim()) continue;
    normalized[key] = baseline;
  }
  return normalized;
}

function clampSimilarityThreshold(value: unknown, fallback = 0.92): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/** Evaluate both structured Action conditions and legacy scheduler conditions. */
export function evaluateSchedulerCondition(
  cond: unknown,
  vars: Record<string, any>,
): boolean {
  try {
    if (cond && typeof cond === 'object' && 'kind' in cond && typeof cond.kind === 'string') {
      const result = evaluateActionCondition(cond as Condition, vars);
      return result.ok && result.value;
    }
    if (
      cond &&
      typeof cond === 'object' &&
      'expression' in cond &&
      typeof cond.expression === 'string' &&
      cond.expression.trim()
    ) {
      return !!evalExpression(cond.expression, { vars });
    }
    if (cond && typeof cond === 'object' && 'var' in cond && typeof cond.var === 'string') {
      const value = vars[cond.var];
      if ('equals' in cond) return String(value) === String(cond.equals);
      return !!value;
    }
  } catch {
    // Invalid or unsupported conditions fail closed.
  }
  return false;
}

/**
 * ExecutionOrchestrator manages the lifecycle of a flow execution.
 *
 * Architecture:
 * - Creates StepExecutor based on ExecutionModeConfig (legacy by default)
 * - Injects StepExecutor into StepRunner for step execution
 * - Manages tabId and passes it through ExecCtx
 * - Handles DAG traversal, control flow, and cleanup
 */
class ExecutionOrchestrator {
  private readonly runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  private readonly startAt = Date.now();
  private readonly logger = new RunLogger(this.runId);
  private readonly pluginManager: PluginManager;
  private readonly afterScripts = new AfterScriptQueue(this.logger);

  // Execution mode configuration (defaults to legacy for safety)
  private readonly executionModeConfig: ExecutionModeConfig;
  private readonly stepExecutor: StepExecutorInterface;

  // Runtime state
  private vars: Record<string, any> = Object.create(null);
  private tabId: number | null = null;
  private deadline = 0;
  private networkCaptureStarted = false;
  private paused = false;
  private failed = 0;
  private executed = 0;
  private steps: Step[] = [];
  private prepareError: RunResult | null = null;
  private lastStepEventIndex = -1;
  private readonly debugRecords: StepDebugRecord[] = [];
  private readonly capturedBaselines: Record<string, string> = Object.create(null);
  private readonly debugStepByStep: boolean;
  private readonly captureStepScreenshots: boolean;
  private readonly recordStepScreenshotBaselines: boolean;
  private readonly screenshotBaselines: Record<string, string>;
  private readonly screenshotDiffThreshold: number;
  private readonly stepDelayMs: number;

  // Runners
  private stepRunner: StepRunner;
  private controlFlowRunner!: ControlFlowRunner;
  private subflowRunner!: SubflowRunner;

  constructor(
    private flow: Flow,
    private options: RunOptions = {},
  ) {
    this.debugStepByStep = options.debugStepByStep === true;
    this.captureStepScreenshots = options.captureStepScreenshots === true;
    this.recordStepScreenshotBaselines = options.recordStepScreenshotBaselines === true;
    this.screenshotBaselines = normalizeScreenshotBaselines(options.screenshotBaselines);
    this.screenshotDiffThreshold = clampSimilarityThreshold(options.screenshotDiffThreshold, 0.92);
    this.stepDelayMs = Math.max(0, Math.floor(Number(options.stepDelayMs || 0)));

    // Initialize variables from flow defaults and args
    for (const v of flow.variables || []) {
      if (v.default !== undefined) this.vars[v.key] = v.default;
    }
    if (options.args) Object.assign(this.vars, options.args);

    // Set up global deadline
    const globalTimeout = Math.max(0, Number(options.timeoutMs || 0));
    this.deadline = globalTimeout > 0 ? this.startAt + globalTimeout : 0;

    // Initialize plugin manager
    this.pluginManager = new PluginManager(
      options.plugins && options.plugins.length ? options.plugins : [breakpointPlugin()],
    );

    // Create step executor based on execution mode configuration
    // Default to legacy mode for maximum safety during migration
    this.executionModeConfig = buildExecutionModeConfig(options);

    // Only create ActionRegistry when needed (hybrid or actions mode)
    // This avoids unnecessary initialization overhead in legacy mode
    const registry =
      this.executionModeConfig.mode === 'legacy' ? undefined : createReplayActionRegistry();
    this.stepExecutor = createExecutor(this.executionModeConfig, registry);

    // Initialize step runner with injected executor
    this.stepRunner = new StepRunner({
      runId: this.runId,
      flow: this.flow,
      vars: this.vars,
      logger: this.logger,
      pluginManager: this.pluginManager,
      afterScripts: this.afterScripts,
      getRemainingBudgetMs: () =>
        this.deadline > 0 ? Math.max(0, this.deadline - Date.now()) : Number.POSITIVE_INFINITY,
      stepExecutor: this.stepExecutor,
      onStepFinished: async (event) => this.onStepFinished(event),
    });
  }

  private get shouldCollectDebugData(): boolean {
    return (
      this.debugStepByStep ||
      this.captureStepScreenshots ||
      this.recordStepScreenshotBaselines ||
      Object.keys(this.screenshotBaselines).length > 0
    );
  }

  private async onStepFinished(event: StepExecutionEvent): Promise<void> {
    if (!this.shouldCollectDebugData) return;

    const record: StepDebugRecord = {
      stepId: event.step.id,
      type: event.step.type,
      status: event.status,
      tookMs: Math.max(0, Number(event.tookMs || 0)),
      tabId: event.tabId,
      ...(event.error ? { error: event.error } : {}),
      ...(event.nextLabel ? { nextLabel: event.nextLabel } : {}),
    };

    const needsScreenshot =
      this.captureStepScreenshots ||
      this.recordStepScreenshotBaselines ||
      typeof this.screenshotBaselines[event.step.id] === 'string';
    if (needsScreenshot) {
      const screenshot = await this.logger.captureScreenshotBase64(event.tabId);
      if (screenshot) {
        if (this.captureStepScreenshots) {
          record.screenshotBase64 = screenshot;
        }
        if (this.recordStepScreenshotBaselines) {
          this.capturedBaselines[event.step.id] = screenshot;
        }
        const baseline = this.screenshotBaselines[event.step.id];
        if (baseline) {
          const similarity = compareScreenshotBase64(screenshot, baseline);
          record.screenshotSimilarity = similarity;
          if (similarity == null) {
            record.screenshotMatched = false;
            this.logger.push({
              stepId: event.step.id,
              status: 'warning',
              message: 'Screenshot comparison skipped: invalid baseline payload',
            });
          } else {
            const matched = similarity >= this.screenshotDiffThreshold;
            record.screenshotMatched = matched;
            if (!matched) {
              this.logger.push({
                stepId: event.step.id,
                status: 'warning',
                message: `Screenshot mismatch: similarity ${similarity} below threshold ${this.screenshotDiffThreshold}`,
              });
            }
          }
        }
      } else if (this.screenshotBaselines[event.step.id]) {
        this.logger.push({
          stepId: event.step.id,
          status: 'warning',
          message: 'Screenshot comparison skipped: failed to capture runtime screenshot',
        });
      }
    }

    this.debugRecords.push(record);
    this.lastStepEventIndex = this.debugRecords.length - 1;

    if (this.stepDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.stepDelayMs));
    }
  }

  private annotateDebugRecord(index: number, patch: Partial<StepDebugRecord>, expectedStepId: string) {
    if (!this.shouldCollectDebugData) return;
    if (!Number.isInteger(index) || index < 0 || index >= this.debugRecords.length) return;
    const target = this.debugRecords[index];
    if (!target || target.stepId !== expectedStepId) return;
    Object.assign(target, patch);
  }

  private buildRunDebugPayload(): RunDebugPayload | undefined {
    if (!this.shouldCollectDebugData) return undefined;
    const payload: RunDebugPayload = {
      steps: this.debugRecords.map((record) => ({ ...record })),
    };
    if (this.recordStepScreenshotBaselines) {
      payload.screenshotBaselines = { ...this.capturedBaselines };
    }
    return payload;
  }

  private ensureWithinDeadline() {
    if (this.deadline > 0 && Date.now() > this.deadline) {
      const err = new Error('Global timeout reached');
      this.logger.push({
        stepId: LOG_STEP_IDS.GLOBAL_TIMEOUT,
        status: 'failed',
        message: 'Global timeout reached',
      });
      throw err;
    }
  }

  async run(): Promise<RunResult> {
    try {
      await this.prepareExecution();
      if (this.prepareError) return this.prepareError;
      return await this.traverseDag();
    } finally {
      await this.cleanup();
    }
  }

  private async prepareExecution() {
    // Derive default startUrl
    let derivedStartUrl: string | undefined;
    try {
      const hasDag0 = Array.isArray(this.flow.nodes) && (this.flow.nodes?.length || 0) > 0;
      const nodes0: NodeBase[] = hasDag0 ? this.flow.nodes || [] : [];
      const edges0: Edge[] = hasDag0 ? this.flow.edges || [] : [];
      const defaultEdges0 = hasDag0 ? defaultEdgesOnly(edges0) : [];
      const order0 = hasDag0 ? topoOrder(nodes0, defaultEdges0) : [];
      const steps0: Step[] = hasDag0 ? order0.map((n) => mapDagNodeToStep(n)) : [];
      const nav = steps0.find((s) => s.type === STEP_TYPES.NAVIGATE);
      if (nav && nav.type === STEP_TYPES.NAVIGATE)
        derivedStartUrl = expandTemplatesDeep(nav.url, this.vars);
    } catch {
      // ignore: best-effort derive startUrl
    }

    const ensured = await ensureTab({
      tabTarget: this.options.tabTarget,
      tabId: this.options.tabId,
      startUrl: this.options.startUrl || derivedStartUrl,
      refresh: this.options.refresh,
      background: this.options.execution?.backgroundTabs === true,
    });
    // Capture tabId for use in ExecCtx
    this.tabId = ensured?.tabId ?? null;
    this.logger.setTargetTabId(this.tabId);

    // register run state
    await runState.restore();
    await runState.add(this.runId, {
      id: this.runId,
      flowId: this.flow.id,
      name: this.flow.name,
      status: 'running',
      startedAt: this.startAt,
      updatedAt: this.startAt,
    });

    try {
      await this.pluginManager.runStart({ runId: this.runId, flow: this.flow, vars: this.vars });
    } catch (e: any) {
      this.logger.push({
        stepId: LOG_STEP_IDS.PLUGIN_RUN_START,
        status: 'warning',
        message: e?.message || String(e),
      });
    }

    // pre-load read_page when on web
    try {
      const u = ensured?.url || '';
      if (/^(https?:|file:)/i.test(u))
        await handleCallTool({
          name: TOOL_NAMES.BROWSER.READ_PAGE,
          args: typeof this.tabId === 'number' ? { tabId: this.tabId } : {},
        });
    } catch {
      // ignore: preloading read_page is best-effort
    }

    // overlay variable collection
    try {
      const needed = (this.flow.variables || []).filter(
        (v) =>
          (this.options.args?.[v.key] == null || this.options.args?.[v.key] === '') &&
          (v.rules?.required || (v.default ?? '') === ''),
      );
      if (needed.length) {
        const res = await handleCallTool({
          name: TOOL_NAMES.BROWSER.SEND_COMMAND_TO_INJECT_SCRIPT,
          args: {
            eventName: TOOL_MESSAGE_TYPES.COLLECT_VARIABLES,
            payload: JSON.stringify({ variables: needed, useOverlay: true }),
            ...(typeof this.tabId === 'number' ? { tabId: this.tabId } : {}),
          },
        });
        let values: Record<string, any> | null = null;
        try {
          const t = (res?.content || []).find((c: any) => c.type === 'text')?.text;
          const j = t ? JSON.parse(t) : null;
          if (j && j.success && j.values) values = j.values;
        } catch {
          // ignore: parse result from tool response
        }
        if (!values) {
          const fallbackTabId =
            typeof this.tabId === 'number'
              ? this.tabId
              : (await chrome.tabs.query({ active: true, currentWindow: true }))?.[0]?.id;
          if (typeof fallbackTabId === 'number') {
            const res2 = await chrome.tabs.sendMessage(fallbackTabId, {
              action: TOOL_MESSAGE_TYPES.COLLECT_VARIABLES,
              variables: needed,
              useOverlay: true,
            });
            if (res2 && res2.success && res2.values) values = res2.values;
          }
        }
        if (values) Object.assign(this.vars, values);
        else
          this.logger.push({
            stepId: LOG_STEP_IDS.VARIABLE_COLLECT,
            status: 'warning',
            message: 'Variable collection failed; using provided args/defaults',
          });
      }
    } catch {
      // ignore: variable collection is optional
    }

    await this.logger.overlayInit();

    // binding enforcement
    try {
      const currentTab =
        typeof this.tabId === 'number'
          ? await chrome.tabs.get(this.tabId).catch(() => null)
          : (await chrome.tabs.query({ active: true, currentWindow: true }))?.[0];
      const currentUrl = currentTab?.url || '';
      const bindings = this.flow.meta?.bindings || [];
      if (!this.options.startUrl && bindings.length > 0) {
        const ok = bindings.some((b) => {
          try {
            if (b.type === 'domain') return new URL(currentUrl).hostname.includes(b.value);
            if (b.type === 'path') return new URL(currentUrl).pathname.startsWith(b.value);
            if (b.type === 'url') return currentUrl.startsWith(b.value);
          } catch {
            // ignore: URL parsing for binding check
          }
          return false;
        });
        if (!ok) {
          this.prepareError = {
            runId: this.runId,
            success: false,
            summary: { total: 0, success: 0, failed: 0, tookMs: 0 },
            url: currentUrl,
            outputs: null,
            logs: [
              {
                stepId: LOG_STEP_IDS.BINDING_CHECK,
                status: 'failed',
                message:
                  'Flow binding mismatch. Provide startUrl or open a page matching flow.meta.bindings.',
              },
            ],
            screenshots: { onFailure: null },
            paused: false,
          };
          return;
        }
      }
    } catch {
      // ignore: binding enforcement failures fall back to default behavior
    }

    // network capture start
    if (this.options.captureNetwork) {
      try {
        const res = await handleCallTool({
          name: TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_START,
          args: {
            includeStatic: false,
            maxCaptureTime: 3 * 60_000,
            inactivityTimeout: 0,
            ...(typeof this.tabId === 'number' ? { tabId: this.tabId } : {}),
          },
        });
        let started = false;
        try {
          const t = res?.content?.find?.((c: any) => c.type === 'text')?.text;
          if (t) {
            const j = JSON.parse(t);
            started = !!j?.success;
          }
        } catch {
          // ignore: parse network debugger start response
        }
        this.networkCaptureStarted = started;
        if (!started) {
          this.logger.push({
            stepId: LOG_STEP_IDS.NETWORK_CAPTURE,
            status: 'warning',
            message: 'Failed to confirm network capture start',
          });
        }
      } catch (e: any) {
        this.logger.push({
          stepId: LOG_STEP_IDS.NETWORK_CAPTURE,
          status: 'warning',
          message: e?.message || 'Network capture start errored',
        });
      }
    }

    // build DAG steps
    const hasDag = Array.isArray(this.flow.nodes) && (this.flow.nodes?.length || 0) > 0;
    if (!hasDag) {
      this.prepareError = {
        runId: this.runId,
        success: false,
        summary: { total: 0, success: 0, failed: 0, tookMs: 0 },
        url: null,
        outputs: null,
        logs: [
          {
            stepId: LOG_STEP_IDS.DAG_REQUIRED,
            status: 'failed',
            message:
              'Flow has no DAG nodes. Linear steps are no longer supported. Please migrate this flow to nodes/edges.',
          },
        ],
        screenshots: { onFailure: null },
        paused: false,
      };
      return;
    }
    const nodes: NodeBase[] = (this.flow.nodes || []) as NodeBase[];
    const edges: Edge[] = (this.flow.edges || []) as Edge[];
    // Validate DAG for potential cycles on full edge set
    try {
      if (this.hasCycle(nodes, edges)) {
        this.prepareError = {
          runId: this.runId,
          success: false,
          summary: { total: 0, success: 0, failed: 0, tookMs: 0 },
          url: null,
          outputs: null,
          logs: [
            {
              stepId: LOG_STEP_IDS.DAG_CYCLE,
              status: 'failed',
              message:
                'Flow DAG contains a cycle. Please break the cycle or add explicit labels/branches to avoid infinite loops.',
            },
          ],
          screenshots: { onFailure: null },
          paused: false,
        };
        return;
      }
    } catch {
      // ignore: cycle detection guard
    }
    const defaultEdges = defaultEdgesOnly(edges);
    const order = topoOrder(nodes, defaultEdges);
    // Filter out trigger nodes - they are configuration nodes, not executable steps
    this.steps = order.filter((n) => n.type !== STEP_TYPES.TRIGGER).map((n) => mapDagNodeToStep(n));
    // initialize runners
    this.subflowRunner = new SubflowRunner({
      runId: this.runId,
      flow: this.flow,
      vars: this.vars,
      logger: this.logger,
      pluginManager: this.pluginManager,
      stepRunner: this.stepRunner,
    });
    this.controlFlowRunner = new ControlFlowRunner({
      vars: this.vars,
      logger: this.logger,
      evalCondition: (c) => this.evalCondition(c),
      runSubflowById: (id, ctx) => this.subflowRunner.runSubflowById(id, ctx, () => this.paused),
      isPaused: () => this.paused,
    });
  }

  // Basic cycle detection using DFS coloring on the full edge set
  private hasCycle(
    nodes: Array<{ id: string }>,
    edges: Array<{ from: string; to: string }>,
  ): boolean {
    const adj = new Map<string, string[]>();
    for (const n of nodes) adj.set(n.id, []);
    for (const e of edges) {
      if (!adj.has(e.from)) adj.set(e.from, []);
      adj.get(e.from)!.push(e.to);
    }
    const color = new Map<string, number>(); // 0=unvisited,1=visiting,2=done
    const visit = (u: string): boolean => {
      const c = color.get(u) || 0;
      if (c === 1) return true; // back-edge
      if (c === 2) return false;
      color.set(u, 1);
      for (const v of adj.get(u) || []) if (visit(v)) return true;
      color.set(u, 2);
      return false;
    };
    for (const n of nodes) if ((color.get(n.id) || 0) === 0 && visit(n.id)) return true;
    return false;
  }

  private async traverseDag(): Promise<RunResult> {
    if (!this.steps.length) {
      await this.logger.overlayDone();
      const tookMs0 = Date.now() - this.startAt;
      const debugPayload0 = this.buildRunDebugPayload();
      return (
        this.prepareError || {
          runId: this.runId,
          success: false,
          summary: { total: 0, success: 0, failed: 0, tookMs: tookMs0 },
          url: null,
          outputs: null,
          logs: this.options.returnLogs ? this.logger.getLogs() : undefined,
          screenshots: { onFailure: null },
          paused: false,
          ...(debugPayload0 ? { debug: debugPayload0 } : {}),
        }
      );
    }
    const nodes: NodeBase[] = this.flow.nodes || [];
    const edges: Edge[] = this.flow.edges || [];
    const id2node = new Map(nodes.map((n) => [n.id, n] as const));
    const outEdges = new Map<string, Array<Edge>>();
    for (const e of edges) {
      if (!outEdges.has(e.from)) outEdges.set(e.from, []);
      outEdges.get(e.from)!.push(e);
    }
    const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0] as const));
    for (const e of edges) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
    // Find start node: prefer non-trigger nodes with indeg=0
    // Trigger nodes are configuration nodes and should be skipped
    const findFirstExecutableRoot = (): string | undefined => {
      // First try to find a non-trigger root node
      const executableRoot = nodes.find(
        (n) => (indeg.get(n.id) || 0) === 0 && n.type !== STEP_TYPES.TRIGGER,
      );
      if (executableRoot) return executableRoot.id;

      // If all roots are triggers, find one and follow default edge to first executable
      const triggerRoot = nodes.find((n) => (indeg.get(n.id) || 0) === 0);
      if (triggerRoot) {
        const defaultEdge = (outEdges.get(triggerRoot.id) || []).find(
          (e) => !e.label || e.label === ENGINE_CONSTANTS.EDGE_LABELS.DEFAULT,
        );
        if (defaultEdge) return defaultEdge.to;
      }

      // Fallback to first node
      return nodes[0]?.id;
    };

    let currentId: string | undefined =
      this.options.startNodeId && id2node.has(this.options.startNodeId)
        ? this.options.startNodeId
        : findFirstExecutableRoot();
    let guard = 0;

    // Create execution context with tabId from ensureTab
    // tabId is managed by Scheduler and may be updated by openTab/switchTab actions
    const ctx: ExecCtx = {
      vars: this.vars,
      tabId: this.tabId ?? undefined,
      execution: this.options.execution,
      logger: (e: RunLogEntry) => this.logger.push(e),
    };
    if (currentId) {
      try {
        await this.logger.overlayAppend(
          `▶ start at ${id2node.get(currentId)?.type || ''} (${currentId})`,
        );
      } catch {
        // ignore: eval condition failure treated as false
      }
    }
    while (currentId) {
      this.logger.setTargetTabId(ctx.tabId);
      this.ensureWithinDeadline();
      if (guard++ >= ENGINE_CONSTANTS.MAX_ITERATIONS) {
        this.logger.push({
          stepId: LOG_STEP_IDS.LOOP_GUARD,
          status: 'failed',
          message: `Exceeded ${ENGINE_CONSTANTS.MAX_ITERATIONS} iterations - possible cycle in DAG`,
        });
        this.failed++;
        break;
      }
      const node = id2node.get(currentId);
      if (!node) break;

      // Skip trigger nodes - they are configuration nodes, not executable steps
      // Follow default edge to the next executable node
      if (node.type === STEP_TYPES.TRIGGER) {
        try {
          await this.logger.overlayAppend(`⏭ skip trigger (${node.id})`);
        } catch {}
        const defaultEdge = (outEdges.get(currentId) || []).find(
          (e) => !e.label || e.label === ENGINE_CONSTANTS.EDGE_LABELS.DEFAULT,
        );
        if (defaultEdge) {
          currentId = defaultEdge.to;
          continue;
        }
        // No successor after trigger - end execution
        this.logger.push({
          stepId: node.id,
          status: 'warning',
          message: 'Trigger node has no successor - nothing to execute',
        });
        break;
      }

      const step: Step = mapDagNodeToStep(node);
      // lightweight trace to aid debugging edge traversal
      try {
        await this.logger.overlayAppend(`→ ${step.type} (${step.id})`);
      } catch {
        // ignore: stopping network capture is best-effort
      }
      // Count this step as executed (regardless of success/failure)
      this.executed++;

      const r = await this.stepRunner.run(
        ctx,
        step,
        (s) => this.logger.overlayAppend(`✔ ${s.type} (${s.id})`),
        (s, e) => this.logger.overlayAppend(`✘ ${s.type} (${s.id}) -> ${e?.message || String(e)}`),
      );
      const currentStepDebugIndex = this.lastStepEventIndex;
      if (r.status === 'paused') {
        this.paused = true;
        this.annotateDebugRecord(
          currentStepDebugIndex,
          {
            nextLabel: ENGINE_CONSTANTS.EDGE_LABELS.DEFAULT,
            nextNodeId: undefined,
          },
          step.id,
        );
        break;
      }
      if (r.status === 'failed') {
        this.failed++;
        const oes = (outEdges.get(currentId) || []) as Edge[];
        const errEdge = oes.find((edg) => edg.label === ENGINE_CONSTANTS.EDGE_LABELS.ON_ERROR);
        this.annotateDebugRecord(
          currentStepDebugIndex,
          {
            nextLabel: errEdge ? ENGINE_CONSTANTS.EDGE_LABELS.ON_ERROR : undefined,
            nextNodeId: errEdge?.to,
          },
          step.id,
        );
        if (errEdge) {
          currentId = errEdge.to;
          continue;
        } else {
          break;
        }
      }
      if (r.control) {
        const control = r.control;
        const st = await this.controlFlowRunner.run(control, ctx);
        if (st === 'paused') {
          this.paused = true;
          break;
        }
        const suggested = r.nextLabel ? String(r.nextLabel) : ENGINE_CONSTANTS.EDGE_LABELS.DEFAULT;
        const next = await this.advanceToNext(currentId, step, suggested, id2node, outEdges);
        this.annotateDebugRecord(
          currentStepDebugIndex,
          {
            nextLabel: suggested,
            nextNodeId: next,
          },
          step.id,
        );
        if (!next) break;
        currentId = next;
        continue;
      }
      // choose next by label
      {
        const suggested = r.nextLabel ? String(r.nextLabel) : ENGINE_CONSTANTS.EDGE_LABELS.DEFAULT;
        const next = await this.advanceToNext(currentId, step, suggested, id2node, outEdges);
        this.annotateDebugRecord(
          currentStepDebugIndex,
          {
            nextLabel: suggested,
            nextNodeId: next,
          },
          step.id,
        );
        if (!next) break;
        currentId = next;
      }
    }
    const tookMs = Date.now() - this.startAt;
    const sensitiveKeys = new Set(
      (this.flow.variables || []).filter((v) => v.sensitive).map((v) => v.key),
    );
    const outputs: Record<string, any> = {};
    for (const [k, v] of Object.entries(this.vars)) if (!sensitiveKeys.has(k)) outputs[k] = v;
    const debugPayload = this.buildRunDebugPayload();
    return {
      runId: this.runId,
      success: !this.paused && this.failed === 0,
      summary: {
        total: this.executed,
        success: this.executed - this.failed,
        failed: this.failed,
        tookMs,
      },
      url: null,
      outputs,
      logs: this.options.returnLogs ? this.logger.getLogs() : undefined,
      screenshots: {
        onFailure: this.logger.getLogs().find((l) => l.status === 'failed')?.screenshotBase64,
      },
      paused: this.paused,
      ...(debugPayload ? { debug: debugPayload } : {}),
    };
  }

  // Advance to next node by suggested label, with overlay/logging and fallback to default edge.
  private async advanceToNext(
    currentId: string,
    step: Step,
    suggested: string,
    id2node: Map<string, NodeBase>,
    outEdges: Map<string, Array<Edge>>,
  ): Promise<string | undefined> {
    const nextLabel = await this.chooseNextLabel(step, suggested);
    const nextId = this.findNextNodeId(currentId, outEdges, nextLabel);
    if (nextId) {
      try {
        await this.logger.overlayAppend(
          `↪ next(${nextLabel}) → ${id2node.get(nextId)?.type || ''} (${nextId})`,
        );
      } catch {}
      return nextId;
    }
    const labels = (outEdges.get(currentId) || []).map((e) =>
      String(e.label || ENGINE_CONSTANTS.EDGE_LABELS.DEFAULT),
    );
    this.logger.push({
      stepId: step.id,
      status: 'warning',
      message: `No next edge for label '${nextLabel}'. Outgoing labels: [${labels.join(', ')}]`,
    });
    return undefined;
  }

  // Decide next label, allowing plugins to override; logs plugin errors as warnings
  private async chooseNextLabel(step: Step, suggested: string): Promise<string> {
    try {
      const override = await this.pluginManager.onChooseNextLabel({
        runId: this.runId,
        flow: this.flow,
        vars: this.vars,
        step,
        suggested,
      });
      return override ? String(override) : suggested;
    } catch (e: any) {
      this.logger.push({
        stepId: step.id,
        status: 'warning',
        message: `plugin.onChooseNextLabel error: ${e?.message || String(e)}`,
      });
      return suggested;
    }
  }

  // From current node and label, pick next nodeId using outEdges; prefers labeled edge then default
  private findNextNodeId(
    currentId: string,
    outEdges: Map<string, Array<Edge>>,
    nextLabel: string,
  ): string | undefined {
    const oes = (outEdges.get(currentId) || []) as Edge[];
    const edge =
      oes.find((e) => String(e.label || ENGINE_CONSTANTS.EDGE_LABELS.DEFAULT) === nextLabel) ||
      oes.find((e) => !e.label || e.label === ENGINE_CONSTANTS.EDGE_LABELS.DEFAULT);
    return edge ? edge.to : undefined;
  }

  private evalCondition(cond: any): boolean {
    return evaluateSchedulerCondition(cond, this.vars);
  }

  private async cleanup() {
    if (this.networkCaptureStarted) {
      try {
        const stopRes = await handleCallTool({
          name: TOOL_NAMES.BROWSER.NETWORK_DEBUGGER_STOP,
          args: typeof this.tabId === 'number' ? { tabId: this.tabId } : {},
        });
        const text = (stopRes?.content || []).find((c: any) => c.type === 'text')?.text;
        if (text) {
          try {
            const data = JSON.parse(text);
            const requests: any[] = Array.isArray(data?.requests) ? data.requests : [];
            const snippets = requests
              .filter((r) => ['XHR', 'Fetch'].includes(String(r.type)))
              .slice(0, 10)
              .map((r) => ({
                method: String(r.method || 'GET'),
                url: String(r.url || ''),
                status: r.statusCode || r.status,
                ms: Math.max(0, (r.responseTime || 0) - (r.requestTime || 0)),
              }));
            this.logger.push({
              stepId: LOG_STEP_IDS.NETWORK_CAPTURE,
              status: 'success',
              message: `Captured ${Number(data?.requestCount || 0)} requests`,
              networkSnippets: snippets,
            });
          } catch (e: any) {
            this.logger.push({
              stepId: LOG_STEP_IDS.NETWORK_CAPTURE,
              status: 'warning',
              message: `Failed parsing network capture result: ${e?.message || String(e)}`,
            });
          }
        }
      } catch {}
    }
    await this.logger.overlayDone();
    try {
      try {
        await this.pluginManager.runEnd({
          runId: this.runId,
          flow: this.flow,
          vars: this.vars,
          success: this.failed === 0 && !this.paused,
          failed: this.failed,
        });
      } catch (e: any) {
        this.logger.push({
          stepId: LOG_STEP_IDS.PLUGIN_RUN_END,
          status: 'warning',
          message: e?.message || String(e),
        });
      }
      if (!this.paused) await this.logger.persist(this.flow, this.startAt, this.failed === 0);
      try {
        await runState.update(this.runId, {
          status: this.paused ? 'stopped' : this.failed === 0 ? 'completed' : 'failed',
          updatedAt: Date.now(),
        });
      } catch (e: any) {
        this.logger.push({
          stepId: LOG_STEP_IDS.RUNSTATE_UPDATE,
          status: 'warning',
          message: e?.message || String(e),
        });
      }
      try {
        if (!this.paused) await runState.delete(this.runId);
      } catch (e: any) {
        this.logger.push({
          stepId: LOG_STEP_IDS.RUNSTATE_DELETE,
          status: 'warning',
          message: e?.message || String(e),
        });
      }
    } catch {}
  }
}

export async function runFlow(flow: Flow, options: RunOptions = {}): Promise<RunResult> {
  const orchestrator = new ExecutionOrchestrator(flow, options);
  return await orchestrator.run();
}
