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

export interface StepExecutionEvent {
  step: Step;
  status: 'success' | 'failed' | 'paused';
  tookMs: number;
  tabId?: number;
  nextLabel?: string;
  control?: ExecResult['control'];
  error?: string;
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
  /**
   * Optional hook invoked after each step reaches a terminal status.
   * Useful for debug traces and screenshot capture in the scheduler.
   */
  onStepFinished?: (event: StepExecutionEvent) => Promise<void> | void;
}

export class StepRunner {
  constructor(private env: StepRunEnv) {}

  private async getActiveTabInfo(preferredTabId?: number): Promise<{ url: string; status: string | '' }> {
    if (typeof preferredTabId === 'number') {
      const tab = await chrome.tabs.get(preferredTabId).catch(() => null);
      if (tab?.id) {
        return { url: tab.url || '', status: (tab.status as string) || '' };
      }
    }
    return { url: '', status: '' };
  }

  private async emitStepFinished(event: StepExecutionEvent) {
    if (!this.env.onStepFinished) return;
    try {
      await this.env.onStepFinished(event);
    } catch (e: unknown) {
      this.env.logger.push({
        stepId: event.step.id,
        status: 'warning',
        message: `stepFinished hook error: ${errorMessage(e)}`,
      });
    }
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
    tookMs: number;
    error?: string;
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
    if (ctrlStart?.pause) {
      const tookMs = Date.now() - t0;
      await this.emitStepFinished({
        step,
        status: 'paused',
        tookMs,
        tabId: ctx.tabId,
      });
      return { status: 'paused', tookMs };
    }

    this.env.logger.setTargetTabId(ctx.tabId);
    const beforeInfo = await this.getActiveTabInfo(ctx.tabId);
    try {
      await withRetry(
        async () => {
          // Execute step via injected executor (legacy, actions, or hybrid)
          // tabId is expected to be set by Scheduler in ctx and must remain workflow-scoped.
          const tabId = ctx.tabId;
          if (typeof tabId !== 'number') {
            throw new Error('Workflow tab is not set for step execution');
          }
          this.env.logger.setTargetTabId(tabId);

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
                ctx.tabId,
              );
            else if (after.waitForNetworkIdle) {
              const totalMs = Math.min(
                step.timeoutMs ?? ENGINE_CONSTANTS.DEFAULT_WAIT_MS,
                remainingBudget,
              );
              const idleMs = Math.min(1500, Math.max(500, Math.floor(totalMs / 3)));
              await waitForNetworkIdle(totalMs, idleMs, ctx.tabId);
            } else
              await maybeQuickWaitForNav(
                beforeInfo.url,
                Math.min(step.timeoutMs ?? ENGINE_CONSTANTS.DEFAULT_WAIT_MS, remainingBudget),
                ctx.tabId,
              );
          }
          if (step.type === STEP_TYPES.NAVIGATE || step.type === STEP_TYPES.OPEN_TAB) {
            await waitForNavigationDone(
              beforeInfo.url,
              Math.min(
                step.timeoutMs ?? ENGINE_CONSTANTS.DEFAULT_WAIT_MS,
                this.env.getRemainingBudgetMs(),
              ),
              ctx.tabId,
            );
            await ensureReadPageIfWeb(ctx.tabId);
          } else if (step.type === STEP_TYPES.SWITCH_TAB) {
            await ensureReadPageIfWeb(ctx.tabId);
          }
          if (!result?.alreadyLogged)
            this.env.logger.push({ stepId: step.id, status: 'success', tookMs: Date.now() - t0 });
          let resultError: string | undefined;
          try {
            await this.env.pluginManager.afterStep({
              runId: this.env.runId,
              flow: this.env.flow,
              vars: this.env.vars,
              step,
              result,
            });
          } catch (e: unknown) {
            resultError = errorMessage(e);
            this.env.logger.push({
              stepId: step.id,
              status: 'warning',
              message: `plugin.afterStep error: ${resultError}`,
            });
          }
          await appendOverlayOk(step);
          if (result?.nextLabel) stepNextLabel = String(result.nextLabel);
          if (result?.control) controlOut = result.control;
          if (result?.deferAfterScript) this.env.afterScripts.enqueue(result.deferAfterScript);
          await this.env.afterScripts.flush(ctx, this.env.vars);
          await this.emitStepFinished({
            step,
            status: 'success',
            tookMs: Date.now() - t0,
            tabId: ctx.tabId,
            nextLabel: stepNextLabel,
            control: controlOut,
            error: resultError,
          });
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
      const message = errorMessage(e);
      this.env.logger.push({
        stepId: step.id,
        status: 'failed',
        message,
        tookMs: Date.now() - t0,
      });
      await this.env.logger.screenshotOnFailure(ctx.tabId);
      await appendOverlayFail(step, e as ErrorLike);
      try {
        const hook = await this.env.pluginManager.onError({
          runId: this.env.runId,
          flow: this.env.flow,
          vars: this.env.vars,
          step,
          error: e,
        });
        if (hook?.pause) {
          const tookMs = Date.now() - t0;
          await this.emitStepFinished({
            step,
            status: 'paused',
            tookMs,
            tabId: ctx.tabId,
            error: message,
          });
          return { status: 'paused', tookMs, error: message };
        }
      } catch (pe: unknown) {
        this.env.logger.push({
          stepId: step.id,
          status: 'warning',
          message: `plugin.onError error: ${errorMessage(pe)}`,
        });
      }
      const tookMs = Date.now() - t0;
      await this.emitStepFinished({
        step,
        status: 'failed',
        tookMs,
        tabId: ctx.tabId,
        error: message,
      });
      return { status: 'failed', tookMs, error: message };
    }
    return { status: 'success', nextLabel: stepNextLabel, control: controlOut, tookMs: Date.now() - t0 };
  }
}
