import type { RunPlugin, StepContext } from './types';
import { runState } from '../state-manager';

export function breakpointPlugin(): RunPlugin {
  return {
    name: 'breakpoint',
    async onBeforeStep(ctx: StepContext) {
      try {
        const step: any = ctx.step as any;
        const hasBreakpoint = step?.$breakpoint === true || step?.breakpoint === true;
        if (!hasBreakpoint) return;
        // mark run paused for external UI to resume
        await runState.update(ctx.runId, { status: 'stopped', updatedAt: Date.now() } as any);
        return { pause: true };
      } catch {}
      return;
    },
  };
}
