// Plugin system for record-replay engine
// Inspired by webpack-like lifecycle hooks, to avoid touching core for extensibility

import type { Flow, Step } from '../../types';
import type { ExecResult } from '../../nodes';

export interface RunContext {
  runId: string;
  flow: Flow;
  vars: Record<string, any>;
}

export interface StepContext extends RunContext {
  step: Step;
}

export interface StepErrorContext extends StepContext {
  error: any;
}

export interface StepRetryContext extends StepErrorContext {
  attempt: number;
}

export interface StepAfterContext extends StepContext {
  result?: ExecResult;
}

export interface SubflowContext extends RunContext {
  subflowId: string;
}

export interface RunEndContext extends RunContext {
  success: boolean;
  failed: number;
}

export interface HookControl {
  pause?: boolean; // request scheduler to pause run (e.g., breakpoint)
  nextLabel?: string; // override next edge label
}

export interface RunPlugin {
  name: string;
  onRunStart?(ctx: RunContext): Promise<void> | void;
  onBeforeStep?(ctx: StepContext): Promise<HookControl | void> | HookControl | void;
  onAfterStep?(ctx: StepAfterContext): Promise<void> | void;
  onStepError?(ctx: StepErrorContext): Promise<HookControl | void> | HookControl | void;
  onRetry?(ctx: StepRetryContext): Promise<void> | void;
  onChooseNextLabel?(
    ctx: StepContext & { suggested?: string },
  ): Promise<HookControl | void> | HookControl | void;
  onSubflowStart?(ctx: SubflowContext): Promise<void> | void;
  onSubflowEnd?(ctx: SubflowContext): Promise<void> | void;
  onRunEnd?(ctx: RunEndContext): Promise<void> | void;
}
