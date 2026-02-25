// control-flow-runner.ts — foreach / while orchestration

import type { ExecCtx } from '../../nodes';
import { RunLogger } from '../logging/run-logger';

export interface ControlFlowEnv {
  vars: Record<string, any>;
  logger: RunLogger;
  evalCondition: (cond: any) => boolean;
  runSubflowById: (subflowId: string, ctx: ExecCtx) => Promise<void>;
  isPaused: () => boolean;
}

export class ControlFlowRunner {
  constructor(private env: ControlFlowEnv) {}

  async run(control: any, ctx: ExecCtx): Promise<'ok' | 'paused'> {
    if (control?.kind === 'foreach') {
      const list = Array.isArray(this.env.vars[control.listVar])
        ? (this.env.vars[control.listVar] as any[])
        : [];
      const concurrency = Math.max(1, Math.min(16, Number(control.concurrency ?? 1)));
      if (concurrency <= 1) {
        for (const it of list) {
          this.env.vars[control.itemVar] = it;
          await this.env.runSubflowById(control.subflowId, ctx);
          if (this.env.isPaused()) return 'paused';
        }
        return this.env.isPaused() ? 'paused' : 'ok';
      }
      // Parallel with shallow-cloned vars per task (no automatic merge)
      let idx = 0;
      const runOne = async () => {
        while (idx < list.length) {
          const cur = idx++;
          const it = list[cur];
          const childCtx: ExecCtx = { ...ctx, vars: { ...this.env.vars } };
          childCtx.vars[control.itemVar] = it;
          await this.env.runSubflowById(control.subflowId, childCtx);
          if (this.env.isPaused()) return;
        }
      };
      const workers = Array.from({ length: Math.min(concurrency, list.length) }, () => runOne());
      await Promise.all(workers);
      return this.env.isPaused() ? 'paused' : 'ok';
    }
    if (control?.kind === 'while') {
      let i = 0;
      while (i < control.maxIterations && this.env.evalCondition(control.condition)) {
        await this.env.runSubflowById(control.subflowId, ctx);
        if (this.env.isPaused()) return 'paused';
        i++;
      }
      return this.env.isPaused() ? 'paused' : 'ok';
    }
    // Unknown control type → no-op
    return 'ok';
  }
}
