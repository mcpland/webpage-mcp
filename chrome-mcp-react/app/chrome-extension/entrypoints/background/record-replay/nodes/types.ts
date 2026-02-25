import type { RunLogEntry, Step, StepScript } from '../types';

/**
 * Execution context for step execution.
 * Contains runtime state that may change during flow execution.
 */
export interface ExecCtx {
  /** Runtime variables accessible to steps */
  vars: Record<string, any>;
  /** Logger function for recording execution events */
  logger: (e: RunLogEntry) => void;
  /**
   * Current tab ID for this execution context.
   * Managed by Scheduler, may change after openTab/switchTab actions.
   */
  tabId?: number;
  /**
   * Current frame ID within the tab.
   * Used for iframe targeting, 0 for main frame.
   */
  frameId?: number;
}

export interface ExecResult {
  alreadyLogged?: boolean;
  deferAfterScript?: StepScript | null;
  nextLabel?: string;
  control?:
    | { kind: 'foreach'; listVar: string; itemVar: string; subflowId: string; concurrency?: number }
    | { kind: 'while'; condition: any; subflowId: string; maxIterations: number };
}

export interface NodeRuntime<S extends Step = Step> {
  validate?: (step: S) => { ok: boolean; errors?: string[] };
  run: (ctx: ExecCtx, step: S) => Promise<ExecResult | void>;
}
