/**
 * step-runner.ts
 *
 * Encapsulates execution of a single step with policies (retry, navigation wait) and plugins.
 * Uses dependency-injected StepExecutorInterface for actual step execution, enabling
 * seamless switching between legacy and ActionRegistry execution modes.
 */

import type { Flow, Step, StepClick } from '../../types';
import { STEP_TYPES } from 'webpage-mcp-shared';
import type { ExecCtx, ExecResult } from '../../nodes';
import { RunLogger } from '../logging/run-logger';
import { withRetry } from '../policies/retry';
import {
  waitForNavigationDone,
  maybeQuickWaitForNav,
  ensureReadPageIfWeb,
  waitForNetworkIdle,
} from '../policies/wait';
import { ENGINE_CONSTANTS } from '../constants';
import { AfterScriptQueue } from './after-script-queue';
import { PluginManager } from '../plugins/manager';
import type { HookControl } from '../plugins/types';
import type { StepExecutorInterface } from './step-executor';

// Narrow error-like value used for overlay reporting
interface ErrorLike {
  message?: string;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) return String((e as any).message);
  return String(e);
}

/**
 * Environment dependencies for StepRunner.
 * Injected by Scheduler to allow flexible configuration and testing.
 */
export interface StepRunEnv {
  /** Unique identifier for this run */
  runId: string;
  /** The flow being executed */
  flow: Flow;
  /** Runtime variables */
  vars: Record<string, any>;
  /** Run logger for recording execution events */
  logger: RunLogger;
  /** Plugin manager for hooks (beforeStep, afterStep, onRetry, onError) */
  pluginManager: PluginManager;
  /** Queue for deferred after-scripts */
  afterScripts: AfterScriptQueue;
  /** Returns remaining time budget from global deadline (ms), Infinity if no deadline */
  getRemainingBudgetMs: () => number;
  /**
   * Step executor for actual step execution.
   * Defaults to LegacyStepExecutor if not provided (for backwards compatibility).
   * In future, Scheduler will inject ActionsStepExecutor or HybridStepExecutor.
   */
  stepExecutor: StepExecutorInterface;
}

export class StepRunner {
  constructor(private env: StepRunEnv) {}

  private async getActiveTabInfo(): Promise<{ url: string; status: string | '' }> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    return { url: tab?.url || '', status: (tab?.status as string) || '' };
  }

  async run(
    ctx: ExecCtx,
    step: Step,
    appendOverlayOk: (s: Step) => Promise<void> | void,
    appendOverlayFail: (s: Step, e: ErrorLike) => Promise<void> | void,
  ): Promise<{
    status: 'success' | 'failed' | 'paused';
    nextLabel?: string;
    control?: ExecResult['control'];
  }> {
    const t0 = Date.now();
    let stepNextLabel: string | undefined;
    let controlOut: ExecResult['control'] | undefined = undefined;
    let ctrlStart: HookControl | undefined;
    try {
      ctrlStart = await this.env.pluginManager.beforeStep({
        runId: this.env.runId,
        flow: this.env.flow,
        vars: this.env.vars,
        step,
      });
    } catch (e: unknown) {
      this.env.logger.push({
        stepId: step.id,
        status: 'warning',
        message: `plugin.beforeStep error: ${errorMessage(e)}`,
      });
    }
    if (ctrlStart?.pause) return { status: 'paused' };

    const beforeInfo = await this.getActiveTabInfo();
    try {
      await withRetry(
        async () => {
          // Execute step via injected executor (legacy, actions, or hybrid)
          // tabId is expected to be set by Scheduler in ctx; fallback to active tab if missing
          let tabId = ctx.tabId;
          if (typeof tabId !== 'number') {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            tabId = tabs?.[0]?.id;
          }
          if (typeof tabId !== 'number') {
            throw new Error('No active tab found for step execution');
          }

          const execResult = await this.env.stepExecutor.execute(ctx, step, {
            tabId,
            runId: this.env.runId,
            pushLog: (entry) => this.env.logger.push(entry as any),
            remainingBudgetMs: this.env.getRemainingBudgetMs(),
          });
          const result = execResult.result;
          const remainingBudget = this.env.getRemainingBudgetMs();
          if (step.type === STEP_TYPES.CLICK || step.type === STEP_TYPES.DBLCLICK) {
            const after = step.after ?? ({} as NonNullable<StepClick['after']>);
            if (after.waitForNavigation)
              await waitForNavigationDone(
                beforeInfo.url,
                Math.min(step.timeoutMs ?? ENGINE_CONSTANTS.DEFAULT_WAIT_MS, remainingBudget),
              );
            else if (after.waitForNetworkIdle) {
              const totalMs = Math.min(
                step.timeoutMs ?? ENGINE_CONSTANTS.DEFAULT_WAIT_MS,
                remainingBudget,
              );
              const idleMs = Math.min(1500, Math.max(500, Math.floor(totalMs / 3)));
              await waitForNetworkIdle(totalMs, idleMs);
            } else
              await maybeQuickWaitForNav(
                beforeInfo.url,
                Math.min(step.timeoutMs ?? ENGINE_CONSTANTS.DEFAULT_WAIT_MS, remainingBudget),
              );
          }
          if (step.type === STEP_TYPES.NAVIGATE || step.type === STEP_TYPES.OPEN_TAB) {
            await waitForNavigationDone(
              beforeInfo.url,
              Math.min(
                step.timeoutMs ?? ENGINE_CONSTANTS.DEFAULT_WAIT_MS,
                this.env.getRemainingBudgetMs(),
              ),
            );
            await ensureReadPageIfWeb();
          } else if (step.type === STEP_TYPES.SWITCH_TAB) {
            await ensureReadPageIfWeb();
          }
          if (!result?.alreadyLogged)
            this.env.logger.push({ stepId: step.id, status: 'success', tookMs: Date.now() - t0 });
          try {
            await this.env.pluginManager.afterStep({
              runId: this.env.runId,
              flow: this.env.flow,
              vars: this.env.vars,
              step,
              result,
            });
          } catch (e: unknown) {
            this.env.logger.push({
              stepId: step.id,
              status: 'warning',
              message: `plugin.afterStep error: ${errorMessage(e)}`,
            });
          }
          await appendOverlayOk(step);
          if (result?.nextLabel) stepNextLabel = String(result.nextLabel);
          if (result?.control) controlOut = result.control;
          if (result?.deferAfterScript) this.env.afterScripts.enqueue(result.deferAfterScript);
          await this.env.afterScripts.flush(ctx, this.env.vars);
        },
        async (attempt, e) => {
          this.env.logger.push({
            stepId: step.id,
            status: 'retrying',
            message: errorMessage(e),
          });
          try {
            await this.env.pluginManager.onRetry({
              runId: this.env.runId,
              flow: this.env.flow,
              vars: this.env.vars,
              step,
              error: e,
              attempt,
            });
          } catch (pe: unknown) {
            this.env.logger.push({
              stepId: step.id,
              status: 'warning',
              message: `plugin.onRetry error: ${errorMessage(pe)}`,
            });
          }
        },
        {
          count: Math.max(0, step.retry?.count ?? 0),
          intervalMs: Math.max(0, step.retry?.intervalMs ?? 0),
          backoff: step.retry?.backoff || 'none',
        },
      );
    } catch (e: unknown) {
      this.env.logger.push({
        stepId: step.id,
        status: 'failed',
        message: errorMessage(e),
        tookMs: Date.now() - t0,
      });
      await appendOverlayFail(step, e as ErrorLike);
      try {
        const hook = await this.env.pluginManager.onError({
          runId: this.env.runId,
          flow: this.env.flow,
          vars: this.env.vars,
          step,
          error: e,
        });
        if (hook?.pause) return { status: 'paused' };
      } catch (pe: unknown) {
        this.env.logger.push({
          stepId: step.id,
          status: 'warning',
          message: `plugin.onError error: ${errorMessage(pe)}`,
        });
      }
      return { status: 'failed' };
    }
    return { status: 'success', nextLabel: stepNextLabel, control: controlOut };
  }
}
